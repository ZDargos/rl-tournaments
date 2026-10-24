import type { AppContext } from './context.js';
import { nowIso } from './context.js';
import { loadTournament, type LoadedTournament } from './access.js';
import { enqueue } from './notifications.js';
import { competitorMembers, competitorName, matchLabel, poolName, type MatchRow } from './queries.js';
import { matchVotes, tallyVotes } from './results.js';
import { DiscordApiError, type MessageContent } from '../discord/port.js';
import { escapeDiscord } from '../lib/util.js';

/**
 * Score report cards: when a tournament has a score report channel (config.scoreReports.channelId),
 * every live match gets one message there with a button per team. The players vote for the winner
 * (results.ts voteResult); the card shows the running count and is edited to show the result when
 * the match ends, however it ended (vote, website report or organizer).
 *
 * Like voice channels this is reconciled from the database, so it is safe after restarts: a row in
 * match_cards is written ('posting') before the Discord call, so a card is never posted twice.
 */

interface CardRow {
  match_id: number;
  tournament_id: number;
  channel_id: string;
  message_id: string | null;
  result_version: number;
  status: 'posting' | 'open' | 'closed' | 'failed';
  rendered: string | null;
  error: string | null;
  updated_at: string;
}

const LIVE = new Set(['ready', 'awaiting_confirmation']);
const POSTING_STUCK_MS = 2 * 60_000;
const esc = escapeDiscord;

export function cardCustomId(matchId: number, winner: 'a' | 'b') {
  return `vote:${matchId}:${winner}`;
}

function renderCard(ctx: AppContext, t: LoadedTournament, m: MatchRow, mode: 'open' | 'closed'): MessageContent {
  const a = competitorMembers(ctx, m.competitor_a);
  const b = competitorMembers(ctx, m.competitor_b);
  const nameA = competitorName(ctx, m.competitor_a);
  const nameB = competitorName(ctx, m.competitor_b);
  const head = `🎮 **Match ${m.id}** · ${esc(t.name)} · ${matchLabel(m, poolName(ctx, m.pool_id))}${m.best_of > 1 ? ` (best of ${m.best_of})` : ''}`;
  const teams = `🔵 **${esc(nameA)}**: ${a.map((u) => `<@${u}>`).join(' ')}\n🟠 **${esc(nameB)}**: ${b.map((u) => `<@${u}>`).join(' ')}`;
  const rules = t.cfg.scoreReports;
  if (mode === 'closed') {
    let line: string;
    if (m.status === 'completed' && m.winner) line = `✅ **${esc(m.winner === 'a' ? nameA : nameB)}** won${m.forfeit ? ' (forfeit)' : ''}.`;
    else if (m.status === 'disputed') line = '⚠️ The votes disagree. An organizer will set the result.';
    else if (m.status === 'cancelled') line = '🚫 This match was abandoned.';
    else line = 'This match is no longer being played.';
    return { content: `${head}\n${teams}\n${line}`, buttons: [] };
  }
  const tally = tallyVotes(matchVotes(ctx, m), rules);
  const need = `${rules.votesNeeded} matching vote${rules.votesNeeded === 1 ? '' : 's'}${rules.requireBothTeams && rules.votesNeeded > 1 ? ', including one from each team' : ''}`;
  return {
    content: `${head}\n${teams}\nPlayers: when the game is over, tap the team that won. Needs ${need}. You can change your vote until it counts.\nVotes: 🔵 ${tally.a} · 🟠 ${tally.b}`,
    mentionUserIds: [...a, ...b],
    buttons: [
      { customId: cardCustomId(m.id, 'a'), label: `🔵 ${nameA} won`.slice(0, 80), style: 'primary' },
      { customId: cardCustomId(m.id, 'b'), label: `🟠 ${nameB} won`.slice(0, 80), style: 'danger' },
    ],
  };
}

function setCard(ctx: AppContext, matchId: number, fields: Partial<Pick<CardRow, 'message_id' | 'status' | 'rendered' | 'error' | 'result_version' | 'channel_id'>>) {
  const keys = Object.keys(fields);
  ctx.db
    .prepare(`UPDATE match_cards SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE match_id = ?`)
    .run(...keys.map((k) => (fields as Record<string, unknown>)[k]), nowIso(ctx), matchId);
}

async function post(ctx: AppContext, t: LoadedTournament, m: MatchRow, channelId: string) {
  const now = nowIso(ctx);
  // Claim the card before calling Discord, so concurrent runs cannot post it twice.
  const claimed = ctx.db
    .prepare(
      `INSERT INTO match_cards (match_id, tournament_id, channel_id, message_id, result_version, status, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'posting', ?, ?)
       ON CONFLICT(match_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = NULL, result_version = excluded.result_version, status = 'posting', rendered = NULL, error = NULL, updated_at = excluded.updated_at
       WHERE match_cards.status IN ('closed', 'failed') OR (match_cards.status = 'posting' AND match_cards.updated_at < ?)`,
    )
    .run(m.id, t.id, channelId, m.result_version, now, now, new Date(ctx.clock.now().getTime() - POSTING_STUCK_MS).toISOString()).changes;
  if (!claimed) return;
  const msg = renderCard(ctx, t, m, 'open');
  try {
    const sent = await ctx.discord.sendChannelMessage(channelId, msg);
    setCard(ctx, m.id, { message_id: sent.id, status: 'open', rendered: JSON.stringify(msg) });
  } catch (err) {
    if (err instanceof DiscordApiError && err.permanent) {
      setCard(ctx, m.id, { status: 'failed', error: err.message.slice(0, 300) });
      enqueue(ctx, {
        tournamentId: t.id, category: 'organizer_alert', key: `t${t.id}:scorecard-failed:${channelId}`, audience: 'admins',
        payload: { text: `I could not post score report cards in <#${channelId}> (${err.message.slice(0, 120)}). The bot needs View Channel and Send Messages there. Players can still report on the website or with /match report.` },
      });
    } else {
      // Transient: release the claim so the next run retries.
      ctx.db.prepare("DELETE FROM match_cards WHERE match_id = ? AND status = 'posting'").run(m.id);
      ctx.log.warn({ err: String(err), match: m.id }, 'posting score card failed; will retry');
    }
  }
}

async function edit(ctx: AppContext, card: CardRow, msg: MessageContent, status: CardRow['status']) {
  const rendered = JSON.stringify({ ...msg, mentionUserIds: undefined });
  if (card.rendered && JSON.stringify({ ...JSON.parse(card.rendered), mentionUserIds: undefined }) === rendered && card.status === status) return;
  if (!card.message_id) return;
  try {
    await ctx.discord.editChannelMessage(card.channel_id, card.message_id, msg);
    setCard(ctx, card.match_id, { status, rendered: JSON.stringify(msg) });
  } catch (err) {
    // A deleted card (or channel) is not retried; anything else is retried on the next run.
    if (err instanceof DiscordApiError && err.permanent) setCard(ctx, card.match_id, { status: status === 'closed' ? 'closed' : 'failed', error: err.message.slice(0, 300) });
    else ctx.log.warn({ err: String(err), match: card.match_id }, 'editing score card failed; will retry');
  }
}

/** Bring the score cards of one tournament in line with its matches. */
export async function syncScoreCards(ctx: AppContext, tournamentId: number) {
  if (!ctx.discord.enabled) return;
  let t: LoadedTournament;
  try {
    t = loadTournament(ctx, tournamentId);
  } catch {
    return;
  }
  const channelId = t.cfg.scoreReports.channelId;
  const running = t.state === 'in_progress';
  const cards = new Map((ctx.db.prepare('SELECT * FROM match_cards WHERE tournament_id = ?').all(t.id) as CardRow[]).map((c) => [c.match_id, c]));
  const matches = ctx.db.prepare('SELECT * FROM matches WHERE tournament_id = ? ORDER BY round, position, id').all(t.id) as MatchRow[];
  for (const m of matches) {
    const card = cards.get(m.id);
    const wanted = running && !!channelId && t.cfg.results.confirmation !== 'admin_only' && LIVE.has(m.status) && !!m.competitor_a && !!m.competitor_b;
    if (wanted) {
      const stale = card && (card.status === 'closed' || card.status === 'failed') && (card.result_version !== m.result_version || card.channel_id !== channelId);
      if (!card || stale || card.status === 'posting') await post(ctx, t, m, channelId!);
      else if (card.status === 'open') await edit(ctx, card, renderCard(ctx, t, m, 'open'), 'open');
    } else if (card && (card.status === 'open' || card.status === 'closed') && (t.state !== 'paused' || !LIVE.has(m.status))) {
      // Also keeps closed cards current (e.g. disputed, then set by an organizer).
      await edit(ctx, card, renderCard(ctx, t, m, 'closed'), 'closed');
    }
  }
}

export async function syncAllScoreCards(ctx: AppContext) {
  const ids = ctx.db
    .prepare("SELECT id FROM tournaments WHERE state IN ('in_progress','paused') UNION SELECT DISTINCT tournament_id FROM match_cards WHERE status IN ('posting','open')")
    .all() as { id: number }[];
  for (const r of ids) {
    try {
      await syncScoreCards(ctx, r.id);
    } catch (err) {
      ctx.log.error({ err: String(err), tournamentId: r.id }, 'score card sync failed');
    }
  }
}
