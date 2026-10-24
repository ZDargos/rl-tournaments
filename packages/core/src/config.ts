import { z } from 'zod';
import { RANK_IDS } from './ranks.js';

/**
 * Tournament configuration. This object is what presets store and what every tournament
 * snapshots at creation time. All competition rules live here so the website, the Discord bot
 * and background jobs read exactly the same settings.
 */

export const FORMATS = ['single_elim', 'double_elim', 'swiss', 'round_robin', 'sixmans'] as const;
export type Format = (typeof FORMATS)[number];
export const FORMAT_LABELS: Record<Format, string> = {
  single_elim: 'Single elimination',
  double_elim: 'Double elimination',
  swiss: 'Swiss',
  round_robin: 'Round robin',
  sixmans: '6mans',
};

export const BEST_OF = [1, 3, 5, 7] as const;
export type BestOf = (typeof BEST_OF)[number];
const bestOf = z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)]);

export const NOTIFICATION_CATEGORIES = [
  'registration_open',
  'registration_close',
  'tournament_start',
  'check_in',
  'match_assigned',
  'match_start',
  'match_result',
  'bracket_change',
  'standings',
  'tournament_complete',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  registration_open: 'Registration opening',
  registration_close: 'Registration closing',
  tournament_start: 'Tournament start',
  check_in: 'Check-in deadlines',
  match_assigned: 'Match assignments',
  match_start: 'Match start times & deadlines',
  match_result: 'Match results',
  bracket_change: 'Bracket changes',
  standings: 'Standings updates',
  tournament_complete: 'Completion & placements',
};

const delivery = z.object({ channel: z.boolean(), dm: z.boolean() });

const STANDARD_TIEBREAKERS = ['points', 'head_to_head', 'buchholz', 'game_diff', 'goal_diff', 'goals_for', 'wins', 'seed'] as const;
export type StandardTiebreaker = (typeof STANDARD_TIEBREAKERS)[number];
const SIXMANS_TIEBREAKERS = ['points', 'goal_diff', 'goals_for', 'wins', 'fewest_games', 'seed'] as const;
export type SixmansTiebreaker = (typeof SIXMANS_TIEBREAKERS)[number];

const minutesList = z.array(z.number().int().min(0).max(60 * 24 * 60)).max(10);
/** Hours, to the minute (0.25 = 15 minutes). */
const hoursList = z.array(z.number().min(0).max(24 * 60)).max(10);

export const configSchema = z.object({
  format: z.enum(FORMATS).default('single_elim'),
  teamSize: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3),
  /** individual: players sign up alone (teams auto-formed for team sizes > 1); team: captains register teams. */
  registrationMode: z.enum(['individual', 'team']).default('team'),
  registration: z
    .object({
      /** null = unlimited (counted in entrants: players for individual, teams for team mode). */
      capacity: z.number().int().min(2).max(1024).nullable().default(null),
      requireApproval: z.boolean().default(false),
      waitlist: z.boolean().default(true),
      opensAt: z.string().datetime().nullable().default(null),
      closesAt: z.string().datetime().nullable().default(null),
      lateRegistration: z.boolean().default(false),
      allowWithdrawal: z.boolean().default(true),
      /** Max substitutes per team (team mode). */
      maxSubstitutes: z.number().int().min(0).max(3).default(1),
      /** Minimum rostered starters required to be confirmed; null = teamSize. */
      minRoster: z.number().int().min(1).max(3).nullable().default(null),
      rosterLock: z.enum(['on_start', 'on_registration_close', 'manual']).default('on_start'),
      inviteExpiryHours: z.number().int().min(1).max(24 * 30).default(72),
      /** Discord role IDs a member must hold (any of) to register. Empty = everyone in the server. */
      requiredRoleIds: z.array(z.string().regex(/^\d{5,25}$/)).max(10).default([]),
    })
    .prefault({}),
  checkIn: z
    .object({
      enabled: z.boolean().default(false),
      opensMinutesBefore: z.number().int().min(5).max(60 * 24 * 7).default(60),
      closesMinutesBefore: z.number().int().min(0).max(60 * 24).default(10),
      /** At start, unchecked entrants are removed (true) or start blocks until resolved (false). */
      removeNoShows: z.boolean().default(true),
    })
    .prefault({}),
  schedule: z
    .object({
      startAt: z.string().datetime().nullable().default(null),
      timezone: z.string().min(1).max(64).default('UTC'),
      autoStart: z.boolean().default(false),
      /** Minutes after a match becomes ready before it is considered overdue (reminders, no-shows). */
      matchDeadlineMinutes: z.number().int().min(5).max(60 * 24).default(30),
    })
    .prefault({}),
  minEntrants: z.number().int().min(2).max(512).default(2),
  series: z
    .object({
      bestOf: bestOf.default(3),
      /** Per-round overrides, keyed "<bracket>:<round>" e.g. "winners:3", "grand_final:1", "finals:2". */
      perRound: z.record(z.string(), bestOf).prefault({}),
      /** Require per-game goal scores (needed for goal-based tie-breakers). */
      requireGameScores: z.boolean().default(true),
    })
    .prefault({}),
  seeding: z
    .object({
      method: z.enum(['manual', 'random', 'registration_order']).default('registration_order'),
      seed: z.number().int().min(0).max(2 ** 31).default(1),
    })
    .prefault({}),
  results: z
    .object({
      /**
       * opponent_confirm: one side reports, a distinct user on the opposing side confirms (default).
       * single_report: one participant report completes the match.
       * admin_only: only tournament admins enter results.
       */
      confirmation: z.enum(['opponent_confirm', 'single_report', 'admin_only']).default('opponent_confirm'),
      /** Minutes after a report without confirmation/dispute before it auto-confirms. null = never. */
      autoConfirmMinutes: z.number().int().min(5).max(60 * 24 * 3).nullable().default(null),
    })
    .prefault({}),
  singleElim: z.object({ thirdPlaceMatch: z.boolean().default(false) }).prefault({}),
  doubleElim: z.object({ grandFinalReset: z.boolean().default(false) }).prefault({}),
  swiss: z
    .object({
      /** null = ceil(log2(entrants)). */
      rounds: z.number().int().min(1).max(20).nullable().default(null),
      pointsWin: z.number().min(0).max(100).default(3),
      pointsLoss: z.number().min(0).max(100).default(0),
      pointsBye: z.number().min(0).max(100).default(3),
      tiebreakers: z.array(z.enum(STANDARD_TIEBREAKERS)).min(1).default(['points', 'buchholz', 'game_diff', 'goal_diff', 'seed']),
    })
    .prefault({}),
  roundRobin: z
    .object({
      /** How many times each pair meets. */
      encounters: z.number().int().min(1).max(4).default(1),
      pointsWin: z.number().min(0).max(100).default(3),
      pointsLoss: z.number().min(0).max(100).default(0),
      /** Rounds are activated one at a time (round N+1 opens when round N is done). */
      sequentialRounds: z.boolean().default(true),
      tiebreakers: z.array(z.enum(STANDARD_TIEBREAKERS)).min(1).default(['points', 'head_to_head', 'game_diff', 'goal_diff', 'seed']),
    })
    .prefault({}),
  sixmans: z
    .object({
      poolCount: z.number().int().min(1).max(32).default(2),
      skillMethod: z.enum(['manual_seed', 'rank']).default('rank'),
      /** Optional override of rank -> numeric value. */
      rankValues: z.partialRecord(z.enum(RANK_IDS as [string, ...string[]]), z.number()).prefault({}),
      /** How to treat players without a seed/rank. */
      missingSkill: z.enum(['lowest', 'median']).default('lowest'),
      /**
       * "Make pools" may swap players whose skill differs by at most this much (rank scale: 4 per
       * rank, 1 per division), keeping pools balanced. 0 = only identical skill values are swapped.
       */
      poolShuffleTolerance: z.number().min(0).max(20).default(2),
      /**
       * equal_games: each pool plays as many rounds as needed for everyone (in every pool) to play the
       * same number of games; a bigger pool plays more rounds. fixed: every pool plays roundsPerPool.
       */
      roundsMode: z.enum(['equal_games', 'fixed']).default('equal_games'),
      /** equal_games: games per player wanted; null = as few as possible. Rounded up to a valid amount. */
      gamesPerPlayer: z.number().int().min(1).max(60).nullable().default(null),
      /** fixed mode: rounds every pool plays. */
      roundsPerPool: z.number().int().min(1).max(60).default(4),
      matchesPerRound: z.number().int().min(1).max(5).default(1),
      skillBalancedTeams: z.boolean().default(true),
      groupBestOf: bestOf.default(1),
      finalsBestOf: bestOf.default(1),
      scoring: z
        .object({
          win: z.number().min(0).max(100).default(3),
          loss: z.number().min(0).max(100).default(0),
          forfeitWin: z.number().min(0).max(100).default(3),
          forfeitLoss: z.number().min(0).max(100).default(0),
          /** Goal differential credited to forfeit winners (and debited from losers). */
          forfeitGoalDiff: z.number().int().min(0).max(20).default(0),
        })
        .prefault({}),
      /** Abandoned group matches: void (ignored) or counted as a loss for all six players. */
      abandoned: z.enum(['void', 'loss_for_both']).default('void'),
      tiebreakers: z.array(z.enum(SIXMANS_TIEBREAKERS)).min(1).default(['points', 'goal_diff', 'goals_for', 'seed']),
      /** null = default policy (1 pool: 6, 2 pools: 3 each, 3+ pools: 2 each). */
      qualifiersPerPool: z.number().int().min(1).max(64).nullable().default(null),
      /** When qualifiers are not a multiple of 3. */
      qualifierAdjustment: z.enum(['expand', 'reduce']).default('expand'),
      finalsTeamFormation: z.enum(['balanced', 'standings_snake']).default('balanced'),
      /** Search budget for the scheduler. */
      schedulerTimeLimitMs: z.number().int().min(100).max(30000).default(4000),
    })
    .prefault({}),
  notifications: z
    .object({
      /** Discord channel id; null = server default announcement channel. */
      announcementChannelId: z.string().regex(/^\d{5,25}$/).nullable().default(null),
      channelAnnouncements: z.boolean().default(true),
      dms: z.boolean().default(true),
      categories: z
        .partialRecord(z.enum(NOTIFICATION_CATEGORIES), delivery)
        .default({
          registration_open: { channel: true, dm: false },
          registration_close: { channel: true, dm: false },
          tournament_start: { channel: true, dm: true },
          check_in: { channel: true, dm: true },
          match_assigned: { channel: false, dm: true },
          match_start: { channel: false, dm: true },
          match_result: { channel: true, dm: false },
          bracket_change: { channel: false, dm: true },
          standings: { channel: true, dm: false },
          tournament_complete: { channel: true, dm: true },
        }),
      /**
       * Hours before tournament start to remind participants (by DM, with "can you make it?" buttons).
       * Replaces the old `startReminders` (minutes), which parseConfig still accepts and converts.
       */
      startReminderHours: hoursList.default([48, 24, 1]),
      /** Minutes before check-in closes. */
      checkInReminders: minutesList.default([30, 5]),
      /** Minutes after a match becomes ready if still unreported. */
      matchReminders: minutesList.default([15]),
    })
    .prefault({}),
  voice: z
    .object({
      enabled: z.boolean().default(true),
      /** Category channel id; null = server default category (or none). */
      categoryId: z.string().regex(/^\d{5,25}$/).nullable().default(null),
      moveConnectedPlayers: z.boolean().default(true),
      /** Let all tournament participants see (not join) team channels. */
      visibleToParticipants: z.boolean().default(false),
      deleteOnComplete: z.boolean().default(true),
      /**
       * Voice channel players are moved into when their match ends (between-games lobby). After
       * `lobbySeconds` the bot opens their next match's channels and moves them in. null = off.
       */
      lobbyChannelId: z.string().regex(/^\d{5,25}$/).nullable().default(null),
      lobbySeconds: z.number().int().min(1).max(3600).default(30),
    })
    .prefault({}),
  /** Score reporting from Discord: a vote card per live match, posted in a channel. */
  scoreReports: z
    .object({
      /** Text channel for vote cards; null = off. */
      channelId: z.string().regex(/^\d{5,25}$/).nullable().default(null),
      /** Matching votes needed before the result counts. */
      votesNeeded: z.number().int().min(1).max(6).default(2),
      /** The votes must include at least one player from each team (so one team cannot report its own win alone). */
      requireBothTeams: z.boolean().default(true),
      /** Ping the match's players when their card is posted. Off: their names still show, without a notification. */
      mentionPlayers: z.boolean().default(true),
    })
    .prefault({}),
});

export type TournamentConfig = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

/** Parse/complete a config, applying defaults for missing fields. Throws ZodError on invalid input. */
export function parseConfig(input: unknown): TournamentConfig {
  const cfg = configSchema.parse(upgradeLegacy(input ?? {}));
  // Merge category defaults so a partial `categories` object still covers every category.
  const defaults = configSchema.parse({}).notifications.categories;
  cfg.notifications.categories = { ...defaults, ...cfg.notifications.categories };
  return normalizeConfig(cfg);
}

/** Minutes for an hours setting, rounded to the minute. */
export const hoursToMinutes = (h: number) => Math.round(h * 60);

/** Older configs (and `/tourney set notifications.startReminders`) give start reminders in minutes. */
function upgradeLegacy(input: unknown): unknown {
  const n = (input as { notifications?: Record<string, unknown> })?.notifications;
  if (!n || typeof n !== 'object' || n.startReminders === undefined) return input;
  const { startReminders, ...rest } = n;
  const hours = (Array.isArray(startReminders) ? startReminders : [startReminders]).map((m) => (typeof m === 'number' ? Math.round((m / 60) * 10000) / 10000 : m));
  return { ...(input as object), notifications: { ...rest, startReminderHours: hours } };
}

export function defaultConfig(overrides: ConfigInput = {}): TournamentConfig {
  return parseConfig(overrides);
}

/** Enforce cross-field rules (6mans is individual 3v3, 1v1 is individual). */
export function normalizeConfig(cfg: TournamentConfig): TournamentConfig {
  if (cfg.format === 'sixmans') {
    cfg.teamSize = 3;
    cfg.registrationMode = 'individual';
  }
  if (cfg.teamSize === 1) cfg.registrationMode = 'individual';
  return cfg;
}

export function validateConfig(cfg: TournamentConfig): string[] {
  const problems: string[] = [];
  const { registration: r } = cfg;
  if (r.opensAt && r.closesAt && Date.parse(r.opensAt) >= Date.parse(r.closesAt))
    problems.push('Registration must open before it closes.');
  if (r.closesAt && cfg.schedule.startAt && Date.parse(r.closesAt) > Date.parse(cfg.schedule.startAt))
    problems.push('Registration must close before the tournament starts.');
  if (r.minRoster != null && r.minRoster > cfg.teamSize) problems.push('Minimum roster cannot exceed team size.');
  if (cfg.checkIn.enabled && cfg.checkIn.closesMinutesBefore >= cfg.checkIn.opensMinutesBefore)
    problems.push('Check-in must open before it closes.');
  if (cfg.schedule.autoStart && !cfg.schedule.startAt) problems.push('Auto-start needs a start time.');
  if (!isValidTimezone(cfg.schedule.timezone)) problems.push(`Unknown timezone "${cfg.schedule.timezone}".`);
  if (cfg.format === 'sixmans' && cfg.registration.capacity != null && cfg.registration.capacity < 6)
    problems.push('6mans needs a capacity of at least 6 players.');
  return problems;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Settings that define the competition's structure. Once a tournament starts these are locked
 * everywhere (API, bot, jobs). Paths are prefixes into the config object.
 */
export const LOCKED_AFTER_START = [
  'format',
  'teamSize',
  'registrationMode',
  'minEntrants',
  'series',
  'seeding',
  'results',
  'singleElim',
  'doubleElim',
  'swiss',
  'roundRobin',
  'sixmans',
  'registration',
  'checkIn',
  'schedule.startAt',
  'schedule.autoStart',
  'schedule.matchDeadlineMinutes',
] as const;

/** Return dotted paths of leaf values that differ between two configs. */
export function diffConfig(a: unknown, b: unknown, prefix = ''): { path: string; before: unknown; after: unknown }[] {
  const out: { path: string; before: unknown; after: unknown }[] = [];
  const isObj = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of [...keys].sort()) {
      out.push(...diffConfig((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
    }
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: prefix, before: a, after: b });
  return out;
}

export function lockedPaths(changes: { path: string }[]): string[] {
  return changes
    .map((c) => c.path)
    .filter((p) => LOCKED_AFTER_START.some((l) => p === l || p.startsWith(`${l}.`)));
}

/** Deep-merge a partial patch into a config, then re-validate. Arrays are replaced, not merged. */
export function applyConfigPatch(cfg: TournamentConfig, patch: unknown): TournamentConfig {
  const merge = (base: unknown, p: unknown): unknown => {
    if (p === undefined) return base;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return p;
    if (base === null || typeof base !== 'object' || Array.isArray(base)) return p;
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) out[k] = merge(out[k], v);
    return out;
  };
  return parseConfig(merge(cfg, patch));
}

/** Set a single dotted path (used by the Discord `/tourney set` command). Value is parsed from text. */
export function patchFromPath(path: string, raw: string): Record<string, unknown> {
  let value: unknown = raw;
  const t = raw.trim();
  if (t === 'true' || t === 'on' || t === 'yes') value = true;
  else if (t === 'false' || t === 'off' || t === 'no') value = false;
  else if (t === 'null' || t === 'none' || t === 'default') value = null;
  else if (/^-?\d+(\.\d+)?$/.test(t) && !/^\d{15,}$/.test(t)) value = Number(t);
  else if (t.startsWith('[') || t.startsWith('{')) {
    try {
      value = JSON.parse(t);
    } catch {
      value = raw;
    }
  } else if (/^-?\d+(\s*,\s*-?\d+)+$/.test(t)) value = t.split(',').map((x) => Number(x.trim()));
  const parts = path.split('.').filter(Boolean);
  const root: Record<string, unknown> = {};
  let cur = root;
  parts.forEach((p, i) => {
    if (i === parts.length - 1) cur[p] = value;
    else cur = (cur[p] = {}) as Record<string, unknown>;
  });
  return root;
}

/** Series length for a specific bracket+round, honoring per-round overrides. */
export function bestOfFor(cfg: TournamentConfig, bracket: string, round: number): BestOf {
  if (cfg.format === 'sixmans') {
    const base = bracket === 'pool' ? cfg.sixmans.groupBestOf : cfg.sixmans.finalsBestOf;
    return (cfg.series.perRound[`${bracket}:${round}`] as BestOf | undefined) ?? base;
  }
  return (cfg.series.perRound[`${bracket}:${round}`] as BestOf | undefined) ?? cfg.series.bestOf;
}

/** Default qualifiers per pool for 6mans. */
export function defaultQualifiersPerPool(poolCount: number): number {
  if (poolCount <= 1) return 6;
  if (poolCount === 2) return 3;
  return 2;
}
