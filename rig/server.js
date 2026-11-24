#!/usr/bin/env node
'use strict';
// Sonor Site Rig home page (port 80 on the Pi): what's running, how the rig is connected, links to each tool, Update.
// Node built-ins only. The tablet reaches it at http://10.77.0.1 on the rig's hotspot.
const http = require('http');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { execFile } = require('child_process');
const PORT = Number(process.env.PORT || 80);
const CFG = process.env.RIG_CONFIG || '/etc/sonor-rig/config.json';
const VERSION = process.env.RIG_VERSION || 'dev';
const TOOLS = [
  { id: 'scanner', name: 'Network Scanner', port: 8050, unit: 'sonor-rig-scanner', about: 'Every device on the site network, checked against Network Map' },
  { id: 'remotes', name: 'Remotes', port: 8049, unit: 'sonor-rig-remotes', about: 'TVs, receivers, Sky boxes and projectors, with a remote for each' },
];
const run = (c, a) => new Promise((r) => execFile(c, a, { timeout: 4000 }, (e, o) => r(e ? '' : String(o).trim())));
const portUp = (p) => new Promise((r) => { const s = net.connect({ host: '127.0.0.1', port: p }); const t = setTimeout(() => { s.destroy(); r(false); }, 600); s.on('connect', () => { clearTimeout(t); s.destroy(); r(true); }); s.on('error', () => { clearTimeout(t); r(false); }); });
async function status() {
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch {}
  const ifs = os.networkInterfaces(); const v4 = (n) => ((ifs[n] || []).find((a) => a.family === 'IPv4' || a.family === 4) || {}).address || null;
  const temp = (() => { try { return Math.round(Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 100) / 10; } catch { return null; } })();
  const clients = (await run('sh', ['-c', "ip neigh show dev wlan0 2>/dev/null | grep -c REACHABLE"])) || '0';
  const internet = await new Promise((r) => { const s = net.connect({ host: '1.1.1.1', port: 443 }); const t0 = Date.now(); const t = setTimeout(() => { s.destroy(); r(null); }, 2500); s.on('connect', () => { clearTimeout(t); s.destroy(); r(Date.now() - t0); }); s.on('error', () => { clearTimeout(t); r(null); }); });
  const tools = await Promise.all(TOOLS.map(async (t) => ({ ...t, up: await portUp(t.port) })));
  return { version: VERSION, name: cfg.name || os.hostname(), ssid: cfg.ssid || '', hostname: os.hostname(), lan: v4('eth0'), ap: v4('wlan0'), clients: Number(clients), temp, uptime: Math.round(os.uptime()), internetMs: internet, tools };
}
const page = (s, host) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${s.name} · Sonor Site Rig</title><meta name="theme-color" content="#1C1C1E"><style>
:root{--bg:#1C1C1E;--card:#242426;--card2:#2C2C2E;--edge:#3A3A3C;--text:#F5F5F7;--label:#8E8E93;--gold:#ad9978;--ok:#2fbf71;--bad:#e5484d;--warn:#e3a72f;--mono:"DM Mono",ui-monospace,Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,#2a2724 0,transparent 60%),var(--bg);color:var(--text);font:15px/1.45 "DM Sans",system-ui,sans-serif;min-height:100vh}
header{display:flex;align-items:center;gap:14px;padding:22px 24px;border-bottom:1px solid var(--edge)}header b{letter-spacing:.32em;font-weight:600}header span{font-family:var(--mono);font-size:11px;letter-spacing:.2em;color:var(--gold);text-transform:uppercase;border-left:1px solid var(--edge);padding-left:14px}
header i{margin-left:auto;font:11px var(--mono);color:var(--label);font-style:normal}
main{max-width:980px;margin:0 auto;padding:20px}.lbl{font:500 10.5px var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--label)}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:12px 0 22px}.stats div{background:var(--card);border:1px solid var(--edge);border-left:4px solid var(--c,var(--edge));border-radius:6px;padding:9px 12px}.stats b{display:block;font:500 17px var(--mono)}
.tools{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-top:10px}
a.tool{display:flex;gap:14px;align-items:center;text-decoration:none;color:inherit;background:linear-gradient(160deg,#2c2a27,#222);border:1px solid #4a4339;border-radius:14px;padding:16px}
a.tool:hover{border-color:var(--gold)}a.tool .ic{width:56px;height:56px;border-radius:14px;background:#191919;border:1px solid #5a503f;display:grid;place-items:center;font:600 15px var(--mono);color:var(--gold);letter-spacing:.08em}
a.tool .n{font-weight:600;font-size:16px}a.tool .a{color:var(--label);font-size:12.5px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--c)}
button{font:11px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--text);background:var(--card2);border:1px solid var(--edge);border-radius:4px;padding:9px 14px;cursor:pointer}
footer{margin-top:26px;color:var(--label);font-size:12.5px}code{font-family:var(--mono)}
</style></head><body><header><svg width="30" height="30" viewBox="0 0 96 96"><g fill="#ad9978"><path d="M92.02,38.41v51.4c0,2.63-2.13,4.75-4.75,4.75h-3.34c-2.62,0-4.75-2.12-4.75-4.75v-45.34c0-2.45-1.11-4.77-3.01-6.31l-25.23-20.41c-2.8-2.27-6.76-2.42-9.73-.36l-23.15,16.05.45,1.55c22.38,9.5,40.47,30.05,47.71,53.39.95,3.06-1.32,6.18-4.53,6.18h-5.36c-2.08,0-3.9-1.37-4.54-3.35-6.96-21.83-24.83-38.23-46.17-46.13-1.31-.49-2.31-1.5-2.79-2.75-.2-.51-.31-1.06-.32-1.64l-.12-9.11c-.02-1.58.75-3.06,2.05-3.96L28.74,10.74,42.11,1.45c.16-.11.32-.22.49-.31,2.35-1.4,5.22-1.5,7.64-.34.57.26,1.12.61,1.63,1.03l37.16,30.29c1.89,1.54,2.99,3.85,2.99,6.29Z"/><path d="M34.59,94.55h-5.25c-1.6,0-3.09-.81-3.97-2.15-5.47-8.37-11.98-15.35-20.72-20.32-1.5-.85-2.45-2.42-2.45-4.15v-5.58c0-3.52,3.68-5.79,6.85-4.26,12.79,6.15,23.95,16.91,29.85,29.73,1.45,3.14-.86,6.73-4.32,6.73h0Z"/><path d="M4.26,83.39c7.65-1.71,9.39,9.06,4.03,10.83-8.9,2.94-11.25-9.22-4.03-10.83Z"/></g></svg><b>SONOR</b><span>Site Rig</span><i>${s.name} · v${s.version}</i></header>
<main><div class="lbl">Rig</div><div class="stats">
<div style="--c:${s.lan ? 'var(--ok)' : 'var(--bad)'}"><span class="lbl">Site LAN (eth0)</span><b>${s.lan || 'not plugged in'}</b></div>
<div style="--c:${s.internetMs != null ? 'var(--ok)' : 'var(--warn)'}"><span class="lbl">Internet</span><b>${s.internetMs != null ? s.internetMs + ' ms' : 'offline'}</b></div>
<div style="--c:var(--gold)"><span class="lbl">Hotspot</span><b>${s.ssid || '—'}</b></div>
<div><span class="lbl">Tablets connected</span><b>${s.clients}</b></div>
<div style="--c:${s.temp > 75 ? 'var(--bad)' : 'var(--edge)'}"><span class="lbl">CPU temp</span><b>${s.temp != null ? s.temp + ' °C' : '—'}</b></div>
<div><span class="lbl">Up</span><b>${Math.floor(s.uptime / 3600)} h ${Math.floor(s.uptime / 60) % 60} m</b></div></div>
<div class="lbl">Tools</div><div class="tools">${s.tools.map((t) => `<a class="tool" href="http://${host}:${t.port}/"><span class="ic">${t.id === 'scanner' ? 'NS' : 'RM'}</span><span><span class="n">${t.name}</span><br><span class="a"><span class="dot" style="--c:${t.up ? 'var(--ok)' : 'var(--bad)'}"></span>${t.up ? 'running' : 'not running'} · :${t.port}</span><br><span class="a">${t.about}</span></span></a>`).join('')}</div>
<footer><button id="upd">Update the rig</button> <span id="us"></span><p>Plug the rig's Ethernet into the site switch, join <b>${s.ssid}</b> on the tablet, open <code>http://10.77.0.1</code>. Updating needs internet on the site LAN and takes a couple of minutes.</p></footer></main>
<script>document.getElementById('upd').onclick=async(e)=>{e.target.disabled=true;document.getElementById('us').textContent='Updating… the page comes back in about two minutes.';try{await fetch('/api/update',{method:'POST'})}catch{}setTimeout(()=>location.reload(),120000)};</script></body></html>`;
module.exports = { page, status, TOOLS };
if (require.main === module) http.createServer(async (req, res) => {
  const host = (req.headers.host || '10.77.0.1').replace(/:\d+$/, '');
  if (req.url === '/api/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(await status())); }
  if (req.url === '/api/update' && req.method === 'POST') { execFile('sudo', ['-n', '/usr/local/bin/sonor-rig-update'], () => {}); res.writeHead(202); return res.end('{"started":true}'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page(await status(), host));
}).listen(PORT, '0.0.0.0', () => console.log(`Sonor Site Rig home on :${PORT}`));
