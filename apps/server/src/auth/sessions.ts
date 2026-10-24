import type { AppContext } from '../services/context.js';
import { nowIso } from '../services/context.js';
import { addMinutes, randomToken, sha256 } from '../lib/util.js';
import { getUser, type UserRow } from '../services/users.js';

/**
 * Opaque bearer sessions. The browser stores the raw token (localStorage on the GitHub Pages
 * origin); the database stores only its SHA-256. Because the token is sent in an Authorization
 * header and never as a cookie, cross-site requests cannot ride on it (no CSRF surface).
 */
export function createSession(ctx: AppContext, userId: string, userAgent: string | null): string {
  const token = randomToken(32);
  const now = ctx.clock.now();
  ctx.db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(token), userId, now.toISOString(), addMinutes(now, ctx.env.SESSION_TTL_DAYS * 1440).toISOString(), now.toISOString(), userAgent?.slice(0, 200) ?? null);
  return token;
}

export function resolveSession(ctx: AppContext, token: string | null | undefined): UserRow | null {
  if (!token || token.length < 20 || token.length > 200) return null;
  const id = sha256(token);
  const s = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as { user_id: string; expires_at: string; last_seen_at: string } | undefined;
  if (!s) return null;
  const now = ctx.clock.now();
  if (Date.parse(s.expires_at) < now.getTime()) {
    ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  // Sliding expiry, written at most once per hour.
  if (now.getTime() - Date.parse(s.last_seen_at) > 3600_000)
    ctx.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now.toISOString(), addMinutes(now, ctx.env.SESSION_TTL_DAYS * 1440).toISOString(), id);
  return getUser(ctx, s.user_id) ?? null;
}

export function destroySession(ctx: AppContext, token: string) {
  ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
}

/** One-time code handed to the website after OAuth (avoids putting the session token in a URL). */
export function createLoginCode(ctx: AppContext, userId: string): string {
  const code = randomToken(24);
  ctx.db.prepare('INSERT INTO login_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(code), userId, addMinutes(ctx.clock.now(), 2).toISOString());
  return code;
}

export function redeemLoginCode(ctx: AppContext, code: string): string | null {
  const h = sha256(code);
  const row = ctx.db.prepare('SELECT * FROM login_codes WHERE code_hash = ?').get(h) as { user_id: string; expires_at: string; used: number } | undefined;
  if (!row || row.used || Date.parse(row.expires_at) < ctx.clock.now().getTime()) return null;
  const r = ctx.db.prepare('UPDATE login_codes SET used = 1 WHERE code_hash = ? AND used = 0').run(h);
  return r.changes ? row.user_id : null;
}

export function cleanupAuth(ctx: AppContext) {
  const now = nowIso(ctx);
  ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  ctx.db.prepare('DELETE FROM login_codes WHERE expires_at < ?').run(now);
  ctx.db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(addMinutes(ctx.clock.now(), -15).toISOString());
  ctx.db.prepare('DELETE FROM processed_interactions WHERE created_at < ?').run(addMinutes(ctx.clock.now(), -24 * 60).toISOString());
  ctx.db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(addMinutes(ctx.clock.now(), -24 * 60).toISOString());
}
