import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('127.0.0.1'),
  /** Public base URL of this API (as reachable by browsers and Discord OAuth), no trailing slash. */
  PUBLIC_API_URL: z.string().url().default('http://localhost:8787'),
  /** Public URL of the website (GitHub Pages), no trailing slash. Used for CORS and redirects. */
  WEB_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_PATH: z.string().default('./data/rl-tournaments.db'),
  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14),
  BACKUP_INTERVAL_HOURS: z.coerce.number().min(1).max(24 * 7).default(24),
  DISCORD_CLIENT_ID: z.string().default(''),
  DISCORD_CLIENT_SECRET: z.string().default(''),
  DISCORD_BOT_TOKEN: z.string().default(''),
  /** Optional: register slash commands to one guild instantly (useful in development). */
  DISCORD_DEV_GUILD_ID: z.string().default(''),
  /** Run without connecting to Discord (website-only / local testing). */
  DISCORD_DISABLED: bool,
  /** Development-only login without Discord. Refused when NODE_ENV=production. */
  DEV_LOGIN: bool,
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  JOB_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(300).default(15),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: bool,
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const env = schema.parse(source);
  if (env.NODE_ENV === 'production' && env.DEV_LOGIN) {
    throw new Error('DEV_LOGIN must not be enabled in production.');
  }
  for (const k of ['PUBLIC_API_URL', 'WEB_URL'] as const) env[k] = env[k].replace(/\/+$/, '');
  return env;
}

export function discordConfigured(env: Env): boolean {
  return !env.DISCORD_DISABLED && !!env.DISCORD_BOT_TOKEN && !!env.DISCORD_CLIENT_ID;
}

export function oauthConfigured(env: Env): boolean {
  return !!env.DISCORD_CLIENT_ID && !!env.DISCORD_CLIENT_SECRET;
}
