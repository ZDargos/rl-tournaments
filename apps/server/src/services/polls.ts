import { randomInt } from 'node:crypto';
import { conflict, forbidden, invalid, isPreStart, notFound, DomainError } from '@rl/core';
import type { AppContext, Source } from './context.js';
import { nowIso, tx } from './context.js';
import { assertManage, assertView, loadTournament, type LoadedTournament } from './access.js';
import { audit } from './audit.js';
import { enqueue, scheduleTournamentReminders } from './notifications.js';
import { assertEligible, register } from './registration.js';
import { transition } from './tournaments.js';
import { ensureUser, userNames } from './users.js';
import { joinNames } from './availability.js';
import { recordPost, tournamentChannel } from './channels.js';
import { DiscordApiError, type MessageButton, type MessageContent } from '../discord/port.js';
import { discordTime, escapeDiscord } from '../lib/util.js';

/**
 * Start time votes. Organizers list possible start times and a closing time; players tick every time
 * that works for them (Discord card buttons or the website). When the vote closes, the time with the
 * most votes wins (a tie is broken at random), it becomes the start time, registration opens and
 * everyone who voted for it is registered. Other voters are told which time won and can sign up with
 * one tap.
 *
 * While a vote is open the tournament has no start time and registration stays closed. Closing is
 * driven by the job loop from the database, so a vote whose deadline passed while the bot was offline
 * closes as soon as it is back.
 */

export const MAX_POLL_OPTIONS = 10;
const POSTING_STUCK_MS = 2 * 60_000;
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

interface PollRow {
  id: number;
  tournament_id: number;
  options: string;
  closes_at: string;
  status: 'open' | 'closed' | 'cancelled';
  winner: number | null;
  tie: number;
  channel_id: string | null;
  message_id: string | null;
  card_status: 'none' | 'posting' | 'posted' | 'failed';
  rendered: string | null;
  created_by: string | null;
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

export function pollCustomId(pollId: number, option: number) {
  return `poll:${pollId}:${option}`;
}

const optionsOf = (p: PollRow) => JSON.parse(p.options) as string[];

/** The tournament's latest vote (open, or the last closed/cancelled one). */
export function latestPoll(ctx: AppContext, tournamentId: number): PollRow | undefined {
  return ctx.db.prepare('SELECT * FROM start_polls WHERE tournament_id = ? ORDER BY id DESC LIMIT 1').get(tournamentId) as PollRow | undefined;
}

function openPoll(ctx: AppContext, tournamentId: number): PollRow | undefined {
  return ctx.db.prepare("SELECT * FROM start_polls WHERE tournament_id = ? AND status = 'open'").get(tournamentId) as PollRow | undefined;
}

function getPoll(ctx: AppContext, id: number): PollRow {
  const p = ctx.db.prepare('SELECT * FROM start_polls WHERE id = ?').get(id) as PollRow | undefined;
  if (!p) throw notFound('Start time vote');
  return p;
}

function counts(ctx: AppContext, p: PollRow): number[] {
  const out = optionsOf(p).map(() => 0);
  for (const r of ctx.db.prepare('SELECT option, COUNT(*) c FROM start_poll_votes WHERE poll_id = ? GROUP BY option').all(p.id) as { option: number; c: number }[]) {
    if (r.option < out.length) out[r.option] = r.c;
  }
  return out;
}

function picksOf(ctx: AppContext, pollId: number, userId: string): number[] {
  return (ctx.db.prepare('SELECT option FROM start_poll_votes WHERE poll_id = ? AND user_id = ? ORDER BY option').all(pollId, userId) as { option: number }[]).map((r) => r.option);
}

const teamMode = (t: LoadedTournament) => t.cfg.registrationMode === 'team' && t.cfg.teamSize > 1;
const bump = (ctx: AppContext, tid: number) => ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(tid);

/** What the website shows. Voters' names are for organizers only. */
export function pollView(ctx: AppContext, t: LoadedTournament, viewerId: string | null, canManage: boolean) {
  const p = latestPoll(ctx, t.id);
  if (!p) return null;
  const c = counts(ctx, p);
  const mine = viewerId ? new Set(picksOf(ctx, p.id, viewerId)) : new Set<number>();
  let voters: { userId: string; name: string; options: number[] }[] | undefined;
  if (canManage) {
    const rows = ctx.db.prepare('SELECT user_id, option FROM start_poll_votes WHERE poll_id = ? ORDER BY voted_at').all(p.id) as { user_id: string; option: number }[];
    const by = new Map<string, number[]>();
    for (const r of rows) by.set(r.user_id, [...(by.get(r.user_id) ?? []), r.option]);
    const names = userNames(ctx, [...by.keys()]);
    voters = [...by].map(([userId, options]) => ({ userId, name: names.get(userId) ?? 'Player', options: options.sort((a, b) => a - b) }));
  }
  return {
    id: p.id, status: p.status, closesAt: p.closes_at, winner: p.winner, tie: !!p.tie, closedAt: p.closed_at,
    options: optionsOf(p).map((at, i) => ({ at, votes: c[i], mine: mine.has(i) })),
    voterCount: (ctx.db.prepare('SELECT COUNT(DISTINCT user_id) c FROM start_poll_votes WHERE poll_id = ?').get(p.id) as { c: number }).c,
    cardPosted: p.card_status === 'posted', voters,
  };
}

export async function createPoll(ctx: AppContext, actorId: string, tournamentId: number, input: { options: string[]; closesAt: string }, source: Source) {
  const t = loadTournament(ctx, tournamentId);
  await assertManage(ctx, t, actorId);
  if (t.state !== 'draft' && t.state !== 'published') throw conflict('bad_state', 'Start a vote before registration opens (the vote opens registration when it closes).');
  if (openPoll(ctx, t.id)) throw conflict('start_poll_open', 'A start time vote is already running. Cancel it first to start a new one.');
  const now = ctx.clock.now().getTime();
  const times = input.options.map((o) => {
    const ms = Date.parse(o);
    if (Number.isNaN(ms)) throw invalid('bad_time', 'One of the times is not a valid date and time.');
    return ms;
  });
  if (times.length < 2 || times.length > MAX_POLL_OPTIONS) throw invalid('bad_options', `Give between 2 and ${MAX_POLL_OPTIONS} start times.`);
  if (new Set(times).size !== times.length) throw invalid('duplicate_option', 'The same start time is listed twice.');
  const closes = Date.parse(input.closesAt);
  if (Number.isNaN(closes)) throw invalid('bad_time', 'The voting deadline is not a valid date and time.');
  if (closes <= now) throw invalid('bad_deadline', 'The voting deadline must be in the future.');
  if (times.some((ms) => ms <= closes)) throw invalid('bad_deadline', 'Every start time must be after the voting deadline.');
  const options = times.map((ms) => new Date(ms).toISOString());
  const id = tx(ctx, () => {
    const iso = nowIso(ctx);
    const r = ctx.db
      .prepare("INSERT INTO start_polls (tournament_id, options, closes_at, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)")
      .run(t.id, JSON.stringify(options), new Date(closes).toISOString(), actorId, iso, iso);
    // No start time while players vote: no start reminders, no auto-start.
    if (t.cfg.schedule.startAt) setStartAt(ctx, t, null);
    bump(ctx, t.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'start_poll.created', details: { options, closesAt: new Date(closes).toISOString(), source } });
    return Number(r.lastInsertRowid);
  });
  ctx.kick(t.id);
  const warnings: string[] = [];
  if (t.state === 'draft') warnings.push('The tournament is still a draft, so only organizers can see it. Publish it so players can vote on the website.');
  if (!tournamentChannel(ctx, t, 'registration')) warnings.push('No registration or announcement channel is set, so the vote is only on the website.');
  return { id, warnings };
}

function setStartAt(ctx: AppContext, t: LoadedTournament, startAt: string | null) {
  const cfg = { ...t.cfg, schedule: { ...t.cfg.schedule, startAt } };
  ctx.db.prepare('UPDATE tournaments SET config = ?, start_at = ?, version = version + 1, updated_at = ? WHERE id = ?').run(JSON.stringify(cfg), startAt, nowIso(ctx), t.id);
  scheduleTournamentReminders(ctx, loadTournament(ctx, t.id));
}

export async function cancelPoll(ctx: AppContext, actorId: string, tournamentId: number, source: Source) {
  const t = loadTournament(ctx, tournamentId);
  await assertManage(ctx, t, actorId);
  const p = openPoll(ctx, t.id);
  if (!p) throw notFound('Running start time vote');
  tx(ctx, () => {
    const now = nowIso(ctx);
    ctx.db.prepare("UPDATE start_polls SET status = 'cancelled', closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(now, actorId, now, p.id);
    bump(ctx, t.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'start_poll.cancelled', details: { source } });
  });
  ctx.kick(t.id);
}

/** A player sets all their picks at once (website). */
export async function setPollVotes(ctx: AppContext, userId: string, tournamentId: number, options: number[], source: Source) {
  const p = openPoll(ctx, tournamentId);
  if (!p) throw conflict('poll_closed', 'Voting on the start time has closed.');
  return writeVotes(ctx, userId, p, () => [...new Set(options)], source);
}

/** A player taps a time on the Discord card: adds it, or removes it if already picked. */
export async function togglePollVote(ctx: AppContext, userId: string, pollId: number, option: number, source: Source) {
  const p = getPoll(ctx, pollId);
  if (p.status !== 'open') throw conflict('poll_closed', 'Voting on the start time has closed.');
  return writeVotes(ctx, userId, p, (cur) => (cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option]), source);
}

async function writeVotes(ctx: AppContext, userId: string, p: PollRow, next: (current: number[]) => number[], source: Source) {
  const t = loadTournament(ctx, p.tournament_id);
  await assertView(ctx, t, userId);
  await assertEligible(ctx, t, userId);
  if (Date.parse(p.closes_at) <= ctx.clock.now().getTime()) throw conflict('poll_closed', 'Voting on the start time has closed.');
  ensureUser(ctx, userId);
  const count = optionsOf(p).length;
  const picks = tx(ctx, () => {
    const want = next(picksOf(ctx, p.id, userId));
    if (want.some((o) => !Number.isInteger(o) || o < 0 || o >= count)) throw invalid('bad_option', 'That start time is not in this vote.');
    const now = nowIso(ctx);
    // Keep the original vote time for picks that stay, so first-come order holds when spots run out.
    ctx.db.prepare(`DELETE FROM start_poll_votes WHERE poll_id = ? AND user_id = ? AND option NOT IN (${want.map(() => '?').join(',') || 'NULL'})`).run(p.id, userId, ...want);
    const add = ctx.db.prepare('INSERT OR IGNORE INTO start_poll_votes (poll_id, user_id, option, voted_at) VALUES (?, ?, ?, ?)');
    for (const o of want) add.run(p.id, userId, o, now);
    bump(ctx, t.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId: userId, action: 'start_poll.vote', details: { options: want, source } });
    return picksOf(ctx, p.id, userId);
  });
  ctx.kick(t.id);
  return { picks, options: optionsOf(p), counts: counts(ctx, p) };
}

export async function closePollNow(ctx: AppContext, actorId: string, tournamentId: number, source: Source) {
  const t = loadTournament(ctx, tournamentId);
  await assertManage(ctx, t, actorId);
  const p = openPoll(ctx, t.id);
  if (!p) throw notFound('Running start time vote');
  return closePoll(ctx, p, actorId, source);
}

export async function closeDuePolls(ctx: AppContext) {
  const due = ctx.db.prepare("SELECT * FROM start_polls WHERE status = 'open' AND closes_at <= ?").all(nowIso(ctx)) as PollRow[];
  for (const p of due) {
    try {
      await closePoll(ctx, p, null, 'system');
    } catch (err) {
      ctx.log.error({ err: String(err), poll: p.id }, 'closing start time vote failed');
    }
  }
}

/** Pick the winner, set the start time, open registration and register the winning voters. */
async function closePoll(ctx: AppContext, p: PollRow, actorId: string | null, source: Source) {
  const t = loadTournament(ctx, p.tournament_id);
  const options = optionsOf(p);
  const c = counts(ctx, p);
  const max = Math.max(...c);
  const tied = max > 0 ? c.flatMap((n, i) => (n === max ? [i] : [])) : [];
  const winner = tied.length ? tied[randomInt(tied.length)] : null;
  // Started or cancelled meanwhile: the vote no longer decides anything.
  const stillMatters = isPreStart(t.state) && !t.started_at;
  const claimed = tx(ctx, () => {
    const now = nowIso(ctx);
    const r = ctx.db
      .prepare("UPDATE start_polls SET status = ?, winner = ?, tie = ?, closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ? AND status = 'open'")
      .run(stillMatters ? 'closed' : 'cancelled', stillMatters ? winner : null, tied.length > 1 ? 1 : 0, now, actorId, now, p.id);
    if (!r.changes) return false;
    bump(ctx, t.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'start_poll.closed', details: { winner: stillMatters && winner != null ? options[winner] : null, counts: c, tie: tied.length > 1, source } });
    if (stillMatters && winner != null) setStartAt(ctx, t, options[winner]);
    return true;
  });
  if (!claimed || !stillMatters) {
    ctx.kick(t.id);
    return { winner: null as string | null };
  }
  if (winner == null) {
    enqueue(ctx, {
      tournamentId: t.id, category: 'organizer_alert', key: `t${t.id}:poll:${p.id}:novotes`, audience: 'admins',
      payload: { text: 'The start time vote closed with no votes, so no start time was picked. Set one in the settings or start a new vote.' },
    });
    ctx.kick(t.id);
    return { winner: null };
  }
  const startAt = options[winner];
  if (t.state === 'draft' || t.state === 'published') {
    try {
      await transition(ctx, null, t.id, 'open_registration', { source: 'system', fromPoll: true });
    } catch (err) {
      ctx.log.warn({ err: String(err), tournamentId: t.id }, 'opening registration after the start time vote failed');
    }
  }
  const outcome = await registerVoters(ctx, loadTournament(ctx, t.id), p, winner);
  const when = discordTime(startAt, 'F');
  const parts = [`${c[winner]} vote${c[winner] === 1 ? '' : 's'}${tied.length > 1 ? `, tied with ${tied.length - 1} other time${tied.length > 2 ? 's' : ''} and picked at random` : ''}`];
  if (outcome.registered.length) parts.push(`${outcome.registered.length} voter${outcome.registered.length === 1 ? '' : 's'} registered`);
  if (outcome.waitlisted.length) parts.push(`${outcome.waitlisted.length} waitlisted`);
  if (outcome.pending.length) parts.push(`${outcome.pending.length} waiting for your approval`);
  let text = `The start time vote closed: ${when} won (${parts.join(', ')}).`;
  if (outcome.failed.length) {
    const names = userNames(ctx, outcome.failed.map((f) => f.userId));
    text += ` Could not register: ${joinNames(outcome.failed.map((f) => `${names.get(f.userId) ?? 'Player'} (${f.reason})`), 1200)}.`;
  }
  enqueue(ctx, { tournamentId: t.id, category: 'organizer_alert', key: `t${t.id}:poll:${p.id}:result`, audience: 'admins', payload: { text } });
  ctx.kick(t.id);
  return { winner: startAt };
}

async function registerVoters(ctx: AppContext, t: LoadedTournament, p: PollRow, winner: number) {
  const startAt = optionsOf(p)[winner];
  const when = discordTime(startAt, 'F');
  const title = `**${escapeDiscord(t.name)}**`;
  const rows = ctx.db.prepare('SELECT user_id, option, voted_at FROM start_poll_votes WHERE poll_id = ? ORDER BY voted_at, rowid').all(p.id) as { user_id: string; option: number; voted_at: string }[];
  const winners: string[] = [];
  const voters: string[] = [];
  for (const r of rows) {
    if (!voters.includes(r.user_id)) voters.push(r.user_id);
    if (r.option === winner && !winners.includes(r.user_id)) winners.push(r.user_id);
  }
  const out = { registered: [] as string[], waitlisted: [] as string[], pending: [] as string[], failed: [] as { userId: string; reason: string }[] };
  const dm = (userId: string, kind: string, text: string, buttons?: MessageButton[]) =>
    enqueue(ctx, { tournamentId: t.id, category: 'personal', key: `t${t.id}:poll:${p.id}:${kind}:${userId}`, audience: `user:${userId}`, payload: { text, buttons } });
  const signup: MessageButton[] = teamMode(t) ? [] : [{ customId: `pollreg:${t.id}`, label: '✅ Sign me up', style: 'success' }];

  for (const uid of voters) {
    if (!winners.includes(uid)) {
      dm(uid, 'lost', `🗳️ The time you picked for ${title} didn't win. It starts ${when}. ${teamMode(t) ? 'You can still register your team on the website.' : 'Want to play anyway?'}`, signup);
      continue;
    }
    if (teamMode(t)) {
      dm(uid, 'team', `🗳️ ${title} starts ${when}, a time you voted for. Registration is open: register your team on the website, or join a team when your captain invites you.`);
      continue;
    }
    try {
      const e = await register(ctx, uid, t.id, {}, 'system');
      const withdraw: MessageButton[] = t.cfg.registration.allowWithdrawal ? [{ customId: `pollwd:${t.id}`, label: 'Withdraw', style: 'secondary' }] : [];
      if (e.status === 'confirmed') {
        out.registered.push(uid);
        dm(uid, 'won', `🗳️ ${title} starts ${when}, a time you voted for, so you're registered!${needsRank(t) ? ' Set your rank on the website so you are placed in the right pool.' : ''} Plans changed? Tap Withdraw.`, withdraw);
      } else if (e.status === 'waitlisted') {
        out.waitlisted.push(uid);
        dm(uid, 'won', `🗳️ ${title} starts ${when}, a time you voted for. It's full, so you're on the waitlist and will get a spot if one opens.`, withdraw);
      } else {
        out.pending.push(uid);
        dm(uid, 'won', `🗳️ ${title} starts ${when}, a time you voted for. You're signed up and waiting for an organizer to approve you.`, withdraw);
      }
    } catch (err) {
      const code = err instanceof DomainError ? err.code : '';
      if (code === 'already_registered') continue;
      const reason = code === 'tournament_full' ? 'full' : err instanceof DomainError ? err.message : 'error';
      out.failed.push({ userId: uid, reason: reason.slice(0, 80) });
      if (code === 'tournament_full') dm(uid, 'full', `🗳️ ${title} starts ${when}, a time you voted for, but it filled up before you could get a spot.`);
      if (!(err instanceof DomainError)) ctx.log.error({ err: String(err), userId: uid, tournamentId: t.id }, 'registering a voter failed');
    }
  }
  return out;
}

const needsRank = (t: LoadedTournament) => t.cfg.format === 'sixmans' && t.cfg.sixmans.skillMethod === 'rank';

/** "Sign me up" from the result DM. */
export async function pollSignup(ctx: AppContext, userId: string, tournamentId: number, source: Source) {
  const t = loadTournament(ctx, tournamentId);
  if (teamMode(t)) throw forbidden('This tournament uses team registration: register your team on the website.');
  return register(ctx, userId, t.id, {}, source);
}

// ---------------- the Discord card ----------------

function shortTime(iso: string, tz: string) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString().slice(0, 22);
  }
}

function renderCard(ctx: AppContext, t: LoadedTournament, p: PollRow): MessageContent {
  const options = optionsOf(p);
  const c = counts(ctx, p);
  const head = `🗳️ **When should ${escapeDiscord(t.name)} start?**`;
  const lines = options.map((at, i) => {
    const won = p.status === 'closed' && p.winner === i;
    return `${won ? '🏆' : NUMBERS[i]} ${discordTime(at, 'F')} · **${c[i]}** vote${c[i] === 1 ? '' : 's'}`;
  });
  if (p.status === 'open') {
    return {
      content: `${head}\nTap every time that works for you (tap again to undo). Voting closes ${discordTime(p.closes_at, 'R')}. Everyone who picks the winning time is registered automatically.\n${lines.join('\n')}`,
      buttons: options.map((at, i) => ({ customId: pollCustomId(p.id, i), label: `${i + 1} · ${shortTime(at, t.cfg.schedule.timezone)}`.slice(0, 80), style: 'primary' as const })),
    };
  }
  if (p.status === 'cancelled') return { content: `${head}\nThis vote was cancelled.`, buttons: [] };
  if (p.winner == null) return { content: `${head}\nVoting closed with no votes. The organizers will set the start time.\n${lines.join('\n')}`, buttons: [] };
  return {
    content: `${head}\nVoting closed: **${discordTime(options[p.winner], 'F')}** won${p.tie ? ' (a tie, picked at random)' : ''}. Everyone who voted for it is registered, and registration is open for everyone else.\n${lines.join('\n')}`,
    buttons: [],
  };
}

function setCard(ctx: AppContext, id: number, fields: Partial<Pick<PollRow, 'channel_id' | 'message_id' | 'card_status' | 'rendered'>>) {
  const keys = Object.keys(fields);
  ctx.db.prepare(`UPDATE start_polls SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => (fields as Record<string, unknown>)[k]), nowIso(ctx), id);
}

/** Post the vote card, or bring it up to date. Reconciled from the database, so safe after restarts. */
export async function syncPollCards(ctx: AppContext, tournamentId: number) {
  if (!ctx.discord.enabled) return;
  const polls = ctx.db.prepare("SELECT * FROM start_polls WHERE tournament_id = ? AND (status = 'open' OR card_status IN ('posting', 'posted'))").all(tournamentId) as PollRow[];
  if (!polls.length) return;
  const t = loadTournament(ctx, tournamentId);
  for (const p of polls) {
    if (p.card_status === 'posted' && p.channel_id && p.message_id) {
      const msg = renderCard(ctx, t, p);
      const rendered = JSON.stringify(msg);
      if (rendered === p.rendered) continue;
      try {
        await ctx.discord.editChannelMessage(p.channel_id, p.message_id, msg);
        setCard(ctx, p.id, { rendered });
      } catch (err) {
        if (err instanceof DiscordApiError && err.permanent) setCard(ctx, p.id, { card_status: 'failed', rendered });
        else ctx.log.warn({ err: String(err), poll: p.id }, 'editing the start time vote card failed; will retry');
      }
      continue;
    }
    if (p.status !== 'open' || p.card_status === 'failed') continue;
    const channelId = tournamentChannel(ctx, t, 'registration');
    if (!channelId) continue;
    const stuck = new Date(ctx.clock.now().getTime() - POSTING_STUCK_MS).toISOString();
    const claimed = ctx.db
      .prepare("UPDATE start_polls SET card_status = 'posting', channel_id = ?, updated_at = ? WHERE id = ? AND (card_status = 'none' OR (card_status = 'posting' AND updated_at < ?))")
      .run(channelId, nowIso(ctx), p.id, stuck).changes;
    if (!claimed) continue;
    const msg = renderCard(ctx, t, p);
    try {
      const sent = await ctx.discord.sendChannelMessage(channelId, msg);
      recordPost(ctx, t.id, channelId, sent.id);
      setCard(ctx, p.id, { message_id: sent.id, card_status: 'posted', rendered: JSON.stringify(msg) });
    } catch (err) {
      if (err instanceof DiscordApiError && err.permanent) {
        setCard(ctx, p.id, { card_status: 'failed' });
        enqueue(ctx, {
          tournamentId: t.id, category: 'organizer_alert', key: `t${t.id}:poll:${p.id}:card-failed`, audience: 'admins',
          payload: { text: `I could not post the start time vote in <#${channelId}> (${err.message.slice(0, 120)}). The bot needs View Channel and Send Messages there. Players can still vote on the website.` },
        });
      } else {
        setCard(ctx, p.id, { card_status: 'none' });
        ctx.log.warn({ err: String(err), poll: p.id }, 'posting the start time vote card failed; will retry');
      }
    }
  }
}

export async function syncAllPollCards(ctx: AppContext) {
  // A closed vote's card is final once edited; a day later it is no longer looked at.
  const ids = ctx.db
    .prepare("SELECT DISTINCT tournament_id AS id FROM start_polls WHERE status = 'open' OR card_status = 'posting' OR (card_status = 'posted' AND closed_at > ?)")
    .all(new Date(ctx.clock.now().getTime() - 86400_000).toISOString()) as { id: number }[];
  for (const r of ids) {
    try {
      await syncPollCards(ctx, r.id);
    } catch (err) {
      ctx.log.error({ err: String(err), tournamentId: r.id }, 'start time vote card sync failed');
    }
  }
}
