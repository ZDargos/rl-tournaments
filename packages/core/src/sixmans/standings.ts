import type { SixmansTiebreaker, TournamentConfig } from '../config.js';

export interface SixmansMatchResult {
  matchId: string;
  teamA: string[];
  teamB: string[];
  winner: 'a' | 'b' | null;
  goalsA: number;
  goalsB: number;
  forfeit?: boolean;
  /** Abandoned match (only passed in when the abandoned policy is loss_for_both). */
  abandoned?: boolean;
}

export interface PlayerStanding {
  playerId: string;
  played: number;
  wins: number;
  losses: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  skill: number;
  rank: number;
  scheduled: number;
  qualified: boolean;
}

/**
 * Individual 6mans standings. Every player on the winning team earns `scoring.win` points, every
 * player on the losing team `scoring.loss`. Team goals count towards each player's goals for/against.
 * Forfeits use the forfeit point values and `forfeitGoalDiff`. Disputed/unconfirmed matches are not
 * passed in, so they never count until resolved. Abandoned (cancelled) matches are not counted.
 * Ties are broken in the configured order with a final fallback of skill (higher first) then id.
 */
export function computeSixmansStandings(
  players: { id: string; skill: number }[],
  results: SixmansMatchResult[],
  cfg: Pick<TournamentConfig, 'sixmans'>,
  scheduledCounts: Record<string, number> = {},
): PlayerStanding[] {
  const s = cfg.sixmans.scoring;
  const rows = new Map<string, PlayerStanding>(
    players.map((p) => [p.id, {
      playerId: p.id, played: 0, wins: 0, losses: 0, points: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0,
      skill: p.skill, rank: 0, scheduled: scheduledCounts[p.id] ?? 0, qualified: false,
    }]),
  );
  for (const r of results) {
    if (r.abandoned || !r.winner) {
      if (cfg.sixmans.abandoned !== 'loss_for_both') continue;
      for (const id of [...r.teamA, ...r.teamB]) {
        const row = rows.get(id);
        if (!row) continue;
        row.played++;
        row.losses++;
        row.points += s.loss;
      }
      continue;
    }
    const winners = r.winner === 'a' ? r.teamA : r.teamB;
    const losers = r.winner === 'a' ? r.teamB : r.teamA;
    let wGoals = r.winner === 'a' ? r.goalsA : r.goalsB;
    let lGoals = r.winner === 'a' ? r.goalsB : r.goalsA;
    if (r.forfeit) {
      wGoals = s.forfeitGoalDiff;
      lGoals = 0;
    }
    for (const id of winners) {
      const row = rows.get(id);
      if (!row) continue;
      row.played++;
      row.wins++;
      row.points += r.forfeit ? s.forfeitWin : s.win;
      row.goalsFor += wGoals;
      row.goalsAgainst += lGoals;
    }
    for (const id of losers) {
      const row = rows.get(id);
      if (!row) continue;
      row.played++;
      row.losses++;
      row.points += r.forfeit ? s.forfeitLoss : s.loss;
      row.goalsFor += lGoals;
      row.goalsAgainst += wGoals;
    }
  }
  for (const r of rows.values()) r.goalDiff = r.goalsFor - r.goalsAgainst;
  const metric = (tb: SixmansTiebreaker, r: PlayerStanding) => {
    switch (tb) {
      case 'points': return r.points;
      case 'goal_diff': return r.goalDiff;
      case 'goals_for': return r.goalsFor;
      case 'wins': return r.wins;
      case 'fewest_games': return -r.played;
      case 'seed': return r.skill;
    }
  };
  const tbs = cfg.sixmans.tiebreakers;
  const sorted = [...rows.values()].sort((x, y) => {
    for (const tb of tbs) {
      const d = metric(tb, y) - metric(tb, x);
      if (d !== 0) return d;
    }
    return y.skill - x.skill || (x.playerId < y.playerId ? -1 : x.playerId > y.playerId ? 1 : 0);
  });
  sorted.forEach((r, i) => (r.rank = i + 1));
  return sorted;
}
