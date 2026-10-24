import { describeSeries, DomainError, FORMAT_LABELS, parseGamesText, parseRank, patchFromPath, rankLabel, STATE_LABELS, type Format } from '@rl/core';
import type { AppContext } from '../services/context.js';
import { nowIso } from '../services/context.js';
import { ensureUser, setMute, setPreferences, upsertUser, getUser } from '../services/users.js';
import { getGuild, guildDto, guildPolicy, recordMembership, updateGuildSettings, upsertGuild } from '../services/guilds.js';
import { addAdmin, applyPreset, createTournament, inviteViewer, previewPreset, removeAdmin, transition, updateTournament } from '../services/tournaments.js';
import {
  adminAddPlayer, adminEntryAction, checkIn, entryForUser, entryMembers, inviteToTeam, register, removeTeamMember, renameTeam, respondInvitation, setEntrySkill, setOwnRank, withdraw,
} from '../services/registration.js';
import { abandonMatch, adminResolve, confirmResult, disputeResult, reportResult, voteResult } from '../services/results.js';
import { getMatch } from '../services/queries.js';
import { confirmPools, confirmSchedule, editFinalsTeams, generateSchedule, makePoolsProposal, previewFinals, startFinals, swapScheduledPlayers } from '../services/sixmans.js';
import { createPreset, deletePreset, duplicatePreset, listPresets, presetDto, updatePreset, type PresetRow } from '../services/presets.js';
import { listTournaments, matchDetail, tournamentDetail } from '../services/views.js';
import { exportCsv, type ExportKind } from '../services/exports.js';
import { repairVoice, voiceStatus } from '../services/voice.js';
import { assertManage, loadTournament } from '../services/access.js';
import { discordTime, escapeDiscord } from '../lib/util.js';
import { zonedToUtc } from '../lib/tz.js';
import { SETTING_SUGGESTIONS } from './commands.js';
import { setAvailability } from '../services/availability.js';

/** Platform-neutral view of a Discord interaction (built by bot.ts from discord.js objects). */
export interface BotInteraction {
  id: string;
  kind: 'command' | 'button';
  guildId: string | null;
  guildName?: string | null;
  user: { id: string; username: string; globalName?: string | null; avatar?: string | null };
  /** Discord permission check from the interaction payload: Manage Server or Administrator. */
  memberIsAdmin: boolean;
  memberRoleIds: string[];
  memberDisplayName?: string | null;
  command: string;
  subcommand: string | null;
  options: Record<string, string | number | boolean | { id: string; username: string; globalName?: string | null } | undefined>;
  customId?: string;
}

export interface BotButton {
  customId: string;
  label: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
}

export interface BotReply {
  content: string;
  ephemeral: boolean;
  buttons?: BotButton[];
  file?: { name: string; data: Buffer };
}

const MAX = 1900;
const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX - 20)}\n… (see the website)` : s);
const reply = (content: string, ephemeral = true, extra: Partial<BotReply> = {}): BotReply => ({ content: clip(content), ephemeral, ...extra });
const esc = escapeDiscord;

type UserOpt = { id: string; username: string; globalName?: string | null };

function optUser(i: BotInteraction, name: string): UserOpt {
  const v = i.options[name];
  if (!v || typeof v !== 'object') throw new DomainError('missing_option', `Missing option ${name}.`);
  return v;
}
const optStr = (i: BotInteraction, name: string) => (typeof i.options[name] === 'string' ? (i.options[name] as string) : undefined);
const optNum = (i: BotInteraction, name: string) => (typeof i.options[name] === 'number' ? (i.options[name] as number) : undefined);
const optBool = (i: BotInteraction, name: string) => (typeof i.options[name] === 'boolean' ? (i.options[name] as boolean) : undefined);
function reqNum(i: BotInteraction, name: string): number {
  const n = optNum(i, name);
  if (n == null) throw new DomainError('missing_option', `Missing option ${name}.`);
  return n;
}

const tLink = (ctx: AppContext, id: number, path = '') => `${ctx.env.WEB_URL}/#/t/${id}${path}`;

/** The tournament must belong to the server the command was used in (server isolation). */
function guildTournament(ctx: AppContext, i: BotInteraction, id: number) {
  const t = loadTournament(ctx, id);
  if (t.guild_id !== i.guildId) throw new DomainError('not_found', 'Tournament not found in this server.', 404);
  return t;
}

function guildPreset(ctx: AppContext, i: BotInteraction, id: number): PresetRow {
  const p = ctx.db.prepare('SELECT * FROM presets WHERE id = ? AND deleted_at IS NULL').get(id) as PresetRow | undefined;
  if (!p || p.guild_id !== i.guildId) throw new DomainError('not_found', 'Preset not found in this server.', 404);
  return p;
}

function registerUser(ctx: AppContext, u: UserOpt) {
  return ensureUser(ctx, u.id, u.username, u.globalName ?? null);
}

/** Entry point. Returns null when the interaction was already processed (duplicate delivery). */
export async function handleInteraction(ctx: AppContext, i: BotInteraction): Promise<BotReply | null> {
  const fresh = ctx.db.prepare('INSERT OR IGNORE INTO processed_interactions (id, created_at) VALUES (?, ?)').run(i.id, nowIso(ctx));
  if (!fresh.changes) return null;
  upsertUser(ctx, { id: i.user.id, username: i.user.username, globalName: i.user.globalName ?? null, avatar: i.user.avatar ?? null });
  if (i.guildId) {
    if (!getGuild(ctx, i.guildId)) upsertGuild(ctx, { id: i.guildId, name: i.guildName ?? 'Discord server', botPresent: true });
    recordMembership(ctx, { guildId: i.guildId, userId: i.user.id, isAdmin: i.memberIsAdmin, roleIds: i.memberRoleIds, displayName: i.memberDisplayName ?? null, source: 'interaction' });
  }
  try {
    if (i.kind === 'button') return await handleButton(ctx, i);
    if (!i.guildId && i.command !== 'notify') return reply('Use this command inside your Discord server.');
    return await route(ctx, i);
  } catch (err) {
    if (err instanceof DomainError) {
      const details = err.details as { problems?: string[] } | undefined;
      const extra = details?.problems?.length ? `\n${details.problems.map((p) => `• ${p}`).join('\n')}` : '';
      return reply(`⚠️ ${err.message}${extra && !err.message.includes(details!.problems![0]) ? extra : ''}`);
    }
    ctx.log.error({ err: String(err), stack: (err as Error).stack, command: i.command, sub: i.subcommand }, 'bot command failed');
    return reply('Something went wrong on our side. It has been logged.');
  }
}

async function route(ctx: AppContext, i: BotInteraction): Promise<BotReply> {
  const key = `${i.command} ${i.subcommand ?? ''}`.trim();
  const uid = i.user.id;
  const src = 'discord' as const;
  switch (key) {
    // ------------------------------------------------------------- tourney
    case 'tourney create': {
      const tz = optStr(i, 'timezone') ?? 'UTC';
      const start = optStr(i, 'start');
      let startAt: string | null = null;
      if (start) {
        try {
          startAt = zonedToUtc(start, tz);
        } catch (e) {
          throw new DomainError('bad_time', (e as Error).message);
        }
      }
      const presetId = optNum(i, 'preset');
      if (presetId) guildPreset(ctx, i, presetId);
      const config: Record<string, unknown> = { schedule: { timezone: tz, startAt } };
      if (optStr(i, 'format') && !presetId) config.format = optStr(i, 'format');
      if (optNum(i, 'team_size') && !presetId) config.teamSize = optNum(i, 'team_size');
      if (config.format && config.format !== 'sixmans' && !config.teamSize) config.teamSize = 3;
      const t = await createTournament(ctx, uid, { guildId: i.guildId!, name: optStr(i, 'name')!, description: optStr(i, 'description'), visibility: (optStr(i, 'visibility') as 'public' | 'private') ?? 'public', presetId: presetId ?? null, config }, src);
      return reply(
        `✅ Created **${esc(t.name)}** (#${t.id}) — ${FORMAT_LABELS[t.format]}, ${t.cfg.teamSize}v${t.cfg.teamSize}${startAt ? `, starts ${discordTime(startAt)}` : ''}. It is a draft.\n` +
          `Next: \`/tourney publish tournament:${t.id}\` then \`/tourney open tournament:${t.id}\`. Fine-tune settings with \`/tourney set\` or on the website: ${tLink(ctx, t.id, '/manage')}`,
      );
    }
    case 'tourney list': {
      const filter = optStr(i, 'filter') ?? 'active';
      const list = await listTournaments(ctx, uid, { guildId: i.guildId!, state: filter === 'all' ? undefined : filter });
      if (!list.length) return reply('No tournaments found.', false);
      return reply(list.slice(0, 20).map((t) => `**#${t.id} ${esc(t.name)}** — ${t.formatLabel}, ${t.stateLabel}${t.startAt ? `, ${discordTime(t.startAt)}` : ''} · ${t.confirmedEntries}${t.capacity ? `/${t.capacity}` : ''} entries`).join('\n'), false);
    }
    case 'tourney info': {
      const d = await tournamentDetail(ctx, guildTournament(ctx, i, reqNum(i, 'tournament')).id, uid);
      const t = d.tournament;
      const lines = [
        `**${esc(t.name)}** (#${t.id}) — ${t.formatLabel}, ${t.teamSize}v${t.teamSize}, ${t.visibility}`,
        `Status: **${t.stateLabel}**${t.stage ? ` (${t.stage.replace('_', ' ')})` : ''}`,
        t.startAt ? `Start: ${discordTime(t.startAt)} (${t.timezone})` : 'Start: not scheduled',
        `Entries: ${t.confirmedEntries}${t.capacity ? `/${t.capacity}` : ''} · Series: best of ${t.config.format === 'sixmans' ? t.config.sixmans.groupBestOf : t.config.series.bestOf}`,
        t.description ? `\n${esc(t.description.slice(0, 400))}` : '',
        `\n${tLink(ctx, t.id)}`,
      ];
      return reply(lines.filter(Boolean).join('\n'), false);
    }
    case 'tourney publish':
    case 'tourney open':
    case 'tourney close':
    case 'tourney start':
    case 'tourney pause':
    case 'tourney resume':
    case 'tourney cancel': {
      const action = ({ publish: 'publish', open: 'open_registration', close: 'close_registration', start: 'start', pause: 'pause', resume: 'resume', cancel: 'cancel' } as const)[i.subcommand as 'publish'];
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const r = await transition(ctx, uid, t.id, action, { reason: optStr(i, 'reason'), source: src });
      const warn = r.warnings.length ? `\nWarnings:\n${r.warnings.map((w) => `• ${w}`).join('\n')}` : '';
      return reply(`✅ **${esc(t.name)}** is now **${STATE_LABELS[r.tournament.state]}**.${warn}`);
    }
    case 'tourney set': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const path = optStr(i, 'setting')!;
      let raw = optStr(i, 'value')!;
      if (path === 'schedule.startAt' && raw !== 'null' && raw !== 'none') raw = zonedToUtc(raw, t.cfg.schedule.timezone);
      if (path === 'visibility') {
        await updateTournament(ctx, uid, t.id, { visibility: raw === 'private' ? 'private' : 'public' }, src);
        return reply(`✅ Visibility set to ${raw === 'private' ? 'private' : 'public'}.`);
      }
      await updateTournament(ctx, uid, t.id, { configPatch: patchFromPath(path, raw) }, src);
      return reply(`✅ \`${path}\` updated for **${esc(t.name)}**.`);
    }
    case 'tourney score-channel': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const patch: Record<string, unknown> = {};
      if (optBool(i, 'off')) patch.channelId = null;
      else if (typeof i.options.channel === 'string') patch.channelId = i.options.channel;
      if (optNum(i, 'votes') != null) patch.votesNeeded = optNum(i, 'votes');
      if (optBool(i, 'both_teams') != null) patch.requireBothTeams = optBool(i, 'both_teams');
      const u = Object.keys(patch).length ? await updateTournament(ctx, uid, t.id, { configPatch: { scoreReports: patch } }, src) : t;
      const sr = u.cfg.scoreReports;
      return reply(
        sr.channelId
          ? `✅ Vote cards for live matches of **${esc(u.name)}** go to <#${sr.channelId}>. A result counts after ${sr.votesNeeded} matching vote(s)${sr.requireBothTeams && sr.votesNeeded > 1 ? ', with at least one from each team' : ''}.`
          : `Vote cards are off for **${esc(u.name)}**. Turn them on with \`/tourney score-channel tournament:${u.id} channel:#channel\`.`,
      );
    }
    case 'tourney admin-add':
    case 'tourney admin-remove': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const u = registerUser(ctx, optUser(i, 'user'));
      if (i.subcommand === 'admin-add') await addAdmin(ctx, uid, t.id, u.id, src);
      else await removeAdmin(ctx, uid, t.id, u.id, src);
      return reply(`✅ <@${u.id}> ${i.subcommand === 'admin-add' ? 'is now an admin of' : 'is no longer an admin of'} **${esc(t.name)}**.`);
    }
    case 'tourney invite': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const u = registerUser(ctx, optUser(i, 'user'));
      await inviteViewer(ctx, uid, t.id, u.id);
      return reply(`✅ Invited <@${u.id}> to **${esc(t.name)}**.`);
    }
    case 'tourney apply-preset': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const p = guildPreset(ctx, i, reqNum(i, 'preset'));
      const prev = await previewPreset(ctx, uid, t.id, p.id);
      if (!prev.changes.length) return reply('This preset matches the current settings; nothing would change.');
      const lines = prev.changes.slice(0, 25).map((c) => `• \`${c.path}\`: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
      return reply(`Applying **${esc(p.name)}** to **${esc(t.name)}** would change ${prev.changes.length} setting(s):\n${lines.join('\n')}${prev.changes.length > 25 ? '\n…' : ''}`, true, {
        buttons: [{ customId: `applypreset:${t.id}:${p.id}`, label: 'Apply preset', style: 'primary' }],
      });
    }
    case 'tourney export': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const r = await exportCsv(ctx, t.id, optStr(i, 'kind') as ExportKind, uid);
      return reply(`📄 ${r.filename}`, true, { file: { name: r.filename, data: Buffer.from(r.csv, 'utf8') } });
    }
    case 'tourney link': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      return reply(`🔗 **${esc(t.name)}**: ${tLink(ctx, t.id)}`, false);
    }
    // ------------------------------------------------------------- reg
    case 'reg join': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const rankText = optStr(i, 'rank');
      const rank = rankText ? parseRank(rankText) : null;
      if (rankText && !rank) throw new DomainError('bad_rank', `I could not read "${rankText}" as a rank. Try e.g. "Champion 2" or "GC1".`);
      const e = await register(ctx, uid, t.id, { teamName: optStr(i, 'team_name') ?? null, rank }, src);
      const status = { confirmed: 'You are in! ✅', pending: 'Your registration is waiting for organizer approval.', waitlisted: 'The tournament is full; you are on the waitlist.' }[e.status as 'confirmed'] ?? e.status;
      const team = e.kind === 'team' ? `\nInvite teammates with \`/team invite tournament:${t.id} user:@name\`.` : '';
      return reply(`${status} (**${esc(t.name)}**)${team}`);
    }
    case 'reg leave': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      await withdraw(ctx, uid, t.id, src);
      return reply(`You left **${esc(t.name)}**.`);
    }
    case 'reg checkin': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      await checkIn(ctx, uid, t.id, null, src);
      return reply(`✅ Checked in for **${esc(t.name)}**.`);
    }
    case 'reg list': {
      const d = await tournamentDetail(ctx, guildTournament(ctx, i, reqNum(i, 'tournament')).id, uid);
      const groups = ['confirmed', 'pending', 'waitlisted'].map((s) => {
        const es = d.entries.filter((e) => e.status === s);
        if (!es.length) return '';
        return `**${s[0].toUpperCase()}${s.slice(1)} (${es.length})**\n${es.map((e) => `• ${esc(e.name ?? '')}${e.kind === 'team' ? ` (${e.members.map((m) => esc(m.name)).join(', ')})` : ''}${e.checkedIn ? ' ✅' : ''}${d.viewer.canManage && e.rankLabel ? ` · ${e.rankLabel}` : ''}${d.viewer.canManage && e.seed ? ` · seed ${e.seed}` : ''}`).join('\n')}`;
      });
      return reply(groups.filter(Boolean).join('\n\n') || 'No registrations yet.', !d.viewer.canManage ? false : true);
    }
    case 'reg myrank': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const rank = parseRank(optStr(i, 'rank')!);
      if (!rank) throw new DomainError('bad_rank', 'Unknown rank. Try e.g. "Diamond 3" or "GC2".');
      await setOwnRank(ctx, uid, t.id, rank, optNum(i, 'division') ?? null);
      return reply(`✅ Rank set to ${rankLabel(rank, optNum(i, 'division'))}.`);
    }
    case 'reg approve':
    case 'reg reject':
    case 'reg remove': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const u = optUser(i, 'user');
      const e = entryForUser(ctx, t.id, u.id);
      if (!e) throw new DomainError('not_found', 'That user has no active registration.', 404);
      const r = await adminEntryAction(ctx, uid, e.id, i.subcommand as 'approve', optStr(i, 'reason') ?? null, src);
      return reply(`✅ <@${u.id}>: ${r.status}.`);
    }
    case 'reg add': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const u = registerUser(ctx, optUser(i, 'user'));
      const e = await adminAddPlayer(ctx, uid, t.id, u.id, u.username, src);
      return reply(`✅ Added <@${u.id}> (${e.status}).`);
    }
    case 'reg seed':
    case 'reg rank': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const u = optUser(i, 'user');
      const e = entryForUser(ctx, t.id, u.id);
      if (!e) throw new DomainError('not_found', 'That user has no active registration.', 404);
      if (i.subcommand === 'seed') await setEntrySkill(ctx, uid, e.id, { seed: reqNum(i, 'seed') }, src);
      else {
        const rank = parseRank(optStr(i, 'rank')!);
        if (!rank) throw new DomainError('bad_rank', 'Unknown rank.');
        await setEntrySkill(ctx, uid, e.id, { rank, division: optNum(i, 'division') ?? null }, src);
      }
      return reply('✅ Saved.');
    }
    // ------------------------------------------------------------- team
    case 'team invite': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const e = entryForUser(ctx, t.id, uid);
      if (!e || e.kind !== 'team') throw new DomainError('not_found', 'You are not on a team in this tournament. Register with a team name first.', 404);
      const u = registerUser(ctx, optUser(i, 'user'));
      const inv = await inviteToTeam(ctx, uid, e.id, u.id, optBool(i, 'substitute') ? 'substitute' : 'player', src, u.username);
      return reply(`📨 Invited <@${u.id}> to **${esc(e.name ?? '')}** (invitation ${inv}). They can accept with \`/team accept invitation:${inv}\` or the buttons below.`, false, {
        buttons: [{ customId: `inv:accept:${inv}`, label: 'Accept', style: 'success' }, { customId: `inv:decline:${inv}`, label: 'Decline', style: 'secondary' }],
      });
    }
    case 'team accept':
    case 'team decline': {
      await respondInvitation(ctx, uid, reqNum(i, 'invitation'), i.subcommand === 'accept', src);
      return reply(i.subcommand === 'accept' ? '✅ You joined the team.' : 'Invitation declined.');
    }
    case 'team kick': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const e = entryForUser(ctx, t.id, uid);
      if (!e || e.kind !== 'team') throw new DomainError('not_found', 'You are not on a team in this tournament.', 404);
      await removeTeamMember(ctx, uid, e.id, optUser(i, 'user').id, null, src);
      return reply('✅ Removed from the roster.');
    }
    case 'team roster': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const e = entryForUser(ctx, t.id, uid);
      if (!e) throw new DomainError('not_found', 'You are not registered in this tournament.', 404);
      const members = entryMembers(ctx, e.id);
      return reply(`**${esc(e.name ?? 'Solo entry')}** (${e.status}${e.roster_locked ? ', locked' : ''})\n${members.map((m) => `• <@${m.user_id}> — ${m.role}`).join('\n')}`);
    }
    case 'team rename': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const e = entryForUser(ctx, t.id, uid);
      if (!e) throw new DomainError('not_found', 'You are not registered in this tournament.', 404);
      await renameTeam(ctx, uid, e.id, optStr(i, 'name')!);
      return reply('✅ Team renamed.');
    }
    // ------------------------------------------------------------- preset
    case 'preset list': {
      const ps = await listPresets(ctx, i.guildId!, uid);
      return reply(ps.length ? ps.map((p) => `• **${esc(p.name)}** (#${p.id}) — ${FORMAT_LABELS[p.config.format]}, ${p.config.teamSize}v${p.config.teamSize}, v${p.version}`).join('\n') : 'No presets yet. Create one with `/preset create` or `/preset save`.');
    }
    case 'preset show': {
      const p = presetDto(guildPreset(ctx, i, reqNum(i, 'preset')));
      const c = p.config;
      const extra = c.format === 'sixmans' ? `\n6mans: ${c.sixmans.poolCount} pools, ${c.sixmans.roundsMode === 'fixed' ? `${c.sixmans.roundsPerPool} rounds` : `equal games (${c.sixmans.gamesPerPlayer ?? 'auto'} per player)`}, skill by ${c.sixmans.skillMethod}, balanced teams ${c.sixmans.skillBalancedTeams ? 'on' : 'off'}` : '';
      return reply(`**${esc(p.name)}** (v${p.version}) — ${FORMAT_LABELS[c.format]}, ${c.teamSize}v${c.teamSize}, ${c.registrationMode} registration, best of ${c.series.bestOf}, check-in ${c.checkIn.enabled ? 'on' : 'off'}, voice ${c.voice.enabled ? 'on' : 'off'}${extra}`);
    }
    case 'preset create': {
      const format = optStr(i, 'format') as Format;
      const p = await createPreset(ctx, uid, { guildId: i.guildId!, name: optStr(i, 'name')!, config: { format, teamSize: optNum(i, 'team_size') ?? 3 } });
      return reply(`✅ Preset **${esc(p.name)}** (#${p.id}) created. Adjust it with \`/preset set\` or on the website.`);
    }
    case 'preset save': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      await assertManage(ctx, t, uid);
      const p = await createPreset(ctx, uid, { guildId: t.guild_id, name: optStr(i, 'name')!, config: { ...t.cfg, schedule: { ...t.cfg.schedule, startAt: null } } });
      return reply(`✅ Saved **${esc(t.name)}**’s settings as preset **${esc(p.name)}** (#${p.id}).`);
    }
    case 'preset set': {
      const p = guildPreset(ctx, i, reqNum(i, 'preset'));
      const { applyConfigPatch, parseConfig } = await import('@rl/core');
      const cfg = applyConfigPatch(parseConfig(JSON.parse(p.config)), patchFromPath(optStr(i, 'setting')!, optStr(i, 'value')!));
      await updatePreset(ctx, uid, p.id, { config: cfg });
      return reply(`✅ Preset **${esc(p.name)}** updated. Existing tournaments are unaffected until you apply it.`);
    }
    case 'preset rename': {
      const p = guildPreset(ctx, i, reqNum(i, 'preset'));
      await updatePreset(ctx, uid, p.id, { name: optStr(i, 'name')! });
      return reply('✅ Renamed.');
    }
    case 'preset duplicate': {
      const p = guildPreset(ctx, i, reqNum(i, 'preset'));
      const copy = await duplicatePreset(ctx, uid, p.id, optStr(i, 'name'));
      return reply(`✅ Created **${esc(copy.name)}** (#${copy.id}).`);
    }
    case 'preset delete': {
      const p = guildPreset(ctx, i, reqNum(i, 'preset'));
      await deletePreset(ctx, uid, p.id);
      return reply(`🗑️ Deleted **${esc(p.name)}**. Tournaments created from it keep their own settings.`);
    }
    // ------------------------------------------------------------- match
    case 'match mine': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const d = await tournamentDetail(ctx, t.id, uid);
      const mine = d.matches.filter((m) => d.viewer.myMatchIds.includes(m.id) && ['ready', 'awaiting_confirmation', 'disputed'].includes(m.status));
      if (!mine.length) {
        const next = d.matches.find((m) => d.viewer.myMatchIds.includes(m.id) && m.status === 'pending');
        return reply(next ? `No active match right now. Your next one: ${next.label} (waiting for earlier results).` : 'You have no active matches in this tournament.');
      }
      const voice = voiceStatus(ctx, t.id);
      return reply(
        mine.map((m) => {
          const v = voice.filter((x) => x.matchId === m.id && x.channelId && x.memberIds.includes(uid)).map((x) => `<#${x.channelId}>`).join(' ');
          return `**Match ${m.id}** — ${m.label}: **${esc(m.a?.name ?? 'TBD')}** (A) vs **${esc(m.b?.name ?? 'TBD')}** (B), best of ${m.bestOf} — ${m.status.replace('_', ' ')}${v ? `\nYour voice channel: ${v}` : ''}`;
        }).join('\n\n') + `\nReport with \`/match report match:<id> scores:3-1, 2-0\` (Team A goals first).`,
      );
    }
    case 'match info': {
      const d = await matchDetail(ctx, reqNum(i, 'match'), uid);
      if (d.tournament.guildId !== i.guildId) throw new DomainError('not_found', 'Match not found in this server.', 404);
      const m = d.match;
      const score = m.status === 'completed' ? `Result: ${m.forfeit ? 'forfeit' : describeSeries({ winsA: m.winsA ?? 0, winsB: m.winsB ?? 0, games: m.games })}, winner **${esc((m.winner === 'a' ? m.a?.name : m.b?.name) ?? '')}**` : `Status: ${m.status.replace('_', ' ')}`;
      const players = (s: typeof m.a) => (s ? s.players.map((p) => esc(p.name)).join(', ') : 'TBD');
      return reply(`**Match ${m.id}** — ${esc(d.tournament.name)} · ${m.label} (best of ${m.bestOf})\n🔵 A: **${esc(m.a?.name ?? 'TBD')}** — ${players(m.a)}\n🟠 B: **${esc(m.b?.name ?? 'TBD')}** — ${players(m.b)}\n${score}\n${ctx.env.WEB_URL}/#/m/${m.id}`, false);
    }
    case 'match report': {
      const games = parseGamesText(optStr(i, 'scores')!);
      const matchId = reqNum(i, 'match');
      const md = await matchDetail(ctx, matchId, uid);
      if (md.tournament.guildId !== i.guildId) throw new DomainError('not_found', 'Match not found in this server.', 404);
      const r = await reportResult(ctx, uid, matchId, { games }, src);
      const outcome = 'outcome' in r ? r.outcome : 'completed';
      const text = { completed: '✅ Result recorded and confirmed.', awaiting_confirmation: '📨 Result reported. A player from the other team must confirm it.', disputed: '⚠️ Your report does not match the other team’s; organizers were notified to resolve it.', unchanged: 'You already reported this result.' }[outcome];
      return reply(`${text} (${describeSeries({ winsA: games.filter((g) => g.a > g.b).length, winsB: games.filter((g) => g.b > g.a).length, games })})`, true,
        outcome === 'awaiting_confirmation' ? { buttons: [{ customId: `confirm:${matchId}`, label: 'Opponent: confirm', style: 'success' }] } : {});
    }
    case 'match confirm': {
      await confirmResult(ctx, uid, reqNum(i, 'match'), src);
      return reply('✅ Result confirmed.');
    }
    case 'match dispute': {
      await disputeResult(ctx, uid, reqNum(i, 'match'), optStr(i, 'reason')!, null, src);
      return reply('⚠️ Result disputed. Organizers have been notified.');
    }
    case 'match resolve': {
      const games = parseGamesText(optStr(i, 'scores')!);
      await adminResolve(ctx, uid, reqNum(i, 'match'), { games }, optStr(i, 'reason') ?? null, !!optBool(i, 'confirm_reset'), src);
      return reply('✅ Result set.');
    }
    case 'match forfeit': {
      await adminResolve(ctx, uid, reqNum(i, 'match'), { forfeitWinner: optStr(i, 'winner') as 'a' | 'b' }, optStr(i, 'reason')!, false, src);
      return reply('✅ Forfeit recorded.');
    }
    case 'match abandon': {
      await abandonMatch(ctx, uid, reqNum(i, 'match'), optStr(i, 'reason')!, src);
      return reply('✅ Match abandoned.');
    }
    // ------------------------------------------------------------- view
    case 'view standings':
    case 'view bracket':
    case 'view pools':
    case 'view schedule': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      return reply(await renderView(ctx, t.id, uid, i.subcommand as 'standings'), false);
    }
    // ------------------------------------------------------------- sixmans
    case 'sixmans make-pools': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const d = await makePoolsProposal(ctx, uid, t.id, optNum(i, 'pools') ?? null, src);
      const names = await nameMap(ctx, d.pools.flatMap((p) => p.players.map((x) => x.userId)));
      const body = d.pools.map((p, idx) => `**${p.name}** (${p.players.length}, avg ${d.averages[idx].toFixed(1)}): ${p.players.map((x) => esc(names.get(x.userId) ?? x.userId)).join(', ')}`).join('\n');
      return reply(`Proposed pools (replaces any earlier proposal):\n${body}\nConfirm with \`/sixmans confirm-pools tournament:${t.id}\` or adjust on the website.`);
    }
    case 'sixmans confirm-pools': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      await confirmPools(ctx, uid, t.id, src);
      return reply(
        t.cfg.sixmans.roundsMode === 'fixed'
          ? `✅ Pools confirmed. Next: \`/sixmans schedule tournament:${t.id} rounds:${t.cfg.sixmans.roundsPerPool}\`.`
          : `✅ Pools confirmed. Next: \`/sixmans schedule tournament:${t.id}\` (rounds per pool are worked out so everyone plays the same number of games; add \`games:\` to choose how many).`,
      );
    }
    case 'sixmans schedule': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const games = optNum(i, 'games');
      const rounds = optNum(i, 'rounds');
      const d = await generateSchedule(ctx, uid, t.id, { ...(games != null ? { games, mode: 'equal_games' as const } : {}), ...(rounds != null && games == null ? { rounds } : {}), skillBalanced: optBool(i, 'skill_balanced') }, src);
      const lines = d.pools.map((p) => {
        const r = p.result;
        if (r.status !== 'ok') return `**Pool ${String.fromCharCode(65 + p.poolIndex)}**: ❌ ${r.infeasibility?.reasons.join(' ')} ${r.infeasibility?.maxFeasibleFound ? `Maximum found: ${r.infeasibility.maxFeasibleFound} rounds${r.infeasibility.maxFeasibleProven ? ' (proven)' : ''}.` : ''}`;
        const games = r.balance.min === r.balance.max ? `${r.balance.min} games each` : `games per player ${r.balance.min}–${r.balance.max}${r.balance.ideal ? ' (ideal)' : r.balance.provenBest ? ' (best possible)' : ''}`;
        return `**Pool ${String.fromCharCode(65 + p.poolIndex)}** (${p.playerIds.length} players): ✅ ${r.rounds.length} rounds, ${games}, no repeated trios.`;
      });
      const notes = (d.notes ?? []).map((x) => `ℹ️ ${x}`);
      return reply(`${[...lines, ...notes].join('\n')}\nReview the full schedule on the website (${tLink(ctx, t.id, '/manage')}), then \`/sixmans confirm-schedule tournament:${t.id}\`.`);
    }
    case 'sixmans swap': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      await swapScheduledPlayers(ctx, uid, t.id, { poolIndex: reqNum(i, 'pool') - 1, round: reqNum(i, 'round'), playerA: optUser(i, 'player_a').id, playerB: optUser(i, 'player_b').id }, src);
      return reply('✅ Swapped. The schedule was re-validated.');
    }
    case 'sixmans confirm-schedule': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      await confirmSchedule(ctx, uid, t.id, src);
      return reply(`✅ Schedule confirmed. Start the group stage with \`/tourney start tournament:${t.id}\` (or let it auto-start).`);
    }
    case 'sixmans finals-teams': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const teams = optStr(i, 'teams')!.split('|').map((part) => ({ players: [...part.matchAll(/<@!?(\d{5,25})>/g)].map((x) => x[1]) })).filter((tm) => tm.players.length);
      const d = await editFinalsTeams(ctx, uid, t.id, teams, src, { handPicked: true });
      const names = await nameMap(ctx, d.teams.flatMap((x) => x.players));
      return reply(`✅ Hand-picked finals teams saved:\n${d.teams.map((tm) => `**Seed ${tm.seed}**: ${tm.players.map((u) => esc(names.get(u) ?? u)).join(', ')}`).join('\n')}\nStart with \`/sixmans start-finals tournament:${t.id}\`.`);
    }
    case 'sixmans finals': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const d = await previewFinals(ctx, uid, t.id, { optionId: optStr(i, 'option') ?? null, qualifiersPerPool: optNum(i, 'qualifiers') ?? null }, src);
      const names = await nameMap(ctx, d.teams.flatMap((x) => x.players));
      const opts = d.options.map((o) => `${o.id === d.optionId ? '▶' : '•'} \`${o.id}\` — ${o.label}: ${o.description}`).join('\n');
      const teams = d.teams.map((tm) => `**${esc(tm.name)}** (seed ${tm.seed}): ${tm.players.map((u) => esc(names.get(u) ?? u)).join(', ')}`).join('\n');
      return reply(`Finals options:\n${opts}\n\nTeams:\n${teams}\nStart with \`/sixmans start-finals tournament:${t.id}\`.`);
    }
    case 'sixmans start-finals': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      await startFinals(ctx, uid, t.id, src);
      return reply('🏁 Finals started!', false);
    }
    // ------------------------------------------------------------- notify
    case 'notify dms': {
      const enabled = !!optBool(i, 'enabled');
      setPreferences(ctx, uid, { dmsEnabled: enabled });
      return reply(enabled ? '✅ DMs from the bot are on.' : '🔕 DMs are off. If a tournament also has channel announcements off, you may miss match calls.');
    }
    case 'notify mute':
    case 'notify unmute': {
      const t = loadTournament(ctx, reqNum(i, 'tournament'));
      setMute(ctx, uid, t.id, i.subcommand === 'mute');
      return reply(i.subcommand === 'mute' ? `🔕 Muted **${esc(t.name)}** (personal invitations and organizer messages still arrive).` : `🔔 Unmuted **${esc(t.name)}**.`);
    }
    case 'notify status': {
      const u = getUser(ctx, uid)!;
      const mutes = ctx.db.prepare('SELECT t.id, t.name FROM tournament_mutes m JOIN tournaments t ON t.id = m.tournament_id WHERE m.user_id = ?').all(uid) as { id: number; name: string }[];
      return reply(`DMs: **${u.dms_enabled ? 'on' : 'off'}**${u.dm_blocked_until ? ` (Discord refused a DM; paused until ${discordTime(u.dm_blocked_until)} — open your DMs and run /notify dms enabled:true)` : ''}\nMuted: ${mutes.length ? mutes.map((m) => esc(m.name)).join(', ') : 'none'}`);
    }
    // ------------------------------------------------------------- voice
    case 'voice repair': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const s = await repairVoice(ctx, uid, t.id);
      const failed = s.filter((x) => x.status === 'failed');
      return reply(`🔧 Voice channels reconciled: ${s.filter((x) => x.status === 'active').length} active${failed.length ? `, ${failed.length} failed (${esc(failed[0].error ?? '')})` : ''}.`);
    }
    case 'voice lobby': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      const patch: Record<string, unknown> = {};
      if (optBool(i, 'off')) patch.lobbyChannelId = null;
      else if (typeof i.options.channel === 'string') patch.lobbyChannelId = i.options.channel;
      if (optNum(i, 'seconds') != null) patch.lobbySeconds = optNum(i, 'seconds');
      const u = Object.keys(patch).length ? await updateTournament(ctx, uid, t.id, { configPatch: { voice: patch } }, src) : t;
      const v = u.cfg.voice;
      return reply(
        v.lobbyChannelId
          ? `✅ After each game, players go to <#${v.lobbyChannelId}> for ${v.lobbySeconds} second(s), then into their next match's channels.`
          : `The between-games lobby is off for **${esc(u.name)}**.`,
      );
    }
    case 'voice status': {
      const t = guildTournament(ctx, i, reqNum(i, 'tournament'));
      await assertManage(ctx, t, uid);
      const s = voiceStatus(ctx, t.id);
      return reply(s.length ? s.map((x) => `• Match ${x.matchId}${x.slot.toUpperCase()}: ${x.channelId ? `<#${x.channelId}>` : '—'} ${x.status}${x.error ? ` (${esc(x.error)})` : ''}`).join('\n') : 'No match voice channels right now.');
    }
    // ------------------------------------------------------------- server
    case 'server settings': {
      const ch = i.options.announce_channel as string | undefined;
      const cat = i.options.voice_category as string | undefined;
      const policy: Record<string, unknown> = {};
      if (optStr(i, 'who_can_create')) policy.tournamentCreation = optStr(i, 'who_can_create');
      if (optBool(i, 'admins_manage_all') != null) policy.serverAdminsManageTournaments = optBool(i, 'admins_manage_all');
      const g = await updateGuildSettings(ctx, uid, i.guildId!, { announcementChannelId: ch, voiceCategoryId: cat, policy });
      return reply(`✅ Saved. Announcements: ${g.announcement_channel_id ? `<#${g.announcement_channel_id}>` : 'not set'} · Voice category: ${g.voice_category_id ? `<#${g.voice_category_id}>` : 'none'}`);
    }
    case 'server role': {
      const g = getGuild(ctx, i.guildId!)!;
      const p = guildPolicy(g);
      const roleId = i.options.role as string;
      const key = optStr(i, 'capability') === 'creator' ? 'creatorRoleIds' : 'presetManagerRoleIds';
      const list = new Set(p[key]);
      if (optBool(i, 'remove')) list.delete(roleId);
      else list.add(roleId);
      await updateGuildSettings(ctx, uid, i.guildId!, { policy: { [key]: [...list] } });
      return reply(`✅ ${key === 'creatorRoleIds' ? 'Tournament creator' : 'Preset manager'} roles: ${[...list].map((r) => `<@&${r}>`).join(', ') || 'none'}${key === 'creatorRoleIds' && p.tournamentCreation !== 'roles' ? '\nNote: set "who can create" to "Admins + creator roles" for this to apply.' : ''}`);
    }
    case 'server info': {
      const g = guildDto(getGuild(ctx, i.guildId!)!);
      let perms = 'unknown';
      try {
        const r = await ctx.discord.botPermissions(i.guildId!);
        perms = r.missing.length ? `missing ${r.missing.join(', ')}` : 'all required permissions granted';
      } catch {
        /* ignore */
      }
      return reply(`**Server settings**\nAnnouncements: ${g.announcementChannelId ? `<#${g.announcementChannelId}>` : 'not set'}\nVoice category: ${g.voiceCategoryId ? `<#${g.voiceCategoryId}>` : 'none'}\nWho can create: ${g.policy.tournamentCreation}\nServer admins manage all tournaments: ${g.policy.serverAdminsManageTournaments ? 'yes' : 'no'}\nBot permissions: ${perms}\nWebsite: ${ctx.env.WEB_URL}`);
    }
    default:
      return reply('Unknown command.');
  }
}

async function nameMap(ctx: AppContext, ids: string[]) {
  const { userNames } = await import('../services/users.js');
  return userNames(ctx, ids);
}

async function handleButton(ctx: AppContext, i: BotInteraction): Promise<BotReply> {
  const [kind, a, b] = (i.customId ?? '').split(':');
  const src = 'discord' as const;
  if (kind === 'confirm') {
    await confirmResult(ctx, i.user.id, Number(a), src);
    return reply('✅ Result confirmed.');
  }
  if (kind === 'vote') {
    const m = getMatch(ctx, Number(a));
    if (!m || loadTournament(ctx, m.tournament_id).guild_id !== i.guildId) return reply('This match is not in this server.');
    const r = await voteResult(ctx, i.user.id, m.id, b === 'b' ? 'b' : 'a', src);
    const team = b === 'b' ? '🟠' : '🔵';
    if (r.outcome === 'completed') return reply(`✅ Result recorded: ${team} won. The next match opens automatically.`);
    if (r.outcome === 'disputed') return reply('⚠️ The votes disagree, so the organizers were asked to set the result.');
    if (r.outcome === 'unchanged') return reply(`You already voted ${team}. Votes so far: 🔵 ${r.tally.a} · 🟠 ${r.tally.b}.`);
    return reply(`🗳️ Vote counted for ${team}. Votes so far: 🔵 ${r.tally.a} · 🟠 ${r.tally.b}.`);
  }
  if (kind === 'avail') {
    const t = loadTournament(ctx, Number(a));
    const answer = await setAvailability(ctx, i.user.id, t.id, null, b === 'no' ? 'declined' : 'confirmed', src);
    return reply(answer === 'confirmed'
      ? `✅ Thanks! The organizers of **${esc(t.name)}** know you can make it. Changed your mind? Tap the other button.`
      : `Got it, the organizers of **${esc(t.name)}** know you can't make it.${t.cfg.registration.allowWithdrawal ? ` If you won't play, please also withdraw so someone else can take your spot: \`/reg leave tournament:${t.id}\` in the server.` : ''}`);
  }
  if (kind === 'inv') {
    await respondInvitation(ctx, i.user.id, Number(b), a === 'accept', src);
    return reply(a === 'accept' ? '✅ You joined the team.' : 'Invitation declined.');
  }
  if (kind === 'applypreset') {
    const t = guildTournament(ctx, i, Number(a));
    await applyPreset(ctx, i.user.id, t.id, Number(b), src);
    return reply('✅ Preset applied.');
  }
  return reply('This button is no longer valid.');
}

/** Text renderings for /view commands (Discord has no tables, so monospace blocks). */
export async function renderView(ctx: AppContext, tournamentId: number, viewerId: string, kind: 'standings' | 'bracket' | 'pools' | 'schedule'): Promise<string> {
  const d = await tournamentDetail(ctx, tournamentId, viewerId);
  const t = d.tournament;
  const link = `${ctx.env.WEB_URL}/#/t/${t.id}`;
  const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
  if (kind === 'standings') {
    if (t.format === 'sixmans') {
      const sm = d.sixmans as { standings: { name: string; standings: { rank: number; name: string; points: number; wins: number; losses: number; goalDiff: number; played: number; qualified: boolean }[] }[] } | null;
      if (!sm?.standings.length) return `No standings yet. ${link}`;
      return `**${esc(t.name)} — standings**\n` + sm.standings.map((p) => `**${p.name}**\n\`\`\`\n#  Player           Pts  W-L  GD   GP\n${p.standings.map((s) => `${pad(String(s.rank), 3)}${pad(s.name, 17)}${pad(String(s.points), 5)}${pad(`${s.wins}-${s.losses}`, 5)}${pad((s.goalDiff > 0 ? '+' : '') + s.goalDiff, 5)}${s.played}${s.qualified ? ' Q' : ''}`).join('\n')}\n\`\`\``).join('\n') + link;
    }
    const st = d.standings as { rank: number; name: string; points: number; wins: number; losses: number; gameDiff: number; buchholz: number }[] | null;
    if (st?.length) return `**${esc(t.name)} — standings**\n\`\`\`\n#  Name             Pts  W-L  GD  Buch\n${st.map((s) => `${pad(String(s.rank), 3)}${pad(s.name, 17)}${pad(String(s.points), 5)}${pad(`${s.wins}-${s.losses}`, 5)}${pad(String(s.gameDiff), 4)}${s.buchholz}`).join('\n')}\n\`\`\`${link}`;
    if (d.placements.length) return `**${esc(t.name)} — final placements**\n${d.placements.map((p) => `${p.placement}. ${esc(p.name)}`).join('\n')}\n${link}`;
    return `Standings appear once matches are played. ${link}`;
  }
  if (kind === 'pools') {
    const sm = d.sixmans as { pools: { status: string; data: { pools: { name: string; players: { userId: string }[] }[] } } | null } | null;
    if (!sm?.pools) return `Pools have not been published yet. ${link}`;
    const names = new Map(d.entries.map((e) => [e.userId, e.name]));
    return `**${esc(t.name)} — pools** (${sm.pools.status})\n${sm.pools.data.pools.map((p) => `**${p.name}**: ${p.players.map((x) => esc(names.get(x.userId) ?? 'Player')).join(', ')}`).join('\n')}\n${link}`;
  }
  const relevant = kind === 'schedule' ? d.matches.filter((m) => ['ready', 'awaiting_confirmation', 'disputed', 'pending'].includes(m.status)).slice(0, 15) : d.matches.filter((m) => m.status !== 'void');
  if (!relevant.length) return `Nothing to show yet. ${link}`;
  const line = (m: (typeof d.matches)[number]) => {
    const res = m.status === 'completed' ? (m.walkover ? 'bye' : m.forfeit ? 'FF' : `${m.winsA}-${m.winsB}`) : m.status === 'pending' ? 'waiting' : m.status.replace('_', ' ');
    const w = (s: 'a' | 'b') => (m.winner === s ? '**' : '');
    return `\`${m.id}\` ${m.label}: ${w('a')}${esc(m.a?.name ?? 'TBD')}${w('a')} vs ${w('b')}${esc(m.b?.name ?? 'TBD')}${w('b')} — ${res}`;
  };
  return `**${esc(t.name)} — ${kind}**\n${relevant.slice(0, 40).map(line).join('\n')}\n${link}`;
}

/** Autocomplete: tournaments of this server visible to the user, presets, setting paths. */
export async function autocomplete(ctx: AppContext, a: { guildId: string | null; userId: string; option: string; value: string }): Promise<{ name: string; value: string | number }[]> {
  if (a.option === 'setting') return SETTING_SUGGESTIONS.filter((s) => s.toLowerCase().includes(a.value.toLowerCase())).slice(0, 25).map((s) => ({ name: s, value: s }));
  if (!a.guildId) return [];
  if (a.option === 'preset') {
    const rows = ctx.db.prepare('SELECT id, name FROM presets WHERE guild_id = ? AND deleted_at IS NULL AND name LIKE ? ORDER BY name LIMIT 25').all(a.guildId, `%${a.value.replace(/[%_]/g, '')}%`) as { id: number; name: string }[];
    return rows.map((r) => ({ name: r.name.slice(0, 100), value: r.id }));
  }
  if (a.option === 'tournament') {
    const list = await listTournaments(ctx, a.userId, { guildId: a.guildId, q: a.value || undefined });
    return list.slice(0, 25).map((t) => ({ name: `#${t.id} ${t.name} (${t.stateLabel})`.slice(0, 100), value: t.id }));
  }
  return [];
}
