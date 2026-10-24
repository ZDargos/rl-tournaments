import { loadEnv } from './env.js';
import { createLogger } from './lib/logger.js';
import { migrate, openDatabase } from './db/index.js';
import { createContext } from './app.js';
import { FakeDiscord } from './discord/port.js';
import { runBackup } from './jobs/backup.js';
import { COMMANDS } from './discord/commands.js';

const USAGE = `Usage: node dist/cli.js <command>
  migrate             Apply database migrations
  backup              Write a consistent SQLite backup to BACKUP_DIR now
  register-commands   Register slash commands with Discord (to DISCORD_DEV_GUILD_ID if set, else globally)
  restore <file>      Print the steps to restore a backup (never overwrites anything automatically)`;

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL);
  switch (cmd) {
    case 'migrate': {
      const db = openDatabase(env.DATABASE_PATH);
      const ran = migrate(db);
      console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database is up to date.');
      db.close();
      return;
    }
    case 'backup': {
      const db = openDatabase(env.DATABASE_PATH);
      migrate(db);
      const ctx = createContext({ env, db, discord: new FakeDiscord(false), log });
      console.log(`Backup written: ${await runBackup(ctx)}`);
      db.close();
      return;
    }
    case 'register-commands': {
      if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_CLIENT_ID) throw new Error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required.');
      const { REST, Routes } = await import('discord.js');
      const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
      const route = env.DISCORD_DEV_GUILD_ID ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_DEV_GUILD_ID) : Routes.applicationCommands(env.DISCORD_CLIENT_ID);
      const res = (await rest.put(route, { body: COMMANDS })) as unknown[];
      console.log(`Registered ${res.length} commands ${env.DISCORD_DEV_GUILD_ID ? `to guild ${env.DISCORD_DEV_GUILD_ID}` : 'globally'}.`);
      return;
    }
    case 'restore': {
      console.log(`To restore ${arg ?? '<backup file>'}:
  1. Stop the server.
  2. Move the current database (${env.DATABASE_PATH}) and its -wal/-shm files somewhere safe.
  3. Copy the backup file to ${env.DATABASE_PATH}.
  4. Start the server; migrations run automatically and voice channels are reconciled.`);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
