import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { DomainError, FORMATS, NOTIFICATION_CATEGORIES, RANKS, STATES, type TransitionAction } from '@rl/core';
import type { AppContext } from '../services/context.js';
import { oauthConfigured } from '../env.js';
import { authorizeUrl, handleCallback, OAUTH_SCOPES, type FetchLike } from '../auth/oauth.js';
import { createSession, destroySession, redeemLoginCode, resolveSession } from '../auth/sessions.js';
import type { UserRow } from '../services/users.js';
import { ensureUser, listMutes, publicUser, setMute, setPreferences, upsertUser } from '../services/users.js';
import { getGuild, guildDto, guildPolicy, guildsForUser, guildSettingsSchema, memberFacts, recordMembership, updateGuildSettings, upsertGuild } from '../services/guilds.js';
import { canCreateTournament, canManagePresets } from '@rl/core';
import { createPreset, deletePreset, duplicatePreset, getPreset, listPresets, updatePreset } from '../services/presets.js';
import {
  addAdmin, applyPreset, archiveTournament, createTournament, deleteDraft, inviteViewer, previewPreset, removeAdmin, transition, updateTournament,
} from '../services/tournaments.js';
import {
  adminAddPlayer, adminEntryAction, checkIn, inviteToTeam, pendingInvitationsFor, register, removeTeamMember, renameTeam, respondInvitation,
  revokeInvitation, setEntrySkill, setOwnRank, setRosterLock, withdraw,
} from '../services/registration.js';
import { abandonMatch, adminResolve, confirmResult, disputeResult, replacePlayer, reportProgress, reportResult, swapCompetitors } from '../services/results.js';
import {
  confirmPools, confirmSchedule, editFinalsTeams, editPools, generateSchedule, makePoolsProposal, previewFinals, startFinals, swapScheduledPlayers,
} from '../services/sixmans.js';
import { listTournaments, matchDetail, tournamentDetail } from '../services/views.js';
import { playerProfile, searchPlayers } from '../services/stats.js';
import { EXPORT_KINDS, exportCsv, type ExportKind } from '../services/exports.js';
import { repairVoice } from '../services/voice.js';
import { listAudit } from '../services/audit.js';
import { loadTournament, assertManage, assertView } from '../services/access.js';
import { nowIso } from '../services/context.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    token: string | null;
  }
}

const id = z.coerce.number().int().positive();
const snowflake = z.string().regex(/^\d{5,25}$/);
const games = z.array(z.object({ a: z.number().int().min(0).max(99), b: z.number().int().min(0).max(99) })).max(7);
const resultBody = z.object({ games: games.nullish(), winsA: z.number().int().min(0).max(4).nullish(), winsB: z.number().int().min(0).max(4).nullish() });

function requireUser(req: FastifyRequest): UserRow {
  if (!req.user) throw new DomainError('unauthenticated', 'Please log in with Discord.', 401);
  return req.user;
}

export interface ServerOptions {
  fetchImpl?: FetchLike;
}

export async function buildServer(ctx: AppContext, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: ctx.env.TRUST_PROXY, bodyLimit: 256 * 1024 });
  // Browsers send only the origin (scheme + host), never the GitHub Pages path in WEB_URL.
  const origins = [new URL(ctx.env.WEB_URL).origin, ...(ctx.env.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173'] : [])];
  await app.register(cors, { origin: origins, credentials: false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], maxAge: 600 });
  await app.register(rateLimit, {
    max: ctx.env.NODE_ENV === 'test' ? 100000 : 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`),
    errorResponseBuilder: () => ({ error: { code: 'rate_limited', message: 'Too many requests. Slow down a little.' } }),
  });

  app.decorateRequest('user', null);
  app.decorateRequest('token', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      req.token = h.slice(7).trim();
      req.user = resolveSession(ctx, req.token);
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Idempotency for unsafe requests: retries with the same key replay the first response.
  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (req.method === 'GET' || !key || !req.user || typeof key !== 'string' || key.length > 100) return;
    const row = ctx.db.prepare('SELECT response, status FROM idempotency_keys WHERE key = ? AND user_id = ?').get(`${req.user.id}:${key}`, req.user.id) as { response: string; status: number } | undefined;
    if (row) return reply.code(row.status).header('Idempotent-Replay', 'true').type('application/json').send(row.response);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const key = req.headers['idempotency-key'];
    if (req.method !== 'GET' && key && req.user && typeof key === 'string' && key.length <= 100 && !reply.getHeader('Idempotent-Replay') && typeof payload === 'string' && reply.statusCode < 500)
      ctx.db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, user_id, response, status, created_at) VALUES (?, ?, ?, ?, ?)').run(`${req.user.id}:${key}`, req.user.id, payload, reply.statusCode, nowIso(ctx));
    return payload;
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof DomainError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'invalid_input', message: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') } });
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests.' } });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message ?? 'Bad request.' } });
    if (e.message?.includes('FORMAT_LOCKED')) return reply.code(409).send({ error: { code: 'format_locked', message: 'The tournament has started; its format is locked.' } });
    if (e.message?.includes('COMPLETED_MATCH_IMMUTABLE')) return reply.code(409).send({ error: { code: 'completed_match', message: 'Completed results can only change through an organizer correction.' } });
    if (e.message?.includes('TOURNAMENT_FINISHED')) return reply.code(409).send({ error: { code: 'tournament_finished', message: 'This tournament is finished.' } });
    if (e.message?.includes('UNIQUE constraint failed')) return reply.code(409).send({ error: { code: 'duplicate', message: 'That already exists (duplicate request or entry).' } });
    if (e.message?.includes('Match not found')) return reply.code(404).send({ error: { code: 'not_found', message: 'Match not found.' } });
    ctx.log.error({ err: String(err), stack: (err as Error)?.stack, url: req.url }, 'unhandled API error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on our side. It has been logged.' } });
  });

  const src = 'web' as const;

  // ---------------- health & meta ----------------
  app.get('/health', async () => {
    const db = ctx.db.prepare('SELECT 1 ok').get() as { ok: number };
    const lastJobs = ctx.db.prepare("SELECT last_run_at FROM job_state WHERE name = 'tick'").get() as { last_run_at: string } | undefined;
    return { ok: db.ok === 1, time: nowIso(ctx), discord: ctx.discord.enabled, lastJobRun: lastJobs?.last_run_at ?? null };
  });
  app.get('/api/meta', async () => ({
    formats: FORMATS, states: STATES, ranks: RANKS, notificationCategories: NOTIFICATION_CATEGORIES, oauthScopes: OAUTH_SCOPES,
    oauthConfigured: oauthConfigured(ctx.env), devLogin: ctx.env.DEV_LOGIN && ctx.env.NODE_ENV !== 'production', discordEnabled: ctx.discord.enabled,
    botInviteUrl: ctx.env.DISCORD_CLIENT_ID ? `https://discord.com/oauth2/authorize?client_id=${ctx.env.DISCORD_CLIENT_ID}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}` : null,
  }));

  // ---------------- auth ----------------
  app.get('/auth/discord/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!oauthConfigured(ctx.env)) throw new DomainError('oauth_not_configured', 'Discord login is not configured on this server.', 503);
    const q = req.query as { returnTo?: string };
    return reply.redirect(authorizeUrl(ctx, q.returnTo ?? '/'));
  });
  app.get('/auth/discord/callback', async (req, reply) => reply.redirect(await handleCallback(ctx, req.query as Record<string, string>, opts.fetchImpl)));
  app.post('/auth/exchange', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { code } = z.object({ code: z.string().min(10).max(100) }).parse(req.body);
    const userId = redeemLoginCode(ctx, code);
    if (!userId) throw new DomainError('invalid_code', 'This login link has expired. Please log in again.', 401);
    const token = createSession(ctx, userId, (req.headers['user-agent'] as string) ?? null);
    return { token, user: publicUser(ensureUser(ctx, userId)) };
  });
  app.post('/auth/dev-login', async (req) => {
    if (!ctx.env.DEV_LOGIN || ctx.env.NODE_ENV === 'production') throw new DomainError('not_found', 'Not found.', 404);
    const b = z.object({ userId: snowflake, username: z.string().min(1).max(32), guildId: snowflake.optional(), guildName: z.string().max(100).optional(), admin: z.boolean().optional() }).parse(req.body);
    const u = upsertUser(ctx, { id: b.userId, username: b.username });
    if (b.guildId) {
      if (!getGuild(ctx, b.guildId)) upsertGuild(ctx, { id: b.guildId, name: b.guildName ?? 'Dev Server', botPresent: false });
      recordMembership(ctx, { guildId: b.guildId, userId: u.id, isAdmin: !!b.admin, source: 'oauth' });
    }
    return { token: createSession(ctx, u.id, 'dev-login'), user: publicUser(u) };
  });
  app.post('/auth/logout', async (req) => {
    if (req.token) destroySession(ctx, req.token);
    return { ok: true };
  });

  // ---------------- me ----------------
  app.get('/api/me', async (req) => {
    const u = requireUser(req);
    return {
      user: publicUser(u), preferences: { dmsEnabled: !!u.dms_enabled, profilePublic: !!u.profile_public, dmBlockedUntil: u.dm_blocked_until },
      mutes: listMutes(ctx, u.id), invitations: pendingInvitationsFor(ctx, u.id),
    };
  });
  app.patch('/api/me/preferences', async (req) => {
    const u = requireUser(req);
    setPreferences(ctx, u.id, z.object({ dmsEnabled: z.boolean().optional(), profilePublic: z.boolean().optional() }).parse(req.body));
    return { ok: true };
  });
  app.put('/api/me/mutes/:tid', async (req) => {
    const u = requireUser(req);
    const tid = id.parse((req.params as { tid: string }).tid);
    await assertView(ctx, loadTournament(ctx, tid), u.id);
    setMute(ctx, u.id, tid, true);
    return { ok: true };
  });
  app.delete('/api/me/mutes/:tid', async (req) => {
    const u = requireUser(req);
    setMute(ctx, u.id, id.parse((req.params as { tid: string }).tid), false);
    return { ok: true };
  });
  app.get('/api/me/guilds', async (req) => {
    const u = requireUser(req);
    const out = [];
    for (const g of guildsForUser(ctx, u.id)) {
      const m = await memberFacts(ctx, g.id, u.id);
      if (!m.isMember) continue;
      const p = guildPolicy(g);
      out.push({ ...guildDto(g), isAdmin: m.isServerAdmin, canCreate: canCreateTournament(m, p), canManagePresets: canManagePresets(m, p) });
    }
    return out;
  });

  // ---------------- guilds ----------------
  app.get('/api/guilds/:gid', async (req) => {
    const u = requireUser(req);
    const gid = snowflake.parse((req.params as { gid: string }).gid);
    const g = getGuild(ctx, gid);
    const m = await memberFacts(ctx, gid, u.id);
    if (!g || !m.isMember) throw new DomainError('not_found', 'Server not found (or you are not a member).', 404);
    const p = guildPolicy(g);
    return { ...guildDto(g), isAdmin: m.isServerAdmin, canCreate: canCreateTournament(m, p), canManagePresets: canManagePresets(m, p) };
  });
  app.patch('/api/guilds/:gid/settings', async (req) => {
    const u = requireUser(req);
    const gid = snowflake.parse((req.params as { gid: string }).gid);
    return guildDto(await updateGuildSettings(ctx, u.id, gid, guildSettingsSchema.parse(req.body)));
  });
  app.get('/api/guilds/:gid/channels', async (req) => {
    const u = requireUser(req);
    const gid = snowflake.parse((req.params as { gid: string }).gid);
    const m = await memberFacts(ctx, gid, u.id);
    if (!m.isMember) throw new DomainError('not_found', 'Server not found.', 404);
    if (!ctx.discord.enabled || !getGuild(ctx, gid)?.bot_present) return [];
    return (await ctx.discord.listChannels(gid)).filter((c) => c.type !== 'other');
  });
  app.get('/api/guilds/:gid/members', async (req) => {
    const u = requireUser(req);
    const gid = snowflake.parse((req.params as { gid: string }).gid);
    const q = z.string().min(1).max(32).parse((req.query as { q?: string }).q);
    if (!(await memberFacts(ctx, gid, u.id)).isMember) throw new DomainError('not_found', 'Server not found.', 404);
    const local = ctx.db
      .prepare(`SELECT u.id, u.username, u.global_name FROM guild_members gm JOIN users u ON u.id = gm.user_id WHERE gm.guild_id = ? AND (u.username LIKE ? OR u.global_name LIKE ? OR gm.display_name LIKE ?) LIMIT 15`)
      .all(gid, `%${q}%`, `%${q}%`, `%${q}%`) as { id: string; username: string; global_name: string | null }[];
    const results = new Map(local.map((r) => [r.id, { id: r.id, username: r.username, displayName: r.global_name ?? r.username }]));
    if (ctx.discord.enabled && getGuild(ctx, gid)?.bot_present) {
      try {
        for (const m of await ctx.discord.searchMembers(gid, q)) {
          ensureUser(ctx, m.userId, m.username, m.displayName);
          results.set(m.userId, { id: m.userId, username: m.username, displayName: m.displayName });
        }
      } catch (err) {
        ctx.log.info({ err: String(err) }, 'member search via bot failed');
      }
    }
    return [...results.values()].slice(0, 20);
  });

  // ---------------- presets ----------------
  app.get('/api/guilds/:gid/presets', async (req) => listPresets(ctx, snowflake.parse((req.params as { gid: string }).gid), requireUser(req).id));
  app.post('/api/guilds/:gid/presets', async (req) => {
    const b = z.object({ name: z.string(), description: z.string().max(500).optional(), config: z.unknown() }).parse(req.body);
    return createPreset(ctx, requireUser(req).id, { guildId: snowflake.parse((req.params as { gid: string }).gid), ...b });
  });
  app.get('/api/presets/:id', async (req) => getPreset(ctx, id.parse((req.params as { id: string }).id), requireUser(req).id));
  app.patch('/api/presets/:id', async (req) => {
    const b = z.object({ name: z.string().optional(), description: z.string().max(500).optional(), config: z.unknown().optional() }).parse(req.body);
    return updatePreset(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), b);
  });
  app.post('/api/presets/:id/duplicate', async (req) => duplicatePreset(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), z.object({ name: z.string().optional() }).parse(req.body ?? {}).name));
  app.delete('/api/presets/:id', async (req) => {
    await deletePreset(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id));
    return { ok: true };
  });

  // ---------------- tournaments ----------------
  app.get('/api/tournaments', async (req) => {
    const q = z.object({ guildId: snowflake.optional(), state: z.string().max(30).optional(), q: z.string().max(60).optional(), mine: z.coerce.boolean().optional(), archived: z.coerce.boolean().optional() }).parse(req.query);
    return listTournaments(ctx, req.user?.id ?? null, { ...q, includeArchived: q.archived });
  });
  app.post('/api/tournaments', async (req) => {
    const b = z.object({
      guildId: snowflake, name: z.string(), description: z.string().max(4000).optional(), visibility: z.enum(['public', 'private']).optional(),
      presetId: z.number().int().positive().nullish(), config: z.record(z.string(), z.unknown()).optional(), publish: z.boolean().optional(),
    }).parse(req.body);
    const t = await createTournament(ctx, requireUser(req).id, b, src);
    return { id: t.id };
  });
  app.get('/api/tournaments/:id', async (req) => tournamentDetail(ctx, id.parse((req.params as { id: string }).id), req.user?.id ?? null));
  app.get('/api/tournaments/:id/version', async (req) => {
    const t = loadTournament(ctx, id.parse((req.params as { id: string }).id));
    await assertView(ctx, t, req.user?.id ?? null);
    return { version: t.version, state: t.state, stage: t.stage };
  });
  app.patch('/api/tournaments/:id', async (req) => {
    const b = z.object({ name: z.string().optional(), description: z.string().max(4000).optional(), visibility: z.enum(['public', 'private']).optional(), configPatch: z.record(z.string(), z.unknown()).optional(), expectedVersion: z.number().int().optional() }).parse(req.body);
    const t = await updateTournament(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), b, src);
    return { id: t.id, version: t.version };
  });
  app.delete('/api/tournaments/:id', async (req) => {
    await deleteDraft(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id));
    return { ok: true };
  });
  app.post('/api/tournaments/:id/archive', async (req) => {
    await archiveTournament(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), z.object({ archived: z.boolean() }).parse(req.body).archived);
    return { ok: true };
  });
  app.post('/api/tournaments/:id/actions/:action', async (req) => {
    const p = req.params as { id: string; action: string };
    const action = z.enum(['publish', 'unpublish', 'open_registration', 'close_registration', 'mark_ready', 'start', 'pause', 'resume', 'cancel']).parse(p.action) as TransitionAction;
    const b = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    const r = await transition(ctx, requireUser(req).id, id.parse(p.id), action, { reason: b.reason, source: src });
    return { state: r.tournament.state, warnings: r.warnings };
  });
  app.post('/api/tournaments/:id/preset-preview', async (req) => previewPreset(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), z.object({ presetId: z.number().int().positive() }).parse(req.body).presetId));
  app.post('/api/tournaments/:id/apply-preset', async (req) => {
    const t = await applyPreset(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), z.object({ presetId: z.number().int().positive() }).parse(req.body).presetId, src);
    return { id: t.id, version: t.version };
  });
  app.post('/api/tournaments/:id/save-as-preset', async (req) => {
    const u = requireUser(req);
    const t = loadTournament(ctx, id.parse((req.params as { id: string }).id));
    await assertManage(ctx, t, u.id);
    const b = z.object({ name: z.string(), description: z.string().max(500).optional() }).parse(req.body);
    return createPreset(ctx, u.id, { guildId: t.guild_id, name: b.name, description: b.description, config: { ...t.cfg, schedule: { ...t.cfg.schedule, startAt: null } } });
  });
  app.post('/api/tournaments/:id/admins', async (req) => {
    await addAdmin(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), z.object({ userId: snowflake }).parse(req.body).userId, src);
    return { ok: true };
  });
  app.delete('/api/tournaments/:id/admins/:uid', async (req) => {
    const p = req.params as { id: string; uid: string };
    await removeAdmin(ctx, requireUser(req).id, id.parse(p.id), snowflake.parse(p.uid), src);
    return { ok: true };
  });
  app.post('/api/tournaments/:id/invites', async (req) => {
    const b = z.object({ userId: snowflake, remove: z.boolean().optional() }).parse(req.body);
    await inviteViewer(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), b.userId, b.remove);
    return { ok: true };
  });
  app.get('/api/tournaments/:id/audit', async (req) => {
    const u = requireUser(req);
    const t = loadTournament(ctx, id.parse((req.params as { id: string }).id));
    await assertManage(ctx, t, u.id);
    const q = z.object({ before: z.coerce.number().int().optional() }).parse(req.query);
    return listAudit(ctx, t.id, 200, q.before);
  });
  app.get('/api/tournaments/:id/export/:kind', async (req, reply) => {
    const p = req.params as { id: string; kind: string };
    const kind = z.enum(EXPORT_KINDS).parse(p.kind.replace(/\.csv$/, '')) as ExportKind;
    const { filename, csv } = await exportCsv(ctx, id.parse(p.id), kind, req.user?.id ?? null);
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${filename}"`).send(csv);
  });
  app.post('/api/tournaments/:id/voice/repair', async (req) => repairVoice(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id)));

  // ---------------- registration ----------------
  app.post('/api/tournaments/:id/register', async (req) => {
    const b = z.object({ teamName: z.string().max(40).nullish(), rank: z.string().max(40).nullish() }).parse(req.body ?? {});
    const e = await register(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), b, src);
    return { entryId: e.id, status: e.status };
  });
  app.post('/api/tournaments/:id/withdraw', async (req) => {
    await withdraw(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), src);
    return { ok: true };
  });
  app.post('/api/tournaments/:id/check-in', async (req) => {
    const b = z.object({ entryId: z.number().int().positive().nullish() }).parse(req.body ?? {});
    const e = await checkIn(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), b.entryId ?? null, src);
    return { entryId: e.id, checkedIn: !!e.checked_in_at };
  });
  app.post('/api/tournaments/:id/my-rank', async (req) => {
    const b = z.object({ rank: z.string(), division: z.number().int().min(1).max(4).nullish() }).parse(req.body);
    await setOwnRank(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), b.rank, b.division ?? null);
    return { ok: true };
  });
  app.post('/api/tournaments/:id/players', async (req) => {
    const b = z.object({ userId: snowflake, username: z.string().max(32).nullish() }).parse(req.body);
    const e = await adminAddPlayer(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), b.userId, b.username ?? null, src);
    return { entryId: e.id, status: e.status };
  });
  app.post('/api/tournaments/:id/roster-lock', async (req) => {
    await setRosterLock(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), z.object({ locked: z.boolean() }).parse(req.body).locked);
    return { ok: true };
  });
  app.post('/api/entries/:id/:action', async (req) => {
    const p = req.params as { id: string; action: string };
    const action = z.enum(['approve', 'reject', 'remove', 'waitlist', 'restore']).parse(p.action);
    const b = z.object({ reason: z.string().max(500).nullish() }).parse(req.body ?? {});
    const e = await adminEntryAction(ctx, requireUser(req).id, id.parse(p.id), action, b.reason ?? null, src);
    return { entryId: e.id, status: e.status };
  });
  app.patch('/api/entries/:id', async (req) => {
    const b = z.object({ seed: z.number().int().nullish(), rank: z.string().nullish(), division: z.number().int().nullish(), name: z.string().optional() }).parse(req.body);
    const u = requireUser(req);
    const eid = id.parse((req.params as { id: string }).id);
    if (b.name !== undefined) await renameTeam(ctx, u.id, eid, b.name);
    if (b.seed !== undefined || b.rank !== undefined || b.division !== undefined) await setEntrySkill(ctx, u.id, eid, { seed: b.seed, rank: b.rank, division: b.division }, src);
    return { ok: true };
  });
  app.post('/api/entries/:id/invitations', async (req) => {
    const b = z.object({ userId: snowflake, role: z.enum(['player', 'substitute']).default('player') }).parse(req.body);
    return { invitationId: await inviteToTeam(ctx, requireUser(req).id, id.parse((req.params as { id: string }).id), b.userId, b.role, src) };
  });
  app.delete('/api/entries/:id/members/:uid', async (req) => {
    const p = req.params as { id: string; uid: string };
    await removeTeamMember(ctx, requireUser(req).id, id.parse(p.id), snowflake.parse(p.uid), z.object({ reason: z.string().max(300).nullish() }).parse(req.body ?? {}).reason ?? null, src);
    return { ok: true };
  });
  app.post('/api/invitations/:id/:action', async (req) => {
    const p = req.params as { id: string; action: string };
    const action = z.enum(['accept', 'decline', 'revoke']).parse(p.action);
    const u = requireUser(req);
    if (action === 'revoke') await revokeInvitation(ctx, u.id, id.parse(p.id));
    else await respondInvitation(ctx, u.id, id.parse(p.id), action === 'accept', src);
    return { ok: true };
  });

  // ---------------- 6mans ----------------
  const tid = (req: FastifyRequest) => id.parse((req.params as { id: string }).id);
  app.post('/api/tournaments/:id/sixmans/pools', async (req) => makePoolsProposal(ctx, requireUser(req).id, tid(req), z.object({ poolCount: z.number().int().min(1).max(32).nullish() }).parse(req.body ?? {}).poolCount ?? null, src));
  app.put('/api/tournaments/:id/sixmans/pools', async (req) => editPools(ctx, requireUser(req).id, tid(req), z.object({ pools: z.array(z.array(snowflake)).min(1).max(32) }).parse(req.body).pools, src));
  app.post('/api/tournaments/:id/sixmans/pools/confirm', async (req) => confirmPools(ctx, requireUser(req).id, tid(req), src));
  app.post('/api/tournaments/:id/sixmans/schedule', async (req) =>
    generateSchedule(ctx, requireUser(req).id, tid(req), z.object({
      rounds: z.number().int().min(1).max(60).optional(), games: z.number().int().min(1).max(60).nullable().optional(), mode: z.enum(['equal_games', 'fixed']).optional(),
      matchesPerRound: z.number().int().min(1).max(5).optional(), skillBalanced: z.boolean().optional(),
    }).parse(req.body ?? {}), src));
  app.post('/api/tournaments/:id/sixmans/schedule/swap', async (req) =>
    swapScheduledPlayers(ctx, requireUser(req).id, tid(req), z.object({ poolIndex: z.number().int().min(0), round: z.number().int().min(1), playerA: snowflake, playerB: snowflake }).parse(req.body), src));
  app.post('/api/tournaments/:id/sixmans/schedule/confirm', async (req) => confirmSchedule(ctx, requireUser(req).id, tid(req), src));
  app.post('/api/tournaments/:id/sixmans/finals/preview', async (req) =>
    previewFinals(ctx, requireUser(req).id, tid(req), z.object({ optionId: z.string().max(30).nullish(), qualifiersPerPool: z.number().int().min(1).max(64).nullish() }).parse(req.body ?? {}), src));
  app.put('/api/tournaments/:id/sixmans/finals/teams', async (req) => {
    const body = z.object({ teams: z.array(z.object({ players: z.array(snowflake) })).min(2).max(64), handPicked: z.boolean().optional() }).parse(req.body);
    return editFinalsTeams(ctx, requireUser(req).id, tid(req), body.teams, src, { handPicked: body.handPicked });
  });
  app.post('/api/tournaments/:id/sixmans/finals/start', async (req) => {
    await startFinals(ctx, requireUser(req).id, tid(req), src);
    return { ok: true };
  });

  // ---------------- matches ----------------
  const mid = (req: FastifyRequest) => id.parse((req.params as { id: string }).id);
  app.get('/api/matches/:id', async (req) => matchDetail(ctx, mid(req), req.user?.id ?? null));
  app.post('/api/matches/:id/report', async (req) => {
    const r = await reportResult(ctx, requireUser(req).id, mid(req), resultBody.parse(req.body), src);
    return 'outcome' in r ? { outcome: r.outcome, status: r.match.status } : { outcome: 'completed', status: r.status };
  });
  app.post('/api/matches/:id/confirm', async (req) => ({ status: (await confirmResult(ctx, requireUser(req).id, mid(req), src)).status }));
  app.post('/api/matches/:id/dispute', async (req) => {
    const b = z.object({ reason: z.string().min(3).max(500), counter: resultBody.nullish() }).parse(req.body);
    return { status: (await disputeResult(ctx, requireUser(req).id, mid(req), b.reason, b.counter ?? null, src)).status };
  });
  app.post('/api/matches/:id/progress', async (req) => {
    await reportProgress(ctx, requireUser(req).id, mid(req), z.object({ games }).parse(req.body).games);
    return { ok: true };
  });
  app.post('/api/matches/:id/resolve', async (req) => {
    const b = resultBody.extend({ forfeitWinner: z.enum(['a', 'b']).nullish(), reason: z.string().max(500).nullish(), confirmDownstream: z.boolean().optional() }).parse(req.body);
    const m = await adminResolve(ctx, requireUser(req).id, mid(req), b, b.reason ?? null, !!b.confirmDownstream, src);
    return { status: m.status };
  });
  app.post('/api/matches/:id/abandon', async (req) => {
    await abandonMatch(ctx, requireUser(req).id, mid(req), z.object({ reason: z.string().min(3).max(500) }).parse(req.body).reason, src);
    return { ok: true };
  });
  app.post('/api/tournaments/:id/bracket/swap', async (req) => {
    const b = z.object({ matchA: z.number().int(), slotA: z.enum(['a', 'b']), matchB: z.number().int(), slotB: z.enum(['a', 'b']), reason: z.string().min(3).max(500) }).parse(req.body);
    const m = (ctx.db.prepare('SELECT tournament_id FROM matches WHERE id = ?').get(b.matchA) as { tournament_id: number } | undefined);
    if (!m || m.tournament_id !== tid(req)) throw new DomainError('not_found', 'Match not found.', 404);
    await swapCompetitors(ctx, requireUser(req).id, b, src);
    return { ok: true };
  });
  app.post('/api/tournaments/:id/roster/replace', async (req) => {
    const b = z.object({ outUserId: snowflake, inUserId: snowflake, reason: z.string().min(3).max(500) }).parse(req.body);
    await replacePlayer(ctx, requireUser(req).id, tid(req), b, src);
    return { ok: true };
  });

  // ---------------- players ----------------
  app.get('/api/players', async (req) => searchPlayers(ctx, z.string().min(1).max(40).parse((req.query as { q?: string }).q)));
  app.get('/api/players/:uid', async (req) => playerProfile(ctx, snowflake.parse((req.params as { uid: string }).uid), req.user?.id ?? null));

  app.setNotFoundHandler((_req: FastifyRequest, reply: FastifyReply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } }));
  return app;
}

/**
 * Bot permissions requested in the invite link: Manage Channels (1<<4), View Channels (1<<10),
 * Send Messages (1<<11), Embed Links (1<<14), Connect (1<<20), Speak (1<<21), Move Members (1<<24).
 * Discord only lets a bot grant permissions it holds itself in channel overwrites, which is why
 * View Channels, Connect and Speak are requested.
 */
export const BOT_PERMISSIONS = String((1n << 4n) | (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 20n) | (1n << 21n) | (1n << 24n));
