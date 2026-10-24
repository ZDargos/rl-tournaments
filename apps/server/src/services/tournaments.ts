import {
  applyConfigPatch, canCreateTournament, conflict, diffConfig, forbidden, invalid, isStarted, lockedPaths, LOCKED_AFTER_START,
  nextState, notFound, parseConfig, type ConfigInput, type TournamentConfig, type TransitionAction,
} from '@rl/core';
import { ZodError } from 'zod';
import type { AppContext, Source } from './context.js';
import { nowIso, tx } from './context.js';
import { assertManage, loadTournament, type LoadedTournament } from './access.js';
import { audit } from './audit.js';
import { guildPolicy, memberFacts, requireGuild } from './guilds.js';
import { cancelPending, enqueue, scheduleTournamentReminders } from './notifications.js';
import { loadPreset, presetDiff, safeConfig, zodMessage } from './presets.js';
import { ensureUser } from './users.js';
import { startTournament, cancelOpenMatches } from './engine.js';
import { lockRosters } from './registration.js';

/** JSON of the structural (locked-after-start) settings, compared by a database trigger. */
export function structureOf(cfg: TournamentConfig): string {
  const pick: Record<string, unknown> = {};
  for (const path of LOCKED_AFTER_START) {
    const parts = path.split('.');
    let v: unknown = cfg;
    for (const p of parts) v = (v as Record<string, unknown> | undefined)?.[p];
    pick[path] = v ?? null;
  }
  return JSON.stringify(pick);
}

export interface CreateTournamentInput {
  guildId: string;
  name: string;
  description?: string;
  visibility?: 'public' | 'private';
  presetId?: number | null;
  config?: ConfigInput;
  publish?: boolean;
}

export async function createTournament(ctx: AppContext, actorId: string, input: CreateTournamentInput, source: Source): Promise<LoadedTournament> {
  const g = requireGuild(ctx, input.guildId);
  const m = await memberFacts(ctx, g.id, actorId);
  if (!m.isMember) throw forbidden('You must be a member of this Discord server.');
  if (!canCreateTournament(m, guildPolicy(g))) throw forbidden('This server only lets admins (or configured roles) create tournaments.');
  const name = input.name.trim();
  if (name.length < 3 || name.length > 80) throw invalid('bad_name', 'Tournament names must be 3-80 characters.');
  let base: TournamentConfig = parseConfig({});
  let presetVersion: number | null = null;
  if (input.presetId) {
    const p = loadPreset(ctx, input.presetId, g.id); // throws if the preset belongs to another server
    base = parseConfig(JSON.parse(p.config));
    presetVersion = p.version;
  }
  let cfg: TournamentConfig;
  try {
    cfg = input.config ? applyConfigPatch(base, input.config) : base;
  } catch (err) {
    if (err instanceof ZodError) throw invalid('invalid_config', zodMessage(err));
    throw err;
  }
  cfg = safeConfig(cfg);
  const id = tx(ctx, () => {
    const now = nowIso(ctx);
    const r = ctx.db
      .prepare(
        `INSERT INTO tournaments (guild_id, name, description, visibility, state, format, config, structure, preset_id, preset_version, created_by, start_at, timezone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.id, name, (input.description ?? '').slice(0, 4000), input.visibility ?? 'public', input.publish ? 'published' : 'draft', cfg.format,
        JSON.stringify(cfg), structureOf(cfg), input.presetId ?? null, presetVersion, actorId, cfg.schedule.startAt, cfg.schedule.timezone, now, now,
      );
    const tid = Number(r.lastInsertRowid);
    audit(ctx, { guildId: g.id, tournamentId: tid, actorId, action: 'tournament.created', details: { name, format: cfg.format, presetId: input.presetId ?? null, source } });
    scheduleTournamentReminders(ctx, loadTournament(ctx, tid));
    return tid;
  });
  return loadTournament(ctx, id);
}

export interface UpdateTournamentInput {
  name?: string;
  description?: string;
  visibility?: 'public' | 'private';
  configPatch?: unknown;
  expectedVersion?: number;
}

/**
 * Edit a tournament. Structural settings are rejected once it has started (the database trigger is a
 * second, independent guard). Name/description/visibility/notification/voice settings stay editable.
 */
export async function updateTournament(ctx: AppContext, actorId: string, id: number, input: UpdateTournamentInput, source: Source): Promise<LoadedTournament> {
  const t = loadTournament(ctx, id);
  await assertManage(ctx, t, actorId);
  if (input.expectedVersion != null && input.expectedVersion !== t.version)
    throw conflict('stale_version', 'This tournament was changed by someone else. Reload and try again.');
  if (t.state === 'cancelled' || t.state === 'completed') {
    if (input.configPatch) throw conflict('tournament_finished', 'Settings of a finished tournament cannot be changed.');
  }
  let cfg = t.cfg;
  if (input.configPatch) {
    try {
      cfg = applyConfigPatch(t.cfg, input.configPatch);
    } catch (err) {
      if (err instanceof ZodError) throw invalid('invalid_config', zodMessage(err));
      throw err;
    }
    cfg = safeConfig(cfg);
  }
  const changes = diffConfig(t.cfg, cfg);
  if (isStarted(t.state)) {
    const locked = lockedPaths(changes);
    if (locked.length)
      throw conflict('format_locked', `The tournament has started, so its format and competition rules are locked (${locked.join(', ')}).`, { paths: locked });
  }
  const name = input.name?.trim() ?? t.name;
  if (name.length < 3 || name.length > 80) throw invalid('bad_name', 'Tournament names must be 3-80 characters.');
  tx(ctx, () => {
    ctx.db
      .prepare(
        `UPDATE tournaments SET name = ?, description = ?, visibility = ?, format = ?, config = ?, structure = ?, start_at = ?, timezone = ?,
          version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(name, (input.description ?? t.description).slice(0, 4000), input.visibility ?? t.visibility, cfg.format, JSON.stringify(cfg), structureOf(cfg), cfg.schedule.startAt, cfg.schedule.timezone, nowIso(ctx), id);
    if (changes.some((c) => c.path.startsWith('sixmans') || c.path === 'format')) {
      // Pool/schedule proposals were built for the old settings.
      ctx.db.prepare("DELETE FROM sixmans_plans WHERE tournament_id = ? AND kind IN ('schedule','finals')").run(id);
    }
    audit(ctx, {
      guildId: t.guild_id, tournamentId: id, actorId, action: 'tournament.updated',
      details: { source, name: name !== t.name ? name : undefined, visibility: input.visibility, changes: changes.map((c) => ({ path: c.path, before: c.before, after: c.after })) },
    });
    if (changes.some((c) => c.path.startsWith('schedule') || c.path.startsWith('checkIn') || c.path.startsWith('notifications'))) scheduleTournamentReminders(ctx, loadTournament(ctx, id));
  });
  ctx.kick(id);
  return loadTournament(ctx, id);
}

export async function previewPreset(ctx: AppContext, actorId: string, id: number, presetId: number) {
  const t = loadTournament(ctx, id);
  await assertManage(ctx, t, actorId);
  const p = loadPreset(ctx, presetId, t.guild_id);
  const changes = presetDiff(t.cfg, parseConfig(JSON.parse(p.config)));
  return { presetId, presetName: p.name, presetVersion: p.version, changes, blocked: isStarted(t.state) ? lockedPaths(changes) : [] };
}

/** Explicitly apply a (possibly revised) preset to a tournament that has not started yet. */
export async function applyPreset(ctx: AppContext, actorId: string, id: number, presetId: number, source: Source) {
  const t = loadTournament(ctx, id);
  await assertManage(ctx, t, actorId);
  if (isStarted(t.state) || t.state === 'cancelled') throw conflict('format_locked', 'Presets can only be applied before the tournament starts.');
  const p = loadPreset(ctx, presetId, t.guild_id);
  const presetCfg = parseConfig(JSON.parse(p.config));
  const merged = safeConfig({ ...presetCfg, schedule: { ...presetCfg.schedule, startAt: t.cfg.schedule.startAt } });
  const changes = diffConfig(t.cfg, merged);
  tx(ctx, () => {
    ctx.db
      .prepare('UPDATE tournaments SET format = ?, config = ?, structure = ?, timezone = ?, preset_id = ?, preset_version = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(merged.format, JSON.stringify(merged), structureOf(merged), merged.schedule.timezone, p.id, p.version, nowIso(ctx), id);
    ctx.db.prepare("DELETE FROM sixmans_plans WHERE tournament_id = ? AND kind IN ('schedule','finals')").run(id);
    audit(ctx, { guildId: t.guild_id, tournamentId: id, actorId, action: 'tournament.preset_applied', details: { presetId, presetVersion: p.version, source, changes } });
    scheduleTournamentReminders(ctx, loadTournament(ctx, id));
  });
  return loadTournament(ctx, id);
}

/** Validated lifecycle transition. `actorId` null = system (scheduler). */
export async function transition(ctx: AppContext, actorId: string | null, id: number, action: TransitionAction, opts: { reason?: string; source?: Source; fromPoll?: boolean } = {}) {
  const t = loadTournament(ctx, id);
  if (actorId) await assertManage(ctx, t, actorId);
  if (action === 'open_registration' && !opts.fromPoll && ctx.db.prepare("SELECT 1 FROM start_polls WHERE tournament_id = ? AND status = 'open'").get(id))
    throw conflict('start_poll_open', 'Players are still voting on the start time. Registration opens when the vote closes (or close the vote now).');
  if (action === 'start') return startTournament(ctx, actorId, id, { source: opts.source ?? 'web' });
  if (action === 'complete') throw invalid('not_allowed', 'Tournaments complete automatically when the champion is decided.');
  const to = nextState(t.state, action);
  tx(ctx, () => {
    const now = nowIso(ctx);
    const updated = ctx.db
      .prepare(
        `UPDATE tournaments SET state = ?, cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END, version = version + 1, updated_at = ?
         WHERE id = ? AND state = ?`,
      )
      .run(to, to, now, now, id, t.state);
    if (!updated.changes) throw conflict('stale_state', 'The tournament changed state at the same time. Reload and try again.');
    audit(ctx, { guildId: t.guild_id, tournamentId: id, actorId, action: `tournament.${action}`, details: { from: t.state, to, reason: opts.reason, source: opts.source } });
    const fresh = loadTournament(ctx, id);
    if (action === 'open_registration') enqueue(ctx, { tournamentId: id, category: 'registration_open', key: `t${id}:regopen:${now}`, audience: 'participants' });
    if (action === 'close_registration') {
      enqueue(ctx, { tournamentId: id, category: 'registration_close', key: `t${id}:regclose:${now}`, audience: 'participants' });
      if (fresh.cfg.registration.rosterLock === 'on_registration_close') lockRosters(ctx, fresh, null);
    }
    if (action === 'pause') enqueue(ctx, { tournamentId: id, category: 'tournament_start', key: `t${id}:pause:${now}`, audience: 'participants', payload: { event: 'paused' } });
    if (action === 'resume') enqueue(ctx, { tournamentId: id, category: 'tournament_start', key: `t${id}:resume:${now}`, audience: 'participants', payload: { event: 'resumed' } });
    if (action === 'cancel') {
      ctx.db.prepare("UPDATE start_polls SET status = 'cancelled', closed_at = ?, closed_by = ?, updated_at = ? WHERE tournament_id = ? AND status = 'open'").run(now, actorId, now, id);
      cancelOpenMatches(ctx, id);
      cancelPending(ctx, { tournamentId: id });
      ctx.db.prepare("UPDATE invitations SET status = 'revoked' WHERE tournament_id = ? AND status = 'pending'").run(id);
      enqueue(ctx, { tournamentId: id, category: 'tournament_complete', key: `t${id}:cancelled`, audience: 'participants', payload: { reason: opts.reason ?? null } });
    }
    scheduleTournamentReminders(ctx, fresh);
  });
  ctx.kick(id);
  return { tournament: loadTournament(ctx, id), warnings: [] as string[] };
}

export async function addAdmin(ctx: AppContext, actorId: string, id: number, userId: string, source: Source) {
  const t = loadTournament(ctx, id);
  const a = await assertManage(ctx, t, actorId);
  if (!a.isCreator) throw forbidden('Only the tournament creator can change the admin list.');
  if (userId === t.created_by) throw invalid('already_creator', 'The creator already manages this tournament.');
  ensureUser(ctx, userId);
  const m = await memberFacts(ctx, t.guild_id, userId);
  if (!m.isMember) throw invalid('not_member', 'Tournament admins must be members of the Discord server.');
  tx(ctx, () => {
    ctx.db.prepare('INSERT OR IGNORE INTO tournament_admins (tournament_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)').run(id, userId, actorId, nowIso(ctx));
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(id);
    audit(ctx, { guildId: t.guild_id, tournamentId: id, actorId, action: 'tournament.admin_added', target: `user:${userId}`, details: { source } });
  });
  ctx.kick(id);
}

export async function removeAdmin(ctx: AppContext, actorId: string, id: number, userId: string, source: Source) {
  const t = loadTournament(ctx, id);
  const a = await assertManage(ctx, t, actorId);
  if (!a.isCreator && actorId !== userId) throw forbidden('Only the tournament creator can remove other admins.');
  tx(ctx, () => {
    const r = ctx.db.prepare('DELETE FROM tournament_admins WHERE tournament_id = ? AND user_id = ?').run(id, userId);
    if (!r.changes) throw notFound('Admin');
    ctx.db.prepare('UPDATE tournaments SET version = version + 1 WHERE id = ?').run(id);
    audit(ctx, { guildId: t.guild_id, tournamentId: id, actorId, action: 'tournament.admin_removed', target: `user:${userId}`, details: { source } });
  });
  ctx.kick(id);
}

/** Invite a user to view/register for a private tournament. */
export async function inviteViewer(ctx: AppContext, actorId: string, id: number, userId: string, remove = false) {
  const t = loadTournament(ctx, id);
  await assertManage(ctx, t, actorId);
  ensureUser(ctx, userId);
  tx(ctx, () => {
    if (remove) ctx.db.prepare('DELETE FROM tournament_invites WHERE tournament_id = ? AND user_id = ?').run(id, userId);
    else {
      const r = ctx.db.prepare('INSERT OR IGNORE INTO tournament_invites (tournament_id, user_id, invited_by, created_at) VALUES (?, ?, ?, ?)').run(id, userId, actorId, nowIso(ctx));
      if (r.changes)
        enqueue(ctx, {
          tournamentId: id, category: 'personal', key: `t${id}:invite:${userId}`, audience: `user:${userId}`,
          payload: { text: `🎟️ You were invited to the private tournament **${t.name.replace(/[*_`~|]/g, '')}**.` },
        });
    }
    audit(ctx, { guildId: t.guild_id, tournamentId: id, actorId, action: remove ? 'tournament.invite_removed' : 'tournament.invited', target: `user:${userId}` });
  });
  ctx.kick(id);
}

/** Archive hides a finished tournament from discovery; results are never deleted. */
export async function archiveTournament(ctx: AppContext, actorId: string, id: number, archived: boolean) {
  const t = loadTournament(ctx, id);
  const a = await assertManage(ctx, t, actorId);
  if (!a.isCreator) throw forbidden('Only the creator can archive a tournament.');
  if (t.state !== 'completed' && t.state !== 'cancelled' && t.state !== 'draft') throw conflict('not_finished', 'Only drafts and finished tournaments can be archived.');
  tx(ctx, () => {
    ctx.db.prepare('UPDATE tournaments SET archived_at = ?, version = version + 1 WHERE id = ?').run(archived ? nowIso(ctx) : null, id);
    audit(ctx, { guildId: t.guild_id, tournamentId: id, actorId, action: archived ? 'tournament.archived' : 'tournament.unarchived' });
  });
}

/**
 * Deletion policy: only drafts that never opened registration can be deleted outright. Anything
 * that had participants is cancelled/archived instead so history is preserved.
 */
export async function deleteDraft(ctx: AppContext, actorId: string, id: number) {
  const t = loadTournament(ctx, id);
  const a = await assertManage(ctx, t, actorId);
  if (!a.isCreator) throw forbidden('Only the creator can delete a tournament.');
  const hasEntries = ctx.db.prepare('SELECT 1 FROM entries WHERE tournament_id = ? LIMIT 1').get(id);
  if (t.state !== 'draft' || hasEntries) throw conflict('cannot_delete', 'Only drafts without registrations can be deleted. Cancel and archive it instead to keep its history.');
  tx(ctx, () => {
    audit(ctx, { guildId: t.guild_id, tournamentId: null, actorId, action: 'tournament.deleted', target: `tournament:${id}`, details: { name: t.name } });
    ctx.db.prepare('DELETE FROM tournaments WHERE id = ?').run(id);
  });
}
