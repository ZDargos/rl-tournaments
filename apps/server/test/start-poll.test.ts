import { describe, expect, it } from 'vitest';
import { handleInteraction, type BotInteraction } from '../src/discord/handlers.js';
import { ANNOUNCE, GUILD, ok, setup } from './helpers.js';

const REG = '300000000000000002';

let seq = 0;
const press = (userId: string, customId: string, guildId: string | null = GUILD): BotInteraction => ({
  id: `8300000000000${String(++seq).padStart(5, '0')}`, kind: 'button', guildId, user: { id: userId, username: `u${userId.slice(-3)}` },
  memberIsAdmin: false, memberRoleIds: [], command: '', subcommand: null, options: {}, customId,
});

/** A published 1v1 tournament with a registration channel and four logged-in players. */
async function published(config: Record<string, unknown> = {}) {
  const s = await setup();
  const admin = await s.login(1, { admin: true, name: 'host' });
  const t = ok(await admin.post('/api/tournaments', {
    guildId: GUILD, name: 'Vote Cup',
    config: { format: 'single_elim', teamSize: 1, registration: { requireApproval: false }, notifications: { announcementChannelId: ANNOUNCE, registrationChannelId: REG }, ...config },
  })).body;
  ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
  const ps = await Promise.all([10, 11, 12, 13].map((n) => s.login(n, { name: `player${n}` })));
  const hours = (h: number) => new Date(s.clock.t + h * 3600_000).toISOString();
  const detail = async () => ok(await admin.get(`/api/tournaments/${t.id}`)).body;
  return { s, admin, ps, tid: t.id as number, hours, detail };
}

describe('start time vote', () => {
  it('players vote in Discord and on the website; the winner sets the start, opens registration and registers its voters', async () => {
    const { s, admin, ps, tid, hours, detail } = await published();
    const options = [hours(48), hours(72), hours(96)];
    ok(await admin.post(`/api/tournaments/${tid}/start-poll`, { options, closesAt: hours(24) }));
    await s.settle();

    const card = s.discord.sent.find((m) => m.kind === 'channel' && /When should/.test(m.content))!;
    expect(card.target).toBe(REG);
    expect(card.buttons!.length).toBe(3);
    const pollId = Number(card.buttons![0].customId.split(':')[1]);

    // Registration cannot open while the vote runs.
    expect((await admin.post(`/api/tournaments/${tid}/actions/open_registration`)).status).toBe(409);

    // Discord: ps0 picks #1 and #2, then removes #1. ps1 picks #2. Website: ps2 picks #2 and #3, ps3 picks #3.
    expect((await handleInteraction(s.ctx, press(ps[0].id, `poll:${pollId}:0`)))!.content).toMatch(/Your picks/);
    await handleInteraction(s.ctx, press(ps[0].id, `poll:${pollId}:1`));
    await handleInteraction(s.ctx, press(ps[0].id, `poll:${pollId}:0`));
    await handleInteraction(s.ctx, press(ps[1].id, `poll:${pollId}:1`));
    expect(ok(await ps[2].post(`/api/tournaments/${tid}/start-poll/vote`, { options: [1, 2] })).body.picks).toEqual([1, 2]);
    ok(await ps[3].post(`/api/tournaments/${tid}/start-poll/vote`, { options: [2] }));
    await s.settle();
    const view = (await detail()).startPoll;
    expect(view.options.map((o: any) => o.votes)).toEqual([0, 3, 2]);
    expect(s.discord.messages.get(card.id!)!.content).toMatch(/\*\*3\*\* votes/);

    // The deadline passes: #2 wins.
    s.clock.advance(24 * 60 + 1);
    await s.settle();
    const d = await detail();
    expect(d.tournament.state).toBe('registration_open');
    expect(d.tournament.config.schedule.startAt).toBe(options[1]);
    expect(d.startPoll).toMatchObject({ status: 'closed', winner: 1, tie: false });
    const registered = d.entries.filter((e: any) => e.status === 'confirmed').map((e: any) => e.userId).sort();
    expect(registered).toEqual([ps[0].id, ps[1].id, ps[2].id].sort());
    // The card shows the result without buttons.
    expect(s.discord.messages.get(card.id!)!.buttons).toEqual([]);
    expect(s.discord.messages.get(card.id!)!.content).toMatch(/Voting closed/);
    // Registration posts go to the registration channel.
    expect(s.discord.sent.find((m) => m.kind === 'channel' && /Registration is open/.test(m.content))!.target).toBe(REG);

    // ps3 lost: DM with a sign-up button that works.
    const lost = s.discord.sent.find((m) => m.kind === 'dm' && m.target === ps[3].id && /didn't win/.test(m.content))!;
    expect(lost.buttons!.map((b) => b.customId)).toEqual([`pollreg:${tid}`]);
    expect((await handleInteraction(s.ctx, press(ps[3].id, `pollreg:${tid}`, null)))!.content).toMatch(/registered/);
    const won = s.discord.sent.find((m) => m.kind === 'dm' && m.target === ps[0].id && /you're registered/.test(m.content))!;
    expect(won.buttons!.map((b) => b.customId)).toEqual([`pollwd:${tid}`]);
    // Organizers get the result.
    expect(s.discord.sent.some((m) => m.kind === 'dm' && m.target === admin.id && /3 voters registered/.test(m.content))).toBe(true);
  });

  it('a tie is broken among the tied times, and organizers can close early', async () => {
    const { s, admin, ps, tid, hours, detail } = await published();
    const options = [hours(48), hours(72), hours(96)];
    ok(await admin.post(`/api/tournaments/${tid}/start-poll`, { options, closesAt: hours(24) }));
    ok(await ps[0].post(`/api/tournaments/${tid}/start-poll/vote`, { options: [0] }));
    ok(await ps[1].post(`/api/tournaments/${tid}/start-poll/vote`, { options: [2] }));
    expect((await ps[0].post(`/api/tournaments/${tid}/start-poll/close`)).status).toBe(403);
    ok(await admin.post(`/api/tournaments/${tid}/start-poll/close`));
    await s.settle();
    const d = await detail();
    expect(d.startPoll.tie).toBe(true);
    expect([0, 2]).toContain(d.startPoll.winner);
    expect(d.tournament.config.schedule.startAt).toBe(options[d.startPoll.winner]);
    expect(d.entries.filter((e: any) => e.status === 'confirmed').length).toBe(1);
  });

  it('no votes picks no time; bad setups are refused', async () => {
    const { s, admin, tid, hours, detail } = await published();
    expect((await admin.post(`/api/tournaments/${tid}/start-poll`, { options: [hours(48)], closesAt: hours(24) })).status).toBe(400);
    expect((await admin.post(`/api/tournaments/${tid}/start-poll`, { options: [hours(48), hours(48)], closesAt: hours(24) })).status).toBe(400);
    expect((await admin.post(`/api/tournaments/${tid}/start-poll`, { options: [hours(10), hours(48)], closesAt: hours(24) })).status).toBe(400);
    ok(await admin.post(`/api/tournaments/${tid}/start-poll`, { options: [hours(48), hours(72)], closesAt: hours(24) }));
    expect((await admin.post(`/api/tournaments/${tid}/start-poll`, { options: [hours(48), hours(72)], closesAt: hours(24) })).status).toBe(409);
    s.clock.advance(24 * 60 + 1);
    await s.settle();
    const d = await detail();
    expect(d.startPoll).toMatchObject({ status: 'closed', winner: null });
    expect(d.tournament.state).toBe('published');
    expect(d.tournament.config.schedule.startAt).toBeNull();
    expect(s.discord.sent.some((m) => m.kind === 'dm' && m.target === admin.id && /no votes/.test(m.content))).toBe(true);
  });

  it('team tournaments tell voters to register their team instead', async () => {
    const { s, admin, ps, tid, hours, detail } = await published({ teamSize: 2, registrationMode: 'team' });
    ok(await admin.post(`/api/tournaments/${tid}/start-poll`, { options: [hours(48), hours(72)], closesAt: hours(24) }));
    ok(await ps[0].post(`/api/tournaments/${tid}/start-poll/vote`, { options: [0] }));
    ok(await admin.post(`/api/tournaments/${tid}/start-poll/close`));
    await s.settle();
    expect((await detail()).entries.length).toBe(0);
    expect(s.discord.sent.some((m) => m.kind === 'dm' && m.target === ps[0].id && /register your team/.test(m.content))).toBe(true);
  });
});

describe('channel cleanup when a tournament ends', () => {
  it('deletes everything posted in the announcement and registration channels', async () => {
    const { s, admin, ps, tid } = await published();
    ok(await admin.post(`/api/tournaments/${tid}/actions/open_registration`));
    ok(await ps[0].post(`/api/tournaments/${tid}/register`, {}));
    await s.settle();
    const posted = s.discord.sent.filter((m) => m.kind === 'channel').map((m) => m.id);
    expect(posted.length).toBeGreaterThan(0);
    ok(await admin.post(`/api/tournaments/${tid}/actions/cancel`, {}));
    await s.settle();
    await s.settle();
    const all = s.discord.sent.filter((m) => m.kind === 'channel');
    expect(all.some((m) => /cancelled/.test(m.content))).toBe(true);
    for (const m of all) expect(s.discord.messages.has(m.id!)).toBe(false);
  });

  it('waits for the delay, and can be turned off', async () => {
    const { s, admin, tid } = await published({ notifications: { announcementChannelId: ANNOUNCE, clearChannelsAfterHours: 2 } });
    ok(await admin.post(`/api/tournaments/${tid}/actions/open_registration`));
    ok(await admin.post(`/api/tournaments/${tid}/actions/cancel`, {}));
    await s.settle();
    const ids = s.discord.sent.filter((m) => m.kind === 'channel').map((m) => m.id!);
    expect(ids.every((id) => s.discord.messages.has(id))).toBe(true);
    s.clock.advance(121);
    await s.settle();
    expect(ids.some((id) => s.discord.messages.has(id))).toBe(false);

    const other = await published({ notifications: { announcementChannelId: ANNOUNCE, clearChannelsOnEnd: false } });
    ok(await other.admin.post(`/api/tournaments/${other.tid}/actions/open_registration`));
    ok(await other.admin.post(`/api/tournaments/${other.tid}/actions/cancel`, {}));
    await other.s.settle();
    other.s.clock.advance(60);
    await other.s.settle();
    expect(other.s.discord.sent.filter((m) => m.kind === 'channel').every((m) => other.s.discord.messages.has(m.id!))).toBe(true);
  });

  it('"Vote on date first" in settings: the vote goes live on publish, can gain times, and ends the setting', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true, name: 'host' });
    const hours = (h: number) => new Date(s.clock.t + h * 3600_000).toISOString();
    const options = [hours(72), hours(48)];
    const t = ok(await admin.post('/api/tournaments', {
      guildId: GUILD, name: 'Settings Vote Cup',
      config: { format: 'single_elim', teamSize: 1, notifications: { announcementChannelId: ANNOUNCE, registrationChannelId: REG }, schedule: { startAt: hours(10), autoStart: true, startVote: { enabled: true, options, closesAt: hours(24) } } },
    })).body;
    const tid = t.id as number;
    const detail = async () => ok(await admin.get(`/api/tournaments/${tid}`)).body;
    let d = await detail();
    // A draft only stores the vote; the start time is left to the vote.
    expect(d.startPoll).toBeNull();
    expect(d.tournament.config.schedule.startAt).toBeNull();
    await s.settle();
    expect(s.discord.sent.some((m) => /When should/.test(m.content))).toBe(false);

    const pub = ok(await admin.post(`/api/tournaments/${tid}/actions/publish`)).body;
    expect(pub.state).toBe('published');
    await s.settle();
    d = await detail();
    expect(d.startPoll.status).toBe('open');
    // Listed in time order; index is the stored position.
    expect(d.startPoll.options.map((o: any) => o.at)).toEqual([options[1], options[0]]);
    const card = s.discord.sent.find((m) => m.kind === 'channel' && /When should/.test(m.content))!;
    expect(card.target).toBe(REG);
    expect(card.content).toContain(`Details and sign-up: <${s.ctx.env.WEB_URL}/#/t/${tid}>`);

    // Back to draft is blocked while players vote.
    expect((await admin.post(`/api/tournaments/${tid}/actions/unpublish`)).status).toBe(409);

    const ps = await Promise.all([10, 11].map((n) => s.login(n, { name: `player${n}` })));
    const first = d.startPoll.options[0].index;
    ok(await ps[0].post(`/api/tournaments/${tid}/start-poll/vote`, { options: [first] }));

    // Add a time while the vote runs: votes stay on their time, the card gains a button.
    const cfg = d.tournament.config;
    const extra = hours(36);
    const patch = (startVote: Record<string, unknown>) => admin.patch(`/api/tournaments/${tid}`, { configPatch: { schedule: { startVote: { ...cfg.schedule.startVote, ...startVote } } } });
    ok(await patch({ options: [...cfg.schedule.startVote.options, extra] }));
    await s.settle();
    d = await detail();
    expect(d.startPoll.options.map((o: any) => o.at)).toEqual([extra, options[1], options[0]]);
    expect(d.startPoll.options.find((o: any) => o.at === options[1]).votes).toBe(1);
    expect(s.discord.messages.get(card.id!)!.buttons!.length).toBe(3);
    ok(await ps[1].post(`/api/tournaments/${tid}/start-poll/vote`, { options: [d.startPoll.options[0].index, first] }));

    // Removing a time or switching the vote off needs Cancel vote first.
    expect((await patch({ options: [options[0], extra] })).status).toBe(409);
    expect((await admin.patch(`/api/tournaments/${tid}`, { configPatch: { schedule: { autoStart: false, startVote: { enabled: false } } } })).status).toBe(409);
    // A deadline in the past is refused.
    expect((await patch({ options: [...options, extra], closesAt: hours(-1) })).status).toBe(400);

    // Organizers can see who voted for each time.
    const voters = (await detail()).startPoll.voters;
    expect(voters.find((v: any) => v.userId === ps[1].id).options.sort()).toEqual([first, d.startPoll.options[0].index].sort());

    ok(await admin.post(`/api/tournaments/${tid}/start-poll/close`, {}));
    await s.settle();
    d = await detail();
    expect(d.tournament.state).toBe('registration_open');
    expect(d.tournament.config.schedule.startAt).toBe(options[1]);
    expect(d.tournament.config.schedule.startVote.enabled).toBe(false);
    expect(s.discord.messages.get(card.id!)!.content).toContain(`<${s.ctx.env.WEB_URL}/#/t/${tid}>`);
  });

  it('publishing with a vote whose deadline has passed is refused with the reason', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true, name: 'host' });
    const hours = (h: number) => new Date(s.clock.t + h * 3600_000).toISOString();
    const t = ok(await admin.post('/api/tournaments', {
      guildId: GUILD, name: 'Late Vote Cup', config: { format: 'single_elim', teamSize: 1, schedule: { startVote: { enabled: true, options: [hours(48), hours(72)], closesAt: hours(2) } } },
    })).body;
    s.clock.advance(3 * 60);
    const r = await admin.post(`/api/tournaments/${t.id}/actions/publish`);
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/deadline has passed/);
    expect(ok(await admin.get(`/api/tournaments/${t.id}`)).body.tournament.state).toBe('draft');
    // Created with "Publish now", the vote goes live at once.
    const t2 = ok(await admin.post('/api/tournaments', {
      guildId: GUILD, name: 'Now Vote Cup', publish: true, config: { format: 'single_elim', teamSize: 1, schedule: { startVote: { enabled: true, options: [hours(48), hours(72)], closesAt: hours(24) } } },
    })).body;
    expect(ok(await admin.get(`/api/tournaments/${t2.id}`)).body.startPoll.status).toBe('open');
    // Settings checks: times must come after the deadline.
    expect((await admin.post('/api/tournaments', { guildId: GUILD, name: 'Bad Vote Cup', config: { schedule: { startVote: { enabled: true, options: [hours(5), hours(72)], closesAt: hours(24) } } } })).status).toBe(400);
  });
});
