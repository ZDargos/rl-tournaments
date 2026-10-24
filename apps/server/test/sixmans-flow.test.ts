import { describe, expect, it } from 'vitest';
import { canonicalTrio, validateSchedule } from '@rl/core';
import { ANNOUNCE, GUILD, ok, setup, type Client } from './helpers.js';

const RANKS = ['supersonic_legend', 'grand_champion_3', 'grand_champion_1', 'champion_3', 'champion_2', 'champion_1', 'diamond_3', 'diamond_2', 'diamond_1', 'platinum_3', 'platinum_2', 'platinum_1', 'gold_3', 'gold_2', 'gold_1', 'silver_3'];

async function sixmans(n: number, extra: Record<string, unknown> = {}) {
  const s = await setup();
  const admin = await s.login(1, { admin: true, name: 'host' });
  const t = ok(await admin.post('/api/tournaments', {
    guildId: GUILD, name: '6mans Night', config: { format: 'sixmans', notifications: { announcementChannelId: ANNOUNCE }, voice: { enabled: true }, sixmans: { poolCount: 2, roundsPerPool: 4, ...extra } },
  })).body;
  ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
  ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
  const players = new Map<string, Client>();
  for (let i = 0; i < n; i++) {
    const c = await s.login(100 + i);
    players.set(c.id, c);
    ok(await c.post(`/api/tournaments/${t.id}/register`, { rank: RANKS[i % RANKS.length] }));
  }
  return { s, admin, tid: t.id as number, players };
}

describe('6mans end to end', () => {
  it('pools -> schedule (no repeated trios) -> group stage -> standings -> finals -> champion', async () => {
    const { s, admin, tid, players } = await sixmans(16);
    // Starting before pools/schedule are confirmed is blocked with a clear reason.
    const early = await admin.post(`/api/tournaments/${tid}/actions/start`);
    expect(early.status).toBe(409);
    expect(JSON.stringify(early.body)).toMatch(/pool/i);

    const pools = ok(await admin.post(`/api/tournaments/${tid}/sixmans/pools`, {})).body;
    expect(pools.pools.map((p: any) => p.players.length)).toEqual([8, 8]);
    // Every rank here is different and more than the shuffle range apart, so remaking gives the same pools.
    const again = ok(await admin.post(`/api/tournaments/${tid}/sixmans/pools`, {})).body;
    expect(again.pools).toEqual(pools.pools);
    // Organizer edit: swap one player between pools.
    const edited = pools.pools.map((p: any) => p.players.map((x: any) => x.userId));
    [edited[0][0], edited[1][0]] = [edited[1][0], edited[0][0]];
    ok(await admin.put(`/api/tournaments/${tid}/sixmans/pools`, { pools: edited }));
    // Invalid edit (duplicate player) is rejected.
    expect((await admin.put(`/api/tournaments/${tid}/sixmans/pools`, { pools: [[...edited[0], edited[1][0]], edited[1]] })).status).toBe(400);
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/pools/confirm`));

    // Impossible request is reported, not silently weakened.
    const impossible = ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule`, { rounds: 40 })).body;
    expect(impossible.pools[0].result.status).toBe('infeasible');
    expect(impossible.pools[0].result.infeasibility.alternatives.length).toBeGreaterThan(0);
    expect((await admin.post(`/api/tournaments/${tid}/sixmans/schedule/confirm`)).status).toBe(409);

    const sched = ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule`, { rounds: 4 })).body;
    for (const p of sched.pools) {
      expect(p.result.status).toBe('ok');
      expect(validateSchedule(p.result, p.playerIds).valid).toBe(true);
      expect(Object.values(p.result.appearances)).toEqual(Array(8).fill(3));
    }
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule/confirm`));
    ok(await admin.post(`/api/tournaments/${tid}/actions/start`));
    await s.settle();

    let d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    const group = d.matches.filter((m: any) => m.stage === 'group');
    expect(group.length).toBe(8); // 2 pools x 4 rounds x 1 match
    // Trio rule holds across the stored matches.
    for (const pool of d.pools) {
      const trios = group.filter((m: any) => m.poolId === pool.id).flatMap((m: any) => [m.a, m.b].map((side: any) => canonicalTrio(side.players.map((p: any) => p.userId))));
      expect(new Set(trios).size).toBe(trios.length);
    }
    // And the database refuses a repeated trio outright.
    const row = s.db.prepare('SELECT st.* FROM sixmans_trios st JOIN pools p ON p.id = st.pool_id WHERE p.tournament_id = ? LIMIT 1').get(tid) as Record<string, unknown>;
    expect(() => s.db.prepare(`INSERT INTO sixmans_trios (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row))).toThrow(/UNIQUE|PRIMARY/);
    // Only round 1 is open per pool; voice channels exist for both teams of each ready match.
    const ready = group.filter((m: any) => m.status === 'ready');
    expect(ready.length).toBe(2);
    expect(ready.every((m: any) => m.round === 1)).toBe(true);
    expect([...s.discord.channels.values()].filter((c) => c.type === 'voice').length).toBe(4);

    // Play all group matches; team A wins by game score so goal difference matters.
    for (let guard = 0; guard < 20; guard++) {
      d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
      const m = d.matches.find((x: any) => x.status === 'ready' && x.stage === 'group');
      if (!m) break;
      const ca = players.get(m.a.players[1].userId)!;
      const cb = players.get(m.b.players[2].userId)!;
      ok(await ca.post(`/api/matches/${m.id}/report`, { games: [{ a: 2 + (m.round % 3), b: 1 }] }));
      ok(await cb.post(`/api/matches/${m.id}/confirm`));
      await s.settle();
    }
    d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    expect(d.tournament.stage).toBe('group_complete');
    // Standings: 3 points per win, everyone played 3.
    for (const p of d.sixmans.standings) {
      expect(p.standings.length).toBe(8);
      for (const r of p.standings) {
        expect(r.played).toBe(3);
        expect(r.points).toBe(r.wins * 3);
      }
      const ranks = p.standings.map((r: any) => r.rank);
      expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      // Sorted by points then goal difference.
      for (let i = 1; i < p.standings.length; i++) {
        const a = p.standings[i - 1];
        const b = p.standings[i];
        expect(a.points > b.points || (a.points === b.points && a.goalDiff >= b.goalDiff)).toBe(true);
      }
    }
    // Finals proposal: 2 pools => top 3 per pool => 6 players => 2 teams of 3.
    expect(d.sixmans.qualifiersPerPool).toBe(3);
    expect(d.sixmans.finals.status).toBe('proposed');
    const fin = d.sixmans.finals.data;
    expect(fin.teams.length).toBe(2);
    expect(fin.teams.every((t: any) => t.players.length === 3)).toBe(true);
    // Group results are now locked.
    const g1 = d.matches.find((m: any) => m.stage === 'group');
    expect((await admin.post(`/api/matches/${g1.id}/resolve`, { games: [{ a: 0, b: 1 }], reason: 'late fix' })).status).toBe(409);
    // Organizer edits finals teams (swap a player between the two teams).
    const teams = fin.teams.map((t: any) => ({ players: [...t.players] }));
    [teams[0].players[0], teams[1].players[0]] = [teams[1].players[0], teams[0].players[0]];
    ok(await admin.put(`/api/tournaments/${tid}/sixmans/finals/teams`, { teams }));
    expect((await admin.put(`/api/tournaments/${tid}/sixmans/finals/teams`, { teams: [{ players: teams[0].players }, { players: teams[0].players }] })).status).toBe(400);
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/finals/start`));
    await s.settle();
    d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    const final = d.matches.find((m: any) => m.stage === 'finals' && m.status === 'ready');
    expect(final).toBeDefined();
    ok(await players.get(final.a.players[0].userId)!.post(`/api/matches/${final.id}/report`, { games: [{ a: 3, b: 2 }] }));
    ok(await players.get(final.b.players[0].userId)!.post(`/api/matches/${final.id}/confirm`));
    await s.settle();
    d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    expect(d.tournament.state).toBe('completed');
    expect(d.placements[0].players.length).toBe(3);
    expect([...s.discord.channels.values()].filter((c) => c.type === 'voice').length).toBe(0);
    // Player profile keeps 6mans group record separate from team record.
    const champ = d.placements[0].players[0].userId;
    const prof = ok(await s.call('GET', `/api/players/${champ}`)).body;
    expect(prof.totals.sixmans.games).toBe(3);
    expect(prof.totals.titles).toBe(1);
    // Exports
    for (const kind of ['pools', 'schedule', 'standings', 'player_stats']) {
      const csv = await s.call('GET', `/api/tournaments/${tid}/export/${kind}`);
      expect(csv.status).toBe(200);
    }
  });

  it('non-managers never see skill values or unconfirmed proposals', async () => {
    const { admin, tid, players } = await sixmans(12);
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/pools`, {}));
    const viewer = [...players.values()][0];
    let d = ok(await viewer.get(`/api/tournaments/${tid}`)).body;
    expect(d.sixmans.pools).toBeNull();
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/pools/confirm`));
    d = ok(await viewer.get(`/api/tournaments/${tid}`)).body;
    expect(JSON.stringify(d.sixmans.pools)).not.toMatch(/"skill"/);
    expect(d.entries.filter((e: any) => e.userId !== viewer.id).every((e: any) => e.rank === null && e.seed === null)).toBe(true);
    // A player cannot run 6mans organizer actions.
    expect((await viewer.post(`/api/tournaments/${tid}/sixmans/schedule`, { rounds: 3 })).status).toBe(403);
  });

  it('uneven qualifiers produce finals options instead of silent changes', async () => {
    // 4 pools of 6, top 2 => 8 qualifiers (not a multiple of 3).
    const { s, admin, tid, players } = await sixmans(24, { poolCount: 4, roundsPerPool: 2 });
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/pools`, {}));
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/pools/confirm`));
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule`, { rounds: 2 }));
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule/confirm`));
    ok(await admin.post(`/api/tournaments/${tid}/actions/start`));
    for (let guard = 0; guard < 20; guard++) {
      const d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
      const m = d.matches.find((x: any) => x.status === 'ready');
      if (!m) break;
      ok(await admin.post(`/api/matches/${m.id}/resolve`, { games: [{ a: 1 + (m.id % 4), b: 0 }] }));
    }
    await s.settle();
    const d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    expect(d.sixmans.qualifiersPerPool).toBe(2);
    const opts = d.sixmans.finals.data.options.map((o: any) => o.id);
    expect(opts).toEqual(expect.arrayContaining(['expand', 'reduce']));
    const reduce = ok(await admin.post(`/api/tournaments/${tid}/sixmans/finals/preview`, { optionId: 'reduce' })).body;
    expect(reduce.teams.length).toBe(2);
    const expand = ok(await admin.post(`/api/tournaments/${tid}/sixmans/finals/preview`, { optionId: 'expand' })).body;
    expect(expand.teams.length).toBe(3);
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/finals/start`));
    const after = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    // 3 teams => 4-slot bracket with one bye.
    expect(after.matches.filter((m: any) => m.stage === 'finals' && m.walkover).length).toBe(1);
    void players;
  });
});
