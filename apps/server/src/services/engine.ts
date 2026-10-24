import {
  bestOfFor, bracketChampion, bracketPlacements, buildDoubleElimination, buildRoundRobin, buildSingleElimination, canonicalTrio,
  computeStandings, conflict, defaultSwissRounds, invalid, nextState, pairSwissRound, resolveBracket, seededShuffle,
  validateSchedule, type BracketMatch, type ResultRecord, type SlotSource, type StandingRow,
} from '@rl/core';
import { DomainError } from '@rl/core';
import type { AppContext, Source } from './context.js';
import { nowIso, tx } from './context.js';
import { loadTournament, managerIds, type LoadedTournament } from './access.js';
import { audit } from './audit.js';
import { getGuild } from './guilds.js';
import { cancelPending, enqueue, scheduleMatchReminders } from './notifications.js';
import { competitorsOf, matchesOf, matchGames, type CompetitorRow, type MatchRow } from './queries.js';
import { entriesOf, entryMembers, lockRosters, type EntryRow } from './registration.js';
import { userNames } from './users.js';
import { currentPlan, planFingerprints, proposeFinals } from './sixmans.js';

const FINISHED = new Set(['completed', 'void', 'cancelled']);

// ---------------------------------------------------------------------------------------------
// Start validation
// ---------------------------------------------------------------------------------------------

export interface StartCheck {
  ok: boolean;
  problems: string[];
  warnings: string[];
  entrants: number;
  noShows: number[];
}

function orderedEntries(t: LoadedTournament, entries: EntryRow[]): EntryRow[] {
  const byCreated = entries.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  switch (t.cfg.seeding.method) {
    case 'manual':
      return byCreated.slice().sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9));
    case 'random':
      return seededShuffle(byCreated, `${t.cfg.seeding.seed}:${t.id}`);
    default:
      return byCreated;
  }
}

/** Everything that must hold before a tournament may start (manually or automatically). */
export async function checkStart(ctx: AppContext, t: LoadedTournament): Promise<StartCheck> {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!['published', 'registration_open', 'registration_closed', 'ready'].includes(t.state))
    problems.push(`A ${t.state.replace(/_/g, ' ')} tournament cannot be started.`);
  const confirmed = entriesOf(ctx, t.id, ['confirmed']);
  const noShows = t.cfg.checkIn.enabled ? confirmed.filter((e) => !e.checked_in_at).map((e) => e.id) : [];
  if (noShows.length && !t.cfg.checkIn.removeNoShows) problems.push(`${noShows.length} registration(s) have not checked in. Check them in or remove them.`);
  else if (noShows.length) warnings.push(`${noShows.length} registration(s) did not check in and will be removed as no-shows.`);
  const playing = confirmed.filter((e) => !noShows.includes(e.id));
  const pending = entriesOf(ctx, t.id, ['pending']).length;
  if (pending) warnings.push(`${pending} registration(s) are still awaiting approval and will not play.`);
  const minRoster = t.cfg.registration.minRoster ?? t.cfg.teamSize;
  let entrantCount = playing.length;
  if (t.cfg.registrationMode === 'team' && t.cfg.teamSize > 1) {
    for (const e of playing) {
      const starters = entryMembers(ctx, e.id).filter((m) => m.role !== 'substitute').length;
      if (starters < minRoster) problems.push(`Team "${e.name}" has ${starters} of ${minRoster} required players.`);
    }
  } else if (t.cfg.format !== 'sixmans' && t.cfg.teamSize > 1) {
    const r = playing.length % t.cfg.teamSize;
    if (r) problems.push(`${playing.length} solo players cannot be split into full teams of ${t.cfg.teamSize} (${r} left over). Add or remove players.`);
    entrantCount = Math.floor(playing.length / t.cfg.teamSize);
  }
  const min = Math.max(2, t.cfg.minEntrants);
  if (t.cfg.format === 'sixmans') {
    if (playing.length < 6) problems.push(`6mans needs at least 6 players; ${playing.length} are confirmed.`);
    const pools = currentPlan(ctx, t.id, 'pools');
    const schedule = currentPlan(ctx, t.id, 'schedule');
    const fp = planFingerprints(ctx, t, playing.map((e) => e.user_id!));
    if (!pools || pools.status !== 'confirmed') problems.push('Pools have not been confirmed (use Make Pools, review, then confirm).');
    else if (pools.fingerprint !== fp.pools) problems.push('The player list or skill values changed after the pools were confirmed. Make and confirm the pools again.');
    if (!schedule || schedule.status !== 'confirmed') problems.push('The group-stage schedule has not been generated and confirmed.');
    else if (pools && schedule.fingerprint !== fp.schedule) problems.push('The pools or round settings changed after the schedule was confirmed. Generate and confirm the schedule again.');
    else {
      const data = JSON.parse(schedule.data) as SchedulePlanData;
      for (const p of data.pools) {
        if (p.result.status !== 'ok') problems.push(`Pool ${p.poolIndex + 1}: no valid schedule.`);
        const v = validateSchedule(p.result, p.playerIds, { matchesPerRound: data.matchesPerRound, rounds: data.rounds, maxSpread: p.result.balance.spread });
        if (!v.valid) problems.push(...v.errors.map((e) => `Pool ${p.poolIndex + 1}: ${e}`));
      }
    }
  } else if (entrantCount < min) problems.push(`At least ${min} entrants are needed; ${entrantCount} are ready.`);
  if (t.cfg.format === 'swiss') {
    const rounds = t.cfg.swiss.rounds ?? defaultSwissRounds(entrantCount);
    if (entrantCount >= 2 && rounds > entrantCount - 1) warnings.push(`${rounds} Swiss rounds with ${entrantCount} entrants forces rematches (max ${entrantCount - 1} without).`);
  }
  // Discord configuration
  const guild = getGuild(ctx, t.guild_id);
  if (ctx.discord.enabled && guild?.bot_present) {
    if (t.cfg.voice.enabled) {
      try {
        const perms = await ctx.discord.botPermissions(t.guild_id);
        if (perms.missing.length) warnings.push(`The bot is missing Discord permissions for voice channels: ${perms.missing.join(', ')}.`);
      } catch {
        warnings.push('Could not verify the bot’s Discord permissions.');
      }
    }
  } else if (t.cfg.voice.enabled || t.cfg.notifications.channelAnnouncements || t.cfg.notifications.dms) {
    warnings.push('The Discord bot is not connected to this server, so voice channels and Discord notifications will not work.');
  }
  if (t.cfg.notifications.channelAnnouncements && !(t.cfg.notifications.announcementChannelId ?? guild?.announcement_channel_id))
    warnings.push('Channel announcements are on but no announcement channel is set (server settings or tournament).');
  return { ok: problems.length === 0, problems, warnings, entrants: entrantCount, noShows };
}

// ---------------------------------------------------------------------------------------------
// Start + materialisation
// ---------------------------------------------------------------------------------------------

export interface SchedulePlanData {
  rounds: number;
  matchesPerRound: number;
  skillBalanced: boolean;
  seed: number;
  pools: { poolId: number; poolIndex: number; playerIds: string[]; result: import('@rl/core').ScheduleResult }[];
}

function insertCompetitor(ctx: AppContext, t: LoadedTournament, c: { entryId: number | null; kind: CompetitorRow['kind']; stage: CompetitorRow['stage']; name: string; seed: number | null; members: { userId: string; role: string }[] }): number {
  const r = ctx.db
    .prepare('INSERT INTO competitors (tournament_id, entry_id, kind, stage, name, seed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(t.id, c.entryId, c.kind, c.stage, c.name.slice(0, 80), c.seed, nowIso(ctx));
  const id = Number(r.lastInsertRowid);
  const ins = ctx.db.prepare('INSERT INTO competitor_members (competitor_id, user_id, role) VALUES (?, ?, ?)');
  for (const m of c.members) ins.run(id, m.userId, m.role);
  return id;
}

export function insertMatch(
  ctx: AppContext,
  t: LoadedTournament,
  m: { stage: MatchRow['stage']; bracket: string; round: number; position: number; key: string; poolId?: number | null; sourceA?: SlotSource | null; sourceB?: SlotSource | null; a?: number | null; b?: number | null; status: MatchRow['status'] },
): number {
  const now = nowIso(ctx);
  const r = ctx.db
    .prepare(
      `INSERT INTO matches (tournament_id, stage, bracket, round, position, key, pool_id, best_of, source_a, source_b, competitor_a, competitor_b, status, ready_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.id, m.stage, m.bracket, m.round, m.position, m.key, m.poolId ?? null, bestOfFor(t.cfg, m.bracket, m.round),
      m.sourceA ? JSON.stringify(m.sourceA) : null, m.sourceB ? JSON.stringify(m.sourceB) : null, m.a ?? null, m.b ?? null, m.status,
      m.status === 'ready' ? now : null, now, now,
    );
  return Number(r.lastInsertRowid);
}

/** Convert a core bracket (entrant ids = competitor ids as strings) into match rows. */
function insertBracket(ctx: AppContext, t: LoadedTournament, stage: MatchRow['stage'], bracket: BracketMatch[]) {
  for (const bm of bracket) {
    insertMatch(ctx, t, {
      stage, bracket: bm.bracket, round: bm.round, position: bm.position, key: bm.key, sourceA: bm.sourceA, sourceB: bm.sourceB,
      a: null, b: null, status: 'pending',
    });
  }
}

function buildCompetitors(ctx: AppContext, t: LoadedTournament, entries: EntryRow[]): number[] {
  const names = userNames(ctx, entries.flatMap((e) => entryMembers(ctx, e.id).map((m) => m.user_id)));
  const ordered = orderedEntries(t, entries);
  if (t.cfg.registrationMode === 'team' && t.cfg.teamSize > 1) {
    return ordered.map((e, i) =>
      insertCompetitor(ctx, t, { entryId: e.id, kind: 'team', stage: 'main', name: e.name!, seed: i + 1, members: entryMembers(ctx, e.id).map((m) => ({ userId: m.user_id, role: m.role })) }),
    );
  }
  if (t.cfg.teamSize === 1) {
    return ordered.map((e, i) =>
      insertCompetitor(ctx, t, { entryId: e.id, kind: 'player', stage: 'main', name: names.get(e.user_id!) ?? 'Player', seed: i + 1, members: [{ userId: e.user_id!, role: 'player' }] }),
    );
  }
  // Solo sign-ups for 2v2/3v3: snake-draft players (in seed order) into balanced teams.
  const size = t.cfg.teamSize;
  const teamCount = Math.floor(ordered.length / size);
  const teams: EntryRow[][] = Array.from({ length: teamCount }, () => []);
  ordered.slice(0, teamCount * size).forEach((e, i) => {
    const round = Math.floor(i / teamCount);
    const pos = i % teamCount;
    teams[round % 2 === 0 ? pos : teamCount - 1 - pos].push(e);
  });
  return teams.map((members, i) =>
    insertCompetitor(ctx, t, {
      entryId: null, kind: 'team', stage: 'main', name: `Team ${names.get(members[0].user_id!) ?? i + 1}`, seed: i + 1,
      members: members.map((e, j) => ({ userId: e.user_id!, role: j === 0 ? 'captain' : 'player' })),
    }),
  );
}

export async function startTournament(ctx: AppContext, actorId: string | null, id: number, opts: { source: Source }) {
  const t = loadTournament(ctx, id);
  const check = await checkStart(ctx, t);
  if (!check.ok) throw new DomainError('cannot_start', `The tournament cannot start yet: ${check.problems.join(' ')}`, 409, { problems: check.problems, warnings: check.warnings });
  tx(ctx, () => {
    const fresh = loadTournament(ctx, id);
    if (fresh.version !== t.version) throw conflict('stale_version', 'The tournament changed while starting. Try again.');
    const now = nowIso(ctx);
    for (const eid of check.noShows) {
      ctx.db.prepare("UPDATE entries SET status = 'removed', updated_at = ? WHERE id = ?").run(now, eid);
      ctx.db.prepare('UPDATE entry_members SET active = 0, left_at = ? WHERE entry_id = ? AND active = 1').run(now, eid);
      audit(ctx, { guildId: t.guild_id, tournamentId: id, actorId, action: 'registration.no_show_removed', target: `entry:${eid}` });
    }
    lockRosters(ctx, t, actorId);
    const entries = entriesOf(ctx, id, ['confirmed']);
    let stage: 'main' | 'group' = 'main';
    if (t.cfg.format === 'sixmans') {
      stage = 'group';
      materializeGroupStage(ctx, t);
    } else {
      const comps = buildCompetitors(ctx, t, entries).map(String);
      if (t.cfg.format === 'single_elim') insertBracket(ctx, t, 'main', buildSingleElimination(comps, { thirdPlace: t.cfg.singleElim.thirdPlaceMatch }));
      else if (t.cfg.format === 'double_elim') insertBracket(ctx, t, 'main', buildDoubleElimination(comps, { grandFinalReset: t.cfg.doubleElim.grandFinalReset }));
      else if (t.cfg.format === 'round_robin') {
        const rr = buildRoundRobin(comps, t.cfg.roundRobin.encounters);
        for (const p of rr.pairings)
          insertMatch(ctx, t, {
            stage: 'main', bracket: 'rr', round: p.round, position: p.position, key: `rr${p.round}-${p.position + 1}`,
            a: Number(p.a), b: Number(p.b), status: !t.cfg.roundRobin.sequentialRounds || p.round === 1 ? 'ready' : 'pending',
          });
        for (const b of rr.byes) ctx.db.prepare('INSERT INTO match_byes (tournament_id, stage, round, competitor_id) VALUES (?, ?, ?, ?)').run(id, 'main', b.round, Number(b.entrantId));
      } else if (t.cfg.format === 'swiss') {
        generateSwissRound(ctx, t, 1);
      }
    }
    const to = nextState(t.state, 'start');
    ctx.db.prepare('UPDATE tournaments SET state = ?, stage = ?, started_at = ?, auto_start_error = NULL, version = version + 1, updated_at = ? WHERE id = ?').run(to, stage, now, now, id);
    const started = loadTournament(ctx, id);
    if (t.cfg.format === 'single_elim' || t.cfg.format === 'double_elim') syncBracket(ctx, started, 'main');
    notifyNewlyReady(ctx, started, matchesOf(ctx, id).filter((m) => m.status === 'ready'));
    cancelPending(ctx, { tournamentId: id, keyPrefix: `t${id}:start:` });
    cancelPending(ctx, { tournamentId: id, keyPrefix: `t${id}:checkin:` });
    enqueue(ctx, { tournamentId: id, category: 'tournament_start', key: `t${id}:started`, audience: 'participants' });
    audit(ctx, { guildId: t.guild_id, tournamentId: id, actorId, action: 'tournament.start', details: { source: opts.source, auto: actorId == null, warnings: check.warnings } });
  });
  ctx.kick(id);
  return { tournament: loadTournament(ctx, id), warnings: check.warnings };
}

function materializeGroupStage(ctx: AppContext, t: LoadedTournament) {
  const plan = currentPlan(ctx, t.id, 'schedule');
  if (!plan) throw conflict('no_schedule', 'No confirmed schedule.');
  const data = JSON.parse(plan.data) as SchedulePlanData;
  const names = userNames(ctx, data.pools.flatMap((p) => p.playerIds));
  for (const pool of data.pools) {
    for (const round of pool.result.rounds) {
      for (const m of round.matches) {
        const label = (team: string[]) => team.map((u) => names.get(u) ?? 'Player').join(' / ');
        const ca = insertCompetitor(ctx, t, { entryId: null, kind: 'temp_team', stage: 'group', name: label(m.teamA), seed: null, members: m.teamA.map((u) => ({ userId: u, role: 'player' })) });
        const cb = insertCompetitor(ctx, t, { entryId: null, kind: 'temp_team', stage: 'group', name: label(m.teamB), seed: null, members: m.teamB.map((u) => ({ userId: u, role: 'player' })) });
        const mid = insertMatch(ctx, t, {
          stage: 'group', bracket: 'pool', round: round.round, position: m.index, key: `p${pool.poolIndex + 1}r${round.round}m${m.index + 1}`,
          poolId: pool.poolId, a: ca, b: cb, status: round.round === 1 ? 'ready' : 'pending',
        });
        // The primary key makes a repeated trio impossible to store, whatever the scheduler did.
        const ins = ctx.db.prepare('INSERT INTO sixmans_trios (pool_id, trio_key, match_id) VALUES (?, ?, ?)');
        ins.run(pool.poolId, canonicalTrio(m.teamA), mid);
        ins.run(pool.poolId, canonicalTrio(m.teamB), mid);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------------------------

function toCore(m: MatchRow): BracketMatch {
  const status: BracketMatch['status'] =
    m.status === 'completed' ? 'completed' : m.status === 'void' || m.status === 'cancelled' ? 'void' : m.status === 'pending' ? 'pending' : 'ready';
  return {
    key: m.key, bracket: m.bracket, round: m.round, position: m.position,
    sourceA: JSON.parse(m.source_a!), sourceB: JSON.parse(m.source_b!),
    entrantA: m.competitor_a ? String(m.competitor_a) : null, entrantB: m.competitor_b ? String(m.competitor_b) : null,
    status, winner: m.winner, walkover: !!m.walkover,
  };
}

/** Re-resolve a bracket stage and persist slot fills, byes and voids. Returns newly ready matches. */
export function syncBracket(ctx: AppContext, t: LoadedTournament, stage: MatchRow['stage']): MatchRow[] {
  const rows = matchesOf(ctx, t.id, stage).filter((m) => m.source_a && m.source_b);
  const core = rows.map(toCore);
  const changed = new Set(resolveBracket(core));
  const now = nowIso(ctx);
  const newlyReady: MatchRow[] = [];
  for (const bm of core) {
    if (!changed.has(bm.key)) continue;
    const row = rows.find((r) => r.key === bm.key)!;
    const status: MatchRow['status'] =
      bm.status === 'ready' ? (['awaiting_confirmation', 'disputed'].includes(row.status) ? row.status : 'ready') : bm.status === 'completed' ? 'completed' : bm.status;
    ctx.db
      .prepare(
        `UPDATE matches SET competitor_a = ?, competitor_b = ?, status = ?, winner = ?, walkover = ?, wins_a = NULL, wins_b = NULL,
          ready_at = CASE WHEN ? = 'ready' THEN ? ELSE ready_at END, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
          result_version = result_version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(bm.entrantA ? Number(bm.entrantA) : null, bm.entrantB ? Number(bm.entrantB) : null, status, bm.winner, bm.walkover ? 1 : 0, status, now, status, now, now, row.id);
    if (status === 'ready' && row.status !== 'ready') newlyReady.push({ ...row, status, ready_at: now, result_version: row.result_version + 1 });
  }
  return newlyReady;
}

export function notifyNewlyReady(ctx: AppContext, t: LoadedTournament, matches: MatchRow[]) {
  for (const m of matches) {
    const fresh = ctx.db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id) as MatchRow;
    if (fresh.status !== 'ready') continue;
    enqueue(ctx, { tournamentId: t.id, matchId: m.id, category: 'match_assigned', key: `m${m.id}:assigned:v${fresh.result_version}`, audience: 'match' });
    scheduleMatchReminders(ctx, t, m.id, fresh.ready_at ?? nowIso(ctx), fresh.result_version);
  }
}

export function standardResults(ctx: AppContext, tournamentId: number, stage: string): ResultRecord[] {
  return matchesOf(ctx, tournamentId, stage)
    .filter((m) => m.status === 'completed' && !m.walkover && m.competitor_a && m.competitor_b && m.winner)
    .map((m) => ({
      a: String(m.competitor_a), b: String(m.competitor_b), winner: m.winner!, winsA: m.wins_a ?? 0, winsB: m.wins_b ?? 0,
      goalsA: m.goals_a ?? 0, goalsB: m.goals_b ?? 0, forfeit: !!m.forfeit,
    }));
}

export function standardStandings(ctx: AppContext, t: LoadedTournament): StandingRow[] {
  const comps = competitorsOf(ctx, t.id, 'main');
  const byes = new Map<string, number>();
  for (const b of ctx.db.prepare("SELECT competitor_id, COUNT(*) c FROM match_byes WHERE tournament_id = ? AND stage = 'main' GROUP BY competitor_id").all(t.id) as { competitor_id: number; c: number }[]) {
    // Round-robin byes are scheduling gaps, not wins.
    if (t.cfg.format === 'swiss') byes.set(String(b.competitor_id), b.c);
  }
  const opts =
    t.cfg.format === 'swiss'
      ? { pointsWin: t.cfg.swiss.pointsWin, pointsLoss: t.cfg.swiss.pointsLoss, pointsBye: t.cfg.swiss.pointsBye, tiebreakers: t.cfg.swiss.tiebreakers }
      : { pointsWin: t.cfg.roundRobin.pointsWin, pointsLoss: t.cfg.roundRobin.pointsLoss, pointsBye: 0, tiebreakers: t.cfg.roundRobin.tiebreakers };
  return computeStandings(comps.map((c) => ({ id: String(c.id), seed: c.seed ?? 9999 })), standardResults(ctx, t.id, 'main'), byes, opts);
}

export function swissTotalRounds(ctx: AppContext, t: LoadedTournament): number {
  const n = competitorsOf(ctx, t.id, 'main').length;
  return t.cfg.swiss.rounds ?? defaultSwissRounds(n);
}

function generateSwissRound(ctx: AppContext, t: LoadedTournament, round: number) {
  const comps = competitorsOf(ctx, t.id, 'main');
  const standings = round === 1 ? null : standardStandings(ctx, t);
  const byeSet = new Set((ctx.db.prepare("SELECT competitor_id FROM match_byes WHERE tournament_id = ? AND stage = 'main'").all(t.id) as { competitor_id: number }[]).map((r) => String(r.competitor_id)));
  const entrants = comps.map((c) => {
    const s = standings?.find((x) => x.entrantId === String(c.id));
    return { id: String(c.id), points: s?.points ?? 0, rank: s?.rank ?? c.seed ?? 9999, opponents: s?.opponents ?? [], hadBye: byeSet.has(String(c.id)) };
  });
  const res = pairSwissRound(entrants, t.cfg.seeding.seed + round);
  res.pairs.forEach((p, i) => insertMatch(ctx, t, { stage: 'main', bracket: 'swiss', round, position: i, key: `s${round}-${i + 1}`, a: Number(p.a), b: Number(p.b), status: 'ready' }));
  if (res.bye) ctx.db.prepare('INSERT INTO match_byes (tournament_id, stage, round, competitor_id) VALUES (?, ?, ?, ?)').run(t.id, 'main', round, Number(res.bye));
  ctx.db.prepare('INSERT INTO round_meta (tournament_id, stage, round, log, created_at) VALUES (?, ?, ?, ?, ?)').run(t.id, 'main', round, JSON.stringify(res.log), nowIso(ctx));
  if (res.log.length) ctx.log.info({ tournamentId: t.id, round, log: res.log }, 'swiss pairing fallback');
}

/** Advance whatever can advance after a result/correction in `stage`. Must run inside a transaction. */
export function advance(ctx: AppContext, tournamentId: number, stage: MatchRow['stage']) {
  const t = loadTournament(ctx, tournamentId);
  if (t.state !== 'in_progress' && t.state !== 'paused') return;
  const fmt = t.cfg.format;
  if (stage === 'main' && (fmt === 'single_elim' || fmt === 'double_elim')) {
    const ready = syncBracket(ctx, t, 'main');
    notifyNewlyReady(ctx, t, ready);
    const core = matchesOf(ctx, t.id, 'main').map(toCore);
    const champ = bracketChampion(core, fmt);
    if (champ) completeTournament(ctx, t, bracketPlacements(core, fmt), Number(champ));
    return;
  }
  if (stage === 'main' && fmt === 'swiss') {
    const ms = matchesOf(ctx, t.id, 'main');
    const current = Math.max(...ms.map((m) => m.round));
    if (!ms.filter((m) => m.round === current).every((m) => FINISHED.has(m.status))) return;
    const total = swissTotalRounds(ctx, t);
    if (current < total) {
      generateSwissRound(ctx, t, current + 1);
      notifyNewlyReady(ctx, t, matchesOf(ctx, t.id, 'main').filter((m) => m.round === current + 1 && m.status === 'ready'));
      enqueue(ctx, { tournamentId: t.id, category: 'standings', key: `t${t.id}:swiss:r${current}`, audience: 'participants', payload: { text: `Swiss round ${current} is complete; round ${current + 1} pairings are out.` } });
    } else {
      const st = standardStandings(ctx, t);
      completeTournament(ctx, t, new Map(st.map((s) => [s.entrantId, s.rank])), Number(st[0].entrantId));
    }
    return;
  }
  if (stage === 'main' && fmt === 'round_robin') {
    const ms = matchesOf(ctx, t.id, 'main');
    if (ms.every((m) => FINISHED.has(m.status))) {
      const st = standardStandings(ctx, t);
      completeTournament(ctx, t, new Map(st.map((s) => [s.entrantId, s.rank])), Number(st[0].entrantId));
      return;
    }
    if (t.cfg.roundRobin.sequentialRounds) {
      const open = ms.filter((m) => !FINISHED.has(m.status));
      const minRound = Math.min(...open.map((m) => m.round));
      const toOpen = open.filter((m) => m.round === minRound && m.status === 'pending');
      if (toOpen.length && ms.filter((m) => m.round < minRound).every((m) => FINISHED.has(m.status))) {
        const now = nowIso(ctx);
        for (const m of toOpen) ctx.db.prepare("UPDATE matches SET status = 'ready', ready_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(now, now, m.id);
        notifyNewlyReady(ctx, t, toOpen);
        enqueue(ctx, { tournamentId: t.id, category: 'standings', key: `t${t.id}:rr:r${minRound - 1}`, audience: 'participants', payload: { text: `Round ${minRound - 1} is complete; round ${minRound} is open.` } });
      }
    }
    return;
  }
  if (stage === 'group') {
    const ms = matchesOf(ctx, t.id, 'group');
    const byPool = new Map<number, MatchRow[]>();
    for (const m of ms) {
      if (!byPool.has(m.pool_id!)) byPool.set(m.pool_id!, []);
      byPool.get(m.pool_id!)!.push(m);
    }
    const now = nowIso(ctx);
    for (const [, pm] of byPool) {
      const open = pm.filter((m) => !FINISHED.has(m.status));
      if (!open.length) continue;
      const minRound = Math.min(...open.map((m) => m.round));
      const toOpen = open.filter((m) => m.round === minRound && m.status === 'pending');
      for (const m of toOpen) ctx.db.prepare("UPDATE matches SET status = 'ready', ready_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(now, now, m.id);
      notifyNewlyReady(ctx, t, toOpen);
    }
    if (ms.every((m) => FINISHED.has(m.status)) && t.stage === 'group') {
      ctx.db.prepare("UPDATE tournaments SET stage = 'group_complete', version = version + 1, updated_at = ? WHERE id = ?").run(now, t.id);
      audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId: null, action: 'sixmans.group_complete' });
      proposeFinals(ctx, loadTournament(ctx, t.id), null);
      enqueue(ctx, { tournamentId: t.id, category: 'standings', key: `t${t.id}:group_complete`, audience: 'participants', payload: { text: 'The group stage is complete! Final standings are up and the finals are being prepared.' } });
      enqueue(ctx, { tournamentId: t.id, category: 'organizer_alert', key: `t${t.id}:group_complete:admins`, audience: 'admins', payload: { text: 'The group stage is complete. Review the qualifiers and finals teams, then start the finals.' } });
    }
    return;
  }
  if (stage === 'finals') {
    const ready = syncBracket(ctx, t, 'finals');
    notifyNewlyReady(ctx, t, ready);
    const core = matchesOf(ctx, t.id, 'finals').map(toCore);
    const champ = bracketChampion(core, 'single_elim');
    if (champ) completeTournament(ctx, t, bracketPlacements(core, 'single_elim'), Number(champ));
  }
}

function completeTournament(ctx: AppContext, t: LoadedTournament, placements: Map<string, number>, championId: number) {
  const now = nowIso(ctx);
  const res = ctx.db.prepare("UPDATE tournaments SET state = 'completed', completed_at = ?, champion_competitor_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND state = 'in_progress'").run(now, championId, now, t.id);
  if (!res.changes) return;
  const ins = ctx.db.prepare('INSERT OR REPLACE INTO placements (tournament_id, competitor_id, placement) VALUES (?, ?, ?)');
  for (const [cid, place] of placements) ins.run(t.id, Number(cid), place);
  cancelPending(ctx, { tournamentId: t.id });
  enqueue(ctx, { tournamentId: t.id, category: 'tournament_complete', key: `t${t.id}:completed`, audience: 'participants' });
  audit(ctx, { guildId: t.guild_id, tournamentId: t.id, actorId: null, action: 'tournament.completed', details: { championCompetitorId: championId } });
}

/** Cancel every unfinished match (tournament cancellation). */
export function cancelOpenMatches(ctx: AppContext, tournamentId: number) {
  ctx.db
    .prepare("UPDATE matches SET status = 'cancelled', updated_at = ? WHERE tournament_id = ? AND status IN ('pending','ready','awaiting_confirmation','disputed')")
    .run(nowIso(ctx), tournamentId);
}

/** Organizers to alert about operational problems. */
export function alertOrganizers(ctx: AppContext, t: LoadedTournament, key: string, text: string) {
  enqueue(ctx, { tournamentId: t.id, category: 'organizer_alert', key, audience: 'admins', payload: { text } });
  void managerIds;
}

/** Bracket stage of a match for advancement purposes. */
export const isBracketMatch = (m: MatchRow) => !!(m.source_a && m.source_b);
export { matchGames, FINISHED };
