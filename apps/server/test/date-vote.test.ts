import { describe, expect, it } from 'vitest';
import { handleInteraction, type BotInteraction } from '../src/discord/handlers.js';
import { ANNOUNCE, GUILD, ok, setup } from './helpers.js';

const REG = '300000000000000002';

let seq = 0;
const press = (userId: string, customId: string, guildId: string | null = GUILD): BotInteraction => ({
  id: `8400000000000${String(++seq).padStart(5, '0')}`, kind: 'button', guildId, user: { id: userId, username: `u${userId.slice(-3)}` },
  memberIsAdmin: false, memberRoleIds: [], command: '', subcommand: null, options: {}, customId,
});

/** A 1v1 tournament with a start time, registration open and three registered players (plus one who is not). */
async function withPlayers() {
  const s = await setup();
  const hours = (h: number) => new Date(s.clock.t + h * 3600_000).toISOString();
  const admin = await s.login(1, { admin: true, name: 'host' });
  const t = ok(await admin.post('/api/tournaments', {
    guildId: GUILD, name: 'Move Cup', publish: true,
    config: { format: 'single_elim', teamSize: 1, schedule: { startAt: hours(72) }, registration: { requireApproval: false }, notifications: { announcementChannelId: ANNOUNCE, registrationChannelId: REG } },
  })).body;
  ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
  const ps = await Promise.all([10, 11, 12].map((n) => s.login(n, { name: `player${n}` })));
  for (const p of ps) ok(await p.post(`/api/tournaments/${t.id}/register`, {}));
  const outsider = await s.login(20, { name: 'outsider' });
  await s.settle();
  const detail = async (c = admin) => ok(await c.get(`/api/tournaments/${t.id}`)).body;
  return { s, admin, ps, outsider, tid: t.id as number, hours, detail };
}

describe('date change vote', () => {
  it('asks every registered player, collects answers from DMs, the card and the website, and moves the start', async () => {
    const { s, admin, ps, outsider, tid, hours, detail } = await withPlayers();
    const newTime = hours(96);
    // Players cannot propose.
    expect((await ps[0].post(`/api/tournaments/${tid}/date-vote`, { proposedAt: newTime, reason: 'Server maintenance' })).status).toBe(403);
    expect(ok(await admin.post(`/api/tournaments/${tid}/date-vote`, { proposedAt: newTime, reason: 'Psyonix maintenance that evening' })).body.recipients).toBe(3);
    // Only one at a time.
    expect((await admin.post(`/api/tournaments/${tid}/date-vote`, { proposedAt: hours(120), reason: 'Another idea' })).status).toBe(409);
    await s.settle();

    // Every registered player got a DM with the reason and the two buttons; the outsider did not.
    const dms = s.discord.sent.filter((m) => m.kind === 'dm' && /want to move it/.test(m.content));
    expect(dms.map((m) => m.target).sort()).toEqual(ps.map((p) => p.id).sort());
    expect(dms[0].content).toMatch(/Psyonix maintenance/);
    const voteId = Number(dms[0].buttons![0].customId.split(':')[1]);
    expect(dms[0].buttons!.map((b) => b.customId)).toEqual([`dcv:${voteId}:yes`, `dcv:${voteId}:no`]);
    // And a card in the registration channel.
    const card = s.discord.sent.find((m) => m.kind === 'channel' && /Date change proposed/.test(m.content))!;
    expect(card.target).toBe(REG);

    // Answers: DM button, channel card button (changed answer), website.
    expect((await handleInteraction(s.ctx, press(ps[0].id, `dcv:${voteId}:yes`, null)))!.content).toMatch(/know you can make/);
    await handleInteraction(s.ctx, press(ps[1].id, `dcv:${voteId}:yes`));
    await handleInteraction(s.ctx, press(ps[1].id, `dcv:${voteId}:no`));
    expect((await handleInteraction(s.ctx, press(outsider.id, `dcv:${voteId}:yes`)))!.content).toMatch(/Only players registered/);
    expect((await outsider.post(`/api/tournaments/${tid}/date-vote/answer`, { answer: 'yes' })).status).toBe(403);

    // Players see counts and their own answer, not names.
    let mine = (await detail(ps[1])).dateVote;
    expect(mine).toMatchObject({ status: 'open', myAnswer: 'no', canAnswer: true, reason: 'Psyonix maintenance that evening', counts: { yes: 1, no: 1, waiting: 1 } });
    expect(mine.players).toBeUndefined();
    ok(await ps[2].post(`/api/tournaments/${tid}/date-vote/answer`, { answer: 'yes' }));
    await s.settle();
    // Organizers see every player's answer, and were told once everyone answered.
    const view = (await detail()).dateVote;
    expect(view.counts).toEqual({ yes: 2, no: 1, waiting: 0, total: 3 });
    expect(view.players.map((p: any) => [p.name, p.answer])).toEqual([['player10', 'yes'], ['player11', 'no'], ['player12', 'yes']]);
    expect(s.discord.sent.some((m) => m.kind === 'dm' && m.target === admin.id && /Everyone answered/.test(m.content))).toBe(true);
    expect(s.discord.messages.get(card.id!)!.content).toMatch(/\*\*2\*\* can make it/);

    // Move the date: start time changes, answers carry over as availability, players are told.
    expect((await ps[0].post(`/api/tournaments/${tid}/date-vote/close`, { decision: 'move' })).status).toBe(403);
    ok(await admin.post(`/api/tournaments/${tid}/date-vote/close`, { decision: 'move' }));
    await s.settle();
    const d = await detail();
    expect(d.tournament.config.schedule.startAt).toBe(newTime);
    expect(d.dateVote.status).toBe('applied');
    const avail = Object.fromEntries(d.entries.map((e: any) => [e.name, e.availability]));
    expect(avail).toEqual({ player10: 'confirmed', player11: 'declined', player12: 'confirmed' });
    expect(s.discord.sent.filter((m) => m.kind === 'dm' && /has moved to/.test(m.content)).length).toBe(3);
    expect(s.discord.messages.get(card.id!)!.buttons).toEqual([]);
    // Answering a finished vote is refused.
    expect((await handleInteraction(s.ctx, press(ps[2].id, `dcv:${voteId}:no`, null)))!.content).toMatch(/already moved/);
    mine = (await detail(ps[0])).dateVote;
    expect(mine.canAnswer).toBe(false);
  });

  it('keeping the date leaves the start alone and tells the players', async () => {
    const { s, admin, ps, tid, hours, detail } = await withPlayers();
    const before = (await detail()).tournament.config.schedule.startAt;
    ok(await admin.post(`/api/tournaments/${tid}/date-vote`, { proposedAt: hours(30), reason: 'Earlier works for more people?' }));
    ok(await ps[0].post(`/api/tournaments/${tid}/date-vote/answer`, { answer: 'no' }));
    ok(await admin.post(`/api/tournaments/${tid}/date-vote/close`, { decision: 'keep' }));
    await s.settle();
    const d = await detail();
    expect(d.tournament.config.schedule.startAt).toBe(before);
    expect(d.dateVote).toMatchObject({ status: 'kept', counts: { yes: 0, no: 1, waiting: 2 } });
    expect(s.discord.sent.filter((m) => m.kind === 'dm' && /is staying/.test(m.content)).length).toBe(3);
    // A new proposal is allowed once the last one ended.
    ok(await admin.post(`/api/tournaments/${tid}/date-vote`, { proposedAt: hours(40), reason: 'Trying another time' }));
  });

  it('refuses bad proposals and ends with the tournament', async () => {
    const { s, admin, tid, hours, detail } = await withPlayers();
    const start = (await detail()).tournament.config.schedule.startAt;
    expect((await admin.post(`/api/tournaments/${tid}/date-vote`, { proposedAt: hours(-1), reason: 'In the past' })).status).toBe(400);
    expect((await admin.post(`/api/tournaments/${tid}/date-vote`, { proposedAt: start, reason: 'Same time' })).status).toBe(400);
    expect((await admin.post(`/api/tournaments/${tid}/date-vote`, { proposedAt: hours(90), reason: '' })).status).toBe(400);
    ok(await admin.post(`/api/tournaments/${tid}/date-vote`, { proposedAt: hours(90), reason: 'Clash with RLCS' }));
    ok(await admin.post(`/api/tournaments/${tid}/actions/cancel`, { reason: 'test' }));
    await s.settle();
    expect((await detail()).dateVote.status).toBe('cancelled');
  });
});
