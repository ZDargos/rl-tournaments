/**
 * Authorization rules shared by the API, the Discord bot and background jobs. The server builds
 * the facts from the database / Discord and calls these functions; nothing here trusts client input.
 *
 * Server-level roles (per Discord server):
 *   - member: any member of the Discord server.
 *   - server admin: has Manage Server or Administrator in Discord.
 *   - preset manager: server admin, or holds one of `presetManagerRoleIds`.
 *   - tournament creator (capability): decided by `tournamentCreation` policy.
 * Tournament-level roles:
 *   - creator and listed tournament admins manage the tournament.
 *   - server admins manage it ONLY if `serverAdminsManageTournaments` is enabled.
 *   - participants act on their own registrations and matches.
 *   - viewers: anyone for public tournaments; for private ones only creator/admins/participants/invitees.
 */
export interface GuildPolicy {
  tournamentCreation: 'members' | 'admins' | 'roles';
  creatorRoleIds: string[];
  presetManagerRoleIds: string[];
  serverAdminsManageTournaments: boolean;
  /** Server admins may view private tournaments (read-only) even without managing them. */
  serverAdminsViewPrivate: boolean;
}

export const DEFAULT_GUILD_POLICY: GuildPolicy = {
  tournamentCreation: 'admins',
  creatorRoleIds: [],
  presetManagerRoleIds: [],
  serverAdminsManageTournaments: false,
  serverAdminsViewPrivate: false,
};

export interface MemberFacts {
  userId: string | null;
  isMember: boolean;
  isServerAdmin: boolean;
  roleIds: string[];
}

export interface TournamentFacts {
  creatorId: string;
  adminIds: string[];
  visibility: 'public' | 'private';
  participantIds: string[];
  invitedIds: string[];
}

const hasAnyRole = (m: MemberFacts, roles: string[]) => roles.some((r) => m.roleIds.includes(r));

export function canCreateTournament(m: MemberFacts, p: GuildPolicy): boolean {
  if (!m.userId || !m.isMember) return false;
  if (m.isServerAdmin) return true;
  if (p.tournamentCreation === 'members') return true;
  if (p.tournamentCreation === 'roles') return hasAnyRole(m, p.creatorRoleIds);
  return false;
}

export function canManagePresets(m: MemberFacts, p: GuildPolicy): boolean {
  if (!m.userId || !m.isMember) return false;
  return m.isServerAdmin || hasAnyRole(m, p.presetManagerRoleIds);
}

export function canViewPresets(m: MemberFacts): boolean {
  return !!m.userId && m.isMember;
}

export function canManageServer(m: MemberFacts): boolean {
  return !!m.userId && m.isMember && m.isServerAdmin;
}

export type TournamentRole = 'creator' | 'admin' | 'server_admin' | 'participant' | 'invited' | 'viewer' | 'none';

export function tournamentRole(m: MemberFacts, t: TournamentFacts, p: GuildPolicy): TournamentRole {
  const u = m.userId;
  if (u && u === t.creatorId) return 'creator';
  if (u && t.adminIds.includes(u)) return 'admin';
  if (u && m.isMember && m.isServerAdmin && p.serverAdminsManageTournaments) return 'server_admin';
  if (u && t.participantIds.includes(u)) return 'participant';
  if (u && t.invitedIds.includes(u)) return 'invited';
  if (t.visibility === 'public') return 'viewer';
  if (u && m.isMember && m.isServerAdmin && p.serverAdminsViewPrivate) return 'viewer';
  return 'none';
}

export const isManagerRole = (r: TournamentRole) => r === 'creator' || r === 'admin' || r === 'server_admin';
export const canViewRole = (r: TournamentRole) => r !== 'none';

export function canManageTournament(m: MemberFacts, t: TournamentFacts, p: GuildPolicy): boolean {
  return isManagerRole(tournamentRole(m, t, p));
}

export function canViewTournament(m: MemberFacts, t: TournamentFacts, p: GuildPolicy): boolean {
  return canViewRole(tournamentRole(m, t, p));
}

/** Only the creator can change the admin list or delete/archive. */
export function canChangeAdmins(m: MemberFacts, t: TournamentFacts): boolean {
  return !!m.userId && m.userId === t.creatorId;
}
