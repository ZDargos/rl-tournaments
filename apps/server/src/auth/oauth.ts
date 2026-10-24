import { DomainError } from '@rl/core';
import type { AppContext } from '../services/context.js';
import { nowIso } from '../services/context.js';
import { randomToken } from '../lib/util.js';
import { upsertUser } from '../services/users.js';
import { recordMembership } from '../services/guilds.js';
import { createLoginCode } from './sessions.js';

/**
 * Discord OAuth2 authorization-code flow (server side). Scopes: `identify` (who you are) and
 * `guilds` (which servers you are in, to enforce server membership). The Discord access token is
 * used once during the callback and never stored.
 */
export const OAUTH_SCOPES = ['identify', 'guilds'];
const DISCORD = 'https://discord.com/api/v10';
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function redirectUri(ctx: AppContext) {
  return `${ctx.env.PUBLIC_API_URL}/auth/discord/callback`;
}

/** Only allow returning to paths inside the website. */
export function safeReturnTo(path: unknown): string {
  return typeof path === 'string' && /^\/[A-Za-z0-9/_\-?=&.%]*$/.test(path) && !path.startsWith('//') ? path.slice(0, 200) : '/';
}

export function authorizeUrl(ctx: AppContext, returnTo: string): string {
  const state = randomToken(24);
  ctx.db.prepare('INSERT INTO oauth_states (state, return_to, created_at) VALUES (?, ?, ?)').run(state, safeReturnTo(returnTo), nowIso(ctx));
  const p = new URLSearchParams({ client_id: ctx.env.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(ctx), scope: OAUTH_SCOPES.join(' '), state, prompt: 'none' });
  return `https://discord.com/oauth2/authorize?${p}`;
}

export function webRedirect(ctx: AppContext, params: Record<string, string>) {
  return `${ctx.env.WEB_URL}/#/auth/complete?${new URLSearchParams(params)}`;
}

export async function handleCallback(ctx: AppContext, query: { code?: string; state?: string; error?: string }, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string> {
  const stateRow = query.state ? (ctx.db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(query.state) as { return_to: string; created_at: string } | undefined) : undefined;
  if (query.state) ctx.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(query.state);
  if (query.error) return webRedirect(ctx, { error: query.error === 'access_denied' ? 'cancelled' : 'failed' });
  if (!stateRow || ctx.clock.now().getTime() - Date.parse(stateRow.created_at) > 10 * 60_000) return webRedirect(ctx, { error: 'expired' });
  if (!query.code) return webRedirect(ctx, { error: 'failed' });
  try {
    const tokenRes = await fetchImpl(`${DISCORD}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: ctx.env.DISCORD_CLIENT_ID, client_secret: ctx.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri(ctx) }).toString(),
    });
    if (!tokenRes.ok) throw new DomainError('oauth_failed', `Token exchange failed (${tokenRes.status}).`, 502);
    const token = (await tokenRes.json()) as { access_token: string; token_type: string };
    const auth = { Authorization: `Bearer ${token.access_token}` };
    const meRes = await fetchImpl(`${DISCORD}/users/@me`, { headers: auth });
    if (!meRes.ok) throw new DomainError('oauth_failed', 'Could not read your Discord profile.', 502);
    const me = (await meRes.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };
    const guildsRes = await fetchImpl(`${DISCORD}/users/@me/guilds`, { headers: auth });
    const guilds = guildsRes.ok ? ((await guildsRes.json()) as { id: string; name: string; permissions: string }[]) : [];
    const user = upsertUser(ctx, { id: me.id, username: me.username, globalName: me.global_name ?? null, avatar: me.avatar ?? null });
    // Only remember memberships for servers where the bot is installed.
    const known = new Set((ctx.db.prepare('SELECT id FROM guilds').all() as { id: string }[]).map((g) => g.id));
    const inGuilds = new Set<string>();
    for (const g of guilds) {
      if (!known.has(g.id)) continue;
      inGuilds.add(g.id);
      const perms = BigInt(g.permissions ?? '0');
      recordMembership(ctx, { guildId: g.id, userId: user.id, isAdmin: (perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_GUILD) !== 0n, source: 'oauth' });
    }
    if (guildsRes.ok) {
      // Remove stale memberships the user no longer has (OAuth is authoritative at login).
      for (const r of ctx.db.prepare('SELECT guild_id FROM guild_members WHERE user_id = ?').all(user.id) as { guild_id: string }[])
        if (!inGuilds.has(r.guild_id)) ctx.db.prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?').run(r.guild_id, user.id);
    }
    const code = createLoginCode(ctx, user.id);
    return webRedirect(ctx, { code, returnTo: stateRow.return_to ?? '/' });
  } catch (err) {
    ctx.log.warn({ err: String(err) }, 'oauth callback failed');
    return webRedirect(ctx, { error: 'failed' });
  }
}
