import { describe, expect, it } from 'vitest';
import { ANNOUNCE, GUILD, OTHER_GUILD, ok, play, setup, uid, type Client } from './helpers.js';

async function makeTournament(s: Awaited<ReturnType<typeof setup>>, admin: Client, config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Friday Cup', config: { notifications: { announcementChannelId: ANNOUNCE }, ...config }, ...extra })).body;
  ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
  ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
  return t.id as number;
}

describe('single elimination 1v1, end to end through the API', () => {
  it('runs registration, start, reporting with confirmation, voice and notifications', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true, name: 'organizer' });
    const tid = await makeTournament(s, admin, { format: 'single_elim', teamSize: 1, series: { bestOf: 3 }, voice: { enabled: true } });
    const players = new Map<string, Client>();
    for (let i = 10; i < 15; i++) {
      const c = await s.login(i);
      players.set(c.id, c);
      ok(await c.post(`/api/tournaments/${tid}/register`, {}));
    }
    // Duplicate registration is rejected.
    expect((await players.get(uid(10))!.post(`/api/tournaments/${tid}/register`, {})).status).toBe(409);
    // A non-manager cannot start the tournament.
    expect((await players.get(uid(10))!.post(`/api/tournaments/${tid}/actions/start`)).status).toBe(403);

    ok(await admin.post(`/api/tournaments/${tid}/actions/close_registration`));
    const started = ok(await admin.post(`/api/tournaments/${tid}/actions/start`)).body;
    expect(started.state).toBe('in_progress');
    await s.settle();

    // Format is locked after start, both via API and directly in the database.
    expect((await admin.patch(`/api/tournaments/${tid}`, { configPatch: { format: 'swiss' } })).status).toBe(409);
    expect(() => s.db.prepare("UPDATE tournaments SET structure = 'x' WHERE id = ?").run(tid)).toThrow(/FORMAT_LOCKED/);
    // Non-structural settings remain editable.
    ok(await admin.patch(`/api/tournaments/${tid}`, { configPatch: { notifications: { matchReminders: [10] } } }));

    let d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    expect(d.competitors.length).toBe(5);
    const ready = d.matches.filter((m: any) => m.status === 'ready');
    expect(ready.length).toBeGreaterThan(0);
    // 1v1: one private voice channel per player.
    const vc = [...s.discord.channels.values()].filter((c) => c.type === 'voice');
    expect(vc.length).toBe(ready.length * 2);
    expect(vc.every((c) => c.memberIds.length === 1)).toBe(true);
    // Players were DMed their match.
    expect(s.discord.sent.some((m) => m.kind === 'dm' && m.target === uid(10))).toBe(true);

    // The same user cannot report and confirm; an unrelated player cannot report.
    const m1 = ready[0];
    const aUser = players.get(m1.a.players[0].userId)!;
    const bUser = players.get(m1.b.players[0].userId)!;
    const outsider = [...players.values()].find((p) => p.id !== aUser.id && p.id !== bUser.id)!;
    expect((await outsider.post(`/api/matches/${m1.id}/report`, { games: [{ a: 1, b: 0 }, { a: 1, b: 0 }] })).status).toBe(403);
    expect(ok(await aUser.post(`/api/matches/${m1.id}/report`, { games: [{ a: 3, b: 1 }, { a: 2, b: 0 }] })).body.outcome).toBe('awaiting_confirmation');
    expect((await aUser.post(`/api/matches/${m1.id}/confirm`)).status).toBe(409);
    // Invalid series is rejected server-side.
    expect((await bUser.post(`/api/matches/${m1.id}/dispute`, { reason: 'no', counter: { games: [{ a: 1, b: 1 }] } })).status).toBe(400);
    ok(await bUser.post(`/api/matches/${m1.id}/confirm`));
    await s.settle();
    const done = ok(await admin.get(`/api/matches/${m1.id}`)).body.match;
    expect(done.status).toBe('completed');
    expect(done.winner).toBe('a');
    // Completed match voice channels are deleted.
    const rows = s.db.prepare('SELECT channel_id, status FROM voice_channels WHERE match_id = ?').all(m1.id) as { channel_id: string; status: string }[];
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.status).toBe('deleted');
      expect(s.discord.channels.has(r.channel_id)).toBe(false);
    }
    // Completed results cannot be edited directly in the database.
    expect(() => s.db.prepare('UPDATE matches SET winner = ? WHERE id = ?').run('b', m1.id)).toThrow(/COMPLETED_MATCH_IMMUTABLE/);

    // Play the rest (higher seed wins).
    for (let guard = 0; guard < 10; guard++) {
      d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
      const next = d.matches.find((m: any) => m.status === 'ready');
      if (!next) break;
      await play(players, next.id, [{ a: 2, b: 1 }, { a: 2, b: 1 }]);
      await s.settle();
    }
    d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    expect(d.tournament.state).toBe('completed');
    expect(d.placements[0].placement).toBe(1);
    expect(d.tournament.championCompetitorId).toBe(d.placements[0].competitorId);
    expect([...s.discord.channels.values()].filter((c) => c.type === 'voice').length).toBe(0);
    expect(s.discord.sent.some((m) => m.kind === 'channel' && m.target === ANNOUNCE && /champion|won|winner/i.test(m.content))).toBe(true);

    // History & exports.
    const csv = await s.call('GET', `/api/tournaments/${tid}/export/results.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n').length).toBeGreaterThan(3);
    const profile = ok(await s.call('GET', `/api/players/${d.placements[0].players[0].userId}`)).body;
    expect(profile.history.length).toBe(1);
    expect(profile.totals.titles).toBe(1);
    const audit = ok(await admin.get(`/api/tournaments/${tid}/audit`)).body;
    expect(audit.some((a: any) => a.action.includes('result'))).toBe(true);
    expect((await outsider.get(`/api/tournaments/${tid}/audit`)).status).toBe(403);
  });

  it('organizer correction after downstream matches requires explicit confirmation and resets dependents', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const tid = await makeTournament(s, admin, { format: 'single_elim', teamSize: 1, series: { bestOf: 1 }, voice: { enabled: false } });
    const players = new Map<string, Client>();
    for (let i = 10; i < 18; i++) {
      const c = await s.login(i);
      players.set(c.id, c);
      ok(await c.post(`/api/tournaments/${tid}/register`, {}));
    }
    ok(await admin.post(`/api/tournaments/${tid}/actions/start`));
    let d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    const r1 = d.matches.filter((m: any) => m.round === 1);
    expect(r1.length).toBe(4);
    for (const m of r1) await play(players, m.id, [{ a: 3, b: 0 }]);
    d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    // Find the semifinal fed by r1[0] and r1[1].
    const semi = d.matches.find((m: any) => m.round === 2 && [m.sourceA?.matchKey, m.sourceB?.matchKey].includes(r1[0].key));
    expect(semi.status).toBe('ready');

    // Correction while the semifinal is only "ready": its slot is simply refilled.
    expect((await admin.post(`/api/matches/${r1[0].id}/resolve`, { games: [{ a: 0, b: 1 }] })).status).toBe(400); // reason required
    ok(await admin.post(`/api/matches/${r1[0].id}/resolve`, { games: [{ a: 0, b: 1 }], reason: 'Wrong score reported' }));
    d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    let corrected = d.matches.find((m: any) => m.id === r1[0].id);
    let semiNow = d.matches.find((m: any) => m.id === semi.id);
    expect(corrected.winner).toBe('b');
    const slot = semi.sourceA.matchKey === r1[0].key ? 'a' : 'b';
    expect(semiNow[slot].competitorId).toBe(corrected.b.competitorId);

    // Play the semifinal, then correct round 1 again: refused without explicit confirmation.
    await play(players, semi.id, [{ a: 1, b: 0 }]);
    const refused = await admin.post(`/api/matches/${r1[0].id}/resolve`, { games: [{ a: 2, b: 0 }], reason: 'Replay showed A won' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('downstream_impact');
    expect(refused.body.error.details.matches.map((m: any) => m.id)).toContain(semi.id);
    ok(await admin.post(`/api/matches/${r1[0].id}/resolve`, { games: [{ a: 2, b: 0 }], reason: 'Replay showed A won', confirmDownstream: true }));
    d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    corrected = d.matches.find((m: any) => m.id === r1[0].id);
    semiNow = d.matches.find((m: any) => m.id === semi.id);
    expect(corrected.winner).toBe('a');
    expect(semiNow.status).toBe('ready');
    expect(semiNow.winner).toBeNull();
    expect(semiNow[slot].competitorId).toBe(corrected.a.competitorId);
    const audit = ok(await admin.get(`/api/tournaments/${tid}/audit`)).body;
    expect(audit.filter((a: any) => a.action === 'result.corrected').length).toBe(2);
  });

  it('disputes block progress until an organizer resolves them', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const tid = await makeTournament(s, admin, { format: 'single_elim', teamSize: 1, series: { bestOf: 1 }, voice: { enabled: false } });
    const players = new Map<string, Client>();
    for (let i = 10; i < 12; i++) {
      const c = await s.login(i);
      players.set(c.id, c);
      ok(await c.post(`/api/tournaments/${tid}/register`, {}));
    }
    ok(await admin.post(`/api/tournaments/${tid}/actions/start`));
    const m = ok(await admin.get(`/api/tournaments/${tid}`)).body.matches[0];
    const a = players.get(m.a.players[0].userId)!;
    const b = players.get(m.b.players[0].userId)!;
    ok(await a.post(`/api/matches/${m.id}/report`, { games: [{ a: 2, b: 1 }] }));
    // B reports the opposite result => dispute.
    expect(ok(await b.post(`/api/matches/${m.id}/report`, { games: [{ a: 1, b: 2 }] })).body.outcome).toBe('disputed');
    await s.settle();
    expect(s.discord.sent.some((x) => x.kind === 'dm' && x.target === admin.id && /disput|conflicting/i.test(x.content))).toBe(true);
    expect((await a.post(`/api/matches/${m.id}/confirm`)).status).toBe(409);
    ok(await admin.post(`/api/matches/${m.id}/resolve`, { games: [{ a: 2, b: 1 }], reason: 'Checked replay' }));
    const d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    expect(d.tournament.state).toBe('completed');
  });

  it('enforces server isolation and private visibility', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const stranger = await s.login(50, { guild: OTHER_GUILD, admin: true });
    const member = await s.login(51);
    const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Secret Scrims', visibility: 'private', config: { format: 'single_elim', teamSize: 1 } })).body;
    ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
    // Admin of another server cannot create tournaments in this server.
    expect((await stranger.post('/api/tournaments', { guildId: GUILD, name: 'Intruder', config: {} })).status).toBe(403);
    // Private tournament: invisible (404) to non-invited, in lists, exports and player search.
    for (const c of [stranger, member]) {
      expect((await c.get(`/api/tournaments/${t.id}`)).status).toBe(404);
      expect(ok(await c.get(`/api/tournaments?guildId=${GUILD}`)).body.find((x: any) => x.id === t.id)).toBeUndefined();
      expect((await c.get(`/api/tournaments/${t.id}/export/participants`)).status).toBe(404);
      expect((await c.get(`/api/tournaments/${t.id}/version`)).status).toBe(404);
    }
    expect((await s.anon.get(`/api/tournaments/${t.id}`)).status).toBe(404);
    // Invited viewers can see it.
    ok(await admin.post(`/api/tournaments/${t.id}/invites`, { userId: member.id }));
    expect((await member.get(`/api/tournaments/${t.id}`)).status).toBe(200);
    // Presets are isolated per server.
    const p = ok(await admin.post(`/api/guilds/${GUILD}/presets`, { name: 'House rules', config: { format: 'swiss', teamSize: 2 } })).body;
    expect((await stranger.get(`/api/presets/${p.id}`)).status).toBe(404);
    expect((await stranger.post('/api/tournaments', { guildId: OTHER_GUILD, name: 'Copycat', presetId: p.id })).status).toBe(404);
    expect((await member.post(`/api/guilds/${GUILD}/presets`, { name: 'Mine', config: {} })).status).toBe(403);
    expect([403, 404]).toContain((await stranger.get(`/api/guilds/${GUILD}/presets`)).status);
  });

  it('applies a preset only before start, with a preview diff; tournaments keep a snapshot', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const p = ok(await admin.post(`/api/guilds/${GUILD}/presets`, { name: 'Bo5 Swiss', config: { format: 'swiss', teamSize: 2, series: { bestOf: 5 } } })).body;
    const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'From preset', presetId: p.id })).body;
    let d = ok(await admin.get(`/api/tournaments/${t.id}`)).body;
    expect(d.tournament.config.format).toBe('swiss');
    expect(d.tournament.config.series.bestOf).toBe(5);
    // Editing the preset later does not change the tournament.
    ok(await admin.patch(`/api/presets/${p.id}`, { config: { format: 'swiss', teamSize: 2, series: { bestOf: 7 } } }));
    d = ok(await admin.get(`/api/tournaments/${t.id}`)).body;
    expect(d.tournament.config.series.bestOf).toBe(5);
    const prev = ok(await admin.post(`/api/tournaments/${t.id}/preset-preview`, { presetId: p.id })).body;
    expect(prev.changes.map((c: any) => c.path)).toContain('series.bestOf');
    ok(await admin.post(`/api/tournaments/${t.id}/apply-preset`, { presetId: p.id }));
    d = ok(await admin.get(`/api/tournaments/${t.id}`)).body;
    expect(d.tournament.config.series.bestOf).toBe(7);
    // Deleting a preset leaves tournaments intact.
    ok(await admin.del(`/api/presets/${p.id}`));
    expect(ok(await admin.get(`/api/tournaments/${t.id}`)).body.tournament.config.series.bestOf).toBe(7);
  });

  it('Idempotency-Key replays the first response instead of acting twice', async () => {
    const s = await setup();
    const admin = await s.login(1, { admin: true });
    const a = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Once' }, { 'idempotency-key': 'abc123' })).body;
    const b = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Once' }, { 'idempotency-key': 'abc123' })).body;
    expect(a.id).toBe(b.id);
    expect((s.db.prepare("SELECT COUNT(*) c FROM tournaments WHERE name = 'Once'").get() as { c: number }).c).toBe(1);
  });
});
