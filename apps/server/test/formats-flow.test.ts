import { describe, expect, it } from 'vitest';
import { GUILD, ok, play, setup, type Client } from './helpers.js';

async function run(config: Record<string, unknown>, n: number, opts: { teams?: boolean } = {}) {
  const s = await setup();
  const admin = await s.login(1, { admin: true });
  const t = ok(await admin.post('/api/tournaments', { guildId: GUILD, name: 'Format Test', config: { voice: { enabled: false }, ...config } })).body;
  ok(await admin.post(`/api/tournaments/${t.id}/actions/publish`));
  ok(await admin.post(`/api/tournaments/${t.id}/actions/open_registration`));
  const players = new Map<string, Client>();
  let k = 10;
  for (let i = 0; i < n; i++) {
    const captain = await s.login(k++);
    players.set(captain.id, captain);
    const e = ok(await captain.post(`/api/tournaments/${t.id}/register`, opts.teams ? { teamName: `Team ${i + 1}` } : {})).body;
    if (opts.teams) {
      const mate = await s.login(k++);
      players.set(mate.id, mate);
      const inv = ok(await captain.post(`/api/entries/${e.entryId}/invitations`, { userId: mate.id })).body;
      ok(await mate.post(`/api/invitations/${inv.invitationId}/accept`));
    }
  }
  ok(await admin.post(`/api/tournaments/${t.id}/actions/start`));
  return { s, admin, tid: t.id as number, players };
}

async function playAll(ctx: Awaited<ReturnType<typeof run>>, pick: (m: any) => { a: number; b: number }[] = () => [{ a: 1, b: 0 }, { a: 1, b: 0 }]) {
  for (let guard = 0; guard < 200; guard++) {
    const d = ok(await ctx.admin.get(`/api/tournaments/${ctx.tid}`)).body;
    const m = d.matches.find((x: any) => x.status === 'ready');
    if (!m) return d;
    await play(ctx.players, m.id, pick(m), ctx.admin);
    await ctx.s.settle();
  }
  throw new Error('did not finish');
}

describe('formats through the API', () => {
  it('double elimination with grand-final reset off (default)', async () => {
    const r = await run({ format: 'double_elim', teamSize: 1, series: { bestOf: 1 } }, 6);
    const d = await playAll(r, (m) => (m.key === 'gf' ? [{ a: 0, b: 1 }] : [{ a: 1, b: 0 }]));
    expect(d.tournament.state).toBe('completed');
    expect(d.matches.some((m: any) => m.key === 'gf2')).toBe(false);
    expect(d.placements.length).toBe(6);
  });

  it('double elimination with grand-final reset on plays the reset when the losers side wins', async () => {
    const r = await run({ format: 'double_elim', teamSize: 1, series: { bestOf: 1 }, doubleElim: { grandFinalReset: true } }, 4);
    const d = await playAll(r, (m) => (m.key === 'gf' ? [{ a: 0, b: 1 }] : [{ a: 1, b: 0 }]));
    const gf2 = d.matches.find((m: any) => m.key === 'gf2');
    expect(gf2.status).toBe('completed');
    expect(d.tournament.state).toBe('completed');
  });

  it('swiss with an odd count: byes, no rematches, rounds generated one at a time', async () => {
    const r = await run({ format: 'swiss', teamSize: 1, series: { bestOf: 1 }, swiss: { rounds: 3 } }, 7);
    let d = ok(await r.admin.get(`/api/tournaments/${r.tid}`)).body;
    expect(d.matches.filter((m: any) => m.round === 1 && !m.walkover).length).toBe(3);
    d = await playAll(r, (m) => (m.id % 2 ? [{ a: 2, b: 1 }] : [{ a: 0, b: 3 }]));
    expect(d.tournament.state).toBe('completed');
    expect(d.tournament.swissRounds).toBe(3);
    const pairs = d.matches.filter((m: any) => !m.walkover && m.a && m.b).map((m: any) => [m.a.competitorId, m.b.competitorId].sort().join('-'));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(d.standings.length).toBe(7);
    expect(d.standings[0].rank).toBe(1);
    // Every competitor received at most one bye.
    const byes = d.standings.map((s: any) => s.byes);
    expect(Math.max(...byes)).toBeLessThanOrEqual(1);
  });

  it('round robin 2v2 with team invitations', async () => {
    const r = await run({ format: 'round_robin', teamSize: 2, registrationMode: 'team', series: { bestOf: 3 } }, 4, { teams: true });
    let d = ok(await r.admin.get(`/api/tournaments/${r.tid}`)).body;
    expect(d.competitors.every((c: any) => c.players.length === 2)).toBe(true);
    d = await playAll(r);
    expect(d.tournament.state).toBe('completed');
    expect(d.matches.filter((m: any) => !m.walkover).length).toBe(6);
    expect(d.standings.map((s: any) => s.rank)).toEqual([1, 2, 3, 4]);
  });

  it('individual signups for 3v3 are drafted into balanced teams at start', async () => {
    const r = await run({ format: 'single_elim', teamSize: 3, registrationMode: 'individual', series: { bestOf: 1 } }, 12);
    const d = ok(await r.admin.get(`/api/tournaments/${r.tid}`)).body;
    expect(d.competitors.length).toBe(4);
    expect(d.competitors.every((c: any) => c.players.length === 3)).toBe(true);
  });
});
