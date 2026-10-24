import type { AppContext } from './context.js';
import { nowIso } from './context.js';

export interface UserRow {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  dms_enabled: number;
  dm_blocked_until: string | null;
  profile_public: number;
  created_at: string;
  updated_at: string;
}

export function upsertUser(ctx: AppContext, u: { id: string; username: string; globalName?: string | null; avatar?: string | null }): UserRow {
  if (!/^\d{5,25}$/.test(u.id)) throw new Error('Invalid Discord user id.');
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO users (id, username, global_name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username = excluded.username, global_name = COALESCE(excluded.global_name, users.global_name),
         avatar = COALESCE(excluded.avatar, users.avatar), updated_at = excluded.updated_at`,
    )
    .run(u.id, u.username.slice(0, 64), u.globalName?.slice(0, 64) ?? null, u.avatar ?? null, now, now);
  return getUser(ctx, u.id)!;
}

/** Make sure a user row exists for a Discord id we only know from a mention or member lookup. */
export function ensureUser(ctx: AppContext, id: string, username?: string, globalName?: string | null): UserRow {
  const existing = getUser(ctx, id);
  if (existing && !username) return existing;
  return upsertUser(ctx, { id, username: username ?? existing?.username ?? `user-${id.slice(-6)}`, globalName: globalName ?? null });
}

export function getUser(ctx: AppContext, id: string): UserRow | undefined {
  return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export const displayName = (u: Pick<UserRow, 'global_name' | 'username'> | undefined | null, fallback = 'Unknown player') =>
  u ? u.global_name || u.username : fallback;

export function userNames(ctx: AppContext, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 500) {
    const chunk = uniq.slice(i, i + 500);
    const rows = ctx.db.prepare(`SELECT id, username, global_name FROM users WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as UserRow[];
    for (const r of rows) out.set(r.id, displayName(r));
  }
  return out;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: displayName(u),
    avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : null,
  };
}

export function setPreferences(ctx: AppContext, userId: string, prefs: { dmsEnabled?: boolean; profilePublic?: boolean }) {
  if (prefs.dmsEnabled != null)
    ctx.db.prepare('UPDATE users SET dms_enabled = ?, dm_blocked_until = NULL, updated_at = ? WHERE id = ?').run(prefs.dmsEnabled ? 1 : 0, nowIso(ctx), userId);
  if (prefs.profilePublic != null)
    ctx.db.prepare('UPDATE users SET profile_public = ?, updated_at = ? WHERE id = ?').run(prefs.profilePublic ? 1 : 0, nowIso(ctx), userId);
}

export function setMute(ctx: AppContext, userId: string, tournamentId: number, muted: boolean) {
  if (muted)
    ctx.db.prepare('INSERT OR IGNORE INTO tournament_mutes (user_id, tournament_id, created_at) VALUES (?, ?, ?)').run(userId, tournamentId, nowIso(ctx));
  else ctx.db.prepare('DELETE FROM tournament_mutes WHERE user_id = ? AND tournament_id = ?').run(userId, tournamentId);
}

export function listMutes(ctx: AppContext, userId: string): number[] {
  return (ctx.db.prepare('SELECT tournament_id FROM tournament_mutes WHERE user_id = ?').all(userId) as { tournament_id: number }[]).map((r) => r.tournament_id);
}
