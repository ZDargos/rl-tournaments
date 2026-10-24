import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  canonicalTrio, computeSixmansStandings, computeSkills, defaultConfig, finalsOptions, formFinalsTeams, makePools, qualify, scheduleGroupStage, swapInRound,
  trioUpperBound, validateFinalsTeams, validatePools, validateSchedule, buildFinalsBracket, resolveBracket,
} from '@rl/core';

const players = (n: number, skill = (i: number) => 100 - i) => Array.from({ length: n }, (_, i) => ({ id: `p${String(i + 1).padStart(2, '0')}`, skill: skill(i) }));
const cfg = defaultConfig({ format: 'sixmans' });

describe('6mans scheduler', () => {
  it('8 players, 4 rounds: valid, no repeated trio, everyone plays exactly 3 times', () => {
    const ps = players(8);
    const r = scheduleGroupStage({ players: ps, rounds: 4, skillBalanced: true, seed: 1 });
    expect(r.status).toBe('ok');
    const v = validateSchedule(r, ps.map((p) => p.id), { rounds: 4 });
    expect(v.errors).toEqual([]);
    expect(v.repeatedTrios).toEqual([]);
    expect(Object.values(v.appearances)).toEqual(Array(8).fill(3));
    expect(r.balance.spread).toBe(0);
    expect(r.balance.ideal).toBe(true);
  });

  it('is deterministic for the same seed and input', () => {
    const ps = players(9);
    const a = scheduleGroupStage({ players: ps, rounds: 5, skillBalanced: true, seed: 99 });
    const b = scheduleGroupStage({ players: ps, rounds: 5, skillBalanced: true, seed: 99 });
    expect(JSON.stringify(a.rounds)).toBe(JSON.stringify(b.rounds));
  });

  it('detects infeasibility from the trio bound and offers alternatives (6 players, 11 rounds)', () => {
    expect(trioUpperBound(6)).toBe(10);
    const r = scheduleGroupStage({ players: players(6), rounds: 11, skillBalanced: false, seed: 1 });
    expect(r.status).toBe('infeasible');
    expect(r.infeasibility!.reasons.join(' ')).toMatch(/trio/i);
    expect(r.infeasibility!.alternatives.length).toBeGreaterThan(0);
    expect(r.rounds).toEqual([]);
  });

  it('6 players can play every one of the 10 possible splits exactly once', () => {
    const ps = players(6);
    const r = scheduleGroupStage({ players: ps, rounds: 10, skillBalanced: false, seed: 3 });
    expect(r.status).toBe('ok');
    expect(validateSchedule(r, ps.map((p) => p.id)).valid).toBe(true);
  });

  it('7 players reach the 17-round trio bound', () => {
    const ps = players(7);
    const r = scheduleGroupStage({ players: ps, rounds: 17, skillBalanced: false, seed: 5, timeLimitMs: 10000 });
    expect(r.status).toBe('ok');
    expect(validateSchedule(r, ps.map((p) => p.id)).valid).toBe(true);
  });

  it('skill balancing reduces team skill differences', () => {
    const ps = players(10, (i) => (i < 3 ? 1000 : 10 * i));
    const on = scheduleGroupStage({ players: ps, rounds: 6, skillBalanced: true, seed: 2 });
    const off = scheduleGroupStage({ players: ps, rounds: 6, skillBalanced: false, seed: 2 });
    expect(on.status).toBe('ok');
    expect(on.skill.totalDiff).toBeLessThanOrEqual(off.skill.totalDiff);
  });

  it('two matches per round when the pool is big enough', () => {
    const ps = players(12);
    const r = scheduleGroupStage({ players: ps, rounds: 4, matchesPerRound: 2, skillBalanced: true, seed: 4 });
    expect(r.status).toBe('ok');
    expect(validateSchedule(r, ps.map((p) => p.id), { matchesPerRound: 2 }).valid).toBe(true);
  });

  it('every schedule it returns passes the independent validator (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 6, max: 13 }), fc.integer({ min: 1, max: 9 }), fc.integer({ min: 0, max: 10_000 }), fc.boolean(), (n, rounds, seed, bal) => {
        const ps = players(n, (i) => (i * 37 + seed) % 50);
        const r = scheduleGroupStage({ players: ps, rounds, skillBalanced: bal, seed, timeLimitMs: 1500 });
        if (r.status === 'ok') {
          const v = validateSchedule(r, ps.map((p) => p.id), { rounds });
          expect(v.errors).toEqual([]);
          // Appearances never differ by more than one when that is arithmetically possible.
          if (r.balance.ideal) expect(v.spread).toBeLessThanOrEqual(1);
        } else {
          expect(r.rounds).toEqual([]);
        }
      }),
      { seed: 2026, numRuns: 80 },
    );
  });
});

describe('6mans validator', () => {
  const ids = players(8).map((p) => p.id);
  it('treats trios as unordered across sides, rounds and match numbers', () => {
    const sched = {
      rounds: [
        { round: 1, matches: [{ teamA: ['p01', 'p02', 'p03'], teamB: ['p04', 'p05', 'p06'] }] },
        { round: 2, matches: [{ teamA: ['p07', 'p08', 'p01'], teamB: ['p03', 'p01', 'p02'].reverse().map((x) => (x === 'p01' ? 'p01' : x)) }] },
      ],
    };
    // Round 2 team B is {p02,p01,p03} = repeat of round 1 team A (and also p01 twice in round 2).
    const v = validateSchedule(sched, ids);
    expect(v.valid).toBe(false);
    expect(v.repeatedTrios).toContain(canonicalTrio(['p01', 'p02', 'p03']));
  });
  it('rejects a swap that would create a repeated trio', () => {
    const sched = {
      rounds: [
        { round: 1, matches: [{ teamA: ['p01', 'p02', 'p03'], teamB: ['p04', 'p05', 'p06'] }], sitOut: ['p07', 'p08'] },
        { round: 2, matches: [{ teamA: ['p01', 'p02', 'p07'], teamB: ['p04', 'p05', 'p08'] }], sitOut: ['p03', 'p06'] },
      ],
    };
    const swapped = swapInRound(sched, 2, 'p07', 'p03', ids);
    expect(validateSchedule(swapped, ids).repeatedTrios.length).toBeGreaterThan(0);
  });
});

describe('6mans pools', () => {
  it('sizes differ by at most one and averages are close; deterministic', () => {
    const ps = computeSkills(players(21).map((p, i) => ({ id: p.id, seed: i + 1 })), defaultConfig({ format: 'sixmans', sixmans: { skillMethod: 'manual_seed' } }));
    const a = makePools(ps, 3, 7);
    const b = makePools(ps, 3, 7);
    expect(a.pools).toEqual(b.pools);
    expect(a.sizes.sort()).toEqual([7, 7, 7]);
    expect(a.averageSpread).toBeLessThan(2);
    expect(validatePools(a.pools, ps.map((p) => p.id))).toEqual([]);
  });
  it('refuses pools smaller than six', () => {
    expect(() => makePools(players(11).map((p) => ({ ...p, imputed: false })), 2, 1)).toThrow(/6/);
  });
  it('rank skill input with missing ranks uses the lowest policy', () => {
    const s = computeSkills([{ id: 'a', rank: 'champion_1' }, { id: 'b', rank: 'diamond_2' }, { id: 'c' }], cfg);
    const by = Object.fromEntries(s.map((x) => [x.id, x]));
    expect(by.a.skill).toBeGreaterThan(by.b.skill);
    expect(by.c.skill).toBeLessThan(by.b.skill);
    expect(by.c.imputed).toBe(true);
  });
  it('validatePools catches duplicates and missing players', () => {
    expect(validatePools([['a', 'b'], ['b']], ['a', 'b', 'c']).length).toBeGreaterThan(0);
  });
});

describe('6mans standings', () => {
  it('3 points per win, then goal difference, goals for, seed', () => {
    const ps = players(6);
    const rows = computeSixmansStandings(ps, [
      { matchId: '1', teamA: ['p01', 'p02', 'p03'], teamB: ['p04', 'p05', 'p06'], winner: 'a', goalsA: 3, goalsB: 1 },
      { matchId: '2', teamA: ['p01', 'p04', 'p05'], teamB: ['p02', 'p03', 'p06'], winner: 'b', goalsA: 0, goalsB: 4 },
    ], cfg);
    const by = Object.fromEntries(rows.map((r) => [r.playerId, r]));
    expect(by.p02.points).toBe(6);
    expect(by.p03.points).toBe(6);
    expect(by.p01.points).toBe(3);
    expect(by.p02.goalDiff).toBe(6);
    // p02 and p03 tie on points, GD and GF; seed/skill decides (p02 is higher skill).
    expect(rows[0].playerId).toBe('p02');
    expect(rows[1].playerId).toBe('p03');
    expect(by.p06.points).toBe(3);
    expect(by.p06.goalDiff).toBe(2); // lost 1-3 (−2), won 4-0 (+4)
  });
  it('void abandoned matches by default; loss for both when configured', () => {
    const ps = players(6);
    const ab = { matchId: '1', teamA: ['p01', 'p02', 'p03'], teamB: ['p04', 'p05', 'p06'], winner: null, goalsA: 0, goalsB: 0, abandoned: true };
    expect(computeSixmansStandings(ps, [ab], cfg).every((r) => r.played === 0)).toBe(true);
    const lfb = defaultConfig({ format: 'sixmans', sixmans: { abandoned: 'loss_for_both' } });
    expect(computeSixmansStandings(ps, [ab], lfb).every((r) => r.losses === 1)).toBe(true);
  });
});

describe('6mans finals', () => {
  const standingsFor = (pool: number, n: number) =>
    computeSixmansStandings(players(n).map((p) => ({ ...p, id: `${pool}-${p.id}` })), [], cfg).map((r) => ({ ...r }));
  it('2 pools x top 3 = 6 players -> 2 balanced teams', () => {
    const { qualified, others } = qualify([standingsFor(0, 8), standingsFor(1, 8)], 3);
    expect(qualified.length).toBe(6);
    const opts = finalsOptions(qualified, others);
    expect(opts[0].id).toBe('as_qualified');
    const teams = formFinalsTeams(qualified.map((q, i) => ({ id: q.playerId, skill: q.skill, order: i })), 'balanced', 1);
    expect(teams.length).toBe(2);
    expect(validateFinalsTeams(teams, qualified.map((q) => q.playerId))).toEqual([]);
  });
  it('uneven qualifiers (8) offer expand-to-9 and reduce-to-6 options', () => {
    const { qualified, others } = qualify([0, 1, 2, 3].map((p) => standingsFor(p, 6)), 2);
    expect(qualified.length).toBe(8);
    const ids = finalsOptions(qualified, others).map((o) => o.id);
    expect(ids).toContain('expand');
    expect(ids).toContain('reduce');
    const expand = finalsOptions(qualified, others).find((o) => o.id === 'expand')!;
    expect(expand.players.length).toBe(9);
    expect(expand.byes).toBe(1);
  });
  it('balanced formation does not stack the strongest players', () => {
    const ps = Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, skill: 90 - i * 10, order: i }));
    const teams = formFinalsTeams(ps, 'balanced', 1);
    const totals = teams.map((t) => t.skill);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(10);
    expect(teams.every((t) => !(t.players.includes('x0') && t.players.includes('x1')))).toBe(true);
  });
  it('finals bracket with 3 teams gives the top seed a bye', () => {
    const b = buildFinalsBracket(['team1', 'team2', 'team3']);
    resolveBracket(b);
    expect(b.filter((m) => m.walkover).length).toBe(1);
  });
});
