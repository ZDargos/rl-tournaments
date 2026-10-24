import {
  canViewRole, forbidden, isManagerRole, notFound, parseConfig, tournamentRole,
  type MemberFacts, type TournamentConfig, type TournamentFacts, type TournamentRole, type TournamentState,
} from '@rl/core';
import type { AppContext } from './context.js';
import { getGuild, guildPolicy, memberFacts } from './guilds.js';

export interface TournamentRow {
  id: number;
  guild_id: string;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  state: TournamentState;
  stage: 'main' | 'group' | 'group_complete' | 'finals' | null;
  format: TournamentConfig['format'];
  config: string;
  structure: string;
  preset_id: number | null;
  preset_version: number | null;
  created_by: string;
  start_at: string | null;
  timezone: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  archived_at: string | null;
  champion_competitor_id: number | null;
  auto_start_error: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface LoadedTournament extends TournamentRow {
  cfg: TournamentConfig;
}

export function loadTournament(ctx: AppContext, id: number): LoadedTournament {
  if (!Number.isInteger(id) || id <= 0) throw notFound('Tournament');
  const row = ctx.db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id) as TournamentRow | undefined;
  if (!row) throw notFound('Tournament');
  return { ...row, cfg: parseConfig(JSON.parse(row.config)) };
}

export function adminIds(ctx: AppContext, tournamentId: number): string[] {
  return (ctx.db.prepare('SELECT user_id FROM tournament_admins WHERE tournament_id = ?').all(tournamentId) as { user_id: string }[]).map((r) => r.user_id);
}

/** Users with an active roster position or a pending/waitlisted registration. */
export function participantIds(ctx: AppContext, tournamentId: number): string[] {
  return (
    ctx.db
      .prepare(
        `SELECT DISTINCT em.user_id FROM entry_members em JOIN entries e ON e.id = em.entry_id
         WHERE em.tournament_id = ? AND em.active = 1 AND e.status IN ('pending','confirmed','waitlisted')
         UNION SELECT cm.user_id FROM competitor_members cm JOIN competitors c ON c.id = cm.competitor_id WHERE c.tournament_id = ?`,
      )
      .all(tournamentId, tournamentId) as { user_id: string }[]
  ).map((r) => r.user_id);
}

export function invitedIds(ctx: AppContext, tournamentId: number): string[] {
  const direct = (ctx.db.prepare('SELECT user_id FROM tournament_invites WHERE tournament_id = ?').all(tournamentId) as { user_id: string }[]).map((r) => r.user_id);
  const teamInv = (ctx.db.prepare("SELECT invitee_id FROM invitations WHERE tournament_id = ? AND status = 'pending'").all(tournamentId) as { invitee_id: string }[]).map((r) => r.invitee_id);
  return [...new Set([...direct, ...teamInv])];
}

export function tournamentFacts(ctx: AppContext, t: TournamentRow): TournamentFacts {
  return {
    creatorId: t.created_by,
    adminIds: adminIds(ctx, t.id),
    visibility: t.visibility,
    participantIds: participantIds(ctx, t.id),
    invitedIds: invitedIds(ctx, t.id),
  };
}

export interface Access {
  role: TournamentRole;
  member: MemberFacts;
  canView: boolean;
  canManage: boolean;
  isCreator: boolean;
}

export async function getAccess(ctx: AppContext, t: TournamentRow, userId: string | null): Promise<Access> {
  const g = getGuild(ctx, t.guild_id);
  const policy = g ? guildPolicy(g) : undefined;
  const member = await memberFacts(ctx, t.guild_id, userId);
  const role = tournamentRole(member, tournamentFacts(ctx, t), policy ?? { tournamentCreation: 'admins', creatorRoleIds: [], presetManagerRoleIds: [], serverAdminsManageTournaments: false, serverAdminsViewPrivate: false });
  return { role, member, canView: canViewRole(role), canManage: isManagerRole(role), isCreator: !!userId && userId === t.created_by };
}

/** Private tournaments answer "not found" to outsiders so their existence is not leaked. */
export async function assertView(ctx: AppContext, t: TournamentRow, userId: string | null): Promise<Access> {
  const a = await getAccess(ctx, t, userId);
  if (!a.canView) throw notFound('Tournament');
  return a;
}

export async function assertManage(ctx: AppContext, t: TournamentRow, userId: string | null): Promise<Access> {
  const a = await getAccess(ctx, t, userId);
  if (!a.canView) throw notFound('Tournament');
  if (!a.canManage) throw forbidden('Only the tournament creator and its administrators can do that.');
  return a;
}

/** Managers of a tournament for notifications/voice: creator + admins. */
export function managerIds(ctx: AppContext, t: TournamentRow): string[] {
  return [...new Set([t.created_by, ...adminIds(ctx, t.id)])];
}
