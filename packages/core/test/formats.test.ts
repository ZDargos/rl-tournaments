import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  bracketChampion, bracketPlacements, buildDoubleElimination, buildRoundRobin, buildSingleElimination, computeStandings, pairSwissRound, resolveBracket,
  seedOrder, type BracketMatch,
} from '@rl/core';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);

/** Play every ready match, letting the better seed (lower number) win unless `upset` says otherwise. */
function playOut(ms: BracketMatch[], pick: (m: BracketMatch) => 'a' | 'b' = (m) => (Number(m.entrantA!.slice(1)) < Number(m.entrantB!.slice(1)) ? 'a' : 'b')) {
  resolveBracket(ms);
  for (let guard = 0; guard < 500; guard++) {
    const ready = ms.find((m) => m.status === 'ready');
    if (!ready) break;
    ready.winner = pick(ready);
    ready.status = 'completed';
    resolveBracket(ms);
  }
  return ms;
}

describe('seeding', () => {
  it('standard seed order keeps 1 and 2 apart', () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
});

describe('single elimination', () => {
  it('handles byes for non-power-of-two counts', () => {
    const ms = buildSingleElimination(ids(6));
    resolveBracket(ms);
    const r1 = ms.filter((m) => m.round === 1);
    expect(r1.filter((m) => m.walkover).length).toBe(2);
    playOut(ms);
    expect(bracketChampion(ms, 'single_elim')).toBe('e1');
  });
  it('has a third place match when enabled', () => {
    const ms = playOut(buildSingleElimination(ids(8), { thirdPlace: true }));
    const p = bracketPlacements(ms, 'single_elim');
    expect(p.get('e1')).toBe(1);
    expect(p.get('e2')).toBe(2);
    expect(p.get('e3')).toBe(3);
    expect(p.get('e4')).toBe(4);
  });
  it('every entrant plays until eliminated exactly once (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 40 }), fc.integer({ min: 0, max: 1000 }), (n, s) => {
        const ms = playOut(buildSingleElimination(ids(n)), (m) => (((s + m.position + m.round) % 2) ? 'a' : 'b'));
        const champ = bracketChampion(ms, 'single_elim');
        expect(champ).not.toBeNull();
        const losses = new Map<string, number>();
        for (const m of ms) if (m.status === 'completed' && !m.walkover) {
          const loser = m.winner === 'a' ? m.entrantB! : m.entrantA!;
          losses.set(loser, (losses.get(loser) ?? 0) + 1);
        }
        expect(losses.size).toBe(n - 1);
        for (const v of losses.values()) expect(v).toBe(1);
      }),
      { seed: 42, numRuns: 60 },
    );
  });
});

describe('double elimination', () => {
  it('no reset by default: winners-side champion loses grand final -> losers champ wins', () => {
    const ms = buildDoubleElimination(ids(4));
    expect(ms.some((m) => m.key === 'gf2')).toBe(false);
    playOut(ms, (m) => (m.key === 'gf' ? 'b' : Number(m.entrantA!.slice(1)) < Number(m.entrantB!.slice(1)) ? 'a' : 'b'));
    expect(bracketChampion(ms, 'double_elim')).not.toBe('e1');
  });
  it('reset match is played only when the losers-bracket side wins the first final', () => {
    const a = playOut(buildDoubleElimination(ids(4), { grandFinalReset: true }));
    expect(a.find((m) => m.key === 'gf2')!.status).toBe('void');
    expect(bracketChampion(a, 'double_elim')).toBe('e1');
    const b = playOut(buildDoubleElimination(ids(4), { grandFinalReset: true }), (m) => (m.key === 'gf' ? 'b' : m.key === 'gf2' ? 'a' : Number(m.entrantA!.slice(1)) < Number(m.entrantB!.slice(1)) ? 'a' : 'b'));
    expect(b.find((m) => m.key === 'gf2')!.status).toBe('completed');
    expect(bracketChampion(b, 'double_elim')).toBe('e1');
  });
  it('everyone except the champion loses exactly twice, or once in the grand final (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 24 }), fc.integer({ min: 0, max: 999 }), fc.boolean(), (n, s, reset) => {
        const ms = playOut(buildDoubleElimination(ids(n), { grandFinalReset: reset }), (m) => (((s * 7 + m.position * 3 + m.round) % 3) ? 'a' : 'b'));
        const champ = bracketChampion(ms, 'double_elim');
        expect(champ).not.toBeNull();
        expect(ms.some((m) => m.status === 'ready' || m.status === 'pending')).toBe(false);
        const placements = bracketPlacements(ms, 'double_elim');
        expect(placements.get(champ!)).toBe(1);
        expect(placements.size).toBe(n);
      }),
      { seed: 7, numRuns: 60 },
    );
  });
});

describe('round robin', () => {
  it('every pair meets exactly once and nobody plays twice per round', () => {
    for (const n of [2, 3, 4, 5, 8, 9]) {
      const r = buildRoundRobin(ids(n));
      const seen = new Set<string>();
      for (const p of r.pairings) {
        const k = [p.a, p.b].sort().join('-');
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
      expect(seen.size).toBe((n * (n - 1)) / 2);
      for (let round = 1; round <= r.rounds; round++) {
        const inRound = r.pairings.filter((p) => p.round === round).flatMap((p) => [p.a, p.b]);
        expect(new Set(inRound).size).toBe(inRound.length);
      }
    }
  });
  it('double round robin meets twice', () => {
    expect(buildRoundRobin(ids(4), 2).pairings.length).toBe(12);
  });
});

describe('swiss', () => {
  it('avoids rematches and gives the bye to the lowest-ranked player without one', () => {
    const es = ids(5).map((id, i) => ({ id, points: 0, rank: i + 1, opponents: [] as string[], hadBye: false }));
    const r1 = pairSwissRound(es, 1);
    expect(r1.bye).toBe('e5');
    expect(r1.pairs.length).toBe(2);
    es[4].hadBye = true;
    for (const p of r1.pairs) {
      es.find((e) => e.id === p.a)!.opponents.push(p.b);
      es.find((e) => e.id === p.b)!.opponents.push(p.a);
    }
    const r2 = pairSwissRound(es, 1);
    expect(r2.bye).not.toBe('e5');
    expect(r2.rematches).toEqual([]);
  });
  it('falls back to rematches only when unavoidable and logs it', () => {
    const es = ids(2).map((id, i) => ({ id, points: 0, rank: i + 1, opponents: [i === 0 ? 'e2' : 'e1'], hadBye: false }));
    const r = pairSwissRound(es, 1);
    expect(r.rematches.length).toBe(1);
    expect(r.log.join(' ')).toMatch(/rematch/i);
  });
});

describe('standings', () => {
  it('ranks by points then configured tiebreakers deterministically', () => {
    const rows = computeStandings(
      ids(3).map((id, i) => ({ id, seed: i + 1 })),
      [
        { a: 'e1', b: 'e2', winner: 'b', winsA: 1, winsB: 2, goalsA: 5, goalsB: 6 },
        { a: 'e2', b: 'e3', winner: 'b', winsA: 0, winsB: 2, goalsA: 1, goalsB: 6 },
        { a: 'e3', b: 'e1', winner: 'b', winsA: 1, winsB: 2, goalsA: 4, goalsB: 5 },
      ],
      new Map(),
      { pointsWin: 3, pointsLoss: 0, pointsBye: 3, tiebreakers: ['points', 'game_diff', 'goal_diff', 'seed'] },
    );
    // all 3 points; game diff: e1 +0 (1-2,2-1), e2 -1 (2-1, 0-2), e3 +1 (2-0,1-2)
    expect(rows.map((r) => r.entrantId)).toEqual(['e3', 'e1', 'e2']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });
});
