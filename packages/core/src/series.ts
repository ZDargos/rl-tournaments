import { invalid } from './errors.js';
import type { BestOf } from './config.js';

export interface GameScore {
  /** Goals scored by side A. */
  a: number;
  /** Goals scored by side B. */
  b: number;
}

export interface SeriesResult {
  winsA: number;
  winsB: number;
  winner: 'a' | 'b';
  goalsA: number;
  goalsB: number;
  games: GameScore[];
}

export const winsNeeded = (bestOf: BestOf | number) => Math.floor(bestOf / 2) + 1;

/**
 * Validate a completed series. Rocket League games cannot end in a tie (overtime), so every game
 * must have a winner. The series must stop as soon as one side reaches the required wins.
 */
export function validateSeries(
  bestOf: BestOf | number,
  input: { games?: GameScore[] | null; winsA?: number | null; winsB?: number | null },
  opts: { requireGameScores: boolean },
): SeriesResult {
  const need = winsNeeded(bestOf);
  const games = input.games ?? null;
  if (games && games.length > 0) {
    if (games.length > bestOf) throw invalid('too_many_games', `A best-of-${bestOf} has at most ${bestOf} games.`);
    let wa = 0;
    let wb = 0;
    let ga = 0;
    let gb = 0;
    games.forEach((g, i) => {
      if (!Number.isInteger(g.a) || !Number.isInteger(g.b) || g.a < 0 || g.b < 0 || g.a > 99 || g.b > 99)
        throw invalid('bad_goals', `Game ${i + 1}: goals must be whole numbers between 0 and 99.`);
      if (g.a === g.b) throw invalid('tied_game', `Game ${i + 1}: Rocket League games cannot end in a tie.`);
      if (wa >= need || wb >= need)
        throw invalid('games_after_clinch', `Game ${i + 1} was played after the series was already decided.`);
      if (g.a > g.b) wa++;
      else wb++;
      ga += g.a;
      gb += g.b;
    });
    if (wa < need && wb < need)
      throw invalid('series_incomplete', `Series is not finished: ${wa}-${wb}, first to ${need} wins a best-of-${bestOf}.`);
    if (input.winsA != null && input.winsB != null && (input.winsA !== wa || input.winsB !== wb))
      throw invalid('series_mismatch', 'Series score does not match the game scores.');
    return { winsA: wa, winsB: wb, winner: wa > wb ? 'a' : 'b', goalsA: ga, goalsB: gb, games };
  }
  if (opts.requireGameScores) throw invalid('game_scores_required', 'Please report the goals for every game.');
  const wa = input.winsA;
  const wb = input.winsB;
  if (wa == null || wb == null || !Number.isInteger(wa) || !Number.isInteger(wb) || wa < 0 || wb < 0)
    throw invalid('bad_series', 'Series score must be two whole numbers.');
  const winnerWins = Math.max(wa, wb);
  const loserWins = Math.min(wa, wb);
  if (winnerWins !== need || loserWins >= need)
    throw invalid('impossible_series', `In a best-of-${bestOf} the winner must have exactly ${need} wins (got ${wa}-${wb}).`);
  return { winsA: wa, winsB: wb, winner: wa > wb ? 'a' : 'b', goalsA: 0, goalsB: 0, games: [] };
}

/** Parse "3-1, 2-4, 1-0" or "3-1 2-4" into games. */
export function parseGamesText(text: string): GameScore[] {
  const parts = text.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw invalid('bad_scores', 'Enter scores like "3-1, 2-4, 1-0".');
  return parts.map((p) => {
    const m = p.match(/^(\d{1,2})[-:](\d{1,2})$/);
    if (!m) throw invalid('bad_scores', `Could not read "${p}". Use goals like 3-1.`);
    return { a: Number(m[1]), b: Number(m[2]) };
  });
}

export function sameResult(x: SeriesResult, y: SeriesResult): boolean {
  if (x.winsA !== y.winsA || x.winsB !== y.winsB) return false;
  if (x.games.length !== y.games.length) return false;
  return x.games.every((g, i) => g.a === y.games[i].a && g.b === y.games[i].b);
}

/** Flip a result reported from side B's perspective (not used by default: reports are always A/B). */
export function describeSeries(r: Pick<SeriesResult, 'winsA' | 'winsB' | 'games'>): string {
  const g = r.games.length ? ` (${r.games.map((x) => `${x.a}-${x.b}`).join(', ')})` : '';
  return `${r.winsA}-${r.winsB}${g}`;
}
