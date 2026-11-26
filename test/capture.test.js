'use strict';
// node --test test/*.test.js   (from the repo root, no packages). The live end-to-end check (test pattern → mediamtx → ONVIF
// client, RTSP logins, ISAPI digest, SADP / WS-Discovery) is in docs/HDMI-CAPTURE.md "How it was tested".
const test = require('node:test');
const assert = require('node:assert');
const P = require('../rig/capture/pipeline');
const ISAPI = require('../rig/capture/isapi');
const ONVIF = require('../rig/capture/onvif');

const V4L_DEVICES = `pispbe (platform:1000880000.pisp_be):
	/dev/video20
	/dev/video21

rpivid (platform:rpivid):
	/dev/video19
	/dev/media0

USB3 Video: USB3 Video (usb-xhci-hcd.0-1):
	/dev/video0
	/dev/video1
	/dev/media3
`;
const V4L_FORMATS = `ioctl: VIDIOC_ENUM_FMT
	Type: Video Capture

	[0]: 'MJPG' (Motion-JPEG, compressed)
		Size: Discrete 1920x1080
			Interval: Discrete 0.017s (60.000 fps)
			Interval: Discrete 0.033s (30.000 fps)
		Size: Discrete 1280x720
			Interval: Discrete 0.017s (60.000 fps)
	[1]: 'YUYV' (YUYV 4:2:2)
		Size: Discrete 1920x1080
			Interval: Discrete 0.200s (5.000 fps)
		Size: Discrete 1280x720
			Interval: Discrete 0.100s (10.000 fps)
`;

test('devices: Pi codec nodes are skipped, the dongle is found', () => {
  const d = P.parseDevices(V4L_DEVICES);
  assert.strictEqual(d.length, 1); assert.strictEqual(d[0].nodes[0], '/dev/video0'); assert.strictEqual(d[0].kind, 'usb');
});
test('formats: MJPEG at the asked size wins, frame rate matched', () => {
  const f = P.parseFormats(V4L_FORMATS);
  assert.deepStrictEqual(f.map((x) => x.fmt), ['MJPG', 'YUYV']);
  const i = P.chooseInput(f, { size: '1920x1080', fps: 30 });
  assert.deepStrictEqual([i.pix, i.w, i.h, i.fps], ['mjpeg', 1920, 1080, 30]);
  assert.strictEqual(P.chooseInput(f, { size: '1920x1080', input: 'yuyv422', fps: 25 }).pix, 'yuyv422');
  assert.strictEqual(P.chooseInput(f, { size: '3840x2160' }).w, 1920);   // not offered → biggest, MJPEG first
});
test('encoder: Pi 5 has no hardware H.264, Pi 4 does', () => {
  assert.strictEqual(P.chooseEncoder('auto', 'Raspberry Pi 5 Model B Rev 1.0', ' V..... h264_v4l2m2m'), 'libx264');
  assert.strictEqual(P.chooseEncoder('auto', 'Raspberry Pi 4 Model B Rev 1.5', ' V..... h264_v4l2m2m'), 'h264_v4l2m2m');
  assert.strictEqual(P.chooseEncoder('hardware', 'Raspberry Pi 5', 'h264_v4l2m2m'), 'libx264');
});
test('ffmpeg args: main + sub to the Hikvision-style paths, 2 s GOP, no B-frames, level probe', () => {
  const a = P.ffmpegArgs({ ...P.DEFAULTS }, { device: '/dev/video0', input: { pix: 'mjpeg', w: 1920, h: 1080, fps: 30 }, encoder: 'libx264', rtspPort: 554 }).join(' ');
  assert.match(a, /-f v4l2 .*-input_format mjpeg -video_size 1920x1080 -framerate 30 -i \/dev\/video0/);
  assert.match(a, /rtsp:\/\/127\.0\.0\.1:554\/Streaming\/Channels\/101/); assert.match(a, /Channels\/102/);
  assert.match(a, /-g 50 .*-bf 0/); assert.match(a, /signalstats/);
  const n = P.ffmpegArgs({ ...P.DEFAULTS, sub: false }, { device: '/dev/video0', encoder: 'h264_v4l2m2m' }).join(' ');
  assert.doesNotMatch(n, /Channels\/102/); assert.match(n, /h264_v4l2m2m/);
});
test('flat picture = no signal', () => {
  const acc = {};
  assert.strictEqual(P.levelsFrom('[Parsed_metadata_8 @ 0x1] lavfi.signalstats.YLOW=16', acc), null);
  assert.deepStrictEqual(P.levelsFrom('lavfi.signalstats.YHIGH=18', acc), { low: 16, high: 18, flat: true });
  P.levelsFrom('lavfi.signalstats.YLOW=30', acc); assert.strictEqual(P.levelsFrom('lavfi.signalstats.YHIGH=220', acc).flat, false);
});
test('TC358743 timings', () => {
  assert.deepStrictEqual(P.parseDvTimings('Active width: 1920\nActive height: 1080\nPixelclock: 148500000 Hz (60.00 frames per second)'), { w: 1920, h: 1080, fps: 60 });
  assert.strictEqual(P.parseDvTimings('VIDIOC_QUERY_DV_TIMINGS: failed: No link has been detected'), null);
});
test('mediamtx config: login for the LAN, hotspot watches freely, only this Pi publishes', () => {
  const y = P.mediamtxYml({ ...P.DEFAULTS, pass: 'p"w' }, { hotspot: '10.77.0.1/24' });
  assert.match(y, /rtspAddress: :554/); assert.match(y, /"10\.77\.0\.0\/24"/); assert.match(y, /pass: "p\\"w"/);
  assert.match(y, /Streaming\/Channels\/101:/); assert.match(y, /hls: false/);
  assert.strictEqual(y.split('action: publish').length, 2);
});

const DEV = { name: 'Rig <HDMI>', uuid: 'u-1', serial: 'SN1', mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.1.50', httpPort: 8056, rtspPort: 554, version: '1.1.0', hostname: 'rig', user: 'admin',
  profiles: [{ token: 'main', name: 'Main', w: 1920, h: 1080, fps: 25, kbps: 4000, path: P.MAIN }, { token: 'sub', name: 'Sub', w: 640, h: 360, fps: 25, kbps: 512, path: P.SUB }] };
const soap = (body, hdr = '') => `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl">${hdr}<s:Body>${body}</s:Body></s:Envelope>`;

test('ONVIF: pre-auth calls open, the rest need a login', () => {
  assert.strictEqual(ONVIF.handle(soap('<tds:GetSystemDateAndTime xmlns:tds="x"/>'), DEV).status, 200);
  assert.strictEqual(ONVIF.handle(soap('<tds:GetCapabilities xmlns:tds="x"/>'), DEV).status, 200);
  assert.strictEqual(ONVIF.handle(soap('<trt:GetProfiles/>'), DEV).status, 401);
  assert.strictEqual(ONVIF.handle(soap('<trt:GetFoo/>'), DEV, { authed: true }).status, 400);
});
test('ONVIF: WS-Security digest checks the password', () => {
  const good = soap('<trt:GetProfiles/>', ONVIF.wsseHeader('admin', 'pw1'));
  assert.strictEqual(ONVIF.wsseOk(good, 'admin', 'pw1'), true);
  assert.strictEqual(ONVIF.wsseOk(good, 'admin', 'pw2'), false);
  assert.strictEqual(ONVIF.wsseOk(soap('<trt:GetProfiles/>'), 'admin', 'pw1'), null);
});
test('ONVIF: profiles and stream URIs point at the RTSP paths, names escaped', () => {
  const r = ONVIF.handle(soap('<trt:GetProfiles/>'), DEV, { authed: true });
  assert.match(r.xml, /token="main"/); assert.match(r.xml, /<tt:Width>640<\/tt:Width>/); assert.doesNotMatch(r.xml, /<HDMI>/);
  const u = ONVIF.handle(soap('<trt:GetStreamUri><trt:ProfileToken>sub</trt:ProfileToken></trt:GetStreamUri>'), DEV, { authed: true });
  assert.match(u.xml, /rtsp:\/\/192\.168\.1\.50:554\/Streaming\/Channels\/102/);
});
test('WS-Discovery: answers a camera probe, ignores others', () => {
  const pr = '<e:Envelope><e:Header><w:MessageID>uuid:abc</w:MessageID></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';
  assert.ok(ONVIF.isProbe(pr)); assert.ok(!ONVIF.isProbe(pr.replace('dn:NetworkVideoTransmitter', 'wsdp:Printer')));
  const m = ONVIF.probeMatches(DEV, pr, '192.168.1.50');
  assert.match(m, /RelatesTo>uuid:abc</); assert.match(m, /http:\/\/192\.168\.1\.50:8056\/onvif\/device_service/);
});
test('ISAPI: digest login, deviceInfo, videoloss event shape the C4 driver parses', () => {
  const secret = 's'; const chal = ISAPI.challenge(ISAPI.newNonce(secret));
  const h = ISAPI.digestHeader('GET', '/ISAPI/System/deviceInfo', 'admin', 'pw', chal);
  assert.ok(ISAPI.checkAuth(h, 'GET', { user: 'admin', pass: 'pw', secret }));
  assert.ok(!ISAPI.checkAuth(h, 'GET', { user: 'admin', pass: 'nope', secret }));
  assert.ok(!ISAPI.checkAuth(h, 'GET', { user: 'admin', pass: 'pw', secret: 'other' }));
  assert.match(ISAPI.deviceInfo(DEV), /<model>SONOR-RIG-HDMI<\/model>/);
  const a = ISAPI.alert(DEV, true);
  assert.match(a, /<eventType>videoloss<\/eventType>/); assert.match(a, /<eventState>active<\/eventState>/); assert.match(a, /<channelID>1<\/channelID>/);
  assert.match(ISAPI.part(a), /^--boundary\r\nContent-Type: application\/xml/);
});
test('SADP: answers the Hikvision search the driver and the Network Scanner send', () => {
  const pr = '<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>ABC-1</Uuid><Types>inquiry</Types></Probe>';
  assert.ok(ISAPI.isSadpProbe(pr));
  const m = ISAPI.sadpMatch(DEV, pr);
  assert.match(m, /<Uuid>ABC-1<\/Uuid>/); assert.match(m, /<IPv4Address>192\.168\.1\.50</); assert.match(m, /<HttpPort>8056</); assert.match(m, /<Activated>true</);
});
