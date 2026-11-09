import { conflict, forbidden, invalid, isPreStart, notFound } from '@rl/core';
import type { AppContext, Source } from './context.js';
import { nowIso, tx } from './context.js';
import { assertManage, loadTournament, participantIds, type LoadedTournament } from './access.js';
import { audit } from './audit.js';
import { enqueue } from './notifications.js';
import { ensureUser, userNames } from './users.js';
import { recordPost, tournamentChannel } from './channels.js';
import { DiscordApiError, type MessageButton, type MessageContent } from '../discord/port.js';
import { discordTime, escapeDiscord } from '../lib/util.js';

/**
 * Date change votes. Organizers propose moving the tournament to one new date and time and say why.
 * Every player registered at that moment gets a DM with "Yes, I can make it" / "No, I can't"
 * buttons; they can also answer on the tournament page or on a card in the registration channel.
 * Organizers watch the answers and then either move the start to the new time or keep the current
 * one. Either way the players are told. When the start moves, each answer carries over as the
 * player's "can you make it?" answer for the new time.
 */

export type DateAnswer = 'yes' | 'no';
type Status = 'open' | 'applied' | 'kept' | 'cancelled';

interface VoteRow {
  id: number;
  tournament_id: number;
  proposed_at: string;
  previous_at: string | null;
  reason: string;
  status: Status;
  channel_id: string | null;
  message_id: string | null;
  card_status: 'none' | 'posting' | 'posted' | 'failed';
  rendered: string | null;
  created_by: string | null;
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

const POSTING_STUCK_MS = 2 * 60_000;
export const DATE_VOTE_REASON_MAX = 500;

export function dateVoteCustomId(voteId: number, answer: DateAnswer) {
  return `dcv:${voteId}:${answer}`;
}

const bump = (ctx: AppContext, tid: number) => ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(tid);

function latestVote(ctx: AppContext, tournamentId: number): VoteRow | undefined {
  return ctx.db.prepare('SELECT * FROM date_change_votes WHERE tournament_id = ? ORDER BY id DESC LIMIT 1').get(tournamentId) as VoteRow | undefined;
}

function openVote(ctx: AppContext, tournamentId: number): VoteRow | undefined {
  return ctx.db.prepare("SELECT * FROM date_change_votes WHERE tournament_id = ? AND status = 'open'").get(tournamentId) as VoteRow | undefined;
}

function getVote(ctx: AppContext, id: number): VoteRow {
  const v = ctx.db.prepare('SELECT * FROM date_change_votes WHERE id = ?').get(id) as VoteRow | undefined;
  if (!v) throw notFound('Date change vote');
  return v;
}

function recipients(ctx: AppContext, voteId: number): string[] {
  return (ctx.db.prepare('SELECT user_id FROM date_change_recipients WHERE vote_id = ?').all(voteId) as { user_id: string }[]).map((r) => r.user_id);
}

function answers(ctx: AppContext, voteId: number): Map<string, { answer: DateAnswer; answeredAt: string }> {
  const rows = ctx.db.prepare('SELECT user_id, answer, answered_at FROM date_change_answers WHERE vote_id = ?').all(voteId) as { user_id: string; answer: DateAnswer; answered_at: string }[];
  return new Map(rows.map((r) => [r.user_id, { answer: r.answer, answeredAt: r.answered_at }]));
}

/** Everyone the vote is about: those asked, plus anyone who registered since (they can answer too). */
function people(ctx: AppContext, v: VoteRow): { asked: string[]; registered: Set<string>; all: string[] } {
  const asked = recipients(ctx, v.id);
  const registered = new Set(participantIds(ctx, v.tournament_id));
  const all = [...new Set([...asked, ...(v.status === 'open' ? registered : []), ...answers(ctx, v.id).keys()])];
  return { asked, registered, all };
}

function tally(ctx: AppContext, v: VoteRow) {
  const a = answers(ctx, v.id);
  const { all } = people(ctx, v);
  let yes = 0;
  let no = 0;
  for (const u of all) {
    const x = a.get(u)?.answer;
    if (x === 'yes') yes++;
    else if (x === 'no') no++;
  }
  return { yes, no, waiting: all.length - yes - no, total: all.length };
}

/** What the website shows. Names are for organizers only. */
export function dateVoteView(ctx: AppContext, t: LoadedTournament, viewerId: string | null, canManage: boolean) {
  const v = latestVote(ctx, t.id);
  if (!v) return null;
  const a = answers(ctx, v.id);
  const { all, registered } = people(ctx, v);
  const mine = viewerId ? a.get(viewerId)?.answer ?? null : null;
  const canAnswer = !!viewerId && v.status === 'open' && isPreStart(t.state) && (registered.has(viewerId) || all.includes(viewerId));
  let players: { userId: string; name: string; answer: DateAnswer | null; answeredAt: string | null; stillRegistered: boolean }[] | undefined;
  if (canManage) {
    const names = userNames(ctx, all);
    players = all
      .map((u) => ({ userId: u, name: names.get(u) ?? 'Player', answer: a.get(u)?.answer ?? null, answeredAt: a.get(u)?.answeredAt ?? null, stillRegistered: registered.has(u) }))
      .sort((x, y) => x.name.localeCompare(y.name));
  }
  return {
    id: v.id, status: v.status, proposedAt: v.proposed_at, previousAt: v.previous_at, reason: v.reason,
    createdAt: v.created_at, closedAt: v.closed_at, counts: tally(ctx, v), myAnswer: mine, canAnswer,
    cardPosted: v.card_status === 'posted', players,
  };
}

/** An organizer proposes a new date and time. Every registered player is asked right away. */
export async function createDateVote(ctx: AppContext, actorId: string, tournamentId: number, input: { proposedAt: string; reason: string }, source: Source) {
  const t = loadTournament(ctx, tournamentId);
  await assertManage(ctx, t, actorId);
  if (!isPreStart(t.state)) throw conflict('already_started', t.state === 'cancelled' ? 'This tournament was cancelled.' : 'The tournament has already started, so its date can no longer change.');
  if (ctx.db.prepare("SELECT 1 FROM start_polls WHERE tournament_id = ? AND status = 'open'").get(t.id))
    throw conflict('start_poll_open', 'Players are still voting on the start time. Close or cancel that vote first.');
  if (openVote(ctx, t.id)) throw conflict('date_vote_open', 'A date change vote is already running. Move the date or keep it before proposing another.');
  const ms = Date.parse(input.proposedAt);
  if (Number.isNaN(ms)) throw invalid('bad_time', 'The new date and time is not valid.');
  if (ms <= ctx.clock.now().getTime()) throw invalid('bad_time', 'The new date and time must be in the future.');
  const proposedAt = new Date(ms).toISOString();
  const current = t.cfg.schedule.startAt;
  if (current && Date.parse(current) === ms) throw invalid('same_time', 'That is already the start time.');
  const reason = input.reason.trim();
  if (reason.length < 3) throw invalid('bad_reason', 'Tell the players why the date should change (at least a few words).');
  if (reason.length > DATE_VOTE_REASON_MAX) throw invalid('bad_reason', `Keep the reason under ${DATE_VOTE_REASON_MAX} characters.`);
  const players = participantIds(ctx, t.id);
  if (!players.length) throw conflict('no_players', 'Nobody has registered yet, so there is no one to ask.');

  const id = tx(ctx, () => {
    const now = nowIso(ctx);
    const r = ctx.db
      .prepare("INSERT INTO date_change_votes (tournament_id, proposed_at, previous_at, reason, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)")
      .run(t.id, proposedAt, current, reason, actorId, now, now);
    const voteId = Number(r.lastInsertRowid);
    const add = ctx.db.prepare('INSERT OR IGNORE INTO date_change_recipients (vote_id, user_id) VALUES (?, ?)');
    for (const u of players) {
      ensureUser(ctx, u);
      add.run(voteId, u);
    }
    const title = `**${escapeDiscord(t.name)}**`;
    const buttons: MessageButton[] = [
      { customId: dateVoteCustomId(voteId, 'yes'), label: '✅ Yes, I can make it', style: 'success' },
      { customId: dateVoteCustomId(voteId, 'no'), label: '❌ No, I can’t', style: 'danger' },
    ];
    const text =
      `📅 The organizers of ${title} want to move it to **${discordTime(proposedAt, 'F')}**` +
      `${current ? ` (it is set for ${discordTime(current, 'F')} now)` : ''}.\n> ${escapeDiscord(reason).replace(/\n+/g, '\n> ')}\nCan you make the new time?`;
    for (const u of players) {
      enqueue(ctx, { tournamentId: t.id, category: 'personal', key: `t${t.id}:dcv:${voteId}:ask:${u}`, audience: `user:${u}`, payload: { text, buttons } });
    }
    bump(ctx, t.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'date_vote.created', details: { proposedAt, previousAt: current, reason, recipients: players.length, source } });
    return voteId;
  });
  ctx.kick(t.id);
  return { id, recipients: players.length };
}

/** A player answers (website, DM button or channel card). Answering again changes the answer. */
export async function answerDateVote(ctx: AppContext, userId: string, voteId: number, answer: DateAnswer, source: Source) {
  const v = getVote(ctx, voteId);
  const t = loadTournament(ctx, v.tournament_id);
  if (v.status !== 'open') throw conflict('date_vote_closed', v.status === 'applied' ? 'The organizers already moved the tournament to the new date.' : 'This date change vote has ended.');
  if (!isPreStart(t.state)) throw conflict('already_started', 'The tournament has already started.');
  const { asked, registered } = people(ctx, v);
  if (!asked.includes(userId) && !registered.has(userId)) throw forbidden('Only players registered for this tournament can answer.');
  const before = answers(ctx, v.id).get(userId)?.answer ?? null;
  tx(ctx, () => {
    const now = nowIso(ctx);
    ctx.db
      .prepare('INSERT INTO date_change_answers (vote_id, user_id, answer, answered_at) VALUES (?, ?, ?, ?) ON CONFLICT(vote_id, user_id) DO UPDATE SET answer = excluded.answer, answered_at = excluded.answered_at')
      .run(v.id, userId, answer, now);
    bump(ctx, t.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId: userId, action: 'date_vote.answer', details: { voteId: v.id, answer, source } });
    // Tell the organizers once, when the last person asked has answered.
    const c = tally(ctx, v);
    if (before === null && c.waiting === 0) {
      enqueue(ctx, {
        tournamentId: t.id, category: 'organizer_alert', key: `t${t.id}:dcv:${v.id}:all-answered`, audience: 'admins',
        payload: { text: `Everyone answered the date change vote for ${discordTime(v.proposed_at, 'F')}: ${c.yes} can make it, ${c.no} can't. Move the date or keep it on the website.` },
      });
    }
  });
  ctx.kick(t.id);
  return { answer, counts: tally(ctx, getVote(ctx, v.id)), tournament: t, proposedAt: v.proposed_at };
}

/** Website: the viewer answers the tournament's running vote. */
export async function answerTournamentDateVote(ctx: AppContext, userId: string, tournamentId: number, answer: DateAnswer, source: Source) {
  const v = openVote(ctx, tournamentId);
  if (!v) throw conflict('date_vote_closed', 'There is no date change vote running.');
  return answerDateVote(ctx, userId, v.id, answer, source);
}

/**
 * End the vote. `move`: the start becomes the proposed time (players' answers carry over as their
 * availability for it). `keep`: the start stays as it is. Players are told either way.
 */
export async function closeDateVote(ctx: AppContext, actorId: string, tournamentId: number, decision: 'move' | 'keep', source: Source) {
  const t = loadTournament(ctx, tournamentId);
  await assertManage(ctx, t, actorId);
  const v = openVote(ctx, t.id);
  if (!v) throw notFound('Running date change vote');
  if (decision === 'move') {
    if (!isPreStart(t.state)) throw conflict('already_started', 'The tournament has already started, so its date can no longer change.');
    if (Date.parse(v.proposed_at) <= ctx.clock.now().getTime()) throw conflict('time_passed', 'The proposed time has already passed. Keep the current date and propose a new one.');
    const { updateTournament } = await import('./tournaments.js');
    await updateTournament(ctx, actorId, t.id, { configPatch: { schedule: { startAt: v.proposed_at } } }, source);
  }
  const fresh = loadTournament(ctx, t.id);
  const a = answers(ctx, v.id);
  const { all, registered } = people(ctx, v);
  const status: Status = decision === 'move' ? 'applied' : 'kept';
  tx(ctx, () => {
    const now = nowIso(ctx);
    const r = ctx.db.prepare("UPDATE date_change_votes SET status = ?, closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(status, now, actorId, now, v.id);
    if (!r.changes) throw conflict('stale_state', 'The vote changed at the same time. Reload and try again.');
    if (decision === 'move') {
      // Answers for the new time count as each player's "can you make it?" for it.
      const set = ctx.db.prepare(
        `INSERT INTO availability (tournament_id, user_id, start_at, status, asked_at, answered_at, answered_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tournament_id, user_id) DO UPDATE SET start_at = excluded.start_at, status = excluded.status, asked_at = excluded.asked_at,
           answered_at = excluded.answered_at, answered_by = excluded.answered_by, updated_at = excluded.updated_at`,
      );
      for (const [u, x] of a) if (registered.has(u)) set.run(fresh.id, u, v.proposed_at, x.answer === 'yes' ? 'confirmed' : 'declined', v.created_at, x.answeredAt, u, now);
    }
    const title = `**${escapeDiscord(fresh.name)}**`;
    const text =
      decision === 'move'
        ? `📅 ${title} has moved to **${discordTime(v.proposed_at, 'F')}**.${v.previous_at ? ` (It was ${discordTime(v.previous_at, 'F')}.)` : ''}`
        : `📅 ${title} is staying ${v.previous_at ? `at **${discordTime(v.previous_at, 'F')}**` : 'on its current schedule'}. The organizers decided not to move it to ${discordTime(v.proposed_at, 'F')}.`;
    for (const u of all) {
      if (!registered.has(u)) continue;
      enqueue(ctx, { tournamentId: fresh.id, category: 'personal', key: `t${fresh.id}:dcv:${v.id}:${status}:${u}`, audience: `user:${u}`, payload: { text } });
    }
    bump(ctx, fresh.id);
    audit(ctx, { guildId: fresh.guild_id, tournamentId: fresh.id, actorId, action: `date_vote.${status}`, details: { voteId: v.id, proposedAt: v.proposed_at, counts: tally(ctx, v), source } });
  });
  ctx.kick(t.id);
  return { status, startAt: loadTournament(ctx, t.id).cfg.schedule.startAt };
}

/** Votes whose tournament started or was cancelled no longer decide anything. */
export function cancelStaleDateVotes(ctx: AppContext) {
  const rows = ctx.db
    .prepare("SELECT v.id, v.tournament_id FROM date_change_votes v JOIN tournaments t ON t.id = v.tournament_id WHERE v.status = 'open' AND t.state IN ('in_progress','paused','completed','cancelled')")
    .all() as { id: number; tournament_id: number }[];
  for (const r of rows) {
    const now = nowIso(ctx);
    ctx.db.prepare("UPDATE date_change_votes SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(now, now, r.id);
    bump(ctx, r.tournament_id);
  }
  return rows.length;
}

// ---------------- the Discord card ----------------

function renderCard(ctx: AppContext, t: LoadedTournament, v: VoteRow): MessageContent {
  const c = tally(ctx, v);
  const head = `📅 **Date change proposed for ${escapeDiscord(t.name)}**`;
  const when = `New time: **${discordTime(v.proposed_at, 'F')}**${v.previous_at ? ` (currently ${discordTime(v.previous_at, 'F')})` : ''}`;
  const why = `> ${escapeDiscord(v.reason).replace(/\n+/g, '\n> ')}`;
  const counts = `✅ **${c.yes}** can make it · ❌ **${c.no}** can't · ⏳ **${c.waiting}** haven't answered`;
  const link = `Details: <${ctx.env.WEB_URL}/#/t/${t.id}>`;
  if (v.status === 'open') {
    return {
      content: `${head}\n${when}\n${why}\nRegistered players: can you make the new time? Tap a button (tap the other one to change your answer).\n${counts}\n${link}`,
      buttons: [
        { customId: dateVoteCustomId(v.id, 'yes'), label: 'Yes, I can make it', style: 'success' },
        { customId: dateVoteCustomId(v.id, 'no'), label: 'No, I can’t', style: 'danger' },
      ],
    };
  }
  const outcome =
    v.status === 'applied' ? `The tournament moved to **${discordTime(v.proposed_at, 'F')}**.`
    : v.status === 'kept' ? `The organizers kept the ${v.previous_at ? `current time, ${discordTime(v.previous_at, 'F')}` : 'current schedule'}.`
    : 'This vote ended.';
  return { content: `${head}\n${outcome}\n${counts}\n${link}`, buttons: [] };
}

function setCard(ctx: AppContext, id: number, fields: Partial<Pick<VoteRow, 'channel_id' | 'message_id' | 'card_status' | 'rendered'>>) {
  const keys = Object.keys(fields);
  ctx.db.prepare(`UPDATE date_change_votes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => (fields as Record<string, unknown>)[k]), nowIso(ctx), id);
}

/** Post the vote card, or bring it up to date. Reconciled from the database, so safe after restarts. */
export async function syncDateVoteCards(ctx: AppContext, tournamentId: number) {
  if (!ctx.discord.enabled) return;
  const votes = ctx.db.prepare("SELECT * FROM date_change_votes WHERE tournament_id = ? AND (status = 'open' OR card_status IN ('posting', 'posted'))").all(tournamentId) as VoteRow[];
  if (!votes.length) return;
  const t = loadTournament(ctx, tournamentId);
  for (const v of votes) {
    if (v.card_status === 'posted' && v.channel_id && v.message_id) {
      const msg = renderCard(ctx, t, v);
      const rendered = JSON.stringify(msg);
      if (rendered === v.rendered) continue;
      try {
        await ctx.discord.editChannelMessage(v.channel_id, v.message_id, msg);
        setCard(ctx, v.id, { rendered });
      } catch (err) {
        if (err instanceof DiscordApiError && err.permanent) setCard(ctx, v.id, { card_status: 'failed', rendered });
        else ctx.log.warn({ err: String(err), vote: v.id }, 'editing the date change card failed; will retry');
      }
      continue;
    }
    if (v.status !== 'open' || v.card_status === 'failed') continue;
    const channelId = tournamentChannel(ctx, t, 'registration');
    if (!channelId) continue;
    const stuck = new Date(ctx.clock.now().getTime() - POSTING_STUCK_MS).toISOString();
    const claimed = ctx.db
      .prepare("UPDATE date_change_votes SET card_status = 'posting', channel_id = ?, updated_at = ? WHERE id = ? AND (card_status = 'none' OR (card_status = 'posting' AND updated_at < ?))")
      .run(channelId, nowIso(ctx), v.id, stuck).changes;
    if (!claimed) continue;
    const msg = renderCard(ctx, t, v);
    try {
      const sent = await ctx.discord.sendChannelMessage(channelId, msg);
      recordPost(ctx, t.id, channelId, sent.id);
      setCard(ctx, v.id, { message_id: sent.id, card_status: 'posted', rendered: JSON.stringify(msg) });
    } catch (err) {
      if (err instanceof DiscordApiError && err.permanent) setCard(ctx, v.id, { card_status: 'failed' });
      else {
        setCard(ctx, v.id, { card_status: 'none' });
        ctx.log.warn({ err: String(err), vote: v.id }, 'posting the date change card failed; will retry');
      }
    }
  }
}

export async function syncAllDateVoteCards(ctx: AppContext) {
  const ids = ctx.db
    .prepare("SELECT DISTINCT tournament_id AS id FROM date_change_votes WHERE status = 'open' OR card_status = 'posting' OR (card_status = 'posted' AND closed_at > ?)")
    .all(new Date(ctx.clock.now().getTime() - 86400_000).toISOString()) as { id: number }[];
  for (const r of ids) {
    try {
      await syncDateVoteCards(ctx, r.id);
    } catch (err) {
      ctx.log.error({ err: String(err), tournamentId: r.id }, 'date change card sync failed');
    }
  }
}
