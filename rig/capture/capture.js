#!/usr/bin/env node
'use strict';
// Sonor Site Rig · HDMI capture agent (sonor-rig-capture, :8056). Node built-ins only.
// A USB HDMI capture dongle (or a TC358743 HDMI-to-CSI board) on the rig takes an output of the video matrix and the rig serves it as
// a camera: RTSP H.264 (main + sub) through mediamtx on :554, ONVIF Profile S + WS-Discovery so Hikvision / Dahua NVRs add it as a
// channel, the slice of Hikvision ISAPI the Sonor Control4 camera driver uses (+ SADP so "Find Cameras" lists it), WebRTC preview
// for the tablet, and a site log session (off by default) through the shared sonor-sitelog.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const P = require('./pipeline');
const ISAPI = require('./isapi');
const ONVIF = require('./onvif');
let Sitelog = null; try { Sitelog = require('../../lib/sitelog.js'); } catch { /* not synced yet: logging off */ }

const VERSION = process.env.RIG_VERSION || 'dev';
const PORT = Number(process.env.PORT || 8056);
const DATA = process.env.CAPTURE_DATA || '/var/lib/sonor-rig/capture';
const RIG_CFG = process.env.RIG_CONFIG || '/etc/sonor-rig/config.json';
const MEDIAMTX = process.env.MEDIAMTX || '/opt/sonor-rig/mediamtx/mediamtx';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const TEST_SOURCE = 'lavfi:testsrc2=size=1920x1080:rate=25';
const WWW = path.join(__dirname, 'www');
fs.mkdirSync(DATA, { recursive: true });
const log = Sitelog ? Sitelog.create({ dir: path.join(DATA, 'log'), app: 'site-rig' }) : null;
const lg = (kind, o) => { try { if (log) return log.write(kind, { tool: 'hdmi', ...o }); } catch { /* never let logging stop video */ } return null; };
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── settings (DATA/capture.json, created on first start; the login is made here, never typed) ──
const SET_FILE = path.join(DATA, 'capture.json');
const rigCfg = (() => { try { return JSON.parse(fs.readFileSync(RIG_CFG, 'utf8')); } catch { return {}; } })();
let set = (() => { try { return { ...P.DEFAULTS, ...JSON.parse(fs.readFileSync(SET_FILE, 'utf8')) }; } catch { return { ...P.DEFAULTS }; } })();
if (!set.pass) set.pass = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 10) + '7a';
if (!set.uuid) set.uuid = crypto.randomUUID();
if (set.name === P.DEFAULTS.name && rigCfg.name) set.name = `${rigCfg.name} HDMI`;
if (process.env.RTSP_PORT) set.rtspPort = +process.env.RTSP_PORT;
const saveSet = () => { try { fs.writeFileSync(SET_FILE, JSON.stringify(set, null, 1), { mode: 0o600 }); } catch (e) { say('settings not saved', e.message); } };
saveSet();
const secret = crypto.randomBytes(16).toString('hex');   // digest nonces

// ── host facts ──
const run = (c, a, t = 5000) => new Promise((r) => execFile(c, a, { timeout: t }, (e, o, er) => r(e && !o ? '' : String(o || er || ''))));
const readF = (f) => { try { return fs.readFileSync(f, 'utf8').replace(/\0/g, '').trim(); } catch { return ''; } };
const board = readF('/proc/device-tree/model') || os.type();
const serial = (readF('/proc/cpuinfo').match(/Serial\s*:\s*(\w+)/) || [])[1] || crypto.createHash('md5').update(os.hostname()).digest('hex').slice(0, 16);
function addrs() {
  const out = []; for (const [n, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ ifname: n, ip: a.address, mask: a.netmask, mac: a.mac, prefix: a.cidr ? +a.cidr.split('/')[1] : 24 });
  return out.sort((a, b) => (a.ifname === 'eth0' ? -1 : b.ifname === 'eth0' ? 1 : 0));
}
const ipNum = (ip) => String(ip).split('.').reduce((a, b) => a * 256 + (+b), 0);
function localFor(remote) { const r = String(remote || '').replace(/^::ffff:/, ''); const all = addrs(); return all.find((a) => (ipNum(a.ip) & ipNum(a.mask)) === (ipNum(r) & ipNum(a.mask))) || all[0] || { ip: '127.0.0.1', mask: '255.0.0.0', mac: '00:00:00:00:00:00' }; }
const hotNet = P.hotspotNet(rigCfg.subnet);
function trusted(remote) {   // this Pi, or the rig's own hotspot (the engineer's tablet)
  const r = String(remote || '').replace(/^::ffff:/, ''); if (r === '127.0.0.1' || r === '::1') return true;
  const [net, bits] = hotNet.split('/'); const mask = bits == 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipNum(r) & mask) >>> 0) === ((ipNum(net) & mask) >>> 0);
}

// ── probe: capture devices, formats, encoders, audio ──
const probe = { devices: [], encoders: '', audio: [], at: 0 };
async function scan() {
  const devs = P.parseDevices(await run('v4l2-ctl', ['--list-devices']));
  for (const d of devs) { d.path = d.nodes[0]; d.formats = P.parseFormats(await run('v4l2-ctl', ['-d', d.path, '--list-formats-ext'])); }
  probe.devices = devs.filter((d) => d.kind === 'csi' || d.formats.length);
  if (!probe.encoders) probe.encoders = await run(FFMPEG, ['-hide_banner', '-encoders']);
  probe.audio = (await run('arecord', ['-l'])).split('\n').map((l) => l.match(/^card (\d+): (\w+) \[([^\]]*)\], device (\d+): [^[]*\[([^\]]*)\]/)).filter(Boolean)
    .map((m) => ({ value: `plughw:CARD=${m[2]},DEV=${m[4]}`, label: `${m[3]} (${m[5]})` }));
  probe.at = Date.now();
  return probe;
}

// ── state ──
const st = { running: false, since: null, device: null, input: null, encoder: null, restarts: 0, lastError: '', signal: { state: 'starting', since: Date.now(), low: null, high: null },
  flatN: 0, okN: 0, mtx: false, viewers: [], cpu: null, fps: null };
const alertSubs = new Set();                          // open ISAPI alertStreams
let ff = null, mtx = null, backoff = 2000, ffTimer = null, stopping = false;

function setSignal(state) {
  if (st.signal.state === state) return; const was = st.signal.state; st.signal = { ...st.signal, state, since: Date.now() };
  say('signal', was, '→', state);
  if (state === 'flat') { lg('alert', { level: 'warn', src: 'hdmi-in', text: 'No picture on the HDMI input (flat / black screen)', rule: 'hdmi-flat' }); pushAlert(true); }
  else if (state === 'picture') { lg('source', { src: 'hdmi-in', state: 'picture', was }); if (was === 'flat') pushAlert(false); }
  else lg('source', { src: 'hdmi-in', state, was });
}

// ── mediamtx (child; it watches its own config, but we restart it on a port / login change anyway) ──
const MTX_YML = path.join(DATA, 'mediamtx.yml');
function startMtx() {
  fs.writeFileSync(MTX_YML, P.mediamtxYml(set, { hotspot: rigCfg.subnet }), { mode: 0o600 });
  if (!fs.existsSync(MEDIAMTX)) { st.lastError = `RTSP server missing (${MEDIAMTX}): run the installer again`; say(st.lastError); return; }
  mtx = spawn(MEDIAMTX, [MTX_YML], { stdio: ['ignore', 'pipe', 'pipe'] });
  st.mtx = true; lg('source', { src: 'rtsp-server', state: 'started' });
  const out = (b) => String(b).split('\n').filter(Boolean).forEach((l) => say('mtx', l));
  mtx.stdout.on('data', out); mtx.stderr.on('data', out);
  mtx.on('exit', (c) => { st.mtx = false; mtx = null; lg('source', { src: 'rtsp-server', state: 'stopped', code: c }); if (!stopping) setTimeout(startMtx, 3000); });
}
function restartMtx() { if (mtx) { mtx.removeAllListeners('exit'); mtx.on('exit', () => { mtx = null; st.mtx = false; startMtx(); }); mtx.kill(); } else startMtx(); }

// ── ffmpeg pipeline ──
function pickDevice() {
  if (set.device === 'test') return { name: 'Test pattern (no dongle)', path: TEST_SOURCE, kind: 'test', formats: [] };
  const list = probe.devices; return (set.device !== 'auto' && list.find((d) => d.name === set.device || d.path === set.device)) || list[0] || null;
}
async function startFf() {
  clearTimeout(ffTimer); ffTimer = null;
  if (stopping || ff) return;
  await scan();
  const dev = pickDevice();
  if (!dev) { st.device = null; st.running = false; setSignal('none'); st.lastError = 'No HDMI capture device plugged in'; ffTimer = setTimeout(startFf, 5000); return; }
  let input = null;
  if (dev.kind === 'csi') {   // TC358743: EDID + lock on to the source's timings
    for (const a of P.csiPrep(dev.path).slice(0, 1)) await run('v4l2-ctl', a);
    const t = P.parseDvTimings(await run('v4l2-ctl', ['-d', dev.path, '--query-dv-timings']));
    if (!t) { st.device = dev; setSignal('none'); st.lastError = 'HDMI bridge sees no signal from the matrix'; ffTimer = setTimeout(startFf, 3000); return; }
    for (const a of P.csiPrep(dev.path).slice(1)) await run('v4l2-ctl', a);
    input = { fmt: 'UYVY', pix: 'uyvy422', w: t.w, h: t.h, fps: t.fps || 30 };
  } else if (dev.kind !== 'test') input = P.chooseInput(dev.formats, set);
  const encoder = P.chooseEncoder(set.encoder, board, probe.encoders);
  const audioDev = set.audio && set.audio !== 'off' && dev.kind !== 'test' ? set.audio : null;
  const args = P.ffmpegArgs(set, { device: dev.path, input, encoder, rtspPort: set.rtspPort, audioDev });
  Object.assign(st, { device: { name: dev.name, path: dev.path, kind: dev.kind }, input, encoder, lastError: '' });
  say('ffmpeg', args.join(' '));
  lg('source', { src: 'encoder', state: 'starting', device: dev.name, input: input ? `${input.w}x${input.h} ${input.fmt} ${input.fps}fps` : 'test', encoder, out: `${set.size} ${set.fps}fps ${set.kbps}k${set.sub ? ' + sub' : ''}` });
  ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  st.running = true; st.since = Date.now(); st.flatN = st.okN = 0; setSignal('starting');
  const acc = {}; let buf = ''; const tail = [];
  ff.stderr.on('data', (b) => {
    buf += b; const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const l of lines) {
      const lv = P.levelsFrom(l, acc);
      if (lv) { st.signal.low = lv.low; st.signal.high = lv.high; if (Date.now() - st.since > 8000) backoff = 2000;
        if (lv.flat) { st.flatN++; st.okN = 0; if (st.flatN >= 5) setSignal('flat'); } else { st.okN++; st.flatN = 0; if (st.okN >= 2) setSignal('picture'); } continue; }
      if (/signalstats|Parsed_metadata|frame:\d+\s+pts/.test(l)) continue;
      tail.push(l); if (tail.length > 30) tail.shift();
    }
  });
  ff.on('exit', (code, sig) => {
    ff = null; st.running = false;
    const why = tail.filter((l) => /error|fail|invalid|No such|busy|denied|refused/i.test(l)).slice(-2).join(' · ') || `ffmpeg stopped (${sig || code})`;
    if (stopping) return;
    st.restarts++; st.lastError = why; setSignal('none');
    lg('alert', { level: 'bad', src: 'encoder', text: `Encoder stopped: ${why}`, rule: 'hdmi-encoder' });
    say('ffmpeg exit', code, sig, why);
    ffTimer = setTimeout(startFf, backoff); backoff = Math.min(backoff * 2, 30000);
  });
}
function restartFf() { backoff = 2000; if (ff) { ff.removeAllListeners('exit'); ff.on('exit', () => { ff = null; st.running = false; startFf(); }); ff.kill('SIGINT'); } else startFf(); }

// ── viewers (mediamtx API) + CPU, once every 5 s; a one-line summary into the log once a minute ──
const getJson = (u) => new Promise((r) => { http.get(u, { timeout: 1500 }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { r(JSON.parse(b)); } catch { r(null); } }); }).on('error', () => r(null)).on('timeout', function () { this.destroy(); }); });
let cpuPrev = null; const cpuNow = () => { const l = readF('/proc/stat').split('\n')[0].split(/\s+/).slice(1).map(Number); return { idle: l[3] + (l[4] || 0), total: l.reduce((a, b) => a + (b || 0), 0) }; };
let known = new Set(); let minute = { flat: 0, n: 0, peakViewers: 0 };
setInterval(async () => {
  const c = cpuNow(); if (cpuPrev && c.total > cpuPrev.total) st.cpu = Math.round(100 * (1 - (c.idle - cpuPrev.idle) / (c.total - cpuPrev.total))); cpuPrev = c;
  const [rs, wr, pl] = await Promise.all([getJson('http://127.0.0.1:9997/v3/rtspsessions/list'), getJson('http://127.0.0.1:9997/v3/webrtcsessions/list'), getJson('http://127.0.0.1:9997/v3/paths/list')]);
  const v = [];
  for (const s of (rs && rs.items) || []) if (s.state === 'read' && !/^(127\.|\[::1\])/.test(s.remoteAddr || '')) v.push({ id: s.id, kind: 'RTSP', remote: String(s.remoteAddr || '').replace(/:\d+$/, ''), path: s.path, stream: /102$/.test(s.path) ? 'sub' : 'main', bytes: s.bytesSent || s.outboundBytes || 0 });
  for (const s of (wr && wr.items) || []) if (s.state === 'read') v.push({ id: s.id, kind: 'WebRTC', remote: (String(s.remoteCandidate || s.remoteAddr || '').match(/\d+\.\d+\.\d+\.\d+/) || [''])[0], path: s.path, stream: /102$/.test(s.path) ? 'sub' : 'main', bytes: s.bytesSent || s.outboundBytes || 0 });
  st.viewers = v; st.paths = ((pl && pl.items) || []).map((p) => ({ name: p.name, ready: !!p.ready, tracks: p.tracks || [], bytes: p.bytesReceived || p.inboundBytes || 0 }));
  const ids = new Set(v.map((x) => x.id));
  for (const x of v) if (!known.has(x.id)) lg('source', { src: 'viewer', state: 'connected', remote: x.remote, via: x.kind, stream: x.stream });
  for (const id of known) if (!ids.has(id)) lg('source', { src: 'viewer', state: 'left', id });
  known = ids;
  minute.n++; if (st.signal.state === 'flat') minute.flat++; minute.peakViewers = Math.max(minute.peakViewers, v.length);
  if (minute.n >= 12) {
    const main = (st.paths || []).find((p) => p.name === P.MAIN); const kbps = main && minute.bytes != null ? Math.round(((main.bytes - minute.bytes) * 8) / 60000) : null;
    lg('minute', { src: 'hdmi', signal: st.signal.state, flatPct: Math.round((100 * minute.flat) / minute.n), viewers: minute.peakViewers, cpu: st.cpu, temp: temp(), kbps, restarts: st.restarts });
    if (st.cpu != null && st.cpu > 92) lg('alert', { level: 'warn', src: 'cpu', text: `Rig CPU at ${st.cpu}%: lower the HDMI stream size or frame rate`, rule: 'hdmi-cpu' });
    minute = { flat: 0, n: 0, peakViewers: 0, bytes: main ? main.bytes : null };
  }
}, 5000);
const temp = () => { const t = readF('/sys/class/thermal/thermal_zone0/temp'); return t ? Math.round(+t / 100) / 10 : null; };

// ── ISAPI alertStream: videoloss heartbeat every 10 s, active while the picture is flat ──
function devFacts(remote) {
  const me = localFor(remote); const s = P.SUB_SIZE.split('x').map(Number); const m = String(set.size).split('x').map(Number);
  const profiles = [{ token: 'main', name: 'Main stream', w: m[0], h: m[1], fps: +set.fps, kbps: +set.kbps, path: P.MAIN }];
  if (set.sub) profiles.push({ token: 'sub', name: 'Sub stream', w: s[0], h: s[1], fps: +set.fps, kbps: P.SUB_KBPS, path: P.SUB });
  return { name: set.name, uuid: set.uuid, serial: `SONORRIG${serial.slice(-8).toUpperCase()}`, mac: me.mac, ip: me.ip, mask: me.mask, prefix: me.prefix, httpPort: PORT, rtspPort: set.rtspPort, version: VERSION, hostname: os.hostname(), board, user: set.user, profiles };
}
function pushAlert(active) { for (const s of alertSubs) { try { s.res.write(ISAPI.part(ISAPI.alert(devFacts(s.remote), active))); } catch { /* closed */ } } }
setInterval(() => { for (const s of alertSubs) { try { s.res.write(ISAPI.part(ISAPI.alert(devFacts(s.remote), st.signal.state === 'flat'))); } catch { /* closed */ } } }, 10000);

// ── snapshot: one JPEG from the stream, cached 1.5 s ──
let snapCache = { at: 0, buf: null, path: '' }; let snapWait = null;
function snapshot(sub) {
  const p = sub && set.sub ? P.SUB : P.MAIN;
  if (snapCache.buf && snapCache.path === p && Date.now() - snapCache.at < 1500) return Promise.resolve(snapCache.buf);
  if (snapWait) return snapWait;
  snapWait = new Promise((resolve) => {
    const c = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', `rtsp://127.0.0.1:${set.rtspPort}/${p}`, '-frames:v', '1', '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const parts = []; const t = setTimeout(() => c.kill('SIGKILL'), 6000);
    c.stdout.on('data', (b) => parts.push(b));
    c.on('exit', () => { clearTimeout(t); snapWait = null; const buf = Buffer.concat(parts); if (buf.length) snapCache = { at: Date.now(), buf, path: p }; resolve(buf.length ? buf : null); });
  });
  return snapWait;
}
function mjpeg(req, res) {   // the driver's MJPEG path (sub stream, 5 frames/s); one ffmpeg per watcher, killed when they leave
  const c = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', `rtsp://127.0.0.1:${set.rtspPort}/${set.sub ? P.SUB : P.MAIN}`, '-an', '-r', '5', '-vf', 'scale=640:-2', '-q:v', '6', '-f', 'mpjpeg', '-boundary_tag', 'sonorframe', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=sonorframe', 'Cache-Control': 'no-store', Connection: 'close' });
  c.stdout.pipe(res); const end = () => c.kill('SIGKILL'); req.on('close', end); c.on('exit', () => res.end());
}

// ── status for the page ──
function publicSet(show) { const s = { ...set }; if (!show) s.pass = '••••••••'; delete s.uuid; return s; }
function status(remote) {
  const me = localFor(remote); const lan = addrs().find((a) => a.ifname === 'eth0'); const ap = addrs().find((a) => a.ifname === 'wlan0');
  const show = trusted(remote); const host = me.ip;
  const cred = show ? `${encodeURIComponent(set.user)}:${encodeURIComponent(set.pass)}@` : '';
  return {
    version: VERSION, board, name: set.name, settings: publicSet(show), canEdit: show, running: st.running, since: st.since, rtspServer: st.mtx,
    device: st.device, input: st.input, encoder: st.encoder, signal: st.signal, restarts: st.restarts, error: st.lastError,
    cpu: st.cpu, temp: temp(), viewers: st.viewers, paths: st.paths || [],
    choices: {
      devices: [{ value: 'auto', label: 'Automatic (first one found)' }, ...probe.devices.map((d) => ({ value: d.name, label: `${d.name} · ${d.path}${d.kind === 'csi' ? ' (HDMI bridge)' : ''}` })), { value: 'test', label: 'Test pattern (no dongle)' }],
      inputs: [{ value: 'auto', label: 'Automatic' }, ...[...new Set((probe.devices.find((d) => d.name === (st.device && st.device.name)) || { formats: [] }).formats.map((f) => P.FMT[f.fmt] || f.fmt.toLowerCase()))].map((v) => ({ value: v, label: v === 'mjpeg' ? 'MJPEG (USB 2 dongles at 1080p)' : v }))],
      sizes: P.SIZES, fps: P.FPS, kbps: P.BITRATES,
      encoders: [{ value: 'auto', label: 'Automatic' }, { value: 'software', label: 'Software (libx264)' }, ...(/h264_v4l2m2m/.test(probe.encoders) && /Raspberry Pi [34]/.test(board) ? [{ value: 'hardware', label: 'Pi hardware encoder' }] : [])],
      audio: [{ value: 'off', label: 'No audio' }, ...probe.audio],
    },
    net: { lan: lan ? lan.ip : null, ap: ap ? ap.ip : null, here: host },
    urls: {
      main: `rtsp://${cred}${host}:${set.rtspPort}/${P.MAIN}`, sub: set.sub ? `rtsp://${cred}${host}:${set.rtspPort}/${P.SUB}` : null,
      onvif: `http://${host}:${PORT}/onvif/device_service`, webrtc: `http://${host}:8889/${set.sub ? P.SUB : P.MAIN}/`, webrtcMain: `http://${host}:8889/${P.MAIN}/`,
      snapshot: `http://${host}:${PORT}/ISAPI/Streaming/channels/101/picture`, lanMain: lan ? `rtsp://${lan.ip}:${set.rtspPort}/${P.MAIN}` : null,
    },
    log: log ? log.status() : { on: false, unavailable: true },
  };
}

// ── HTTP ──
const send = (res, code, body, type = 'application/json', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req, max = 65536) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > max) req.destroy(); }); req.on('end', () => r(b)); req.on('error', () => r('')); });
const authed = (req) => ISAPI.checkAuth(req.headers.authorization, req.method, { user: set.user, pass: set.pass, secret });
const deny = (res, type = 'application/xml') => send(res, 401, type === 'application/xml' ? ISAPI.responseStatus(4, 'Invalid Operation') : '{"error":"login needed"}', type, { 'WWW-Authenticate': ISAPI.challenge(ISAPI.newNonce(secret)) });
// the rig home page (:80) passes /onvif and /ISAPI through from this Pi; only then is its x-forwarded-for believed
const remoteOf = (req) => { const r = String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''); const f = req.headers['x-forwarded-for']; return (r === '127.0.0.1' || r === '::1') && f ? String(f).split(',')[0].trim().replace(/^::ffff:/, '') : r; };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const CHOICE_KEYS = { size: P.SIZES, fps: P.FPS, kbps: P.BITRATES };
function applySettings(b) {
  const next = { ...set }; const restartRtsp = [];
  if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 60);
  for (const [k, list] of Object.entries(CHOICE_KEYS)) if (b[k] != null && list.map(String).includes(String(b[k]))) next[k] = typeof list[0] === 'number' ? +b[k] : String(b[k]);
  if (typeof b.device === 'string') next.device = b.device.slice(0, 120);
  if (typeof b.input === 'string' && /^(auto|mjpeg|yuyv422|uyvy422|nv12|yuv420p)$/.test(b.input)) next.input = b.input;
  if (typeof b.encoder === 'string' && /^(auto|software|hardware)$/.test(b.encoder)) next.encoder = b.encoder;
  if (typeof b.audio === 'string' && (b.audio === 'off' || probe.audio.some((a) => a.value === b.audio))) next.audio = b.audio;
  if (b.sub != null) next.sub = !!b.sub && b.sub !== 'false';
  if (b.onvif != null) next.onvif = !!b.onvif && b.onvif !== 'false';
  if (b.newPassword) { next.pass = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 10) + '7a'; restartRtsp.push('login'); }
  if (next.sub !== set.sub) restartRtsp.push('streams');
  const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(set[k]));
  set = next; saveSet();
  lg('source', { src: 'settings', state: 'changed', keys: changed.filter((k) => k !== 'pass') });
  if (restartRtsp.length) restartMtx();
  if (changed.some((k) => ['device', 'input', 'size', 'fps', 'kbps', 'sub', 'encoder', 'audio'].includes(k))) restartFf();
  return changed;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname; const remote = remoteOf(req);
  try {
    // ONVIF (any path under /onvif/)
    if (p.startsWith('/onvif/')) {
      if (req.method !== 'POST') return send(res, 405, 'ONVIF needs POST', 'text/plain');
      const xml = await readBody(req, 262144); if (set.onvif === false) return send(res, 404, 'ONVIF is switched off on this rig', 'text/plain');
      const ws = ONVIF.wsseOk(xml, set.user, set.pass); const ok = ws === true || (ws === null && authed(req));
      const r = ONVIF.handle(xml, devFacts(remote), { authed: ok });
      if (r.status === 401) lg('source', { src: 'onvif', state: 'login refused', remote: String(remote).replace(/^::ffff:/, '') });
      else if (r.action === 'GetStreamUri') lg('source', { src: 'onvif', state: 'stream asked for', remote: String(remote).replace(/^::ffff:/, '') });
      return send(res, r.status, r.xml, 'application/soap+xml; charset=utf-8', r.status === 401 ? { 'WWW-Authenticate': ISAPI.challenge(ISAPI.newNonce(secret)) } : {});
    }
    // Hikvision ISAPI slice
    if (p.startsWith('/ISAPI/')) {
      const open = trusted(remote) && /picture|httpPreview/.test(p);
      if (!open && !authed(req)) return deny(res);
      if (p === '/ISAPI/System/deviceInfo') return send(res, 200, ISAPI.deviceInfo({ ...devFacts(remote), built: '2026-11-26' }), 'application/xml');
      let m;
      if ((m = p.match(/^\/ISAPI\/Streaming\/channels\/(1|101|102)\/picture$/i))) { const j = await snapshot(m[1] === '102'); return j ? send(res, 200, j, 'image/jpeg') : send(res, 503, ISAPI.responseStatus(3, 'No picture yet'), 'application/xml'); }
      if (/^\/ISAPI\/Streaming\/channels\/(1|101|102)\/httpPreview$/i.test(p)) return mjpeg(req, res);
      if (p === '/ISAPI/Event/notification/alertStream') {
        res.writeHead(200, { 'Content-Type': `multipart/mixed; boundary=${ISAPI.BOUNDARY}`, Connection: 'close' });
        const sub = { res, remote }; alertSubs.add(sub); res.write(ISAPI.part(ISAPI.alert(devFacts(remote), st.signal.state === 'flat')));
        lg('source', { src: 'events', state: 'listening', remote: String(remote).replace(/^::ffff:/, '') });
        req.on('close', () => alertSubs.delete(sub)); return;
      }
      return send(res, 404, ISAPI.responseStatus(4, 'Invalid Operation'), 'application/xml');
    }
    if (log && p.startsWith('/api/log')) { if (req.method === 'POST' && !trusted(remote) && !authed(req)) return deny(res, 'application/json'); if (log.handle(req, res, url)) return; }
    if (p === '/api/status') return send(res, 200, status(remote));
    if (p === '/api/snapshot.jpg') { if (!trusted(remote) && !authed(req)) return deny(res, 'application/json'); const j = await snapshot(url.searchParams.get('sub') === '1'); return j ? send(res, 200, j, 'image/jpeg') : send(res, 503, '{"error":"no picture yet"}'); }
    if (p === '/api/settings' && req.method === 'POST') {
      if (!trusted(remote) && !authed(req)) return deny(res, 'application/json');
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, '{"error":"bad JSON"}'); }
      const changed = applySettings(b); return send(res, 200, { changed, status: status(remote) });
    }
    if (p === '/api/restart' && req.method === 'POST') { if (!trusted(remote) && !authed(req)) return deny(res, 'application/json'); restartFf(); return send(res, 202, '{"restarting":true}'); }
    if (p === '/api/rescan') { await scan(); return send(res, 200, status(remote)); }
    // the page (favicon = the repo's synced Hub-group tile)
    if (p === '/data/favicon.svg') return fs.readFile(path.join(__dirname, '../../data/favicon.svg'), (e, b) => (e ? send(res, 404, '', 'text/plain') : send(res, 200, b, 'image/svg+xml')));
    const f = path.normalize(path.join(WWW, p === '/' ? 'index.html' : p)); if (!f.startsWith(WWW)) return send(res, 403, 'no', 'text/plain');
    fs.readFile(f, (e, b) => (e ? send(res, 404, 'not found', 'text/plain') : send(res, 200, b, MIME[path.extname(f)] || 'application/octet-stream')));
  } catch (e) { say('http error', e.message); try { send(res, 500, JSON.stringify({ error: e.message })); } catch { /* sent */ } }
});

// ── discovery: WS-Discovery (ONVIF, UDP 3702) + SADP (Hikvision, UDP 37020) ──
const GROUP = '239.255.255.250';
function udp(port, onMsg) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('error', (e) => say(`udp ${port}:`, e.message));
  s.on('message', (m, r) => { try { onMsg(s, String(m), r); } catch (e) { say(`udp ${port}`, e.message); } });
  s.bind(port, () => { for (const a of addrs()) { try { s.addMembership(GROUP, a.ip); } catch { /* already */ } } try { s.setMulticastTTL(1); } catch { /* */ } });
  return s;
}
let wsd = null, sadp = null;
function startDiscovery() {
  wsd = udp(3702, (s, m, r) => {
    if (set.onvif === false || !ONVIF.isProbe(m)) return;
    const me = localFor(r.address); s.send(ONVIF.probeMatches(devFacts(r.address), m, me.ip), r.port, r.address);
    lg('source', { src: 'onvif', state: 'found by a search', remote: r.address });
  });
  sadp = udp(37020, (s, m, r) => {
    if (!ISAPI.isSadpProbe(m)) return;
    const me = localFor(r.address); const x = ISAPI.sadpMatch(devFacts(r.address), m);
    s.send(x, r.port, r.address); if (r.port !== 37020) s.send(x, 37020, GROUP);
  });
  setTimeout(() => { if (set.onvif === false) return; for (const a of addrs()) { try { wsd.send(ONVIF.hello(devFacts(a.ip), a.ip), 3702, GROUP); } catch { /* */ } } }, 1500);
}

function shutdown() {
  stopping = true; try { for (const a of addrs()) wsd && wsd.send(ONVIF.hello(devFacts(a.ip), a.ip, true), 3702, GROUP); } catch { /* */ }
  if (ff) ff.kill('SIGINT'); if (mtx) mtx.kill(); setTimeout(() => process.exit(0), 600);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

module.exports = { server, status, applySettings, devFacts, get set() { return set; }, st };
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => say(`Sonor Site Rig HDMI capture v${VERSION} on :${PORT}, RTSP :${set.rtspPort}`));
  startMtx(); setTimeout(startFf, 1200); if (process.env.NO_DISCOVERY !== '1') startDiscovery();
}
