import { invalid } from '../errors.js';
import { tieKey } from '../rng.js';
import { buildSingleElimination, nextPow2, type BracketMatch } from '../formats/bracket.js';
import type { PlayerStanding } from './standings.js';

export interface QualifierEntry {
  playerId: string;
  poolIndex: number;
  poolRank: number;
  points: number;
  goalDiff: number;
  skill: number;
}

/** Order players across pools: pool placement first, then points, goal difference, skill, id. */
export function crossPoolOrder(a: QualifierEntry, b: QualifierEntry): number {
  return a.poolRank - b.poolRank || b.points - a.points || b.goalDiff - a.goalDiff || b.skill - a.skill || (a.playerId < b.playerId ? -1 : 1);
}

export function qualify(poolStandings: PlayerStanding[][], perPool: number): { qualified: QualifierEntry[]; others: QualifierEntry[] } {
  const qualified: QualifierEntry[] = [];
  const others: QualifierEntry[] = [];
  poolStandings.forEach((rows, poolIndex) => {
    if (perPool > rows.length) throw invalid('too_many_qualifiers', `Pool ${poolIndex + 1} has only ${rows.length} players; cannot qualify ${perPool}.`);
    for (const r of rows) {
      const e = { playerId: r.playerId, poolIndex, poolRank: r.rank, points: r.points, goalDiff: r.goalDiff, skill: r.skill };
      (r.rank <= perPool ? qualified : others).push(e);
    }
  });
  qualified.sort(crossPoolOrder);
  others.sort(crossPoolOrder);
  return { qualified, others };
}

export interface FinalsOption {
  id: string;
  label: string;
  players: string[];
  added: string[];
  removed: string[];
  teams: number;
  bracketSize: number;
  byes: number;
  firstRoundMatches: number;
  description: string;
}

function describe(teams: number): { bracketSize: number; byes: number; firstRoundMatches: number } {
  const size = nextPow2(teams);
  const byes = size - teams;
  return { bracketSize: size, byes, firstRoundMatches: size / 2 - byes };
}

/**
 * Valid finals structures for the qualified players. Finals teams have three players, so the
 * player count must be a multiple of three and give at least two teams. Options are never applied
 * silently; the organizer picks one in the finals preview.
 */
export function finalsOptions(qualified: QualifierEntry[], others: QualifierEntry[]): FinalsOption[] {
  const out: FinalsOption[] = [];
  const Q = qualified.length;
  const ids = qualified.map((q) => q.playerId);
  const make = (id: string, label: string, players: string[], added: string[], removed: string[], why: string) => {
    const teams = players.length / 3;
    const d = describe(teams);
    const bye = d.byes ? ` ${d.byes} team(s) get a first-round bye and ${d.firstRoundMatches} preliminary match(es) are played.` : ' No byes are needed.';
    out.push({ id, label, players, added, removed, teams, ...d, description: `${why} ${teams} teams of 3 in a ${d.bracketSize}-slot bracket.${bye}` });
  };
  const r = Q % 3;
  if (r === 0 && Q >= 6) make('as_qualified', 'Use all qualifiers', ids, [], [], `All ${Q} qualified players play.`);
  // Expand to next multiple of 3 (minimum 6) using the best non-qualified players.
  const expandTo = Math.max(6, r === 0 ? Q : Q + (3 - r));
  if (expandTo > Q && others.length >= expandTo - Q) {
    const add = others.slice(0, expandTo - Q).map((o) => o.playerId);
    make('expand', `Add ${add.length} next-best player(s)`, [...ids, ...add], add, [], `Adds ${add.length} next-best non-qualified player(s) so every team has 3 players.`);
  }
  if (r !== 0 && Q - r >= 6) {
    const removed = ids.slice(Q - r);
    make('reduce', `Drop ${r} lowest qualifier(s)`, ids.slice(0, Q - r), [], removed, `Removes the ${r} lowest-placed qualifier(s) so every team has 3 players.`);
  }
  // Power-of-two alternatives avoid byes entirely.
  const baseTeams = Math.floor((r === 0 ? Q : Q + (3 - r)) / 3);
  const teamsNow = Math.max(2, baseTeams);
  if (nextPow2(teamsNow) !== teamsNow) {
    const up = nextPow2(teamsNow) * 3;
    if (up - Q <= others.length && up > Q) {
      const add = others.slice(0, up - Q).map((o) => o.playerId);
      make('expand_pow2', `Expand to ${up / 3} teams (no byes)`, [...ids, ...add], add, [], `Adds ${add.length} next-best player(s) for a full bracket.`);
    }
    const down = (nextPow2(teamsNow) / 2) * 3;
    if (down >= 6 && down < Q) {
      const removed = ids.slice(down);
      make('reduce_pow2', `Reduce to ${down / 3} teams (no byes)`, ids.slice(0, down), [], removed, `Keeps only the top ${down} qualifiers for a full bracket.`);
    }
  }
  if (!out.length) throw invalid('finals_impossible', `Not enough players for a finals bracket (need at least 6, have ${Q} qualified and ${others.length} others).`);
  return out;
}

export interface FinalsTeam {
  key: string;
  name: string;
  players: string[];
  skill: number;
  seed: number;
}

/**
 * Form 3-player teams. "balanced": snake draft by skill then pairwise swaps that reduce the
 * variance of team skill totals, so no team stacks the top players. "standings_snake": snake
 * draft by group-stage finish (cross-pool order), no further balancing.
 */
export function formFinalsTeams(
  players: { id: string; skill: number; order: number }[],
  mode: 'balanced' | 'standings_snake',
  seed: number,
): FinalsTeam[] {
  if (players.length % 3 !== 0 || players.length < 6) throw invalid('bad_finals_size', 'Finals need a multiple of 3 players (at least 6).');
  const t = players.length / 3;
  const sorted = players.slice().sort((a, b) =>
    mode === 'balanced' ? b.skill - a.skill || a.order - b.order || tieKey(a.id, seed) - tieKey(b.id, seed) : a.order - b.order,
  );
  const teams: { id: string; skill: number; order: number }[][] = Array.from({ length: t }, () => []);
  sorted.forEach((p, i) => {
    const roundIdx = Math.floor(i / t);
    const pos = i % t;
    teams[roundIdx % 2 === 0 ? pos : t - 1 - pos].push(p);
  });
  if (mode === 'balanced') {
    const total = (tm: { skill: number }[]) => tm.reduce((s, p) => s + p.skill, 0);
    const mean = total(sorted) / t;
    const cost = () => teams.reduce((s, tm) => s + (total(tm) - mean) ** 2, 0);
    let current = cost();
    for (let pass = 0; pass < 200; pass++) {
      let best: { i: number; a: number; j: number; b: number; c: number } | null = null;
      for (let i = 0; i < t; i++)
        for (let j = i + 1; j < t; j++)
          for (let a = 0; a < 3; a++)
            for (let b = 0; b < 3; b++) {
              [teams[i][a], teams[j][b]] = [teams[j][b], teams[i][a]];
              const c = cost();
              [teams[i][a], teams[j][b]] = [teams[j][b], teams[i][a]];
              if (c < current - 1e-9 && (!best || c < best.c)) best = { i, a, j, b, c };
            }
      if (!best) break;
      [teams[best.i][best.a], teams[best.j][best.b]] = [teams[best.j][best.b], teams[best.i][best.a]];
      current = best.c;
    }
    // Swaps can stall in a local optimum. Up to 12 players (4 teams, 15,400 partitions) an exact
    // search is cheap, so use it; a strictly better partition replaces the hill-climb result.
    if (players.length <= 12) {
      const order = sorted;
      const assign: number[] = Array(order.length).fill(-1);
      const sums = Array(t).fill(0);
      const counts = Array(t).fill(0);
      let bestAssign: number[] | null = null;
      let bestCost = current - 1e-9;
      const rec = (i: number, opened: number) => {
        if (i === order.length) {
          const c = sums.reduce((s, v) => s + (v - mean) ** 2, 0);
          if (c < bestCost) {
            bestCost = c;
            bestAssign = assign.slice();
          }
          return;
        }
        for (let k = 0; k < Math.min(t, opened + 1); k++) {
          if (counts[k] === 3) continue;
          assign[i] = k;
          sums[k] += order[i].skill;
          counts[k]++;
          rec(i + 1, Math.max(opened, k + 1));
          sums[k] -= order[i].skill;
          counts[k]--;
        }
        assign[i] = -1;
      };
      rec(0, 0);
      if (bestAssign) {
        const chosen: number[] = bestAssign;
        for (let k = 0; k < t; k++) teams[k] = order.filter((_, i) => chosen[i] === k);
      }
    }
  }
  // Seed teams: higher total skill first, then better group-stage finish.
  const built = teams.map((tm) => ({
    players: tm.map((p) => p.id),
    skill: tm.reduce((s, p) => s + p.skill, 0),
    order: Math.min(...tm.map((p) => p.order)),
  }));
  built.sort((a, b) => b.skill - a.skill || a.order - b.order);
  return built.map((b, i) => ({ key: `team${i + 1}`, name: `Team ${i + 1}`, players: b.players, skill: b.skill, seed: i + 1 }));
}

export function validateFinalsTeams(teams: { players: string[] }[], expectedPlayers: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  teams.forEach((t, i) => {
    if (t.players.length !== 3) problems.push(`Team ${i + 1} has ${t.players.length} players; finals teams need exactly 3.`);
    for (const p of t.players) {
      if (seen.has(p)) problems.push(`${p} is on more than one team.`);
      seen.add(p);
    }
  });
  const exp = new Set(expectedPlayers);
  for (const p of seen) if (!exp.has(p)) problems.push(`${p} is not a finals player.`);
  for (const p of exp) if (!seen.has(p)) problems.push(`${p} is not on any team.`);
  if (teams.length < 2) problems.push('Finals need at least two teams.');
  return problems;
}

/** The finals "option" for teams the organizer picked by hand (any group-stage players, 3 per team). */
export function handPickedOption(teams: { players: string[] }[], qualifiedIds: string[]): FinalsOption {
  const players = teams.flatMap((t) => t.players);
  const picked = new Set(players);
  const d = describe(teams.length);
  const added = players.filter((p) => !qualifiedIds.includes(p));
  const removed = qualifiedIds.filter((p) => !picked.has(p));
  const bye = d.byes ? ` ${d.byes} team(s) get a first-round bye.` : '';
  return {
    id: 'hand_picked', label: 'Hand-picked teams', players, added, removed, teams: teams.length, ...d,
    description: `The organizer chose the ${teams.length} teams. Seeds follow the team order.${bye}`,
  };
}

export function buildFinalsBracket(teamKeysInSeedOrder: string[]): BracketMatch[] {
  return buildSingleElimination(teamKeysInSeedOrder, { bracket: 'finals' });
}
