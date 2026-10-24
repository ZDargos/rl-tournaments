import { canManagePresets, canViewPresets, conflict, diffConfig, forbidden, invalid, notFound, parseConfig, validateConfig, type TournamentConfig } from '@rl/core';
import { ZodError } from 'zod';
import type { AppContext } from './context.js';
import { nowIso, tx } from './context.js';
import { audit } from './audit.js';
import { guildPolicy, memberFacts, requireGuild } from './guilds.js';

export interface PresetRow {
  id: number;
  guild_id: string;
  name: string;
  description: string;
  config: string;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function zodMessage(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ');
}

export function safeConfig(input: unknown): TournamentConfig {
  try {
    const cfg = parseConfig(input);
    const problems = validateConfig(cfg);
    if (problems.length) throw invalid('invalid_config', problems.join(' '), { problems });
    return cfg;
  } catch (err) {
    if (err instanceof ZodError) throw invalid('invalid_config', zodMessage(err));
    throw err;
  }
}

async function assertPresetManager(ctx: AppContext, guildId: string, actorId: string) {
  const g = requireGuild(ctx, guildId);
  const m = await memberFacts(ctx, guildId, actorId);
  if (!canManagePresets(m, guildPolicy(g))) throw forbidden('Only server admins and preset managers can manage presets for this server.');
}

export function presetDto(p: PresetRow) {
  return { id: p.id, guildId: p.guild_id, name: p.name, description: p.description, config: parseConfig(JSON.parse(p.config)), version: p.version, createdBy: p.created_by, updatedAt: p.updated_at };
}

export async function listPresets(ctx: AppContext, guildId: string, actorId: string | null) {
  requireGuild(ctx, guildId);
  const m = await memberFacts(ctx, guildId, actorId);
  if (!canViewPresets(m)) throw forbidden('Join this Discord server to see its presets.');
  return (ctx.db.prepare('SELECT * FROM presets WHERE guild_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE').all(guildId) as PresetRow[]).map(presetDto);
}

/** Load a preset, enforcing that it belongs to the expected server (server isolation). */
export function loadPreset(ctx: AppContext, id: number, guildId: string): PresetRow {
  const p = ctx.db.prepare('SELECT * FROM presets WHERE id = ? AND deleted_at IS NULL').get(id) as PresetRow | undefined;
  if (!p || p.guild_id !== guildId) throw notFound('Preset');
  return p;
}

export async function getPreset(ctx: AppContext, id: number, actorId: string | null) {
  const p = ctx.db.prepare('SELECT * FROM presets WHERE id = ? AND deleted_at IS NULL').get(id) as PresetRow | undefined;
  if (!p) throw notFound('Preset');
  const m = await memberFacts(ctx, p.guild_id, actorId);
  if (!canViewPresets(m)) throw notFound('Preset');
  return presetDto(p);
}

function uniqueViolation(err: unknown) {
  return err instanceof Error && /UNIQUE constraint failed: index 'presets_name'|presets_name|UNIQUE constraint failed: presets/.test(err.message);
}

export async function createPreset(ctx: AppContext, actorId: string, input: { guildId: string; name: string; description?: string; config: unknown }) {
  await assertPresetManager(ctx, input.guildId, actorId);
  const name = input.name.trim();
  if (!name || name.length > 60) throw invalid('bad_name', 'Preset names must be 1-60 characters.');
  const cfg = safeConfig(input.config);
  try {
    const id = tx(ctx, () => {
      const now = nowIso(ctx);
      const r = ctx.db
        .prepare('INSERT INTO presets (guild_id, name, description, config, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.guildId, name, (input.description ?? '').slice(0, 500), JSON.stringify(cfg), actorId, now, now);
      audit(ctx, { guildId: input.guildId, actorId, action: 'preset.created', target: `preset:${r.lastInsertRowid}`, details: { name } });
      return Number(r.lastInsertRowid);
    });
    return presetDto(loadPreset(ctx, id, input.guildId));
  } catch (err) {
    if (uniqueViolation(err)) throw conflict('preset_name_taken', `A preset named "${name}" already exists on this server.`);
    throw err;
  }
}

export async function updatePreset(ctx: AppContext, actorId: string, id: number, input: { name?: string; description?: string; config?: unknown }) {
  const existing = ctx.db.prepare('SELECT * FROM presets WHERE id = ? AND deleted_at IS NULL').get(id) as PresetRow | undefined;
  if (!existing) throw notFound('Preset');
  await assertPresetManager(ctx, existing.guild_id, actorId);
  const name = input.name?.trim() ?? existing.name;
  if (!name || name.length > 60) throw invalid('bad_name', 'Preset names must be 1-60 characters.');
  const cfg = input.config !== undefined ? safeConfig(input.config) : parseConfig(JSON.parse(existing.config));
  const configChanged = JSON.stringify(cfg) !== JSON.stringify(parseConfig(JSON.parse(existing.config)));
  try {
    tx(ctx, () => {
      ctx.db
        .prepare('UPDATE presets SET name = ?, description = ?, config = ?, version = version + ?, updated_at = ? WHERE id = ?')
        .run(name, (input.description ?? existing.description).slice(0, 500), JSON.stringify(cfg), configChanged ? 1 : 0, nowIso(ctx), id);
      audit(ctx, { guildId: existing.guild_id, actorId, action: 'preset.updated', target: `preset:${id}`, details: { name, configChanged } });
    });
  } catch (err) {
    if (uniqueViolation(err)) throw conflict('preset_name_taken', `A preset named "${name}" already exists on this server.`);
    throw err;
  }
  return presetDto(loadPreset(ctx, id, existing.guild_id));
}

export async function duplicatePreset(ctx: AppContext, actorId: string, id: number, newName?: string) {
  const p = ctx.db.prepare('SELECT * FROM presets WHERE id = ? AND deleted_at IS NULL').get(id) as PresetRow | undefined;
  if (!p) throw notFound('Preset');
  let name = newName?.trim() || `${p.name} (copy)`;
  for (let i = 2; !newName && ctx.db.prepare('SELECT 1 FROM presets WHERE guild_id = ? AND lower(name) = lower(?) AND deleted_at IS NULL').get(p.guild_id, name); i++)
    name = `${p.name} (copy ${i})`;
  return createPreset(ctx, actorId, { guildId: p.guild_id, name: name.slice(0, 60), description: p.description, config: JSON.parse(p.config) });
}

/** Soft delete: tournaments created from it keep their own snapshot. */
export async function deletePreset(ctx: AppContext, actorId: string, id: number) {
  const p = ctx.db.prepare('SELECT * FROM presets WHERE id = ? AND deleted_at IS NULL').get(id) as PresetRow | undefined;
  if (!p) throw notFound('Preset');
  await assertPresetManager(ctx, p.guild_id, actorId);
  tx(ctx, () => {
    ctx.db.prepare('UPDATE presets SET deleted_at = ? WHERE id = ?').run(nowIso(ctx), id);
    audit(ctx, { guildId: p.guild_id, actorId, action: 'preset.deleted', target: `preset:${id}`, details: { name: p.name } });
  });
}

/** Settings that would change if `preset` were applied to a tournament's config. */
export function presetDiff(current: TournamentConfig, preset: TournamentConfig) {
  // Scheduling details (start time) belong to the tournament, not the preset.
  const merged = { ...preset, schedule: { ...preset.schedule, startAt: current.schedule.startAt } };
  return diffConfig(current, merged);
}
