/* sonor-sitelog.js v1.1.0 (2026-11-25) — the ONE long-term site log for every Sonor site agent (Network Scanner, IR & RF Capture,
 * Remotes, Site Rig). Bryn: "we also need long term logging for troubleshooting" · "we dont need it running non stop for every project,
 * only usually on site or occasionally long term for fixing something on a trouble site" · "but we do need max features for ultimate
 * troubleshooting across the suite". Contract agreed with the IR & RF thread, recorded in CROSS-APP-CONTRACTS.md.
 *
 * OFF by default: write() does nothing until a session is armed; alert() always lands in an in-memory ring (live view) and, when
 * armed, in the file too.
 *   session  start({ name, project_id?, spot?, mode: 'site' | 'watch', days?, until?, keep? }) · stop() · status()
 *            site  = on site today, stops by itself after 12 h · watch = a trouble site left logging for 1 / 3 / 7 / 14 / 30 days
 *            state in <dir>/session.json, so a watch survives a reboot; size cap (default 2 GB) stops the session with an alert
 *   files    <dir>/<session-id>/YYYY-MM-DD.jsonl (agent's local date), one JSON object per line; sessions pruned 30 days after they
 *            end unless keep: true; logs never leave site
 *   line     { t: ISO, app: 'scanner' | 'ir-rf' | 'remotes' | 'site-rig' | 'artnet', kind, tool?, src?, ...fields }
 *   kind     packet · burst · minute (1-minute summary) · alert (level, text, rule) · source (node / probe / capture online, offline, moved)
 *   HTTP     GET  /api/log?from=&to=&q=&kind=&tool=&app=&src=&session=&limit= → { lines, days, bytes, session } (newest last)
 *            GET  /api/log/session → status() · POST /api/log/session { action: 'start' | 'stop', ... } · GET /api/log/sessions
 *            GET  /api/log/alerts → the live alert ring · GET /api/log/download?session=<id>[&day=YYYY-MM-DD][&gz=1]
 * Workspace master: ~/Code/Sonor/sonor-sitelog.js → sync-everything.sh copies it to each agent's lib/sitelog.js. Never hand-edit a copy.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const VERSION = '1.1.0';
const KINDS = ['packet', 'burst', 'minute', 'alert', 'source'];
const WATCH_DAYS = [1, 3, 7, 14, 30];
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const stamp = (d) => { d = new Date(d); return `${dayOf(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`; };

function create({ dir, app, keepDays = 30, maxBytes = 2 * 1024 ** 3, siteHours = 12 } = {}) {
  if (!dir) throw new Error('sitelog: dir required');
  fs.mkdirSync(dir, { recursive: true });
  const sessFile = path.join(dir, 'session.json'); const ring = []; const listeners = new Set();
  let queue = Promise.resolve(); let lastPrune = 0; let sess = null; let bytes = 0, lines = 0;
  try { sess = JSON.parse(fs.readFileSync(sessFile, 'utf8')); if (!sess || !sess.on) sess = null; } catch { sess = null; }
  const sdir = (id) => path.join(dir, id);
  const meta = (id) => { try { return JSON.parse(fs.readFileSync(path.join(sdir(id), 'session.json'), 'utf8')); } catch { return null; } };
  const saveMeta = (m) => { try { fs.mkdirSync(sdir(m.id), { recursive: true }); fs.writeFileSync(path.join(sdir(m.id), 'session.json'), JSON.stringify(m, null, 1)); } catch { /* read-only */ } };
  const saveSess = () => { try { fs.writeFileSync(sessFile, JSON.stringify(sess || { on: false })); } catch { /* read-only */ } };
  const daysIn = (id) => { try { return fs.readdirSync(sdir(id)).filter((f) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort(); } catch { return []; } };
  const sizeOf = (id) => daysIn(id).reduce((a, d) => { try { return a + fs.statSync(path.join(sdir(id), d + '.jsonl')).size; } catch { return a; } }, 0);
  if (sess) { bytes = sizeOf(sess.id); lines = sess.lines || 0; }

  function sessions() { let ids = []; try { ids = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isDirectory()); } catch { /* none */ }
    return ids.map((id) => { const m = meta(id) || { id }; return { ...m, on: !!(sess && sess.id === id), bytes: sizeOf(id), days: daysIn(id) }; }).sort((a, b) => String(b.started || '').localeCompare(String(a.started || ''))); }
  function prune() { lastPrune = Date.now(); const cut = Date.now() - keepDays * 86400000;
    for (const s of sessions()) if (!s.on && !s.keep && s.ended && Date.parse(s.ended) < cut) { try { fs.rmSync(sdir(s.id), { recursive: true, force: true }); } catch { /* keep going */ } } }
  function status() { expire(); return sess ? { on: true, id: sess.id, name: sess.name, mode: sess.mode, project_id: sess.project_id || null, spot: sess.spot || null, started: sess.started, until: sess.until, bytes, lines, maxBytes, app } : { on: false, app, watchDays: WATCH_DAYS, siteHours }; }
  function start({ name, project_id, spot, mode = 'site', days, until, keep = false } = {}) {
    if (sess) stop('replaced by a new session');
    mode = mode === 'watch' ? 'watch' : 'site'; const now = Date.now();
    const end = until ? Date.parse(until) : mode === 'site' ? now + siteHours * 3600000 : now + (WATCH_DAYS.includes(Number(days)) ? Number(days) : 7) * 86400000;
    const id = `${stamp(now)}_${String(name || mode).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || mode}`;
    sess = { on: true, id, name: name || (mode === 'site' ? 'Site visit' : 'Trouble watch'), mode, project_id: project_id || null, spot: spot || null, started: new Date(now).toISOString(), until: new Date(end).toISOString(), keep: !!keep, lines: 0, app };
    bytes = 0; lines = 0; saveSess(); saveMeta({ ...sess }); write('source', { tool: 'log', src: 'agent', state: 'session started', session: sess.name, mode, until: sess.until }); return status(); }
  function stop(why = 'stopped') { if (!sess) return status(); write('source', { tool: 'log', src: 'agent', state: 'session ended', why });
    const m = { ...(meta(sess.id) || sess), on: false, ended: new Date().toISOString(), why, lines, bytes }; saveMeta(m); sess = null; saveSess(); return status(); }
  function expire() { if (sess && sess.until && Date.now() > Date.parse(sess.until)) stop(sess.mode === 'site' ? `site session ended after ${siteHours} h` : 'watch period over'); }
  function write(kind, obj = {}) {
    if (!KINDS.includes(kind)) throw new Error('sitelog: kind must be ' + KINDS.join(' | '));
    const line = { t: new Date().toISOString(), app, kind, ...obj };
    if (kind === 'alert') { ring.push(line); if (ring.length > 500) ring.shift(); for (const f of listeners) try { f(line); } catch { /* listener */ } }
    if (!sess) return null; expire(); if (!sess) return null;
    const s = JSON.stringify(line) + '\n'; const f = path.join(sdir(sess.id), dayOf(line.t) + '.jsonl'); bytes += s.length; lines += 1; sess.lines = lines;
    queue = queue.then(() => fs.promises.appendFile(f, s)).catch(() => {});
    if (lines % 500 === 0) saveSess();
    if (bytes > maxBytes) { const cap = Math.round(maxBytes / 1024 ** 2); ring.push({ ...line, kind: 'alert', level: 'bad', tool: 'log', text: `Log session stopped: it reached the ${cap} MB size cap` }); stop(`size cap ${cap} MB`); }
    if (Date.now() - lastPrune > 3600000) prune();
    return line;
  }
  const alert = (obj) => write('alert', { level: 'warn', ...obj });
  function query({ from, to, q, kind, tool, src, app: a, session, limit = 2000 } = {}) {
    const t0 = from ? new Date(isNaN(from) ? from : Number(from)).getTime() : Date.now() - 86400000; const t1 = to ? new Date(isNaN(to) ? to : Number(to)).getTime() : Date.now();
    const set = (v) => (v ? new Set(String(v).split(',').map((x) => x.trim()).filter(Boolean)) : null); const K = set(kind), T = set(tool), S = set(src), A = set(a);
    const needle = q ? String(q).toLowerCase() : ''; const out = []; let read = 0; limit = Math.min(20000, Number(limit) || 2000);
    const ids = session ? [String(session)] : sessions().map((s) => s.id);
    for (const id of ids) for (const d of daysIn(id).filter((x) => x >= dayOf(t0) && x <= dayOf(t1))) {
      let txt = ''; try { txt = fs.readFileSync(path.join(sdir(id), d + '.jsonl'), 'utf8'); } catch { continue; } read += txt.length;
      for (const ln of txt.split('\n')) { if (!ln) continue; if (needle && !ln.toLowerCase().includes(needle)) continue; let o; try { o = JSON.parse(ln); } catch { continue; }
        const t = Date.parse(o.t); if (t < t0 || t > t1) continue; if (K && !K.has(o.kind)) continue; if (T && !T.has(o.tool)) continue; if (S && !S.has(o.src)) continue; if (A && !A.has(o.app)) continue;
        o.session = id; out.push(o); } }
    out.sort((x, y) => (x.t < y.t ? -1 : 1));
    return { lines: out.slice(-limit), total: out.length, bytes: read, session: status() };
  }
  const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } }); });
  const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
  // http helper: returns true when it answered the request
  function handle(req, res, url) {
    const p = url.pathname; const qs = Object.fromEntries(url.searchParams);
    if (p === '/api/log') { json(res, 200, query(qs)); return true; }
    if (p === '/api/log/alerts') { json(res, 200, { alerts: ring.slice(-Number(qs.limit || 200)), session: status() }); return true; }
    if (p === '/api/log/sessions') { json(res, 200, { sessions: sessions(), session: status() }); return true; }
    if (p === '/api/log/session') {
      if (req.method !== 'POST') { json(res, 200, status()); return true; }
      readBody(req).then((b) => json(res, 200, b.action === 'stop' ? stop(b.why || 'stopped by hand') : b.action === 'start' ? start(b) : b.action === 'keep' ? (() => { const m = meta(b.id); if (m) { m.keep = !!b.keep; saveMeta(m); } return status(); })() : status())); return true; }
    if (p === '/api/log/download') { const id = String(qs.session || (sess && sess.id) || ''); if (!/^[\w-]+$/.test(id) || !fs.existsSync(sdir(id))) { res.writeHead(404); res.end('no such session'); return true; }
      const ds = qs.day ? daysIn(id).filter((d) => d === qs.day) : daysIn(id); const body = Buffer.concat(ds.map((d) => { try { return fs.readFileSync(path.join(sdir(id), d + '.jsonl')); } catch { return Buffer.alloc(0); } }));
      const gz = qs.gz === '1'; res.writeHead(200, { 'Content-Type': gz ? 'application/gzip' : 'application/x-ndjson', 'Content-Disposition': `attachment; filename="sonor-${app}-${id}${qs.day ? '-' + qs.day : ''}.jsonl${gz ? '.gz' : ''}"` }); res.end(gz ? zlib.gzipSync(body) : body); return true; }
    return false;
  }
  prune();
  return { write, alert, query, start, stop, status, sessions, prune, handle, onAlert: (f) => { listeners.add(f); return () => listeners.delete(f); }, alerts: () => ring.slice(), dir, flush: () => queue, get on() { return !!status().on; } };
}

module.exports = { create, KINDS, WATCH_DAYS, dayOf, VERSION };
