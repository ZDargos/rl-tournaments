import { describe, expect, it } from 'vitest';
import { makePools, scheduleGroupStage, sitOutStats, validatePools, validateSchedule } from '@rl/core';

const players = (n: number, skill = (i: number) => 100 - i) => Array.from({ length: n }, (_, i) => ({ id: `p${String(i + 1).padStart(2, '0')}`, skill: skill(i) }));
const sitKey = (r: { rounds: { sitOut: string[] }[] }) => r.rounds.map((x) => x.sitOut.join('/')).join(' ');

describe('6mans schedule variety', () => {
  it('different seeds give different schedules; each one still never repeats a trio', () => {
    const ps = players(9);
    const seen = new Set<string>();
    for (const seed of [11, 22, 33, 44, 55]) {
      const r = scheduleGroupStage({ players: ps, rounds: 6, skillBalanced: true, seed });
      expect(r.status).toBe('ok');
      expect(r.seed).toBe(seed);
      const v = validateSchedule(r, ps.map((p) => p.id), { rounds: 6 });
      expect(v.errors).toEqual([]);
      expect(v.repeatedTrios).toEqual([]);
      seen.add(JSON.stringify(r.rounds.map((x) => x.matches)));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('does not keep sitting out the same group (8 players, 8 rounds: no pair sits out together twice)', () => {
    for (const seed of [1, 2, 3]) {
      const r = scheduleGroupStage({ players: players(8), rounds: 8, skillBalanced: true, seed });
      expect(r.status).toBe('ok');
      expect(r.sitOuts).toEqual({ repeatedPairs: 0, backToBack: 0 });
    }
  });

  it('breaks up fixed sit-out halves (12 players, 8 rounds)', () => {
    const r = scheduleGroupStage({ players: players(12), rounds: 8, skillBalanced: true, seed: 1 });
    expect(r.status).toBe('ok');
    // The old rotation alternated the same two halves of six (90 repeated pairs); 54 is the floor.
    expect(r.sitOuts!.repeatedPairs).toBeLessThan(75);
    expect(new Set(r.rounds.map((x) => x.sitOut.join('/'))).size).toBe(8);
    expect(validateSchedule(r, players(12).map((p) => p.id), { rounds: 8 }).valid).toBe(true);
  });

  it('first-round sit-outs are not tied to player order', () => {
    const firsts = new Set([1, 2, 3, 4, 5, 6].map((seed) => scheduleGroupStage({ players: players(9), rounds: 3, skillBalanced: false, seed }).rounds[0].sitOut.join('/')));
    expect(firsts.size).toBeGreaterThan(2);
  });

  it('sitOutStats counts repeated pairs and back-to-back sit-outs', () => {
    expect(sitOutStats([{ sitOut: ['a', 'b'] }, { sitOut: ['b', 'a'] }, { sitOut: ['c', 'd'] }])).toEqual({ repeatedPairs: 1, backToBack: 2 });
  });

  it('is still deterministic for one seed', () => {
    const a = scheduleGroupStage({ players: players(10), rounds: 5, skillBalanced: true, seed: 5 });
    const b = scheduleGroupStage({ players: players(10), rounds: 5, skillBalanced: true, seed: 5 });
    expect(sitKey(a)).toBe(sitKey(b));
  });
});

describe('6mans pool variety', () => {
  // Four tiers of four identical skills: any pool split that takes two of each tier is equally balanced.
  const tiers = Array.from({ length: 16 }, (_, i) => ({ id: `p${String(i + 1).padStart(2, '0')}`, skill: 40 - Math.floor(i / 4) * 4, imputed: false }));

  it('remaking with a new seed trades players of the same skill between pools', () => {
    const results = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => makePools(tiers, 2, seed));
    const distinct = new Set(results.map((r) => JSON.stringify(r.pools.map((p) => p.slice().sort()).sort())));
    expect(distinct.size).toBeGreaterThan(2);
    for (const r of results) {
      expect(r.averageSpread).toBe(0);
      expect(validatePools(r.pools, tiers.map((p) => p.id))).toEqual([]);
    }
  });

  it('close (not equal) players can trade places within the tolerance, keeping pools balanced', () => {
    const ps = Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, skill: 60 - i, imputed: false })); // all different
    const strict = new Set([1, 2, 3, 4, 5, 6].map((seed) => JSON.stringify(makePools(ps, 2, seed, { tolerance: 0 }).pools.map((p) => p.slice().sort()).sort())));
    const loose = [1, 2, 3, 4, 5, 6].map((seed) => makePools(ps, 2, seed, { tolerance: 2 }));
    const looseSet = new Set(loose.map((r) => JSON.stringify(r.pools.map((p) => p.slice().sort()).sort())));
    expect(looseSet.size).toBeGreaterThan(strict.size);
    const best = makePools(ps, 2, 1, { tolerance: 0 }).averageSpread;
    for (const r of loose) expect(r.averageSpread).toBeLessThanOrEqual(best + 2 / 6 + 1e-9);
  });

  it('never swaps players further apart than the tolerance', () => {
    const ps = [...Array.from({ length: 6 }, (_, i) => ({ id: `hi${i}`, skill: 100, imputed: false })), ...Array.from({ length: 6 }, (_, i) => ({ id: `lo${i}`, skill: 10, imputed: false }))];
    for (const seed of [1, 2, 3, 4]) {
      const r = makePools(ps, 2, seed, { tolerance: 5 });
      for (const pool of r.pools) expect(pool.filter((x) => x.startsWith('hi')).length).toBe(3);
    }
  });
});
