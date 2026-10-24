import { conflict, dependentsOf, describeSeries, forbidden, invalid, notFound, sameResult, validateSeries, winsNeeded, type GameScore, type SeriesResult } from '@rl/core';
import type { AppContext, Source } from './context.js';
import { nowIso, tx } from './context.js';
import { getAccess, loadTournament, type LoadedTournament } from './access.js';
import { audit } from './audit.js';
import { cancelPending, enqueue } from './notifications.js';
import { getMatch, matchesOf, sideOf, type MatchRow } from './queries.js';
import { advance } from './engine.js';
import { json } from '../lib/util.js';

/**
 * Result reporting and confirmation.
 *
 * Default policy (opponent_confirm): a player on one side reports; a *different authenticated user*
 * on the opposing side confirms the identical score. Identity is the Discord user id, so reporting
 * from the website and from Discord is the same person. Disagreeing reports mark the match
 * disputed (no advancement) until an organizer resolves it. Every report, confirmation, dispute and
 * correction is kept in result_reports; nothing is deleted.
 */

export interface ReportInput {
  games?: GameScore[] | null;
  winsA?: number | null;
  winsB?: number | null;
}

interface ReportRow {
  id: number;
  match_id: number;
  user_id: string | null;
  side: 'a' | 'b' | null;
  kind: string;
  wins_a: number | null;
  wins_b: number | null;
  games: string | null;
  reason: string | null;
  source: string;
  result_version: number;
  superseded: number;
  created_at: string;
}

const OPEN = new Set(['ready', 'awaiting_confirmation', 'disputed']);

function activeReports(ctx: AppContext, m: MatchRow): ReportRow[] {
  return ctx.db
    .prepare("SELECT * FROM result_reports WHERE match_id = ? AND superseded = 0 AND result_version = ? AND kind IN ('report','confirm','dispute') ORDER BY id")
    .all(m.id, m.result_version) as ReportRow[];
}

const asResult = (r: ReportRow): SeriesResult => {
  const games = json<GameScore[]>(r.games, []);
  return { winsA: r.wins_a ?? 0, winsB: r.wins_b ?? 0, winner: (r.wins_a ?? 0) > (r.wins_b ?? 0) ? 'a' : 'b', goalsA: games.reduce((s, g) => s + g.a, 0), goalsB: games.reduce((s, g) => s + g.b, 0), games };
};

function load(ctx: AppContext, matchId: number) {
  const m = getMatch(ctx, matchId);
  if (!m) throw notFound('Match');
  const t = loadTournament(ctx, m.tournament_id);
  return { m, t };
}

function insertReport(ctx: AppContext, m: MatchRow, r: { userId: string | null; side: 'a' | 'b' | null; kind: string; result?: SeriesResult | null; reason?: string | null; source: Source }) {
  ctx.db
    .prepare('INSERT INTO result_reports (match_id, user_id, side, kind, wins_a, wins_b, games, reason, source, result_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.id, r.userId, r.side, r.kind, r.result?.winsA ?? null, r.result?.winsB ?? null, r.result ? JSON.stringify(r.result.games) : null, r.reason ?? null, r.source, m.result_version, nowIso(ctx));
}

function assertPlayable(t: LoadedTournament) {
  if (t.state === 'paused') throw conflict('paused', 'The tournament is paused. Results can be reported when it resumes.');
  if (t.state !== 'in_progress') throw conflict('not_running', 'This tournament is not in progress.');
}

/** Write the final result and advance the tournament. Inside a transaction. */
function completeMatch(ctx: AppContext, t: LoadedTournament, m: MatchRow, result: SeriesResult, opts: { forfeit?: boolean; event?: string } = {}) {
  const now = nowIso(ctx);
  const res = ctx.db
    .prepare(
      `UPDATE matches SET status = 'completed', winner = ?, wins_a = ?, wins_b = ?, goals_a = ?, goals_b = ?, games = ?, forfeit = ?, live_games = NULL,
         completed_at = ?, result_version = result_version + 1, updated_at = ?
       WHERE id = ? AND status IN ('ready','awaiting_confirmation','disputed') AND result_version = ?`,
    )
    .run(result.winner, result.winsA, result.winsB, result.goalsA, result.goalsB, JSON.stringify(result.games), opts.forfeit ? 1 : 0, now, now, m.id, m.result_version);
  if (!res.changes) throw conflict('match_changed', 'This match was updated at the same time. Reload and try again.');
  cancelPending(ctx, { tournamentId: t.id, matchId: m.id });
  enqueue(ctx, { tournamentId: t.id, matchId: m.id, category: 'match_result', key: `m${m.id}:result:v${m.result_version + 1}`, audience: 'match', payload: { event: opts.event ?? 'completed' } });
  ctx.db.prepare('UPDATE tournaments SET version = version + 1, updated_at = ? WHERE id = ?').run(now, t.id);
  advance(ctx, t.id, m.stage);
}

function parseResult(t: LoadedTournament, m: MatchRow, input: ReportInput): SeriesResult {
  const requireGames = t.cfg.series.requireGameScores || (t.cfg.format === 'sixmans' && t.cfg.sixmans.tiebreakers.some((x) => x === 'goal_diff' || x === 'goals_for'));
  return validateSeries(m.best_of, { games: input.games, winsA: input.winsA, winsB: input.winsB }, { requireGameScores: requireGames });
}

export async function reportResult(ctx: AppContext, actorId: string, matchId: number, input: ReportInput, source: Source) {
  const { m, t } = load(ctx, matchId);
  assertPlayable(t);
  const access = await getAccess(ctx, t, actorId);
  const side = sideOf(ctx, m, actorId);
  if (!side) {
    if (access.canManage) return adminResolve(ctx, actorId, matchId, input, null, false, source);
    throw forbidden('Only players in this match can report its result.');
  }
  if (!OPEN.has(m.status)) throw conflict('not_reportable', m.status === 'completed' ? 'This match is already complete. Ask an organizer for a correction.' : `This match is ${m.status}.`);
  if (m.status === 'disputed') throw conflict('disputed', 'This result is disputed; an organizer must resolve it.');
  const policy = t.cfg.results.confirmation;
  if (policy === 'admin_only') throw forbidden('In this tournament only organizers enter results.');
  const result = parseResult(t, m, input);
  let outcome: 'completed' | 'awaiting_confirmation' | 'disputed' | 'unchanged' = 'awaiting_confirmation';
  tx(ctx, () => {
    const fresh = getMatch(ctx, m.id)!;
    if (fresh.result_version !== m.result_version || !OPEN.has(fresh.status)) throw conflict('match_changed', 'This match was updated at the same time. Reload and try again.');
    if (policy === 'single_report') {
      insertReport(ctx, m, { userId: actorId, side, kind: 'report', result, source });
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'result.reported', target: `match:${m.id}`, details: { result: describeSeries(result), side, source, policy } });
      completeMatch(ctx, t, m, result);
      outcome = 'completed';
      return;
    }
    const reports = activeReports(ctx, m);
    const mine = reports.find((r) => r.user_id === actorId && r.kind === 'report');
    if (mine) {
      if (sameResult(asResult(mine), result)) {
        outcome = 'unchanged';
        return;
      }
      ctx.db.prepare('UPDATE result_reports SET superseded = 1 WHERE id = ?').run(mine.id); // own report replaced, kept for audit
    }
    const others = reports.filter((r) => r.id !== mine?.id && (r.kind === 'report' || r.kind === 'confirm'));
    insertReport(ctx, m, { userId: actorId, side, kind: 'report', result, source });
    const disagree = others.find((r) => !sameResult(asResult(r), result));
    const opposingAgree = others.find((r) => r.side !== side && r.user_id !== actorId && sameResult(asResult(r), result));
    if (disagree) {
      ctx.db.prepare("UPDATE matches SET status = 'disputed', updated_at = ? WHERE id = ?").run(nowIso(ctx), m.id);
      enqueue(ctx, { tournamentId: t.id, matchId: m.id, category: 'organizer_alert', key: `m${m.id}:disputed:v${m.result_version}:${actorId}`, audience: 'admins', payload: { text: `Match ${m.id} has conflicting result reports and needs a decision: ${ctx.env.WEB_URL}/#/m/${m.id}` } });
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'result.disputed', target: `match:${m.id}`, details: { result: describeSeries(result), conflictsWith: describeSeries(asResult(disagree)), source } });
      outcome = 'disputed';
    } else if (opposingAgree) {
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'result.confirmed', target: `match:${m.id}`, details: { result: describeSeries(result), source, reporter: opposingAgree.user_id } });
      completeMatch(ctx, t, m, result);
      outcome = 'completed';
    } else {
      ctx.db.prepare("UPDATE matches SET status = 'awaiting_confirmation', updated_at = ? WHERE id = ?").run(nowIso(ctx), m.id);
      const other = side === 'a' ? 'b' : 'a';
      enqueue(ctx, {
        tournamentId: t.id, matchId: m.id, category: 'match_result', key: `m${m.id}:confirm:v${m.result_version}:${actorId}:${result.winsA}-${result.winsB}`,
        audience: `side:${other}`, payload: { event: 'awaiting_confirmation', winsA: result.winsA, winsB: result.winsB, games: result.games },
      });
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'result.reported', target: `match:${m.id}`, details: { result: describeSeries(result), side, source } });
    }
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
  });
  ctx.kick(t.id);
  return { outcome, match: getMatch(ctx, m.id)! };
}

/** Confirm the opposing side's pending report (same score). */
export async function confirmResult(ctx: AppContext, actorId: string, matchId: number, source: Source) {
  const { m, t } = load(ctx, matchId);
  assertPlayable(t);
  const side = sideOf(ctx, m, actorId);
  if (!side) throw forbidden('Only players in this match can confirm its result.');
  if (m.status !== 'awaiting_confirmation') throw conflict('nothing_to_confirm', 'There is no reported result waiting for confirmation.');
  const pending = activeReports(ctx, m).filter((r) => r.kind === 'report' && r.side !== side && r.user_id !== actorId);
  if (!pending.length) throw conflict('own_report', 'A player from the opposing team must confirm this result.');
  const result = asResult(pending[pending.length - 1]);
  tx(ctx, () => {
    const fresh = getMatch(ctx, m.id)!;
    if (fresh.result_version !== m.result_version || fresh.status !== 'awaiting_confirmation') throw conflict('match_changed', 'This match was updated at the same time.');
    insertReport(ctx, m, { userId: actorId, side, kind: 'confirm', result, source });
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'result.confirmed', target: `match:${m.id}`, details: { result: describeSeries(result), source } });
    completeMatch(ctx, t, m, result);
  });
  ctx.kick(t.id);
  return getMatch(ctx, m.id)!;
}

export async function disputeResult(ctx: AppContext, actorId: string, matchId: number, reason: string, counter: ReportInput | null, source: Source) {
  const { m, t } = load(ctx, matchId);
  assertPlayable(t);
  const side = sideOf(ctx, m, actorId);
  if (!side) throw forbidden('Only players in this match can dispute its result.');
  if (m.status !== 'awaiting_confirmation') throw conflict('nothing_to_dispute', 'There is no pending result to dispute.');
  const counterResult = counter && (counter.games?.length || counter.winsA != null) ? parseResult(t, m, counter) : null;
  tx(ctx, () => {
    insertReport(ctx, m, { userId: actorId, side, kind: 'dispute', result: counterResult, reason: reason.slice(0, 500), source });
    ctx.db.prepare("UPDATE matches SET status = 'disputed', updated_at = ? WHERE id = ?").run(nowIso(ctx), m.id);
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
    enqueue(ctx, { tournamentId: t.id, matchId: m.id, category: 'organizer_alert', key: `m${m.id}:disputed:v${m.result_version}:${actorId}`, audience: 'admins', payload: { text: `A player disputed the reported result of match ${m.id} ("${reason.slice(0, 200)}"). Resolve it: ${ctx.env.WEB_URL}/#/m/${m.id}` } });
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'result.disputed', target: `match:${m.id}`, details: { reason, counter: counterResult ? describeSeries(counterResult) : null, source } });
  });
  ctx.kick(t.id);
  return getMatch(ctx, m.id)!;
}

/** Live (unconfirmed) game-by-game progress, shown to spectators as "unofficial". */
export async function reportProgress(ctx: AppContext, actorId: string, matchId: number, games: GameScore[]) {
  const { m, t } = load(ctx, matchId);
  assertPlayable(t);
  if (!sideOf(ctx, m, actorId)) throw forbidden('Only players in this match can update the live score.');
  if (m.status !== 'ready') throw conflict('not_live', 'Live scores can only be updated while the match is being played.');
  if (games.length > m.best_of) throw invalid('too_many_games', `Best of ${m.best_of}.`);
  let wa = 0;
  let wb = 0;
  for (const g of games) {
    if (!Number.isInteger(g.a) || !Number.isInteger(g.b) || g.a < 0 || g.b < 0 || g.a === g.b) throw invalid('bad_goals', 'Each game needs a winner and whole-number goals.');
    if (wa >= winsNeeded(m.best_of) || wb >= winsNeeded(m.best_of)) throw invalid('games_after_clinch', 'The series is already decided; report the final result.');
    if (g.a > g.b) wa++;
    else wb++;
  }
  ctx.db.prepare('UPDATE matches SET live_games = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(games), nowIso(ctx), m.id);
  ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
}

/** Matches (completed or reported) whose result depends on `m`; corrections must reset them. */
export function downstreamImpact(ctx: AppContext, m: MatchRow): MatchRow[] {
  if (!m.source_a) {
    // Swiss / round robin / 6mans group: results do not feed other matches' slots.
    return [];
  }
  const all = matchesOf(ctx, m.tournament_id, m.stage);
  const core = all.filter((x) => x.source_a).map((x) => ({ key: x.key, sourceA: JSON.parse(x.source_a!), sourceB: JSON.parse(x.source_b!) })) as Parameters<typeof dependentsOf>[0];
  const keys = new Set(dependentsOf(core, m.key));
  return all.filter((x) => keys.has(x.key) && (x.status === 'completed' && !x.walkover ? true : ['awaiting_confirmation', 'disputed'].includes(x.status)));
}

function resetMatch(ctx: AppContext, m: MatchRow, actorId: string, reason: string, source: Source) {
  const now = nowIso(ctx);
  ctx.db.prepare('UPDATE result_reports SET superseded = 1 WHERE match_id = ? AND superseded = 0').run(m.id);
  insertReport(ctx, m, { userId: actorId, side: null, kind: 'reset', reason, source });
  const clearSlots = m.source_a ? ', competitor_a = NULL, competitor_b = NULL' : '';
  ctx.db
    .prepare(
      `UPDATE matches SET status = ?, winner = NULL, wins_a = NULL, wins_b = NULL, goals_a = NULL, goals_b = NULL, games = NULL, live_games = NULL,
         walkover = 0, forfeit = 0, completed_at = NULL, result_version = result_version + 1, updated_at = ?${clearSlots} WHERE id = ?`,
    )
    .run(m.source_a ? 'pending' : 'ready', now, m.id);
}

/**
 * Organizer result entry / dispute resolution / correction of a completed match.
 * Corrections require a reason. If later matches depend on the corrected one, the call fails with
 * the impact list unless `confirmDownstream` is true, in which case those matches are reset.
 */
export async function adminResolve(
  ctx: AppContext, actorId: string, matchId: number, input: ReportInput & { forfeitWinner?: 'a' | 'b' | null }, reason: string | null, confirmDownstream: boolean, source: Source,
) {
  const { m, t } = load(ctx, matchId);
  const access = await getAccess(ctx, t, actorId);
  if (!access.canManage) throw forbidden('Only tournament organizers can enter or correct results.');
  if (t.state === 'completed') throw conflict('tournament_finished', 'The tournament is complete; its results are final.');
  if (t.state !== 'in_progress' && t.state !== 'paused') throw conflict('not_running', 'This tournament is not in progress.');
  if (m.status === 'pending' || m.status === 'void' || m.status === 'cancelled') throw conflict('not_reportable', `This match is ${m.status}.`);
  if (m.walkover) throw conflict('walkover', 'This match was a bye.');
  if (m.stage === 'group' && t.stage !== 'group') throw conflict('group_locked', 'The group stage is finished and qualification is decided; group results can no longer change.');
  const hadReports = m.status !== 'ready' || activeReports(ctx, m).length > 0;
  const isCorrection = m.status === 'completed';
  if ((hadReports || isCorrection || input.forfeitWinner) && !reason?.trim()) throw invalid('reason_required', 'A reason is required for organizer overrides and corrections.');
  let result: SeriesResult;
  if (input.forfeitWinner) {
    const need = winsNeeded(m.best_of);
    result = { winsA: input.forfeitWinner === 'a' ? need : 0, winsB: input.forfeitWinner === 'b' ? need : 0, winner: input.forfeitWinner, goalsA: 0, goalsB: 0, games: [] };
  } else result = parseResult(t, m, input);
  const impact = isCorrection ? downstreamImpact(ctx, m) : [];
  if (impact.length && !confirmDownstream)
    throw conflict('downstream_impact', `Correcting this result resets ${impact.length} later match(es). Confirm to continue.`, {
      matches: impact.map((x) => ({ id: x.id, key: x.key, status: x.status, round: x.round, bracket: x.bracket })),
    });
  tx(ctx, () => {
    let current = getMatch(ctx, m.id)!;
    if (current.result_version !== m.result_version) throw conflict('match_changed', 'This match was updated at the same time. Reload and try again.');
    if (isCorrection) {
      for (const d of impact.sort((a, b) => b.round - a.round)) resetMatch(ctx, getMatch(ctx, d.id)!, actorId, `Reset by correction of match ${m.id}: ${reason}`, source);
      // Reopen the corrected match (keeps its competitors) then write the corrected result.
      const before = { winner: current.winner, winsA: current.wins_a, winsB: current.wins_b, games: current.games };
      ctx.db.prepare('UPDATE result_reports SET superseded = 1 WHERE match_id = ? AND superseded = 0').run(m.id);
      ctx.db.prepare("UPDATE matches SET status = 'ready', result_version = result_version + 1, updated_at = ? WHERE id = ?").run(nowIso(ctx), m.id);
      current = getMatch(ctx, m.id)!;
      insertReport(ctx, current, { userId: actorId, side: null, kind: 'correction', result, reason, source });
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'result.corrected', target: `match:${m.id}`, details: { before, after: describeSeries(result), reason, reset: impact.map((x) => x.id), source } });
      if (impact.length) enqueue(ctx, { tournamentId: t.id, category: 'bracket_change', key: `m${m.id}:correction:v${current.result_version}`, audience: 'participants', payload: { text: `A result was corrected and ${impact.length} later match(es) were reset.` } });
    } else {
      ctx.db.prepare('UPDATE result_reports SET superseded = 1 WHERE match_id = ? AND superseded = 0').run(m.id);
      insertReport(ctx, current, { userId: actorId, side: null, kind: input.forfeitWinner ? 'forfeit' : 'admin_result', result, reason, source });
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: input.forfeitWinner ? 'result.forfeit' : 'result.admin_entered', target: `match:${m.id}`, details: { result: describeSeries(result), reason, wasStatus: m.status, source } });
    }
    completeMatch(ctx, t, current, result, { forfeit: !!input.forfeitWinner, event: isCorrection ? 'corrected' : 'completed' });
    // Corrections can reopen dependants; re-run advancement for the whole stage.
    if (isCorrection) advance(ctx, t.id, m.stage);
  });
  ctx.kick(t.id);
  return getMatch(ctx, m.id)!;
}

/** Abandon a 6mans group match (policy decides whether it counts as a loss for everyone). */
export async function abandonMatch(ctx: AppContext, actorId: string, matchId: number, reason: string, source: Source) {
  const { m, t } = load(ctx, matchId);
  if (!(await getAccess(ctx, t, actorId)).canManage) throw forbidden('Only organizers can abandon matches.');
  if (m.stage !== 'group') throw invalid('not_group', 'Only 6mans group matches can be abandoned; use a forfeit for bracket matches.');
  if (!OPEN.has(m.status)) throw conflict('not_open', 'Only unfinished matches can be abandoned.');
  if (!reason.trim()) throw invalid('reason_required', 'A reason is required.');
  tx(ctx, () => {
    ctx.db.prepare('UPDATE result_reports SET superseded = 1 WHERE match_id = ? AND superseded = 0').run(m.id);
    ctx.db.prepare("UPDATE matches SET status = 'cancelled', result_version = result_version + 1, updated_at = ? WHERE id = ?").run(nowIso(ctx), m.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'result.abandoned', target: `match:${m.id}`, details: { reason, policy: t.cfg.sixmans.abandoned, source } });
    cancelPending(ctx, { tournamentId: t.id, matchId: m.id });
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
    advance(ctx, t.id, 'group');
  });
  ctx.kick(t.id);
}

/** Auto-confirm reports older than the configured window (if enabled). */
export function autoConfirmDue(ctx: AppContext): number {
  const rows = ctx.db
    .prepare("SELECT m.id, m.tournament_id FROM matches m JOIN tournaments t ON t.id = m.tournament_id WHERE m.status = 'awaiting_confirmation' AND t.state = 'in_progress'")
    .all() as { id: number; tournament_id: number }[];
  let done = 0;
  for (const r of rows) {
    const t = loadTournament(ctx, r.tournament_id);
    const minutes = t.cfg.results.autoConfirmMinutes;
    if (minutes == null) continue;
    const m = getMatch(ctx, r.id)!;
    const reports = activeReports(ctx, m).filter((x) => x.kind === 'report');
    const last = reports[reports.length - 1];
    if (!last || ctx.clock.now().getTime() - Date.parse(last.created_at) < minutes * 60000) continue;
    tx(ctx, () => {
      insertReport(ctx, m, { userId: null, side: null, kind: 'auto_confirm', result: asResult(last), reason: `No response within ${minutes} minutes`, source: 'system' });
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId: null, action: 'result.auto_confirmed', target: `match:${m.id}`, details: { minutes } });
      completeMatch(ctx, t, m, asResult(last));
    });
    ctx.kick(t.id);
    done++;
  }
  return done;
}

export function reportsFor(ctx: AppContext, matchId: number) {
  return (ctx.db.prepare('SELECT r.*, u.username, u.global_name FROM result_reports r LEFT JOIN users u ON u.id = r.user_id WHERE r.match_id = ? ORDER BY r.id').all(matchId) as (ReportRow & { username: string | null; global_name: string | null })[]).map((r) => ({
    id: r.id, userId: r.user_id, userName: r.global_name ?? r.username ?? (r.user_id ? r.user_id : 'system'), side: r.side, kind: r.kind,
    winsA: r.wins_a, winsB: r.wins_b, games: json<GameScore[]>(r.games, []), reason: r.reason, source: r.source, superseded: !!r.superseded, resultVersion: r.result_version, createdAt: r.created_at,
  }));
}

/** Swap two competitors between unplayed matches of the same round (operational bracket fix). */
export async function swapCompetitors(ctx: AppContext, actorId: string, input: { matchA: number; slotA: 'a' | 'b'; matchB: number; slotB: 'a' | 'b'; reason: string }, source: Source) {
  const { m: ma, t } = load(ctx, input.matchA);
  const mb = getMatch(ctx, input.matchB);
  if (!mb || mb.tournament_id !== t.id) throw notFound('Match');
  if (!(await getAccess(ctx, t, actorId)).canManage) throw forbidden('Only organizers can adjust the bracket.');
  if (!input.reason?.trim()) throw invalid('reason_required', 'A reason is required for bracket adjustments.');
  if (t.state !== 'in_progress' && t.state !== 'paused') throw conflict('not_running', 'Bracket adjustments after the start are for running tournaments; before the start, edit seeding.');
  for (const [x, slot] of [[ma, input.slotA], [mb, input.slotB]] as [MatchRow, 'a' | 'b'][]) {
    if (x.status !== 'ready' || activeReports(ctx, x).length) throw conflict('match_started', `Match ${x.id} already has results or reports.`);
    if (x.stage === 'group') throw invalid('group', '6mans group teams are fixed by the no-repeat schedule.');
    if (x.bracket === 'rr') throw invalid('rr', 'Round-robin schedules cannot be re-paired.');
    const raw = slot === 'a' ? x.source_a : x.source_b;
    if (raw && JSON.parse(raw).type !== 'entrant') throw invalid('fed_slot', 'Only first-round (seeded) bracket slots can be swapped; later slots are filled by results.');
  }
  if (ma.stage !== mb.stage || ma.round !== mb.round || ma.bracket !== mb.bracket) throw invalid('different_round', 'Both matches must be in the same round.');
  tx(ctx, () => {
    const ca = input.slotA === 'a' ? ma.competitor_a : ma.competitor_b;
    const cb = input.slotB === 'a' ? mb.competitor_a : mb.competitor_b;
    const setSlot = (m: MatchRow, slot: 'a' | 'b', cid: number | null) => {
      const col = slot === 'a' ? 'competitor_a' : 'competitor_b';
      const srcCol = slot === 'a' ? 'source_a' : 'source_b';
      ctx.db
        .prepare(`UPDATE matches SET ${col} = ?, ${srcCol} = CASE WHEN ${srcCol} IS NULL THEN NULL ELSE ? END, result_version = result_version + 1, updated_at = ? WHERE id = ?`)
        .run(cid, JSON.stringify({ type: 'entrant', entrantId: String(cid) }), nowIso(ctx), m.id);
    };
    if (ma.id === mb.id) {
      setSlot(ma, input.slotA, cb);
      setSlot(getMatch(ctx, ma.id)!, input.slotB, ca);
    } else {
      setSlot(ma, input.slotA, cb);
      setSlot(mb, input.slotB, ca);
    }
    const a2 = getMatch(ctx, ma.id)!;
    const b2 = getMatch(ctx, mb.id)!;
    for (const x of [a2, b2]) if (x.competitor_a && x.competitor_a === x.competitor_b) throw invalid('same_competitor', 'A competitor cannot play itself.');
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'bracket.swapped', target: `match:${ma.id},${mb.id}`, details: { ...input, source } });
    enqueue(ctx, { tournamentId: t.id, category: 'bracket_change', key: `swap:${ma.id}:${mb.id}:${a2.result_version}`, audience: 'participants', payload: { text: 'Organizers adjusted the pairings for the current round.' } });
    enqueue(ctx, { tournamentId: t.id, matchId: a2.id, category: 'match_assigned', key: `m${a2.id}:assigned:v${a2.result_version}`, audience: 'match' });
    if (b2.id !== a2.id) enqueue(ctx, { tournamentId: t.id, matchId: b2.id, category: 'match_assigned', key: `m${b2.id}:assigned:v${b2.result_version}`, audience: 'match' });
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
  });
  ctx.kick(t.id);
}

/**
 * Roster correction after the start: replace a player in every unfinished match (and the
 * competitor's roster). For 6mans group matches the no-repeat-trio rule is re-checked.
 */
export async function replacePlayer(ctx: AppContext, actorId: string, tournamentId: number, input: { outUserId: string; inUserId: string; reason: string }, source: Source) {
  const t = loadTournament(ctx, tournamentId);
  if (!(await getAccess(ctx, t, actorId)).canManage) throw forbidden('Only organizers can make roster corrections.');
  if (t.state !== 'in_progress' && t.state !== 'paused') throw conflict('not_running', 'Before the start, edit registrations instead.');
  if (!input.reason?.trim()) throw invalid('reason_required', 'A reason is required.');
  const { ensureUser } = await import('./users.js');
  const { memberFacts } = await import('./guilds.js');
  ensureUser(ctx, input.inUserId);
  if (!(await memberFacts(ctx, t.guild_id, input.inUserId)).isMember) throw invalid('not_member', 'The replacement must be a member of the Discord server.');
  tx(ctx, () => {
    const open = matchesOf(ctx, t.id).filter((m) => OPEN.has(m.status) || m.status === 'pending');
    const comps = new Set<number>();
    for (const m of open) for (const c of [m.competitor_a, m.competitor_b]) if (c) comps.add(c);
    // Competitors in unfinished matches that contain the outgoing player.
    const affected = [...comps].filter((c) => ctx.db.prepare('SELECT 1 FROM competitor_members WHERE competitor_id = ? AND user_id = ?').get(c, input.outUserId));
    if (!affected.length) throw notFound('That player in any unfinished match');
    for (const c of affected) {
      const clash = ctx.db.prepare('SELECT 1 FROM competitor_members WHERE competitor_id = ? AND user_id = ?').get(c, input.inUserId);
      if (clash) throw conflict('already_on_team', 'The replacement is already on that team.');
      const inMatch = open.filter((m) => m.competitor_a === c || m.competitor_b === c);
      for (const m of inMatch) {
        const oppo = m.competitor_a === c ? m.competitor_b : m.competitor_a;
        if (oppo && ctx.db.prepare('SELECT 1 FROM competitor_members WHERE competitor_id = ? AND user_id = ?').get(oppo, input.inUserId))
          throw conflict('on_other_side', `The replacement is on the opposing side in match ${m.id}.`);
      }
      ctx.db.prepare('UPDATE competitor_members SET user_id = ? WHERE competitor_id = ? AND user_id = ?').run(input.inUserId, c, input.outUserId);
      const groupMatch = inMatch.find((m) => m.stage === 'group');
      if (groupMatch) {
        const members = (ctx.db.prepare('SELECT user_id FROM competitor_members WHERE competitor_id = ?').all(c) as { user_id: string }[]).map((r) => r.user_id).sort();
        ctx.db.prepare('DELETE FROM sixmans_trios WHERE match_id = ? AND trio_key LIKE ?').run(groupMatch.id, `%${input.outUserId}%`);
        try {
          ctx.db.prepare('INSERT INTO sixmans_trios (pool_id, trio_key, match_id) VALUES (?, ?, ?)').run(groupMatch.pool_id, members.join('|'), groupMatch.id);
        } catch {
          throw conflict('repeated_trio', `That replacement would repeat a trio (${members.join(', ')}) in this pool. Choose another player.`);
        }
      }
      ctx.db.prepare('UPDATE matches SET result_version = result_version + 1, updated_at = ? WHERE (competitor_a = ? OR competitor_b = ?) AND status IN (\'pending\',\'ready\',\'awaiting_confirmation\',\'disputed\')').run(nowIso(ctx), c, c);
    }
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'roster.replaced', details: { ...input, competitors: affected, source } });
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
  });
  ctx.kick(t.id);
}

// ---------------------------------------------------------------------------------------------
// Discord vote cards: players vote for the winning team; enough matching votes complete the match.
// ---------------------------------------------------------------------------------------------

export interface MatchVote {
  userId: string;
  voterSide: 'a' | 'b';
  winner: 'a' | 'b';
}

export interface VoteRules {
  votesNeeded: number;
  requireBothTeams: boolean;
}

export interface VoteTally {
  a: number;
  b: number;
  /** The team the votes have decided on, if any. */
  winner: 'a' | 'b' | null;
  /** Both teams have enough votes for different winners: an organizer has to decide. */
  conflict: boolean;
}

/**
 * A team wins the vote when it has at least `votesNeeded` votes, more votes than the other team and
 * (with `requireBothTeams`) at least one of those votes comes from each team.
 */
export function tallyVotes(votes: MatchVote[], rules: VoteRules): VoteTally {
  const count = { a: 0, b: 0 };
  const voters = { a: new Set<string>(), b: new Set<string>() };
  for (const v of votes) {
    count[v.winner]++;
    voters[v.winner].add(v.voterSide);
  }
  const wins = (x: 'a' | 'b') => {
    const o = x === 'a' ? 'b' : 'a';
    return count[x] >= rules.votesNeeded && count[x] > count[o] && (!rules.requireBothTeams || voters[x].size === 2);
  };
  const winner = wins('a') ? 'a' : wins('b') ? 'b' : null;
  return { ...count, winner, conflict: !winner && count.a >= rules.votesNeeded && count.b >= rules.votesNeeded };
}

export function matchVotes(ctx: AppContext, m: Pick<MatchRow, 'id' | 'result_version'>): MatchVote[] {
  return (ctx.db.prepare('SELECT user_id, voter_side, winner FROM match_votes WHERE match_id = ? AND result_version = ? ORDER BY created_at, user_id').all(m.id, m.result_version) as {
    user_id: string; voter_side: 'a' | 'b'; winner: 'a' | 'b';
  }[]).map((r) => ({ userId: r.user_id, voterSide: r.voter_side, winner: r.winner }));
}

/** A player in the match votes (or changes their vote) for the team that won. */
export async function voteResult(ctx: AppContext, actorId: string, matchId: number, winner: 'a' | 'b', source: Source) {
  const { m, t } = load(ctx, matchId);
  assertPlayable(t);
  const side = sideOf(ctx, m, actorId);
  if (!side) throw forbidden('Only the players in this match can vote on its result.');
  if (m.status === 'disputed') throw conflict('disputed', 'The votes disagree, so an organizer will set this result.');
  if (m.status !== 'ready' && m.status !== 'awaiting_confirmation')
    throw conflict('not_reportable', m.status === 'completed' ? 'This match already has a result. Ask an organizer for a correction.' : `This match is ${m.status}.`);
  if (t.cfg.results.confirmation === 'admin_only') throw forbidden('In this tournament only organizers enter results.');
  const rules = t.cfg.scoreReports;
  let outcome = 'counted' as 'counted' | 'unchanged' | 'completed' | 'disputed';
  let tally: VoteTally = { a: 0, b: 0, winner: null, conflict: false };
  tx(ctx, () => {
    const fresh = getMatch(ctx, m.id)!;
    if (fresh.result_version !== m.result_version || !OPEN.has(fresh.status)) throw conflict('match_changed', 'This match was updated at the same time. Try again.');
    const prev = ctx.db.prepare('SELECT winner FROM match_votes WHERE match_id = ? AND result_version = ? AND user_id = ?').get(m.id, m.result_version, actorId) as { winner: string } | undefined;
    if (prev?.winner === winner) outcome = 'unchanged';
    const now = nowIso(ctx);
    ctx.db
      .prepare(
        `INSERT INTO match_votes (match_id, result_version, user_id, voter_side, winner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_id, result_version, user_id) DO UPDATE SET winner = excluded.winner, updated_at = excluded.updated_at`,
      )
      .run(m.id, m.result_version, actorId, side, winner, now, now);
    const votes = matchVotes(ctx, m);
    tally = tallyVotes(votes, rules);
    if (tally.winner) {
      const need = winsNeeded(m.best_of);
      const result: SeriesResult = { winsA: tally.winner === 'a' ? need : 0, winsB: tally.winner === 'b' ? need : 0, winner: tally.winner, goalsA: 0, goalsB: 0, games: [] };
      ctx.db.prepare('UPDATE result_reports SET superseded = 1 WHERE match_id = ? AND superseded = 0').run(m.id);
      votes.filter((v) => v.winner === tally.winner).forEach((v, i) => insertReport(ctx, m, { userId: v.userId, side: v.voterSide, kind: i === 0 ? 'report' : 'confirm', result, reason: 'Discord vote', source }));
      audit(ctx, {
        guildId: t.guild_id, tournamentId: t.id, actorId, action: 'result.voted', target: `match:${m.id}`,
        details: { winner: tally.winner, votes: votes.map((v) => ({ user: v.userId, side: v.voterSide, winner: v.winner })), rules, source },
      });
      completeMatch(ctx, t, m, result);
      outcome = 'completed';
    } else if (tally.conflict && fresh.status !== 'disputed') {
      ctx.db.prepare("UPDATE matches SET status = 'disputed', updated_at = ? WHERE id = ?").run(now, m.id);
      enqueue(ctx, { tournamentId: t.id, matchId: m.id, category: 'organizer_alert', key: `m${m.id}:vote-conflict:v${m.result_version}`, audience: 'admins', payload: { text: `The players of match ${m.id} voted for different winners (${tally.a}–${tally.b}). Set the result: ${ctx.env.WEB_URL}/#/m/${m.id}` } });
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'result.disputed', target: `match:${m.id}`, details: { votes: { a: tally.a, b: tally.b }, source } });
      outcome = 'disputed';
    }
    ctx.db.prepare('UPDATE tournaments SET version = version + 1, updated_at = ? WHERE id = ?').run(now, t.id);
  });
  ctx.kick(t.id);
  return { outcome, tally, side, match: getMatch(ctx, m.id)! };
}
