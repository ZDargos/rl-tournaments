/**
 * Round-robin schedule using the circle method. With an odd number of entrants a phantom BYE is
 * added; the entrant paired with it sits out that round. With `encounters` > 1 the full cycle is
 * repeated with sides swapped on every other cycle.
 */
export interface RoundRobinPairing {
  round: number;
  position: number;
  a: string;
  b: string;
}

export function buildRoundRobin(entrantIds: string[], encounters = 1): { pairings: RoundRobinPairing[]; byes: { round: number; entrantId: string }[]; rounds: number } {
  if (entrantIds.length < 2) throw new Error('Need at least two entrants.');
  const BYE = '\u0000bye';
  const list = entrantIds.length % 2 === 1 ? [...entrantIds, BYE] : [...entrantIds];
  const n = list.length;
  const cycleRounds = n - 1;
  const pairings: RoundRobinPairing[] = [];
  const byes: { round: number; entrantId: string }[] = [];
  for (let cycle = 0; cycle < encounters; cycle++) {
    const arr = list.slice();
    for (let r = 0; r < cycleRounds; r++) {
      const round = cycle * cycleRounds + r + 1;
      let pos = 0;
      for (let i = 0; i < n / 2; i++) {
        let x = arr[i];
        let y = arr[n - 1 - i];
        // Alternate home/away for the fixed entrant and per cycle for fairness.
        if ((i === 0 && r % 2 === 1) !== (cycle % 2 === 1)) [x, y] = [y, x];
        if (x === BYE || y === BYE) {
          byes.push({ round, entrantId: x === BYE ? y : x });
          continue;
        }
        pairings.push({ round, position: pos++, a: x, b: y });
      }
      // rotate all but the first
      arr.splice(1, 0, arr.pop()!);
    }
  }
  return { pairings, byes, rounds: cycleRounds * encounters };
}
