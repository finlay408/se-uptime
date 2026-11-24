// Renders the public status page from the monitor's state. Names only, no URLs.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function sparkline(samples, now) {
  const W = 600;
  const H = 48;
  const pts = samples.filter(([t]) => now - t <= 86400000);
  if (pts.length < 2) return `<p class="muted small">Response times appear after a few checks.</p>`;
  const max = Math.max(500, ...pts.map(([, ms]) => ms ?? 0));
  const x = (t) => ((t - (now - 86400000)) / 86400000) * W;
  const y = (ms) => H - 4 - (ms / max) * (H - 8);
  let d = "";
  let pen = false;
  const downs = [];
  for (const [t, ms] of pts) {
    if (ms === null) {
      downs.push(`<rect x="${x(t).toFixed(1)}" y="0" width="3" height="${H}" class="down-bar"/>`);
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x(t).toFixed(1)},${y(ms).toFixed(1)}`;
    pen = true;
  }
  const ok = pts.filter(([, ms]) => ms !== null).map(([, ms]) => ms);
  const avg = ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark" role="img" aria-label="Response time over the last 24 hours${avg ? `, average ${avg} milliseconds` : ""}">${downs.join("")}<path d="${d}" class="line"/></svg>
  <div class="axis small muted"><span>24 hours ago</span><span>${avg ? `avg ${avg}ms · peak ${Math.max(...ok)}ms` : ""}</span><span>now</span></div>`;
}

function dayStrip(mon, now, { dayKey, pct }) {
  const cells = [];
  for (let i = 89; i >= 0; i--) {
    const key = dayKey(now - i * 86400000);
    const d = mon.days?.[key];
    let cls = "none";
    let label = `${key}: no data`;
    if (d) {
      const u = d.up / d.n;
      cls = u === 1 ? "good" : u >= 0.99 ? "warn" : "bad";
      label = `${key}: ${pct(u)} up`;
    }
    cells.push(`<i class="${cls}" title="${label}"></i>`);
  }
  return `<div class="strip" aria-label="Daily uptime for the last 90 days">${cells.join("")}</div>
  <div class="axis small muted"><span>90 days ago</span><span>today</span></div>`;
}

export function renderPage({ state, config, now, uptime, pct, dayKey, duration, clock }) {
  const mons = config.monitors.map((m) => ({ m, mon: state.monitors[m.id] })).filter((x) => x.mon);
  const down = mons.filter(({ mon }) => mon.status === "down");
  const headline = down.length
    ? `${down.map(({ m }) => esc(m.name)).join(" and ")} ${down.length > 1 ? "are" : "is"} down`
    : "Everything is up";

  const cards = mons
    .map(({ m, mon }) => {
      const isDown = mon.status === "down";
      const windows = [1, 7, 30, 90].map((d) => `<div><b>${pct(uptime(mon, d, now))}</b><span class="small muted">${d === 1 ? "24 hours" : `${d} days`}</span></div>`).join("");
      return `<section class="card">
  <header><span class="dot ${isDown ? "bad" : "good"}"></span><h2>${esc(m.name)}</h2>
  <span class="small muted">${isDown ? `down for ${duration(now - mon.since)}: ${esc(mon.reason)}` : `up for ${duration(now - mon.since)}`}</span></header>
  <div class="windows">${windows}</div>
  ${dayStrip(mon, now, { dayKey, pct })}
  ${sparkline(mon.samples ?? [], now)}
</section>`;
    })
    .join("\n");

  const incidents = (state.incidents ?? []).slice(0, 15);
  const incidentRows = incidents.length
    ? incidents
        .map((i) => {
          const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" }).format(i.start);
          return `<li><span class="dot ${i.end ? "good" : "bad"}"></span><b>${esc(i.name)}</b> <span class="muted">${date}, ${clock(i.start)}${i.end ? ` for ${duration(i.end - i.start)}` : ", ongoing"}</span><br><span class="small muted">${esc(i.reason)}</span></li>`;
        })
        .join("")
    : `<li class="muted">No outages recorded yet.</li>`;

  const certDays = Object.values(state.certs ?? {}).map((c) => c.expires && Math.floor((c.expires - now) / 86400000)).filter((x) => x != null);
  const domDays = Object.values(state.domains ?? {}).map((c) => c.expires && Math.floor((c.expires - now) / 86400000)).filter((x) => x != null);
  const updated = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" }).format(now);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300"><meta name="robots" content="noindex">
<title>Soon Erased status</title>
<style>
:root{--bg:#f6f4ef;--card:#fff;--ink:#161512;--muted:#6f6b63;--line:#e4e0d7;--good:#2f9e5b;--warn:#d9a21b;--bad:#d2442f;--none:#e4e0d7}
@media (prefers-color-scheme:dark){:root{--bg:#121110;--card:#1b1a18;--ink:#f1eee7;--muted:#9a958b;--line:#2d2b27;--none:#2d2b27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:28px;line-height:1.15;margin:0 0 6px;letter-spacing:-.01em}h2{font-size:17px;margin:0}
.lede{display:flex;align-items:flex-start;gap:12px;margin-bottom:28px}.lede .dot{width:14px;height:14px;margin-top:11px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
.card header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}.card header .small{margin-left:auto}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;flex:none}.dot.good{background:var(--good)}.dot.bad{background:var(--bad)}
.windows{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}.windows div{display:flex;flex-direction:column}.windows b{font-size:18px;font-variant-numeric:tabular-nums}
.strip{display:grid;grid-template-columns:repeat(90,1fr);gap:2px;height:28px}.strip i{border-radius:2px;background:var(--none)}
.strip .good{background:var(--good)}.strip .warn{background:var(--warn)}.strip .bad{background:var(--bad)}
.axis{display:flex;justify-content:space-between;margin:4px 0 14px}
.spark{width:100%;height:48px;display:block}.spark .line{fill:none;stroke:var(--ink);stroke-width:1.5;vector-effect:non-scaling-stroke}.spark .down-bar{fill:var(--bad);opacity:.5}
.muted{color:var(--muted)}.small{font-size:13px}
ul{list-style:none;padding:0;margin:0}li{padding:10px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}li .dot{margin-right:6px}
footer{margin-top:28px}
@media (max-width:520px){.windows b{font-size:16px}.card header .small{margin-left:0;width:100%}}
</style></head>
<body><main>
<div class="lede"><span class="dot ${down.length ? "bad" : "good"}"></span><div><h1>${headline}</h1><div class="muted small">Soon Erased status · updated ${updated}</div></div></div>
${cards}
<section class="card"><h2 style="margin-bottom:8px">Recent outages</h2><ul>${incidentRows}</ul></section>
<footer class="small muted">Checked every 5 minutes. A page counts as down when it errors, times out, or loads without the content it should show, confirmed by a second check.${certDays.length ? ` SSL certificate good for ${Math.min(...certDays)} more days.` : ""}${domDays.length ? ` Domain registered for ${Math.min(...domDays)} more days.` : ""}</footer>
</main></body></html>`;
}
