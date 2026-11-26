'use strict';
// Sonor Site Rig · HDMI capture: the small slice of Hikvision ISAPI the Sonor Hikvision camera driver (sonor-c4-cameras) uses,
// so the capture can be added in Control4 as a camera directly, with no NVR. Also SADP answers, so "Find Cameras on Network"
// (driver) and the Network Scanner list it. Pure builders + HTTP Digest; the agent does the I/O.
//   GET /ISAPI/System/deviceInfo · GET /ISAPI/Streaming/channels/10x/picture · GET /ISAPI/Streaming/channels/102/httpPreview
//   GET /ISAPI/Event/notification/alertStream (videoloss heartbeat every 10 s; active while the picture is flat = no signal)
const crypto = require('crypto');

const REALM = 'Sonor Site Rig';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const esc = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// ── HTTP Digest (RFC 2617, MD5, qop=auth) + Basic ──
function challenge(nonce) { return `Digest realm="${REALM}", qop="auth", nonce="${nonce}", opaque="${md5(REALM)}", algorithm=MD5, stale=FALSE`; }
function newNonce(secret) { const t = Date.now().toString(36); return t + '.' + md5(t + ':' + secret).slice(0, 16); }
function nonceOk(nonce, secret, maxAgeMs = 10 * 60 * 1000) {
  const [t, sig] = String(nonce || '').split('.');
  return !!t && sig === md5(t + ':' + secret).slice(0, 16) && Date.now() - parseInt(t, 36) < maxAgeMs;
}
function parseAuth(h) {
  const out = {}; const s = String(h || '');
  const m = s.match(/^(\w+)\s+(.*)$/); if (!m) return null; out.scheme = m[1].toLowerCase();
  if (out.scheme === 'basic') { const [u, ...p] = Buffer.from(m[2], 'base64').toString().split(':'); out.username = u; out.password = p.join(':'); return out; }
  for (const kv of m[2].matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) out[kv[1]] = kv[2] != null ? kv[2] : kv[3];
  return out;
}
// → true | false; method + uri from the request
function checkAuth(header, method, { user, pass, secret }) {
  const a = parseAuth(header); if (!a || a.username !== user) return false;
  if (a.scheme === 'basic') return a.password === pass;
  if (a.scheme !== 'digest' || !nonceOk(a.nonce, secret)) return false;
  const ha1 = md5(`${user}:${REALM}:${pass}`); const ha2 = md5(`${method}:${a.uri}`);
  const want = a.qop ? md5(`${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:${a.qop}:${ha2}`) : md5(`${ha1}:${a.nonce}:${ha2}`);
  return want === a.response;
}
// for tests: what a client would send
function digestHeader(method, uri, user, pass, chal, nc = '00000001', cnonce = 'abcdef') {
  const c = parseAuth(chal); const ha1 = md5(`${user}:${c.realm}:${pass}`); const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return `Digest username="${user}", realm="${c.realm}", nonce="${c.nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}", opaque="${c.opaque}"`;
}

const XMLNS = 'http://www.hikvision.com/ver20/XMLSchema';
function deviceInfo(d) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<DeviceInfo version="2.0" xmlns="${XMLNS}">
<deviceName>${esc(d.name)}</deviceName>
<deviceID>${esc(d.uuid)}</deviceID>
<model>SONOR-RIG-HDMI</model>
<serialNumber>${esc(d.serial)}</serialNumber>
<macAddress>${esc(d.mac)}</macAddress>
<firmwareVersion>V${esc(d.version)}</firmwareVersion>
<firmwareReleasedDate>build ${esc(d.built || '')}</firmwareReleasedDate>
<deviceType>IPCamera</deviceType>
<manufacturer>Sonor</manufacturer>
</DeviceInfo>`;
}
function responseStatus(code, text) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ResponseStatus version="2.0" xmlns="${XMLNS}"><requestURL></requestURL><statusCode>${code}</statusCode><statusString>${esc(text)}</statusString><subStatusCode>${code === 4 ? 'notSupport' : 'badAuthorization'}</subStatusCode></ResponseStatus>`;
}
// One event for the alertStream. videoloss inactive = Hikvision's own heartbeat; active = no picture.
function alert(d, active, count = 1) {
  return `<EventNotificationAlert version="2.0" xmlns="${XMLNS}">
<ipAddress>${esc(d.ip)}</ipAddress>
<portNo>${esc(d.httpPort)}</portNo>
<protocol>HTTP</protocol>
<macAddress>${esc(d.mac)}</macAddress>
<channelID>1</channelID>
<dateTime>${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dateTime>
<activePostCount>${count}</activePostCount>
<eventType>videoloss</eventType>
<eventState>${active ? 'active' : 'inactive'}</eventState>
<eventDescription>${active ? 'No picture on the HDMI input' : 'videoloss alarm'}</eventDescription>
</EventNotificationAlert>`;
}
const BOUNDARY = 'boundary';
function part(xml) { const b = Buffer.from(xml); return `--${BOUNDARY}\r\nContent-Type: application/xml; charset="UTF-8"\r\nContent-Length: ${b.length}\r\n\r\n${xml}\r\n`; }

// ── SADP (UDP 37020, multicast 239.255.255.250) ──
function isSadpProbe(x) { return /<Probe>/.test(x) && /<Types>\s*inquiry\s*<\/Types>/i.test(x); }
function sadpMatch(d, probe) {
  const uuid = (String(probe).match(/<Uuid>([^<]+)<\/Uuid>/) || [])[1] || d.uuid;
  return `<?xml version="1.0" encoding="UTF-8"?><ProbeMatch><Uuid>${esc(uuid)}</Uuid><Types>inquiry</Types><DeviceType>SONOR-RIG-HDMI</DeviceType>` +
    `<DeviceDescription>Sonor Site Rig HDMI</DeviceDescription><DeviceSN>${esc(d.serial)}</DeviceSN><CommandPort>0</CommandPort><HttpPort>${esc(d.httpPort)}</HttpPort>` +
    `<MAC>${esc(String(d.mac || '').replace(/:/g, '-'))}</MAC><IPv4Address>${esc(d.ip)}</IPv4Address><IPv4SubnetMask>${esc(d.mask || '255.255.255.0')}</IPv4SubnetMask>` +
    `<IPv4Gateway>0.0.0.0</IPv4Gateway><DHCP>true</DHCP><AnalogChannelNum>0</AnalogChannelNum><DigitalChannelNum>1</DigitalChannelNum>` +
    `<SoftwareVersion>V${esc(d.version)}</SoftwareVersion><Activated>true</Activated><PasswordResetAbility>false</PasswordResetAbility></ProbeMatch>`;
}

module.exports = { REALM, challenge, newNonce, nonceOk, parseAuth, checkAuth, digestHeader, deviceInfo, responseStatus, alert, part, BOUNDARY, isSadpProbe, sadpMatch, esc };
