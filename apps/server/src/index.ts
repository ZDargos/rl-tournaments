import { loadEnv, discordConfigured } from './env.js';
import { createLogger } from './lib/logger.js';
import { migrate, openDatabase } from './db/index.js';
import { createContext } from './app.js';
import { buildServer } from './api/server.js';
import { JobRunner } from './jobs/scheduler.js';
import { FakeDiscord, type DiscordPort } from './discord/port.js';

async function main() {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL);
  const db = openDatabase(env.DATABASE_PATH);
  const ran = migrate(db);
  if (ran.length) log.info({ ran }, 'applied migrations');

  let discord: DiscordPort;
  let client: import('discord.js').Client | null = null;
  if (discordConfigured(env)) {
    const { createClient } = await import('./discord/bot.js');
    const { DiscordJsAdapter } = await import('./discord/adapter.js');
    client = createClient();
    discord = new DiscordJsAdapter(client);
  } else {
    log.warn('Discord bot is not configured (or DISCORD_DISABLED=true): running website/API only. Notifications and voice channels are not sent.');
    discord = new FakeDiscord(false);
  }

  const ctx = createContext({ env, db, discord, log });
  if (client) {
    const { attachBot } = await import('./discord/bot.js');
    attachBot(ctx, client);
    const ready = new Promise<void>((resolve) => client!.once('clientReady', () => resolve()));
    await client.login(env.DISCORD_BOT_TOKEN);
    await ready;
  }

  const app = await buildServer(ctx);
  await app.listen({ host: env.HOST, port: env.PORT });
  log.info({ host: env.HOST, port: env.PORT, web: env.WEB_URL }, 'api listening');

  const jobs = new JobRunner(ctx);
  await jobs.startup();
  jobs.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    jobs.stop();
    await app.close().catch(() => undefined);
    await Promise.race([ctx.idle(), new Promise((r) => setTimeout(r, 5000))]);
    await client?.destroy().catch(() => undefined);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error({ err: String(err) }, 'unhandled rejection'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
