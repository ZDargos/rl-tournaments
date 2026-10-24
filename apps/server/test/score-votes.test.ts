import { describe, expect, it } from 'vitest';
import { handleInteraction, type BotInteraction } from '../src/discord/handlers.js';
import { tallyVotes } from '../src/services/results.js';
import { ANNOUNCE, GUILD, ok, setup, type Client } from './helpers.js';

const RANKS = ['champion_3', 'champion_2', 'champion_1', 'diamond_3', 'diamond_2', 'diamond_1', 'platinum_3', 'platinum_2'];
const SCORES = '300000000000000099';
const LOBBY = '400000000000000077';

let seq = 0;
const button = (userId: string, customId: string): BotInteraction => ({
  id: `8100000000000${String(++seq).padStart(5, '0')}`, kind: 'button', guildId: GUILD, guildName: 'RL Hub', user: { id: userId, username: `u${userId.slice(-3)}` },
  memberIsAdmin: false, memberRoleIds: [], command: '', subcommand: null, options: {}, customId,
});

/** 8-player, 1-pool 6mans that is already running, with vote cards and a lobby configured. */
async function running(extra: Record<string, unknown> = {}) {
  const s = await setup();
  s.discord.channels.set(SCORES, { id: SCORES, guildId: GUILD, name: 'scores', type: 'text', parentId: null, memberIds: [], organizerIds: [], viewerIds: [] });
  s.discord.channels.set(LOBBY, { id: LOBBY, guildId: GUILD, name: 'lobby', type: 'voice', parentId: null, memberIds: [], organizerIds: [], viewerIds: [] });
  const admin = await s.login(1, { admin: true, name: 'host' });
  const t = ok(await admin.post('/api/tournaments', {
    guildId: GUILD, name: 'Vote Night',
    config: {
      format: 'sixmans', notifications: { announcementChannelId: ANNOUNCE }, voice: { enabled: true, lobbyChannelId: LOBBY, lobbySeconds: 30 },
      scoreReports: { channelId: SCORES }, sixmans: { poolCount: 1, roundsPerPool: 4 }, ...extra,
    },
  })).body;
  ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
  ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
  const players = new Map<string, Client>();
  for (let i = 0; i < 8; i++) {
    const c = await s.login(100 + i);
    players.set(c.id, c);
    ok(await c.post(`/api/tournaments/${t.id}/register`, { rank: RANKS[i] }));
  }
  ok(await admin.post(`/api/tournaments/${t.id}/sixmans/pools`, {}));
  ok(await admin.post(`/api/tournaments/${t.id}/sixmans/pools/confirm`));
  ok(await admin.post(`/api/tournaments/${t.id}/sixmans/schedule`, { rounds: 4 }));
  ok(await admin.post(`/api/tournaments/${t.id}/sixmans/schedule/confirm`));
  ok(await admin.post(`/api/tournaments/${t.id}/actions/start`));
  await s.settle();
  const current = async () => (ok(await admin.get(`/api/tournaments/${t.id}`)).body.matches as any[]).find((m) => m.status === 'ready');
  return { s, admin, tid: t.id as number, players, current };
}

const sides = (m: any) => ({ a: m.a.players.map((p: any) => p.userId) as string[], b: m.b.players.map((p: any) => p.userId) as string[] });

describe('vote tally rules', () => {
  const v = (userId: string, voterSide: 'a' | 'b', winner: 'a' | 'b') => ({ userId, voterSide, winner });
  it('needs the vote count and, by default, a vote from each team', () => {
    const rules = { votesNeeded: 2, requireBothTeams: true };
    expect(tallyVotes([v('1', 'a', 'a')], rules).winner).toBeNull();
    expect(tallyVotes([v('1', 'a', 'a'), v('2', 'a', 'a')], rules).winner).toBeNull(); // one team alone
    expect(tallyVotes([v('1', 'a', 'a'), v('4', 'b', 'a')], rules).winner).toBe('a');
    expect(tallyVotes([v('1', 'a', 'a'), v('2', 'a', 'a')], { ...rules, requireBothTeams: false }).winner).toBe('a');
  });
  it('flags a conflict when both teams have enough votes for different winners', () => {
    const t = tallyVotes([v('1', 'a', 'a'), v('2', 'a', 'a'), v('4', 'b', 'b'), v('5', 'b', 'b')], { votesNeeded: 2, requireBothTeams: true });
    expect(t).toMatchObject({ a: 2, b: 2, winner: null, conflict: true });
  });
});

describe('Discord score report cards', () => {
  it('can show the players without pinging them', async () => {
    const { s, current } = await running({ scoreReports: { channelId: SCORES, mentionPlayers: false } });
    const m1 = await current();
    const card = s.discord.sent.find((x) => x.target === SCORES)!;
    const { a, b } = sides(m1);
    for (const u of [...a, ...b]) expect(card.content).toContain(`<@${u}>`);
    expect(card.mentions).toEqual([]);
  });

  it('posts a card per live match, counts votes, records the result and opens the next match', async () => {
    const { s, current, tid } = await running();
    const m1 = await current();
    const cards = s.discord.sent.filter((x) => x.target === SCORES);
    expect(cards.length).toBe(1);
    expect(cards[0].buttons!.map((b) => b.customId)).toEqual([`vote:${m1.id}:a`, `vote:${m1.id}:b`]);
    const { a, b } = sides(m1);
    expect(cards[0].mentions.sort()).toEqual([...a, ...b].sort());

    // Someone outside the match cannot vote.
    const outsider = [...Array(8).keys()].map((i) => `2000000000000${String(100 + i).padStart(5, '0')}`).find((u) => !a.includes(u) && !b.includes(u))!;
    expect((await handleInteraction(s.ctx, button(outsider, `vote:${m1.id}:a`)))!.content).toMatch(/Only the players/);

    // Two votes from the same team are not enough (one from each team is required).
    expect((await handleInteraction(s.ctx, button(a[0], `vote:${m1.id}:a`)))!.content).toMatch(/Vote counted/);
    expect((await handleInteraction(s.ctx, button(a[1], `vote:${m1.id}:a`)))!.content).toMatch(/Vote counted/);
    await s.settle();
    expect(s.discord.messages.get(cards[0].id!)!.content).toMatch(/Votes: 🔵 2 · 🟠 0/);
    expect((s.db.prepare('SELECT status FROM matches WHERE id = ?').get(m1.id) as { status: string }).status).toBe('ready');

    // A player of the other team agrees: result recorded.
    expect((await handleInteraction(s.ctx, button(b[0], `vote:${m1.id}:a`)))!.content).toMatch(/Result recorded/);
    await s.settle();
    const done = s.db.prepare('SELECT status, winner, wins_a, wins_b FROM matches WHERE id = ?').get(m1.id) as Record<string, unknown>;
    expect(done).toMatchObject({ status: 'completed', winner: 'a', wins_a: 1, wins_b: 0 });
    // The finished match's card is deleted: the channel only shows live matches.
    expect(s.discord.messages.has(cards[0].id!)).toBe(false);
    expect(s.discord.deletes.map((d) => d.messageId)).toEqual([cards[0].id]);
    const reports = s.db.prepare("SELECT kind, source FROM result_reports WHERE match_id = ? AND superseded = 0 ORDER BY id").all(m1.id) as { kind: string }[];
    expect(reports.map((r) => r.kind)).toEqual(['report', 'confirm', 'confirm']);
    expect(s.db.prepare("SELECT 1 FROM audit_events WHERE tournament_id = ? AND action = 'result.voted'").get(tid)).toBeTruthy();

    // The next match is open and has its own card; late clicks on the old card are refused.
    const m2 = await current();
    expect(m2.id).not.toBe(m1.id);
    expect(s.discord.sent.filter((x) => x.target === SCORES).length).toBe(2);
    expect((await handleInteraction(s.ctx, button(b[1], `vote:${m1.id}:b`)))!.content).toMatch(/already has a result/);
  });

  it('marks the match disputed when the teams vote for themselves', async () => {
    const { s, current } = await running();
    const m = await current();
    const { a, b } = sides(m);
    for (const u of a.slice(0, 2)) await handleInteraction(s.ctx, button(u, `vote:${m.id}:a`));
    await handleInteraction(s.ctx, button(b[0], `vote:${m.id}:b`));
    expect((await handleInteraction(s.ctx, button(b[1], `vote:${m.id}:b`)))!.content).toMatch(/disagree/);
    await s.settle();
    expect((s.db.prepare('SELECT status FROM matches WHERE id = ?').get(m.id) as { status: string }).status).toBe('disputed');
    const card = [...s.discord.messages.values()].find((x) => x.channelId === SCORES)!;
    expect(card.content).toMatch(/organizer will set the result/);
    expect(card.buttons).toEqual([]);
  });

  it('a player can change their vote; a website result also closes the card', async () => {
    const { s, current, players } = await running({ scoreReports: { channelId: SCORES, votesNeeded: 2, requireBothTeams: false } });
    const m = await current();
    const { a, b } = sides(m);
    await handleInteraction(s.ctx, button(a[0], `vote:${m.id}:b`));
    expect((await handleInteraction(s.ctx, button(a[0], `vote:${m.id}:a`)))!.content).toMatch(/🔵 1 · 🟠 0/);
    ok(await players.get(a[1])!.post(`/api/matches/${m.id}/report`, { games: [{ a: 3, b: 1 }] }));
    ok(await players.get(b[1])!.post(`/api/matches/${m.id}/confirm`));
    await s.settle();
    // The old card is gone; the only card left is the next live match's.
    const left = [...s.discord.messages.values()].filter((x) => x.channelId === SCORES);
    expect(left.length).toBe(1);
    expect(left[0].content).not.toContain(`Match ${m.id}**`);
    expect(left[0].buttons.length).toBe(2);
  });

  it('a disputed card stays until an organizer sets the result, then is deleted', async () => {
    const { s, admin, current } = await running();
    const m = await current();
    const { a, b } = sides(m);
    for (const u of a.slice(0, 2)) await handleInteraction(s.ctx, button(u, `vote:${m.id}:a`));
    for (const u of b.slice(0, 2)) await handleInteraction(s.ctx, button(u, `vote:${m.id}:b`));
    await s.settle();
    const cardId = s.discord.sent.find((x) => x.target === SCORES)!.id!;
    expect(s.discord.messages.get(cardId)!.content).toMatch(/organizer will set the result/);
    ok(await admin.post(`/api/matches/${m.id}/resolve`, { games: [{ a: 2, b: 1 }], reason: 'Checked the replay' }));
    await s.settle();
    expect(s.discord.messages.has(cardId)).toBe(false);
  });

  it('cleans up finished cards left over from before (even in completed tournaments)', async () => {
    const { s, tid, current } = await running();
    const m = await current();
    const cardId = s.discord.sent.find((x) => x.target === SCORES)!.id!;
    // Simulate an old closed card that was edited instead of deleted, in a tournament that has since ended.
    s.db.prepare("UPDATE match_cards SET status = 'closed' WHERE match_id = ?").run(m.id);
    s.db.prepare("UPDATE matches SET status = 'void' WHERE tournament_id = ? AND status IN ('ready','pending')").run(tid);
    s.db.prepare("UPDATE tournaments SET state = 'cancelled' WHERE id = ?").run(tid);
    await s.settle();
    expect(s.discord.messages.has(cardId)).toBe(false);
    expect(s.db.prepare('SELECT status, message_id FROM match_cards WHERE match_id = ?').get(m.id)).toEqual({ status: 'closed', message_id: null });
  });

  it('cards are not posted without a channel', async () => {
    const { s } = await running({ scoreReports: { channelId: null } });
    expect(s.discord.sent.filter((x) => x.buttons?.length).length).toBe(0);
  });
});

describe('between-games voice lobby', () => {
  it('moves finished players to the lobby, holds the next match for the timer, then moves them in', async () => {
    const { s, current } = await running({ scoreReports: { channelId: SCORES, votesNeeded: 2, requireBothTeams: false } });
    const m1 = await current();
    const { a, b } = sides(m1);
    const vc = s.db.prepare("SELECT slot, channel_id FROM voice_channels WHERE match_id = ? AND status = 'active'").all(m1.id) as { slot: string; channel_id: string }[];
    expect(vc.length).toBe(2);
    // Everyone is sitting in their team channel.
    for (const u of a) s.discord.voiceStates.set(`${GUILD}:${u}`, vc.find((x) => x.slot === 'a')!.channel_id);
    for (const u of b) s.discord.voiceStates.set(`${GUILD}:${u}`, vc.find((x) => x.slot === 'b')!.channel_id);
    await handleInteraction(s.ctx, button(a[0], `vote:${m1.id}:a`));
    await handleInteraction(s.ctx, button(a[1], `vote:${m1.id}:a`));
    await s.settle();
    for (const u of [...a, ...b]) expect(s.discord.voiceStates.get(`${GUILD}:${u}`)).toBe(LOBBY);

    // The next match is ready (card posted) but its voice channels wait for the lobby timer.
    const m2 = await current();
    expect(s.db.prepare("SELECT COUNT(*) c FROM voice_channels WHERE match_id = ? AND status = 'active'").get(m2.id)).toEqual({ c: 0 });
    s.clock.advance(0.25); // 15 s
    await s.settle();
    expect(s.db.prepare("SELECT COUNT(*) c FROM voice_channels WHERE match_id = ? AND status = 'active'").get(m2.id)).toEqual({ c: 0 });
    s.clock.advance(0.3); // 33 s total
    await s.settle();
    const next = s.db.prepare("SELECT channel_id, member_ids FROM voice_channels WHERE match_id = ? AND status = 'active'").all(m2.id) as { channel_id: string; member_ids: string }[];
    expect(next.length).toBe(2);
    // Players of the new match who were waiting in the lobby are moved into their team channel.
    for (const row of next) for (const u of JSON.parse(row.member_ids) as string[]) if ([...a, ...b].includes(u)) expect(s.discord.voiceStates.get(`${GUILD}:${u}`)).toBe(row.channel_id);
  });

  it('lobby time has a minimum of one second', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const r = await admin.post('/api/tournaments', { guildId: GUILD, name: 'x', config: { format: 'sixmans', voice: { lobbySeconds: 0 } } });
    expect(r.status).toBe(400);
  });
});

describe('hand-picked finals and fresh proposals', () => {
  it('remaking pools and regenerating schedules use a new seed each time', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Seeds', config: { format: 'sixmans', sixmans: { poolCount: 1, roundsPerPool: 4 } } })).body;
    ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
    ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
    for (let i = 0; i < 9; i++) ok(await (await s.login(200 + i)).post(`/api/tournaments/${t.id}/register`, { rank: 'diamond_2' }));
    const seeds = new Set<number>();
    for (let i = 0; i < 3; i++) seeds.add(ok(await admin.post(`/api/tournaments/${t.id}/sixmans/pools`, {})).body.seed);
    expect(seeds.size).toBe(3);
    ok(await admin.post(`/api/tournaments/${t.id}/sixmans/pools/confirm`));
    const schedules = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const sc = ok(await admin.post(`/api/tournaments/${t.id}/sixmans/schedule`, { rounds: 4 })).body;
      expect(sc.pools[0].result.status).toBe('ok');
      schedules.add(JSON.stringify(sc.pools[0].result.rounds));
    }
    expect(schedules.size).toBeGreaterThan(1);
  });

  it('the organizer can hand-pick finals teams from any group players', async () => {
    const { s, admin, tid } = await running({ scoreReports: { channelId: null } });
    for (let guard = 0; guard < 10; guard++) {
      const m = (ok(await admin.get(`/api/tournaments/${tid}`)).body.matches as any[]).find((x) => x.status === 'ready');
      if (!m) break;
      ok(await admin.post(`/api/matches/${m.id}/resolve`, { games: [{ a: 2, b: 1 }] }));
    }
    await s.settle();
    const d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    expect(d.tournament.stage).toBe('group_complete');
    const plan = d.sixmans.finals.data;
    // Pick the 6 *lowest* finishers, which the automatic options would never choose.
    const bottom = [...plan.qualified, ...plan.others].sort((x: any, y: any) => y.poolRank - x.poolRank).slice(0, 6).map((q: any) => q.playerId);
    const teams = [{ players: bottom.slice(0, 3) }, { players: bottom.slice(3) }];
    expect((await admin.put(`/api/tournaments/${tid}/sixmans/finals/teams`, { teams })).status).toBe(400); // not hand-picked: must match the option
    const saved = ok(await admin.put(`/api/tournaments/${tid}/sixmans/finals/teams`, { teams, handPicked: true })).body;
    expect(saved.optionId).toBe('hand_picked');
    expect(saved.teams.map((x: any) => x.players)).toEqual(teams.map((x) => x.players));
    expect((await admin.put(`/api/tournaments/${tid}/sixmans/finals/teams`, { teams: [{ players: bottom.slice(0, 3) }, { players: [bottom[3], bottom[4], '299999999999999999'] }], handPicked: true })).status).toBe(400);
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/finals/start`));
    await s.settle();
    const after = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    const fin = after.matches.find((m: any) => m.stage === 'finals');
    expect([...fin.a.players, ...fin.b.players].map((p: any) => p.userId).sort()).toEqual(bottom.slice().sort());
  });
});

describe('Discord setup commands', () => {
  it('/tourney score-channel and /voice lobby update the tournament', async () => {
    const s = await setup();
    s.discord.addMember(GUILD, { userId: '200000000000000001', username: 'host', isAdmin: true });
    const admin = await s.login(1, { admin: true });
    const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Cmds', config: { format: 'sixmans' } })).body;
    const cmd = (command: string, subcommand: string, options: BotInteraction['options']): BotInteraction => ({ ...button(admin.id, ''), kind: 'command', command, subcommand, options, memberIsAdmin: true });
    expect((await handleInteraction(s.ctx, cmd('tourney', 'score-channel', { tournament: t.id, channel: SCORES, votes: 3 })))!.content).toMatch(/3 matching vote/);
    expect((await handleInteraction(s.ctx, cmd('voice', 'lobby', { tournament: t.id, channel: LOBBY, seconds: 5 })))!.content).toMatch(/5 second/);
    const cfg = ok(await admin.get(`/api/tournaments/${t.id}`)).body.tournament.config;
    expect(cfg.scoreReports).toMatchObject({ channelId: SCORES, votesNeeded: 3, requireBothTeams: true });
    expect(cfg.voice).toMatchObject({ lobbyChannelId: LOBBY, lobbySeconds: 5 });
    expect((await handleInteraction(s.ctx, cmd('tourney', 'score-channel', { tournament: t.id, off: true })))!.content).toMatch(/off/);
  });
});
