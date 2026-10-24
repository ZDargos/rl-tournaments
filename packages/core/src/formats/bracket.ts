/**
 * Generic bracket graph used by single elimination, double elimination and 6mans finals.
 *
 * A bracket is a list of matches. Each match has two slots and every slot has a *source*:
 * a seeded entrant, a bye, or the winner/loser of another match. `resolveBracket` repeatedly
 * fills slots from completed matches, auto-advances byes and voids matches that can never be
 * played, until nothing changes. The function is pure: the server persists its output.
 */

export type SlotSource =
  | { type: 'entrant'; entrantId: string }
  | { type: 'bye' }
  | { type: 'winner'; matchKey: string }
  | { type: 'loser'; matchKey: string }
  /** Grand-final reset slot: filled only when the losers-bracket side won the first grand final. */
  | { type: 'reset'; matchKey: string; side: 'a' | 'b' };

export interface BracketMatch {
  key: string;
  bracket: string;
  round: number;
  position: number;
  sourceA: SlotSource;
  sourceB: SlotSource;
  entrantA: string | null;
  entrantB: string | null;
  /** pending: waiting for entrants; ready: playable; completed: has a winner; void: can never be played. */
  status: 'pending' | 'ready' | 'completed' | 'void';
  winner: 'a' | 'b' | null;
  /** True when completed automatically because the opponent slot was a bye. */
  walkover: boolean;
}

type SlotState = { kind: 'filled'; entrantId: string } | { kind: 'empty' } | { kind: 'waiting' };

function slotState(src: SlotSource, byKey: Map<string, BracketMatch>): SlotState {
  switch (src.type) {
    case 'entrant':
      return { kind: 'filled', entrantId: src.entrantId };
    case 'bye':
      return { kind: 'empty' };
    case 'winner': {
      const m = byKey.get(src.matchKey);
      if (!m) return { kind: 'empty' };
      if (m.status === 'void') return { kind: 'empty' };
      if (m.status !== 'completed' || !m.winner) return { kind: 'waiting' };
      const id = m.winner === 'a' ? m.entrantA : m.entrantB;
      return id ? { kind: 'filled', entrantId: id } : { kind: 'empty' };
    }
    case 'loser': {
      const m = byKey.get(src.matchKey);
      if (!m) return { kind: 'empty' };
      if (m.status === 'void') return { kind: 'empty' };
      if (m.status !== 'completed' || !m.winner) return { kind: 'waiting' };
      if (m.walkover) return { kind: 'empty' };
      const id = m.winner === 'a' ? m.entrantB : m.entrantA;
      return id ? { kind: 'filled', entrantId: id } : { kind: 'empty' };
    }
    case 'reset': {
      const m = byKey.get(src.matchKey);
      if (!m || m.status === 'void') return { kind: 'empty' };
      if (m.status !== 'completed' || !m.winner) return { kind: 'waiting' };
      if (m.winner === 'a') return { kind: 'empty' }; // winners-bracket champion won: no reset
      const id = src.side === 'a' ? m.entrantA : m.entrantB;
      return id ? { kind: 'filled', entrantId: id } : { kind: 'empty' };
    }
  }
}

/** Fill slots and advance byes until a fixpoint. Returns keys of matches whose state changed. */
export function resolveBracket(matches: BracketMatch[]): string[] {
  const byKey = new Map(matches.map((m) => [m.key, m]));
  const changed = new Set<string>();
  for (let iter = 0; iter < matches.length * 4 + 10; iter++) {
    let progress = false;
    for (const m of matches) {
      if (m.status === 'completed' && !m.walkover) continue;
      const sa = slotState(m.sourceA, byKey);
      const sb = slotState(m.sourceB, byKey);
      const ea = sa.kind === 'filled' ? sa.entrantId : null;
      const eb = sb.kind === 'filled' ? sb.entrantId : null;
      let status: BracketMatch['status'] = 'pending';
      let winner: BracketMatch['winner'] = null;
      let walkover = false;
      if (sa.kind === 'filled' && sb.kind === 'filled') status = 'ready';
      else if (sa.kind === 'empty' && sb.kind === 'empty') status = 'void';
      else if (sa.kind === 'filled' && sb.kind === 'empty') {
        status = 'completed';
        winner = 'a';
        walkover = true;
      } else if (sa.kind === 'empty' && sb.kind === 'filled') {
        status = 'completed';
        winner = 'b';
        walkover = true;
      }
      // A ready match keeps a real result if one was recorded.
      if (status === 'ready' && m.status === 'completed' && !m.walkover && m.entrantA === ea && m.entrantB === eb) continue;
      if (m.entrantA !== ea || m.entrantB !== eb || m.status !== status || m.winner !== winner || m.walkover !== walkover) {
        m.entrantA = ea;
        m.entrantB = eb;
        m.status = status;
        m.winner = winner;
        m.walkover = walkover;
        changed.add(m.key);
        progress = true;
      }
    }
    if (!progress) break;
  }
  return [...changed];
}

/** Keys of every match whose slots depend (directly or transitively) on `key`. */
export function dependentsOf(matches: BracketMatch[], key: string): string[] {
  const out = new Set<string>();
  const queue = [key];
  while (queue.length) {
    const k = queue.shift()!;
    for (const m of matches) {
      for (const s of [m.sourceA, m.sourceB]) {
        if ((s.type === 'winner' || s.type === 'loser' || s.type === 'reset') && s.matchKey === k && !out.has(m.key)) {
          out.add(m.key);
          queue.push(m.key);
        }
      }
    }
  }
  return [...out];
}

/** Standard seeding order: for 8 -> [1,8,4,5,2,7,3,6]. */
export function seedOrder(size: number): number[] {
  let seeds = [1];
  while (seeds.length < size) {
    const len = seeds.length * 2;
    const next: number[] = [];
    for (const s of seeds) next.push(s, len + 1 - s);
    seeds = next;
  }
  return seeds;
}

export const nextPow2 = (n: number) => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};

function emptyMatch(key: string, bracket: string, round: number, position: number, a: SlotSource, b: SlotSource): BracketMatch {
  return { key, bracket, round, position, sourceA: a, sourceB: b, entrantA: null, entrantB: null, status: 'pending', winner: null, walkover: false };
}

/** Entrants must be passed in seed order (index 0 = seed 1). */
export function buildSingleElimination(entrantIds: string[], opts: { thirdPlace?: boolean; bracket?: string } = {}): BracketMatch[] {
  const bracket = opts.bracket ?? 'winners';
  const n = entrantIds.length;
  if (n < 2) throw new Error('Need at least two entrants.');
  const size = nextPow2(n);
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const out: BracketMatch[] = [];
  const key = (r: number, i: number) => `${bracket[0]}${r}-${i + 1}`;
  for (let i = 0; i < size / 2; i++) {
    const sa = order[2 * i];
    const sb = order[2 * i + 1];
    const src = (s: number): SlotSource => (s <= n ? { type: 'entrant', entrantId: entrantIds[s - 1] } : { type: 'bye' });
    out.push(emptyMatch(key(1, i), bracket, 1, i, src(sa), src(sb)));
  }
  for (let r = 2; r <= rounds; r++) {
    const count = size / 2 ** r;
    for (let i = 0; i < count; i++) {
      out.push(emptyMatch(key(r, i), bracket, r, i, { type: 'winner', matchKey: key(r - 1, 2 * i) }, { type: 'winner', matchKey: key(r - 1, 2 * i + 1) }));
    }
  }
  if (opts.thirdPlace && rounds >= 2) {
    out.push(emptyMatch('third', 'third_place', rounds, 0, { type: 'loser', matchKey: key(rounds - 1, 0) }, { type: 'loser', matchKey: key(rounds - 1, 1) }));
  }
  resolveBracket(out);
  return out;
}

export function buildDoubleElimination(entrantIds: string[], opts: { grandFinalReset?: boolean } = {}): BracketMatch[] {
  const n = entrantIds.length;
  if (n < 2) throw new Error('Need at least two entrants.');
  const size = nextPow2(n);
  const k = Math.log2(size);
  const wb = buildSingleElimination(entrantIds, { bracket: 'winners' });
  const out: BracketMatch[] = [...wb];
  const wk = (r: number, i: number) => `w${r}-${i + 1}`;
  const lk = (r: number, i: number) => `l${r}-${i + 1}`;
  const lbRounds = 2 * (k - 1);
  const lbCount = (j: number) => size / 2 ** (Math.floor((j + 1) / 2) + 1);
  for (let j = 1; j <= lbRounds; j++) {
    const count = lbCount(j);
    for (let i = 0; i < count; i++) {
      let a: SlotSource;
      let b: SlotSource;
      if (j === 1) {
        a = { type: 'loser', matchKey: wk(1, 2 * i) };
        b = { type: 'loser', matchKey: wk(1, 2 * i + 1) };
      } else if (j % 2 === 0) {
        const wr = j / 2 + 1;
        const idx = (j / 2) % 2 === 1 ? count - 1 - i : i; // alternate drop order to delay rematches
        a = { type: 'winner', matchKey: lk(j - 1, i) };
        b = { type: 'loser', matchKey: wk(wr, idx) };
      } else {
        a = { type: 'winner', matchKey: lk(j - 1, 2 * i) };
        b = { type: 'winner', matchKey: lk(j - 1, 2 * i + 1) };
      }
      out.push(emptyMatch(lk(j, i), 'losers', j, i, a, b));
    }
  }
  const lbChampion: SlotSource = lbRounds > 0 ? { type: 'winner', matchKey: lk(lbRounds, 0) } : { type: 'loser', matchKey: wk(k, 0) };
  out.push(emptyMatch('gf', 'grand_final', 1, 0, { type: 'winner', matchKey: wk(k, 0) }, lbChampion));
  if (opts.grandFinalReset) {
    out.push(emptyMatch('gf2', 'grand_final_reset', 1, 0, { type: 'reset', matchKey: 'gf', side: 'a' }, { type: 'reset', matchKey: 'gf', side: 'b' }));
  }
  resolveBracket(out);
  return out;
}

/** Champion of an elimination bracket, or null if not decided yet. */
export function bracketChampion(matches: BracketMatch[], format: 'single_elim' | 'double_elim'): string | null {
  const winnerOf = (m: BracketMatch) => (m.winner === 'a' ? m.entrantA : m.winner === 'b' ? m.entrantB : null);
  if (format === 'double_elim') {
    const gf = matches.find((m) => m.key === 'gf');
    const gf2 = matches.find((m) => m.key === 'gf2');
    if (!gf || gf.status !== 'completed') return null;
    if (gf.winner === 'a' || !gf2) return winnerOf(gf);
    if (gf2.status === 'completed') return winnerOf(gf2);
    return null;
  }
  const finalRound = Math.max(...matches.filter((m) => m.bracket !== 'third_place').map((m) => m.round));
  const final = matches.find((m) => m.round === finalRound && m.bracket !== 'third_place');
  if (!final || final.status !== 'completed') return null;
  const third = matches.find((m) => m.bracket === 'third_place');
  if (third && third.status !== 'completed' && third.status !== 'void') return null;
  return winnerOf(final);
}

/**
 * Placements for elimination brackets. An entrant's placement is 1 + the number of entrants
 * who were eliminated later (or not at all). Entrants eliminated at the same stage share a place.
 */
export function bracketPlacements(matches: BracketMatch[], format: 'single_elim' | 'double_elim'): Map<string, number> {
  const level = (m: BracketMatch): number => {
    if (m.bracket === 'grand_final_reset') return 10000;
    if (m.bracket === 'grand_final') return 9999;
    if (m.bracket === 'third_place') return -1; // handled separately
    if (format === 'double_elim') return m.bracket === 'losers' ? m.round : -2; // winners losses are not eliminations
    return m.round;
  };
  const elim = new Map<string, number>();
  const all = new Set<string>();
  for (const m of matches) {
    if (m.entrantA) all.add(m.entrantA);
    if (m.entrantB) all.add(m.entrantB);
  }
  const champion = bracketChampion(matches, format);
  for (const m of matches) {
    if (m.status !== 'completed' || m.walkover || !m.winner) continue;
    const loser = m.winner === 'a' ? m.entrantB : m.entrantA;
    if (!loser) continue;
    const lv = level(m);
    if (lv === -2) continue;
    if (m.bracket === 'grand_final' && format === 'double_elim') {
      // Losing the first grand final only eliminates if no reset is pending.
      const gf2 = matches.find((x) => x.key === 'gf2');
      if (m.winner === 'b' && gf2) continue;
    }
    if (lv === -1) continue;
    elim.set(loser, Math.max(elim.get(loser) ?? -Infinity, lv));
  }
  const third = matches.find((m) => m.bracket === 'third_place' && m.status === 'completed' && m.winner);
  const result = new Map<string, number>();
  const ranked = [...all].map((id) => ({ id, lv: id === champion ? Infinity : (elim.get(id) ?? (champion ? -Infinity : Infinity)) }));
  for (const r of ranked) {
    const better = ranked.filter((x) => x.lv > r.lv).length;
    result.set(r.id, better + 1);
  }
  if (third) {
    const w = third.winner === 'a' ? third.entrantA : third.entrantB;
    const l = third.winner === 'a' ? third.entrantB : third.entrantA;
    if (w) result.set(w, 3);
    if (l) result.set(l, 4);
  }
  return result;
}
