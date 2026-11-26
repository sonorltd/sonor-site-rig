'use strict';
// Sonor Site Rig · HDMI capture: a minimal ONVIF Profile S device, enough for Hikvision / Dahua NVRs (and ONVIF Device Manager)
// to find the rig, log in and pull the two RTSP streams. Pure: request XML in, { status, xml } out. The agent does HTTP + UDP.
//   Device: GetSystemDateAndTime · GetCapabilities · GetServices · GetServiceCapabilities · GetDeviceInformation · GetScopes ·
//           GetHostname · GetNetworkInterfaces · GetDNS · GetNTP · GetNetworkProtocols · GetDiscoveryMode · GetUsers · GetRelayOutputs
//   Media:  GetProfiles · GetProfile · GetVideoSources · GetVideoSourceConfiguration(s) · GetVideoEncoderConfiguration(s) ·
//           GetVideoEncoderConfigurationOptions · GetCompatibleVideoEncoderConfigurations · GetStreamUri · GetSnapshotUri ·
//           GetAudioSources · GetAudioEncoderConfigurations · GetServiceCapabilities
//   Anything else → SOAP fault ActionNotSupported (NVRs carry on without it).
// Auth: WS-Security UsernameToken (digest or text) or HTTP Digest/Basic; the pre-auth calls from the ONVIF core spec need neither.
const crypto = require('crypto');
const { esc } = require('./isapi');

const NS = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:ter="http://www.onvif.org/ver10/error"';
const PRE_AUTH = new Set(['GetSystemDateAndTime', 'GetCapabilities', 'GetServices', 'GetServiceCapabilities', 'GetHostname', 'GetWsdlUrl', 'GetEndpointReference']);
const env = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<s:Envelope ${NS}><s:Body>${body}</s:Body></s:Envelope>`;
const fault = (code, sub, text) => env(`<s:Fault><s:Code><s:Value>s:${code}</s:Value><s:Subcode><s:Value>${sub}</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en">${esc(text)}</s:Text></s:Reason></s:Fault>`);

function action(xml) {
  const m = String(xml).match(/<(?:[\w-]+:)?Body[^>]*>\s*<(?:[\w-]+:)?(\w+)/);
  return m ? m[1] : null;
}
const tag = (xml, t) => (String(xml).match(new RegExp(`<(?:[\\w-]+:)?${t}(?:\\s[^>]*)?>([^<]*)<`)) || [])[1];

// WS-Security UsernameToken: PasswordDigest = Base64(SHA1(nonce + created + password))
function wsseOk(xml, user, pass) {
  const u = tag(xml, 'Username'); if (u == null) return null;          // null = no token in the request
  if (u !== user) return false;
  const pw = tag(xml, 'Password'); const nonce = tag(xml, 'Nonce'); const created = tag(xml, 'Created');
  const isDigest = /<(?:[\w-]+:)?Password[^>]*PasswordDigest/.test(xml);
  if (!isDigest) return pw === pass;
  if (!nonce || !created) return false;
  const want = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(pass)])).digest('base64');
  return want === pw;
}
function wsseHeader(user, pass, nonceB64 = crypto.randomBytes(16).toString('base64'), created = new Date().toISOString()) { // for tests
  const d = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(nonceB64, 'base64'), Buffer.from(created), Buffer.from(pass)])).digest('base64');
  return `<s:Header><Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${user}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${d}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceB64}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created></UsernameToken></Security></s:Header>`;
}

// d = { name, uuid, serial, mac, ip, httpPort, rtspPort, version, hostname, profiles: [{ token, name, w, h, fps, kbps, path }] }
function profilesOf(d) { return d.profiles && d.profiles.length ? d.profiles : []; }
const src = (d) => { const m = profilesOf(d)[0] || { w: 1920, h: 1080, fps: 25 }; return { w: m.w, h: m.h, fps: m.fps }; };
function vsc(d) { const s = src(d); return `<tt:VideoSourceConfiguration token="VSC_1"><tt:Name>HDMI</tt:Name><tt:UseCount>${profilesOf(d).length}</tt:UseCount><tt:SourceToken>HDMI_1</tt:SourceToken><tt:Bounds x="0" y="0" width="${s.w}" height="${s.h}"/></tt:VideoSourceConfiguration>`; }
function vec(p, el = 'tt:VideoEncoderConfiguration') {
  return `<${el} token="VEC_${p.token}"><tt:Name>${esc(p.name)}</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>${p.w}</tt:Width><tt:Height>${p.h}</tt:Height></tt:Resolution><tt:Quality>5</tt:Quality>` +
    `<tt:RateControl><tt:FrameRateLimit>${p.fps}</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>${p.kbps}</tt:BitrateLimit></tt:RateControl>` +
    `<tt:H264><tt:GovLength>${p.fps * 2}</tt:GovLength><tt:H264Profile>Baseline</tt:H264Profile></tt:H264>` +
    `<tt:Multicast><tt:Address><tt:Type>IPv4</tt:Type><tt:IPv4Address>0.0.0.0</tt:IPv4Address></tt:Address><tt:Port>0</tt:Port><tt:TTL>1</tt:TTL><tt:AutoStart>false</tt:AutoStart></tt:Multicast><tt:SessionTimeout>PT60S</tt:SessionTimeout></${el}>`;
}
function profile(d, p, el = 'trt:Profiles') {
  return `<${el} token="${p.token}" fixed="true"><tt:Name>${esc(p.name)}</tt:Name>${vsc(d)}${vec(p)}</${el}>`;
}
const xaddr = (d, path) => `http://${d.ip}:${d.httpPort}/onvif/${path}`;
const streamUri = (d, p) => `rtsp://${d.ip}:${d.rtspPort}/${p.path}`;
const snapUri = (d, p) => `http://${d.ip}:${d.httpPort}/ISAPI/Streaming/channels/${p.path.slice(-3)}/picture`;
const pick = (d, xml) => { const t = tag(xml, 'ProfileToken'); return profilesOf(d).find((p) => p.token === t) || (t ? null : profilesOf(d)[0]); };

function handle(xml, d, { authed } = {}) {
  const act = action(xml);
  if (!act) return { status: 400, xml: fault('Sender', 'ter:WellFormed', 'No SOAP body') };
  if (!PRE_AUTH.has(act) && !authed) return { status: 401, xml: fault('Sender', 'ter:NotAuthorized', 'Sender not authorized') };
  const ok = (body) => ({ status: 200, xml: env(body), action: act });
  const now = new Date();
  const s = src(d);
  switch (act) {
    case 'GetSystemDateAndTime': return ok(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:TimeZone><tt:TZ>GMT0</tt:TZ></tt:TimeZone><tt:UTCDateTime><tt:Time><tt:Hour>${now.getUTCHours()}</tt:Hour><tt:Minute>${now.getUTCMinutes()}</tt:Minute><tt:Second>${now.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${now.getUTCFullYear()}</tt:Year><tt:Month>${now.getUTCMonth() + 1}</tt:Month><tt:Day>${now.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
    case 'GetCapabilities': return ok(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>${xaddr(d, 'device_service')}</tt:XAddr><tt:Network><tt:IPFilter>false</tt:IPFilter><tt:ZeroConfiguration>false</tt:ZeroConfiguration><tt:IPVersion6>false</tt:IPVersion6><tt:DynDNS>false</tt:DynDNS></tt:Network><tt:System><tt:DiscoveryResolve>false</tt:DiscoveryResolve><tt:DiscoveryBye>true</tt:DiscoveryBye><tt:RemoteDiscovery>false</tt:RemoteDiscovery><tt:SystemBackup>false</tt:SystemBackup><tt:SystemLogging>false</tt:SystemLogging><tt:FirmwareUpgrade>false</tt:FirmwareUpgrade><tt:SupportedVersions><tt:Major>2</tt:Major><tt:Minor>60</tt:Minor></tt:SupportedVersions></tt:System><tt:Security><tt:TLS1.1>false</tt:TLS1.1><tt:TLS1.2>false</tt:TLS1.2><tt:OnboardKeyGeneration>false</tt:OnboardKeyGeneration><tt:AccessPolicyConfig>false</tt:AccessPolicyConfig><tt:X.509Token>false</tt:X.509Token><tt:SAMLToken>false</tt:SAMLToken><tt:KerberosToken>false</tt:KerberosToken><tt:RELToken>false</tt:RELToken></tt:Security></tt:Device>` +
      `<tt:Media><tt:XAddr>${xaddr(d, 'media_service')}</tt:XAddr><tt:StreamingCapabilities><tt:RTPMulticast>false</tt:RTPMulticast><tt:RTP_TCP>true</tt:RTP_TCP><tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP></tt:StreamingCapabilities></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`);
    case 'GetServices': return ok(`<tds:GetServicesResponse><tds:Service><tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace><tds:XAddr>${xaddr(d, 'device_service')}</tds:XAddr><tds:Version><tt:Major>2</tt:Major><tt:Minor>60</tt:Minor></tds:Version></tds:Service><tds:Service><tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace><tds:XAddr>${xaddr(d, 'media_service')}</tds:XAddr><tds:Version><tt:Major>2</tt:Major><tt:Minor>60</tt:Minor></tds:Version></tds:Service></tds:GetServicesResponse>`);
    case 'GetServiceCapabilities':
      if (/media\/wsdl/.test(xml)) return ok('<trt:GetServiceCapabilitiesResponse><trt:Capabilities SnapshotUri="true" Rotation="false" VideoSourceMode="false" OSD="false"><trt:ProfileCapabilities MaximumNumberOfProfiles="2"/><trt:StreamingCapabilities RTPMulticast="false" RTP_TCP="true" RTP_RTSP_TCP="true" NonAggregateControl="false"/></trt:Capabilities></trt:GetServiceCapabilitiesResponse>');
      return ok('<tds:GetServiceCapabilitiesResponse><tds:Capabilities><tds:Network IPFilter="false" ZeroConfiguration="false" IPVersion6="false" DynDNS="false" NTP="0"/><tds:Security UsernameToken="true" HttpDigest="true"/><tds:System DiscoveryResolve="false" DiscoveryBye="true" RemoteDiscovery="false" SystemBackup="false" SystemLogging="false" FirmwareUpgrade="false"/></tds:Capabilities></tds:GetServiceCapabilitiesResponse>');
    case 'GetDeviceInformation': return ok(`<tds:GetDeviceInformationResponse><tds:Manufacturer>Sonor</tds:Manufacturer><tds:Model>Site Rig HDMI</tds:Model><tds:FirmwareVersion>${esc(d.version)}</tds:FirmwareVersion><tds:SerialNumber>${esc(d.serial)}</tds:SerialNumber><tds:HardwareId>${esc(d.board || 'Raspberry Pi')}</tds:HardwareId></tds:GetDeviceInformationResponse>`);
    case 'GetScopes': return ok(`<tds:GetScopesResponse>${scopes(d).map((u) => `<tds:Scopes><tt:ScopeDef>Fixed</tt:ScopeDef><tt:ScopeItem>${esc(u)}</tt:ScopeItem></tds:Scopes>`).join('')}</tds:GetScopesResponse>`);
    case 'GetHostname': return ok(`<tds:GetHostnameResponse><tds:HostnameInformation><tt:FromDHCP>false</tt:FromDHCP><tt:Name>${esc(d.hostname)}</tt:Name></tds:HostnameInformation></tds:GetHostnameResponse>`);
    case 'GetNetworkInterfaces': return ok(`<tds:GetNetworkInterfacesResponse><tds:NetworkInterfaces token="eth0"><tt:Enabled>true</tt:Enabled><tt:Info><tt:Name>eth0</tt:Name><tt:HwAddress>${esc(d.mac)}</tt:HwAddress><tt:MTU>1500</tt:MTU></tt:Info><tt:IPv4><tt:Enabled>true</tt:Enabled><tt:Config><tt:FromDHCP><tt:Address>${esc(d.ip)}</tt:Address><tt:PrefixLength>${d.prefix || 24}</tt:PrefixLength></tt:FromDHCP><tt:DHCP>true</tt:DHCP></tt:Config></tt:IPv4></tds:NetworkInterfaces></tds:GetNetworkInterfacesResponse>`);
    case 'GetDNS': return ok('<tds:GetDNSResponse><tds:DNSInformation><tt:FromDHCP>true</tt:FromDHCP></tds:DNSInformation></tds:GetDNSResponse>');
    case 'GetNTP': return ok('<tds:GetNTPResponse><tds:NTPInformation><tt:FromDHCP>true</tt:FromDHCP></tds:NTPInformation></tds:GetNTPResponse>');
    case 'GetNetworkProtocols': return ok(`<tds:GetNetworkProtocolsResponse><tds:NetworkProtocols><tt:Name>HTTP</tt:Name><tt:Enabled>true</tt:Enabled><tt:Port>${d.httpPort}</tt:Port></tds:NetworkProtocols><tds:NetworkProtocols><tt:Name>RTSP</tt:Name><tt:Enabled>true</tt:Enabled><tt:Port>${d.rtspPort}</tt:Port></tds:NetworkProtocols></tds:GetNetworkProtocolsResponse>`);
    case 'GetDiscoveryMode': return ok('<tds:GetDiscoveryModeResponse><tds:DiscoveryMode>Discoverable</tds:DiscoveryMode></tds:GetDiscoveryModeResponse>');
    case 'GetUsers': return ok(`<tds:GetUsersResponse><tds:User><tt:Username>${esc(d.user || 'admin')}</tt:Username><tt:UserLevel>Administrator</tt:UserLevel></tds:User></tds:GetUsersResponse>`);
    case 'GetRelayOutputs': return ok('<tds:GetRelayOutputsResponse/>');
    case 'GetProfiles': return ok(`<trt:GetProfilesResponse>${profilesOf(d).map((p) => profile(d, p)).join('')}</trt:GetProfilesResponse>`);
    case 'GetProfile': { const p = pick(d, xml); return p ? ok(`<trt:GetProfileResponse>${profile(d, p, 'trt:Profile')}</trt:GetProfileResponse>`) : noProfile(); }
    case 'GetVideoSources': return ok(`<trt:GetVideoSourcesResponse><trt:VideoSources token="HDMI_1"><tt:Framerate>${s.fps}</tt:Framerate><tt:Resolution><tt:Width>${s.w}</tt:Width><tt:Height>${s.h}</tt:Height></tt:Resolution></trt:VideoSources></trt:GetVideoSourcesResponse>`);
    case 'GetVideoSourceConfigurations': return ok(`<trt:GetVideoSourceConfigurationsResponse>${vsc(d).replace(/tt:VideoSourceConfiguration /, 'trt:Configurations ').replace(/<\/tt:VideoSourceConfiguration>$/, '</trt:Configurations>')}</trt:GetVideoSourceConfigurationsResponse>`);
    case 'GetVideoSourceConfiguration': return ok(`<trt:GetVideoSourceConfigurationResponse>${vsc(d).replace(/tt:VideoSourceConfiguration /, 'trt:Configuration ').replace(/<\/tt:VideoSourceConfiguration>$/, '</trt:Configuration>')}</trt:GetVideoSourceConfigurationResponse>`);
    case 'GetVideoEncoderConfigurations': return ok(`<trt:GetVideoEncoderConfigurationsResponse>${profilesOf(d).map((p) => vec(p, 'trt:Configurations')).join('')}</trt:GetVideoEncoderConfigurationsResponse>`);
    case 'GetCompatibleVideoEncoderConfigurations': { const p = pick(d, xml); return ok(`<trt:GetCompatibleVideoEncoderConfigurationsResponse>${(p ? [p] : profilesOf(d)).map((x) => vec(x, 'trt:Configurations')).join('')}</trt:GetCompatibleVideoEncoderConfigurationsResponse>`); }
    case 'GetVideoEncoderConfiguration': { const t = tag(xml, 'ConfigurationToken'); const p = profilesOf(d).find((x) => 'VEC_' + x.token === t) || profilesOf(d)[0]; return ok(`<trt:GetVideoEncoderConfigurationResponse>${vec(p, 'trt:Configuration')}</trt:GetVideoEncoderConfigurationResponse>`); }
    case 'GetVideoEncoderConfigurationOptions': {
      const res = profilesOf(d).map((p) => `<tt:ResolutionsAvailable><tt:Width>${p.w}</tt:Width><tt:Height>${p.h}</tt:Height></tt:ResolutionsAvailable>`).join('');
      return ok(`<trt:GetVideoEncoderConfigurationOptionsResponse><trt:Options><tt:QualityRange><tt:Min>1</tt:Min><tt:Max>5</tt:Max></tt:QualityRange><tt:H264>${res}<tt:GovLengthRange><tt:Min>1</tt:Min><tt:Max>120</tt:Max></tt:GovLengthRange><tt:FrameRateRange><tt:Min>1</tt:Min><tt:Max>${s.fps}</tt:Max></tt:FrameRateRange><tt:EncodingIntervalRange><tt:Min>1</tt:Min><tt:Max>1</tt:Max></tt:EncodingIntervalRange><tt:H264ProfilesSupported>Baseline</tt:H264ProfilesSupported></tt:H264></trt:Options></trt:GetVideoEncoderConfigurationOptionsResponse>`);
    }
    case 'GetStreamUri': { const p = pick(d, xml); return p ? ok(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>${esc(streamUri(d, p))}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>`) : noProfile(); }
    case 'GetSnapshotUri': { const p = pick(d, xml); return p ? ok(`<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>${esc(snapUri(d, p))}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetSnapshotUriResponse>`) : noProfile(); }
    case 'GetAudioSources': return ok('<trt:GetAudioSourcesResponse/>');
    case 'GetAudioEncoderConfigurations': return ok('<trt:GetAudioEncoderConfigurationsResponse/>');
    case 'GetAudioSourceConfigurations': return ok('<trt:GetAudioSourceConfigurationsResponse/>');
    default: return { status: 400, xml: fault('Sender', 'ter:ActionNotSupported', `${act} is not supported`), action: act };
  }
}
const noProfile = () => ({ status: 400, xml: fault('Sender', 'ter:NoProfile', 'No such profile') });

// ── WS-Discovery (UDP 3702, multicast 239.255.255.250) ──
function scopes(d) {
  const n = String(d.name || 'Site Rig HDMI').replace(/\s+/g, '_');
  return ['onvif://www.onvif.org/type/video_encoder', 'onvif://www.onvif.org/type/Network_Video_Transmitter', 'onvif://www.onvif.org/Profile/Streaming',
    `onvif://www.onvif.org/name/${encodeURIComponent(n)}`, 'onvif://www.onvif.org/hardware/Sonor_Site_Rig_HDMI', 'onvif://www.onvif.org/location/site'];
}
const DNS = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl"';
function isProbe(x) {
  x = String(x); if (!/:Probe[\s>]|<Probe[\s>]/.test(x) || /ProbeMatches/.test(x)) return false;
  const types = tag(x, 'Types');
  return !types || /NetworkVideoTransmitter|Device/.test(types);
}
const msgId = (x) => tag(x, 'MessageID') || '';
function probeMatches(d, probe, ip) {
  const xa = ip ? `http://${ip}:${d.httpPort}/onvif/device_service` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${DNS}><s:Header><a:MessageID>uuid:${crypto.randomUUID()}</a:MessageID><a:RelatesTo>${esc(msgId(probe))}</a:RelatesTo><a:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:To><a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</a:Action></s:Header>` +
    `<s:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:${d.uuid}</a:Address></a:EndpointReference><d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types><d:Scopes>${scopes(d).map(esc).join(' ')}</d:Scopes><d:XAddrs>${xa}</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`;
}
function hello(d, ip, bye = false) {
  const act = bye ? 'Bye' : 'Hello';
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${DNS}><s:Header><a:MessageID>uuid:${crypto.randomUUID()}</a:MessageID><a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To><a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/${act}</a:Action></s:Header>` +
    `<s:Body><d:${act}><a:EndpointReference><a:Address>urn:uuid:${d.uuid}</a:Address></a:EndpointReference>${bye ? '' : `<d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types><d:Scopes>${scopes(d).map(esc).join(' ')}</d:Scopes><d:XAddrs>http://${ip}:${d.httpPort}/onvif/device_service</d:XAddrs>`}<d:MetadataVersion>1</d:MetadataVersion></d:${act}></s:Body></s:Envelope>`;
}

module.exports = { action, tag, wsseOk, wsseHeader, handle, isProbe, probeMatches, hello, scopes, PRE_AUTH, env };
