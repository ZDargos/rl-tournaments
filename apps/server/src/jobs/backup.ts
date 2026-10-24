import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppContext } from '../services/context.js';

/**
 * Online SQLite backup (consistent snapshot while the app keeps running) into BACKUP_DIR,
 * keeping the newest BACKUP_KEEP files. Copy that folder somewhere else (cloud drive, USB disk)
 * for off-machine protection.
 */
export async function runBackup(ctx: AppContext): Promise<string> {
  const dir = resolve(ctx.env.BACKUP_DIR);
  mkdirSync(dir, { recursive: true });
  const stamp = ctx.clock.now().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `rl-tournaments-${stamp}.db`);
  await ctx.db.backup(file);
  const files = readdirSync(dir)
    .filter((f) => /^rl-tournaments-.*\.db$/.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of files.slice(ctx.env.BACKUP_KEEP)) unlinkSync(join(dir, old.f));
  ctx.log.info({ file }, 'database backup written');
  return file;
}
