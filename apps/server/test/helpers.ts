import { loadEnv } from '../src/env.js';
import { createLogger } from '../src/lib/logger.js';
import { migrate, openDatabase } from '../src/db/index.js';
import { createContext } from '../src/app.js';
import { buildServer } from '../src/api/server.js';
import { FakeDiscord } from '../src/discord/port.js';
import { upsertGuild } from '../src/services/guilds.js';
import type { FetchLike } from '../src/auth/oauth.js';
import { JobRunner } from '../src/jobs/scheduler.js';

export const GUILD = '100000000000000001';
export const OTHER_GUILD = '100000000000000002';
export const ANNOUNCE = '300000000000000001';

export class TestClock {
  t: number;
  constructor(iso = '2026-11-01T12:00:00.000Z') {
    this.t = Date.parse(iso);
  }
  now() {
    return new Date(this.t);
  }
  advance(minutes: number) {
    this.t += minutes * 60_000;
  }
}

export const uid = (n: number) => `2000000000000${String(n).padStart(5, '0')}`;

export async function setup(opts: { fetchImpl?: FetchLike; env?: Record<string, string> } = {}) {
  const env = loadEnv({
    NODE_ENV: 'test', DEV_LOGIN: 'true', WEB_URL: 'https://web.example', PUBLIC_API_URL: 'https://api.example',
    DISCORD_CLIENT_ID: '555555555555555555', DISCORD_CLIENT_SECRET: 'test-secret', JOB_INTERVAL_SECONDS: '5', DATABASE_PATH: ':memory:', BACKUP_INTERVAL_HOURS: '168', ...opts.env,
  });
  const db = openDatabase(':memory:');
  migrate(db);
  const discord = new FakeDiscord(true);
  const clock = new TestClock();
  const ctx = createContext({ env, db, discord, log: createLogger('silent', false), clock });
  const app = await buildServer(ctx, { fetchImpl: opts.fetchImpl });
  upsertGuild(ctx, { id: GUILD, name: 'RL Hub', botPresent: true });
  upsertGuild(ctx, { id: OTHER_GUILD, name: 'Other Server', botPresent: true });
  discord.channels.set(ANNOUNCE, { id: ANNOUNCE, guildId: GUILD, name: 'tournaments', type: 'text', parentId: null, memberIds: [], organizerIds: [], viewerIds: [] });
  const jobs = new JobRunner(ctx);

  async function call(method: string, url: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.inject({
      method: method as 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = res.json();
    } catch {
      /* not json */
    }
    return { status: res.statusCode, body: json, text: res.body, headers: res.headers };
  }

  /** Log in a user (dev login) and make them a member of the guild (bot view). */
  async function login(n: number, o: { admin?: boolean; guild?: string; roles?: string[]; name?: string } = {}) {
    const guild = o.guild ?? GUILD;
    const name = o.name ?? `player${n}`;
    discord.addMember(guild, { userId: uid(n), username: name, displayName: name, isAdmin: !!o.admin, roleIds: o.roles ?? [] });
    const r = await call('POST', '/auth/dev-login', null, { userId: uid(n), username: name, guildId: guild, admin: !!o.admin });
    if (r.status !== 200) throw new Error(`login failed ${r.status} ${r.text}`);
    const token = r.body.token as string;
    const client = {
      id: uid(n), token,
      get: (u: string) => call('GET', u, token),
      post: (u: string, b: unknown = {}, h?: Record<string, string>) => call('POST', u, token, b, h),
      put: (u: string, b: unknown = {}) => call('PUT', u, token, b),
      patch: (u: string, b: unknown = {}) => call('PATCH', u, token, b),
      del: (u: string, b?: unknown) => call('DELETE', u, token, b),
    };
    return client;
  }

  /** Run side effects (voice reconcile + notification dispatch) to completion. */
  async function settle() {
    await ctx.idle();
    await jobs.tick();
    await ctx.idle();
  }

  return { ctx, app, db, discord, clock, env, call, login, settle, jobs, anon: { get: (u: string) => call('GET', u, null), post: (u: string, b: unknown = {}) => call('POST', u, null, b) } };
}

export type Client = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['login']>>;

export function ok<T extends { status: number; text: string }>(r: T, status = 200): T {
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${r.text}`);
  return r;
}

/** Report and confirm a match result (A reports, a B player confirms). */
export async function play(clients: Map<string, Client>, matchId: number, games: { a: number; b: number }[], admin?: Client) {
  const anyClient = [...clients.values()][0];
  const m = ok(await anyClient.get(`/api/matches/${matchId}`)).body.match;
  const aUser = m.a.players[0].userId as string;
  const bUser = m.b.players[0].userId as string;
  const ca = clients.get(aUser);
  const cb = clients.get(bUser);
  if (!ca || !cb) {
    if (!admin) throw new Error('missing clients');
    return ok(await admin.post(`/api/matches/${matchId}/resolve`, { games }));
  }
  ok(await ca.post(`/api/matches/${matchId}/report`, { games }));
  return ok(await cb.post(`/api/matches/${matchId}/confirm`));
}
