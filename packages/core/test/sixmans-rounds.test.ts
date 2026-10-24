import { describe, expect, it } from 'vitest';
import { MAX_ROUNDS, minEqualGames, planEqualRounds, poolSizesFor, roundsForGames, scheduleGroupStage, trioUpperBound, validateSchedule } from '@rl/core';

const players = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${String(i).padStart(3, '0')}`, skill: 50 - i }));

describe('6mans rounds per pool (equal games)', () => {
  it('one pool: the classic counts', () => {
    // [players, rounds, games each] with one match per round and the default target of >= 3 games
    for (const [n, rounds, games] of [[6, 3, 3], [7, 7, 6], [8, 4, 3], [9, 6, 4], [10, 5, 3], [11, 11, 6], [12, 6, 3], [13, 13, 6], [16, 8, 3], [18, 9, 3]]) {
      const p = planEqualRounds({ poolSizes: [n] });
      expect(p.problems).toEqual([]);
      expect([p.chosen!.rounds[0], p.chosen!.games]).toEqual([rounds, games]);
    }
  });

  it('uneven pools: the bigger pool plays more rounds, everyone plays the same games', () => {
    const p = planEqualRounds({ poolSizes: poolSizesFor(17, 2) });
    expect(p.poolSizes).toEqual([9, 8]);
    expect(p.chosen).toMatchObject({ games: 6, rounds: [9, 8] });
    expect(p.notes.join(' ')).toMatch(/bigger pool plays more rounds/);
    expect(planEqualRounds({ poolSizes: poolSizesFor(13, 2) }).chosen).toMatchObject({ games: 6, rounds: [7, 6] });
    expect(planEqualRounds({ poolSizes: poolSizesFor(25, 3) }).chosen).toMatchObject({ games: 6, rounds: [9, 8, 8] });
  });

  it('games per player is rounded up to a valid amount, and the plan says so', () => {
    const p = planEqualRounds({ poolSizes: [8], games: 4 });
    expect(p.chosen!.games).toBe(6);
    expect(p.notes.join(' ')).toMatch(/rounded up to 6/);
    expect(planEqualRounds({ poolSizes: [8], games: 6 }).notes.join(' ')).not.toMatch(/rounded/);
    expect(planEqualRounds({ poolSizes: [9], games: 1 }).chosen!.games).toBe(2);
  });

  it('never plans more rounds than a pool can play without repeating a trio', () => {
    // 6 players: at most 10 rounds (10 games each).
    const p = planEqualRounds({ poolSizes: [6], games: 25 });
    expect(p.chosen!.rounds[0]).toBeLessThanOrEqual(trioUpperBound(6));
    expect(p.notes.join(' ')).toMatch(/using 10 instead/);
  });

  it('two matches per round', () => {
    expect(minEqualGames([12], 2)).toBe(1);
    expect(planEqualRounds({ poolSizes: [13], matchesPerRound: 2 }).chosen).toMatchObject({ games: 12, rounds: [13] });
    expect(planEqualRounds({ poolSizes: [11], matchesPerRound: 2 }).problems.join(' ')).toMatch(/at least 12/);
  });

  it('flags long group stages and many idle players', () => {
    const p = planEqualRounds({ poolSizes: [19] });
    expect(p.chosen!.rounds[0]).toBe(19);
    expect(p.notes.join(' ')).toMatch(/long group stage/);
    expect(p.notes.join(' ')).toMatch(/sit out each round/);
  });

  it('property: for every pool split up to 64 players, each pool has a schedule where everyone plays exactly the planned games', () => {
    for (let total = 6; total <= 64; total++) {
      for (let pools = 1; pools <= Math.floor(total / 6); pools++) {
        const sizes = poolSizesFor(total, pools);
        const p = planEqualRounds({ poolSizes: sizes });
        if (p.problems.length) {
          // Only a huge single pool (61 players needs 61 rounds) is refused, with a way out.
          expect(Math.max(...sizes)).toBeGreaterThan(MAX_ROUNDS);
          expect(p.problems.join(' ')).toMatch(/more pools/);
          continue;
        }
        const o = p.chosen!;
        sizes.forEach((n, i) => expect((6 * o.rounds[i]) % n).toBe(0));
        expect(roundsForGames(sizes, o.games).feasible).toBe(true);
      }
    }
  });

  it('the scheduler achieves exactly equal games for the planned rounds (sampled sizes)', () => {
    for (const n of [6, 7, 8, 9, 10, 11, 13, 14, 17]) {
      const rounds = planEqualRounds({ poolSizes: [n] }).chosen!.rounds[0];
      const r = scheduleGroupStage({ players: players(n), rounds, skillBalanced: true, seed: n });
      expect(r.status).toBe('ok');
      expect(r.balance.spread).toBe(0);
      expect(validateSchedule(r, players(n).map((p) => p.id), { rounds, maxSpread: 0 }).valid).toBe(true);
    }
  });
});
