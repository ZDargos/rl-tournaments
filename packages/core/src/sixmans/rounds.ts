import { trioUpperBound } from './scheduler.js';
import { MIN_POOL_SIZE } from './pools.js';

/**
 * How many rounds each 6mans pool plays so that every player plays the same number of games.
 *
 * A round of a pool with n players and m matches uses 6m player slots, so after R rounds the pool has
 * 6mR slots. Everyone plays the same amount exactly when n divides 6mR, i.e. games per player
 * g = 6mR / n is a whole number. For one pool the fewest such games is 6m / gcd(n, 6m); for several
 * pools (sizes differ by one when the player count does not split evenly) every pool must give the
 * same g, so g is a multiple of the least common multiple of those values. Each pool then plays
 * R = g * n / 6m rounds: a bigger pool plays more rounds than a smaller one.
 *
 * Examples (one match per round): 8 players -> 4 rounds, 3 games each. 9 -> 3 rounds, 2 games.
 * 17 players in two pools (9 + 8) -> 9 and 8 rounds, 6 games each.
 */

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;

/** Same rule as makePools: sizes differ by at most one, larger pools first. */
export function poolSizesFor(players: number, poolCount: number): number[] {
  const base = Math.floor(players / poolCount);
  const extra = players % poolCount;
  return Array.from({ length: poolCount }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Fewest games per player that every pool can give exactly. */
export function minEqualGames(poolSizes: number[], matchesPerRound = 1): number {
  const slots = 6 * matchesPerRound;
  return poolSizes.reduce((acc, n) => lcm(acc, slots / gcd(n, slots)), 1);
}

export interface RoundsOption {
  /** Games every player plays in the group stage. */
  games: number;
  /** Rounds for each pool, in pool order. */
  rounds: number[];
  /** False when a pool would need more rounds than its players allow without repeating a trio (or than MAX_ROUNDS). */
  feasible: boolean;
}

export interface RoundsPlan {
  poolSizes: number[];
  matchesPerRound: number;
  /** Fewest equal games per player. */
  minGames: number;
  /** Equal-games choices, fewest games first (multiples of minGames). */
  options: RoundsOption[];
  /** The choice used: the requested games (default DEFAULT_TARGET_GAMES) rounded up to a valid amount. */
  chosen: RoundsOption | null;
  /** Plain-language notes the organizer should see (rounding, long group stages, idle players). */
  notes: string[];
  problems: string[];
}

/** With no games-per-player setting, aim for at least this many games each (fewer makes standings a coin flip). */
export const DEFAULT_TARGET_GAMES = 3;

/** Upper limit on rounds in one pool (matches the sixmans.roundsPerPool limit). */
export const MAX_ROUNDS = 60;

export function roundsForGames(poolSizes: number[], games: number, matchesPerRound = 1): RoundsOption {
  const slots = 6 * matchesPerRound;
  const rounds = poolSizes.map((n) => (games * n) / slots);
  const feasible = rounds.every((r, i) => Number.isInteger(r) && r >= 1 && r <= MAX_ROUNDS && r <= trioUpperBound(poolSizes[i], matchesPerRound));
  return { games, rounds, feasible };
}

/**
 * Plan rounds per pool for equal games. `games` is the organizer's wish (null = at least
 * DEFAULT_TARGET_GAMES); it is rounded *up* to the next amount every pool can give exactly, and the
 * plan says so when the organizer asked for a specific number.
 */
export function planEqualRounds(input: { poolSizes: number[]; matchesPerRound?: number; games?: number | null; optionCount?: number }): RoundsPlan {
  const m = input.matchesPerRound ?? 1;
  const sizes = input.poolSizes;
  const notes: string[] = [];
  const problems: string[] = [];
  if (!sizes.length) problems.push('There are no pools.');
  const small = sizes.filter((n) => n < MIN_POOL_SIZE * m);
  if (small.length) problems.push(`Every pool needs at least ${MIN_POOL_SIZE * m} players for ${m} match(es) per round; the smallest has ${Math.min(...sizes)}.`);
  if (problems.length) return { poolSizes: sizes, matchesPerRound: m, minGames: 0, options: [], chosen: null, notes, problems };

  const minGames = minEqualGames(sizes, m);
  const options: RoundsOption[] = [];
  for (let k = 1; options.length < (input.optionCount ?? 4); k++) {
    const o = roundsForGames(sizes, minGames * k, m);
    if (!o.feasible) break;
    options.push(o);
  }
  if (!options.length) {
    const need = roundsForGames(sizes, minGames, m);
    problems.push(
      `Equal games need ${need.rounds.join(' / ')} rounds, which is more than a pool can play` +
        (need.rounds.some((r) => r > MAX_ROUNDS) ? ` (limit ${MAX_ROUNDS})` : ' without repeating a trio') +
        '. Use more pools, or a fixed number of rounds.',
    );
    return { poolSizes: sizes, matchesPerRound: m, minGames, options, chosen: null, notes, problems };
  }

  const asked = input.games ?? null;
  const want = asked ?? DEFAULT_TARGET_GAMES;
  const up = Math.max(minGames, Math.ceil(want / minGames) * minGames);
  let chosen = options.find((x) => x.games === up) ?? roundsForGames(sizes, up, m);
  if (!chosen.feasible) {
    // The wish needs more rounds than possible: take the most games that still fit.
    let best = options[options.length - 1];
    for (let g = best.games + minGames; g < up; g += minGames) {
      const o = roundsForGames(sizes, g, m);
      if (o.feasible) best = o;
    }
    chosen = best;
    if (asked != null) notes.push(`${asked} game(s) each would need more rounds than a pool can play; using ${chosen.games} instead.`);
  } else if (asked != null && up !== asked) {
    notes.push(`${asked} game(s) each cannot be split evenly with pools of ${describeSizes(sizes)}, so it was rounded up to ${up}.`);
  }
  if (!options.some((o) => o.games === chosen.games)) options.push(chosen);
  options.sort((a, b) => a.games - b.games);
  if (new Set(chosen.rounds).size > 1)
    notes.push(`Pools are different sizes, so the bigger pool plays more rounds (${chosen.rounds.join(' / ')}) and finishes later; everyone still plays ${chosen.games} games.`);
  const biggest = Math.max(...sizes);
  const idle = biggest - 6 * m;
  if (idle >= 6) notes.push(`In a pool of ${biggest}, ${idle} players sit out each round. More pools${m === 1 && biggest >= 12 ? ' or 2 matches per round' : ''} would cut the waiting.`);
  if (Math.max(...chosen.rounds) >= 12) notes.push(`${Math.max(...chosen.rounds)} rounds is a long group stage. More pools or more matches per round make it shorter.`);
  return { poolSizes: sizes, matchesPerRound: m, minGames, options, chosen, notes, problems };
}

function describeSizes(sizes: number[]) {
  const uniq = [...new Set(sizes)];
  return uniq.length === 1 ? `${uniq[0]}` : uniq.join(' and ');
}
