import { z } from 'zod';
import { DEFAULT_GUILD_POLICY, forbidden, invalid, notFound, type GuildPolicy, type MemberFacts } from '@rl/core';
import type { AppContext } from './context.js';
import { nowIso } from './context.js';
import { json } from '../lib/util.js';
import { audit } from './audit.js';
import { ensureUser } from './users.js';

export interface GuildRow {
  id: string;
  name: string;
  icon: string | null;
  bot_present: number;
  announcement_channel_id: string | null;
  voice_category_id: string | null;
  policy: string;
  created_at: string;
  updated_at: string;
}

const MEMBER_CACHE_MS = 10 * 60_000;

export const policySchema = z.object({
  tournamentCreation: z.enum(['members', 'admins', 'roles']).default('admins'),
  creatorRoleIds: z.array(z.string().regex(/^\d{5,25}$/)).max(25).default([]),
  presetManagerRoleIds: z.array(z.string().regex(/^\d{5,25}$/)).max(25).default([]),
  serverAdminsManageTournaments: z.boolean().default(false),
  serverAdminsViewPrivate: z.boolean().default(false),
});

export function upsertGuild(ctx: AppContext, g: { id: string; name: string; icon?: string | null; botPresent?: boolean }): GuildRow {
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO guilds (id, name, icon, bot_present, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon,
         bot_present = COALESCE(?, guilds.bot_present), updated_at = excluded.updated_at`,
    )
    .run(g.id, g.name.slice(0, 100), g.icon ?? null, g.botPresent ? 1 : 0, now, now, g.botPresent == null ? null : g.botPresent ? 1 : 0);
  return getGuild(ctx, g.id)!;
}

export function getGuild(ctx: AppContext, id: string): GuildRow | undefined {
  return ctx.db.prepare('SELECT * FROM guilds WHERE id = ?').get(id) as GuildRow | undefined;
}

export function requireGuild(ctx: AppContext, id: string): GuildRow {
  const g = getGuild(ctx, id);
  if (!g) throw notFound('Server');
  return g;
}

export function guildPolicy(g: GuildRow): GuildPolicy {
  const parsed = policySchema.safeParse(json(g.policy, {}));
  return parsed.success ? parsed.data : DEFAULT_GUILD_POLICY;
}

export function recordMembership(
  ctx: AppContext,
  m: { guildId: string; userId: string; isAdmin: boolean; roleIds?: string[] | null; displayName?: string | null; source: 'oauth' | 'bot' | 'interaction' },
) {
  const existing = ctx.db.prepare('SELECT role_ids FROM guild_members WHERE guild_id = ? AND user_id = ?').get(m.guildId, m.userId) as { role_ids: string } | undefined;
  // OAuth's guild list does not include roles; keep roles learnt from the bot.
  const roles = m.roleIds ?? json<string[]>(existing?.role_ids, []);
  ctx.db
    .prepare(
      `INSERT INTO guild_members (guild_id, user_id, is_admin, role_ids, display_name, source, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET is_admin = excluded.is_admin, role_ids = excluded.role_ids,
         display_name = COALESCE(excluded.display_name, guild_members.display_name), source = excluded.source, refreshed_at = excluded.refreshed_at`,
    )
    .run(m.guildId, m.userId, m.isAdmin ? 1 : 0, JSON.stringify(roles), m.displayName ?? null, m.source, nowIso(ctx));
}

/**
 * Server membership facts for authorization. Uses the bot's live view of the member when the bot is
 * in the server (cached 10 minutes), otherwise the snapshot from the user's last Discord login.
 */
export async function memberFacts(ctx: AppContext, guildId: string, userId: string | null, opts: { fresh?: boolean } = {}): Promise<MemberFacts> {
  if (!userId) return { userId: null, isMember: false, isServerAdmin: false, roleIds: [] };
  const g = getGuild(ctx, guildId);
  if (!g) return { userId, isMember: false, isServerAdmin: false, roleIds: [] };
  let row = ctx.db.prepare('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as
    | { is_admin: number; role_ids: string; refreshed_at: string; source: string }
    | undefined;
  // OAuth snapshots carry no roles, so the first check after a login asks the bot for the live member.
  const stale = !row || opts.fresh || row.source === 'oauth' || ctx.clock.now().getTime() - Date.parse(row.refreshed_at) > MEMBER_CACHE_MS;
  if (stale && g.bot_present && ctx.discord.enabled) {
    try {
      const m = await ctx.discord.getMember(guildId, userId);
      if (m) {
        ensureUser(ctx, userId, m.username, m.displayName);
        recordMembership(ctx, { guildId, userId, isAdmin: m.isAdmin, roleIds: m.roleIds, displayName: m.displayName, source: 'bot' });
      } else {
        ctx.db.prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
      }
      row = ctx.db.prepare('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as typeof row;
    } catch (err) {
      ctx.log.warn({ err: String(err), guildId }, 'member refresh failed; using cached membership');
    }
  }
  if (!row) return { userId, isMember: false, isServerAdmin: false, roleIds: [] };
  return { userId, isMember: true, isServerAdmin: !!row.is_admin, roleIds: json<string[]>(row.role_ids, []) };
}

export function guildsForUser(ctx: AppContext, userId: string) {
  return ctx.db
    .prepare(
      `SELECT g.*, gm.is_admin FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id
       WHERE gm.user_id = ? ORDER BY g.name COLLATE NOCASE`,
    )
    .all(userId) as (GuildRow & { is_admin: number })[];
}

export const guildSettingsSchema = z.object({
  announcementChannelId: z.string().regex(/^\d{5,25}$/).nullable().optional(),
  voiceCategoryId: z.string().regex(/^\d{5,25}$/).nullable().optional(),
  policy: policySchema.partial().optional(),
});

export async function updateGuildSettings(ctx: AppContext, actorId: string, guildId: string, input: z.infer<typeof guildSettingsSchema>) {
  const g = requireGuild(ctx, guildId);
  const m = await memberFacts(ctx, guildId, actorId, { fresh: true });
  if (!m.isMember || !m.isServerAdmin) throw forbidden('Only server admins (Manage Server) can change server settings.');
  const policy = { ...guildPolicy(g), ...(input.policy ?? {}) };
  const parsed = policySchema.safeParse(policy);
  if (!parsed.success) throw invalid('bad_policy', 'Invalid permission policy.');
  ctx.db
    .prepare('UPDATE guilds SET announcement_channel_id = ?, voice_category_id = ?, policy = ?, updated_at = ? WHERE id = ?')
    .run(
      input.announcementChannelId === undefined ? g.announcement_channel_id : input.announcementChannelId,
      input.voiceCategoryId === undefined ? g.voice_category_id : input.voiceCategoryId,
      JSON.stringify(parsed.data),
      nowIso(ctx),
      guildId,
    );
  audit(ctx, { guildId, actorId, action: 'guild.settings_updated', details: input as Record<string, unknown> });
  return getGuild(ctx, guildId)!;
}

export function guildDto(g: GuildRow) {
  return {
    id: g.id,
    name: g.name,
    iconUrl: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128` : null,
    botPresent: !!g.bot_present,
    announcementChannelId: g.announcement_channel_id,
    voiceCategoryId: g.voice_category_id,
    policy: guildPolicy(g),
  };
}
