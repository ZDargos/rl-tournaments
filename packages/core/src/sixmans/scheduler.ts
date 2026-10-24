import { invalid } from '../errors.js';
import { tieKey } from '../rng.js';

/**
 * 6mans group-stage scheduler.
 *
 * Problem: for one pool of n players, build R rounds. Each round has m matches (default 1); each
 * match has two teams of three distinct players; nobody plays twice in a round.
 *
 * Constraint priority (highest first):
 *   1. HARD: a trio (unordered set of 3 teammates) never appears twice in the pool.
 *   2. HARD: every round has exactly m matches.
 *   3. Appearance balance: the spread (max - min games per player) is as small as possible.
 *   4. Optional: skill balance (minimise |sum(teamA) - sum(teamB)| per match).
 *   5. Soft: vary who sits out together (and avoid sitting out twice in a row), avoid repeating
 *      teammate pairs.
 *
 * Method: depth-first search over rounds with backtracking.
 *   - For a target appearance window [lo, hi] each node prunes on: players who can no longer reach
 *     lo, players already at hi, must-play players (a_i + remaining == lo), and slot-count bounds.
 *   - The players who play each round are chosen by a cost: sitting out in consecutive rounds is
 *     penalised, and so is sitting out alongside someone you already sat out with. Ties are broken
 *     by a hash that changes every round, so the same group does not keep sitting out together.
 *     (When there are too many combinations to rank, the old fewest-appearances-first order is used.)
 *   - Team splits use only unused trios, ordered by skill difference (when enabled) and repeated
 *     pairs; ties use a seeded hash so results are deterministic for a given seed.
 *   - Windows are tried from the tightest achievable spread upward. If a window is searched
 *     exhaustively without a solution, that spread is *proven* impossible.
 *   - Searches are bounded by node and time limits. A search that hits a limit reports "unknown"
 *     rather than claiming infeasibility.
 *   - After a solution is found, a local pass re-splits each round's six players to improve skill
 *     balance without touching appearances or reusing trios. This is a heuristic: the result is a
 *     best-found, not a proven optimum, and is labelled as such.
 * The result is always re-checked by the independent validator (validate.ts) before being used.
 */

export interface SchedulePlayer {
  id: string;
  skill: number;
}

export interface ScheduleRequest {
  players: SchedulePlayer[];
  rounds: number;
  matchesPerRound?: number;
  skillBalanced: boolean;
  seed: number;
  timeLimitMs?: number;
  nodeLimit?: number;
}

export interface ScheduledMatch {
  round: number;
  index: number;
  teamA: string[];
  teamB: string[];
  skillA: number;
  skillB: number;
}

export interface ScheduledRound {
  round: number;
  matches: ScheduledMatch[];
  sitOut: string[];
}

export interface ScheduleResult {
  /** Seed that produced this schedule (the same seed and players always give the same schedule). */
  seed?: number;
  status: 'ok' | 'infeasible' | 'unknown';
  rounds: ScheduledRound[];
  appearances: Record<string, number>;
  balance: {
    min: number;
    max: number;
    spread: number;
    idealSpread: number;
    totalSlots: number;
    /** True when spread equals the arithmetic ideal (0 or 1). */
    ideal: boolean;
    /** True when every tighter spread was proven impossible by exhaustive search. */
    provenBest: boolean;
  };
  skill: { enabled: boolean; totalDiff: number; maxDiff: number; label: 'best_found' };
  /** How often the same players sat out together, and back-to-back sit-outs. */
  sitOuts?: { repeatedPairs: number; backToBack: number };
  infeasibility?: {
    reasons: string[];
    upperBoundRounds: number;
    maxFeasibleFound: number | null;
    maxFeasibleProven: boolean;
    alternatives: string[];
  };
  stats: { nodes: number; ms: number; exhaustive: boolean; windowsTried: string[] };
}

const C3 = (n: number) => (n * (n - 1) * (n - 2)) / 6;

/** Upper bound on rounds from trio counting alone: each match consumes 2 distinct trios. */
export function trioUpperBound(n: number, m = 1): number {
  return Math.floor(C3(n) / (2 * m));
}

interface Ctx {
  n: number;
  m: number;
  R: number;
  skill: number[];
  balanced: boolean;
  seed: number;
  used: Uint8Array; // trio index -> used
  pairCount: Uint16Array; // n*n
  app: number[];
  lastPlayed: number[];
  rounds: { matches: [number[], number[]][] }[];
  /** n*n: how many rounds each pair of players has sat out together. */
  sitPair: Uint16Array;
  /** Per-round tie keys (seed + round), built lazily. */
  roundKeys: number[][];
  ids: string[];
  /** Rank line-ups by sit-out variety (false = plain rotation order, faster on tight instances). */
  variety: boolean;
  nodes: number;
  nodeLimit: number;
  deadline: number;
  aborted: boolean;
  lo: number;
  hi: number;
  key: number[]; // seeded tie keys
}

const trioIdx = (n: number, a: number, b: number, c: number) => {
  // sort three numbers
  if (a > b) [a, b] = [b, a];
  if (b > c) [b, c] = [c, b];
  if (a > b) [a, b] = [b, a];
  return (a * n + b) * n + c;
};

function* combinations(arr: number[], k: number, start = 0, acc: number[] = []): Generator<number[]> {
  if (acc.length === k) {
    yield acc.slice();
    return;
  }
  for (let i = start; i <= arr.length - (k - acc.length); i++) {
    acc.push(arr[i]);
    yield* combinations(arr, k, i + 1, acc);
    acc.pop();
  }
}

/** All ways to split 6 players into two trios (10 splits), ordered by cost, unused trios only. */
function splitsOf(ctx: Ctx, six: number[]): [number[], number[]][] {
  const out: { a: number[]; b: number[]; cost: number; tk: number }[] = [];
  const first = six[0];
  const rest = six.slice(1);
  for (let i = 0; i < rest.length; i++)
    for (let j = i + 1; j < rest.length; j++) {
      const a = [first, rest[i], rest[j]];
      const b = rest.filter((_, x) => x !== i && x !== j);
      const ta = trioIdx(ctx.n, a[0], a[1], a[2]);
      const tb = trioIdx(ctx.n, b[0], b[1], b[2]);
      if (ctx.used[ta] || ctx.used[tb]) continue;
      const sa = a.reduce((s, x) => s + ctx.skill[x], 0);
      const sb = b.reduce((s, x) => s + ctx.skill[x], 0);
      const pairs =
        ctx.pairCount[a[0] * ctx.n + a[1]] + ctx.pairCount[a[0] * ctx.n + a[2]] + ctx.pairCount[a[1] * ctx.n + a[2]] +
        ctx.pairCount[b[0] * ctx.n + b[1]] + ctx.pairCount[b[0] * ctx.n + b[2]] + ctx.pairCount[b[1] * ctx.n + b[2]];
      const diff = Math.abs(sa - sb);
      const cost = ctx.balanced ? diff * 1000 + pairs : pairs;
      const tk = (ctx.key[a[1]] ^ ctx.key[a[2]] ^ (ctx.key[b[0]] >>> 3)) >>> 0;
      out.push({ a, b, cost, tk });
    }
  out.sort((x, y) => x.cost - y.cost || x.tk - y.tk);
  return out.map((o) => [o.a, o.b]);
}

/** Enumerate partitions of 6m participants into m matches. */
function* partitions(ctx: Ctx, players: number[]): Generator<[number[], number[]][]> {
  if (players.length === 0) {
    yield [];
    return;
  }
  if (players.length === 6) {
    for (const s of splitsOf(ctx, players)) yield [s];
    return;
  }
  const first = players[0];
  const rest = players.slice(1);
  for (const five of combinations(rest, 5)) {
    const six = [first, ...five];
    const remaining = rest.filter((p) => !five.includes(p));
    // Matches in one round have disjoint players, so their trios can never coincide.
    for (const s of splitsOf(ctx, six)) for (const tail of partitions(ctx, remaining)) yield [s, ...tail];
  }
}

function mark(ctx: Ctx, match: [number[], number[]], delta: 1 | -1) {
  for (const t of match) {
    ctx.used[trioIdx(ctx.n, t[0], t[1], t[2])] = delta === 1 ? 1 : 0;
    for (const [x, y] of [[t[0], t[1]], [t[0], t[2]], [t[1], t[2]]]) {
      ctx.pairCount[x * ctx.n + y] += delta;
      ctx.pairCount[y * ctx.n + x] += delta;
    }
  }
}

function dfs(ctx: Ctx, r: number): boolean {
  if (ctx.aborted) return false;
  if (++ctx.nodes > ctx.nodeLimit || (ctx.nodes % 512 === 0 && Date.now() > ctx.deadline)) {
    ctx.aborted = true;
    return false;
  }
  const { n, m, R, lo, hi } = ctx;
  if (r === R) return ctx.app.every((a) => a >= lo && a <= hi);
  const remaining = R - r;
  const slots = 6 * m;
  let need = 0;
  let cap = 0;
  const must: number[] = [];
  const eligible: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ctx.app[i];
    if (a + remaining < lo) return false;
    need += Math.max(0, lo - a);
    cap += Math.min(hi - a, remaining);
    if (a + remaining === lo) must.push(i);
    else if (a < hi) eligible.push(i);
  }
  if (need > remaining * slots || cap < remaining * slots) return false;
  if (must.length > slots) return false;
  const free = slots - must.length;
  if (eligible.length < free) return false;
  const rk = roundKey(ctx, r);
  for (const pick of pickOrder(ctx, r, must, eligible, free)) {
    const participants = [...must, ...pick].sort((x, y) => ctx.app[x] - ctx.app[y] || rk[x] - rk[y]);
    const playing = new Set(participants);
    const sitting: number[] = [];
    for (let i = 0; i < n; i++) if (!playing.has(i)) sitting.push(i);
    for (const part of partitions(ctx, participants)) {
      // apply
      const prevLast = participants.map((p) => ctx.lastPlayed[p]);
      for (const mt of part) mark(ctx, mt, 1);
      markSitting(ctx, sitting, 1);
      for (const p of participants) {
        ctx.app[p]++;
        ctx.lastPlayed[p] = r;
      }
      ctx.rounds.push({ matches: part });
      if (dfs(ctx, r + 1)) return true;
      ctx.rounds.pop();
      participants.forEach((p, i) => {
        ctx.app[p]--;
        ctx.lastPlayed[p] = prevLast[i];
      });
      markSitting(ctx, sitting, -1);
      for (const mt of part) mark(ctx, mt, -1);
      if (ctx.aborted) return false;
    }
    if (ctx.aborted) return false;
  }
  return false;
}

/** Tie keys for one round: a different shuffle of the players every round. */
function roundKey(ctx: Ctx, r: number): number[] {
  return (ctx.roundKeys[r] ??= ctx.ids.map((id) => tieKey(id, `${ctx.seed}:r${r}`)));
}

function markSitting(ctx: Ctx, sitting: number[], delta: 1 | -1) {
  for (let i = 0; i < sitting.length; i++)
    for (let j = i + 1; j < sitting.length; j++) {
      ctx.sitPair[sitting[i] * ctx.n + sitting[j]] += delta;
      ctx.sitPair[sitting[j] * ctx.n + sitting[i]] += delta;
    }
}

/** Above this many candidate line-ups per round, fall back to a lazy (unranked) enumeration. */
const RANKED_PICK_LIMIT = 4000;

const binom = (n: number, k: number) => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
};

/**
 * Which `free` players (besides the must-play ones) take the remaining slots this round, best first.
 * Cost, lowest first:
 *   - 1000 per player who would sit out a third round in a row,
 *   - 4 per player who would sit out two rounds in a row,
 *   - 1 for every earlier round each pair of sitters already sat out together,
 *   - 1 per appearance the picked players already have (keeps the rotation fair).
 * Ties are broken by a per-round seeded hash, so there is no fixed sit-out group.
 */
function* pickOrder(ctx: Ctx, r: number, must: number[], eligible: number[], free: number): Generator<number[]> {
  const rk = roundKey(ctx, r);
  if (!ctx.variety || binom(eligible.length, free) > RANKED_PICK_LIMIT) {
    eligible.sort((x, y) => ctx.app[x] - ctx.app[y] || ctx.lastPlayed[x] - ctx.lastPlayed[y] || rk[x] - rk[y]);
    yield* combinations(eligible, free);
    return;
  }
  const n = ctx.n;
  const mustSet = new Set(must);
  const ranked: { pick: number[]; cost: number; tk: number }[] = [];
  const isPicked = new Uint8Array(n);
  for (const pick of combinations(eligible, free)) {
    for (const p of pick) isPicked[p] = 1;
    let cost = 0;
    let tk = 0;
    const sitting: number[] = [];
    for (let i = 0; i < n; i++) {
      if (isPicked[i] || mustSet.has(i)) continue;
      sitting.push(i);
      const idle = r - 1 - ctx.lastPlayed[i]; // rounds already sat out in a row
      if (r > 0 && idle >= 1) cost += idle >= 2 ? 1000 : 4;
    }
    for (let i = 0; i < sitting.length; i++) for (let j = i + 1; j < sitting.length; j++) cost += ctx.sitPair[sitting[i] * n + sitting[j]];
    for (const p of pick) {
      cost += ctx.app[p];
      tk = (tk + rk[p]) >>> 0;
      isPicked[p] = 0;
    }
    ranked.push({ pick, cost, tk });
  }
  ranked.sort((a, b) => a.cost - b.cost || a.tk - b.tk);
  for (const x of ranked) yield x.pick;
}

function windowsFor(T: number, n: number, R: number): { lo: number; hi: number; spread: number }[] {
  const out: { lo: number; hi: number; spread: number }[] = [];
  const ideal = T % n === 0 ? 0 : 1;
  for (let s = ideal; s <= R; s++) {
    const wins: { lo: number; hi: number; spread: number }[] = [];
    for (let lo = Math.max(0, Math.ceil(T / n) - s); lo <= Math.floor(T / n); lo++) {
      const hi = lo + s;
      if (hi > R) continue;
      if (lo * n <= T && hi * n >= T) wins.push({ lo, hi, spread: s });
    }
    // Prefer windows centred on the mean.
    wins.sort((a, b) => Math.abs((a.lo + a.hi) / 2 - T / n) - Math.abs((b.lo + b.hi) / 2 - T / n));
    out.push(...wins);
  }
  return out;
}

function runSearch(req: Required<Omit<ScheduleRequest, 'players'>> & { players: SchedulePlayer[] }, deadline: number, variety = false) {
  const n = req.players.length;
  const m = req.matchesPerRound;
  const R = req.rounds;
  const T = 6 * m * R;
  const windows = windowsFor(T, n, R);
  let totalNodes = 0;
  let allTighterProven = true;
  const tried: string[] = [];
  for (const w of windows) {
    const ctx: Ctx = {
      n, m, R,
      skill: req.players.map((p) => p.skill),
      balanced: req.skillBalanced,
      seed: req.seed,
      used: new Uint8Array(n * n * n),
      pairCount: new Uint16Array(n * n),
      app: new Array(n).fill(0),
      lastPlayed: new Array(n).fill(-1),
      rounds: [],
      sitPair: new Uint16Array(n * n),
      roundKeys: [],
      ids: req.players.map((p) => p.id),
      variety,
      nodes: 0,
      nodeLimit: req.nodeLimit,
      deadline,
      aborted: false,
      lo: w.lo,
      hi: w.hi,
      key: req.players.map((p) => tieKey(p.id, req.seed)),
    };
    const ok = dfs(ctx, 0);
    totalNodes += ctx.nodes;
    tried.push(`[${w.lo},${w.hi}]${ok ? ' found' : ctx.aborted ? ' budget exhausted' : ' proven impossible'}`);
    if (ok) return { ok: true as const, ctx, window: w, nodes: totalNodes, provenBest: allTighterProven, tried };
    if (ctx.aborted) {
      allTighterProven = false;
      // Do not keep burning the budget on looser windows if time is gone.
      if (Date.now() > deadline) return { ok: false as const, aborted: true, nodes: totalNodes, tried, exhaustive: false };
    }
  }
  return { ok: false as const, aborted: !allTighterProven, nodes: totalNodes, tried, exhaustive: allTighterProven };
}

/** Improve skill balance by re-splitting each round's players, keeping trios unique. */
function improveSkill(ctx: Ctx) {
  if (!ctx.balanced) return;
  for (let pass = 0; pass < 5; pass++) {
    let improved = false;
    for (const round of ctx.rounds) {
      round.matches = round.matches.map((mt) => {
        const six = [...mt[0], ...mt[1]].sort((a, b) => a - b);
        const diff = (s: [number[], number[]]) =>
          Math.abs(s[0].reduce((x, p) => x + ctx.skill[p], 0) - s[1].reduce((x, p) => x + ctx.skill[p], 0));
        const before = diff(mt);
        mark(ctx, mt, -1);
        const options = splitsOf(ctx, six); // ordered by diff, unused trios only
        const best = options[0];
        if (best && diff(best) < before - 1e-9) {
          mark(ctx, best, 1);
          improved = true;
          return best;
        }
        mark(ctx, mt, 1);
        return mt;
      });
    }
    if (!improved) break;
  }
}

function buildResult(players: SchedulePlayer[], ctx: Ctx, T: number, idealSpread: number, provenBest: boolean, nodes: number, ms: number, exhaustive: boolean, tried: string[], balanced: boolean): ScheduleResult {
  const ids = players.map((p) => p.id);
  const rounds: ScheduledRound[] = ctx.rounds.map((rd, ri) => {
    const playing = new Set<number>();
    const matches = rd.matches.map((mt, mi) => {
      mt.flat().forEach((p) => playing.add(p));
      const sa = mt[0].reduce((s, p) => s + ctx.skill[p], 0);
      const sb = mt[1].reduce((s, p) => s + ctx.skill[p], 0);
      return { round: ri + 1, index: mi, teamA: mt[0].map((p) => ids[p]), teamB: mt[1].map((p) => ids[p]), skillA: sa, skillB: sb };
    });
    return { round: ri + 1, matches, sitOut: ids.filter((_, i) => !playing.has(i)) };
  });
  const appearances: Record<string, number> = {};
  ids.forEach((id, i) => (appearances[id] = ctx.app[i]));
  const vals = Object.values(appearances);
  const diffs = rounds.flatMap((r) => r.matches.map((m) => Math.abs(m.skillA - m.skillB)));
  return {
    seed: ctx.seed,
    status: 'ok',
    rounds,
    appearances,
    balance: {
      min: Math.min(...vals), max: Math.max(...vals), spread: Math.max(...vals) - Math.min(...vals),
      idealSpread, totalSlots: T, ideal: Math.max(...vals) - Math.min(...vals) === idealSpread, provenBest,
    },
    skill: { enabled: balanced, totalDiff: diffs.reduce((s, d) => s + d, 0), maxDiff: diffs.length ? Math.max(...diffs) : 0, label: 'best_found' },
    sitOuts: sitOutStats(rounds),
    stats: { nodes, ms, exhaustive, windowsTried: tried },
  };
}

/** Repeated sit-out pairs (each pair counted once per extra round together) and back-to-back sit-outs. */
export function sitOutStats(rounds: { sitOut?: string[] }[]): { repeatedPairs: number; backToBack: number } {
  const seen = new Map<string, number>();
  let repeatedPairs = 0;
  let backToBack = 0;
  rounds.forEach((rd, i) => {
    const s = (rd.sitOut ?? []).slice().sort();
    for (let a = 0; a < s.length; a++)
      for (let b = a + 1; b < s.length; b++) {
        const k = `${s[a]}|${s[b]}`;
        const c = seen.get(k) ?? 0;
        if (c) repeatedPairs++;
        seen.set(k, c + 1);
      }
    if (i > 0) backToBack += s.filter((x) => rounds[i - 1].sitOut?.includes(x)).length;
  });
  return { repeatedPairs, backToBack };
}

export function scheduleGroupStage(input: ScheduleRequest): ScheduleResult {
  const started = Date.now();
  const m = input.matchesPerRound ?? 1;
  const req = {
    players: input.players,
    rounds: input.rounds,
    matchesPerRound: m,
    skillBalanced: input.skillBalanced,
    seed: input.seed,
    timeLimitMs: input.timeLimitMs ?? 4000,
    nodeLimit: input.nodeLimit ?? 3_000_000,
  };
  const n = req.players.length;
  const R = req.rounds;
  if (new Set(req.players.map((p) => p.id)).size !== n) throw invalid('duplicate_player', 'A player is listed twice in the pool.');
  if (!Number.isInteger(R) || R < 1) throw invalid('bad_rounds', 'Rounds must be a positive whole number.');
  if (n < 6 * m)
    throw invalid('pool_too_small', `A pool with ${m} match(es) per round needs at least ${6 * m} players; this pool has ${n}.`);
  const T = 6 * m * R;
  const idealSpread = T % n === 0 ? 0 : 1;
  const ub = trioUpperBound(n, m);
  const emptyResult = (status: 'infeasible' | 'unknown', reasons: string[], maxFound: number | null, maxProven: boolean, nodes: number, tried: string[], exhaustive: boolean): ScheduleResult => {
    const alternatives: string[] = [];
    if (maxFound != null && maxFound >= 1) alternatives.push(`Schedule ${maxFound} round(s) instead.`);
    alternatives.push('Use more players per pool (fewer pools), which creates more unique trios.');
    if (m > 1) alternatives.push('Use fewer matches per round.');
    return {
      status,
      rounds: [],
      appearances: {},
      balance: { min: 0, max: 0, spread: 0, idealSpread, totalSlots: T, ideal: false, provenBest: false },
      skill: { enabled: req.skillBalanced, totalDiff: 0, maxDiff: 0, label: 'best_found' },
      infeasibility: { reasons, upperBoundRounds: ub, maxFeasibleFound: maxFound, maxFeasibleProven: maxProven, alternatives },
      stats: { nodes, ms: Date.now() - started, exhaustive, windowsTried: tried },
    };
  };

  if (R > ub) {
    const maxFound = findMaxRounds(req, Math.min(ub, R - 1), started + req.timeLimitMs);
    return emptyResult(
      'infeasible',
      [
        `A pool of ${n} players has only ${C3(n)} distinct trios. Each match uses 2 of them, so at most ${ub} round(s) can be played ` +
          `with ${m} match(es) per round without repeating a trio; ${R} were requested.`,
      ],
      maxFound.rounds,
      maxFound.proven,
      maxFound.nodes,
      [],
      true,
    );
  }

  const deadline = started + req.timeLimitMs;
  // First look for a schedule that also varies who sits out together, using half the budget. Tight
  // instances (near the trio bound) can be slow to solve that way, so if the budget runs out the
  // plain rotation order gets the rest. Both searches enforce the same hard rules.
  let res = runSearch({ ...req, nodeLimit: Math.floor(req.nodeLimit / 2) }, started + req.timeLimitMs / 2, true);
  if (!res.ok && res.aborted) {
    const plain = runSearch(req, deadline);
    res = { ...plain, nodes: plain.nodes + res.nodes };
  }
  if (res.ok) {
    improveSkill(res.ctx);
    return buildResult(req.players, res.ctx, T, idealSpread, res.provenBest, res.nodes, Date.now() - started, true, res.tried, req.skillBalanced);
  }
  const extraDeadline = Date.now() + Math.max(500, req.timeLimitMs / 2);
  const maxFound = findMaxRounds(req, R - 1, extraDeadline);
  if (res.aborted) {
    return emptyResult(
      'unknown',
      [
        `The search budget (${req.timeLimitMs} ms) ran out before a schedule for ${R} round(s) was found or ruled out. ` +
          `The trio upper bound is ${ub} round(s), so it may still be possible.`,
      ],
      maxFound.rounds,
      false,
      res.nodes + maxFound.nodes,
      res.tried,
      false,
    );
  }
  return emptyResult(
    'infeasible',
    [`An exhaustive search proved that ${R} round(s) cannot be scheduled for ${n} players without repeating a trio.`],
    maxFound.rounds,
    maxFound.proven,
    res.nodes + maxFound.nodes,
    res.tried,
    true,
  );
}

/** Find the largest feasible round count <= start by searching downward. */
function findMaxRounds(req: Required<Omit<ScheduleRequest, 'players'>> & { players: SchedulePlayer[] }, start: number, deadline: number): { rounds: number | null; proven: boolean; nodes: number } {
  let nodes = 0;
  let proven = true; // every larger count was proven impossible
  for (let r = start; r >= 1; r--) {
    if (Date.now() > deadline) return { rounds: null, proven: false, nodes };
    const res = runSearch({ ...req, rounds: r }, deadline);
    nodes += res.nodes;
    if (res.ok) return { rounds: r, proven, nodes };
    if (res.aborted) proven = false;
  }
  return { rounds: null, proven, nodes };
}
