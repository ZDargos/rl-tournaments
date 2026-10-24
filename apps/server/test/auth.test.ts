import { describe, expect, it } from 'vitest';
import { GUILD, ok, setup, uid } from './helpers.js';
import type { FetchLike } from '../src/auth/oauth.js';

const ACCESS = 'discord-access-token-should-never-be-stored';

function fakeDiscordOAuth(guildPerms = '32'): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith('/oauth2/token')) {
      expect(init?.body).toContain('client_secret=test-secret');
      return init?.body?.includes('code=good') ? res({ access_token: ACCESS, token_type: 'Bearer' }) : res({ error: 'invalid_grant' }, 400);
    }
    expect(init?.headers?.Authorization).toBe(`Bearer ${ACCESS}`);
    if (url.endsWith('/users/@me')) return res({ id: uid(1), username: 'kaydop', global_name: 'Kaydop', avatar: null });
    if (url.endsWith('/users/@me/guilds')) return res([{ id: GUILD, name: 'RL Hub', permissions: guildPerms }, { id: '999999999999999999', name: 'Unrelated', permissions: '0' }]);
    return res({}, 404);
  };
  return { fetch, calls };
}

describe('Discord OAuth', () => {
  it('logs in through the full code flow and never stores the Discord token', async () => {
    const d = fakeDiscordOAuth();
    const s = await setup({ fetchImpl: d.fetch });
    s.discord.addMember(GUILD, { userId: uid(1), username: 'kaydop', isAdmin: true });
    const start = await s.call('GET', '/auth/discord/login?returnTo=/t/5');
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.origin).toBe('https://discord.com');
    expect(loc.searchParams.get('scope')).toBe('identify guilds');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://api.example/auth/discord/callback');
    const state = loc.searchParams.get('state')!;

    const cb = await s.call('GET', `/auth/discord/callback?code=good&state=${state}`);
    expect(cb.status).toBe(302);
    const back = new URL((cb.headers.location as string).replace('#/', ''));
    expect(back.origin).toBe('https://web.example');
    expect(back.searchParams.get('returnTo')).toBe('/t/5');
    const code = back.searchParams.get('code')!;

    const ex = ok(await s.call('POST', '/auth/exchange', null, { code }));
    expect(ex.body.user.username).toBe('kaydop');
    const me = ok(await s.call('GET', '/api/me', ex.body.token));
    expect(me.body.user.id).toBe(uid(1));
    // Membership recorded only for servers the bot knows; Manage Server (32) => admin.
    const guilds = ok(await s.call('GET', '/api/me/guilds', ex.body.token)).body;
    expect(guilds.map((g: { id: string }) => g.id)).toEqual([GUILD]);
    expect(guilds[0].isAdmin).toBe(true);

    // Codes are single use; the Discord token and our session token are not stored in plain text.
    expect((await s.call('POST', '/auth/exchange', null, { code })).status).toBe(401);
    const dump = JSON.stringify(s.db.prepare("SELECT * FROM sessions").all()) + JSON.stringify(s.db.prepare('SELECT * FROM users').all());
    expect(dump).not.toContain(ACCESS);
    expect(dump).not.toContain(ex.body.token);

    ok(await s.call('POST', '/auth/logout', ex.body.token));
    expect((await s.call('GET', '/api/me', ex.body.token)).status).toBe(401);
  });

  it('rejects unknown or replayed state and reports cancel/failure', async () => {
    const d = fakeDiscordOAuth();
    const s = await setup({ fetchImpl: d.fetch });
    const bad = await s.call('GET', '/auth/discord/callback?code=good&state=forged');
    expect(bad.headers.location).toContain('error=expired');
    expect(d.calls).toEqual([]);
    const cancelled = await s.call('GET', '/auth/discord/callback?error=access_denied');
    expect(cancelled.headers.location).toContain('error=cancelled');
    const state = new URL((await s.call('GET', '/auth/discord/login')).headers.location as string).searchParams.get('state');
    const failed = await s.call('GET', `/auth/discord/callback?code=bad&state=${state}`);
    expect(failed.headers.location).toContain('error=failed');
    const replay = await s.call('GET', `/auth/discord/callback?code=good&state=${state}`);
    expect(replay.headers.location).toContain('error=expired');
  });

  it('refuses dev login in production and requires auth for private endpoints', async () => {
    await expect(setup({ env: { NODE_ENV: 'production' } })).rejects.toThrow(/DEV_LOGIN/);
    const s = await setup({ env: { DEV_LOGIN: 'false' } });
    expect((await s.call('POST', '/auth/dev-login', null, { userId: uid(1), username: 'x' })).status).toBe(404);
    expect((await s.call('GET', '/api/me')).status).toBe(401);
    expect((await s.call('POST', '/api/tournaments', null, { guildId: GUILD, name: 'x' })).status).toBe(401);
  });

  it('only allows CORS from the website origin', async () => {
    const s = await setup({ env: { NODE_ENV: 'production', DEV_LOGIN: 'false' } });
    const good = await s.app.inject({ method: 'OPTIONS', url: '/api/meta', headers: { origin: 'https://web.example', 'access-control-request-method': 'GET' } });
    expect(good.headers['access-control-allow-origin']).toBe('https://web.example');
    const evil = await s.app.inject({ method: 'OPTIONS', url: '/api/meta', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
