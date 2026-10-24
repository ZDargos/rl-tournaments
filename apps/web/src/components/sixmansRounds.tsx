import { planEqualRounds, poolSizesFor, MIN_POOL_SIZE } from '@rl/core';

/**
 * Live answer to "how many rounds does each pool need so everyone plays the same amount?" for a
 * player count, pool count and games-per-player wish. Uses the same core function as the server.
 */
export function RoundsPreview({ players, poolCount, matchesPerRound, games }: { players: number; poolCount: number; matchesPerRound: number; games: number | null }) {
  if (!Number.isFinite(players) || players < 1) return null;
  if (players < MIN_POOL_SIZE * poolCount * matchesPerRound)
    return <div className="alert info small">{players} players are not enough for {poolCount} pool(s){matchesPerRound > 1 ? ` with ${matchesPerRound} matches per round` : ''}: each pool needs at least {MIN_POOL_SIZE * matchesPerRound}. Use {Math.max(1, Math.floor(players / (MIN_POOL_SIZE * matchesPerRound)))} pool(s) or fewer.</div>;
  const sizes = poolSizesFor(players, poolCount);
  const plan = planEqualRounds({ poolSizes: sizes, matchesPerRound, games });
  if (plan.problems.length) return <div className="alert error small">{plan.problems.join(' ')}</div>;
  const c = plan.chosen!;
  const pools = sizes.map((n, i) => ({ name: `Pool ${String.fromCharCode(65 + i)}`, n, rounds: c.rounds[i] }));
  return (
    <div className="alert info small">
      <strong>{players} players → {c.games} games each.</strong>{' '}
      {pools.map((p) => `${p.name}: ${p.n} players, ${p.rounds} rounds`).join(' · ')}
      {plan.options.length > 1 && <div className="tiny" style={{ marginTop: 4 }}>Other equal options: {plan.options.filter((o) => o.games !== c.games).map((o) => `${o.games} games (${[...new Set(o.rounds)].join('/')} rounds)`).join(', ')}.</div>}
      {plan.notes.map((n) => <div key={n} className="tiny" style={{ marginTop: 4 }}>{n}</div>)}
    </div>
  );
}
