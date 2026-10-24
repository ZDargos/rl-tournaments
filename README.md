# RL Tournaments

A free, self-hostable Rocket League tournament platform for Discord communities: a website (GitHub Pages) and a Discord bot that share one backend, so everything you do in one shows up in the other.

- **Formats:** single elimination, double elimination (optional grand-final reset, off by default), Swiss, round robin, and **6mans** (skill-balanced pools, no-repeated-trio group stage, individual standings, balanced 3v3 finals). Series of Bo1/3/5/7, per round if you like.
- **Discord login** (scopes `identify guilds` only). Every server is isolated: its tournaments, presets and members never leak into another server.
- **Roles:** creator, tournament admins, preset managers, participants, viewers. Every sensitive action is checked on the server.
- **Public or private tournaments.** Private ones are hidden from lists, search, exports, profiles and announcements for anyone without access.
- **Presets per server.** A tournament copies a preset when it is created, so later preset edits never change it. Re-applying a preset shows a diff first and is only allowed before the start.
- **Registration:** capacity, waitlist with automatic promotion, approval, required roles, check-in, and team invitations.
- **Results:** a player reports, and a different player from the other team confirms. Disputes go to organizers, and corrections show which later matches they affect. A full audit trail is kept.
- **Voice:** a private temporary voice channel per team (per player in 1v1). Connected players are moved in automatically. Channels are deleted when the match ends and reconciled after a restart.
- **Notifications:** reminders, match-ready and confirmation requests, by channel or DM (organizer's choice). Players can opt out, and duplicates are prevented.
- **Data:** history, player profiles and stats, CSV exports.
- **Cost:** $0. No paid APIs, no AI services. See [docs/COST.md](docs/COST.md).

## How it fits together

```
 Browser ──HTTPS──► GitHub Pages (static website, no secrets)
    │
    └──HTTPS (fetch, bearer session)──► Your machine: one Node.js process
                                         ├─ REST API (Fastify)
 Discord ◄──gateway/REST──────────────── ├─ Discord bot (discord.js)
                                         ├─ job loop (reminders, auto-start, voice cleanup, backups)
                                         └─ SQLite database file (+ automatic backups)
```

The API is exposed over HTTPS with **Tailscale Funnel** (free) or any reverse proxy. Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start (local, no Discord needed)

```bash
nvm use            # Node 22 (see .nvmrc)
npm ci
npm run build
DISCORD_DISABLED=true DEV_LOGIN=true npm run dev:server   # API on http://localhost:8787
npm run dev:web                                           # website on http://localhost:5173
```

Open http://localhost:5173, choose **Log in**, then use the developer login form. Enter any 17–20 digit user id, a username, and a server id such as `200000000000000001` with "Server admin" ticked. Then create a tournament.

## Going live

1. [docs/DISCORD_SETUP.md](docs/DISCORD_SETUP.md): create the Discord application and bot, then invite it.
2. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): run the server, expose it with Tailscale Funnel, and publish the website on GitHub Pages.
3. [docs/OPERATIONS.md](docs/OPERATIONS.md): backups, restore, upgrades, the launch checklist and troubleshooting.

## Tests

```bash
npm test           # 85 unit, property-based and integration tests (vitest)
npm run test:e2e   # browser end-to-end (Chromium via Playwright), needs `npm run build` first
npm run typecheck
```

- **`packages/core/test`:** bracket, Swiss and round-robin generation; series; lifecycle; permissions; and the 6mans algorithms. The 6mans tests are property-based: they generate many random pools (fixed seeds, so runs are reproducible) and check that a schedule never repeats a trio and that infeasibility is reported correctly.
- **`apps/server/test`:** the real API and bot handlers against an in-memory database and a fake Discord. Covers OAuth, isolation and privacy, idempotency, format lock, confirmations, disputes, corrections, reminders, restart recovery and voice channels.
- **`e2e/run-e2e.mjs`:** drives the built website in Chromium against a real server through:
  - A full 1v1 bracket from login to champion.
  - A 6mans run through pools, schedule, group stage and finals.
  - A permission refusal.
  - Phone-width layout checks.

## Discord commands

| Command | What it does |
|---|---|
| `/tourney` | create, list, info, publish, open, close, start, pause, resume, cancel, set, admin-add/remove, invite, apply-preset, export, link |
| `/reg` | join, leave, checkin, list, myrank; organizers: approve, reject, remove, add, seed, rank |
| `/team` | invite, accept, decline, kick, roster, rename |
| `/preset` | list, show, create, save, set, rename, duplicate, delete |
| `/match` | mine, info, report, confirm, dispute; organizers: resolve, forfeit, abandon |
| `/view` | standings, bracket, pools, schedule |
| `/sixmans` | make-pools, confirm-pools, schedule, swap, confirm-schedule, finals, start-finals |
| `/notify` | dms, mute, unmute, status |
| `/voice` | repair, status |
| `/server` | settings, role, info |

Everything can also be done on the website. Bot interactions are deduplicated, so a retried Discord interaction never runs twice.

## Repository layout

```
packages/core   Pure TypeScript domain logic: formats, 6mans algorithms, config schema, lifecycle, permissions
apps/server     Fastify API + discord.js bot + job loop + SQLite (better-sqlite3)
apps/web        React + Vite website (HashRouter, works on GitHub Pages)
e2e             Browser end-to-end test
docs            Architecture, 6mans algorithm, deployment, Discord setup, cost, operations
deploy          systemd unit
```

## Security in one paragraph

- **Secrets stay on the server.** The bot token, client secret and database exist only on the server machine, in `.env` (git-ignored). The website bundle contains only the public API URL, and the e2e test checks that the bundle holds no secret names.
- **Sessions are hashed.** Session tokens are random, and only their SHA-256 hash is stored. Discord access tokens are used once at login and never stored.
- **Scopes are minimal.** OAuth asks for `identify guilds`. The bot uses no privileged intents (only Guilds and GuildVoiceStates) and asks only for the channel and voice permissions it needs.
- **Authorization is server-side.** Every write is checked on the server, whatever the UI shows.

## License

Apache License 2.0 (see LICENSE). Not affiliated with Psyonix, Epic Games or Discord.
