import { conflict, forbidden, isPreStart, notFound } from '@rl/core';
import type { AppContext, Source } from './context.js';
import { nowIso, tx } from './context.js';
import { getAccess, loadTournament, participantIds, type LoadedTournament } from './access.js';
import { audit } from './audit.js';
import { enqueue } from './notifications.js';
import { userNames } from './users.js';
import { escapeDiscord } from '../lib/util.js';

/**
 * Each registered player's status. Signing up makes them confirmed (no row = confirmed). Every
 * "can you still make it?" check that reaches them (start reminder DMs carry two buttons) puts them
 * back to pending until they answer; still pending a day later becomes "pending, no reply" and the
 * organizers are told. "Can't make it" keeps them out of pools and the start until they change it;
 * checks never reset that answer.
 */

export type Availability = 'confirmed' | 'declined' | 'maybe' | 'awaiting';

export const NO_REPLY_HOURS = 24;

interface Row {
  tournament_id: number;
  user_id: string;
  start_at: string;
  status: Exclude<Availability, 'not_asked'>;
  asked_at: string | null;
  answered_at: string | null;
  answered_by: string | null;
}

const startKey = (t: LoadedTournament) => t.cfg.schedule.startAt ?? '';

export function availabilityCustomId(tournamentId: number, answer: 'yes' | 'no') {
  return `avail:${tournamentId}:${answer}`;
}

/** Current statuses, by user id. Missing = confirmed (signed up, no check since). */
export function availabilityOf(ctx: AppContext, t: { id: number }): Map<string, { status: Availability; askedAt: string | null; answeredAt: string | null; byOrganizer: boolean }> {
  const rows = ctx.db.prepare('SELECT * FROM availability WHERE tournament_id = ?').all(t.id) as Row[];
  return new Map(rows.map((r) => [r.user_id, { status: r.status, askedAt: r.asked_at, answeredAt: r.answered_at, byOrganizer: !!r.answered_by && r.answered_by !== r.user_id }]));
}

/** Players who said they can't make it: they are left out of pools and removed at the start. */
export function declinedPlayers(ctx: AppContext, tournamentId: number): Set<string> {
  return new Set((ctx.db.prepare("SELECT user_id FROM availability WHERE tournament_id = ? AND status = 'declined'").all(tournamentId) as { user_id: string }[]).map((r) => r.user_id));
}

/** Players of confirmed registrations (the people who signed up and got a spot). */
export function confirmedPlayers(ctx: AppContext, tournamentId: number): string[] {
  return (
    ctx.db
      .prepare(
        `SELECT DISTINCT em.user_id FROM entry_members em JOIN entries e ON e.id = em.entry_id
         WHERE e.tournament_id = ? AND e.status = 'confirmed' AND em.active = 1`,
      )
      .all(tournamentId) as { user_id: string }[]
  ).map((r) => r.user_id);
}

function activePlayer(ctx: AppContext, tournamentId: number, userId: string) {
  return !!ctx.db
    .prepare(
      `SELECT 1 FROM entry_members em JOIN entries e ON e.id = em.entry_id
       WHERE e.tournament_id = ? AND em.user_id = ? AND em.active = 1 AND e.status IN ('pending','confirmed','waitlisted')`,
    )
    .get(tournamentId, userId);
}

/**
 * A "can you still make it?" check reached this player: they are pending again until they answer.
 * Someone who said they can't make it stays that way (they can still change it themselves), and
 * someone already pending keeps the time they were first asked, so the no-reply clock keeps running.
 */
export function markAsked(ctx: AppContext, t: LoadedTournament, userId: string) {
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO availability (tournament_id, user_id, start_at, status, asked_at, answered_at, answered_by, updated_at) VALUES (?, ?, ?, 'awaiting', ?, NULL, NULL, ?)
       ON CONFLICT(tournament_id, user_id) DO UPDATE SET start_at = excluded.start_at, status = 'awaiting', asked_at = excluded.asked_at, answered_at = NULL, answered_by = NULL, updated_at = excluded.updated_at
       WHERE availability.status = 'confirmed'`,
    )
    .run(t.id, userId, startKey(t), now, now);
}

/**
 * An organizer sends the start reminder (with the "can you still make it?" buttons) right now, to
 * every player or to one. It goes by DM only, even when the tournament's DMs or start reminders are
 * off; players who turned off bot DMs or muted the tournament are still skipped.
 */
export async function sendAvailabilityCheck(ctx: AppContext, actorId: string, tournamentId: number, userId: string | null, source: Source) {
  const t = loadTournament(ctx, tournamentId);
  if (!(await getAccess(ctx, t, actorId)).canManage) throw forbidden('Only organizers can send reminders.');
  if (!isPreStart(t.state)) throw conflict('already_started', t.state === 'cancelled' ? 'This tournament was cancelled.' : 'The tournament has already started.');
  const startAt = t.cfg.schedule.startAt;
  if (!startAt) throw conflict('no_start_time', 'Set a start time first: the reminder tells players when the tournament starts.');
  if (userId && !activePlayer(ctx, t.id, userId)) throw notFound('That player’s registration');
  const recipients = userId ? 1 : participantIds(ctx, t.id).length;
  if (!recipients) throw conflict('no_players', 'Nobody has registered yet.');
  // One send per target per minute, so a double click does not DM twice.
  const minute = Math.floor(ctx.clock.now().getTime() / 60_000);
  const queued = tx(ctx, () => {
    const ok = enqueue(ctx, {
      tournamentId: t.id, category: 'tournament_start', kind: 'reminder', key: `t${t.id}:manual-start:${userId ?? 'all'}:${startAt}:${minute}`,
      expiresAt: startAt, audience: userId ? `user:${userId}` : 'participants', payload: { manual: true }, ref: startAt,
    });
    if (ok) audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'registration.availability_check', target: userId ? `user:${userId}` : 'all', details: { source } });
    return ok;
  });
  if (!queued) throw conflict('recently_sent', 'That reminder was just sent. Try again in a minute.');
  ctx.kick(t.id);
  return { recipients };
}

/** A player answers for themselves, or an organizer sets the answer for a player. */
export async function setAvailability(ctx: AppContext, actorId: string, tournamentId: number, userId: string | null, answer: 'confirmed' | 'declined', source: Source) {
  const t = loadTournament(ctx, tournamentId);
  const target = userId ?? actorId;
  const byOrganizer = target !== actorId;
  if (byOrganizer && !(await getAccess(ctx, t, actorId)).canManage) throw forbidden('Only organizers can set this for another player.');
  if (!activePlayer(ctx, t.id, target)) throw notFound(byOrganizer ? 'That player’s registration' : 'Your registration');
  if (!isPreStart(t.state)) throw conflict('already_started', t.state === 'cancelled' ? 'This tournament was cancelled.' : 'The tournament has already started.');
  const now = nowIso(ctx);
  const start = startKey(t);
  const prev = ctx.db.prepare('SELECT status FROM availability WHERE tournament_id = ? AND user_id = ?').get(t.id, target) as { status: string } | undefined;
  tx(ctx, () => {
    ctx.db
      .prepare(
        `INSERT INTO availability (tournament_id, user_id, start_at, status, asked_at, answered_at, answered_by, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(tournament_id, user_id) DO UPDATE SET
           start_at = excluded.start_at, status = excluded.status, answered_at = excluded.answered_at, answered_by = excluded.answered_by, updated_at = excluded.updated_at`,
      )
      .run(t.id, target, start, answer, now, actorId, now);
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'registration.availability', target: `user:${target}`, details: { answer, source } });
    // Tell the organizers right away when a player says they can't make it.
    if (answer === 'declined' && !byOrganizer && prev?.status !== 'declined') {
      const name = userNames(ctx, [target]).get(target) ?? 'A player';
      enqueue(ctx, {
        tournamentId: t.id, category: 'organizer_alert', key: `t${t.id}:avail-declined:${target}:${now}`, audience: 'admins',
        payload: { text: `${name} says they can't make it.` },
      });
    }
  });
  ctx.kick(t.id);
  return answer;
}

const WAITING_STATES = "('draft','published','registration_open','registration_closed','ready')";

/** Players asked over a day ago who never answered become "pending, no reply"; organizers get one DM per tournament. */
export function flagNoReplies(ctx: AppContext): number {
  const now = ctx.clock.now();
  const cutoff = new Date(now.getTime() - NO_REPLY_HOURS * 3600_000).toISOString();
  const rows = ctx.db
    .prepare(
      `SELECT a.tournament_id, a.user_id, a.start_at FROM availability a JOIN tournaments t ON t.id = a.tournament_id
       WHERE a.status = 'awaiting' AND a.asked_at <= ? AND t.state IN ${WAITING_STATES} AND t.start_at > ?`,
    )
    .all(cutoff, now.toISOString()) as { tournament_id: number; user_id: string; start_at: string }[];
  const byTournament = new Map<number, string[]>();
  for (const r of rows) byTournament.set(r.tournament_id, [...(byTournament.get(r.tournament_id) ?? []), r.user_id]);
  let flagged = 0;
  for (const [tid, users] of byTournament) {
    const confirmed = new Set(confirmedPlayers(ctx, tid));
    const late = users.filter((u) => confirmed.has(u));
    if (!late.length) continue;
    const names = userNames(ctx, late);
    const list = late.map((u) => names.get(u) ?? 'Player').sort((a, b) => a.localeCompare(b));
    tx(ctx, () => {
      const set = ctx.db.prepare("UPDATE availability SET status = 'maybe', updated_at = ? WHERE tournament_id = ? AND user_id = ? AND status = 'awaiting'");
      for (const u of late) set.run(now.toISOString(), tid, u);
      ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(tid);
      enqueue(ctx, {
        tournamentId: tid, category: 'organizer_alert', key: `t${tid}:avail-maybe:${now.toISOString()}`, audience: 'admins',
        payload: { text: `${late.length === 1 ? 'This player has' : `These ${late.length} players have`} not answered whether they can still make it, a day after the check, so they are flagged as no reply: ${joinNames(list, 1500)}` },
      });
    });
    flagged += late.length;
  }
  return flagged;
}

/** "a, b, c" cut to fit in a Discord message, with "and N more" when it does not. */
export function joinNames(names: string[], max: number): string {
  let out = '';
  for (let i = 0; i < names.length; i++) {
    const next = out ? `${out}, ${names[i]}` : names[i];
    if (next.length > max) return `${out}, and ${names.length - i} more (see the website)`;
    out = next;
  }
  return out;
}

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  confirmed: '✅ Confirmed',
  awaiting: '⏳ Pending',
  maybe: '🟠 Pending (no reply)',
  declined: '❌ Can’t make it',
};

/** The organizers' digest 24 hours before the start: every confirmed signup by status. */
export function availabilityDigest(ctx: AppContext, t: LoadedTournament): string | null {
  const players = confirmedPlayers(ctx, t.id);
  if (!players.length) return null;
  const answers = availabilityOf(ctx, t);
  const names = userNames(ctx, players);
  const groups = new Map<Availability, string[]>();
  for (const u of players) {
    const s = answers.get(u)?.status ?? 'confirmed';
    groups.set(s, [...(groups.get(s) ?? []), escapeDiscord(names.get(u) ?? 'Player')]);
  }
  const order: Availability[] = ['confirmed', 'awaiting', 'maybe', 'declined'];
  const present = order.filter((s) => groups.has(s));
  // Discord allows 2000 characters; share the room between the groups.
  const room = Math.floor(1300 / present.length);
  const lines = present.map((s) => {
    const list = groups.get(s)!.sort((a, b) => a.localeCompare(b));
    return `**${AVAILABILITY_LABELS[s]} (${list.length})**: ${joinNames(list, room)}`;
  });
  const waitlisted = (ctx.db.prepare("SELECT COUNT(*) c FROM entries WHERE tournament_id = ? AND status = 'waitlisted'").get(t.id) as { c: number }).c;
  const ready = groups.get('confirmed')?.length ?? 0;
  return `${ready} of ${players.length} signed-up players are confirmed.\n${lines.join('\n')}${waitlisted ? `\nWaitlist: ${waitlisted}.` : ''}`;
}
