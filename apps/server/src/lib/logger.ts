import pino from 'pino';

export type Logger = pino.Logger;

/** Structured JSON logs. Secrets are redacted by key name wherever they might appear. */
export function createLogger(level: string, enabled = true): Logger {
  return pino({
    level,
    enabled,
    base: { app: 'rl-tournaments' },
    redact: {
      paths: ['*.token', '*.accessToken', '*.access_token', '*.client_secret', '*.authorization', 'req.headers.authorization', 'headers.authorization', '*.code'],
      censor: '[redacted]',
    },
  });
}
