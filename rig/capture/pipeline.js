'use strict';
// Sonor Site Rig · HDMI capture: what to run. Pure functions (no I/O) so the tests can check every argument.
//   settings + probe (devices, formats, board, encoders)  →  ffmpeg args  +  mediamtx.yml
// Stream names follow Hikvision's (Streaming/Channels/101 main, 102 sub) so the Sonor Hikvision camera driver, NVRs and
// any RTSP player find them where they expect them. ONVIF hands out the same URLs.

const MAIN = 'Streaming/Channels/101';
const SUB = 'Streaming/Channels/102';
const SIZES = ['1920x1080', '1280x720'];
const FPS = [25, 30];
const BITRATES = [2000, 3000, 4000, 6000];      // kbps, main stream
const SUB_SIZE = '640x360';
const SUB_KBPS = 512;
const DEFAULTS = {
  name: 'Site Rig HDMI', device: 'auto', input: 'auto', size: '1920x1080', fps: 25, kbps: 4000, sub: true,
  encoder: 'auto', audio: 'off', user: 'admin', pass: '', onvif: true, rtspPort: 554, httpPort: 8056,
};

// Pi codec / ISP nodes are not capture inputs
const NOT_CAPTURE = /bcm2835-codec|bcm2835-isp|rpi-hevc|hevc-dec|pispbe|rpivid|rp1-cfe-?\w*meta/i;

// `v4l2-ctl --list-devices` → [{ name, bus, nodes: ['/dev/video0', …], kind: 'usb' | 'csi' }]
function parseDevices(txt) {
  const out = []; let cur = null;
  for (const line of String(txt || '').split('\n')) {
    if (/^\S/.test(line)) { const m = line.match(/^(.*?)\s*\(([^)]*)\):?\s*$/) || [null, line.replace(/:$/, ''), '']; cur = { name: m[1].trim(), bus: m[2], nodes: [] }; out.push(cur); }
    else if (cur && /\/dev\/video\d+/.test(line)) cur.nodes.push(line.trim());
  }
  return out.filter((d) => d.nodes.length && !NOT_CAPTURE.test(d.name))
    .map((d) => ({ ...d, kind: /tc358743|unicam|rp1-cfe|csi/i.test(d.name + d.bus) ? 'csi' : 'usb' }));
}

// `v4l2-ctl -d X --list-formats-ext` → [{ fmt: 'MJPG'|'YUYV'|…, sizes: [{ w, h, fps: [..] }] }]
function parseFormats(txt) {
  const out = []; let f = null, s = null;
  for (const line of String(txt || '').split('\n')) {
    let m;
    if ((m = line.match(/\[\d+\]:\s*'(\w+)'/))) { f = { fmt: m[1], sizes: [] }; out.push(f); s = null; }
    else if (f && (m = line.match(/Size:\s*\w+\s*(\d+)x(\d+)/))) { s = { w: +m[1], h: +m[2], fps: [] }; f.sizes.push(s); }
    else if (s && (m = line.match(/\(([\d.]+)\s*fps\)/))) s.fps.push(Math.round(+m[1]));
  }
  return out;
}

const FMT = { MJPG: 'mjpeg', YUYV: 'yuyv422', UYVY: 'uyvy422', NV12: 'nv12', YU12: 'yuv420p' };

// Pick the capture format: asked-for one if it exists, else MJPEG at the size (USB dongles only do 1080p over USB 2 as MJPEG),
// else raw at the size, else the biggest the device offers.
function chooseInput(formats, want = {}) {
  const [w, h] = String(want.size || DEFAULTS.size).split('x').map(Number);
  const has = (f) => formats.find((x) => x.fmt === f);
  const at = (f) => { const x = has(f); return x && x.sizes.find((s) => s.w === w && s.h === h); };
  const pick = (f, s) => ({ fmt: f, pix: FMT[f] || f.toLowerCase(), w: s.w, h: s.h, fps: s.fps.length ? (s.fps.includes(+want.fps) ? +want.fps : Math.max(...s.fps)) : +want.fps || 25 });
  if (want.input && want.input !== 'auto') { const f = Object.keys(FMT).find((k) => FMT[k] === want.input || k === want.input); if (f && at(f)) return pick(f, at(f)); }
  for (const f of ['MJPG', 'YUYV', 'UYVY', 'NV12']) if (at(f)) return pick(f, at(f));
  let best = null;
  for (const f of formats) for (const s of f.sizes) if (!best || s.w * s.h > best.s.w * best.s.h || (s.w * s.h === best.s.w * best.s.h && f.fmt === 'MJPG')) best = { f: f.fmt, s };
  return best ? pick(best.f, best.s) : null;
}

// Pi 4 (and 3) have the hardware H.264 block; Pi 5 does not, so it encodes in software (libx264 ultrafast).
function chooseEncoder(setting, board, encoders) {
  const hw = /Raspberry Pi [34]/.test(board || '') && /h264_v4l2m2m/.test(encoders || '');
  if (setting === 'hardware') return hw ? 'h264_v4l2m2m' : 'libx264';
  if (setting === 'software') return 'libx264';
  return hw ? 'h264_v4l2m2m' : 'libx264';
}

function encArgs(enc, kbps, fps) {
  const gop = String(fps * 2);   // a key frame every 2 s: NVRs and players join fast
  const rate = ['-b:v', kbps + 'k', '-maxrate', kbps + 'k', '-bufsize', kbps * 2 + 'k'];
  if (enc === 'h264_v4l2m2m') return ['-c:v', 'h264_v4l2m2m', '-g', gop, ...rate, '-bf', '0'];
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'main', '-g', gop, '-keyint_min', gop, '-sc_threshold', '0', '-bf', '0', ...rate];
}

// One ffmpeg: capture → main (+ sub) → mediamtx over RTSP on localhost, plus a 1 frame/s probe that prints picture levels
// (a flat picture = no signal / blank output from the matrix).
function ffmpegArgs(set, { device, input, encoder, rtspPort = 554, audioDev = null }) {
  const fps = +set.fps || 25; const [mw, mh] = String(set.size).split('x').map(Number);
  const a = ['-hide_banner', '-nostats', '-loglevel', 'info', '-fflags', 'nobuffer'];
  if (/^lavfi:/.test(device)) a.push('-re', '-f', 'lavfi', '-i', device.slice(6));   // demo / test source (no dongle)
  else {
    a.push('-f', 'v4l2', '-thread_queue_size', '64');
    if (input) a.push('-input_format', input.pix, '-video_size', `${input.w}x${input.h}`, '-framerate', String(input.fps));
    a.push('-i', device);
  }
  const audio = !!audioDev;
  if (audio) a.push('-f', 'alsa', '-thread_queue_size', '1024', '-i', audioDev);
  const n = set.sub ? 3 : 2;
  let fc = `[0:v]fps=${fps},scale=${mw}:${mh}:flags=fast_bilinear,format=yuv420p,split=${n}[m]` + (set.sub ? '[s0]' : '') + '[p0]';
  if (set.sub) fc += `;[s0]scale=${SUB_SIZE.replace('x', ':')}:flags=fast_bilinear[s]`;
  fc += ';[p0]fps=1,scale=64:36,signalstats,metadata=mode=print:key=lavfi.signalstats.YLOW,metadata=mode=print:key=lavfi.signalstats.YHIGH[p]';
  a.push('-filter_complex', fc);
  const url = (p) => `rtsp://127.0.0.1:${rtspPort}/${p}`;
  const aud = audio ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2'] : [];
  a.push('-map', '[m]', ...aud, ...encArgs(encoder, +set.kbps || 4000, fps), '-f', 'rtsp', '-rtsp_transport', 'tcp', url(MAIN));
  if (set.sub) a.push('-map', '[s]', ...encArgs(encoder, SUB_KBPS, fps), '-f', 'rtsp', '-rtsp_transport', 'tcp', url(SUB));
  a.push('-map', '[p]', '-f', 'null', '-');
  return a;
}

// TC358743 (CSI-2 HDMI bridge): load an EDID, lock on to what the source sends, set UYVY. Run before ffmpeg.
function csiPrep(device) {
  return [
    ['-d', device, '--set-edid=pad=0,type=hdmi', '--fix-edid-checksums'],
    ['-d', device, '--set-dv-bt-timings', 'query'],
    ['-d', device, '-v', 'pixelformat=UYVY'],
  ];
}
// `v4l2-ctl --query-dv-timings` → { w, h, fps } | null (no signal)
function parseDvTimings(txt) {
  const w = (String(txt).match(/Active width:\s*(\d+)/) || [])[1]; const h = (String(txt).match(/Active height:\s*(\d+)/) || [])[1];
  const f = (String(txt).match(/\(([\d.]+) frames per second\)/) || [])[1];
  return w && h && +w > 0 ? { w: +w, h: +h, fps: f ? Math.round(+f) : 0 } : null;
}

// ffmpeg prints a picture level per second: flat (top and bottom levels close together) = black / blue / "no signal" screen
function levelsFrom(line, acc) {
  const m = String(line).match(/lavfi\.signalstats\.(YLOW|YHIGH)=([\d.]+)/);
  if (!m) return null;
  acc[m[1]] = +m[2];
  if (acc.YLOW != null && acc.YHIGH != null) { const r = { low: acc.YLOW, high: acc.YHIGH, flat: acc.YHIGH - acc.YLOW < 12 }; acc.YLOW = acc.YHIGH = null; return r; }
  return null;
}

const yq = (s) => JSON.stringify(String(s));   // a JSON string is a valid YAML double-quoted scalar
function hotspotNet(subnet) { const m = String(subnet || '10.77.0.1/24').match(/^(\d+)\.(\d+)\.(\d+)\.\d+\/(\d+)$/); return m ? `${m[1]}.${m[2]}.${m[3]}.0/${m[4]}` : '10.77.0.0/24'; }

// mediamtx: RTSP for NVRs / Control4 / players (login), WebRTC for the preview page, local API for viewer counts.
// Only ffmpeg on this Pi can publish. The rig's own hotspot may watch without a login (it is the engineer's tablet).
function mediamtxYml(set, { hotspot = '10.77.0.1/24' } = {}) {
  return [
    '# Written by the Sonor Site Rig HDMI capture agent on every start. Edit the settings on its page, not this file.',
    'logLevel: warn', 'logDestinations: [stdout]',
    'api: true', 'apiAddress: 127.0.0.1:9997',
    'rtmp: false', 'hls: false', 'srt: false', 'moq: false', 'playback: false', 'metrics: false', 'pprof: false',
    'rtsp: true', `rtspAddress: :${+set.rtspPort || 554}`, 'rtspTransports: [udp, tcp]', 'rtspAuthMethods: [basic, digest]',
    'webrtc: true', 'webrtcAddress: :8889', 'webrtcLocalUDPAddress: :8189', 'webrtcAllowOrigins: ["*"]',
    'authMethod: internal', 'authInternalUsers:',
    '  - user: any', '    pass:', '    ips: ["127.0.0.1", "::1"]', '    permissions:', '      - action: publish', '      - action: read', '      - action: api',
    '  - user: any', '    pass:', `    ips: [${yq(hotspotNet(hotspot))}]`, '    permissions:', '      - action: read',
    `  - user: ${yq(set.user || 'admin')}`, `    pass: ${yq(set.pass || '')}`, '    ips: []', '    permissions:', '      - action: read',
    'paths:', `  ${MAIN}:`, '    source: publisher', `  ${SUB}:`, '    source: publisher', '',
  ].join('\n');
}

module.exports = { MAIN, SUB, SIZES, FPS, BITRATES, SUB_SIZE, SUB_KBPS, DEFAULTS, FMT, parseDevices, parseFormats, chooseInput, chooseEncoder, ffmpegArgs, csiPrep, parseDvTimings, levelsFrom, mediamtxYml, hotspotNet };
