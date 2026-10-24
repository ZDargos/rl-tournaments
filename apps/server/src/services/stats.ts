import { FORMAT_LABELS, notFound } from '@rl/core';
import type { AppContext } from './context.js';
import { getAccess, loadTournament } from './access.js';
import { getUser, publicUser } from './users.js';

/**
 * Player profile and cross-tournament statistics. Team-format records (the player's competitor
 * won/lost) are kept separate from 6mans individual group-stage records. Only tournaments the
 * viewer is allowed to see are included; private profiles are visible to their owner only.
 */
export async function playerProfile(ctx: AppContext, userId: string, viewerId: string | null) {
  const u = getUser(ctx, userId);
  if (!u) throw notFound('Player');
  if (!u.profile_public && viewerId !== userId) throw notFound('Player');
  const tournamentIds = (
    ctx.db
      .prepare(
        `SELECT DISTINCT tournament_id FROM entry_members WHERE user_id = ?
         UNION SELECT DISTINCT c.tournament_id FROM competitor_members cm JOIN competitors c ON c.id = cm.competitor_id WHERE cm.user_id = ?`,
      )
      .all(userId, userId) as { tournament_id: number }[]
  ).map((r) => r.tournament_id);
  const history = [];
  const totals = {
    team: { matches: 0, wins: 0, losses: 0, gamesWon: 0, gamesLost: 0 },
    sixmans: { games: 0, wins: 0, losses: 0, points: 0, goalsFor: 0, goalsAgainst: 0 },
    tournaments: 0,
    titles: 0,
  };
  for (const tid of tournamentIds) {
    const t = loadTournament(ctx, tid);
    if (!(await getAccess(ctx, t, viewerId)).canView || t.state === 'draft') continue;
    const comps = ctx.db
      .prepare('SELECT c.id, c.stage, c.kind, c.name FROM competitor_members cm JOIN competitors c ON c.id = cm.competitor_id WHERE cm.user_id = ? AND c.tournament_id = ?')
      .all(userId, tid) as { id: number; stage: string; kind: string; name: string }[];
    const compIds = comps.map((c) => c.id);
    const matches = compIds.length
      ? (ctx.db
          .prepare(`SELECT * FROM matches WHERE tournament_id = ? AND status = 'completed' AND walkover = 0 AND (competitor_a IN (${compIds.map(() => '?').join(',')}) OR competitor_b IN (${compIds.map(() => '?').join(',')}))`)
          .all(tid, ...compIds, ...compIds) as { id: number; stage: string; competitor_a: number; competitor_b: number; winner: 'a' | 'b'; wins_a: number; wins_b: number; goals_a: number; goals_b: number; completed_at: string }[])
      : [];
    const rec = { team: { wins: 0, losses: 0 }, group: { wins: 0, losses: 0, points: 0, gf: 0, ga: 0 } };
    for (const m of matches) {
      const side = compIds.includes(m.competitor_a) ? 'a' : 'b';
      const won = m.winner === side;
      if (m.stage === 'group') {
        rec.group[won ? 'wins' : 'losses']++;
        rec.group.points += won ? t.cfg.sixmans.scoring.win : t.cfg.sixmans.scoring.loss;
        rec.group.gf += side === 'a' ? m.goals_a ?? 0 : m.goals_b ?? 0;
        rec.group.ga += side === 'a' ? m.goals_b ?? 0 : m.goals_a ?? 0;
      } else {
        rec.team[won ? 'wins' : 'losses']++;
        totals.team.gamesWon += side === 'a' ? m.wins_a ?? 0 : m.wins_b ?? 0;
        totals.team.gamesLost += side === 'a' ? m.wins_b ?? 0 : m.wins_a ?? 0;
      }
    }
    totals.team.matches += rec.team.wins + rec.team.losses;
    totals.team.wins += rec.team.wins;
    totals.team.losses += rec.team.losses;
    totals.sixmans.games += rec.group.wins + rec.group.losses;
    totals.sixmans.wins += rec.group.wins;
    totals.sixmans.losses += rec.group.losses;
    totals.sixmans.points += rec.group.points;
    totals.sixmans.goalsFor += rec.group.gf;
    totals.sixmans.goalsAgainst += rec.group.ga;
    const placement = compIds.length
      ? (ctx.db.prepare(`SELECT MIN(placement) p FROM placements WHERE tournament_id = ? AND competitor_id IN (${compIds.map(() => '?').join(',')})`).get(tid, ...compIds) as { p: number | null }).p
      : null;
    const qual = ctx.db.prepare('SELECT qualified, pool_rank FROM qualifications WHERE tournament_id = ? AND user_id = ?').get(tid, userId) as { qualified: number; pool_rank: number } | undefined;
    totals.tournaments++;
    if (placement === 1) totals.titles++;
    history.push({
      tournamentId: tid, name: t.name, format: t.format, formatLabel: FORMAT_LABELS[t.format], state: t.state, date: t.started_at ?? t.cfg.schedule.startAt ?? t.created_at,
      team: comps.find((c) => c.stage !== 'group')?.name ?? null, placement, teamRecord: rec.team, sixmansGroup: t.format === 'sixmans' ? { ...rec.group, poolRank: qual?.pool_rank ?? null, qualified: qual ? !!qual.qualified : null } : null,
    });
  }
  history.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return { user: publicUser(u), profilePublic: !!u.profile_public, totals, history };
}

export function searchPlayers(ctx: AppContext, q: string) {
  const term = `%${q.replace(/[%_]/g, '').slice(0, 40)}%`;
  return (ctx.db.prepare('SELECT * FROM users WHERE profile_public = 1 AND (username LIKE ? OR global_name LIKE ?) ORDER BY username LIMIT 25').all(term, term) as Parameters<typeof publicUser>[0][]).map(publicUser);
}
