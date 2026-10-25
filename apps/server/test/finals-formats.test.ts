import { describe, expect, it } from 'vitest';
import { ANNOUNCE, GUILD, ok, setup } from './helpers.js';

const RANKS = ['supersonic_legend', 'grand_champion_3', 'grand_champion_1', 'champion_3', 'champion_2', 'champion_1', 'diamond_3', 'diamond_2', 'diamond_1', 'platinum_3', 'platinum_2', 'platinum_1', 'gold_3', 'gold_2', 'gold_1', 'silver_3'];

/** 3 pools of 8, every group match played. */
async function groupStageDone(sixmans: Record<string, unknown>) {
  const s = await setup();
  const admin = await s.login(1, { admin: true, name: 'host' });
  const t = ok(await admin.post('/api/tournaments', {
    guildId: GUILD, name: 'Finals Night',
    config: { format: 'sixmans', notifications: { announcementChannelId: ANNOUNCE }, voice: { enabled: false }, sixmans: { poolCount: 3, roundsMode: 'fixed', roundsPerPool: 2, ...sixmans } },
  })).body;
  const tid = t.id as number;
  ok(await admin.post(`/api/tournaments/${tid}/actions/publish`));
  ok(await admin.post(`/api/tournaments/${tid}/actions/open_registration`));
  for (let i = 0; i < 24; i++) ok(await (await s.login(100 + i)).post(`/api/tournaments/${tid}/register`, { rank: RANKS[i % RANKS.length] }));
  ok(await admin.post(`/api/tournaments/${tid}/sixmans/pools`, {}));
  ok(await admin.post(`/api/tournaments/${tid}/sixmans/pools/confirm`));
  ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule`, { rounds: 2 }));
  ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule/confirm`));
  ok(await admin.post(`/api/tournaments/${tid}/actions/start`));
  const get = async () => ok(await admin.get(`/api/tournaments/${tid}`)).body;
  const playAll = async () => {
    for (let guard = 0; guard < 80; guard++) {
      const m = (await get()).matches.find((x: any) => x.status === 'ready');
      if (!m) break;
      ok(await admin.post(`/api/matches/${m.id}/resolve`, { games: [{ a: 3, b: m.id % 3 }] }));
      await s.settle();
    }
  };
  await playAll();
  return { s, admin, tid, get, playAll };
}

describe('6mans finals formats', () => {
  it('top 6 of each of 3 pools, pool based teams, double elimination to a champion', async () => {
    const { s, admin, tid, get, playAll } = await groupStageDone({ qualifiersPerPool: 6, finalsBracket: 'double_elim', finalsTeamFormation: 'pool_snake' });
    let d = await get();
    expect(d.tournament.stage).toBe('group_complete');
    const plan = d.sixmans.finals.data;
    expect(plan.qualified.length).toBe(18);
    expect(plan.bracketFormat).toBe('double_elim');
    expect(plan.formation).toBe('pool_snake');
    expect(plan.teams.length).toBe(6);
    const poolOf = new Map<string, number>(plan.qualified.map((q: any) => [q.playerId, q.poolIndex]));
    // Every team is three players from one pool, two teams per pool.
    for (const tm of plan.teams) expect(new Set(tm.players.map((u: string) => poolOf.get(u))).size).toBe(1);
    expect(plan.mixedPoolTeams).toBe(0);

    // Skill-balanced inside each pool keeps pools together too.
    const balanced = ok(await admin.post(`/api/tournaments/${tid}/sixmans/finals/preview`, { optionId: 'as_qualified', formation: 'pool_balanced' })).body;
    for (const tm of balanced.teams) expect(new Set(tm.players.map((u: string) => poolOf.get(u))).size).toBe(1);
    expect(balanced.bracketFormat).toBe('double_elim');

    // Swap two players, then switch the bracket: the edited teams stay.
    const teams = balanced.teams.map((tm: any) => ({ players: [...tm.players] }));
    [teams[0].players[0], teams[1].players[0]] = [teams[1].players[0], teams[0].players[0]];
    ok(await admin.put(`/api/tournaments/${tid}/sixmans/finals/teams`, { teams }));
    const single = ok(await admin.post(`/api/tournaments/${tid}/sixmans/finals/preview`, { bracketFormat: 'single_elim', thirdPlace: true })).body;
    expect(single.teams.map((tm: any) => tm.players)).toEqual(teams.map((tm: any) => tm.players));
    expect(single.bracketFormat).toBe('single_elim');
    const dbl = ok(await admin.post(`/api/tournaments/${tid}/sixmans/finals/preview`, { bracketFormat: 'double_elim', grandFinalReset: false })).body;
    expect(dbl.teams.map((tm: any) => tm.players)).toEqual(teams.map((tm: any) => tm.players));

    // Settings that are not locked stay editable on a running tournament, even when the stored
    // snapshot of the locked settings predates settings added since (older tournaments).
    const lock = (s.ctx.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tournaments_format_lock'").get() as { sql: string }).sql;
    s.ctx.db.exec('DROP TRIGGER tournaments_format_lock');
    s.ctx.db.prepare('UPDATE tournaments SET structure = ? WHERE id = ?').run('{"old":true}', tid);
    s.ctx.db.exec(lock);
    const v = (await get()).tournament.version;
    ok(await admin.patch(`/api/tournaments/${tid}`, { configPatch: { notifications: { dms: false } }, expectedVersion: v }));
    expect((await admin.patch(`/api/tournaments/${tid}`, { configPatch: { sixmans: { finalsBracket: 'single_elim' } } })).status).toBe(409);

    ok(await admin.post(`/api/tournaments/${tid}/sixmans/finals/start`));
    d = await get();
    const finals = d.matches.filter((m: any) => m.stage === 'finals');
    expect(new Set(finals.map((m: any) => m.bracket))).toEqual(new Set(['winners', 'losers', 'grand_final']));
    expect(finals.find((m: any) => m.bracket === 'losers').label).toMatch(/^Finals · Losers/);

    await playAll();
    d = await get();
    expect(d.tournament.state).toBe('completed');
    const gf = d.matches.find((m: any) => m.bracket === 'grand_final');
    expect(gf.status).toBe('completed');
  });

  it('single elimination finals with a third-place match', async () => {
    const { admin, tid, get, playAll } = await groupStageDone({ qualifiersPerPool: 4, finalsThirdPlace: true, finalsTeamFormation: 'pool_balanced' });
    const plan = (await get()).sixmans.finals.data;
    // 12 qualifiers = 4 teams. 4 per pool is not a multiple of 3, so leftovers are mixed.
    expect(plan.teams.length).toBe(4);
    expect(plan.mixedPoolTeams).toBeGreaterThan(0);
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/finals/start`));
    expect((await get()).matches.some((m: any) => m.bracket === 'third_place')).toBe(true);
    await playAll();
    expect((await get()).tournament.state).toBe('completed');
  });
});
