import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@rl/core';
import { handleInteraction, type BotInteraction } from '../src/discord/handlers.js';
import { ANNOUNCE, GUILD, ok, setup } from './helpers.js';

const base = { registration: { requireApproval: false } };

let seq = 0;
/** A button pressed in a DM (no server). */
const dmButton = (userId: string, customId: string): BotInteraction => ({
  id: `8200000000000${String(++seq).padStart(5, '0')}`, kind: 'button', guildId: null, user: { id: userId, username: `u${userId.slice(-3)}` },
  memberIsAdmin: false, memberRoleIds: [], command: '', subcommand: null, options: {}, customId,
});

/** A 1v1 tournament starting in 72 hours with four players signed up. */
async function upcoming(notifications: Record<string, unknown> = { startReminderHours: [48, 24, 1] }) {
  const s = await setup();
  const admin = await s.login(1, { admin: true, name: 'host' });
  const startAt = new Date(s.clock.t + 72 * 3600_000).toISOString();
  const t = ok(await admin.post('/api/tournaments', {
    guildId: GUILD, name: 'Friday Cup', config: { ...base, format: 'single_elim', teamSize: 1, schedule: { startAt }, notifications: { announcementChannelId: ANNOUNCE, ...notifications } },
  })).body;
  ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
  ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
  const ps = await Promise.all([10, 11, 12, 13].map((n) => s.login(n, { name: `player${n}` })));
  for (const p of ps) ok(await p.post(`/api/tournaments/${t.id}/register`, {}));
  await s.settle();
  const statusOf = async (userId: string) => (ok(await admin.get(`/api/tournaments/${t.id}`)).body.entries as any[]).find((e) => e.userId === userId).availability;
  const adminDms = () => s.discord.sent.filter((m) => m.kind === 'dm' && m.target === admin.id).map((m) => m.content);
  return { s, admin, ps, tid: t.id as number, startAt, statusOf, adminDms };
}

describe('start reminders in hours', () => {
  it('old minute values are converted to hours', () => {
    expect(parseConfig({ notifications: { startReminders: [1440, 60, 15] } }).notifications.startReminderHours).toEqual([24, 1, 0.25]);
    expect(parseConfig({}).notifications.startReminderHours).toEqual([48, 24, 1]);
    expect('startReminders' in parseConfig({ notifications: { startReminders: [30] } }).notifications).toBe(false);
  });

  it('the migration converts stored tournaments exactly', async () => {
    const { s, tid } = await upcoming();
    s.db.prepare("UPDATE tournaments SET config = json_set(json_remove(config, '$.notifications.startReminderHours'), '$.notifications.startReminders', json('[1440,60,15,5]')) WHERE id = ?").run(tid);
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, '../src/db/migrations/004_availability.sql'), 'utf8').split('-- Whether each player')[0];
    s.db.exec(sql);
    const cfg = JSON.parse((s.db.prepare('SELECT config FROM tournaments WHERE id = ?').get(tid) as { config: string }).config);
    expect(cfg.notifications.startReminderHours).toEqual([24, 1, 0.25, 0.0833]);
    expect(cfg.notifications.startReminders).toBeUndefined();
    // Reminder keys are still in minutes, so nothing already queued is duplicated.
    expect(parseConfig(cfg).notifications.startReminderHours.map((h) => Math.round(h * 60))).toEqual([1440, 60, 15, 5]);
  });

  it('reminders are queued at the right times', async () => {
    const { s, tid } = await upcoming({ startReminderHours: [48, 0.5] });
    const keys = (s.db.prepare("SELECT idempotency_key k FROM notifications WHERE tournament_id = ? AND kind = 'reminder' AND status = 'pending' ORDER BY run_at").all(tid) as { k: string }[]).map((r) => r.k);
    expect(keys.filter((k) => k.includes(':start:')).map((k) => k.split(':')[2])).toEqual(['2880', '30']);
    expect(keys.some((k) => k.includes(':digest:'))).toBe(true);
  });
});

describe('availability confirmations', () => {
  it('reminder DMs ask, answers are recorded, silence becomes maybe after a day, and organizers get a digest', async () => {
    const { s, admin, ps, tid, statusOf, adminDms } = await upcoming();
    s.discord.dmClosed.add(ps[3].id);
    expect(await statusOf(ps[0].id)).toBe('not_asked');

    s.clock.advance(24 * 60); // 48 hours before the start: first reminder
    await s.settle();
    const dm = s.discord.sent.find((m) => m.kind === 'dm' && m.target === ps[0].id && /starts/.test(m.content))!;
    expect(dm.content).toMatch(/Can you still make it/);
    expect(dm.buttons!.map((b) => b.customId)).toEqual([`avail:${tid}:yes`, `avail:${tid}:no`]);
    // The channel post has no buttons.
    expect(s.discord.sent.find((m) => m.kind === 'channel' && /starts/.test(m.content))!.buttons).toEqual([]);
    expect(await statusOf(ps[0].id)).toBe('awaiting');
    expect(await statusOf(ps[3].id)).toBe('not_asked'); // DMs closed: never asked

    expect((await handleInteraction(s.ctx, dmButton(ps[0].id, `avail:${tid}:yes`)))!.content).toMatch(/know you can make it/);
    expect((await handleInteraction(s.ctx, dmButton(ps[1].id, `avail:${tid}:no`)))!.content).toMatch(/can't make it/);
    await s.settle();
    expect(await statusOf(ps[0].id)).toBe('confirmed');
    expect(await statusOf(ps[1].id)).toBe('declined');
    // Organizers hear right away when someone can't make it.
    expect(adminDms().filter((c) => /player11 says they can't make it/.test(c)).length).toBe(1);

    // Players see only their own status; organizers see everyone's.
    const mine = ok(await ps[2].get(`/api/tournaments/${tid}`)).body;
    expect(mine.viewer.availability).toBe('awaiting');
    expect(mine.entries.find((e: any) => e.userId === ps[0].id).availability).toBeUndefined();

    s.clock.advance(23 * 60); // 25 hours before: not a day yet
    await s.settle();
    expect(await statusOf(ps[2].id)).toBe('awaiting');

    s.clock.advance(60); // 24 hours before: a day without a reply, and the digest
    await s.settle();
    expect(await statusOf(ps[2].id)).toBe('maybe');
    const flagged = adminDms().filter((c) => /marked as maybe/.test(c));
    expect(flagged.length).toBe(1);
    expect(flagged[0]).toMatch(/player12/);
    expect(flagged[0]).not.toMatch(/player10|player11|player13/);
    const digest = adminDms().find((c) => /Who can make it/.test(c))!;
    expect(digest).toMatch(/1 of 4 signed-up players have confirmed/);
    expect(digest).toMatch(/Confirmed \(1\)\*\*: player10/);
    expect(digest).toMatch(/Can’t make it \(1\)\*\*: player11/);
    expect(digest).toMatch(/Maybe \(no reply\) \(1\)\*\*: player12/);
    expect(digest).toMatch(/Not asked yet \(1\)\*\*: player13/);

    // A later reminder keeps the answers, and a maybe can still answer.
    ok(await ps[2].post(`/api/tournaments/${tid}/availability`, { answer: 'confirmed' }));
    expect(await statusOf(ps[2].id)).toBe('confirmed');
    await s.settle();
    await s.settle();
    expect(adminDms().filter((c) => /marked as maybe/.test(c)).length).toBe(1);
    expect(adminDms().filter((c) => /Who can make it/.test(c)).length).toBe(1);
    expect(await statusOf(ps[0].id)).toBe('confirmed');
  });

  it('organizers can set a player’s status; other players cannot', async () => {
    const { admin, ps, tid, statusOf } = await upcoming();
    expect((await ps[0].post(`/api/tournaments/${tid}/availability`, { answer: 'confirmed', userId: ps[1].id })).status).toBe(403);
    ok(await admin.post(`/api/tournaments/${tid}/availability`, { answer: 'declined', userId: ps[1].id }));
    expect(await statusOf(ps[1].id)).toBe('declined');
    expect((await admin.post(`/api/tournaments/${tid}/availability`, { answer: 'confirmed' })).status).toBe(404); // the organizer is not playing
  });

  it('moving the start time resets the answers', async () => {
    const { s, admin, ps, tid, startAt, statusOf } = await upcoming();
    ok(await ps[0].post(`/api/tournaments/${tid}/availability`, { answer: 'confirmed' }));
    expect(await statusOf(ps[0].id)).toBe('confirmed');
    const later = new Date(Date.parse(startAt) + 24 * 3600_000).toISOString();
    ok(await admin.patch(`/api/tournaments/${tid}`, { configPatch: { schedule: { startAt: later } } }));
    expect(await statusOf(ps[0].id)).toBe('not_asked');
    // The digest moved with the start: only one is pending, for the new time.
    const digests = s.db.prepare("SELECT idempotency_key k FROM notifications WHERE tournament_id = ? AND category = 'availability_digest' AND status = 'pending'").all(tid) as { k: string }[];
    expect(digests.map((d) => d.k)).toEqual([`t${tid}:digest:${later}`]);
  });

  it('answers are refused once the tournament has started', async () => {
    const { s, admin, ps, tid } = await upcoming();
    ok(await admin.post(`/api/tournaments/${tid}/actions/start`));
    expect((await handleInteraction(s.ctx, dmButton(ps[0].id, `avail:${tid}:yes`)))!.content).toMatch(/already started/);
  });
});

describe('availability checks sent by organizers', () => {
  const startDms = (s: any, userId: string) => s.discord.sent.filter((m: any) => m.kind === 'dm' && m.target === userId && /Can you still make it/.test(m.content));

  it('sends the reminder to everyone or to one player, by DM only, and asks again', async () => {
    const { s, admin, ps, tid, statusOf } = await upcoming({ dms: false });
    const channelBefore = s.discord.sent.filter((m) => m.kind === 'channel').length;

    const one = ok(await admin.post(`/api/tournaments/${tid}/availability-check`, { userId: ps[1].id })).body;
    expect(one.recipients).toBe(1);
    await s.settle();
    expect(startDms(s, ps[1].id).length).toBe(1);
    expect(startDms(s, ps[0].id).length).toBe(0);
    expect(await statusOf(ps[1].id)).toBe('awaiting');
    // A double click in the same minute does not DM twice.
    expect((await admin.post(`/api/tournaments/${tid}/availability-check`, { userId: ps[1].id })).status).toBe(409);

    s.clock.advance(2);
    expect(ok(await admin.post(`/api/tournaments/${tid}/availability-check`, {})).body.recipients).toBe(4);
    await s.settle();
    for (const p of ps) expect(startDms(s, p.id).length).toBe(p.id === ps[1].id ? 2 : 1);
    expect(s.discord.sent.filter((m) => m.kind === 'channel').length).toBe(channelBefore);
  });

  it('is for organizers only, before the start', async () => {
    const { s, admin, ps, tid } = await upcoming();
    expect((await ps[0].post(`/api/tournaments/${tid}/availability-check`, {})).status).toBe(403);
    expect((await admin.post(`/api/tournaments/${tid}/availability-check`, { userId: '99999999999' })).status).toBe(404);
    ok(await admin.post(`/api/tournaments/${tid}/actions/start`));
    await s.settle();
    expect((await admin.post(`/api/tournaments/${tid}/availability-check`, {})).status).toBe(409);
  });
});
