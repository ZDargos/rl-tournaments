import { describe, expect, it } from 'vitest';
import { autocomplete, handleInteraction, type BotInteraction } from '../src/discord/handlers.js';
import { COMMANDS } from '../src/discord/commands.js';
import { GUILD, OTHER_GUILD, setup, uid } from './helpers.js';

let seq = 0;
function cmd(user: number, command: string, subcommand: string | null, options: BotInteraction['options'] = {}, o: { admin?: boolean; guild?: string; id?: string } = {}): BotInteraction {
  return {
    id: o.id ?? `9000000000000${String(++seq).padStart(5, '0')}`, kind: 'command', guildId: o.guild ?? GUILD, guildName: 'RL Hub',
    user: { id: uid(user), username: `player${user}` }, memberIsAdmin: !!o.admin, memberRoleIds: [], command, subcommand, options,
  };
}
const button = (user: number, customId: string): BotInteraction => ({ ...cmd(user, '', null), kind: 'button', customId });

describe('Discord bot handlers', () => {
  it('command definitions are valid Discord JSON (names, lengths, option order)', () => {
    for (const c of COMMANDS) {
      expect(c.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(c.description.length).toBeLessThanOrEqual(100);
      for (const sub of c.options) {
        expect(sub.name).toMatch(/^[a-z0-9_-]{1,32}$/);
        expect(sub.description.length).toBeLessThanOrEqual(100);
        const opts = (sub as { options?: { required?: boolean; name: string; description: string }[] }).options ?? [];
        expect(opts.length).toBeLessThanOrEqual(25);
        // Required options must come before optional ones.
        const firstOptional = opts.findIndex((x) => !x.required);
        if (firstOptional >= 0) expect(opts.slice(firstOptional).some((x) => x.required)).toBe(false);
        for (const x of opts) {
          expect(x.name).toMatch(/^[a-z0-9_-]{1,32}$/);
          expect(x.description.length).toBeLessThanOrEqual(100);
        }
      }
      expect(c.options.length).toBeLessThanOrEqual(25);
    }
  });

  it('runs a tournament from Discord, deduplicates interactions and enforces permissions', async () => {
    const s = await setup();
    for (const n of [1, 10, 11]) s.discord.addMember(GUILD, { userId: uid(n), username: `player${n}`, isAdmin: n === 1 });
    // Non-admin cannot create by default.
    const denied = await handleInteraction(s.ctx, cmd(10, 'tourney', 'create', { name: 'Night Cup', format: 'single_elim', team_size: 1 }));
    expect(denied!.content).toMatch(/⚠️/);
    const created = await handleInteraction(s.ctx, cmd(1, 'tourney', 'create', { name: 'Night Cup', format: 'single_elim', team_size: 1, start: '2026-11-02 19:00', timezone: 'Europe/Berlin' }, { admin: true }));
    expect(created!.content).toMatch(/Created \*\*Night Cup\*\*/);
    const tid = (s.db.prepare("SELECT id, start_at FROM tournaments WHERE name = 'Night Cup'").get() as { id: number; start_at: string });
    expect(tid.start_at).toBe('2026-11-02T18:00:00.000Z'); // 19:00 CET = 18:00 UTC
    await handleInteraction(s.ctx, cmd(1, 'tourney', 'publish', { tournament: tid.id }, { admin: true }));
    await handleInteraction(s.ctx, cmd(1, 'tourney', 'open', { tournament: tid.id }, { admin: true }));
    // Duplicate delivery of the same interaction is ignored.
    const join = cmd(10, 'reg', 'join', { tournament: tid.id });
    expect((await handleInteraction(s.ctx, join))!.content).toMatch(/You are in/);
    expect(await handleInteraction(s.ctx, join)).toBeNull();
    expect((s.db.prepare('SELECT COUNT(*) c FROM entries WHERE tournament_id = ?').get(tid.id) as { c: number }).c).toBe(1);
    await handleInteraction(s.ctx, cmd(11, 'reg', 'join', { tournament: tid.id }));
    // A player cannot start it.
    expect((await handleInteraction(s.ctx, cmd(10, 'tourney', 'start', { tournament: tid.id })))!.content).toMatch(/⚠️/);
    expect((await handleInteraction(s.ctx, cmd(1, 'tourney', 'start', { tournament: tid.id }, { admin: true })))!.content).toMatch(/In progress/i);
    // Structural settings are locked now.
    expect((await handleInteraction(s.ctx, cmd(1, 'tourney', 'set', { tournament: tid.id, setting: 'format', value: 'swiss' }, { admin: true })))!.content).toMatch(/⚠️/);
    const match = s.db.prepare("SELECT id FROM matches WHERE tournament_id = ? AND status = 'ready'").get(tid.id) as { id: number };
    const mine = await handleInteraction(s.ctx, cmd(10, 'match', 'mine', { tournament: tid.id }));
    expect(mine!.content).toContain(`Match ${match.id}`);
    const a = s.db.prepare('SELECT cm.user_id FROM matches m JOIN competitor_members cm ON cm.competitor_id = m.competitor_a WHERE m.id = ?').get(match.id) as { user_id: string };
    const aN = a.user_id === uid(10) ? 10 : 11;
    const bN = aN === 10 ? 11 : 10;
    const rep = await handleInteraction(s.ctx, cmd(aN, 'match', 'report', { match: match.id, scores: '3-1, 2-0' }));
    expect(rep!.content).toMatch(/must confirm/);
    expect(rep!.buttons?.[0].customId).toBe(`confirm:${match.id}`);
    // Reporter pressing their own confirm button is refused; opponent can confirm.
    expect((await handleInteraction(s.ctx, button(aN, `confirm:${match.id}`)))!.content).toMatch(/⚠️/);
    expect((await handleInteraction(s.ctx, button(bN, `confirm:${match.id}`)))!.content).toMatch(/confirmed/);
    const t = s.db.prepare('SELECT state FROM tournaments WHERE id = ?').get(tid.id) as { state: string };
    expect(t.state).toBe('completed');
    const view = await handleInteraction(s.ctx, cmd(10, 'view', 'bracket', { tournament: tid.id }));
    expect(view!.content).toContain('2-0');
    expect(view!.ephemeral).toBe(false);
  });

  it('keeps servers isolated in commands and autocomplete', async () => {
    const s = await setup();
    s.discord.addMember(GUILD, { userId: uid(1), username: 'host', isAdmin: true });
    s.discord.addMember(OTHER_GUILD, { userId: uid(2), username: 'other', isAdmin: true });
    await handleInteraction(s.ctx, cmd(1, 'tourney', 'create', { name: 'Hub Open', format: 'swiss', team_size: 2 }, { admin: true }));
    await handleInteraction(s.ctx, cmd(1, 'tourney', 'create', { name: 'Hub Secret', format: 'swiss', team_size: 2, visibility: 'private' }, { admin: true }));
    const [open, secret] = s.db.prepare('SELECT id FROM tournaments ORDER BY id').all() as { id: number }[];
    await handleInteraction(s.ctx, cmd(1, 'tourney', 'publish', { tournament: open.id }, { admin: true }));
    await handleInteraction(s.ctx, cmd(1, 'tourney', 'publish', { tournament: secret.id }, { admin: true }));
    // From another server, the tournament id is "not found" even for that server's admin.
    const cross = await handleInteraction(s.ctx, cmd(2, 'tourney', 'cancel', { tournament: open.id, reason: 'mine now' }, { admin: true, guild: OTHER_GUILD }));
    expect(cross!.content).toMatch(/not found/i);
    const ac = await autocomplete(s.ctx, { guildId: OTHER_GUILD, userId: uid(2), option: 'tournament', value: '' });
    expect(ac).toEqual([]);
    s.discord.addMember(GUILD, { userId: uid(3), username: 'member' });
    await handleInteraction(s.ctx, cmd(3, 'notify', 'status'));
    const acMember = await autocomplete(s.ctx, { guildId: GUILD, userId: uid(3), option: 'tournament', value: 'Hub' });
    expect(acMember.map((x) => x.value)).toEqual([open.id]);
    const acHost = await autocomplete(s.ctx, { guildId: GUILD, userId: uid(1), option: 'tournament', value: 'Hub' });
    expect(acHost.map((x) => x.value).sort()).toEqual([open.id, secret.id].sort());
  });

  it('applies a preset from Discord only after showing the diff', async () => {
    const s = await setup();
    s.discord.addMember(GUILD, { userId: uid(1), username: 'host', isAdmin: true });
    await handleInteraction(s.ctx, cmd(1, 'preset', 'create', { name: 'Bo5 3v3', format: 'single_elim', team_size: 3 }, { admin: true }));
    const preset = s.db.prepare('SELECT id FROM presets').get() as { id: number };
    await handleInteraction(s.ctx, cmd(1, 'preset', 'set', { preset: preset.id, setting: 'series.bestOf', value: '5' }, { admin: true }));
    await handleInteraction(s.ctx, cmd(1, 'tourney', 'create', { name: 'Late preset', format: 'single_elim', team_size: 3 }, { admin: true }));
    const t = s.db.prepare('SELECT id FROM tournaments').get() as { id: number };
    const prev = await handleInteraction(s.ctx, cmd(1, 'tourney', 'apply-preset', { tournament: t.id, preset: preset.id }, { admin: true }));
    expect(prev!.content).toContain('series.bestOf');
    expect(JSON.parse((s.db.prepare('SELECT config FROM tournaments').get() as { config: string }).config).series.bestOf).toBe(3);
    await handleInteraction(s.ctx, button(1, prev!.buttons![0].customId));
    expect(JSON.parse((s.db.prepare('SELECT config FROM tournaments').get() as { config: string }).config).series.bestOf).toBe(5);
  });
});
