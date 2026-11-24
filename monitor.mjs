// Soon Erased uptime monitor. One run = one round of checks.
//
//   node monitor.mjs               check everything, alert on changes, write data/
//   node monitor.mjs --test-alert  send a test message to Telegram and stop
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (without them alerts print to the
// console), STATUS_URL (link in messages), DATA_DIR (default ./data),
// MONITORS_FILE (default ./monitors.json), CONFIRM_MS (wait before the retry
// that confirms an outage, default 20000).
//
// What it does, per page: fetch it, follow redirects, time it, and check both
// the HTTP status and a keyword that only renders when the app works. A
// failure is re-checked once before anyone is told, so a single blip does
// not wake you. Down, still-down (hourly) and back-up all go to Telegram.
// Once a day it also checks SSL certificates and the domain's expiry date,
// and sends a short morning summary, which doubles as proof the monitor
// itself is still running.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { renderPage } from "./page.mjs";

const TZ = "Europe/London";
const DATA = process.env.DATA_DIR || "data";
const CONFIRM_MS = Number(process.env.CONFIRM_MS ?? 20000);
const REMIND_MS = 60 * 60 * 1000; // repeat "still down" every hour
const PUBLISH_EVERY_MS = 30 * 60 * 1000; // refresh the status page at least this often
const DIGEST_HOUR = 8; // London time
const SAMPLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAYS_KEPT = 90;
const CERT_WARN_DAYS = [14, 7, 3, 1];
const DOMAIN_WARN_DAYS = [60, 30, 14, 7, 1];
const STATUS_URL = process.env.STATUS_URL || "";

const configPath = process.env.MONITORS_FILE || new URL("./monitors.json", import.meta.url);
const config = JSON.parse(await readFile(configPath, "utf8"));
const statePath = path.join(DATA, "state.json");
let telegramFailed = false;

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const dayKey = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(t); // YYYY-MM-DD
const londonHour = (t) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(t));
const clock = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(t);
const daysUntil = (t, now) => Math.floor((t - now) / 86400000);

export function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)} days`;
}

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  const body = STATUS_URL ? `${text}\n\n<a href="${STATUS_URL}">Status page</a>` : text;
  if (!token || !chat) {
    console.log(`\n[telegram not configured, would send]\n${body}\n`);
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: body, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    console.log(`telegram sent: ${text.split("\n")[0]}`);
  } catch (e) {
    telegramFailed = true;
    console.error(`Telegram send failed: ${e.message}`);
  }
}

// ---------- checks ----------

async function probe(m) {
  const started = performance.now();
  const timeout = m.timeoutMs ?? 15000;
  try {
    const res = await fetch(m.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
      headers: { "user-agent": "se-uptime/1.0", "cache-control": "no-cache" },
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - started);
    if (!res.ok) return { ok: false, ms, code: res.status, reason: `HTTP ${res.status}` };
    if (m.keyword && !text.includes(m.keyword)) {
      return { ok: false, ms, code: res.status, reason: `the page loads but "${m.keyword}" is missing` };
    }
    return { ok: true, ms, code: res.status };
  } catch (e) {
    const reason =
      e.name === "TimeoutError" ? `no answer within ${timeout / 1000}s` : (e.cause?.code ?? e.cause?.message ?? e.message);
    return { ok: false, ms: null, code: null, reason };
  }
}

async function check(m) {
  const first = await probe(m);
  if (first.ok) return first;
  await sleep(CONFIRM_MS);
  const second = await probe(m);
  return second.ok ? { ...second, blip: first.reason } : second;
}

function certExpiry(host) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 15000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert?.valid_to ? Date.parse(cert.valid_to) : null);
    });
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

async function domainExpiry(domain) {
  try {
    // rdap.org refuses Node's default user agent with a 403
    const res = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: { accept: "application/rdap+json", "user-agent": "se-uptime/1.0 (uptime monitor)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const ev = (json.events ?? []).find((e) => e.eventAction === "expiration");
    return ev ? Date.parse(ev.eventDate) : null;
  } catch {
    return null;
  }
}

// Returns the threshold just crossed (e.g. 7) or null; remembers it so each fires once.
function crossed(daysLeft, thresholds, lastWarned) {
  const hit = thresholds.filter((d) => daysLeft <= d).sort((a, b) => a - b)[0];
  if (hit === undefined) return { hit: null, warned: null }; // renewed: reset
  return { hit: hit !== lastWarned ? hit : null, warned: hit };
}

// ---------- uptime maths ----------

export function uptime(mon, days, now) {
  if (days === 1) {
    const recent = (mon.samples ?? []).filter(([t]) => now - t <= SAMPLE_WINDOW_MS);
    if (!recent.length) return null;
    return recent.filter(([, ms]) => ms !== null).length / recent.length;
  }
  let n = 0;
  let up = 0;
  for (let i = 0; i < days; i++) {
    const d = mon.days?.[dayKey(now - i * 86400000)];
    if (d) {
      n += d.n;
      up += d.up;
    }
  }
  return n ? up / n : null;
}

const pct = (u) => (u === null ? "n/a" : `${(Math.floor(u * 10000) / 100).toFixed(u === 1 ? 0 : 2)}%`);

// ---------- main ----------

if (process.argv.includes("--test-alert")) {
  await telegram(`✅ <b>Soon Erased monitor</b>\nTest message. If you can read this, outage alerts will reach you here.`);
  process.exit(telegramFailed ? 1 : 0);
}

await mkdir(DATA, { recursive: true });
const state = existsSync(statePath)
  ? JSON.parse(await readFile(statePath, "utf8"))
  : { monitors: {}, incidents: [], certs: {}, domains: {}, lastDigest: null, lastPublish: 0, started: Date.now() };

const now = Date.now();
const today = dayKey(now);
let changed = false;
const firstRun = Object.keys(state.monitors).length === 0;

const results = await Promise.all(config.monitors.map(async (m) => [m, await check(m)]));

for (const [m, r] of results) {
  const mon = (state.monitors[m.id] ??= { status: "new", since: now, days: {}, samples: [] });
  mon.name = m.name;
  mon.lastCheck = now;
  mon.lastMs = r.ms;
  mon.lastCode = r.code;
  mon.reason = r.ok ? null : r.reason;

  const d = (mon.days[today] ??= { n: 0, up: 0, ms: 0, msN: 0 });
  d.n++;
  if (r.ok) {
    d.up++;
    d.ms += r.ms;
    d.msN++;
  }
  mon.samples.push([now, r.ok ? r.ms : null]);
  mon.samples = mon.samples.filter(([t]) => now - t <= SAMPLE_WINDOW_MS);
  for (const k of Object.keys(mon.days)) if (now - Date.parse(k) > DAYS_KEPT * 86400000) delete mon.days[k];

  console.log(`${r.ok ? "UP  " : "DOWN"} ${m.name.padEnd(10)} ${r.code ?? "---"} ${r.ms ?? "-"}ms ${r.reason ?? ""}${r.blip ? ` (blip: ${r.blip})` : ""}`);

  if (!r.ok && mon.status !== "down") {
    mon.status = "down";
    mon.since = now;
    mon.lastReminder = now;
    state.incidents.unshift({ id: m.id, name: m.name, start: now, end: null, reason: r.reason });
    changed = true;
    await telegram(`🔴 <b>${esc(m.name)} is down</b>\n${esc(r.reason)}\nNoticed at ${clock(now)}. I'll tell you when it's back.`);
  } else if (!r.ok && mon.status === "down") {
    if (now - (mon.lastReminder ?? 0) >= REMIND_MS) {
      mon.lastReminder = now;
      await telegram(`🔴 <b>${esc(m.name)} is still down</b> (${duration(now - mon.since)})\n${esc(r.reason)}`);
    }
  } else if (r.ok && mon.status === "down") {
    const inc = state.incidents.find((i) => i.id === m.id && !i.end);
    if (inc) inc.end = now;
    await telegram(`🟢 <b>${esc(m.name)} is back up</b> after ${duration(now - mon.since)}.\nResponding in ${r.ms}ms.`);
    mon.status = "up";
    mon.since = now;
    changed = true;
  } else if (mon.status === "new") {
    mon.status = "up";
    mon.since = now;
    changed = true;
  }
}
state.incidents = state.incidents.slice(0, 100);

// Once a day: certificates and domain expiry.
if (state.lastExpiryCheck !== today) {
  state.lastExpiryCheck = today;
  const hosts = [...new Set(config.monitors.map((m) => new URL(m.url).hostname))];
  for (const host of hosts) {
    const exp = await certExpiry(host);
    const c = (state.certs[host] ??= {});
    c.expires = exp;
    if (!exp) continue;
    const left = daysUntil(exp, now);
    const { hit, warned } = crossed(left, CERT_WARN_DAYS, c.warned);
    c.warned = warned;
    if (hit !== null) await telegram(`🟡 <b>SSL certificate for ${esc(host)}</b> expires in ${left} days.\nVercel normally renews it by itself; if this repeats, check the domain in Vercel.`);
  }
  for (const domain of config.domains ?? []) {
    const exp = await domainExpiry(domain);
    const c = (state.domains[domain] ??= {});
    if (exp) c.expires = exp;
    if (!c.expires) continue;
    const left = daysUntil(c.expires, now);
    const { hit, warned } = crossed(left, DOMAIN_WARN_DAYS, c.warned);
    c.warned = warned;
    if (hit !== null) await telegram(`🟡 <b>${esc(domain)}</b> expires in ${left} days. Renew it at the registrar (Squarespace) so the site and email don't stop.`);
  }
}

// First run: say hello. After that: one summary each morning.
if (firstRun) {
  state.lastDigest = londonHour(now) >= DIGEST_HOUR ? today : null;
  await telegram(`👋 <b>Soon Erased monitor is on</b>\nWatching ${config.monitors.map((m) => esc(m.name)).join(", ")} every 5 minutes. You'll get a message if one goes down, when it's back, and a short summary each morning.`);
} else if (state.lastDigest !== today && londonHour(now) >= DIGEST_HOUR) {
  state.lastDigest = today;
  const dayAgo = now - 86400000;
  const recent = state.incidents.filter((i) => (i.end ?? now) >= dayAgo);
  const lines = config.monitors.map((m) => {
    const mon = state.monitors[m.id];
    const s = (mon.samples ?? []).filter(([, ms]) => ms !== null);
    const avg = s.length ? Math.round(s.reduce((a, [, ms]) => a + ms, 0) / s.length) : null;
    return `${mon.status === "down" ? "🔴" : "🟢"} ${esc(m.name)}: ${pct(uptime(mon, 1, now))}${avg ? `, ${avg}ms avg` : ""}`;
  });
  const certDays = Object.values(state.certs).map((c) => c.expires && daysUntil(c.expires, now)).filter((x) => x != null);
  const domDays = Object.values(state.domains).map((c) => c.expires && daysUntil(c.expires, now)).filter((x) => x != null);
  const allUp = config.monitors.every((m) => state.monitors[m.id].status !== "down");
  await telegram(
    `${allUp ? "☀️" : "⚠️"} <b>Morning check</b>: ${allUp ? "everything is up" : "something is down"}\n` +
      `Last 24 hours:\n${lines.join("\n")}\n` +
      `${recent.length ? `${recent.length} outage${recent.length > 1 ? "s" : ""} in the last day.` : "No outages in the last day."}` +
      [certDays.length && `\nSSL certificate good for ${Math.min(...certDays)} more days.`, domDays.length && `\nDomain registered for ${Math.min(...domDays)} more days.`]
        .filter(Boolean)
        .join(""),
  );
}

// Status page.
await mkdir(path.join(DATA, "site"), { recursive: true });
await writeFile(path.join(DATA, "site", "index.html"), renderPage({ state, config, now, uptime, pct, dayKey, duration, clock }));
const publishFlag = path.join(DATA, ".publish");
if (changed || now - (state.lastPublish ?? 0) >= PUBLISH_EVERY_MS) {
  state.lastPublish = now;
  await writeFile(publishFlag, "1");
} else if (existsSync(publishFlag)) {
  await rm(publishFlag);
}

await writeFile(statePath, JSON.stringify(state, null, 1));
if (telegramFailed) {
  console.error("At least one alert did not reach Telegram.");
  process.exit(1);
}
