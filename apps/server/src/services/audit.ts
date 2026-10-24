import type { AppContext } from './context.js';
import { nowIso } from './context.js';

export interface AuditInput {
  guildId?: string | null;
  tournamentId?: number | null;
  actorId?: string | null;
  action: string;
  target?: string | null;
  details?: Record<string, unknown>;
}

/** Append-only audit trail (enforced by database triggers). */
export function audit(ctx: AppContext, e: AuditInput): void {
  ctx.db
    .prepare('INSERT INTO audit_events (guild_id, tournament_id, actor_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(e.guildId ?? null, e.tournamentId ?? null, e.actorId ?? null, e.action, e.target ?? null, JSON.stringify(e.details ?? {}), nowIso(ctx));
  ctx.log.info({ audit: e.action, tournamentId: e.tournamentId, actor: e.actorId, target: e.target }, 'audit');
}

export function listAudit(ctx: AppContext, tournamentId: number, limit = 200, before?: number) {
  const rows = ctx.db
    .prepare(
      `SELECT a.*, u.username, u.global_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.tournament_id = ? ${before ? 'AND a.id < ?' : ''} ORDER BY a.id DESC LIMIT ?`,
    )
    .all(...(before ? [tournamentId, before, limit] : [tournamentId, limit])) as {
    id: number; actor_id: string | null; action: string; target: string | null; details: string; created_at: string; username: string | null; global_name: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id, actorId: r.actor_id, actorName: r.global_name ?? r.username ?? (r.actor_id ? r.actor_id : 'system'),
    action: r.action, target: r.target, details: JSON.parse(r.details), createdAt: r.created_at,
  }));
}
