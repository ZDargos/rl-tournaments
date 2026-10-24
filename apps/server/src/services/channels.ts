import type { AppContext } from './context.js';
import { nowIso } from './context.js';
import type { LoadedTournament } from './access.js';
import { getGuild } from './guilds.js';
import { DiscordApiError } from '../discord/port.js';

/**
 * The tournament's text channels: announcements, and an optional separate registration channel
 * (registration open/closed posts and the start time vote). Every message the bot posts there is
 * recorded, so the channels can be cleared once the tournament is over.
 */

export type ChannelKind = 'announcement' | 'registration';

/** The channel the organizer picked for this tournament, without the server default. */
export function chosenChannel(t: LoadedTournament, kind: ChannelKind): string | null {
  const n = t.cfg.notifications;
  return (kind === 'registration' ? n.registrationChannelId : null) ?? n.announcementChannelId;
}

/** Where to post: the tournament's own channel, else (public tournaments only) the server default. */
export function tournamentChannel(ctx: AppContext, t: LoadedTournament, kind: ChannelKind): string | null {
  const chosen = chosenChannel(t, kind);
  if (chosen) return chosen;
  if (t.visibility !== 'public') return null;
  return getGuild(ctx, t.guild_id)?.announcement_channel_id ?? null;
}

export function recordPost(ctx: AppContext, tournamentId: number, channelId: string, messageId: string) {
  ctx.db.prepare('INSERT OR IGNORE INTO channel_posts (tournament_id, channel_id, message_id, created_at) VALUES (?, ?, ?, ?)').run(tournamentId, channelId, messageId, nowIso(ctx));
}

/** Delete the recorded posts of tournaments that ended (and whose delay has passed). Safe to repeat. */
export async function clearEndedChannels(ctx: AppContext, limit = 50): Promise<number> {
  if (!ctx.discord.enabled) return 0;
  const rows = ctx.db
    .prepare(
      `SELECT p.id, p.channel_id, p.message_id, t.config, COALESCE(t.completed_at, t.cancelled_at) AS ended_at
       FROM channel_posts p JOIN tournaments t ON t.id = p.tournament_id
       WHERE p.status = 'posted' AND t.state IN ('completed', 'cancelled') ORDER BY p.id LIMIT ?`,
    )
    .all(limit * 4) as { id: number; channel_id: string; message_id: string; config: string; ended_at: string | null }[];
  const now = ctx.clock.now().getTime();
  let deleted = 0;
  for (const r of rows) {
    if (deleted >= limit) break;
    const n = (JSON.parse(r.config) as { notifications?: { clearChannelsOnEnd?: boolean; clearChannelsAfterHours?: number } }).notifications ?? {};
    if (n.clearChannelsOnEnd === false) continue;
    if (r.ended_at && Date.parse(r.ended_at) + (n.clearChannelsAfterHours ?? 0) * 3600_000 > now) continue;
    const set = (status: 'deleted' | 'failed', error: string | null = null) => ctx.db.prepare('UPDATE channel_posts SET status = ?, error = ? WHERE id = ?').run(status, error, r.id);
    try {
      await ctx.discord.deleteChannelMessage(r.channel_id, r.message_id);
      set('deleted');
      deleted++;
    } catch (err) {
      // No permission or the channel is gone: nothing more we can do. Anything else is retried next run.
      if (err instanceof DiscordApiError && err.permanent) set('failed', err.message.slice(0, 300));
      else ctx.log.warn({ err: String(err), post: r.id }, 'deleting a tournament post failed; will retry');
    }
  }
  return deleted;
}
