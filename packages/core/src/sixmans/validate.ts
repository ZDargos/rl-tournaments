/**
 * Independent validator for 6mans group-stage schedules. It deliberately shares no code with the
 * scheduler so a scheduler bug cannot hide itself. Trios are canonicalised by sorting player ids,
 * so A-B-C, C-B-A and B-A-C are the same trio regardless of side, round or match number.
 */
export interface ScheduleToValidate {
  rounds: { round: number; matches: { teamA: string[]; teamB: string[] }[]; sitOut?: string[] }[];
}

export interface ScheduleValidation {
  valid: boolean;
  errors: string[];
  appearances: Record<string, number>;
  spread: number;
  repeatedTrios: string[];
}

export const canonicalTrio = (ids: string[]) => ids.slice().sort().join('|');

export function validateSchedule(
  schedule: ScheduleToValidate,
  playerIds: string[],
  opts: { matchesPerRound?: number; rounds?: number; maxSpread?: number } = {},
): ScheduleValidation {
  const errors: string[] = [];
  const pool = new Set(playerIds);
  const appearances: Record<string, number> = Object.fromEntries(playerIds.map((p) => [p, 0]));
  const trioSeen = new Map<string, string>();
  const repeatedTrios: string[] = [];
  const m = opts.matchesPerRound ?? 1;
  if (opts.rounds != null && schedule.rounds.length !== opts.rounds)
    errors.push(`Expected ${opts.rounds} rounds, found ${schedule.rounds.length}.`);
  schedule.rounds.forEach((round, ri) => {
    const where = `Round ${round.round ?? ri + 1}`;
    if (round.matches.length !== m) errors.push(`${where}: expected ${m} match(es), found ${round.matches.length}.`);
    const inRound = new Set<string>();
    round.matches.forEach((match, mi) => {
      const mw = `${where} match ${mi + 1}`;
      if (match.teamA.length !== 3 || match.teamB.length !== 3) errors.push(`${mw}: each team must have exactly 3 players.`);
      const six = [...match.teamA, ...match.teamB];
      if (new Set(six).size !== six.length) errors.push(`${mw}: a player appears more than once in the match.`);
      for (const p of six) {
        if (!pool.has(p)) errors.push(`${mw}: ${p} is not in this pool.`);
        if (inRound.has(p)) errors.push(`${where}: ${p} is scheduled in two matches.`);
        inRound.add(p);
        if (p in appearances) appearances[p]++;
      }
      for (const team of [match.teamA, match.teamB]) {
        const key = canonicalTrio(team);
        if (trioSeen.has(key)) {
          errors.push(`${mw}: trio ${team.slice().sort().join(', ')} already played together in ${trioSeen.get(key)}.`);
          repeatedTrios.push(key);
        } else trioSeen.set(key, mw);
      }
    });
    if (round.sitOut) {
      const expected = playerIds.filter((p) => !inRound.has(p)).sort();
      const given = round.sitOut.slice().sort();
      if (expected.join(',') !== given.join(',')) errors.push(`${where}: sit-out list does not match the players not scheduled.`);
    }
  });
  const vals = Object.values(appearances);
  const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  const total = vals.reduce((s, v) => s + v, 0);
  if (opts.maxSpread != null && spread > opts.maxSpread)
    errors.push(`Game appearances differ by ${spread}; the best attainable difference is ${opts.maxSpread}.`);
  if (playerIds.length && total >= playerIds.length) {
    for (const [p, v] of Object.entries(appearances)) if (v === 0) errors.push(`${p} is never scheduled.`);
  }
  return { valid: errors.length === 0, errors, appearances, spread, repeatedTrios };
}

/** Swap two players within one round (between teams, or between a team and the sit-out list). */
export function swapInRound<T extends ScheduleToValidate>(schedule: T, round: number, p1: string, p2: string, allPlayers: string[]): T {
  const copy = JSON.parse(JSON.stringify(schedule)) as T;
  const rd = copy.rounds.find((r) => r.round === round);
  if (!rd) throw new Error(`Round ${round} not found.`);
  const playing = new Set(rd.matches.flatMap((m) => [...m.teamA, ...m.teamB]));
  rd.sitOut = allPlayers.filter((p) => !playing.has(p));
  const replace = (arr: string[]) => arr.map((x) => (x === p1 ? p2 : x === p2 ? p1 : x));
  rd.matches = rd.matches.map((m) => ({ ...m, teamA: replace(m.teamA), teamB: replace(m.teamB) }));
  rd.sitOut = replace(rd.sitOut);
  return copy;
}
