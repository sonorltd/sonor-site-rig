# HDMI Capture on the Site Rig (1.1.0, 2026-11-26)

A matrix output into the rig becomes a camera. Asked for by Sonor 2026-11-26: "an hdmi capture that takes an input from the video
matrix and encodes it as a stream we can view and potentially use remotely by adding it as a camera to the NVR".

## Hardware
- **USB 3 HDMI capture dongle, MS2130 chip** (about £20, "USB 3.0, 1080p60, loop-out"). UVC, no driver, 1080p MJPEG/YUYV to the Pi.
  USB 2 MS2109 dongles also work (1080p30 MJPEG only).
- **Pi 5** (the rig's default) has no H.264 encoder: libx264 ultrafast/zerolatency in software. Not yet measured on a rig; the page
  shows live CPU and suggests 720p / 2 Mbps above 80 %. **Pi 4** uses the hardware encoder (`h264_v4l2m2m`).
- Advanced, Pi 4: **TC358743 HDMI-to-CSI** board. Installer `RIG_HDMI_BRIDGE=tc358743` adds `dtoverlay=tc358743`; the agent loads an
  EDID and locks to the source timings (`v4l2-ctl`), UYVY in. Untested on hardware.
- HDCP-protected sources may come through black: that shows as **No picture**, not as an error.

## Software (rig/capture/, Node built-ins + ffmpeg + mediamtx)
| Part | File | What |
|---|---|---|
| Agent | `capture.js` | `sonor-rig-capture` :8056. Finds dongles (`v4l2-ctl`), runs mediamtx + one ffmpeg, restarts with back-off, settings in `/var/lib/sonor-rig/capture/capture.json` (login generated, never typed) |
| Pipeline | `pipeline.js` | pure: device / format choice, encoder choice, ffmpeg args, `mediamtx.yml` |
| ONVIF | `onvif.js` | Profile S subset + WS-Discovery (UDP 3702). WS-Security UsernameToken or HTTP Digest |
| Hikvision slice | `isapi.js` | `deviceInfo`, `channels/10x/picture`, `102/httpPreview` (MJPEG), `alertStream` (videoloss heartbeat 10 s, active while flat), SADP answers (UDP 37020) |
| Page | `www/index.html` | status, WebRTC / stills preview, Add-it-as-a-camera steps with Copy, settings (dropdowns only), site log, viewers. `?demo=1` (or any apps.sonor.co.uk / file:// load) = demo |

Streams: `rtsp://<rig>:554/Streaming/Channels/101` (main 1080p/720p, 25/30 fps, 2–6 Mbps, 2 s GOP, no B-frames) and `/102`
(640×360, 512 kbps). Hikvision-style names so the Sonor Hikvision driver, NVRs and players all find them. WebRTC :8889 for the page.

Logins: only ffmpeg on the Pi publishes; the rig hotspot (tablet) and the Pi watch without a login; everything else needs the camera
login. The rig home page (:80) passes `/onvif/` and `/ISAPI/` through to :8056 (x-forwarded-for believed only from 127.0.0.1).

No signal: ffmpeg prints the picture's low / high luma once a second (`signalstats`); 5 flat seconds = **No picture** (alert, ISAPI
videoloss active → Control4 Video Lost), 2 good seconds = Picture.

## Site log (shared `lib/sitelog.js`, app `site-rig`, tool `hdmi`)
Off by default. Session from the page: on site today (12 h) or trouble watch 1/3/7/14/30 days. Lines: source (signal, encoder,
viewer connected / left, ONVIF login refused / stream asked for, settings changed), alert (no picture, encoder stopped, CPU > 92 %),
minute (signal, flat %, viewers, CPU, temp, main kbps, restarts). On the rig only.

## How it was tested (cloud, 2026-11-26)
mediamtx v1.21.4 built from source, ffmpeg test pattern through the real agent:
- RTSP main 1080p / sub 640×360 H.264 (ffprobe); wrong password from the LAN → 401; right → plays.
- `onvif-zeep-async` (schema-checked ONVIF client): GetCapabilities, GetDeviceInformation, GetProfiles, GetStreamUri, GetSnapshotUri,
  GetVideoSources, GetVideoEncoderConfigurationOptions all parse; wrong password → NotAuthorized. Also through the :80 pass-through.
- ISAPI with curl `--digest`: deviceInfo, JPEG picture, MJPEG httpPreview, alertStream; wrong password 401.
- WS-Discovery Probe → ProbeMatches with XAddrs; SADP Probe → ProbeMatch (IPv4Address, HttpPort 8056).
- Settings change re-runs ffmpeg (1080p → 720p seen on the RTSP stream); site log session writes viewer lines.
- `node --test test/*.test.js`: 13 checks.

**Not yet proven on site:** a real dongle and Pi 5 CPU load, a Hikvision and a Dahua NVR adding it by ONVIF (search + manual),
remote viewing through Hik-Connect / DMSS, the Sonor Hikvision C4 driver direct (SADP find, videoloss events), TC358743 on a Pi 4.

## Site test plan
1. Update the rig (one line or the Update button). Rig page shows the **HDMI Capture** tile.
2. Plug the dongle in, a matrix output into it. Page: signal Picture, input 1920×1080 MJPG, CPU figure noted.
3. Pull the HDMI lead: **No picture** within ~6 s; plug back: Picture.
4. Hikvision NVR on the same LAN: Online Device List shows it; add with the page's login; check live view and Hik-Connect.
5. Dahua NVR: Device Search, add; check DMSS.
6. Composer: Sonor Hikvision Camera, direct, Find Cameras → pick it; live view on a T4; pull the HDMI lead → Video Lost event.
