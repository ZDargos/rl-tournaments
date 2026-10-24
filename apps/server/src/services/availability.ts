import { conflict, forbidden, isPreStart, notFound } from '@rl/core';
import type { AppContext, Source } from './context.js';
import { nowIso, tx } from './context.js';
import { getAccess, loadTournament, type LoadedTournament } from './access.js';
import { audit } from './audit.js';
import { enqueue } from './notifications.js';
import { userNames } from './users.js';
import { escapeDiscord } from '../lib/util.js';

/**
 * "Can you still make it?" Start reminder DMs carry two buttons; the answer is stored per player per
 * tournament. A player who was asked and has not answered a day later is marked "maybe" and the
 * organizers are told. Answers only count for the start time they were given for: if the start
 * moves, everyone is back to "not asked" and the next reminder asks again.
 */

export type Availability = 'confirmed' | 'declined' | 'maybe' | 'awaiting' | 'not_asked';

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

/** Current answers (for the current start time), by user id. Missing = not asked. */
export function availabilityOf(ctx: AppContext, t: LoadedTournament): Map<string, { status: Availability; askedAt: string | null; answeredAt: string | null; byOrganizer: boolean }> {
  const rows = ctx.db.prepare('SELECT * FROM availability WHERE tournament_id = ? AND start_at = ?').all(t.id, startKey(t)) as Row[];
  return new Map(rows.map((r) => [r.user_id, { status: r.status, askedAt: r.asked_at, answeredAt: r.answered_at, byOrganizer: !!r.answered_by && r.answered_by !== r.user_id }]));
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

/** A start reminder with buttons reached this player. Keeps an existing answer for the same start time. */
export function markAsked(ctx: AppContext, t: LoadedTournament, userId: string) {
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO availability (tournament_id, user_id, start_at, status, asked_at, answered_at, answered_by, updated_at) VALUES (?, ?, ?, 'awaiting', ?, NULL, NULL, ?)
       ON CONFLICT(tournament_id, user_id) DO UPDATE SET start_at = excluded.start_at, status = 'awaiting', asked_at = excluded.asked_at, answered_at = NULL, answered_by = NULL, updated_at = excluded.updated_at
       WHERE availability.start_at <> excluded.start_at`,
    )
    .run(t.id, userId, startKey(t), now, now);
  // Answered on the website before any reminder: remember when they were first asked anyway.
  ctx.db.prepare('UPDATE availability SET asked_at = ? WHERE tournament_id = ? AND user_id = ? AND asked_at IS NULL').run(now, t.id, userId);
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
  const prev = ctx.db.prepare('SELECT status FROM availability WHERE tournament_id = ? AND user_id = ? AND start_at = ?').get(t.id, target, start) as { status: string } | undefined;
  tx(ctx, () => {
    ctx.db
      .prepare(
        `INSERT INTO availability (tournament_id, user_id, start_at, status, asked_at, answered_at, answered_by, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(tournament_id, user_id) DO UPDATE SET
           asked_at = CASE WHEN availability.start_at = excluded.start_at THEN availability.asked_at ELSE NULL END,
           start_at = excluded.start_at, status = excluded.status, answered_at = excluded.answered_at, answered_by = excluded.answered_by, updated_at = excluded.updated_at`,
      )
      .run(t.id, target, start, answer, now, actorId, now);
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'registration.availability', target: `user:${target}`, details: { answer, source } });
    // Tell the organizers right away when a player says they can't make it (once per start time).
    if (answer === 'declined' && !byOrganizer && prev?.status !== 'declined') {
      const name = userNames(ctx, [target]).get(target) ?? 'A player';
      enqueue(ctx, {
        tournamentId: t.id, category: 'organizer_alert', key: `t${t.id}:avail-declined:${target}:${start}`, audience: 'admins',
        payload: { text: `${name} says they can't make it.` },
      });
    }
  });
  ctx.kick(t.id);
  return answer;
}

const WAITING_STATES = "('draft','published','registration_open','registration_closed','ready')";

/** Players asked over a day ago who never answered become "maybe"; organizers get one DM per tournament. */
export function flagNoReplies(ctx: AppContext): number {
  const now = ctx.clock.now();
  const cutoff = new Date(now.getTime() - NO_REPLY_HOURS * 3600_000).toISOString();
  const rows = ctx.db
    .prepare(
      `SELECT a.tournament_id, a.user_id, a.start_at FROM availability a JOIN tournaments t ON t.id = a.tournament_id
       WHERE a.status = 'awaiting' AND a.asked_at <= ? AND t.state IN ${WAITING_STATES} AND t.start_at = a.start_at AND t.start_at > ?`,
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
        payload: { text: `${late.length === 1 ? 'This player has' : `These ${late.length} players have`} not said whether they can make it, a day after the reminder, so they are marked as maybe: ${joinNames(list, 1500)}` },
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
  declined: '❌ Can’t make it',
  maybe: '🟠 Maybe (no reply)',
  awaiting: '⏳ Waiting for a reply',
  not_asked: '➖ Not asked yet',
};

/** The organizers' digest 24 hours before the start: every confirmed signup by availability. */
export function availabilityDigest(ctx: AppContext, t: LoadedTournament): string | null {
  const players = confirmedPlayers(ctx, t.id);
  if (!players.length) return null;
  const answers = availabilityOf(ctx, t);
  const names = userNames(ctx, players);
  const groups = new Map<Availability, string[]>();
  for (const u of players) {
    const s = answers.get(u)?.status ?? 'not_asked';
    groups.set(s, [...(groups.get(s) ?? []), escapeDiscord(names.get(u) ?? 'Player')]);
  }
  const order: Availability[] = ['confirmed', 'declined', 'maybe', 'awaiting', 'not_asked'];
  const present = order.filter((s) => groups.has(s));
  // Discord allows 2000 characters; share the room between the groups.
  const room = Math.floor(1300 / present.length);
  const lines = present.map((s) => {
    const list = groups.get(s)!.sort((a, b) => a.localeCompare(b));
    return `**${AVAILABILITY_LABELS[s]} (${list.length})**: ${joinNames(list, room)}`;
  });
  const waitlisted = (ctx.db.prepare("SELECT COUNT(*) c FROM entries WHERE tournament_id = ? AND status = 'waitlisted'").get(t.id) as { c: number }).c;
  const ready = groups.get('confirmed')?.length ?? 0;
  return `${ready} of ${players.length} signed-up players have confirmed.\n${lines.join('\n')}${waitlisted ? `\nWaitlist: ${waitlisted}.` : ''}`;
}
