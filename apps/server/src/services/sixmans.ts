import {
  buildFinalsBracket, computeSixmansStandings, computeSkills, conflict, crossPoolOrder, defaultQualifiersPerPool, finalsOptions, formFinalsTeams, invalid,
  handPickedOption, isPreStart, makePools, planEqualRounds, notFound, qualify, scheduleGroupStage, swapInRound, validateFinalsTeams, validatePools, validateSchedule,
  type FinalsOption, type FinalsTeam, type FinalsTeamFormation, type PlayerStanding, type QualifierEntry, type SixmansMatchResult, type SkilledPlayer,
} from '@rl/core';
import type { AppContext, Source } from './context.js';
import { nowIso, tx } from './context.js';
import { assertManage, loadTournament, type LoadedTournament } from './access.js';
import { audit } from './audit.js';
import { enqueue } from './notifications.js';
import { matchesOf, type MatchRow } from './queries.js';
import { entriesOf } from './registration.js';
import { randomInt } from 'node:crypto';
import { sha256 } from '../lib/util.js';
import { userNames } from './users.js';
import { insertMatch, notifyNewlyReady, syncBracket, type SchedulePlanData } from './engine.js';

/**
 * 6mans workflow (organizer):
 *   1. Make Pools  -> proposal (preview), optionally edit, then Confirm Pools (materialises pools).
 *   2. Generate Schedule for N rounds -> proposal with feasibility report, optional swaps, Confirm.
 *   3. Start the tournament (group stage). Rounds open one at a time per pool.
 *   4. When every group match is done, a finals proposal is created automatically: qualifiers,
 *      valid finals structures, balanced 3-player teams and the bracket preview. Organizers can pick
 *      another structure, move players between teams, then Start Finals.
 * Every proposal stores a fingerprint of its inputs so a stale proposal can never be used.
 */

export interface PlanRow {
  tournament_id: number;
  kind: 'pools' | 'schedule' | 'finals';
  status: 'proposed' | 'confirmed';
  data: string;
  fingerprint: string;
  created_by: string;
  created_at: string;
}

export interface PoolsPlanData {
  poolCount: number;
  seed: number;
  pools: { index: number; name: string; players: { userId: string; skill: number; imputed: boolean }[] }[];
  averages: number[];
  averageSpread: number;
}

export interface FinalsPlanData {
  qualifiersPerPool: number;
  qualified: QualifierEntry[];
  others: QualifierEntry[];
  options: FinalsOption[];
  optionId: string;
  teams: FinalsTeam[];
  bracket: { round: number; position: number; a: string | null; b: string | null }[];
  /** How the bracket is built and the teams formed. Defaults come from the settings; Finals setup can change them. Older plans lack these. */
  bracketFormat?: 'single_elim' | 'double_elim';
  thirdPlace?: boolean;
  grandFinalReset?: boolean;
  formation?: FinalsTeamFormation;
  /** Pool based formation could not keep every team inside one pool. */
  mixedPoolTeams?: number;
}

export interface FinalsChoices {
  optionId?: string | null;
  qualifiersPerPool?: number | null;
  bracketFormat?: 'single_elim' | 'double_elim';
  thirdPlace?: boolean;
  grandFinalReset?: boolean;
  formation?: FinalsTeamFormation;
}

export function currentPlan(ctx: AppContext, tournamentId: number, kind: PlanRow['kind']): PlanRow | undefined {
  return ctx.db.prepare('SELECT * FROM sixmans_plans WHERE tournament_id = ? AND kind = ?').get(tournamentId, kind) as PlanRow | undefined;
}

function savePlan(ctx: AppContext, t: LoadedTournament, kind: PlanRow['kind'], status: PlanRow['status'], data: unknown, fingerprint: string, actorId: string | null) {
  ctx.db
    .prepare(
      `INSERT INTO sixmans_plans (tournament_id, kind, status, data, fingerprint, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tournament_id, kind) DO UPDATE SET status = excluded.status, data = excluded.data, fingerprint = excluded.fingerprint, created_by = excluded.created_by, created_at = excluded.created_at`,
    )
    .run(t.id, kind, status, JSON.stringify(data), fingerprint, actorId ?? 'system', nowIso(ctx));
  ctx.db.prepare('UPDATE tournaments SET version = version + 1, updated_at = ? WHERE id = ?').run(nowIso(ctx), t.id);
}

function assertSixmans(t: LoadedTournament) {
  if (t.cfg.format !== 'sixmans') throw invalid('not_sixmans', 'This is not a 6mans tournament.');
}

/** Skill values for the confirmed players, from the tournament's selected skill method. */
export function confirmedSkills(ctx: AppContext, t: LoadedTournament): SkilledPlayer[] {
  const entries = entriesOf(ctx, t.id, ['confirmed']).filter((e) => e.kind === 'player');
  return computeSkills(entries.map((e) => ({ id: e.user_id!, seed: e.seed, rank: e.rank, division: e.rank_division })), t.cfg);
}

export function planFingerprints(ctx: AppContext, t: LoadedTournament, playerIds?: string[]) {
  const skills = confirmedSkills(ctx, t).filter((s) => !playerIds || playerIds.includes(s.id));
  const pools = sha256(JSON.stringify({ players: skills.map((s) => [s.id, s.skill]).sort(), method: t.cfg.sixmans.skillMethod, count: t.cfg.sixmans.poolCount }));
  const poolRows = ctx.db.prepare('SELECT p.idx, pm.user_id FROM pools p JOIN pool_members pm ON pm.pool_id = p.id WHERE p.tournament_id = ? ORDER BY p.idx, pm.user_id').all(t.id);
  const schedule = sha256(
    JSON.stringify({
      pools: poolRows, rounds: t.cfg.sixmans.roundsPerPool,
      // Only in equal-games mode, so schedules confirmed before that mode existed (fixed) stay valid.
      ...(t.cfg.sixmans.roundsMode === 'equal_games' ? { mode: 'equal_games', games: t.cfg.sixmans.gamesPerPlayer } : {}),
      m: t.cfg.sixmans.matchesPerRound, balanced: t.cfg.sixmans.skillBalancedTeams, poolsFp: pools,
    }),
  );
  return { pools, schedule };
}

async function prestartManager(ctx: AppContext, actorId: string, id: number) {
  const t = loadTournament(ctx, id);
  assertSixmans(t);
  await assertManage(ctx, t, actorId);
  if (!isPreStart(t.state)) throw conflict('format_locked', 'The group stage has started; pools and schedule are locked.');
  return t;
}

/** "Make Pools": propose an assignment. Replaces any previous proposal (and unconfirms pools). */
export async function makePoolsProposal(ctx: AppContext, actorId: string, id: number, poolCount: number | null, source: Source) {
  let t = await prestartManager(ctx, actorId, id);
  if (poolCount != null && poolCount !== t.cfg.sixmans.poolCount) {
    const { updateTournament } = await import('./tournaments.js');
    t = await updateTournament(ctx, actorId, id, { configPatch: { sixmans: { poolCount } } }, source);
  }
  const skills = confirmedSkills(ctx, t);
  // A fresh seed every time, so "Remake pools" can trade equal / near-equal players between pools.
  // The seed is stored with the proposal, so any proposal can be reproduced exactly.
  const seed = freshSeed();
  const res = makePools(skills, t.cfg.sixmans.poolCount, seed, { tolerance: t.cfg.sixmans.poolShuffleTolerance });
  const byId = new Map(skills.map((s) => [s.id, s]));
  const data: PoolsPlanData = {
    poolCount: t.cfg.sixmans.poolCount,
    seed,
    pools: res.pools.map((ids, i) => ({ index: i, name: `Pool ${String.fromCharCode(65 + i)}`, players: ids.map((u) => ({ userId: u, skill: byId.get(u)!.skill, imputed: byId.get(u)!.imputed })) })),
    averages: res.averages,
    averageSpread: res.averageSpread,
  };
  tx(ctx, () => {
    ctx.db.prepare("DELETE FROM sixmans_plans WHERE tournament_id = ? AND kind IN ('schedule','finals')").run(t.id);
    ctx.db.prepare('DELETE FROM pools WHERE tournament_id = ?').run(t.id);
    savePlan(ctx, t, 'pools', 'proposed', data, planFingerprints(ctx, t).pools, actorId);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'sixmans.pools_proposed', details: { poolCount: data.poolCount, players: skills.length, source } });
  });
  return data;
}

/** Organizer edits to the proposed pools (full assignment), validated. */
export async function editPools(ctx: AppContext, actorId: string, id: number, pools: string[][], source: Source) {
  const t = await prestartManager(ctx, actorId, id);
  const plan = currentPlan(ctx, t.id, 'pools');
  if (!plan) throw notFound('Pool proposal');
  const skills = confirmedSkills(ctx, t);
  const problems = validatePools(pools, skills.map((s) => s.id));
  if (problems.length) throw invalid('invalid_pools', problems.join(' '), { problems });
  const byId = new Map(skills.map((s) => [s.id, s]));
  const prev = JSON.parse(plan.data) as PoolsPlanData;
  const averages = pools.map((p) => p.reduce((s, u) => s + byId.get(u)!.skill, 0) / p.length);
  const data: PoolsPlanData = {
    ...prev,
    poolCount: pools.length,
    pools: pools.map((ids, i) => ({ index: i, name: prev.pools[i]?.name ?? `Pool ${String.fromCharCode(65 + i)}`, players: ids.map((u) => ({ userId: u, skill: byId.get(u)!.skill, imputed: byId.get(u)!.imputed })) })),
    averages,
    averageSpread: Math.max(...averages) - Math.min(...averages),
  };
  tx(ctx, () => {
    ctx.db.prepare("DELETE FROM sixmans_plans WHERE tournament_id = ? AND kind IN ('schedule','finals')").run(t.id);
    ctx.db.prepare('DELETE FROM pools WHERE tournament_id = ?').run(t.id);
    savePlan(ctx, t, 'pools', 'proposed', data, planFingerprints(ctx, t).pools, actorId);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'sixmans.pools_edited', details: { pools, source } });
  });
  return data;
}

export async function confirmPools(ctx: AppContext, actorId: string, id: number, source: Source) {
  const t = await prestartManager(ctx, actorId, id);
  const plan = currentPlan(ctx, t.id, 'pools');
  if (!plan) throw notFound('Pool proposal');
  if (plan.fingerprint !== planFingerprints(ctx, t).pools) throw conflict('stale_plan', 'Players or skill values changed since the pools were made. Make pools again.');
  const data = JSON.parse(plan.data) as PoolsPlanData;
  const problems = validatePools(data.pools.map((p) => p.players.map((x) => x.userId)), confirmedSkills(ctx, t).map((s) => s.id));
  if (problems.length) throw invalid('invalid_pools', problems.join(' '), { problems });
  tx(ctx, () => {
    ctx.db.prepare("DELETE FROM sixmans_plans WHERE tournament_id = ? AND kind IN ('schedule','finals')").run(t.id);
    ctx.db.prepare('DELETE FROM pools WHERE tournament_id = ?').run(t.id);
    for (const p of data.pools) {
      const r = ctx.db.prepare('INSERT INTO pools (tournament_id, idx, name) VALUES (?, ?, ?)').run(t.id, p.index, p.name);
      const pid = Number(r.lastInsertRowid);
      for (const pl of p.players) ctx.db.prepare('INSERT INTO pool_members (pool_id, tournament_id, user_id, skill) VALUES (?, ?, ?, ?)').run(pid, t.id, pl.userId, pl.skill);
    }
    if (data.poolCount !== t.cfg.sixmans.poolCount) {
      // Keep the config in sync with a manually changed pool count (pre-start only).
      const cfg = { ...t.cfg, sixmans: { ...t.cfg.sixmans, poolCount: data.poolCount } };
      ctx.db.prepare('UPDATE tournaments SET config = ? WHERE id = ?').run(JSON.stringify(cfg), t.id);
    }
    savePlan(ctx, loadTournament(ctx, t.id), 'pools', 'confirmed', data, plan.fingerprint, actorId);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'sixmans.pools_confirmed', details: { source } });
  });
  const { structureOf } = await import('./tournaments.js');
  const fresh = loadTournament(ctx, t.id);
  ctx.db.prepare('UPDATE tournaments SET structure = ? WHERE id = ?').run(structureOf(fresh.cfg), t.id);
  return data;
}

/** Random seed for a new proposal (regenerating should give a different, equally valid result). */
export function freshSeed(): number {
  return randomInt(0, 2 ** 31);
}

function poolsWithMembers(ctx: AppContext, tournamentId: number) {
  const pools = ctx.db.prepare('SELECT * FROM pools WHERE tournament_id = ? ORDER BY idx').all(tournamentId) as { id: number; idx: number; name: string }[];
  return pools.map((p) => ({
    ...p,
    members: ctx.db.prepare('SELECT user_id, skill FROM pool_members WHERE pool_id = ? ORDER BY skill DESC, user_id').all(p.id) as { user_id: string; skill: number }[],
  }));
}

export interface ScheduleInput {
  /** Fixed rounds for every pool (implies mode 'fixed' unless a mode is given). */
  rounds?: number;
  /** Equal-games target per player (implies mode 'equal_games' unless a mode is given); null = automatic. */
  games?: number | null;
  mode?: 'equal_games' | 'fixed';
  matchesPerRound?: number;
  skillBalanced?: boolean;
}

/** Rounds each pool plays under the tournament's settings, or the reasons it cannot be planned. */
export function roundsPerPoolPlan(t: LoadedTournament, poolSizes: number[]) {
  const s = t.cfg.sixmans;
  if (s.roundsMode === 'fixed') return { mode: 'fixed' as const, rounds: poolSizes.map(() => s.roundsPerPool), games: null, notes: [] as string[], problems: [] as string[] };
  const plan = planEqualRounds({ poolSizes, matchesPerRound: s.matchesPerRound, games: s.gamesPerPlayer });
  return { mode: 'equal_games' as const, rounds: plan.chosen?.rounds ?? [], games: plan.chosen?.games ?? null, notes: plan.notes, problems: plan.problems, options: plan.options };
}

/** Generate (preview) the group-stage schedule for every pool. */
export async function generateSchedule(ctx: AppContext, actorId: string, id: number, input: ScheduleInput, source: Source) {
  let t = await prestartManager(ctx, actorId, id);
  const pools = currentPlan(ctx, t.id, 'pools');
  if (!pools || pools.status !== 'confirmed') throw conflict('pools_not_confirmed', 'Confirm the pools first.');
  const patch: Record<string, unknown> = {};
  const mode = input.mode ?? (input.rounds != null ? 'fixed' : input.games !== undefined ? 'equal_games' : undefined);
  if (mode && mode !== t.cfg.sixmans.roundsMode) patch.roundsMode = mode;
  if (input.rounds != null && input.rounds !== t.cfg.sixmans.roundsPerPool) patch.roundsPerPool = input.rounds;
  if (input.games !== undefined && input.games !== t.cfg.sixmans.gamesPerPlayer) patch.gamesPerPlayer = input.games;
  if (input.matchesPerRound != null && input.matchesPerRound !== t.cfg.sixmans.matchesPerRound) patch.matchesPerRound = input.matchesPerRound;
  if (input.skillBalanced != null && input.skillBalanced !== t.cfg.sixmans.skillBalancedTeams) patch.skillBalancedTeams = input.skillBalanced;
  if (Object.keys(patch).length) {
    const { updateTournament } = await import('./tournaments.js');
    t = await updateTournament(ctx, actorId, id, { configPatch: { sixmans: patch } }, source);
  }
  const s = t.cfg.sixmans;
  const poolRows = poolsWithMembers(ctx, t.id);
  const rp = roundsPerPoolPlan(t, poolRows.map((p) => p.members.length));
  if (rp.problems.length) throw invalid('rounds_unplannable', rp.problems.join(' '), { problems: rp.problems });
  const seed = freshSeed();
  const notes = [...rp.notes];
  const data: SchedulePlanData = {
    rounds: Math.max(...rp.rounds), mode: rp.mode, games: rp.games, notes,
    matchesPerRound: s.matchesPerRound, skillBalanced: s.skillBalancedTeams, seed, pools: [],
  };
  for (const [i, p] of poolRows.entries()) {
    const rounds = rp.rounds[i];
    const result = scheduleGroupStage({
      players: p.members.map((m) => ({ id: m.user_id, skill: m.skill })),
      rounds,
      matchesPerRound: s.matchesPerRound,
      skillBalanced: s.skillBalancedTeams,
      seed: seed + p.idx,
      timeLimitMs: s.schedulerTimeLimitMs,
    });
    if (result.status === 'ok') {
      // Independent re-validation before anything is accepted.
      const v = validateSchedule(result, p.members.map((m) => m.user_id), { matchesPerRound: s.matchesPerRound, rounds, maxSpread: result.balance.spread });
      if (!v.valid) throw new Error(`Scheduler produced an invalid schedule for ${p.name}: ${v.errors.join('; ')}`);
      if (rp.mode === 'equal_games' && result.balance.spread !== 0) notes.push(`${p.name}: no schedule with exactly equal games was found in time; games per player are ${result.balance.min}–${result.balance.max}. Regenerate to try again.`);
    }
    data.pools.push({ poolId: p.id, poolIndex: p.idx, rounds, playerIds: p.members.map((m) => m.user_id), result });
  }
  tx(ctx, () => {
    savePlan(ctx, t, 'schedule', 'proposed', data, planFingerprints(ctx, t).schedule, actorId);
    audit(ctx, {
      guildId: t.guild_id, tournamentId: t.id, actorId, action: 'sixmans.schedule_generated',
      details: { mode: data.mode, games: data.games, rounds: data.pools.map((p) => p.rounds), statuses: data.pools.map((p) => p.result.status), source },
    });
  });
  return data;
}

/** Swap two players within one round of the proposed schedule (validated, rejects violations). */
export async function swapScheduledPlayers(ctx: AppContext, actorId: string, id: number, input: { poolIndex: number; round: number; playerA: string; playerB: string }, source: Source) {
  const t = await prestartManager(ctx, actorId, id);
  const plan = currentPlan(ctx, t.id, 'schedule');
  if (!plan) throw notFound('Schedule proposal');
  const data = JSON.parse(plan.data) as SchedulePlanData;
  const pool = data.pools.find((p) => p.poolIndex === input.poolIndex);
  if (!pool || pool.result.status !== 'ok') throw notFound('Pool schedule');
  if (!pool.playerIds.includes(input.playerA) || !pool.playerIds.includes(input.playerB)) throw invalid('not_in_pool', 'Both players must be in this pool.');
  const swapped = swapInRound(pool.result, input.round, input.playerA, input.playerB, pool.playerIds);
  const v = validateSchedule(swapped, pool.playerIds, { matchesPerRound: data.matchesPerRound, rounds: pool.rounds ?? data.rounds, maxSpread: pool.result.balance.spread });
  if (!v.valid) throw invalid('invalid_edit', `That change is not allowed: ${v.errors.join(' ')}`, { errors: v.errors });
  const skills = new Map(ctx.db.prepare('SELECT user_id, skill FROM pool_members WHERE pool_id = ?').all(pool.poolId).map((r) => [(r as { user_id: string }).user_id, (r as { skill: number }).skill]));
  for (const rd of swapped.rounds)
    for (const m of rd.matches) {
      m.skillA = m.teamA.reduce((s, u) => s + (skills.get(u) ?? 0), 0);
      m.skillB = m.teamB.reduce((s, u) => s + (skills.get(u) ?? 0), 0);
    }
  swapped.appearances = v.appearances;
  pool.result = swapped;
  tx(ctx, () => {
    savePlan(ctx, t, 'schedule', 'proposed', data, plan.fingerprint, actorId);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'sixmans.schedule_edited', details: { ...input, source } });
  });
  return data;
}

export async function confirmSchedule(ctx: AppContext, actorId: string, id: number, source: Source) {
  const t = await prestartManager(ctx, actorId, id);
  const plan = currentPlan(ctx, t.id, 'schedule');
  if (!plan) throw notFound('Schedule proposal');
  if (plan.fingerprint !== planFingerprints(ctx, t).schedule) throw conflict('stale_plan', 'Pools or round settings changed. Generate the schedule again.');
  const data = JSON.parse(plan.data) as SchedulePlanData;
  for (const p of data.pools) {
    if (p.result.status !== 'ok') {
      const inf = p.result.infeasibility;
      throw conflict('schedule_infeasible', `Pool ${p.poolIndex + 1} has no valid schedule: ${inf?.reasons.join(' ') ?? ''} ${inf?.alternatives.join(' ') ?? ''}`.trim(), { infeasibility: inf });
    }
    const v = validateSchedule(p.result, p.playerIds, { matchesPerRound: data.matchesPerRound, rounds: p.rounds ?? data.rounds, maxSpread: p.result.balance.spread });
    if (!v.valid) throw invalid('invalid_schedule', v.errors.join(' '));
  }
  tx(ctx, () => {
    savePlan(ctx, t, 'schedule', 'confirmed', data, plan.fingerprint, actorId);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'sixmans.schedule_confirmed', details: { source } });
  });
  return data;
}

// ---------------------------------------------------------------------------------------------
// Standings, qualification and finals
// ---------------------------------------------------------------------------------------------

export function groupResults(ctx: AppContext, t: LoadedTournament, poolId: number): SixmansMatchResult[] {
  const ms = matchesOf(ctx, t.id, 'group').filter((m) => m.pool_id === poolId);
  const members = (cid: number | null) =>
    cid ? (ctx.db.prepare('SELECT user_id FROM competitor_members WHERE competitor_id = ?').all(cid) as { user_id: string }[]).map((r) => r.user_id) : [];
  const out: SixmansMatchResult[] = [];
  for (const m of ms) {
    if (m.status === 'completed' && m.winner)
      out.push({ matchId: String(m.id), teamA: members(m.competitor_a), teamB: members(m.competitor_b), winner: m.winner, goalsA: m.goals_a ?? 0, goalsB: m.goals_b ?? 0, forfeit: !!m.forfeit });
    else if (m.status === 'cancelled' && t.cfg.sixmans.abandoned === 'loss_for_both')
      out.push({ matchId: String(m.id), teamA: members(m.competitor_a), teamB: members(m.competitor_b), winner: null, goalsA: 0, goalsB: 0, abandoned: true });
  }
  return out;
}

export function poolStandings(ctx: AppContext, t: LoadedTournament): { poolId: number; poolIndex: number; name: string; standings: PlayerStanding[] }[] {
  const pools = poolsWithMembers(ctx, t.id);
  const qualifiers = qualifiersPerPool(t);
  return pools.map((p) => {
    const scheduled: Record<string, number> = {};
    for (const m of matchesOf(ctx, t.id, 'group').filter((x) => x.pool_id === p.id && x.status !== 'cancelled')) {
      for (const cid of [m.competitor_a, m.competitor_b])
        for (const r of ctx.db.prepare('SELECT user_id FROM competitor_members WHERE competitor_id = ?').all(cid) as { user_id: string }[])
          scheduled[r.user_id] = (scheduled[r.user_id] ?? 0) + 1;
    }
    const standings = computeSixmansStandings(p.members.map((m) => ({ id: m.user_id, skill: m.skill })), groupResults(ctx, t, p.id), t.cfg, scheduled);
    for (const s of standings) s.qualified = s.rank <= qualifiers;
    return { poolId: p.id, poolIndex: p.idx, name: p.name, standings };
  });
}

export function qualifiersPerPool(t: LoadedTournament): number {
  return t.cfg.sixmans.qualifiersPerPool ?? defaultQualifiersPerPool(t.cfg.sixmans.poolCount);
}

function buildFinalsPlan(ctx: AppContext, t: LoadedTournament, choices: FinalsChoices): FinalsPlanData {
  const ps = poolStandings(ctx, t);
  const perPool = choices.qualifiersPerPool ?? qualifiersPerPool(t);
  const optionId = choices.optionId ?? null;
  const sm = t.cfg.sixmans;
  const formation = choices.formation ?? sm.finalsTeamFormation;
  const shape = { bracketFormat: choices.bracketFormat ?? sm.finalsBracket, thirdPlace: choices.thirdPlace ?? sm.finalsThirdPlace, grandFinalReset: choices.grandFinalReset ?? sm.finalsGrandFinalReset };
  const { qualified, others } = qualify(ps.map((p) => p.standings), perPool);
  const options = finalsOptions(qualified, others);
  const preferred = optionId ?? (options.find((o) => o.id === 'as_qualified') ? 'as_qualified' : t.cfg.sixmans.qualifierAdjustment);
  const option = options.find((o) => o.id === preferred) ?? options[0];
  const order = new Map([...qualified, ...others].sort(crossPoolOrder).map((q, i) => [q.playerId, i]));
  const skill = new Map([...qualified, ...others].map((q) => [q.playerId, q.skill]));
  const pool = new Map([...qualified, ...others].map((q) => [q.playerId, q.poolIndex]));
  const teams = formFinalsTeams(option.players.map((u) => ({ id: u, skill: skill.get(u) ?? 0, order: order.get(u) ?? 999, pool: pool.get(u) })), formation, t.cfg.seeding.seed);
  const names = userNames(ctx, option.players);
  for (const tm of teams) tm.name = `Team ${names.get(tm.players[0]) ?? tm.seed}`;
  const mixedPoolTeams = formation.startsWith('pool_') ? teams.filter((tm) => new Set(tm.players.map((u) => pool.get(u))).size > 1).length : 0;
  const data: FinalsPlanData = { qualifiersPerPool: perPool, qualified, others, options, optionId: option.id, teams, bracket: [], ...shape, formation, mixedPoolTeams };
  data.bracket = bracketPreview(data);
  return data;
}

const bracketOptions = (data: FinalsPlanData) => ({ format: data.bracketFormat ?? 'single_elim', thirdPlace: data.thirdPlace, grandFinalReset: data.grandFinalReset });

function bracketPreview(data: FinalsPlanData) {
  return buildFinalsBracket(data.teams.map((x) => x.key), bracketOptions(data))
    .filter((m) => m.round === 1 && (m.bracket === 'finals' || m.bracket === 'winners'))
    .map((m) => ({ round: m.round, position: m.position, a: m.sourceA.type === 'entrant' ? m.sourceA.entrantId : null, b: m.sourceB.type === 'entrant' ? m.sourceB.entrantId : null }));
}

const groupFingerprint = (ctx: AppContext, t: LoadedTournament) =>
  sha256(JSON.stringify(matchesOf(ctx, t.id, 'group').map((m) => [m.id, m.status, m.winner, m.result_version])));

/** Create or refresh the finals proposal. actorId null = automatic at group completion. */
export function proposeFinals(ctx: AppContext, t: LoadedTournament, actorId: string | null, choices: FinalsChoices = {}) {
  const data = buildFinalsPlan(ctx, t, choices);
  savePlan(ctx, t, 'finals', 'proposed', data, groupFingerprint(ctx, t), actorId);
  return data;
}

async function finalsManager(ctx: AppContext, actorId: string, id: number) {
  const t = loadTournament(ctx, id);
  assertSixmans(t);
  await assertManage(ctx, t, actorId);
  if (t.stage !== 'group_complete') throw conflict('wrong_stage', t.stage === 'finals' ? 'The finals have already started.' : 'The group stage is not complete yet.');
  return t;
}

export async function previewFinals(ctx: AppContext, actorId: string, id: number, input: FinalsChoices, source: Source) {
  const t = await finalsManager(ctx, actorId, id);
  return tx(ctx, () => {
    // Choices not given keep what the current proposal uses, so changing one picker keeps the others.
    const prev = currentPlan(ctx, t.id, 'finals');
    const old = prev ? (JSON.parse(prev.data) as FinalsPlanData) : null;
    // Only the bracket changes: keep the teams as they are (swaps and hand-picked teams included).
    if (prev && old && input.optionId === undefined && input.qualifiersPerPool === undefined && input.formation === undefined) {
      const data: FinalsPlanData = {
        ...old,
        bracketFormat: input.bracketFormat ?? old.bracketFormat ?? t.cfg.sixmans.finalsBracket,
        thirdPlace: input.thirdPlace ?? old.thirdPlace ?? t.cfg.sixmans.finalsThirdPlace,
        grandFinalReset: input.grandFinalReset ?? old.grandFinalReset ?? t.cfg.sixmans.finalsGrandFinalReset,
      };
      data.bracket = bracketPreview(data);
      savePlan(ctx, t, 'finals', 'proposed', data, prev.fingerprint, actorId);
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'sixmans.finals_previewed', details: { bracketFormat: data.bracketFormat, thirdPlace: data.thirdPlace, grandFinalReset: data.grandFinalReset, source } });
      return data;
    }
    const keep = <K extends keyof FinalsChoices>(k: K, v: FinalsChoices[K] | undefined) => (input[k] !== undefined ? input[k] : v);
    const data = proposeFinals(ctx, t, actorId, {
      optionId: input.optionId ?? null,
      qualifiersPerPool: input.qualifiersPerPool ?? null,
      bracketFormat: keep('bracketFormat', old?.bracketFormat),
      thirdPlace: keep('thirdPlace', old?.thirdPlace),
      grandFinalReset: keep('grandFinalReset', old?.grandFinalReset),
      formation: keep('formation', old?.formation),
    });
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'sixmans.finals_previewed', details: { optionId: data.optionId, qualifiersPerPool: data.qualifiersPerPool, bracketFormat: data.bracketFormat, formation: data.formation, source } });
    return data;
  });
}

/**
 * Organizer moves players between finals teams and/or reorders team seeds. With `handPicked` the
 * organizer builds the teams from scratch out of any group-stage players (qualified or not), as
 * many teams of three as they like; seeds follow the given order.
 */
export async function editFinalsTeams(ctx: AppContext, actorId: string, id: number, teams: { players: string[] }[], source: Source, opts: { handPicked?: boolean } = {}) {
  const t = await finalsManager(ctx, actorId, id);
  const plan = currentPlan(ctx, t.id, 'finals');
  if (!plan) throw notFound('Finals proposal');
  const data = JSON.parse(plan.data) as FinalsPlanData;
  if (opts.handPicked) {
    const groupPlayers = new Set([...data.qualified, ...data.others].map((q) => q.playerId));
    const outsiders = teams.flatMap((tm) => tm.players).filter((u) => !groupPlayers.has(u));
    if (outsiders.length) throw invalid('invalid_teams', `Only players from the group stage can play in the finals (${outsiders.length} other player(s) chosen).`);
    const custom = handPickedOption(teams, data.qualified.map((q) => q.playerId));
    data.options = [...data.options.filter((o) => o.id !== custom.id), custom];
    data.optionId = custom.id;
  }
  const option = data.options.find((o) => o.id === data.optionId)!;
  const problems = validateFinalsTeams(teams, option.players);
  if (problems.length) throw invalid('invalid_teams', problems.join(' '), { problems });
  const skill = new Map([...data.qualified, ...data.others].map((q) => [q.playerId, q.skill]));
  const names = userNames(ctx, option.players);
  data.teams = teams.map((tm, i) => ({ key: `team${i + 1}`, name: `Team ${names.get(tm.players[0]) ?? i + 1}`, players: tm.players, skill: tm.players.reduce((s, u) => s + (skill.get(u) ?? 0), 0), seed: i + 1 }));
  data.bracket = bracketPreview(data);
  tx(ctx, () => {
    savePlan(ctx, t, 'finals', 'proposed', data, plan.fingerprint, actorId);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'sixmans.finals_teams_edited', details: { teams: teams.map((x) => x.players), handPicked: !!opts.handPicked, source } });
  });
  return data;
}

export async function startFinals(ctx: AppContext, actorId: string, id: number, source: Source) {
  const t = await finalsManager(ctx, actorId, id);
  if (t.state !== 'in_progress') throw conflict('not_running', 'Resume the tournament before starting the finals.');
  const plan = currentPlan(ctx, t.id, 'finals');
  if (!plan) throw notFound('Finals proposal');
  if (plan.fingerprint !== groupFingerprint(ctx, t)) throw conflict('stale_plan', 'Group results changed since the finals were prepared. Refresh the finals preview.');
  const data = JSON.parse(plan.data) as FinalsPlanData;
  const option = data.options.find((o) => o.id === data.optionId)!;
  const problems = validateFinalsTeams(data.teams, option.players);
  if (problems.length) throw invalid('invalid_teams', problems.join(' '));
  tx(ctx, () => {
    const now = nowIso(ctx);
    const qualifiedSet = new Set(option.players);
    for (const q of [...data.qualified, ...data.others]) {
      const reason = qualifiedSet.has(q.playerId)
        ? option.added.includes(q.playerId) ? `Added by finals option "${option.label}"` : 'Qualified'
        : option.removed.includes(q.playerId) ? `Removed by finals option "${option.label}"` : 'Did not qualify';
      ctx.db
        .prepare('INSERT OR REPLACE INTO qualifications (tournament_id, user_id, pool_id, pool_rank, qualified, reason, decided_at) VALUES (?, ?, (SELECT id FROM pools WHERE tournament_id = ? AND idx = ?), ?, ?, ?, ?)')
        .run(t.id, q.playerId, t.id, q.poolIndex, q.poolRank, qualifiedSet.has(q.playerId) ? 1 : 0, reason, now);
    }
    const keyToCompetitor = new Map<string, number>();
    for (const tm of data.teams) {
      const r = ctx.db.prepare("INSERT INTO competitors (tournament_id, entry_id, kind, stage, name, seed, created_at) VALUES (?, NULL, 'temp_team', 'finals', ?, ?, ?)").run(t.id, tm.name, tm.seed, now);
      const cid = Number(r.lastInsertRowid);
      keyToCompetitor.set(tm.key, cid);
      for (const u of tm.players) ctx.db.prepare("INSERT INTO competitor_members (competitor_id, user_id, role) VALUES (?, ?, 'player')").run(cid, u);
    }
    const bracket = buildFinalsBracket(data.teams.map((x) => String(keyToCompetitor.get(x.key))), bracketOptions(data));
    for (const bm of bracket)
      insertMatch(ctx, t, { stage: 'finals', bracket: bm.bracket, round: bm.round, position: bm.position, key: bm.key, sourceA: bm.sourceA, sourceB: bm.sourceB, status: 'pending' });
    ctx.db.prepare("UPDATE tournaments SET stage = 'finals', version = version + 1, updated_at = ? WHERE id = ?").run(now, t.id);
    savePlan(ctx, t, 'finals', 'confirmed', data, plan.fingerprint, actorId);
    const fresh = loadTournament(ctx, t.id);
    notifyNewlyReady(ctx, fresh, syncBracket(ctx, fresh, 'finals'));
    enqueue(ctx, { tournamentId: t.id, category: 'bracket_change', key: `t${t.id}:finals_started`, audience: 'participants', payload: { text: 'The finals bracket is live!' } });
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'sixmans.finals_started', details: { optionId: data.optionId, teams: data.teams.map((x) => x.players), source } });
  });
  ctx.kick(t.id);
}

export type { MatchRow };
