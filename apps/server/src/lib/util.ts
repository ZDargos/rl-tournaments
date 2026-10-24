import { createHash, randomBytes } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
export const iso = (d: Date) => d.toISOString();
export const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

/** Format a UTC instant in a tournament's timezone for display in Discord messages. */
export function formatInZone(isoString: string, timeZone: string): string {
  const d = new Date(isoString);
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** Discord timestamp markup renders in each reader's own local time. */
export const discordTime = (isoString: string, style: 'f' | 'R' | 'F' = 'f') => `<t:${Math.floor(Date.parse(isoString) / 1000)}:${style}>`;

/** Neutralise Discord markdown and mention syntax in user-provided text. */
export function escapeDiscord(text: string): string {
  return text.replace(/([\\*_~`|>#\-[\]()])/g, '\\$1').replace(/@/g, '@\u200b');
}
