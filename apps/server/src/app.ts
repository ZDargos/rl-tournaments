import type { DB } from './db/index.js';
import type { DiscordPort } from './discord/port.js';
import type { Env } from './env.js';
import type { Logger } from './lib/logger.js';
import { systemClock, type Clock } from './lib/util.js';
import type { AppContext } from './services/context.js';
import { dispatchDue } from './services/notifications.js';
import { reconcileTournament } from './services/voice.js';

export function createContext(deps: { env: Env; db: DB; discord: DiscordPort; log: Logger; clock?: Clock }): AppContext {
  let chain: Promise<void> = Promise.resolve();
  const ctx: AppContext = {
    ...deps,
    clock: deps.clock ?? systemClock,
    kick(tournamentId) {
      // Side effects run one at a time, after the triggering transaction has committed.
      chain = chain
        .then(async () => {
          if (tournamentId) await reconcileTournament(ctx, tournamentId);
          await dispatchDue(ctx);
        })
        .catch((err) => deps.log.error({ err: String(err), tournamentId }, 'side effect failed'));
    },
    idle() {
      return chain;
    },
  };
  return ctx;
}
