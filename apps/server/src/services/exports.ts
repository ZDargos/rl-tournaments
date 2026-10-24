import { invalid, rankLabel } from '@rl/core';
import type { AppContext } from './context.js';
import { assertView, loadTournament } from './access.js';
import { audit } from './audit.js';
import { toCsv } from '../lib/csv.js';
import { tournamentDetail } from './views.js';
import { playerProfile } from './stats.js';

export const EXPORT_KINDS = ['participants', 'teams', 'pools', 'schedule', 'results', 'standings', 'placements', 'player_stats'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/**
 * CSV exports built from persisted data via the same view model as the website, so they obey the
 * same visibility rules (private tournaments 404 for outsiders; skill inputs only for organizers).
 */
export async function exportCsv(ctx: AppContext, tournamentId: number, kind: ExportKind, viewerId: string | null): Promise<{ filename: string; csv: string }> {
  if (!EXPORT_KINDS.includes(kind)) throw invalid('bad_export', `Unknown export "${kind}".`);
  const t = loadTournament(ctx, tournamentId);
  const access = await assertView(ctx, t, viewerId);
  const d = await tournamentDetail(ctx, tournamentId, viewerId);
  const manage = access.canManage;
  let csv: string;
  switch (kind) {
    case 'participants':
      csv = toCsv(
        ['entry_id', 'type', 'name', 'status', 'checked_in', 'discord_user_id', 'role', ...(manage ? ['seed', 'rank'] : [])],
        d.entries.flatMap((e) => e.members.map((m) => [e.id, e.kind, e.kind === 'team' ? e.name : m.name, e.status, e.checkedIn, m.userId, m.role, ...(manage ? [e.seed, e.rank ? rankLabel(e.rank, e.division) : ''] : [])])),
      );
      break;
    case 'teams':
      csv = toCsv(['competitor_id', 'stage', 'team', 'seed', 'player', 'discord_user_id', 'role'], d.competitors.flatMap((c) => c.players.map((p) => [c.id, c.stage, c.name, c.seed, p.name, p.userId, p.role])));
      break;
    case 'pools': {
      const sm = d.sixmans as { pools: { data: { pools: { name: string; players: { userId: string; skill?: number }[] }[] } } | null } | null;
      const names = new Map(d.entries.map((e) => [e.userId, e.name]));
      csv = toCsv(['pool', 'player', 'discord_user_id', ...(manage ? ['skill'] : [])], (sm?.pools?.data.pools ?? []).flatMap((p) => p.players.map((pl) => [p.name, names.get(pl.userId) ?? pl.userId, pl.userId, ...(manage ? [pl.skill] : [])])));
      break;
    }
    case 'schedule':
      csv = toCsv(['match_id', 'stage', 'label', 'best_of', 'status', 'side_a', 'side_a_players', 'side_b', 'side_b_players', 'ready_at'], d.matches.map((m) => [m.id, m.stage, m.label, m.bestOf, m.status, m.a?.name, m.a?.players.map((p) => p.name).join(' / '), m.b?.name, m.b?.players.map((p) => p.name).join(' / '), m.readyAt]));
      break;
    case 'results':
      csv = toCsv(
        ['match_id', 'stage', 'label', 'side_a', 'side_b', 'winner', 'series_a', 'series_b', 'games', 'goals_a', 'goals_b', 'forfeit', 'walkover', 'completed_at'],
        d.matches.filter((m) => m.status === 'completed').map((m) => [m.id, m.stage, m.label, m.a?.name, m.b?.name, m.winner === 'a' ? m.a?.name : m.b?.name, m.winsA, m.winsB, m.games.map((g) => `${g.a}-${g.b}`).join(' '), m.goalsA, m.goalsB, m.forfeit, m.walkover, m.completedAt]),
      );
      break;
    case 'standings': {
      if (t.format === 'sixmans') {
        const sm = d.sixmans as { standings: { name: string; standings: { rank: number; name: string; playerId: string; played: number; wins: number; losses: number; points: number; goalsFor: number; goalsAgainst: number; goalDiff: number; qualified: boolean }[] }[] };
        csv = toCsv(['pool', 'rank', 'player', 'discord_user_id', 'played', 'wins', 'losses', 'points', 'goals_for', 'goals_against', 'goal_diff', 'qualified'], sm.standings.flatMap((p) => p.standings.map((s) => [p.name, s.rank, s.name, s.playerId, s.played, s.wins, s.losses, s.points, s.goalsFor, s.goalsAgainst, s.goalDiff, s.qualified])));
      } else {
        const st = (d.standings as { rank: number; name: string; played: number; wins: number; losses: number; points: number; buchholz: number; gameDiff: number; goalDiff: number }[] | null) ?? [];
        csv = toCsv(['rank', 'name', 'played', 'wins', 'losses', 'points', 'buchholz', 'game_diff', 'goal_diff'], st.map((s) => [s.rank, s.name, s.played, s.wins, s.losses, s.points, s.buchholz, s.gameDiff, s.goalDiff]));
      }
      break;
    }
    case 'placements':
      csv = toCsv(['placement', 'name', 'players'], d.placements.map((p) => [p.placement, p.name, p.players.map((x) => x.name).join(' / ')]));
      break;
    case 'player_stats': {
      const ids = [...new Set(d.competitors.flatMap((c) => c.players.map((p) => p.userId)))];
      const rows: (string | number | null)[][] = [];
      for (const uid of ids) {
        try {
          const p = await playerProfile(ctx, uid, viewerId);
          const h = p.history.find((x) => x.tournamentId === t.id);
          if (!h) continue;
          rows.push([p.user.displayName, uid, h.placement, h.teamRecord.wins, h.teamRecord.losses, h.sixmansGroup?.wins ?? null, h.sixmansGroup?.losses ?? null, h.sixmansGroup?.points ?? null, h.sixmansGroup ? h.sixmansGroup.gf - h.sixmansGroup.ga : null]);
        } catch {
          /* private profile: skipped */
        }
      }
      csv = toCsv(['player', 'discord_user_id', 'placement', 'bracket_wins', 'bracket_losses', 'group_wins', 'group_losses', 'group_points', 'group_goal_diff'], rows);
      break;
    }
  }
  audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId: viewerId, action: 'export.downloaded', details: { kind } });
  const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'tournament';
  return { filename: `${slug}-${t.id}-${kind}.csv`, csv };
}
