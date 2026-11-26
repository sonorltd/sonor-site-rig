# APP - Site Rig (sonor-site-rig) · v1.1.0

> Current version: 1.1.0 (2026-11-26). `VERSION` in index.html (build page) and `RIG_VERSION` in install-rig.sh (the rig itself) move together.

The Raspberry Pi in the van: build page (parts, flashing, one-line install, wiring, pairing), the Pi installer, and the rig's home server. It runs the Network Scanner, Remotes and HDMI Capture behind its own hotspot for the tablet.

## Spine / platform
- Spine version: none on purpose. The build page is a self-contained gold page in the ArtNet Node style, and the rig server is Node built-ins only (it must work with no internet). Brand override recorded here: own inline styles, 2026-11-24.
- Hub group **android**; favicon = `data/favicon.svg` (the android tile, synced; linked since 1.0.1). TSV key `site-rig`, isolation family.
- No sign-in of its own: the build page sits behind the gateway; `/dl/sonor-site-rig/` serves the installer without a login (gateway `DOWNLOADS` + a Cloudflare Access bypass for `/dl`).

## Shared seams
- Hosts APP - Network Scanner (8050) and APP - Remotes (8049); their data rules apply (`net_scans` uploads carry the engineer).
- `lib/sitelog.js` = the shared `sonor-sitelog.js` (synced by sync-everything). HDMI Capture logs through it (`app: 'site-rig'`, `tool: 'hdmi'`, `/api/log*` on :8056, off by default). Notice 2026-11-25 closed for HDMI Capture.
- HDMI Capture (`rig/capture/`, :8056) speaks to other Sonor kit, not just people: ONVIF Profile S (NVRs), the Hikvision ISAPI slice + SADP that `sonor-c4-cameras` (Sonor Hikvision Camera driver) uses, RTSP paths `Streaming/Channels/101|102`. Change those only with the camera driver thread. The driver's Find on Network takes the HTTP port from SADP `HttpPort`: keep 8056 there. Driver harness section 6b fakes the rig (306 checks, 2026-11-26). Design + test record: `docs/HDMI-CAPTURE.md`.
- mediamtx is pinned in install-rig.sh (`MEDIAMTX_VERSION`); config keys are written by `pipeline.js mediamtxYml()`, re-check them when bumping it.
- `app_versions` row `site-rig` is updated by hand each bump (the page has no database code).

## Rules
- Never overwrite /etc/sonor-rig/config.json (the hotspot PSK lives there). Scanner data stays on the rig except net_scans uploads.
- Regenerate rig/preview.html after changing page() in rig/server.js.
- HDMI Capture settings are dropdowns only (sizes / fps / bitrates from `pipeline.js`); the camera login is generated on the rig, never typed. Run `node --test test/*.test.js` before pushing.
- Pushed by Bryn from the Mac with the one push block.

## Timeline
- 1.1.0 (2026-11-26): HDMI Capture: USB HDMI dongle → RTSP H.264 (mediamtx v1.21.4), ONVIF + WS-Discovery for Hik / Dahua NVRs, Hikvision ISAPI slice + SADP for the Sonor C4 camera driver, WebRTC preview page with demo, no-picture detection, site log; rig home tile + /onvif /ISAPI pass-through on :80; build page HDMI tab; installer adds ffmpeg, v4l-utils, mediamtx, optional TC358743.
- 1.0.1 (2026-11-26): favicon linked, CLAUDE.md sections, page version level with the installer.
- 1.0.0 (2026-11-24): first build; gateway 1.16.0 /dl/ installer route.
