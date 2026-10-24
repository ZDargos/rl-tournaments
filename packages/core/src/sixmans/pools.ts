import { invalid } from '../errors.js';
import { tieKey } from '../rng.js';
import type { SkilledPlayer } from './skill.js';

export interface PoolsResult {
  pools: string[][];
  sizes: number[];
  averages: number[];
  totals: number[];
  /** max(avg) - min(avg) across pools. */
  averageSpread: number;
  swapsApplied: number;
}

export const MIN_POOL_SIZE = 6;

/**
 * Distribute players into pools:
 *  1. Pool sizes differ by at most one (sizes are fixed first).
 *  2. Players are ordered by skill (ties broken by a seeded hash so results are reproducible) and
 *     snake-drafted into pools.
 *  3. A deterministic hill-climb swaps players between pools while it reduces the variance of
 *     pool average skill. Sizes never change during swaps.
 */
export function makePools(players: SkilledPlayer[], poolCount: number, seed: number): PoolsResult {
  const n = players.length;
  if (!Number.isInteger(poolCount) || poolCount < 1) throw invalid('bad_pool_count', 'Pool count must be at least 1.');
  if (n < MIN_POOL_SIZE * poolCount) {
    const max = Math.floor(n / MIN_POOL_SIZE);
    throw invalid(
      'not_enough_players',
      `${poolCount} pool(s) need at least ${MIN_POOL_SIZE * poolCount} players (6 per pool); ${n} registered. ` +
        (max >= 1 ? `With ${n} players you can have at most ${max} pool(s).` : 'You need at least 6 players.'),
      { maxPools: max },
    );
  }
  const base = Math.floor(n / poolCount);
  const extra = n % poolCount;
  const sizes = Array.from({ length: poolCount }, (_, i) => base + (i < extra ? 1 : 0));
  const ordered = players.slice().sort((a, b) => b.skill - a.skill || tieKey(a.id, seed) - tieKey(b.id, seed));
  const pools: SkilledPlayer[][] = sizes.map(() => []);
  let idx = 0;
  let dir = 1;
  let p = 0;
  while (idx < ordered.length) {
    if (pools[p].length < sizes[p]) pools[p].push(ordered[idx++]);
    // advance snake
    const nextP = p + dir;
    if (nextP < 0 || nextP >= poolCount) dir = -dir;
    else p = nextP;
    if (pools.every((pl, i) => pl.length >= sizes[i])) break;
  }
  const avg = (pl: SkilledPlayer[]) => pl.reduce((s, x) => s + x.skill, 0) / pl.length;
  const overall = ordered.reduce((s, x) => s + x.skill, 0) / n;
  const cost = () => pools.reduce((s, pl) => s + (avg(pl) - overall) ** 2, 0);
  let swaps = 0;
  let current = cost();
  for (let pass = 0; pass < 200; pass++) {
    let best: { i: number; a: number; j: number; b: number; c: number } | null = null;
    for (let i = 0; i < poolCount; i++)
      for (let j = i + 1; j < poolCount; j++)
        for (let a = 0; a < pools[i].length; a++)
          for (let b = 0; b < pools[j].length; b++) {
            if (pools[i][a].skill === pools[j][b].skill) continue;
            [pools[i][a], pools[j][b]] = [pools[j][b], pools[i][a]];
            const c = cost();
            [pools[i][a], pools[j][b]] = [pools[j][b], pools[i][a]];
            if (c < current - 1e-9 && (!best || c < best.c - 1e-12)) best = { i, a, j, b, c };
          }
    if (!best) break;
    [pools[best.i][best.a], pools[best.j][best.b]] = [pools[best.j][best.b], pools[best.i][best.a]];
    current = best.c;
    swaps++;
  }
  const out = pools.map((pl) => pl.slice().sort((a, b) => b.skill - a.skill || tieKey(a.id, seed) - tieKey(b.id, seed)));
  const averages = out.map(avg);
  return {
    pools: out.map((pl) => pl.map((x) => x.id)),
    sizes,
    averages,
    totals: out.map((pl) => pl.reduce((s, x) => s + x.skill, 0)),
    averageSpread: Math.max(...averages) - Math.min(...averages),
    swapsApplied: swaps,
  };
}

/** Validate an organizer-edited pool assignment. */
export function validatePools(pools: string[][], playerIds: string[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  pools.forEach((pl, i) => {
    if (pl.length < MIN_POOL_SIZE) problems.push(`Pool ${i + 1} has ${pl.length} players; each pool needs at least ${MIN_POOL_SIZE}.`);
    for (const id of pl) {
      if (seen.has(id)) problems.push(`Player ${id} is in pool ${seen.get(id)! + 1} and pool ${i + 1}.`);
      seen.set(id, i);
    }
  });
  const all = new Set(playerIds);
  for (const id of seen.keys()) if (!all.has(id)) problems.push(`Player ${id} is not a confirmed participant.`);
  for (const id of all) if (!seen.has(id)) problems.push(`Player ${id} is not assigned to any pool.`);
  const sizes = pools.map((p) => p.length);
  if (sizes.length && Math.max(...sizes) - Math.min(...sizes) > 1)
    problems.push(`Pool sizes ${sizes.join('/')} differ by more than one player.`);
  return problems;
}
