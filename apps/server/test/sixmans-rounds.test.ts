import { describe, expect, it } from 'vitest';
import { GUILD, ok, setup } from './helpers.js';

const RANKS = ['supersonic_legend', 'grand_champion_3', 'grand_champion_1', 'champion_3', 'champion_2', 'champion_1', 'diamond_3', 'diamond_2', 'diamond_1', 'platinum_3', 'platinum_2', 'platinum_1', 'gold_3', 'gold_2', 'gold_1', 'silver_3', 'silver_1'];

async function pooled(n: number, sixmans: Record<string, unknown>) {
  const s = await setup();
  const admin = await s.login(1, { admin: true });
  const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Auto rounds', config: { format: 'sixmans', sixmans } })).body;
  ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
  ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
  for (let i = 0; i < n; i++) ok(await (await s.login(300 + i)).post(`/api/tournaments/${t.id}/register`, { rank: RANKS[i % RANKS.length] }));
  ok(await admin.post(`/api/tournaments/${t.id}/sixmans/pools`, {}));
  ok(await admin.post(`/api/tournaments/${t.id}/sixmans/pools/confirm`));
  return { s, admin, tid: t.id as number };
}

describe('6mans automatic rounds per pool', () => {
  it('17 players in 2 pools: 9 and 8 rounds, everyone plays 6 games through the whole group stage', async () => {
    const { s, admin, tid } = await pooled(17, { poolCount: 2 });
    const sc = ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule`, {})).body;
    expect(sc.mode).toBe('equal_games');
    expect(sc.games).toBe(6);
    expect(sc.pools.map((p: any) => [p.playerIds.length, p.rounds, p.result.rounds.length])).toEqual([[9, 9, 9], [8, 8, 8]]);
    for (const p of sc.pools) expect(new Set(Object.values(p.result.appearances))).toEqual(new Set([6]));
    expect(sc.notes.join(' ')).toMatch(/bigger pool plays more rounds/);
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule/confirm`));
    ok(await admin.post(`/api/tournaments/${tid}/actions/start`));
    for (let guard = 0; guard < 40; guard++) {
      const m = (ok(await admin.get(`/api/tournaments/${tid}`)).body.matches as any[]).find((x) => x.status === 'ready' && x.stage === 'group');
      if (!m) break;
      ok(await admin.post(`/api/matches/${m.id}/resolve`, { games: [{ a: 3, b: m.id % 3 }] }));
    }
    await s.settle();
    const d = ok(await admin.get(`/api/tournaments/${tid}`)).body;
    expect(d.matches.filter((m: any) => m.stage === 'group').length).toBe(17);
    expect(d.tournament.stage).toBe('group_complete');
    for (const p of d.sixmans.standings) for (const r of p.standings) expect(r.played).toBe(6);
  });

  it('a games-per-player wish is rounded up; fixed rounds still work and are explicit', async () => {
    const { admin, tid } = await pooled(16, { poolCount: 2 });
    const four = ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule`, { games: 4 })).body;
    expect(four.games).toBe(6);
    expect(four.pools.map((p: any) => p.rounds)).toEqual([8, 8]);
    expect(four.notes.join(' ')).toMatch(/rounded up to 6/);
    const fixed = ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule`, { rounds: 3 })).body;
    expect(fixed.mode).toBe('fixed');
    expect(fixed.pools.map((p: any) => p.rounds)).toEqual([3, 3]);
    const cfg = ok(await admin.get(`/api/tournaments/${tid}`)).body.tournament.config.sixmans;
    expect(cfg).toMatchObject({ roundsMode: 'fixed', roundsPerPool: 3, gamesPerPlayer: 4 });
    // Switching back to automatic.
    const auto = ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule`, { mode: 'equal_games', games: null })).body;
    expect(auto.pools.map((p: any) => p.rounds)).toEqual([4, 4]);
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule/confirm`));
  });

  it('changing the games setting after confirming makes the schedule stale', async () => {
    const { admin, tid } = await pooled(12, { poolCount: 2 });
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule`, {}));
    ok(await admin.post(`/api/tournaments/${tid}/sixmans/schedule/confirm`));
    ok(await admin.patch(`/api/tournaments/${tid}`, { configPatch: { sixmans: { gamesPerPlayer: 6 } } }));
    const start = await admin.post(`/api/tournaments/${tid}/actions/start`);
    expect(start.status).toBe(409);
    expect(JSON.stringify(start.body)).toMatch(/schedule/i);
  });
});

describe('migration 003', () => {
  it('keeps fixed rounds for 6mans tournaments that already have a schedule or have started', async () => {
    const { readFileSync } = await import('node:fs');
    const { s, tid } = await pooled(12, { poolCount: 2, roundsMode: 'fixed' });
    const t2 = (await pooled(12, { poolCount: 2 }));
    // Simulate configs written before roundsMode existed.
    for (const [db, id] of [[s.db, tid], [t2.s.db, t2.tid]] as const) db.prepare("UPDATE tournaments SET config = json_remove(config, '$.sixmans.roundsMode') WHERE id = ?").run(id);
    ok(await t2.admin.post(`/api/tournaments/${t2.tid}/sixmans/schedule`, { rounds: 4 }));
    t2.s.db.prepare("UPDATE tournaments SET config = json_remove(config, '$.sixmans.roundsMode') WHERE id = ?").run(t2.tid);
    const sql = readFileSync(new URL('../src/db/migrations/003_sixmans_rounds_mode.sql', import.meta.url), 'utf8');
    s.db.exec(sql);
    t2.s.db.exec(sql);
    const mode = (db: typeof s.db, id: number) => (db.prepare("SELECT json_extract(config, '$.sixmans.roundsMode') m FROM tournaments WHERE id = ?").get(id) as { m: string | null }).m;
    expect(mode(s.db, tid)).toBeNull(); // no schedule yet: gets the new automatic default
    expect(mode(t2.s.db, t2.tid)).toBe('fixed'); // already scheduled: unchanged behaviour
  });
});
