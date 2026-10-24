# Deployment ($0)

You run **one Node.js process** on an always-on machine you control. That process is the API, the Discord bot and the job runner, and it keeps its data in one SQLite file. **GitHub Pages** hosts the website. **Tailscale Funnel** gives the API a public HTTPS address without opening router ports. Why this setup rather than a free cloud tier is explained in [COST.md](COST.md).

## 0. What you need

- **An always-on computer:** a Raspberry Pi 4/5, an old laptop, a home server, or an Oracle Always Free VM. Linux, macOS or Windows all work. A 64-bit OS with Node 22 is required.
- **A Discord application:** see [DISCORD_SETUP.md](DISCORD_SETUP.md).
- **A free Tailscale account:** https://tailscale.com
- **A public GitHub repository** holding this code.

## 1. Install and build the server

```bash
# Linux example (use nvm or your package manager for Node 22)
sudo useradd --system --create-home --home-dir /opt/rl-tournaments rlt   # optional dedicated user
sudo -u rlt git clone https://github.com/<you>/<repo>.git /opt/rl-tournaments
cd /opt/rl-tournaments
npm ci
npm run build
cp .env.example .env && chmod 600 .env
nano .env       # fill in the values (see below)
```

Keep `.env` readable only by the service user. It is listed in `.gitignore`. Never commit it.

| Variable | Value |
|---|---|
| `PUBLIC_API_URL` | your Funnel URL from step 2, e.g. `https://pi.tail1234.ts.net` |
| `WEB_URL` | your Pages URL, e.g. `https://<you>.github.io/<repo>` |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` | from the Developer Portal |
| `HOST` | `127.0.0.1` (Funnel connects locally, so the port is never exposed directly) |
| `TRUST_PROXY` | `true` behind Funnel, so rate limits see real client addresses |
| `DEV_LOGIN` | must be `false`; the server refuses to start with it in production |

Then:

```bash
node --env-file=.env apps/server/dist/cli.js register-commands
node --env-file=.env apps/server/dist/index.js     # try it in the foreground first; Ctrl+C to stop
curl http://127.0.0.1:8787/health                  # {"ok":true,...}
```

Database migrations run automatically at start-up.

## 2. Public HTTPS with Tailscale Funnel

```bash
curl -fsSL https://tailscale.com/install.sh | sh     # or the installer for your OS
sudo tailscale up
sudo tailscale funnel --bg 8787
```

- **Enabling Funnel:** the first time, the CLI prints a link to enable HTTPS certificates and Funnel for your tailnet. Open it and approve.
- **Your URL:** `tailscale funnel status` shows the public URL, `https://<machine>.<tailnet>.ts.net`. Put it in `PUBLIC_API_URL`, add `<that URL>/auth/discord/callback` to the Discord OAuth redirects, then restart the server.
- **Beta and limits:** Funnel is currently labelled beta and has bandwidth limits. Both are fine for this API.
- **Other ways in:** any HTTPS reverse proxy (Caddy, nginx + Let's Encrypt, a different tunnel) works too. Point it at `127.0.0.1:8787` and set `PUBLIC_API_URL` to its address.

## 3. Run it as a service

**Linux (systemd):**

```bash
sudo cp deploy/rl-tournaments.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rl-tournaments
journalctl -u rl-tournaments -f        # logs
```

Edit `User=` and the paths in the unit file if you didn't use `/opt/rl-tournaments`.

**Windows:**

1. Install Node 22 and Tailscale.
2. Build as above.
3. Create a Task Scheduler task with these settings:
   - Trigger: "At startup".
   - "Run whether user is logged on or not".
   - Action: `node.exe` with arguments `--env-file=.env apps\server\dist\index.js`.
   - "Start in": the repository folder.
   - On the Settings tab: "If the task fails, restart every 1 minute".
4. Run `tailscale funnel --bg 8787` once from an elevated prompt.

**macOS:** use a `launchd` plist with `KeepAlive` true and the same command.

Turn off sleep on the machine, or it stops answering.

## 4. Publish the website on GitHub Pages

1. On GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Open **Settings → Secrets and variables → Actions → Variables** and add the variable `VITE_API_URL` = your `PUBLIC_API_URL`.
   - This is a public address, not a secret, and it ends up in the browser bundle by design.
   - Never add the bot token or client secret to GitHub.
3. Push to `main`. The **Deploy website** workflow builds `apps/web` and publishes it, and the site appears at `https://<you>.github.io/<repo>/`.
4. Put that URL in `WEB_URL` in `.env` and restart the server. CORS only allows this origin, and login redirects back to it.

The site uses hash URLs (`/#/t/12`), so deep links work on GitHub Pages without server rewrites.

## 5. Check it works

Go through the launch checklist in [OPERATIONS.md](OPERATIONS.md#launch-checklist).

## Optional: Oracle Cloud Always Free instead of a home machine

1. Create an Always Free Ampere A1 or AMD micro instance with Ubuntu, then follow steps 1–4 on it.
2. For HTTPS you can use Funnel there too, or open port 443 in the VCN security list and use Caddy.

Oracle can reclaim Always Free instances that stay idle for 7 days (p95 CPU, network and memory all under 20%). This app is light, so check Oracle's current policy and keep your backups copied off the VM. See [COST.md](COST.md).

## Upgrading

```bash
cd /opt/rl-tournaments
node --env-file=.env apps/server/dist/cli.js backup     # always back up first
git pull
npm ci
npm run build
node --env-file=.env apps/server/dist/cli.js register-commands   # if commands changed
sudo systemctl restart rl-tournaments
```

Migrations run on start. After a restart, the server:

- re-schedules missed reminders,
- reconciles voice channels,
- resumes the job loop.
