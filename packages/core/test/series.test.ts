import { describe, expect, it } from 'vitest';
import { parseGamesText, validateSeries, winsNeeded, describeSeries } from '@rl/core';

const req = { requireGameScores: false };

describe('series validation', () => {
  it('computes wins needed', () => {
    expect([1, 3, 5, 7].map(winsNeeded)).toEqual([1, 2, 3, 4]);
  });
  it('accepts a valid best-of-5 with game scores', () => {
    const r = validateSeries(5, { games: [{ a: 3, b: 1 }, { a: 0, b: 2 }, { a: 4, b: 3 }, { a: 2, b: 1 }] }, req);
    expect(r).toMatchObject({ winsA: 3, winsB: 1, winner: 'a', goalsA: 9, goalsB: 7 });
  });
  it('rejects ties, extra games after the clinch, and unfinished series', () => {
    expect(() => validateSeries(3, { games: [{ a: 1, b: 1 }] }, req)).toThrow(/tie/);
    expect(() => validateSeries(3, { games: [{ a: 1, b: 0 }, { a: 1, b: 0 }, { a: 0, b: 1 }] }, req)).toThrow(/already decided/);
    expect(() => validateSeries(5, { games: [{ a: 1, b: 0 }, { a: 1, b: 0 }] }, req)).toThrow(/not finished/);
    expect(() => validateSeries(1, { games: [{ a: 1, b: 0 }, { a: 0, b: 1 }] }, req)).toThrow(/at most 1/);
  });
  it('accepts series-only scores unless game scores are required', () => {
    expect(validateSeries(7, { winsA: 2, winsB: 4 }, req).winner).toBe('b');
    expect(() => validateSeries(7, { winsA: 3, winsB: 3 }, req)).toThrow(/exactly 4/);
    expect(() => validateSeries(3, { winsA: 2, winsB: 0 }, { requireGameScores: true })).toThrow(/goals/);
  });
  it('rejects mismatched series and game scores', () => {
    expect(() => validateSeries(3, { games: [{ a: 1, b: 0 }, { a: 1, b: 0 }], winsA: 2, winsB: 1 }, req)).toThrow(/does not match/);
  });
  it('parses text scores', () => {
    expect(parseGamesText('3-1, 2-4 1-0')).toEqual([{ a: 3, b: 1 }, { a: 2, b: 4 }, { a: 1, b: 0 }]);
    expect(() => parseGamesText('three to one')).toThrow();
    expect(describeSeries({ winsA: 2, winsB: 1, games: [{ a: 3, b: 1 }, { a: 2, b: 4 }, { a: 1, b: 0 }] })).toContain('2-1');
  });
});
