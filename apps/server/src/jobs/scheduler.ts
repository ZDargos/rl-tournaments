import type { AppContext } from '../services/context.js';
import { nowIso } from '../services/context.js';
import { dispatchDue, enqueue, recoverProcessing } from '../services/notifications.js';
import { autoConfirmDue } from '../services/results.js';
import { expireInvitations } from '../services/registration.js';
import { reconcileAll, reconcileLobbies } from '../services/voice.js';
import { syncAllScoreCards } from '../services/scorecards.js';
import { cleanupAuth } from '../auth/sessions.js';
import { loadTournament } from '../services/access.js';
import { transition } from '../services/tournaments.js';
import { startTournament } from '../services/engine.js';
import { DomainError } from '@rl/core';
import { runBackup } from './backup.js';

/**
 * Background work is driven entirely by database state, so it survives restarts:
 *   - due notifications (reminders included) are read from the outbox table,
 *   - registration open/close and auto-start are derived from tournament settings,
 *   - voice channels are reconciled against the match table.
 * If the process is offline, everything that became due is handled on the next start: events are
 * still delivered (unless their expiry passed) and reminders whose moment has passed are skipped.
 */
export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticks = 0;

  constructor(private ctx: AppContext) {}

  async startup() {
    const recovered = recoverProcessing(this.ctx);
    if (recovered) this.ctx.log.info({ recovered }, 'recovered in-flight notifications');
    await reconcileAll(this.ctx, true);
    await this.tick();
  }

  start() {
    const ms = this.ctx.env.JOB_INTERVAL_SECONDS * 1000;
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    const ctx = this.ctx;
    try {
      this.ticks++;
      await this.registrationWindows();
      await this.autoStarts();
      autoConfirmDue(ctx);
      expireInvitations(ctx);
      let sent = 0;
      do sent = await dispatchDue(ctx, 25);
      while (sent === 25);
      if (this.ticks % 20 === 0) await reconcileAll(ctx, this.ticks % 120 === 0);
      else await reconcileLobbies(ctx);
      await syncAllScoreCards(ctx);
      if (this.ticks % 240 === 0) cleanupAuth(ctx);
      await this.maybeBackup();
      ctx.db.prepare("INSERT INTO job_state (name, last_run_at) VALUES ('tick', ?) ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at").run(nowIso(ctx));
    } catch (err) {
      ctx.log.error({ err: String(err), stack: (err as Error).stack }, 'job tick failed');
    } finally {
      this.running = false;
    }
  }

  private async registrationWindows() {
    const now = nowIso(this.ctx);
    const rows = this.ctx.db.prepare("SELECT id FROM tournaments WHERE state IN ('published','registration_open','registration_closed')").all() as { id: number }[];
    for (const r of rows) {
      const t = loadTournament(this.ctx, r.id);
      const { opensAt, closesAt } = t.cfg.registration;
      try {
        if (t.state === 'published' && opensAt && opensAt <= now && (!closesAt || closesAt > now)) await transition(this.ctx, null, t.id, 'open_registration', { source: 'system' });
        else if (t.state === 'registration_open' && closesAt && closesAt <= now) await transition(this.ctx, null, t.id, 'close_registration', { source: 'system' });
      } catch (err) {
        this.ctx.log.warn({ err: String(err), tournamentId: t.id }, 'registration window transition failed');
      }
    }
  }

  private async autoStarts() {
    const now = nowIso(this.ctx);
    const rows = this.ctx.db
      .prepare("SELECT id FROM tournaments WHERE state IN ('published','registration_open','registration_closed','ready') AND start_at IS NOT NULL AND start_at <= ?")
      .all(now) as { id: number }[];
    for (const r of rows) {
      const t = loadTournament(this.ctx, r.id);
      if (!t.cfg.schedule.autoStart) continue;
      const marker = `${t.cfg.schedule.startAt}|`;
      if (t.auto_start_error?.startsWith(marker)) continue; // already failed for this start time; organizer was told
      try {
        await startTournament(this.ctx, null, t.id, { source: 'system' });
        this.ctx.log.info({ tournamentId: t.id }, 'tournament auto-started');
      } catch (err) {
        const msg = err instanceof DomainError ? err.message : String(err);
        this.ctx.db.prepare('UPDATE tournaments SET auto_start_error = ?, version = version + 1 WHERE id = ?').run(`${marker}${msg}`.slice(0, 1000), t.id);
        enqueue(this.ctx, { tournamentId: t.id, category: 'organizer_alert', key: `t${t.id}:autostart-failed:${t.cfg.schedule.startAt}`, audience: 'admins', payload: { text: `The scheduled start did not happen. ${msg}` } });
        this.ctx.log.warn({ tournamentId: t.id, err: msg }, 'auto-start blocked');
      }
    }
  }

  private async maybeBackup() {
    const row = this.ctx.db.prepare("SELECT last_run_at FROM job_state WHERE name = 'backup'").get() as { last_run_at: string } | undefined;
    const due = !row?.last_run_at || this.ctx.clock.now().getTime() - Date.parse(row.last_run_at) > this.ctx.env.BACKUP_INTERVAL_HOURS * 3600_000;
    if (!due || this.ctx.env.DATABASE_PATH === ':memory:') return;
    try {
      const file = await runBackup(this.ctx);
      this.ctx.db.prepare("INSERT INTO job_state (name, last_run_at, data) VALUES ('backup', ?, ?) ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, data = excluded.data").run(nowIso(this.ctx), JSON.stringify({ file }));
    } catch (err) {
      this.ctx.log.error({ err: String(err) }, 'backup failed');
    }
  }
}
