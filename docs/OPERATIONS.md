# Operations

## Backups

- **Automatic:** the server writes an online SQLite backup every `BACKUP_INTERVAL_HOURS` (default 24) to `BACKUP_DIR`, as `rl-tournaments-<timestamp>.db`. It keeps the newest `BACKUP_KEEP` (default 14).
  - It is a consistent snapshot taken while the app runs.
- **Manual:** `node --env-file=.env apps/server/dist/cli.js backup`. Do this before every upgrade.
- **Off-machine:** a backup on the same disk doesn't survive a dead disk. Copy `BACKUP_DIR` somewhere else regularly. Free options:
  - a synced folder (Google Drive, OneDrive or Dropbox client),
  - a USB disk,
  - a `cron` job such as `rsync -a /opt/rl-tournaments/backups/ other-machine:rlt-backups/` over Tailscale.
- **What is in a backup:** everything (users, sessions, tournaments, results, audit log). Treat backup files as private, because they contain session hashes and Discord user ids. The backup does not contain the bot token or client secret, which live only in `.env`.

### Restore

1. Stop the server: `sudo systemctl stop rl-tournaments`.
2. Move the current `data/rl-tournaments.db` and its `-wal`/`-shm` files aside. Don't delete them yet.
3. Copy the chosen backup to `DATABASE_PATH`.
4. Start the server.

On start the server:

- runs any migrations,
- re-schedules due reminders,
- reconciles voice channels with Discord. It deletes channels that the restored data doesn't know about, and recreates missing ones for ready matches.

`node apps/server/dist/cli.js restore` prints these steps. It never overwrites anything itself.

## Launch checklist

- [ ] `.env` filled in, `chmod 600`, `NODE_ENV=production`, `DEV_LOGIN=false`.
- [ ] `curl https://<PUBLIC_API_URL>/health` returns `"ok":true` and `"discord":true`.
- [ ] Discord OAuth redirect is exactly `<PUBLIC_API_URL>/auth/discord/callback`.
- [ ] Repository variable `VITE_API_URL` is set, Pages source is "GitHub Actions", and the Deploy website workflow is green.
- [ ] `WEB_URL` matches the Pages URL exactly (scheme, host, path, no trailing slash).
- [ ] Bot invited with the permissions in [DISCORD_SETUP.md](DISCORD_SETUP.md), and `/server info` shows no missing permissions.
- [ ] Slash commands registered (`register-commands`).
- [ ] An announcement channel and voice category are set in the server settings.
- [ ] Logging in on the website works, and your server appears under **My stuff**.
- [ ] A test tournament: create, register two accounts, start, and check:
  - the voice channels appear,
  - report and confirm work,
  - the channels are deleted when the match finishes.
- [ ] A backup appears in `BACKUP_DIR`, and you have set up an off-machine copy.
- [ ] The machine doesn't sleep, and the service starts on boot (test with a reboot).

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Website says it can't reach the server | Server down, Funnel off (`tailscale funnel status`), or `VITE_API_URL` wrong. The browser console shows the URL it tried. |
| CORS error in the browser console | `WEB_URL` doesn't exactly match the site origin. Fix and restart. |
| Discord login says "redirect_uri invalid" | Add `<PUBLIC_API_URL>/auth/discord/callback` to OAuth2 → Redirects. It must match exactly. |
| "Discord login is not configured" | `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` missing in `.env`. |
| Slash commands don't show | Run `register-commands`. Global commands can take time; set `DISCORD_DEV_GUILD_ID` for instant testing. |
| Voice channels not created | Missing Manage Channels / Move Members / Connect, or a category override denies the bot. `/server info` shows the bot's effective permissions, the Manage → Control tab shows the error, and **Repair** retries. |
| Players not moved into voice | They weren't connected to any voice channel in that server when the match became ready. Bots can't pull people into voice who aren't connected. They can join the channel themselves. |
| Player gets no DMs | They block DMs from server members, or turned DMs off. Organizers see them under "won't get notifications". Channel announcements still work. |
| Role-gated registration refuses someone who has the role | Membership is cached up to 10 minutes. Wait, or have them use any bot command in the server to refresh it. |
| `SqliteError: database is locked` | Another process (a second copy of the server, or a DB browser) has the file open. Run only one server per database. |
| Server won't start: "DEV_LOGIN must not be enabled in production" | Working as intended. Set `DEV_LOGIN=false`. |

Logs are JSON lines on stdout (`journalctl -u rl-tournaments`). Set `LOG_LEVEL=debug` temporarily for more detail. Secrets are never logged.

## Security notes

- **The only secrets** are `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET` and the database or backups. All stay on the server machine.
- **If the bot token leaks,** reset it in the Developer Portal right away and update `.env`.
- **Logging everyone out** (for example after a leaked backup): stop the server, run `DELETE FROM sessions;` on the database with any SQLite tool, then start the server.
- **Rate limits:** the API rate-limits per client address and caps request bodies at 256 KB.
- **Audit trail:** organizer actions, result reports, confirmations, disputes and corrections are written to an append-only audit log, visible on Manage → Activity.

## Known limitations

These are approximations and gaps you should know about before relying on the platform:

- **Replacing a player mid-tournament** updates the team's roster for all its matches, including completed ones. The result stands, but a past match will list the substitute. The audit log records the change.
- **Swiss corrections:** correcting a Swiss result after the next round was already paired updates standings but doesn't re-pair rounds that already exist.
- **Voice status list:** the voice status on the Control tab can still show earlier failed attempts after a successful repair.
- **No Discord at all:** with `DISCORD_DISABLED=true`, notifications are recorded as skipped rather than sent. This mode is for local testing.
- **Funnel beta:** Tailscale Funnel is labelled beta by Tailscale. If it changes, any HTTPS reverse proxy works instead.
- **Real Discord not tested here:** the automated tests use a fake Discord and a fake OAuth provider. Behaviour against the real Discord API (permission edge cases, rate limits) has to be confirmed in your own server using the launch checklist above.
