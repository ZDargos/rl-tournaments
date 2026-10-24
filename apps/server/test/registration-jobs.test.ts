import { describe, expect, it } from 'vitest';
import { ANNOUNCE, GUILD, ok, setup, uid } from './helpers.js';
import { DiscordApiError, DiscordCodes } from '../src/discord/port.js';
import { createContext } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { JobRunner } from '../src/jobs/scheduler.js';

const base = { voice: { enabled: false }, notifications: { announcementChannelId: ANNOUNCE } };

describe('registration', () => {
  it('capacity, waitlist promotion on withdrawal, and approval', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Capped', config: { ...base, format: 'single_elim', teamSize: 1, registration: { capacity: 2 } } })).body;
    ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
    // Registration before it opens is refused.
    const early = await s.login(9);
    expect((await early.post(`/api/tournaments/${t.id}/register`, {})).status).toBe(409);
    ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
    const p = await Promise.all([10, 11, 12].map((n) => s.login(n)));
    expect(ok(await p[0].post(`/api/tournaments/${t.id}/register`, {})).body.status).toBe('confirmed');
    expect(ok(await p[1].post(`/api/tournaments/${t.id}/register`, {})).body.status).toBe('confirmed');
    expect(ok(await p[2].post(`/api/tournaments/${t.id}/register`, {})).body.status).toBe('waitlisted');
    ok(await p[0].post(`/api/tournaments/${t.id}/withdraw`));
    const d = ok(await admin.get(`/api/tournaments/${t.id}`)).body;
    expect(d.entries.find((e: any) => e.userId === p[2].id).status).toBe('confirmed');
    await s.settle();
    expect(s.discord.sent.some((m) => m.kind === 'dm' && m.target === p[2].id && /waitlist|spot|confirmed/i.test(m.content))).toBe(true);
  });

  it('approval required; members only; required roles', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Approval', config: { ...base, format: 'single_elim', teamSize: 1, registration: { requireApproval: true, requiredRoleIds: ['700000000000000001'] } } })).body;
    ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
    ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
    const noRole = await s.login(10);
    expect((await noRole.post(`/api/tournaments/${t.id}/register`, {})).status).toBe(403);
    const withRole = await s.login(11, { roles: ['700000000000000001'] });
    const e = ok(await withRole.post(`/api/tournaments/${t.id}/register`, {})).body;
    expect(e.status).toBe('pending');
    expect((await withRole.post(`/api/entries/${e.entryId}/approve`)).status).toBe(403);
    expect(ok(await admin.post(`/api/entries/${e.entryId}/approve`)).body.status).toBe('confirmed');
    // A user who left the server can no longer register (bot sees them gone).
    const gone = await s.login(12, { roles: ['700000000000000001'] });
    s.discord.members.delete(`${GUILD}:${gone.id}`);
    s.db.prepare("UPDATE guild_members SET refreshed_at = '2000-01-01T00:00:00Z' WHERE user_id = ?").run(gone.id);
    expect((await gone.post(`/api/tournaments/${t.id}/register`, {})).status).toBe(403);
  });

  it('team invitations: decline, expiry, roster limits and lock at start', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Teams', config: { ...base, format: 'single_elim', teamSize: 2, registrationMode: 'team', registration: { maxSubstitutes: 0, inviteExpiryHours: 1 } } })).body;
    ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
    ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
    const cap = await s.login(10);
    const [a, b, c] = await Promise.all([11, 12, 13].map((n) => s.login(n)));
    expect((await cap.post(`/api/tournaments/${t.id}/register`, {})).status).toBe(400); // team name required
    const e = ok(await cap.post(`/api/tournaments/${t.id}/register`, { teamName: 'Octane Bros' })).body;
    // Same name (case-insensitive) is refused.
    expect((await a.post(`/api/tournaments/${t.id}/register`, { teamName: 'octane bros' })).status).toBe(409);
    const i1 = ok(await cap.post(`/api/entries/${e.entryId}/invitations`, { userId: a.id })).body.invitationId;
    expect([403, 404]).toContain((await b.post(`/api/invitations/${i1}/accept`)).status); // not the invitee
    ok(await a.post(`/api/invitations/${i1}/decline`));
    const i2 = ok(await cap.post(`/api/entries/${e.entryId}/invitations`, { userId: b.id })).body.invitationId;
    s.clock.advance(61);
    await s.settle();
    expect((await b.post(`/api/invitations/${i2}/accept`)).status).toBe(409); // expired
    const i3 = ok(await cap.post(`/api/entries/${e.entryId}/invitations`, { userId: c.id })).body.invitationId;
    ok(await c.post(`/api/invitations/${i3}/accept`));
    // Roster full (2 players, no subs).
    const i4 = await cap.post(`/api/entries/${e.entryId}/invitations`, { userId: a.id });
    expect(i4.status).toBe(409);
    // A player already on a team cannot register solo/elsewhere.
    expect((await c.post(`/api/tournaments/${t.id}/register`, { teamName: 'Other' })).status).toBe(409);
  });

  it('check-in: reminders, no-shows removed at start', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const startAt = new Date(s.clock.t + 120 * 60_000).toISOString();
    const t = ok(await admin.post('/api/tournaments', {
      guildId: GUILD, name: 'Check-in Cup',
      config: { ...base, format: 'single_elim', teamSize: 1, schedule: { startAt, autoStart: true }, checkIn: { enabled: true, opensMinutesBefore: 60, closesMinutesBefore: 10 }, notifications: { announcementChannelId: ANNOUNCE, startReminders: [60, 15], checkInReminders: [30] } },
    })).body;
    ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
    ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
    const ps = await Promise.all([10, 11, 12, 13].map((n) => s.login(n)));
    for (const p of ps) ok(await p.post(`/api/tournaments/${t.id}/register`, {}));
    expect((await ps[0].post(`/api/tournaments/${t.id}/check-in`)).status).toBe(409); // not open yet
    s.clock.advance(61); // check-in open (59 min before start)
    await s.settle();
    for (const p of ps.slice(0, 3)) ok(await p.post(`/api/tournaments/${t.id}/check-in`));
    s.clock.advance(31); // 28 min before: check-in reminder to the unchecked player only
    await s.settle();
    const reminders = s.discord.sent.filter((m) => m.kind === 'dm' && /not checked in/i.test(m.content));
    expect(reminders.map((m) => m.target)).toEqual([ps[3].id]);
    // Run the job loop again: no duplicate reminders.
    await s.settle();
    await s.settle();
    expect(s.discord.sent.filter((m) => m.kind === 'dm' && /not checked in/i.test(m.content)).length).toBe(1);
    s.clock.advance(14); // 14 min before start: second start reminder
    await s.settle();
    s.clock.advance(16); // past start: auto-start removes the no-show
    await s.settle();
    const d = ok(await admin.get(`/api/tournaments/${t.id}`)).body;
    expect(d.tournament.state).toBe('in_progress');
    expect(d.competitors.length).toBe(3);
    // Start reminders were sent once each (60 and 15 minutes), not repeated.
    const startRem = s.discord.sent.filter((m) => m.kind === 'channel' && /starts/i.test(m.content));
    expect(startRem.length).toBe(2);
  });
});

describe('notifications & jobs', () => {
  it('blocked DMs are not retried and organizers see unreachable players; mutes respected', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'DM test', config: { ...base, format: 'single_elim', teamSize: 1, notifications: { channelAnnouncements: false } } })).body;
    ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
    ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
    const [a, b, c] = await Promise.all([10, 11, 12].map((n) => s.login(n)));
    for (const p of [a, b, c]) ok(await p.post(`/api/tournaments/${t.id}/register`, {}));
    s.discord.dmClosed.add(a.id);
    ok(await c.put(`/api/me/mutes/${t.id}`));
    ok(await admin.post(`/api/tournaments/${t.id}/actions/start`));
    await s.settle();
    expect(s.discord.sent.some((m) => m.target === a.id)).toBe(false);
    expect(s.discord.sent.some((m) => m.target === c.id)).toBe(false);
    expect(s.discord.sent.some((m) => m.target === b.id)).toBe(true);
    const u = s.db.prepare('SELECT dm_blocked_until FROM users WHERE id = ?').get(a.id) as { dm_blocked_until: string | null };
    expect(u.dm_blocked_until).not.toBeNull();
    const d = ok(await admin.get(`/api/tournaments/${t.id}`)).body;
    expect(d.manager.unreachable.map((x: any) => x.userId)).toEqual(expect.arrayContaining([a.id, c.id]));
  });

  it('recovers after a restart: in-flight notifications are not duplicated, missed reminders are skipped', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const startAt = new Date(s.clock.t + 24 * 60 * 60_000 + 30 * 60_000).toISOString();
    const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Restart', config: { ...base, format: 'single_elim', teamSize: 1, schedule: { startAt }, notifications: { announcementChannelId: ANNOUNCE, startReminders: [1440, 60] } } })).body;
    ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
    ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
    await s.settle();
    const before = s.discord.sent.length;
    // Simulate a crash mid-send: a notification left 'processing' with its channel delivery marked 'sending'.
    const n = s.db.prepare("SELECT id FROM notifications WHERE status = 'sent' LIMIT 1").get() as { id: number };
    s.db.prepare("UPDATE notifications SET status = 'processing' WHERE id = ?").run(n.id);
    s.db.prepare("UPDATE notification_deliveries SET status = 'sending' WHERE notification_id = ?").run(n.id);
    // "Offline" for 2 days: both start reminders are now in the past.
    s.clock.advance(2 * 24 * 60);
    const ctx2 = createContext({ env: s.env, db: s.db, discord: s.discord, log: createLogger('silent', false), clock: s.clock });
    const jobs2 = new JobRunner(ctx2);
    await jobs2.startup();
    await ctx2.idle();
    const after = s.discord.sent.slice(before);
    expect(after.filter((m) => /starts/i.test(m.content)).length).toBe(0); // stale reminders skipped
    expect(after.length).toBe(0); // the crashed message was not re-sent
    const statuses = s.db.prepare("SELECT status, last_error FROM notifications WHERE kind = 'reminder'").all() as { status: string; last_error: string }[];
    expect(statuses.every((r) => r.status === 'skipped')).toBe(true);
  });

  it('auto-start failure is recorded once and organizers are alerted', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const startAt = new Date(s.clock.t + 10 * 60_000).toISOString();
    const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Lonely', config: { ...base, format: 'single_elim', teamSize: 1, schedule: { startAt, autoStart: true }, minEntrants: 4 } })).body;
    ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
    ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
    s.clock.advance(11);
    await s.settle();
    await s.settle();
    const d = ok(await admin.get(`/api/tournaments/${t.id}`)).body;
    expect(d.tournament.state).toBe('registration_open');
    expect(d.tournament.autoStartError).toMatch(/entrant|at least/i);
    const alerts = s.discord.sent.filter((m) => m.kind === 'dm' && m.target === admin.id && /scheduled start/i.test(m.content));
    expect(alerts.length).toBe(1);
  });
});

describe('voice channels', () => {
  it('creates private channels, moves connected players, survives failures and restarts', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Voice', config: { ...base, voice: { enabled: true }, format: 'single_elim', teamSize: 1, series: { bestOf: 1 } } })).body;
    ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
    ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
    const ps = await Promise.all([10, 11, 12, 13].map((n) => s.login(n)));
    for (const p of ps) ok(await p.post(`/api/tournaments/${t.id}/register`, {}));
    // Player 10 is sitting in a lobby voice channel; Discord fails the first creation attempt.
    s.discord.voiceStates.set(`${GUILD}:${ps[0].id}`, '400000000000000001');
    s.discord.failCreateVoice = new DiscordApiError('Missing Permissions', DiscordCodes.MissingPermissions, 403, true);
    ok(await admin.post(`/api/tournaments/${t.id}/actions/start`));
    await s.settle();
    let d = ok(await admin.get(`/api/tournaments/${t.id}`)).body;
    expect(d.manager.voice.some((v: any) => v.status === 'failed' && /permission/i.test(v.error ?? ''))).toBe(true);
    // The match itself still works.
    expect(d.matches.filter((m: any) => m.status === 'ready').length).toBe(2);
    // Organizer fixes permissions and repairs.
    s.discord.failCreateVoice = null;
    ok(await admin.post(`/api/tournaments/${t.id}/voice/repair`));
    await s.settle();
    d = ok(await admin.get(`/api/tournaments/${t.id}`)).body;
    const active = d.manager.voice.filter((v: any) => v.status === 'active');
    expect(active.length).toBe(4);
    const mine = active.find((v: any) => v.memberIds.includes(ps[0].id));
    expect(s.discord.voiceStates.get(`${GUILD}:${ps[0].id}`)).toBe(mine.channelId);
    // Private: only the player (+ organizers) are allowed.
    const ch = s.discord.channels.get(mine.channelId)!;
    expect(ch.memberIds).toEqual([ps[0].id]);
    expect(ch.organizerIds).toContain(admin.id);
    // Someone deletes a channel by hand while the bot is offline; on restart it is recreated, no duplicates.
    s.discord.channels.delete(mine.channelId);
    const ctx2 = createContext({ env: s.env, db: s.db, discord: s.discord, log: createLogger('silent', false), clock: s.clock });
    await new JobRunner(ctx2).startup();
    await ctx2.idle();
    const live = s.db.prepare("SELECT COUNT(*) c FROM voice_channels WHERE status = 'active'").get() as { c: number };
    expect(live.c).toBe(4);
    expect([...s.discord.channels.values()].filter((c) => c.type === 'voice').length).toBe(4);
    // Cancelling the tournament cleans up every channel.
    ok(await admin.post(`/api/tournaments/${t.id}/actions/cancel`, { reason: 'test over' }));
    await s.settle();
    expect([...s.discord.channels.values()].filter((c) => c.type === 'voice').length).toBe(0);
    void uid;
  });
});
