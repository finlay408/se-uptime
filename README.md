# se-uptime

Soon Erased's own uptime monitor. It does the UptimeRobot job for free on GitHub Actions and sends alerts to Telegram.

- Checks the website, /gallery and the OS every 5 minutes (`monitors.json`).
- A page counts as down if it errors, times out, or loads without its keyword. That catches a broken page that still returns 200.
- A failure is checked a second time before you're told.
- Telegram messages: down, still down (hourly), back up with how long it was out, SSL certificate or domain expiring, and a morning summary at 08:00. If the summary stops arriving, the monitor itself has stopped.
- Status page with uptime for 24h/7d/30d/90d, a 90-day bar, response times and recent outages, served by GitHub Pages.

## One-time setup

1. Create a **public** GitHub repo called `se-uptime` (public repos get unlimited free Actions minutes) and push this folder to it.
2. Settings → Secrets and variables → Actions → add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Use the same bot the agents use. In Telegram, @BotFather → /mybots → your bot → API Token shows the token without revoking it.
3. Actions tab → Uptime → Run workflow. You get a "monitor is on" message.
4. Settings → Pages → Deploy from branch → `gh-pages` / root. The page appears at `https://<you>.github.io/se-uptime/`.

## Locally

```
node monitor.mjs              # one round of checks; without the Telegram env vars, alerts print instead
node monitor.mjs --test-alert # needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID set
```

Add or change a page in `monitors.json`: `id`, `name`, `url`, `keyword`.
