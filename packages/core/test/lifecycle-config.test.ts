import { describe, expect, it } from 'vitest';
import {
  applyConfigPatch, availableActions, canTransition, defaultConfig, defaultQualifiersPerPool, diffConfig, lockedPaths, nextState, normalizeConfig,
  parseConfig, parseRank, patchFromPath, defaultRankValue, RANKS, validateConfig, bestOfFor,
} from '@rl/core';

describe('lifecycle', () => {
  it('follows the documented happy path', () => {
    let s = nextState('draft', 'publish');
    s = nextState(s, 'open_registration');
    s = nextState(s, 'close_registration');
    s = nextState(s, 'start');
    expect(s).toBe('in_progress');
    expect(nextState(s, 'pause')).toBe('paused');
    expect(nextState('paused', 'resume')).toBe('in_progress');
  });
  it('rejects illegal transitions', () => {
    expect(canTransition('completed', 'start')).toBe(false);
    expect(canTransition('cancelled', 'publish')).toBe(false);
    expect(() => nextState('draft', 'resume')).toThrow();
    expect(availableActions('completed')).toEqual([]);
  });
});

describe('config', () => {
  it('has sensible defaults', () => {
    const c = defaultConfig();
    expect(c.doubleElim.grandFinalReset).toBe(false);
    expect(c.sixmans.scoring.win).toBe(3);
    expect(c.notifications.categories.match_assigned).toEqual({ channel: false, dm: true });
  });
  it('sixmans tiebreakers are points then goal difference then goals for then seed', () => {
    expect(defaultConfig().sixmans.tiebreakers).toEqual(['points', 'goal_diff', 'goals_for', 'seed']);
  });
  it('normalizes 6mans to 3-player individual registration', () => {
    const c = normalizeConfig(parseConfig({ format: 'sixmans', teamSize: 2, registrationMode: 'team' }));
    expect(c.teamSize).toBe(3);
    expect(c.registrationMode).toBe('individual');
  });
  it('default qualifiers: 2 pools -> 3, 3+ pools -> 2', () => {
    expect(defaultQualifiersPerPool(2)).toBe(3);
    expect(defaultQualifiersPerPool(3)).toBe(2);
    expect(defaultQualifiersPerPool(5)).toBe(2);
  });
  it('diffs configs and identifies locked paths', () => {
    const a = defaultConfig();
    const b = applyConfigPatch(a, { format: 'swiss', notifications: { dms: false } });
    const d = diffConfig(a, b);
    expect(d.map((x) => x.path)).toEqual(expect.arrayContaining(['format', 'notifications.dms']));
    expect(lockedPaths(d)).toContain('format');
    expect(lockedPaths(d)).not.toContain('notifications.dms');
  });
  it('builds patches from dotted paths with typed values', () => {
    expect(patchFromPath('series.bestOf', '5')).toEqual({ series: { bestOf: 5 } });
    expect(patchFromPath('checkIn.enabled', 'true')).toEqual({ checkIn: { enabled: true } });
    expect(() => applyConfigPatch(defaultConfig(), patchFromPath('series.bestOf', '4'))).toThrow();
  });
  it('flags invalid combinations', () => {
    expect(() => parseConfig({ registration: { capacity: 1 } })).toThrow();
    expect(validateConfig(parseConfig({ format: 'sixmans', registration: { capacity: 4 } })).join(' ')).toMatch(/at least 6/);
    expect(validateConfig(parseConfig({ schedule: { autoStart: true } })).join(' ')).toMatch(/start time/);
    expect(validateConfig(parseConfig({ schedule: { timezone: 'Mars/Olympus' } })).join(' ')).toMatch(/timezone/i);
  });
  it('picks best-of per round when configured', () => {
    const c = parseConfig({ series: { bestOf: 3, perRound: { 'finals': 7 } } });
    expect(typeof bestOfFor(c, 'winners', 1)).toBe('number');
  });
});

describe('ranks', () => {
  it('parses common spellings', () => {
    expect(parseRank('Champion 2')).toBe('champion_2');
    expect(parseRank('gc1')).toBe('grand_champion_1');
    expect(parseRank('SSL')).toBe('supersonic_legend');
    expect(parseRank('nonsense')).toBeNull();
  });
  it('rank values are strictly increasing', () => {
    const vals = RANKS.map((r) => defaultRankValue(r.id));
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
    expect(defaultRankValue('diamond_1', 4)).toBeLessThan(defaultRankValue('diamond_2', 1));
  });
});
