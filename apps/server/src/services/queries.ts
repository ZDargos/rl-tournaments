import type { AppContext } from './context.js';
import { json } from '../lib/util.js';
import type { GameScore, SlotSource } from '@rl/core';

export interface MatchRow {
  id: number;
  tournament_id: number;
  stage: 'main' | 'group' | 'finals';
  bracket: string;
  round: number;
  position: number;
  key: string;
  pool_id: number | null;
  best_of: number;
  source_a: string | null;
  source_b: string | null;
  competitor_a: number | null;
  competitor_b: number | null;
  status: 'pending' | 'ready' | 'awaiting_confirmation' | 'disputed' | 'completed' | 'void' | 'cancelled';
  winner: 'a' | 'b' | null;
  walkover: number;
  forfeit: number;
  wins_a: number | null;
  wins_b: number | null;
  goals_a: number | null;
  goals_b: number | null;
  games: string | null;
  live_games: string | null;
  ready_at: string | null;
  completed_at: string | null;
  result_version: number;
  created_at: string;
  updated_at: string;
}

export interface CompetitorRow {
  id: number;
  tournament_id: number;
  entry_id: number | null;
  kind: 'player' | 'team' | 'temp_team';
  stage: 'main' | 'group' | 'finals';
  name: string;
  seed: number | null;
}

export const ACTIVE_MATCH = ['ready', 'awaiting_confirmation', 'disputed'] as const;

export function getMatch(ctx: AppContext, id: number): MatchRow | undefined {
  return ctx.db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as MatchRow | undefined;
}

export function matchesOf(ctx: AppContext, tournamentId: number, stage?: string): MatchRow[] {
  return (stage
    ? ctx.db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND stage = ? ORDER BY stage, bracket, round, position, id').all(tournamentId, stage)
    : ctx.db.prepare('SELECT * FROM matches WHERE tournament_id = ? ORDER BY stage, bracket, round, position, id').all(tournamentId)) as MatchRow[];
}

export function competitorsOf(ctx: AppContext, tournamentId: number, stage?: string): CompetitorRow[] {
  return (stage
    ? ctx.db.prepare('SELECT * FROM competitors WHERE tournament_id = ? AND stage = ? ORDER BY seed, id').all(tournamentId, stage)
    : ctx.db.prepare('SELECT * FROM competitors WHERE tournament_id = ? ORDER BY stage, seed, id').all(tournamentId)) as CompetitorRow[];
}

export function competitorMembers(ctx: AppContext, competitorId: number | null): string[] {
  if (!competitorId) return [];
  return (ctx.db.prepare('SELECT user_id FROM competitor_members WHERE competitor_id = ? ORDER BY role, user_id').all(competitorId) as { user_id: string }[]).map((r) => r.user_id);
}

export function membersByCompetitor(ctx: AppContext, tournamentId: number): Map<number, { userId: string; role: string }[]> {
  const rows = ctx.db
    .prepare('SELECT cm.competitor_id, cm.user_id, cm.role FROM competitor_members cm JOIN competitors c ON c.id = cm.competitor_id WHERE c.tournament_id = ?')
    .all(tournamentId) as { competitor_id: number; user_id: string; role: string }[];
  const out = new Map<number, { userId: string; role: string }[]>();
  for (const r of rows) {
    if (!out.has(r.competitor_id)) out.set(r.competitor_id, []);
    out.get(r.competitor_id)!.push({ userId: r.user_id, role: r.role });
  }
  return out;
}

export function competitorName(ctx: AppContext, id: number | null): string {
  if (!id) return 'TBD';
  const r = ctx.db.prepare('SELECT name FROM competitors WHERE id = ?').get(id) as { name: string } | undefined;
  return r?.name ?? 'TBD';
}

export const matchGames = (m: MatchRow): GameScore[] => json<GameScore[]>(m.games, []);
export const matchSource = (s: string | null): SlotSource | null => (s ? (JSON.parse(s) as SlotSource) : null);

/** Which side (if any) a user plays on in a match. */
export function sideOf(ctx: AppContext, m: MatchRow, userId: string): 'a' | 'b' | null {
  if (m.competitor_a && competitorMembers(ctx, m.competitor_a).includes(userId)) return 'a';
  if (m.competitor_b && competitorMembers(ctx, m.competitor_b).includes(userId)) return 'b';
  return null;
}

export function matchLabel(m: Pick<MatchRow, 'stage' | 'bracket' | 'round' | 'position' | 'id'>, poolName?: string | null): string {
  const r = m.round;
  switch (m.bracket) {
    case 'winners': return `Winners R${r} · Match ${m.position + 1}`;
    case 'losers': return `Losers R${r} · Match ${m.position + 1}`;
    case 'grand_final': return 'Grand Final';
    case 'grand_final_reset': return 'Grand Final (reset)';
    case 'third_place': return 'Third-place match';
    case 'swiss': return `Swiss R${r} · Match ${m.position + 1}`;
    case 'rr': return `Round ${r} · Match ${m.position + 1}`;
    case 'pool': return `${poolName ?? 'Pool'} · Round ${r}${m.position ? ` · Match ${m.position + 1}` : ''}`;
    case 'finals': return `Finals R${r} · Match ${m.position + 1}`;
    default: return `Match ${m.id}`;
  }
}

export function poolName(ctx: AppContext, poolId: number | null): string | null {
  if (!poolId) return null;
  return (ctx.db.prepare('SELECT name FROM pools WHERE id = ?').get(poolId) as { name: string } | undefined)?.name ?? null;
}
