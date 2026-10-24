import type { AppContext } from './context.js';
import { nowIso } from './context.js';
import { loadTournament, managerIds, participantIds, type LoadedTournament } from './access.js';
import { getGuild } from './guilds.js';
import { enqueue } from './notifications.js';
import { competitorMembers, competitorName, type MatchRow } from './queries.js';
import { DiscordApiError, DiscordCodes } from '../discord/port.js';
import { json } from '../lib/util.js';
import { audit } from './audit.js';

/**
 * Temporary team voice channels, managed by reconciliation:
 *   desired = one private channel per side of every active match (ready / awaiting confirmation /
 *             disputed) in a running tournament with voice enabled. 1v1 sides are single players,
 *             so each player gets an individual channel.
 *   actual  = rows in voice_channels (the auditable match <-> channel mapping).
 * reconcile() creates what is missing, recreates channels whose membership changed, and deletes
 * channels whose match finished (immediately when a result completes the match). It is idempotent,
 * so it is safe after restarts and retries. Only channels recorded in voice_channels are ever deleted.
 * A row is written ('creating') *before* the Discord call; the partial unique index on live rows
 * prevents duplicate channels, and a crashed 'creating' row is adopted by its exact name on recovery.
 */

interface VoiceRow {
  id: number;
  tournament_id: number;
  match_id: number;
  guild_id: string;
  slot: 'a' | 'b';
  generation: number;
  name: string;
  channel_id: string | null;
  member_ids: string;
  status: 'creating' | 'active' | 'deleting' | 'deleted' | 'failed';
  error: string | null;
  updated_at: string;
}

const ACTIVE = new Set(['ready', 'awaiting_confirmation', 'disputed']);
const FAILED_RETRY_MS = 10 * 60_000;
const REQUIRED = 'Manage Channels, Move Members, View Channel and Connect';

function channelName(t: LoadedTournament, m: MatchRow, slot: 'a' | 'b', gen: number, sideName: string) {
  const icon = slot === 'a' ? '🔵' : '🟠';
  const base = `${icon} ${sideName}`.slice(0, 60);
  return `${base} · M${m.id}${slot.toUpperCase()}${gen > 1 ? `-${gen}` : ''}`.slice(0, 100);
}

function liveRows(ctx: AppContext, matchId: number): VoiceRow[] {
  return ctx.db.prepare("SELECT * FROM voice_channels WHERE match_id = ? AND status IN ('creating','active','deleting')").all(matchId) as VoiceRow[];
}

async function deleteRow(ctx: AppContext, row: VoiceRow) {
  ctx.db.prepare("UPDATE voice_channels SET status = 'deleting', updated_at = ? WHERE id = ?").run(nowIso(ctx), row.id);
  try {
    if (row.channel_id) await ctx.discord.deleteChannel(row.guild_id, row.channel_id);
    ctx.db.prepare("UPDATE voice_channels SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(nowIso(ctx), nowIso(ctx), row.id);
  } catch (err) {
    // Leave it in 'deleting'; the next reconcile retries. Unknown channel = already gone.
    if (err instanceof DiscordApiError && err.code === DiscordCodes.UnknownChannel)
      ctx.db.prepare("UPDATE voice_channels SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(nowIso(ctx), nowIso(ctx), row.id);
    else ctx.db.prepare('UPDATE voice_channels SET error = ?, updated_at = ? WHERE id = ?').run(String(err).slice(0, 300), nowIso(ctx), row.id);
  }
}

async function createFor(ctx: AppContext, t: LoadedTournament, m: MatchRow, slot: 'a' | 'b', members: string[], generation: number, existing?: VoiceRow) {
  const guild = getGuild(ctx, t.guild_id)!;
  const name = channelName(t, m, slot, generation, competitorName(ctx, slot === 'a' ? m.competitor_a : m.competitor_b));
  let rowId = existing?.id;
  if (!rowId) {
    try {
      const r = ctx.db
        .prepare("INSERT INTO voice_channels (tournament_id, match_id, guild_id, slot, generation, name, member_ids, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)")
        .run(t.id, m.id, t.guild_id, slot, generation, name, JSON.stringify(members), nowIso(ctx), nowIso(ctx));
      rowId = Number(r.lastInsertRowid);
    } catch {
      return; // another reconcile run is already creating this channel
    }
  }
  const parentId = t.cfg.voice.categoryId ?? guild.voice_category_id ?? null;
  try {
    let channelId: string | null = null;
    if (existing && !existing.channel_id) {
      // Crash recovery: adopt a channel that was created but not recorded.
      const found = (await ctx.discord.listChannels(t.guild_id)).find((c) => c.type === 'voice' && c.name === existing.name);
      channelId = found?.id ?? null;
    }
    if (!channelId) {
      const created = await ctx.discord.createVoiceChannel({
        guildId: t.guild_id, name: existing?.name ?? name, parentId, memberIds: members, organizerIds: managerIds(ctx, t),
        viewerIds: t.cfg.voice.visibleToParticipants ? participantIds(ctx, t.id) : [],
      });
      channelId = created.id;
    }
    ctx.db.prepare("UPDATE voice_channels SET channel_id = ?, status = 'active', error = NULL, updated_at = ? WHERE id = ?").run(channelId, nowIso(ctx), rowId);
    if (t.cfg.voice.moveConnectedPlayers) {
      for (const u of members) {
        try {
          const current = await ctx.discord.getMemberVoiceChannel(t.guild_id, u);
          // A bot cannot pull a disconnected user into voice; they get the channel link instead.
          if (current && current !== channelId) await ctx.discord.moveMember(t.guild_id, u, channelId);
        } catch (err) {
          ctx.log.info({ err: String(err), user: u, match: m.id }, 'could not move player into team voice channel');
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const permission = err instanceof DiscordApiError && (err.code === DiscordCodes.MissingPermissions || err.code === DiscordCodes.MissingAccess);
    ctx.db.prepare("UPDATE voice_channels SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(msg.slice(0, 300), nowIso(ctx), rowId);
    ctx.log.warn({ err: msg, match: m.id, slot }, 'voice channel creation failed');
    enqueue(ctx, {
      tournamentId: t.id, matchId: m.id, category: 'organizer_alert', key: `voicefail:${m.id}:${slot}:${generation}`, audience: 'admins',
      payload: {
        text: permission
          ? `I could not create the voice channel for match ${m.id}: the bot needs ${REQUIRED} (in the voice category too). Players were told to use any channel.`
          : `Creating the voice channel for match ${m.id} failed (${msg.slice(0, 120)}). I will retry automatically; you can also run /voice repair.`,
      },
    });
  }
}

export async function reconcileTournament(ctx: AppContext, tournamentId: number, opts: { verifyExisting?: boolean; force?: boolean } = {}) {
  if (!ctx.discord.enabled) return;
  let t: LoadedTournament;
  try {
    t = loadTournament(ctx, tournamentId);
  } catch {
    return;
  }
  const guild = getGuild(ctx, t.guild_id);
  const running = t.state === 'in_progress' || t.state === 'paused';
  const voiceOn = t.cfg.voice.enabled && !!guild?.bot_present;
  const matches = ctx.db.prepare('SELECT * FROM matches WHERE tournament_id = ?').all(t.id) as MatchRow[];
  const live = ctx.db.prepare("SELECT * FROM voice_channels WHERE tournament_id = ? AND status IN ('creating','active','deleting')").all(t.id) as VoiceRow[];
  const byMatch = new Map<number, VoiceRow[]>();
  for (const r of live) {
    if (!byMatch.has(r.match_id)) byMatch.set(r.match_id, []);
    byMatch.get(r.match_id)!.push(r);
  }
  for (const m of matches) {
    const desired = running && voiceOn && ACTIVE.has(m.status) && m.competitor_a && m.competitor_b;
    const rows = byMatch.get(m.id) ?? [];
    if (!desired) {
      if (!(t.state === 'paused' && ACTIVE.has(m.status))) for (const r of rows) await deleteRow(ctx, r);
      continue;
    }
    for (const slot of ['a', 'b'] as const) {
      const members = competitorMembers(ctx, slot === 'a' ? m.competitor_a : m.competitor_b).sort();
      const row = rows.find((r) => r.slot === slot);
      if (row?.status === 'deleting') {
        await deleteRow(ctx, row);
        continue;
      }
      if (row?.status === 'creating') {
        if (!row.channel_id) await createFor(ctx, t, m, slot, members, row.generation, row);
        continue;
      }
      if (row?.status === 'active') {
        const same = JSON.stringify(json<string[]>(row.member_ids, []).sort()) === JSON.stringify(members);
        let exists = true;
        if (opts.verifyExisting && row.channel_id) exists = await ctx.discord.channelExists(row.guild_id, row.channel_id).catch(() => true);
        if (same && exists) continue;
        // Assignment changed (roster correction / bracket swap) or channel deleted by hand: rebuild.
        if (exists) await deleteRow(ctx, row);
        else ctx.db.prepare("UPDATE voice_channels SET status = 'deleted', deleted_at = ?, error = 'deleted outside the bot' WHERE id = ?").run(nowIso(ctx), row.id);
        await createFor(ctx, t, m, slot, members, row.generation + 1);
        continue;
      }
      const lastFailed = ctx.db.prepare("SELECT * FROM voice_channels WHERE match_id = ? AND slot = ? ORDER BY id DESC LIMIT 1").get(m.id, slot) as VoiceRow | undefined;
      if (!opts.force && lastFailed?.status === 'failed' && ctx.clock.now().getTime() - Date.parse(lastFailed.updated_at) < FAILED_RETRY_MS) continue;
      const gen = (lastFailed?.generation ?? 0) + 1;
      await createFor(ctx, t, m, slot, members, gen);
    }
  }
}

/** Startup/periodic: reconcile every tournament that is running or still owns live channels. */
export async function reconcileAll(ctx: AppContext, verifyExisting = false) {
  const ids = ctx.db
    .prepare("SELECT id FROM tournaments WHERE state IN ('in_progress','paused') UNION SELECT DISTINCT tournament_id FROM voice_channels WHERE status IN ('creating','active','deleting')")
    .all() as { id: number }[];
  for (const r of ids) {
    try {
      await reconcileTournament(ctx, r.id, { verifyExisting });
    } catch (err) {
      ctx.log.error({ err: String(err), tournamentId: r.id }, 'voice reconcile failed');
    }
  }
}

export async function repairVoice(ctx: AppContext, actorId: string, tournamentId: number) {
  const t = loadTournament(ctx, tournamentId);
  const { assertManage } = await import('./access.js');
  await assertManage(ctx, t, actorId);
  audit(ctx, { guildId: t.guild_id, tournamentId, actorId, action: 'voice.repair' });
  await reconcileTournament(ctx, tournamentId, { verifyExisting: true, force: true });
  return voiceStatus(ctx, tournamentId);
}

export function voiceStatus(ctx: AppContext, tournamentId: number) {
  return (ctx.db.prepare("SELECT * FROM voice_channels WHERE tournament_id = ? AND (status IN ('creating','active','deleting','failed')) ORDER BY match_id, slot, id DESC").all(tournamentId) as VoiceRow[]).map((r) => ({
    id: r.id, matchId: r.match_id, slot: r.slot, name: r.name, channelId: r.channel_id, status: r.status, error: r.error, memberIds: json<string[]>(r.member_ids, []),
  }));
}
