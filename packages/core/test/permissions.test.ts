import { describe, expect, it } from 'vitest';
import { canChangeAdmins, canCreateTournament, canManagePresets, canManageTournament, canViewTournament, DEFAULT_GUILD_POLICY as P } from '@rl/core';

const member = (userId: string, extra: Partial<{ isServerAdmin: boolean; roleIds: string[]; isMember: boolean }> = {}) => ({ userId, isMember: true, isServerAdmin: false, roleIds: [], ...extra });
const t = { creatorId: 'c', adminIds: ['a'], visibility: 'private' as const, participantIds: ['p'], invitedIds: ['i'] };

describe('permissions', () => {
  it('only admins create tournaments by default; roles policy honours creator roles', () => {
    expect(canCreateTournament(member('x'), P)).toBe(false);
    expect(canCreateTournament(member('x', { isServerAdmin: true }), P)).toBe(true);
    expect(canCreateTournament(member('x', { roleIds: ['r1'] }), { ...P, tournamentCreation: 'roles', creatorRoleIds: ['r1'] })).toBe(true);
    expect(canCreateTournament(member('x', { isMember: false, isServerAdmin: true }), P)).toBe(false);
  });
  it('preset managers are server admins or hold a preset role', () => {
    expect(canManagePresets(member('x'), P)).toBe(false);
    expect(canManagePresets(member('x', { roleIds: ['pm'] }), { ...P, presetManagerRoleIds: ['pm'] })).toBe(true);
  });
  it('tournament management: creator and admins; server admins only when the policy allows', () => {
    expect(canManageTournament(member('c'), t, P)).toBe(true);
    expect(canManageTournament(member('a'), t, P)).toBe(true);
    expect(canManageTournament(member('p'), t, P)).toBe(false);
    expect(canManageTournament(member('s', { isServerAdmin: true }), t, P)).toBe(false);
    expect(canManageTournament(member('s', { isServerAdmin: true }), t, { ...P, serverAdminsManageTournaments: true })).toBe(true);
  });
  it('private tournaments are visible only to insiders', () => {
    for (const u of ['c', 'a', 'p', 'i']) expect(canViewTournament(member(u), t, P)).toBe(true);
    expect(canViewTournament(member('x'), t, P)).toBe(false);
    expect(canViewTournament({ userId: null, isMember: false, isServerAdmin: false, roleIds: [] }, t, P)).toBe(false);
    expect(canViewTournament({ userId: null, isMember: false, isServerAdmin: false, roleIds: [] }, { ...t, visibility: 'public' }, P)).toBe(true);
  });
  it('only the creator changes the admin list', () => {
    expect(canChangeAdmins(member('c'), t)).toBe(true);
    expect(canChangeAdmins(member('a'), t)).toBe(false);
  });
});
