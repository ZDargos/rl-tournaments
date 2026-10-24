import type { DB } from '../db/index.js';
import type { DiscordPort } from '../discord/port.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { Clock } from '../lib/util.js';

export interface AppContext {
  db: DB;
  discord: DiscordPort;
  clock: Clock;
  log: Logger;
  env: Env;
  /** Schedule asynchronous side effects (voice sync, notification dispatch) after a change. */
  kick(tournamentId: number | null): void;
  /** Resolves when all kicked side effects have finished (used by tests and graceful shutdown). */
  idle(): Promise<void>;
}

export type Source = 'web' | 'discord' | 'system';

export function nowIso(ctx: Pick<AppContext, 'clock'>): string {
  return ctx.clock.now().toISOString();
}

/** Run `fn` inside a SQLite transaction (IMMEDIATE, so concurrent writers serialise). */
export function tx<T>(ctx: Pick<AppContext, 'db'>, fn: () => T): T {
  return ctx.db.transaction(fn).immediate();
}
