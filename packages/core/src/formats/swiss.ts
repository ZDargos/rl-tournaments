import { tieKey } from '../rng.js';

export interface SwissEntrant {
  id: string;
  points: number;
  rank: number;
  opponents: string[];
  hadBye: boolean;
}

export interface SwissPairingResult {
  pairs: { a: string; b: string }[];
  bye: string | null;
  rematches: { a: string; b: string }[];
  log: string[];
}

export const defaultSwissRounds = (n: number) => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));

/**
 * Swiss pairing. Entrants are ordered by current standings. The bye (odd counts) goes to the
 * lowest-ranked entrant who has not had one. Pairing is a depth-first search that pairs the
 * highest remaining entrant with the closest-ranked eligible opponent, backtracking when an
 * entrant would be left without a legal opponent. If no rematch-free pairing exists, the search is
 * repeated allowing rematches and the fallback is reported in `log` and `rematches`.
 */
export function pairSwissRound(entrants: SwissEntrant[], seed: number, nodeLimit = 200000): SwissPairingResult {
  const log: string[] = [];
  const ordered = entrants.slice().sort((x, y) => x.rank - y.rank || tieKey(x.id, seed) - tieKey(y.id, seed));
  let bye: string | null = null;
  let pool = ordered;
  if (ordered.length % 2 === 1) {
    const candidates = [...ordered].reverse();
    const pick = candidates.find((e) => !e.hadBye) ?? candidates[0];
    if (pick.hadBye) log.push(`Every entrant already had a bye; ${pick.id} receives a second bye.`);
    bye = pick.id;
    pool = ordered.filter((e) => e.id !== pick.id);
  }
  const played = new Map<string, Set<string>>(pool.map((e) => [e.id, new Set(e.opponents)]));

  const attempt = (allowRematch: boolean) => {
    let nodes = 0;
    const used = new Set<string>();
    const pairs: { a: string; b: string }[] = [];
    const dfs = (): boolean => {
      if (++nodes > nodeLimit) return false;
      const first = pool.find((e) => !used.has(e.id));
      if (!first) return true;
      used.add(first.id);
      const opts = pool
        .filter((e) => !used.has(e.id) && (allowRematch || !played.get(first.id)!.has(e.id)))
        .sort((x, y) => {
          const rx = allowRematch && played.get(first.id)!.has(x.id) ? 1 : 0;
          const ry = allowRematch && played.get(first.id)!.has(y.id) ? 1 : 0;
          return rx - ry || Math.abs(x.points - first.points) - Math.abs(y.points - first.points) || x.rank - y.rank;
        });
      for (const o of opts) {
        used.add(o.id);
        pairs.push({ a: first.id, b: o.id });
        if (dfs()) return true;
        pairs.pop();
        used.delete(o.id);
      }
      used.delete(first.id);
      return false;
    };
    return dfs() ? pairs : null;
  };

  let pairs = attempt(false);
  if (!pairs) {
    log.push('No pairing without rematches exists for this round; rematches were allowed and minimised.');
    pairs = attempt(true);
  }
  if (!pairs) throw new Error('Unable to pair Swiss round.');
  const rematches = pairs.filter((p) => played.get(p.a)!.has(p.b));
  for (const r of rematches) log.push(`Rematch: ${r.a} vs ${r.b}.`);
  return { pairs, bye, rematches, log };
}
