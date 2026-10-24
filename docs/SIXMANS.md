# 6mans

6mans is an individual competition played as 3v3:

1. Players register alone and are split into skill-balanced pools.
2. Each pool plays a group stage of 3v3 matches with rotating teammates, scored individually.
3. The top players form balanced 3-player teams for a single-elimination finals bracket.

Every algorithm is deterministic. The same players, settings and seed always give the same result, which makes outcomes explainable and reproducible. The code is in `packages/core/src/sixmans/`.

## 1. Skill input

The organizer chooses the input: `manual_seed` (seed 1 = strongest) or `rank`. With `rank`, the player's Rocket League rank maps to a number through a documented table in `packages/core/src/ranks.ts`, from Bronze 1 to Supersonic Legend, and organizers can override the values. Players without a value are placed lowest or at the median (configurable). Skill values are visible only to organizers, never in public views or exports.

## 2. Pools

1. **Sizes:** pool sizes are fixed first and differ by at most one. Each pool needs at least 6 players.
2. **Snake draft:** players are sorted by skill and snake-drafted into pools. Ties are broken by a seeded hash.
3. **Balancing:** a hill-climb swaps players between pools while that reduces the variance of the pools' average skill. Sizes never change.

The organizer can re-make pools or move players between them. Edits are validated (everyone exactly once, minimum size), and editing pools clears any schedule.

## 3. Group-stage schedule

Each round of a pool has one 3v3 match by default. Players not in that match sit out the round.

| Priority | Rule |
|---|---|
| Hard | **A trio of teammates never repeats within a pool.** `{A,B,C}` is the same trio regardless of side, order or round. |
| Hard | Every round has its full set of matches; nobody plays twice in one round. |
| 1 | Appearance balance: the smallest possible spread between the most- and least-used players. |
| 2 | Optional skill balance: minimize the difference in team skill totals per match. |
| 3 | Avoid repeated teammate pairs and long sit-out streaks. |

**Method:**

- **Search:** a depth-first search over rounds with backtracking and pruning, tried from the tightest appearance spread upward.
- **Proven infeasibility:** if a spread is searched exhaustively without a solution, it is proven impossible. If a search hits its node or time budget, the result is reported as **unknown**, never as impossible.
- **Skill pass:** a skill-balancing pass then re-splits each round's six players without touching appearances or reusing a trio. This is a heuristic, so the result is labelled "best found".

**Infeasibility:**

- **Hard bound:** a pool of n players has C(n,3) possible trios and each match uses 2, so more than ⌊C(n,3)/2⌋ rounds is impossible. For example, 6 players allow at most 10 rounds.
- **What the organizer sees:** when the requested rounds can't be scheduled, they get the reason plus alternatives: the largest feasible round count, or a different number of pools. Nothing is applied silently.

**Independent validator:** every schedule, including after manual swaps, is re-checked by `validate.ts`, which shares no code with the scheduler. On top of that, the database has a unique index on (pool, trio).

## 4. Standings

Standings are individual. Every player on the winning team gets 3 points and the losing team 0 (configurable). Team goals count toward each player's goals for and against.

Default tie-breakers, in order:

1. points
2. goal difference
3. goals for
4. seed or skill

A final deterministic fallback breaks any remaining tie. Unconfirmed or disputed matches don't count until resolved. Abandoned matches never count.

## 5. Qualification

- 2 pools: the top 3 of each pool qualify.
- 3 or more pools: the top 2 of each pool qualify.
- 1 pool: the top 6 qualify.

The organizer can change the number per pool.

## 6. Finals

Qualifiers are ordered across pools by pool placement, then points, goal difference and skill. Teams need exactly 3 players, so when the qualifier count isn't a multiple of 3 the organizer chooses from explicit options. Each option shows who is added or removed and what the bracket looks like:

| Option | Effect |
|---|---|
| **Use all qualifiers** | available when the count already divides by 3 |
| **Add next-best** | fills up with the best non-qualified players |
| **Drop lowest** | removes the lowest-placed qualifiers |
| **Expand / reduce to a power of two** | a full bracket with no byes |

Teams are formed by snake draft on skill, then improved with pairwise swaps that reduce the variance of team skill totals. With 12 or fewer players an exact search is also run and used if it is strictly better. The goal is that no team stacks the top players. A "standings snake" mode is also available.

The organizer can move or swap players before starting. Validation ensures teams of 3 and everyone exactly once. The finals are a single-elimination bracket of those temporary teams, seeded by team strength with byes for the top seeds.
