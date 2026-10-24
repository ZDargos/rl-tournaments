import { conflict, forbidden, invalid, isPreStart, isRankId, isStarted, notFound, type TournamentConfig } from '@rl/core';
import type { AppContext, Source } from './context.js';
import { nowIso, tx } from './context.js';
import { assertManage, assertView, getAccess, loadTournament, type LoadedTournament } from './access.js';
import { audit } from './audit.js';
import { memberFacts } from './guilds.js';
import { enqueue } from './notifications.js';
import { ensureUser } from './users.js';
import { addMinutes } from '../lib/util.js';

export interface EntryRow {
  id: number;
  tournament_id: number;
  kind: 'player' | 'team';
  user_id: string | null;
  name: string | null;
  captain_id: string | null;
  status: 'pending' | 'confirmed' | 'waitlisted' | 'withdrawn' | 'removed' | 'rejected';
  seed: number | null;
  rank: string | null;
  rank_division: number | null;
  checked_in_at: string | null;
  checked_in_by: string | null;
  waitlisted_at: string | null;
  roster_locked: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export const ACTIVE_ENTRY = ['pending', 'confirmed', 'waitlisted'] as const;

export function getEntry(ctx: AppContext, id: number): EntryRow {
  const e = ctx.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow | undefined;
  if (!e) throw notFound('Registration');
  return e;
}

export function entriesOf(ctx: AppContext, tournamentId: number, statuses?: readonly string[]): EntryRow[] {
  const rows = ctx.db.prepare('SELECT * FROM entries WHERE tournament_id = ? ORDER BY created_at, id').all(tournamentId) as EntryRow[];
  return statuses ? rows.filter((r) => statuses.includes(r.status)) : rows;
}

export function entryMembers(ctx: AppContext, entryId: number, activeOnly = true) {
  return ctx.db
    .prepare(`SELECT user_id, role, active, joined_at FROM entry_members WHERE entry_id = ? ${activeOnly ? 'AND active = 1' : ''} ORDER BY CASE role WHEN 'captain' THEN 0 WHEN 'player' THEN 1 ELSE 2 END, joined_at`)
    .all(entryId) as { user_id: string; role: 'captain' | 'player' | 'substitute'; active: number; joined_at: string }[];
}

/** The active entry a user belongs to in a tournament (as a solo player or team member). */
export function entryForUser(ctx: AppContext, tournamentId: number, userId: string): EntryRow | undefined {
  return ctx.db
    .prepare(
      `SELECT e.* FROM entries e JOIN entry_members em ON em.entry_id = e.id AND em.active = 1
       WHERE e.tournament_id = ? AND em.user_id = ? AND e.status IN ('pending','confirmed','waitlisted')`,
    )
    .get(tournamentId, userId) as EntryRow | undefined;
}

const confirmedCount = (ctx: AppContext, tid: number) =>
  (ctx.db.prepare("SELECT COUNT(*) c FROM entries WHERE tournament_id = ? AND status = 'confirmed'").get(tid) as { c: number }).c;

function registrationWindowOpen(ctx: AppContext, t: LoadedTournament): string | null {
  const r = t.cfg.registration;
  const now = ctx.clock.now().getTime();
  if (t.state === 'registration_open') {
    if (r.closesAt && Date.parse(r.closesAt) < now && !r.lateRegistration) return 'Registration has closed.';
    return null;
  }
  if (r.lateRegistration && (t.state === 'registration_closed' || t.state === 'ready')) return null;
  if (isStarted(t.state)) return 'This tournament has already started.';
  return 'Registration is not open.';
}

function uniqueError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  if (/entry_members_one_position|entries_player_active|UNIQUE constraint failed: entry_members|UNIQUE constraint failed: entries\.tournament_id, entries\.user_id/.test(err.message))
    return 'You are already registered in this tournament (solo or on a team).';
  if (/entries_team_name_active/.test(err.message))
    return 'That team name is already taken in this tournament.';
  return null;
}

async function assertEligible(ctx: AppContext, t: LoadedTournament, userId: string) {
  const m = await memberFacts(ctx, t.guild_id, userId);
  if (!m.isMember) throw forbidden('You must be a member of the tournament’s Discord server to register.');
  const roles = t.cfg.registration.requiredRoleIds;
  if (roles.length && !roles.some((r) => m.roleIds.includes(r))) throw forbidden('You do not have a role required to register for this tournament.');
  if (t.visibility === 'private') {
    const a = await getAccess(ctx, t, userId);
    if (a.role === 'viewer' || a.role === 'none') throw forbidden('This is a private tournament; you need an invitation from an organizer.');
  }
}

/** New entries are confirmed, pending (approval) or waitlisted depending on capacity and settings. */
function initialStatus(ctx: AppContext, t: LoadedTournament): EntryRow['status'] {
  const cap = t.cfg.registration.capacity;
  const full = cap != null && confirmedCount(ctx, t.id) >= cap;
  if (t.cfg.registration.requireApproval) return 'pending';
  if (full) {
    if (!t.cfg.registration.waitlist) throw conflict('tournament_full', 'This tournament is full.');
    return 'waitlisted';
  }
  return 'confirmed';
}

export async function register(ctx: AppContext, actorId: string, tournamentId: number, input: { teamName?: string | null; rank?: string | null }, source: Source) {
  const t = loadTournament(ctx, tournamentId);
  await assertView(ctx, t, actorId);
  const closed = registrationWindowOpen(ctx, t);
  if (closed) throw conflict('registration_closed', closed);
  await assertEligible(ctx, t, actorId);
  ensureUser(ctx, actorId);
  const teamMode = t.cfg.registrationMode === 'team' && t.cfg.teamSize > 1;
  if (teamMode && !input.teamName?.trim()) throw invalid('team_name_required', 'This tournament uses team registration: enter a team name to register as captain, or accept an invitation from a captain.');
  if (input.rank && !isRankId(input.rank)) throw invalid('bad_rank', 'Unknown rank.');
  try {
    const entryId = tx(ctx, () => {
      const status = initialStatus(ctx, t);
      const now = nowIso(ctx);
      const r = teamMode
        ? ctx.db
            .prepare(`INSERT INTO entries (tournament_id, kind, name, captain_id, status, waitlisted_at, source, created_at, updated_at) VALUES (?, 'team', ?, ?, ?, ?, ?, ?, ?)`)
            .run(t.id, input.teamName!.trim().slice(0, 40), actorId, status, status === 'waitlisted' ? now : null, source === 'system' ? 'admin' : source, now, now)
        : ctx.db
            .prepare(`INSERT INTO entries (tournament_id, kind, user_id, status, rank, waitlisted_at, source, created_at, updated_at) VALUES (?, 'player', ?, ?, ?, ?, ?, ?, ?)`)
            .run(t.id, actorId, status, t.cfg.format === 'sixmans' && t.cfg.sixmans.skillMethod === 'rank' ? (input.rank ?? null) : null, status === 'waitlisted' ? now : null, source === 'system' ? 'admin' : source, now, now);
      const id = Number(r.lastInsertRowid);
      ctx.db
        .prepare('INSERT INTO entry_members (entry_id, tournament_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, t.id, actorId, teamMode ? 'captain' : 'player', now);
      ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'registration.created', target: `entry:${id}`, details: { status, team: input.teamName ?? null, source } });
      return id;
    });
    ctx.kick(t.id);
    return getEntry(ctx, entryId);
  } catch (err) {
    const msg = uniqueError(err);
    if (msg) throw conflict('already_registered', msg);
    throw err;
  }
}

/** Promote the oldest waitlisted entries while there is capacity. */
export function promoteWaitlist(ctx: AppContext, t: LoadedTournament, actorId: string | null) {
  const cap = t.cfg.registration.capacity;
  const waiting = ctx.db.prepare("SELECT * FROM entries WHERE tournament_id = ? AND status = 'waitlisted' ORDER BY waitlisted_at, id").all(t.id) as EntryRow[];
  for (const e of waiting) {
    if (cap != null && confirmedCount(ctx, t.id) >= cap) break;
    ctx.db.prepare("UPDATE entries SET status = 'confirmed', updated_at = ? WHERE id = ?").run(nowIso(ctx), e.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'registration.promoted', target: `entry:${e.id}` });
    const uid = e.kind === 'player' ? e.user_id : e.captain_id;
    enqueue(ctx, {
      tournamentId: t.id, category: 'personal', key: `e${e.id}:promoted`, audience: `user:${uid}`,
      payload: { text: `🎉 A spot opened up: ${e.kind === 'team' ? `your team ${e.name}` : 'you'} moved from the waitlist into **${t.name.replace(/[*_`~|]/g, '')}**.` },
    });
  }
}

/** Leave a tournament: withdraw a solo entry, a whole team (captain) or leave a team (member). */
export async function withdraw(ctx: AppContext, actorId: string, tournamentId: number, source: Source) {
  const t = loadTournament(ctx, tournamentId);
  const e = entryForUser(ctx, tournamentId, actorId);
  if (!e) throw notFound('Your registration');
  if (!isPreStart(t.state)) throw conflict('already_started', 'The tournament has started. Ask an organizer to handle withdrawals and substitutions.');
  if (!t.cfg.registration.allowWithdrawal && e.status === 'confirmed') throw forbidden('This tournament does not allow withdrawals. Contact an organizer.');
  tx(ctx, () => {
    const now = nowIso(ctx);
    if (e.kind === 'team' && e.captain_id !== actorId) {
      if (e.roster_locked) throw conflict('roster_locked', 'Rosters are locked.');
      ctx.db.prepare('UPDATE entry_members SET active = 0, left_at = ? WHERE entry_id = ? AND user_id = ?').run(now, e.id, actorId);
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'roster.left', target: `entry:${e.id}`, details: { source } });
    } else {
      ctx.db.prepare("UPDATE entries SET status = 'withdrawn', updated_at = ? WHERE id = ?").run(now, e.id);
      ctx.db.prepare('UPDATE entry_members SET active = 0, left_at = ? WHERE entry_id = ? AND active = 1').run(now, e.id);
      ctx.db.prepare("UPDATE invitations SET status = 'revoked' WHERE entry_id = ? AND status = 'pending'").run(e.id);
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'registration.withdrawn', target: `entry:${e.id}`, details: { source } });
      if (e.status === 'confirmed') promoteWaitlist(ctx, t, null);
    }
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
  });
  ctx.kick(t.id);
}

export type EntryAdminAction = 'approve' | 'reject' | 'remove' | 'waitlist' | 'restore';

export async function adminEntryAction(ctx: AppContext, actorId: string, entryId: number, action: EntryAdminAction, reason: string | null, source: Source) {
  const e = getEntry(ctx, entryId);
  const t = loadTournament(ctx, e.tournament_id);
  await assertManage(ctx, t, actorId);
  if (!isPreStart(t.state)) throw conflict('already_started', 'Registrations cannot be changed after the start. Use forfeits or roster corrections instead.');
  tx(ctx, () => {
    const now = nowIso(ctx);
    let status: EntryRow['status'];
    if (action === 'approve') {
      if (!['pending', 'waitlisted'].includes(e.status)) throw conflict('bad_status', 'Only pending or waitlisted entries can be approved.');
      const cap = t.cfg.registration.capacity;
      if (cap != null && confirmedCount(ctx, t.id) >= cap) {
        if (e.status === 'waitlisted') throw conflict('tournament_full', 'The tournament is full. Increase the capacity or remove someone first.');
        status = 'waitlisted';
      } else status = 'confirmed';
    } else if (action === 'reject') status = 'rejected';
    else if (action === 'remove') status = 'removed';
    else if (action === 'waitlist') status = 'waitlisted';
    else {
      if (!['withdrawn', 'removed', 'rejected'].includes(e.status)) throw conflict('bad_status', 'Only removed, rejected or withdrawn entries can be restored.');
      status = 'pending';
    }
    ctx.db.prepare('UPDATE entries SET status = ?, waitlisted_at = CASE WHEN ? = \'waitlisted\' THEN COALESCE(waitlisted_at, ?) ELSE waitlisted_at END, updated_at = ? WHERE id = ?').run(status, status, now, now, e.id);
    if (status === 'removed' || status === 'rejected') ctx.db.prepare('UPDATE entry_members SET active = 0, left_at = ? WHERE entry_id = ? AND active = 1').run(now, e.id);
    if (action === 'restore') {
      try {
        ctx.db.prepare('UPDATE entry_members SET active = 1, left_at = NULL WHERE entry_id = ? AND (role = \'captain\' OR (SELECT kind FROM entries WHERE id = ?) = \'player\')').run(e.id, e.id);
      } catch (err) {
        const msg = uniqueError(err);
        if (msg) throw conflict('already_registered', 'That player has since registered elsewhere in this tournament.');
        throw err;
      }
    }
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: `registration.${action}`, target: `entry:${e.id}`, details: { from: e.status, to: status, reason, source } });
    const uid = e.kind === 'player' ? e.user_id : e.captain_id;
    if (action === 'approve' || action === 'reject' || action === 'remove')
      enqueue(ctx, {
        tournamentId: t.id, category: 'personal', key: `e${e.id}:${action}:${now}`, audience: `user:${uid}`,
        payload: { text: `Your registration for **${t.name.replace(/[*_`~|]/g, '')}** is now **${status}**.${reason ? ` Note: ${reason.replace(/[*_`~|@]/g, '')}` : ''}` },
      });
    if (e.status === 'confirmed' && status !== 'confirmed') promoteWaitlist(ctx, t, actorId);
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
  });
  ctx.kick(t.id);
  return getEntry(ctx, entryId);
}

/** Organizer adds a player directly (e.g. someone who is not on the website). */
export async function adminAddPlayer(ctx: AppContext, actorId: string, tournamentId: number, userId: string, username: string | null, source: Source) {
  const t = loadTournament(ctx, tournamentId);
  await assertManage(ctx, t, actorId);
  if (!isPreStart(t.state)) throw conflict('already_started', 'Players cannot be added after the start.');
  if (t.cfg.registrationMode === 'team' && t.cfg.teamSize > 1) throw invalid('team_mode', 'In team mode players join through a captain’s invitation.');
  ensureUser(ctx, userId, username ?? undefined);
  const m = await memberFacts(ctx, t.guild_id, userId);
  if (!m.isMember) throw invalid('not_member', 'That user is not a member of this Discord server (or the bot cannot see them).');
  try {
    const id = tx(ctx, () => {
      const now = nowIso(ctx);
      const cap = t.cfg.registration.capacity;
      const status = cap != null && confirmedCount(ctx, t.id) >= cap ? 'waitlisted' : 'confirmed';
      const r = ctx.db
        .prepare(`INSERT INTO entries (tournament_id, kind, user_id, status, waitlisted_at, source, created_at, updated_at) VALUES (?, 'player', ?, ?, ?, 'admin', ?, ?)`)
        .run(t.id, userId, status, status === 'waitlisted' ? now : null, now, now);
      const eid = Number(r.lastInsertRowid);
      ctx.db.prepare("INSERT INTO entry_members (entry_id, tournament_id, user_id, role, joined_at) VALUES (?, ?, ?, 'player', ?)").run(eid, t.id, userId, now);
      ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'registration.admin_added', target: `entry:${eid}`, details: { userId, status, source } });
      return eid;
    });
    ctx.kick(t.id);
    return getEntry(ctx, id);
  } catch (err) {
    const msg = uniqueError(err);
    if (msg) throw conflict('already_registered', 'That player is already registered.');
    throw err;
  }
}

/** Organizer sets seed / rank (skill input) before the start. */
export async function setEntrySkill(ctx: AppContext, actorId: string, entryId: number, input: { seed?: number | null; rank?: string | null; division?: number | null }, source: Source) {
  const e = getEntry(ctx, entryId);
  const t = loadTournament(ctx, e.tournament_id);
  await assertManage(ctx, t, actorId);
  if (!isPreStart(t.state)) throw conflict('format_locked', 'Seeds and ranks are locked once the tournament starts.');
  if (input.seed != null && (!Number.isInteger(input.seed) || input.seed < 1 || input.seed > 1024)) throw invalid('bad_seed', 'Seeds are whole numbers from 1 to 1024.');
  if (input.rank != null && !isRankId(input.rank)) throw invalid('bad_rank', 'Unknown rank.');
  if (input.division != null && (!Number.isInteger(input.division) || input.division < 1 || input.division > 4)) throw invalid('bad_division', 'Division must be 1-4.');
  tx(ctx, () => {
    ctx.db
      .prepare('UPDATE entries SET seed = ?, rank = ?, rank_division = ?, updated_at = ? WHERE id = ?')
      .run(input.seed !== undefined ? input.seed : e.seed, input.rank !== undefined ? input.rank : e.rank, input.division !== undefined ? input.division : e.rank_division, nowIso(ctx), e.id);
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'registration.skill_set', target: `entry:${e.id}`, details: { ...input, source } });
  });
  ctx.kick(t.id);
}

/** Players may set their own rank for rank-based 6mans before pools are made; organizers can override. */
export async function setOwnRank(ctx: AppContext, actorId: string, tournamentId: number, rank: string, division: number | null) {
  const t = loadTournament(ctx, tournamentId);
  const e = entryForUser(ctx, tournamentId, actorId);
  if (!e || e.kind !== 'player') throw notFound('Your registration');
  if (!isPreStart(t.state)) throw conflict('format_locked', 'Ranks are locked once the tournament starts.');
  if (!isRankId(rank)) throw invalid('bad_rank', 'Unknown rank.');
  if (ctx.db.prepare("SELECT 1 FROM sixmans_plans WHERE tournament_id = ? AND kind = 'pools' AND status = 'confirmed'").get(t.id))
    throw conflict('pools_confirmed', 'Pools are already confirmed; ask an organizer to change your rank.');
  ctx.db.prepare('UPDATE entries SET rank = ?, rank_division = ?, updated_at = ? WHERE id = ?').run(rank, division, nowIso(ctx), e.id);
  audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'registration.self_rank', target: `entry:${e.id}`, details: { rank, division } });
}

/** Check in for a tournament (player, any team member, or an organizer on someone's behalf). */
export async function checkIn(ctx: AppContext, actorId: string, tournamentId: number, entryId: number | null, source: Source) {
  const t = loadTournament(ctx, tournamentId);
  if (!t.cfg.checkIn.enabled) throw conflict('checkin_disabled', 'This tournament does not use check-in.');
  let e: EntryRow | undefined;
  if (entryId) {
    e = getEntry(ctx, entryId);
    if (e.tournament_id !== t.id) throw notFound('Registration');
    const own = entryForUser(ctx, t.id, actorId);
    if (own?.id !== e.id) await assertManage(ctx, t, actorId);
  } else e = entryForUser(ctx, t.id, actorId);
  if (!e) throw notFound('Your registration');
  if (e.status !== 'confirmed') throw conflict('not_confirmed', 'Only confirmed registrations can check in.');
  if (!isPreStart(t.state)) throw conflict('already_started', 'Check-in is closed: the tournament has started.');
  const startAt = t.cfg.schedule.startAt;
  if (startAt) {
    const now = ctx.clock.now();
    const opens = addMinutes(new Date(startAt), -t.cfg.checkIn.opensMinutesBefore);
    const closes = addMinutes(new Date(startAt), -t.cfg.checkIn.closesMinutesBefore);
    const isAdmin = (await getAccess(ctx, t, actorId)).canManage;
    if (!isAdmin && now < opens) throw conflict('checkin_not_open', `Check-in opens ${opens.toISOString()}.`);
    if (!isAdmin && now > closes) throw conflict('checkin_closed', 'Check-in has closed.');
  }
  tx(ctx, () => {
    ctx.db.prepare('UPDATE entries SET checked_in_at = COALESCE(checked_in_at, ?), checked_in_by = COALESCE(checked_in_by, ?), updated_at = ? WHERE id = ?').run(nowIso(ctx), actorId, nowIso(ctx), e!.id);
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'registration.checked_in', target: `entry:${e!.id}`, details: { source } });
  });
  ctx.kick(t.id);
  return getEntry(ctx, e.id);
}

function rosterLimits(cfg: TournamentConfig) {
  return { players: cfg.teamSize, subs: cfg.registration.maxSubstitutes };
}

export async function inviteToTeam(ctx: AppContext, actorId: string, entryId: number, inviteeId: string, role: 'player' | 'substitute', source: Source, inviteeName?: string) {
  const e = getEntry(ctx, entryId);
  const t = loadTournament(ctx, e.tournament_id);
  if (e.kind !== 'team') throw invalid('not_team', 'Only teams have invitations.');
  const isCaptain = e.captain_id === actorId;
  const manager = (await getAccess(ctx, t, actorId)).canManage;
  if (!isCaptain && !manager) throw forbidden('Only the team captain can invite players.');
  if (!['pending', 'confirmed', 'waitlisted'].includes(e.status)) throw conflict('bad_status', 'This team is no longer registered.');
  if (e.roster_locked && !manager) throw conflict('roster_locked', 'Rosters are locked.');
  if (isStarted(t.state) || t.state === 'cancelled') throw conflict('already_started', 'Invitations are closed once the tournament starts.');
  if (inviteeId === actorId) throw invalid('self_invite', 'You cannot invite yourself.');
  ensureUser(ctx, inviteeId, inviteeName);
  const m = await memberFacts(ctx, t.guild_id, inviteeId);
  if (!m.isMember) throw invalid('not_member', 'That user is not a member of this Discord server (or the bot cannot see them).');
  if (entryForUser(ctx, t.id, inviteeId)) throw conflict('already_registered', 'That player is already registered in this tournament.');
  const members = entryMembers(ctx, e.id);
  const limits = rosterLimits(t.cfg);
  const starters = members.filter((x) => x.role !== 'substitute').length;
  const subs = members.filter((x) => x.role === 'substitute').length;
  if (role === 'player' && starters >= limits.players) throw conflict('roster_full', `The team already has ${limits.players} starters.`);
  if (role === 'substitute' && subs >= limits.subs) throw conflict('roster_full', limits.subs ? `The team already has ${limits.subs} substitute(s).` : 'This tournament does not allow substitutes.');
  try {
    const id = tx(ctx, () => {
      const now = nowIso(ctx);
      const r = ctx.db
        .prepare(`INSERT INTO invitations (tournament_id, entry_id, invitee_id, inviter_id, role, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(t.id, e.id, inviteeId, actorId, role, addMinutes(ctx.clock.now(), t.cfg.registration.inviteExpiryHours * 60).toISOString(), now);
      const iid = Number(r.lastInsertRowid);
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'invitation.created', target: `user:${inviteeId}`, details: { entryId: e.id, role, source } });
      enqueue(ctx, {
        tournamentId: t.id, category: 'personal', key: `inv${iid}`, audience: `user:${inviteeId}`,
        payload: { text: `🤝 You were invited to join **${(e.name ?? '').replace(/[*_`~|]/g, '')}** as a ${role} in **${t.name.replace(/[*_`~|]/g, '')}**. Accept with \`/team accept invitation:${iid}\` or on the website.` },
      });
      return iid;
    });
    ctx.kick(t.id);
    return id;
  } catch (err) {
    if (err instanceof Error && /invitations_pending/.test(err.message)) throw conflict('already_invited', 'That player already has a pending invitation to this team.');
    throw err;
  }
}

export async function respondInvitation(ctx: AppContext, actorId: string, invitationId: number, accept: boolean, source: Source) {
  const inv = ctx.db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitationId) as
    | { id: number; tournament_id: number; entry_id: number; invitee_id: string; role: 'player' | 'substitute'; status: string; expires_at: string }
    | undefined;
  if (!inv || inv.invitee_id !== actorId) throw notFound('Invitation');
  if (inv.status !== 'pending') throw conflict('invitation_closed', `This invitation is ${inv.status}.`);
  const t = loadTournament(ctx, inv.tournament_id);
  if (Date.parse(inv.expires_at) < ctx.clock.now().getTime()) {
    ctx.db.prepare("UPDATE invitations SET status = 'expired' WHERE id = ?").run(inv.id);
    throw conflict('invitation_expired', 'This invitation has expired. Ask the captain for a new one.');
  }
  if (accept) {
    if (!isPreStart(t.state)) throw conflict('already_started', 'The tournament has started.');
    await assertEligible(ctx, t, actorId);
  }
  try {
    tx(ctx, () => {
      const now = nowIso(ctx);
      if (!accept) {
        ctx.db.prepare("UPDATE invitations SET status = 'declined', responded_at = ? WHERE id = ?").run(now, inv.id);
        audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'invitation.declined', target: `entry:${inv.entry_id}`, details: { source } });
        return;
      }
      const e = getEntry(ctx, inv.entry_id);
      if (!['pending', 'confirmed', 'waitlisted'].includes(e.status)) throw conflict('bad_status', 'That team is no longer registered.');
      if (e.roster_locked) throw conflict('roster_locked', 'That team’s roster is locked.');
      const members = entryMembers(ctx, e.id);
      const starters = members.filter((x) => x.role !== 'substitute').length;
      const subs = members.filter((x) => x.role === 'substitute').length;
      if (inv.role === 'player' && starters >= t.cfg.teamSize) throw conflict('roster_full', 'The team is already full.');
      if (inv.role === 'substitute' && subs >= t.cfg.registration.maxSubstitutes) throw conflict('roster_full', 'The team has no substitute spot left.');
      ctx.db
        .prepare(
          `INSERT INTO entry_members (entry_id, tournament_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(entry_id, user_id) DO UPDATE SET active = 1, role = excluded.role, left_at = NULL, joined_at = excluded.joined_at`,
        )
        .run(e.id, t.id, actorId, inv.role, now);
      ctx.db.prepare("UPDATE invitations SET status = 'accepted', responded_at = ? WHERE id = ?").run(now, inv.id);
      ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'roster.joined', target: `entry:${e.id}`, details: { role: inv.role, source } });
    });
  } catch (err) {
    const msg = uniqueError(err);
    if (msg) throw conflict('already_registered', msg);
    throw err;
  }
  ctx.kick(t.id);
}

export async function revokeInvitation(ctx: AppContext, actorId: string, invitationId: number) {
  const inv = ctx.db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitationId) as { id: number; tournament_id: number; entry_id: number; status: string } | undefined;
  if (!inv) throw notFound('Invitation');
  const e = getEntry(ctx, inv.entry_id);
  const t = loadTournament(ctx, inv.tournament_id);
  if (e.captain_id !== actorId && !(await getAccess(ctx, t, actorId)).canManage) throw forbidden('Only the captain can revoke invitations.');
  if (inv.status !== 'pending') throw conflict('invitation_closed', 'This invitation is no longer pending.');
  ctx.db.prepare("UPDATE invitations SET status = 'revoked', responded_at = ? WHERE id = ?").run(nowIso(ctx), inv.id);
  audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'invitation.revoked', target: `invitation:${inv.id}` });
}

/** Captain removes a member before the roster locks; organizers can always do it (audited). */
export async function removeTeamMember(ctx: AppContext, actorId: string, entryId: number, userId: string, reason: string | null, source: Source) {
  const e = getEntry(ctx, entryId);
  const t = loadTournament(ctx, e.tournament_id);
  const manager = (await getAccess(ctx, t, actorId)).canManage;
  if (e.captain_id !== actorId && !manager) throw forbidden('Only the captain can remove teammates.');
  if (userId === e.captain_id) throw invalid('captain', 'The captain cannot be removed; withdraw the team instead.');
  if (e.roster_locked && !manager) throw conflict('roster_locked', 'Rosters are locked.');
  if (!isPreStart(t.state)) throw conflict('already_started', 'Use a roster correction after the start.');
  tx(ctx, () => {
    const r = ctx.db.prepare('UPDATE entry_members SET active = 0, left_at = ? WHERE entry_id = ? AND user_id = ? AND active = 1').run(nowIso(ctx), e.id, userId);
    if (!r.changes) throw notFound('Team member');
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
    audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'roster.removed', target: `user:${userId}`, details: { entryId: e.id, reason, byOrganizer: manager && e.captain_id !== actorId, source } });
  });
  ctx.kick(t.id);
}

export async function renameTeam(ctx: AppContext, actorId: string, entryId: number, name: string) {
  const e = getEntry(ctx, entryId);
  const t = loadTournament(ctx, e.tournament_id);
  if (e.kind !== 'team') throw invalid('not_team', 'Not a team.');
  if (e.captain_id !== actorId && !(await getAccess(ctx, t, actorId)).canManage) throw forbidden('Only the captain can rename the team.');
  if (!isPreStart(t.state)) throw conflict('already_started', 'Team names are fixed once the tournament starts.');
  const n = name.trim();
  if (n.length < 2 || n.length > 40) throw invalid('bad_name', 'Team names must be 2-40 characters.');
  try {
    ctx.db.prepare('UPDATE entries SET name = ?, updated_at = ? WHERE id = ?').run(n, nowIso(ctx), e.id);
  } catch (err) {
    const msg = uniqueError(err);
    if (msg) throw conflict('name_taken', msg);
    throw err;
  }
  audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'roster.renamed', target: `entry:${e.id}`, details: { from: e.name, to: n } });
}

/** Lock rosters (all active entries). actorId null = automatic (start / registration close). */
export function lockRosters(ctx: AppContext, t: LoadedTournament, actorId: string | null) {
  ctx.db.prepare("UPDATE entries SET roster_locked = 1, updated_at = ? WHERE tournament_id = ? AND status IN ('pending','confirmed','waitlisted')").run(nowIso(ctx), t.id);
  ctx.db.prepare("UPDATE invitations SET status = 'revoked' WHERE tournament_id = ? AND status = 'pending'").run(t.id);
  audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'roster.locked_all' });
}

export async function setRosterLock(ctx: AppContext, actorId: string, tournamentId: number, locked: boolean) {
  const t = loadTournament(ctx, tournamentId);
  await assertManage(ctx, t, actorId);
  if (isStarted(t.state) && !locked) throw conflict('already_started', 'Rosters stay locked after the start.');
  tx(ctx, () => {
    if (locked) lockRosters(ctx, t, actorId);
    else {
      ctx.db.prepare('UPDATE entries SET roster_locked = 0 WHERE tournament_id = ?').run(t.id);
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId, action: 'roster.unlocked_all' });
    }
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(t.id);
  });
}

export function expireInvitations(ctx: AppContext): number {
  return ctx.db.prepare("UPDATE invitations SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(nowIso(ctx)).changes;
}

export function pendingInvitationsFor(ctx: AppContext, userId: string) {
  return ctx.db
    .prepare(
      `SELECT i.id, i.role, i.expires_at, e.name AS team_name, t.id AS tournament_id, t.name AS tournament_name
       FROM invitations i JOIN entries e ON e.id = i.entry_id JOIN tournaments t ON t.id = i.tournament_id
       WHERE i.invitee_id = ? AND i.status = 'pending' AND i.expires_at > ? ORDER BY i.created_at DESC`,
    )
    .all(userId, nowIso(ctx));
}
