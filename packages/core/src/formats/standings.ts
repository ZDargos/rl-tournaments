import type { StandardTiebreaker } from '../config.js';

/** A completed (or walkover/forfeit) match between two entrants, from the standings' point of view. */
export interface ResultRecord {
  a: string;
  b: string;
  winner: 'a' | 'b';
  winsA: number;
  winsB: number;
  goalsA: number;
  goalsB: number;
  forfeit?: boolean;
}

export interface StandingRow {
  entrantId: string;
  played: number;
  wins: number;
  losses: number;
  byes: number;
  points: number;
  gameWins: number;
  gameLosses: number;
  gameDiff: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  buchholz: number;
  seed: number;
  rank: number;
  opponents: string[];
}

export interface StandingsOptions {
  pointsWin: number;
  pointsLoss: number;
  pointsBye: number;
  tiebreakers: StandardTiebreaker[];
}

/**
 * Deterministic standings for Swiss and round robin. Ties are broken in the configured order; the
 * final fallback is always seed then entrant id so the order is total and reproducible.
 */
export function computeStandings(
  entrants: { id: string; seed: number }[],
  results: ResultRecord[],
  byes: Map<string, number>,
  opts: StandingsOptions,
): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  for (const e of entrants) {
    const b = byes.get(e.id) ?? 0;
    rows.set(e.id, {
      entrantId: e.id, played: 0, wins: 0, losses: 0, byes: b, points: b * opts.pointsBye,
      gameWins: 0, gameLosses: 0, gameDiff: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0, buchholz: 0,
      seed: e.seed, rank: 0, opponents: [],
    });
  }
  for (const r of results) {
    const A = rows.get(r.a);
    const B = rows.get(r.b);
    if (!A || !B) continue;
    A.played++;
    B.played++;
    A.opponents.push(r.b);
    B.opponents.push(r.a);
    const [W, L] = r.winner === 'a' ? [A, B] : [B, A];
    W.wins++;
    L.losses++;
    W.points += opts.pointsWin;
    L.points += opts.pointsLoss;
    A.gameWins += r.winsA;
    A.gameLosses += r.winsB;
    B.gameWins += r.winsB;
    B.gameLosses += r.winsA;
    A.goalsFor += r.goalsA;
    A.goalsAgainst += r.goalsB;
    B.goalsFor += r.goalsB;
    B.goalsAgainst += r.goalsA;
  }
  for (const row of rows.values()) {
    row.gameDiff = row.gameWins - row.gameLosses;
    row.goalDiff = row.goalsFor - row.goalsAgainst;
  }
  for (const row of rows.values()) row.buchholz = row.opponents.reduce((s, o) => s + (rows.get(o)?.points ?? 0), 0);

  const h2hPoints = (group: StandingRow[]): Map<string, number> => {
    const ids = new Set(group.map((g) => g.entrantId));
    const pts = new Map<string, number>(group.map((g) => [g.entrantId, 0]));
    for (const r of results) {
      if (!ids.has(r.a) || !ids.has(r.b)) continue;
      const w = r.winner === 'a' ? r.a : r.b;
      pts.set(w, (pts.get(w) ?? 0) + 1);
    }
    return pts;
  };

  const metric = (tb: StandardTiebreaker, row: StandingRow, ctx: Map<string, number> | null): number => {
    switch (tb) {
      case 'points': return row.points;
      case 'wins': return row.wins;
      case 'buchholz': return row.buchholz;
      case 'game_diff': return row.gameDiff;
      case 'goal_diff': return row.goalDiff;
      case 'goals_for': return row.goalsFor;
      case 'head_to_head': return ctx?.get(row.entrantId) ?? 0;
      case 'seed': return -row.seed;
    }
  };

  const sortGroup = (group: StandingRow[], tbs: StandardTiebreaker[]): StandingRow[] => {
    if (group.length <= 1) return group;
    if (tbs.length === 0) return group.slice().sort((x, y) => x.seed - y.seed || (x.entrantId < y.entrantId ? -1 : 1));
    const [tb, ...rest] = tbs;
    const ctx = tb === 'head_to_head' ? h2hPoints(group) : null;
    const buckets = new Map<number, StandingRow[]>();
    for (const r of group) {
      const v = metric(tb, r, ctx);
      if (!buckets.has(v)) buckets.set(v, []);
      buckets.get(v)!.push(r);
    }
    return [...buckets.entries()].sort((x, y) => y[0] - x[0]).flatMap(([, g]) => sortGroup(g, rest));
  };

  const sorted = sortGroup([...rows.values()], opts.tiebreakers);
  sorted.forEach((r, i) => (r.rank = i + 1));
  return sorted;
}
