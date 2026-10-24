import { availableActions, FORMAT_LABELS, isPreStart, rankLabel, STATE_LABELS, type GameScore } from '@rl/core';
import type { AppContext } from './context.js';
import { adminIds, assertView, getAccess, loadTournament, type Access, type LoadedTournament } from './access.js';
import { getGuild, guildDto } from './guilds.js';
import { notificationLog, unreachablePlayers } from './notifications.js';
import { competitorsOf, matchesOf, matchLabel, membersByCompetitor, type MatchRow } from './queries.js';
import { entriesOf, entryMembers, entryForUser } from './registration.js';
import { availabilityOf } from './availability.js';
import { userNames } from './users.js';
import { checkStart, standardStandings, swissTotalRounds } from './engine.js';
import { currentPlan, poolStandings, qualifiersPerPool } from './sixmans.js';
import { voiceStatus } from './voice.js';
import { json } from '../lib/util.js';
import { reportsFor } from './results.js';

export function tournamentSummary(ctx: AppContext, t: LoadedTournament) {
  const count = (ctx.db.prepare("SELECT COUNT(*) c FROM entries WHERE tournament_id = ? AND status = 'confirmed'").get(t.id) as { c: number }).c;
  const g = getGuild(ctx, t.guild_id);
  return {
    id: t.id, name: t.name, guildId: t.guild_id, guildName: g?.name ?? 'Unknown server', visibility: t.visibility, state: t.state, stateLabel: STATE_LABELS[t.state],
    stage: t.stage, format: t.format, formatLabel: FORMAT_LABELS[t.format], teamSize: t.cfg.teamSize, startAt: t.cfg.schedule.startAt, timezone: t.cfg.schedule.timezone,
    confirmedEntries: count, capacity: t.cfg.registration.capacity, version: t.version, createdAt: t.created_at, completedAt: t.completed_at, archived: !!t.archived_at,
  };
}

/** List tournaments the viewer may see (public ones + private ones they belong to). */
export async function listTournaments(ctx: AppContext, viewerId: string | null, filter: { guildId?: string; state?: string; q?: string; mine?: boolean; includeArchived?: boolean }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.guildId) {
    where.push('guild_id = ?');
    args.push(filter.guildId);
  }
  if (filter.state === 'active') where.push("state IN ('published','registration_open','registration_closed','ready','in_progress','paused')");
  else if (filter.state === 'finished') where.push("state IN ('completed','cancelled')");
  else if (filter.state) {
    where.push('state = ?');
    args.push(filter.state);
  }
  if (!filter.includeArchived) where.push('archived_at IS NULL');
  if (filter.q) {
    where.push('name LIKE ?');
    args.push(`%${filter.q.replace(/[%_]/g, '')}%`);
  }
  const rows = ctx.db.prepare(`SELECT id FROM tournaments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(start_at, created_at) DESC LIMIT 300`).all(...args) as { id: number }[];
  const out = [];
  for (const r of rows) {
    const t = loadTournament(ctx, r.id);
    // Drafts are visible only to their managers; private tournaments only to members.
    const a = await getAccess(ctx, t, viewerId);
    if (!a.canView) continue;
    if (t.state === 'draft' && !a.canManage) continue;
    if (filter.mine && a.role === 'viewer') continue;
    out.push({ ...tournamentSummary(ctx, t), role: a.role });
    if (out.length >= 100) break;
  }
  return out;
}

function matchDto(ctx: AppContext, m: MatchRow, names: Map<number, string>, members: Map<number, { userId: string; role: string }[]>, userName: Map<string, string>, poolNames: Map<number, string>) {
  const side = (cid: number | null) => cid ? { competitorId: cid, name: names.get(cid) ?? 'TBD', players: (members.get(cid) ?? []).map((x) => ({ userId: x.userId, name: userName.get(x.userId) ?? 'Player', role: x.role })) } : null;
  return {
    id: m.id, stage: m.stage, bracket: m.bracket, round: m.round, position: m.position, key: m.key, poolId: m.pool_id, label: matchLabel(m, m.pool_id ? poolNames.get(m.pool_id) : null),
    bestOf: m.best_of, status: m.status, a: side(m.competitor_a), b: side(m.competitor_b), winner: m.winner, walkover: !!m.walkover, forfeit: !!m.forfeit,
    winsA: m.wins_a, winsB: m.wins_b, goalsA: m.goals_a, goalsB: m.goals_b, games: json<GameScore[]>(m.games, []), liveGames: json<GameScore[]>(m.live_games, []),
    sourceA: m.source_a ? JSON.parse(m.source_a) : null, sourceB: m.source_b ? JSON.parse(m.source_b) : null, readyAt: m.ready_at, completedAt: m.completed_at, resultVersion: m.result_version,
  };
}

export async function tournamentDetail(ctx: AppContext, id: number, viewerId: string | null) {
  const t = loadTournament(ctx, id);
  const access = await assertView(ctx, t, viewerId);
  const manage = access.canManage;
  const entries = entriesOf(ctx, t.id);
  const memberRows = new Map(entries.map((e) => [e.id, entryMembers(ctx, e.id)]));
  const allUserIds = [...new Set([t.created_by, ...adminIds(ctx, t.id), ...[...memberRows.values()].flat().map((m) => m.user_id)])];
  const comps = competitorsOf(ctx, t.id);
  const members = membersByCompetitor(ctx, t.id);
  for (const ms of members.values()) for (const m of ms) allUserIds.push(m.userId);
  const names = userNames(ctx, allUserIds);
  const compNames = new Map(comps.map((c) => [c.id, c.name]));
  const pools = ctx.db.prepare('SELECT * FROM pools WHERE tournament_id = ? ORDER BY idx').all(t.id) as { id: number; idx: number; name: string }[];
  const poolNames = new Map(pools.map((p) => [p.id, p.name]));
  const matches = matchesOf(ctx, t.id).map((m) => matchDto(ctx, m, compNames, members, names, poolNames));
  const visibleEntries = entries.filter((e) => manage || ['confirmed', 'pending', 'waitlisted'].includes(e.status));
  const showSkill = manage; // skill inputs are organizer-only
  // Availability is for organizers (and each player sees their own).
  const avail = availabilityOf(ctx, t);
  const availOf = (userId: string) => (manage || userId === viewerId ? avail.get(userId)?.status ?? 'not_asked' : undefined);
  const entryDtos = visibleEntries.map((e) => ({
    id: e.id, kind: e.kind, name: e.kind === 'team' ? e.name : names.get(e.user_id!) ?? 'Player', userId: e.user_id, captainId: e.captain_id, status: e.status,
    checkedIn: !!e.checked_in_at, rosterLocked: !!e.roster_locked, createdAt: e.created_at,
    seed: showSkill ? e.seed : null, rank: showSkill || e.user_id === viewerId ? e.rank : null, rankLabel: (showSkill || e.user_id === viewerId) && e.rank ? rankLabel(e.rank, e.rank_division) : null, division: showSkill ? e.rank_division : null,
    members: (memberRows.get(e.id) ?? []).map((m) => ({ userId: m.user_id, name: names.get(m.user_id) ?? 'Player', role: m.role, availability: availOf(m.user_id) })),
    availability: e.kind === 'player' ? availOf(e.user_id!) : undefined,
  }));
  let standings: unknown = null;
  if ((t.format === 'swiss' || t.format === 'round_robin') && t.started_at) {
    standings = standardStandings(ctx, t).map((s) => ({ ...s, name: compNames.get(Number(s.entrantId)) ?? 'TBD', competitorId: Number(s.entrantId) }));
  }
  let sixmans: unknown = null;
  if (t.format === 'sixmans') {
    const poolsPlan = currentPlan(ctx, t.id, 'pools');
    const schedulePlan = currentPlan(ctx, t.id, 'schedule');
    const finalsPlan = currentPlan(ctx, t.id, 'finals');
    const planVisible = (p: typeof poolsPlan) => p && (manage || p.status === 'confirmed');
    const strip = (data: unknown) => (manage ? data : JSON.parse(JSON.stringify(data, (k, v) => (k === 'skill' || k === 'skillA' || k === 'skillB' || k === 'averages' ? undefined : v))));
    const ps = t.started_at ? poolStandings(ctx, t) : [];
    sixmans = {
      qualifiersPerPool: qualifiersPerPool(t),
      pools: planVisible(poolsPlan) ? { status: poolsPlan!.status, data: strip(JSON.parse(poolsPlan!.data)) } : null,
      schedule: planVisible(schedulePlan) ? { status: schedulePlan!.status, data: strip(JSON.parse(schedulePlan!.data)) } : null,
      finals: finalsPlan && (manage || finalsPlan.status === 'confirmed') ? { status: finalsPlan.status, data: strip(JSON.parse(finalsPlan.data)) } : null,
      standings: ps.map((p) => ({ ...p, standings: p.standings.map((s) => ({ ...s, name: names.get(s.playerId) ?? 'Player', skill: manage ? s.skill : undefined })) })),
      qualifications: ctx.db.prepare('SELECT user_id AS userId, pool_rank AS poolRank, qualified, reason FROM qualifications WHERE tournament_id = ?').all(t.id),
    };
  }
  const placements = (ctx.db.prepare('SELECT competitor_id AS competitorId, placement FROM placements WHERE tournament_id = ? ORDER BY placement').all(t.id) as { competitorId: number; placement: number }[]).map((p) => ({
    ...p, name: compNames.get(p.competitorId) ?? '', players: (members.get(p.competitorId) ?? []).map((x) => ({ userId: x.userId, name: names.get(x.userId) ?? 'Player' })),
  }));
  const myEntry = viewerId ? entryForUser(ctx, t.id, viewerId) : undefined;
  const myMatches = viewerId ? matches.filter((m) => [m.a, m.b].some((s) => s?.players.some((p) => p.userId === viewerId))).map((m) => m.id) : [];
  const g = getGuild(ctx, t.guild_id);
  const guild = g ? guildDto(g) : null;
  const managerExtras = manage
    ? {
        startCheck: isPreStart(t.state) ? await checkStart(ctx, t) : null,
        unreachable: unreachablePlayers(ctx, t).map((u) => ({ ...u, name: names.get(u.userId) ?? u.userId })),
        voice: voiceStatus(ctx, t.id),
        notifications: notificationLog(ctx, t.id, 50),
        availableActions: availableActions(t.state),
        swissLogs: ctx.db.prepare('SELECT round, log FROM round_meta WHERE tournament_id = ? ORDER BY round').all(t.id).map((r) => ({ round: (r as { round: number }).round, log: JSON.parse((r as { log: string }).log) })),
      }
    : null;
  const muted = viewerId ? !!ctx.db.prepare('SELECT 1 FROM tournament_mutes WHERE user_id = ? AND tournament_id = ?').get(viewerId, t.id) : false;
  return {
    tournament: {
      ...tournamentSummary(ctx, t), description: t.description, config: t.cfg, createdBy: { id: t.created_by, name: names.get(t.created_by) ?? 'Organizer' },
      admins: adminIds(ctx, t.id).map((u) => ({ id: u, name: names.get(u) ?? u })), presetId: t.preset_id, presetVersion: t.preset_version, startedAt: t.started_at,
      cancelledAt: t.cancelled_at, championCompetitorId: t.champion_competitor_id, autoStartError: manage ? t.auto_start_error : null,
      swissRounds: t.format === 'swiss' && t.started_at ? swissTotalRounds(ctx, t) : null,
    },
    guild: guild ? { id: guild.id, name: guild.name, iconUrl: guild.iconUrl, botPresent: guild.botPresent } : null,
    viewer: { userId: viewerId, role: access.role, canManage: manage, isCreator: access.isCreator, entryId: myEntry?.id ?? null, myMatchIds: myMatches, muted, availability: viewerId && myEntry ? avail.get(viewerId)?.status ?? 'not_asked' : null },
    entries: entryDtos,
    competitors: comps.map((c) => ({ id: c.id, name: c.name, seed: c.seed, kind: c.kind, stage: c.stage, players: (members.get(c.id) ?? []).map((x) => ({ userId: x.userId, name: names.get(x.userId) ?? 'Player', role: x.role })) })),
    matches,
    pools: pools.map((p) => ({ id: p.id, index: p.idx, name: p.name })),
    standings,
    sixmans,
    placements,
    manager: managerExtras,
  };
}

export async function matchDetail(ctx: AppContext, matchId: number, viewerId: string | null) {
  const m = ctx.db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as MatchRow | undefined;
  if (!m) throw Object.assign(new Error('Match not found'), { status: 404 });
  const t = loadTournament(ctx, m.tournament_id);
  const access: Access = await assertView(ctx, t, viewerId);
  const comps = competitorsOf(ctx, t.id);
  const members = membersByCompetitor(ctx, t.id);
  const names = userNames(ctx, [...members.values()].flat().map((x) => x.userId));
  const poolNames = new Map((ctx.db.prepare('SELECT id, name FROM pools WHERE tournament_id = ?').all(t.id) as { id: number; name: string }[]).map((p) => [p.id, p.name]));
  const dto = matchDto(ctx, m, new Map(comps.map((c) => [c.id, c.name])), members, names, poolNames);
  const mySide = viewerId ? (dto.a?.players.some((p) => p.userId === viewerId) ? 'a' : dto.b?.players.some((p) => p.userId === viewerId) ? 'b' : null) : null;
  return {
    match: dto,
    tournament: tournamentSummary(ctx, t),
    config: { confirmation: t.cfg.results.confirmation, requireGameScores: t.cfg.series.requireGameScores || t.format === 'sixmans' },
    viewer: { userId: viewerId, canManage: access.canManage, side: mySide },
    reports: reportsFor(ctx, m.id),
    voice: access.canManage || mySide ? voiceStatus(ctx, t.id).filter((v) => v.matchId === m.id) : [],
  };
}
