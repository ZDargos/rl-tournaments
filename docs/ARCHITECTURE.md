# Architecture

## Components

| Part | Tech | Where it runs |
|---|---|---|
| `packages/core` | TypeScript, zod | Shared by server and website. Pure functions: config schema and defaults, lifecycle state machine, permission rules, bracket/Swiss/round-robin generation, standings, the 6mans pool, schedule, validator and finals algorithms. No I/O. |
| `apps/server` | Node 22, Fastify, discord.js 14, better-sqlite3 | One process on your machine: REST API, Discord bot, job loop and SQLite. |
| `apps/web` | React 19, Vite, React Router (hash mode) | Static files on GitHub Pages. Talks to the API with `fetch`. |

The website and the bot are two clients of the same service layer (`apps/server/src/services`). There is no logic that exists only in the bot or only on the website. Both call the same functions, which enforce permissions, the lifecycle and the format lock.

## Data and integrity

The database is SQLite in WAL mode, a single file. Migrations live in `apps/server/src/db/migrations` and run at start-up. Several rules are enforced by the database itself, not just the code:

- **Format lock:** the `tournaments_format_lock` trigger refuses changes to format or structure once a tournament is in progress, paused or completed.
- **Final states:** a completed or cancelled tournament never changes state again.
- **Completed results:** a completed match can only change through a correction, which bumps `result_version`. The `matches_completed_immutable` trigger enforces this.
- **Audit log:** append-only (triggers block UPDATE and DELETE).
- **No repeated 6mans trio:** `sixmans_trios` has a unique key on the pool plus the sorted trio, so a repeated trio is impossible even if code had a bug.
- **Uniqueness:** one entry per user per tournament, and one membership per team.

## Lifecycle

```
draft ⇄ published → registration_open ⇄ registration_closed → ready
   ↘ (start from published/open/closed/ready) → in_progress ⇄ paused → completed
   any non-final state → cancelled
```

Start runs a checklist and refuses with a clear list of problems if any check fails:

- enough entrants,
- complete teams,
- 6mans pools and schedule confirmed,
- etc.

On start, brackets or pairings are generated in one transaction and the format becomes locked.

## Auth and access

- **Login:** Discord OAuth2 authorization code flow with scopes `identify guilds`.
  - `state` is single-use and expires.
  - The API exchanges the code server-side, reads the user and guild list once, then discards the Discord token.
- **Website session:** the browser gets a one-time login code in the redirect, which it exchanges for a random session token.
  - The token is stored in `localStorage` and sent as `Authorization: Bearer`.
  - The server stores only its SHA-256.
  - There are no cookies, so there is no CSRF surface. CORS only allows `WEB_URL`.
- **Server membership:** comes from OAuth (at login), from bot interactions, and from live lookups. Live lookups cover role-gated actions and are cached for 10 minutes.
- **Permissions:** every request is authorized in the service layer (`services/access.ts` and `packages/core/src/permissions.ts`).
  - Server isolation: a tournament or preset is only reachable from its own server.
  - Private tournaments return 404, not 403, to people without access, so their existence doesn't leak. They are also left out of lists, search, profiles, exports and announcements.

## Reliability

- **Idempotency:**
  - Website writes carry an `Idempotency-Key` header. A repeated request returns the stored response instead of running twice.
  - Discord interactions are deduplicated by interaction id (`processed_interactions`).
  - Result reports are versioned, so a stale confirm can't confirm a newer report.
- **Notifications:**
  - They go through an outbox table. Each recipient delivery is recorded before it is sent, so a crash mid-send can't produce duplicates on retry.
  - Failed sends retry with backoff, up to 5 attempts.
  - Reminders are rows with a due time, so they survive restarts. A reminder whose moment passed while the server was down is skipped rather than sent late.
- **Voice channels:**
  - Rows track each channel. The job loop creates them when a match becomes ready and deletes them when it completes.
  - On start-up the loop reconciles against Discord: it deletes orphans and recreates missing ones.
  - Players already connected to voice are moved into their team channel.
- **The job loop** runs every `JOB_INTERVAL_SECONDS`:
  - due notifications,
  - auto open/close of registration,
  - check-in deadlines and no-show removal,
  - auto-start,
  - voice reconcile,
  - backups.

## Formats

- **Single and double elimination:** standard seeding with byes for the top seeds, and an optional third-place match. In double elimination, the order in which players drop into the losers bracket alternates to delay rematches. The grand-final reset is optional and off by default.
- **Swiss:** players are paired by current standing with no rematches, using a backtracking search. Only if no rematch-free pairing exists is a rematch allowed, and that fallback is logged. The bye goes to the lowest-ranked player who hasn't had one. Default tie-breakers are points, Buchholz, game difference, goal difference, then seed (all configurable). The default round count is `ceil(log2(n))`.
- **Round robin:** circle method, playing everyone once or more (configurable). Default tie-breakers are points, head-to-head, game difference, goal difference, then seed.
- **6mans:** see [SIXMANS.md](SIXMANS.md).

Results use series (Bo1/3/5/7, optionally per round) with per-game goals. A correction to a completed match lists the later matches it would reset, and asks for confirmation before resetting them.
