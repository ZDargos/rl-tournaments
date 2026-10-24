import type { NotificationCategory } from '@rl/core';
import type { AppContext } from './context.js';
import { nowIso } from './context.js';
import { addMinutes, json } from '../lib/util.js';
import { DiscordApiError, DiscordCodes } from '../discord/port.js';
import { loadTournament, managerIds, participantIds, type LoadedTournament } from './access.js';
import { getGuild } from './guilds.js';
import { renderNotification } from './messages.js';

/**
 * Persistent notification outbox.
 *
 * Every notification is a row with a unique idempotency key, a run time and an audience. Rows are
 * inserted in the same transaction as the change that caused them, so a crash can never lose or
 * duplicate them. The dispatcher (run by the job loop and after each change) claims due rows,
 * re-checks that they are still relevant ("stale" checks), renders fresh content from the database
 * and records one delivery row per (method, target). Delivery rows are written *before* sending
 * ('sending'), so a crash mid-send results in at most one message, never a repeat.
 */

export type Category = NotificationCategory | 'organizer_alert' | 'personal';

export interface EnqueueInput {
  tournamentId: number | null;
  matchId?: number | null;
  category: Category;
  kind?: 'event' | 'reminder';
  key: string;
  runAt?: string;
  expiresAt?: string | null;
  /** participants | match | admins | user:<id> */
  audience: string;
  payload?: Record<string, unknown>;
  ref?: string | null;
}

export function enqueue(ctx: AppContext, n: EnqueueInput): boolean {
  const now = nowIso(ctx);
  const res = ctx.db
    .prepare(
      `INSERT OR IGNORE INTO notifications (tournament_id, match_id, category, kind, idempotency_key, run_at, expires_at, audience, payload, ref, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(n.tournamentId, n.matchId ?? null, n.category, n.kind ?? 'event', n.key, n.runAt ?? now, n.expiresAt ?? null, n.audience, JSON.stringify(n.payload ?? {}), n.ref ?? null, now, now);
  return res.changes > 0;
}

export function cancelPending(ctx: AppContext, where: { tournamentId: number; keyPrefix?: string; matchId?: number }): number {
  const parts = ["tournament_id = ?", "status = 'pending'"];
  const args: unknown[] = [where.tournamentId];
  if (where.keyPrefix) {
    parts.push('idempotency_key LIKE ?');
    args.push(`${where.keyPrefix}%`);
  }
  if (where.matchId) {
    parts.push('match_id = ?');
    args.push(where.matchId);
  }
  return ctx.db.prepare(`UPDATE notifications SET status = 'cancelled', updated_at = ? WHERE ${parts.join(' AND ')}`).run(nowIso(ctx), ...args).changes;
}

/** Insert a reminder, or revive it if an earlier reschedule cancelled the same key. Sent rows are never repeated. */
function upsertReminder(ctx: AppContext, n: EnqueueInput) {
  if (enqueue(ctx, n)) return;
  ctx.db
    .prepare(
      `UPDATE notifications SET status = 'pending', run_at = ?, expires_at = ?, audience = ?, payload = ?, ref = ?, attempts = 0, last_error = NULL, updated_at = ?
       WHERE idempotency_key = ? AND status = 'cancelled'`,
    )
    .run(n.runAt ?? nowIso(ctx), n.expiresAt ?? null, n.audience, JSON.stringify(n.payload ?? {}), n.ref ?? null, nowIso(ctx), n.key);
}

/**
 * Reconcile start and check-in reminders with the tournament's current schedule. Keys include the
 * start time, so moving the start creates fresh reminders and the old ones are cancelled; calling
 * this repeatedly never duplicates anything.
 */
export function scheduleTournamentReminders(ctx: AppContext, t: LoadedTournament) {
  const wanted: EnqueueInput[] = [];
  const active = !['cancelled', 'completed', 'in_progress', 'paused', 'draft'].includes(t.state);
  const now = ctx.clock.now();
  const startAt = t.cfg.schedule.startAt;
  if (active && startAt) {
    const start = new Date(startAt);
    for (const m of t.cfg.notifications.startReminders) {
      const runAt = addMinutes(start, -m);
      if (runAt <= now) continue; // never send a reminder whose moment has already passed
      wanted.push({
        tournamentId: t.id, category: 'tournament_start', kind: 'reminder', key: `t${t.id}:start:${m}:${startAt}`,
        runAt: runAt.toISOString(), expiresAt: startAt, audience: 'participants', payload: { minutes: m }, ref: startAt,
      });
    }
    if (t.cfg.checkIn.enabled) {
      const opens = addMinutes(start, -t.cfg.checkIn.opensMinutesBefore);
      const closes = addMinutes(start, -t.cfg.checkIn.closesMinutesBefore);
      if (opens > now)
        wanted.push({
          tournamentId: t.id, category: 'check_in', kind: 'reminder', key: `t${t.id}:checkin:open:${startAt}`,
          runAt: opens.toISOString(), expiresAt: closes.toISOString(), audience: 'participants', payload: { phase: 'open' }, ref: startAt,
        });
      for (const m of t.cfg.notifications.checkInReminders) {
        const runAt = addMinutes(closes, -m);
        if (runAt <= now || runAt < opens) continue;
        wanted.push({
          tournamentId: t.id, category: 'check_in', kind: 'reminder', key: `t${t.id}:checkin:${m}:${startAt}`,
          runAt: runAt.toISOString(), expiresAt: closes.toISOString(), audience: 'unchecked', payload: { phase: 'closing', minutes: m }, ref: startAt,
        });
      }
    }
  }
  const keep = new Set(wanted.map((w) => w.key));
  const pending = ctx.db
    .prepare("SELECT id, idempotency_key FROM notifications WHERE tournament_id = ? AND status = 'pending' AND (idempotency_key LIKE ? OR idempotency_key LIKE ?)")
    .all(t.id, `t${t.id}:start:%`, `t${t.id}:checkin:%`) as { id: number; idempotency_key: string }[];
  for (const p of pending) if (!keep.has(p.idempotency_key)) ctx.db.prepare("UPDATE notifications SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(ctx), p.id);
  for (const w of wanted) upsertReminder(ctx, w);
}

/** Reminders for an unreported match after it becomes ready. */
export function scheduleMatchReminders(ctx: AppContext, t: LoadedTournament, matchId: number, readyAt: string, resultVersion: number) {
  for (const m of t.cfg.notifications.matchReminders) {
    enqueue(ctx, {
      tournamentId: t.id, matchId, category: 'match_start', kind: 'reminder', key: `m${matchId}:remind:${m}:v${resultVersion}:${readyAt}`,
      runAt: addMinutes(new Date(readyAt), m).toISOString(), audience: 'match', payload: { minutes: m }, ref: `${resultVersion}`,
    });
  }
}

interface NotificationRow {
  id: number;
  tournament_id: number | null;
  match_id: number | null;
  category: Category;
  kind: 'event' | 'reminder';
  idempotency_key: string;
  run_at: string;
  expires_at: string | null;
  audience: string;
  payload: string;
  ref: string | null;
  status: string;
  attempts: number;
}

const MAX_ATTEMPTS = 5;
const DM_BLOCK_DAYS = 7;

/** Is the notification still meaningful right now? Returns a reason if it should be skipped. */
function staleReason(ctx: AppContext, n: NotificationRow, t: LoadedTournament | null): string | null {
  if (n.expires_at && Date.parse(n.expires_at) < ctx.clock.now().getTime()) return 'expired';
  if (!t) return n.tournament_id ? 'tournament_deleted' : null;
  if (t.state === 'cancelled' && n.category !== 'tournament_complete' && n.category !== 'personal') return 'tournament_cancelled';
  if (n.kind === 'reminder') {
    if (n.category === 'tournament_start' || n.category === 'check_in') {
      if (n.ref !== t.cfg.schedule.startAt) return 'start_time_changed';
      if (t.state === 'in_progress' || t.state === 'paused' || t.state === 'completed') return 'already_started';
    }
    if (n.category === 'match_start' && n.match_id) {
      const m = ctx.db.prepare('SELECT status, result_version FROM matches WHERE id = ?').get(n.match_id) as { status: string; result_version: number } | undefined;
      if (!m) return 'match_deleted';
      if (m.status !== 'ready') return 'match_no_longer_pending';
      if (`${m.result_version}` !== n.ref) return 'match_changed';
      if (t.state !== 'in_progress') return 'tournament_not_running';
    }
  }
  if (n.category === 'match_assigned' && n.match_id) {
    const m = ctx.db.prepare('SELECT status FROM matches WHERE id = ?').get(n.match_id) as { status: string } | undefined;
    if (!m || ['completed', 'void', 'cancelled'].includes(m.status)) return 'match_already_finished';
  }
  return null;
}

function audienceUserIds(ctx: AppContext, n: NotificationRow, t: LoadedTournament | null): string[] {
  if (n.audience.startsWith('user:')) return [n.audience.slice(5)];
  if (!t) return [];
  if (n.audience === 'admins') return managerIds(ctx, t);
  if (n.audience === 'participants') return participantIds(ctx, t.id);
  if (n.audience === 'unchecked') {
    return (
      ctx.db
        .prepare(
          `SELECT em.user_id FROM entries e JOIN entry_members em ON em.entry_id = e.id AND em.active = 1
           WHERE e.tournament_id = ? AND e.status = 'confirmed' AND e.checked_in_at IS NULL AND (e.kind = 'player' OR em.role = 'captain')`,
        )
        .all(t.id) as { user_id: string }[]
    ).map((r) => r.user_id);
  }
  if (n.audience === 'match' && n.match_id) {
    return (
      ctx.db
        .prepare(
          `SELECT cm.user_id FROM matches m JOIN competitor_members cm ON cm.competitor_id IN (m.competitor_a, m.competitor_b) WHERE m.id = ?`,
        )
        .all(n.match_id) as { user_id: string }[]
    ).map((r) => r.user_id);
  }
  if (n.audience.startsWith('side:') && n.match_id) {
    const side = n.audience.slice(5) === 'a' ? 'competitor_a' : 'competitor_b';
    return (
      ctx.db.prepare(`SELECT cm.user_id FROM matches m JOIN competitor_members cm ON cm.competitor_id = m.${side} WHERE m.id = ?`).all(n.match_id) as { user_id: string }[]
    ).map((r) => r.user_id);
  }
  return [];
}

/** Effective delivery plan for a category, combining tournament settings. */
export function deliveryPlan(t: LoadedTournament | null, category: Category, audience: string): { channel: boolean; dm: boolean } {
  if (category === 'organizer_alert' || category === 'personal') return { channel: false, dm: true };
  if (!t) return { channel: false, dm: true };
  const c = t.cfg.notifications.categories[category as NotificationCategory] ?? { channel: false, dm: false };
  const personal = audience.startsWith('user:') || audience === 'admins';
  // Requests aimed at one side of a match (e.g. "please confirm this result") go by DM; if the
  // organizer turned DMs off they fall back to the announcement channel with a mention.
  if (audience.startsWith('side:')) {
    const dm = t.cfg.notifications.dms;
    return { dm, channel: !dm && t.cfg.notifications.channelAnnouncements && (t.visibility === 'public' || !!t.cfg.notifications.announcementChannelId) };
  }
  // Private tournaments only announce in a channel the organizer explicitly chose for this tournament.
  const channelAllowed = t.cfg.notifications.channelAnnouncements && (t.visibility === 'public' || !!t.cfg.notifications.announcementChannelId);
  return { channel: !personal && channelAllowed && c.channel, dm: t.cfg.notifications.dms && c.dm };
}

function deliveryExists(ctx: AppContext, notificationId: number, method: string, target: string) {
  return !!ctx.db.prepare('SELECT 1 FROM notification_deliveries WHERE notification_id = ? AND method = ? AND target = ?').get(notificationId, method, target);
}

function recordDelivery(ctx: AppContext, notificationId: number, method: 'channel' | 'dm', target: string, status: 'sending' | 'sent' | 'failed' | 'skipped', error?: string) {
  ctx.db
    .prepare(
      `INSERT INTO notification_deliveries (notification_id, method, target, status, error, attempted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(notification_id, method, target) DO UPDATE SET status = excluded.status, error = excluded.error, attempted_at = excluded.attempted_at`,
    )
    .run(notificationId, method, target, status, error ?? null, nowIso(ctx));
}

export async function dispatchDue(ctx: AppContext, limit = 25): Promise<number> {
  const now = nowIso(ctx);
  const due = ctx.db
    .prepare("SELECT * FROM notifications WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT ?")
    .all(now, limit) as NotificationRow[];
  let processed = 0;
  for (const n of due) {
    // Atomic claim: only one dispatcher run can take a row.
    const claimed = ctx.db.prepare("UPDATE notifications SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'").run(now, n.id).changes;
    if (!claimed) continue;
    processed++;
    try {
      await deliver(ctx, { ...n, attempts: n.attempts + 1 });
    } catch (err) {
      ctx.log.error({ err: String(err), notification: n.id }, 'notification dispatch crashed');
      const attempts = n.attempts + 1;
      ctx.db
        .prepare('UPDATE notifications SET status = ?, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?')
        .run(attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', String(err).slice(0, 500), addMinutes(ctx.clock.now(), 2 ** attempts).toISOString(), nowIso(ctx), n.id);
    }
  }
  return processed;
}

/** Recover rows left in 'processing' by a crash: retry them (delivery rows prevent repeats). */
export function recoverProcessing(ctx: AppContext): number {
  return ctx.db.prepare("UPDATE notifications SET status = 'pending', updated_at = ? WHERE status = 'processing'").run(nowIso(ctx)).changes;
}

async function deliver(ctx: AppContext, n: NotificationRow) {
  let t: LoadedTournament | null = null;
  if (n.tournament_id) {
    try {
      t = loadTournament(ctx, n.tournament_id);
    } catch {
      t = null;
    }
  }
  const finish = (status: string, error?: string) =>
    ctx.db.prepare('UPDATE notifications SET status = ?, last_error = ?, sent_at = ?, updated_at = ? WHERE id = ?').run(status, error ?? null, nowIso(ctx), nowIso(ctx), n.id);
  const stale = staleReason(ctx, n, t);
  if (stale) return finish('skipped', stale);
  if (!ctx.discord.enabled) return finish('skipped', 'discord_disabled');

  const plan = deliveryPlan(t, n.category, n.audience);
  const payload = json<Record<string, unknown>>(n.payload, {});
  const msg = renderNotification(ctx, { category: n.category, kind: n.kind, tournament: t, matchId: n.match_id, payload, audience: n.audience });
  if (!msg) return finish('skipped', 'nothing_to_send');
  let transientFailure: string | null = null;
  let sent = 0;

  if (plan.channel && t) {
    const guild = getGuild(ctx, t.guild_id);
    const channelId = t.cfg.notifications.announcementChannelId ?? guild?.announcement_channel_id ?? null;
    if (!channelId) {
      if (!deliveryExists(ctx, n.id, 'channel', 'none')) recordDelivery(ctx, n.id, 'channel', 'none', 'skipped', 'no_announcement_channel');
    } else if (!deliveryExists(ctx, n.id, 'channel', channelId)) {
      recordDelivery(ctx, n.id, 'channel', channelId, 'sending');
      try {
        await ctx.discord.sendChannelMessage(channelId, { content: msg.channel, mentionUserIds: msg.mentionUserIds });
        recordDelivery(ctx, n.id, 'channel', channelId, 'sent');
        sent++;
      } catch (err) {
        const permanent = err instanceof DiscordApiError && err.permanent;
        if (permanent) recordDelivery(ctx, n.id, 'channel', channelId, 'failed', err.message);
        else {
          ctx.db.prepare('DELETE FROM notification_deliveries WHERE notification_id = ? AND method = ? AND target = ?').run(n.id, 'channel', channelId);
          transientFailure = String(err);
        }
      }
    }
  }

  if (plan.dm) {
    const recipients = [...new Set(audienceUserIds(ctx, n, t))];
    for (const uid of recipients) {
      if (deliveryExists(ctx, n.id, 'dm', uid)) continue;
      const u = ctx.db.prepare('SELECT dms_enabled, dm_blocked_until FROM users WHERE id = ?').get(uid) as { dms_enabled: number; dm_blocked_until: string | null } | undefined;
      const muted = t ? !!ctx.db.prepare('SELECT 1 FROM tournament_mutes WHERE user_id = ? AND tournament_id = ?').get(uid, t.id) : false;
      const blocked = u?.dm_blocked_until && Date.parse(u.dm_blocked_until) > ctx.clock.now().getTime();
      // Muting a tournament never suppresses personal or organizer messages.
      const muteApplies = muted && n.category !== 'personal' && n.category !== 'organizer_alert';
      if (!u || !u.dms_enabled || muteApplies || blocked) {
        recordDelivery(ctx, n.id, 'dm', uid, 'skipped', !u ? 'unknown_user' : !u.dms_enabled ? 'dms_disabled' : muteApplies ? 'muted' : 'dm_unreachable');
        continue;
      }
      recordDelivery(ctx, n.id, 'dm', uid, 'sending');
      try {
        await ctx.discord.sendDM(uid, { content: msg.dm });
        recordDelivery(ctx, n.id, 'dm', uid, 'sent');
        sent++;
      } catch (err) {
        if (err instanceof DiscordApiError && (err.code === DiscordCodes.CannotDM || err.permanent)) {
          recordDelivery(ctx, n.id, 'dm', uid, 'failed', err.message);
          if (err.code === DiscordCodes.CannotDM) {
            // Stop retrying this user for a while so we never spam a closed inbox.
            ctx.db.prepare('UPDATE users SET dm_blocked_until = ? WHERE id = ?').run(addMinutes(ctx.clock.now(), DM_BLOCK_DAYS * 1440).toISOString(), uid);
          }
        } else {
          ctx.db.prepare('DELETE FROM notification_deliveries WHERE notification_id = ? AND method = ? AND target = ?').run(n.id, 'dm', uid);
          transientFailure = String(err);
        }
      }
    }
  }

  if (transientFailure) {
    if (n.attempts >= MAX_ATTEMPTS) return finish(sent ? 'partial' : 'failed', transientFailure);
    ctx.db
      .prepare("UPDATE notifications SET status = 'pending', last_error = ?, run_at = ?, updated_at = ? WHERE id = ?")
      .run(transientFailure.slice(0, 500), addMinutes(ctx.clock.now(), 2 ** n.attempts).toISOString(), nowIso(ctx), n.id);
    return;
  }
  const failed = ctx.db.prepare("SELECT COUNT(*) c FROM notification_deliveries WHERE notification_id = ? AND status = 'failed'").get(n.id) as { c: number };
  finish(sent ? (failed.c ? 'partial' : 'sent') : failed.c ? 'failed' : 'skipped');
}

/**
 * Players who will receive nothing because channel announcements are off (or impossible) and their
 * DMs are off/unreachable or the tournament is muted. Shown to organizers as a warning.
 */
export function unreachablePlayers(ctx: AppContext, t: LoadedTournament): { userId: string; reason: string }[] {
  const plan = deliveryPlan(t, 'tournament_start', 'participants');
  const guild = getGuild(ctx, t.guild_id);
  const channelWorks = plan.channel && !!(t.cfg.notifications.announcementChannelId ?? guild?.announcement_channel_id);
  if (channelWorks && t.cfg.notifications.dms) return [];
  const ids = participantIds(ctx, t.id);
  const out: { userId: string; reason: string }[] = [];
  for (const uid of ids) {
    if (!t.cfg.notifications.dms) {
      if (!channelWorks) out.push({ userId: uid, reason: 'Channel announcements and DMs are both off for this tournament.' });
      continue;
    }
    if (channelWorks) continue;
    const u = ctx.db.prepare('SELECT dms_enabled, dm_blocked_until FROM users WHERE id = ?').get(uid) as { dms_enabled: number; dm_blocked_until: string | null } | undefined;
    const muted = !!ctx.db.prepare('SELECT 1 FROM tournament_mutes WHERE user_id = ? AND tournament_id = ?').get(uid, t.id);
    if (!u?.dms_enabled) out.push({ userId: uid, reason: 'Has turned off bot DMs.' });
    else if (u.dm_blocked_until && Date.parse(u.dm_blocked_until) > ctx.clock.now().getTime()) out.push({ userId: uid, reason: 'Discord refused our last DM (DMs closed).' });
    else if (muted) out.push({ userId: uid, reason: 'Muted this tournament.' });
  }
  return out;
}

export function notificationLog(ctx: AppContext, tournamentId: number, limit = 100) {
  return ctx.db
    .prepare(
      `SELECT n.id, n.category, n.kind, n.run_at, n.status, n.last_error, n.audience, n.match_id,
        (SELECT COUNT(*) FROM notification_deliveries d WHERE d.notification_id = n.id AND d.status = 'sent') AS sent,
        (SELECT COUNT(*) FROM notification_deliveries d WHERE d.notification_id = n.id AND d.status = 'failed') AS failed,
        (SELECT COUNT(*) FROM notification_deliveries d WHERE d.notification_id = n.id AND d.status = 'skipped') AS skipped
       FROM notifications n WHERE n.tournament_id = ? ORDER BY n.run_at DESC, n.id DESC LIMIT ?`,
    )
    .all(tournamentId, limit);
}
