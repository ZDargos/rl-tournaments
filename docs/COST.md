# Cost report: $0 per month

Checked against the providers' own pages on **2026-10-24**. Free tiers change, so re-check the linked pages before relying on them.

## What this project uses

| Piece | Service | Cost | Notes |
|---|---|---|---|
| Website | GitHub Pages | $0 | Free for public repositories on GitHub Free. https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages |
| CI | GitHub Actions | $0 | "Free for … public repositories that use standard GitHub-hosted runners." https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions |
| API + bot + database | Your own always-on machine (Raspberry Pi, old laptop or desktop) | $0 extra | Only the electricity you already pay. A Raspberry Pi uses a few watts. |
| HTTPS to that machine | Tailscale Funnel | $0 | "Available for all plans". The Personal plan is free for non-commercial use. Gives public HTTPS on `*.ts.net`. Caveats: Funnel is labelled **beta**, it only listens on ports 443, 8443 and 10000, and traffic has "non-configurable bandwidth limits". API traffic is tiny, so the limits are not a concern. https://tailscale.com/kb/1223/funnel and https://tailscale.com/pricing |
| Database | SQLite file | $0 | No separate database service, so nothing expires. |
| Discord application, bot, OAuth | Discord | $0 | No paid Discord API. |
| Domain | none needed | $0 | Uses `github.io` and `ts.net` addresses. A custom domain is optional and is the only thing that would cost money. |

**Optional host instead of your own machine:** an Oracle Cloud **Always Free** VM. You need a card for signup verification, but Always Free resources are not billed.

- **Idle reclaim:** Oracle may reclaim an Always Free compute instance that stays idle for 7 days. Idle means the 95th-percentile CPU, network *and* memory use are all under 20%.
- **This app is lightweight,** so it can count as idle. Self-hosting at home is the recommended default for that reason.
- **Source:** https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## Options I checked and rejected

| Option | Why not |
|---|---|
| Render free web service + free Postgres | Web services sleep after 15 minutes without traffic, which would drop the Discord gateway connection and delay reminders. Free Postgres databases expire after 30 days. https://render.com/docs/free |
| Fly.io | No free allowance for new customers; usage is billed. https://fly.io/docs/about/pricing/ |
| Koyeb | Requires a credit card on file for its free instance. https://www.koyeb.com/pricing |
| Cloudflare Workers (free) | 10 ms CPU per request on the free plan, and no long-lived gateway connection. A Discord bot that moves members into voice channels needs a persistent gateway session. https://developers.cloudflare.com/workers/platform/limits/ |
| Google Cloud free e2-micro | Free in some US regions. A workable alternative, but needs billing enabled with a card, and 1 GB RAM is tight. https://cloud.google.com/free/docs/free-cloud-features#compute |

## Why one process and SQLite

- **Gateway for voice:** the bot needs a persistent Discord gateway connection, for voice states and moving members. That rules out serverless free tiers.
- **Nothing to sleep or expire:** with one process and one SQLite file, nothing can expire or sleep, and backups are a file copy.
- **Enough capacity:** WAL-mode SQLite comfortably handles community-sized load (hundreds of players, dozens of concurrent matches).

## Things that could cost money (all optional)

- **A custom domain:** roughly $10/year from any registrar.
- **A VPS host instead of your own machine:** if you choose a paid one.
- **Private repository:** making the repository private on GitHub Free means GitHub Pages is no longer free. Keep it public, which is safe because it holds no secrets.
