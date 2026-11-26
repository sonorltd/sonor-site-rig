#!/usr/bin/env bash
# Sonor Site Rig: turns a Raspberry Pi (Pi OS Lite 64-bit, Bookworm or later) into the engineers' site box.
#   curl -fsSL "https://apps.sonor.co.uk/dl/sonor-site-rig/install-rig.sh?v=$(date +%s)" | sudo bash
# Re-running it IS the updater (pages-one-line-installer pattern). It never overwrites /etc/sonor-rig/config.json;
# new defaults go to config.json.new.
#
# What you get:
#   - Wi-Fi hotspot SONOR-RIG-<xx> on wlan0 (10.77.0.1/24, DHCP + NAT out of eth0) for the tablet
#   - eth0 = plug into the site switch (DHCP client): the rig sees the site LAN, the tablet sees the rig
#   - Network Scanner agent  :8050   (sonor-net-scanner)
#   - Remotes bridge         :8049   (sonor-remotes)
#   - HDMI capture           :8056   (sonor-rig-capture: USB HDMI dongle → RTSP :554 + ONVIF + WebRTC preview; NVR / Control4 camera)
#   - Rig home page          :80     (status, links, update button)
# Optional, for a TC358743 HDMI-to-CSI board instead of a USB dongle (Pi 4; reboot after):
#   curl -fsSL "https://apps.sonor.co.uk/dl/sonor-site-rig/install-rig.sh?v=$(date +%s)" | sudo RIG_HDMI_BRIDGE=tc358743 bash
set -euo pipefail
RIG_VERSION=1.1.0
MEDIAMTX_VERSION=v1.21.4
BASE=/opt/sonor-rig
CFG=/etc/sonor-rig
BRANCH=main
APPS=(sonor-net-scanner:8050 sonor-remotes:8049)
say() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo (… | sudo bash)"; exit 1; }
. /etc/os-release || true
[ "${ID:-}" = "debian" ] || [ "${ID:-}" = "raspbian" ] || echo "Warning: not Raspberry Pi OS / Debian (${PRETTY_NAME:-unknown}); carrying on."

say "Packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar network-manager iw >/dev/null
# HDMI capture: ffmpeg (capture + H.264), v4l-utils (find the dongle, TC358743 EDID), alsa-utils (dongle audio)
apt-get install -y -qq ffmpeg v4l-utils alsa-utils >/dev/null || echo "ffmpeg / v4l-utils could not be installed: HDMI capture will not start"
if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 18 ]; then
  apt-get install -y -qq nodejs >/dev/null || true
fi
command -v node >/dev/null || { echo "Node.js 18+ could not be installed"; exit 1; }
# Network Scanner Traffic tab: live capture with tshark (dumpcap runs with capabilities; the service user joins the wireshark group)
echo "wireshark-common wireshark-common/install-setuid boolean true" | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tshark tcpdump >/dev/null || echo "tshark could not be installed: the Traffic tab falls back to tcpdump"

say "Config"
mkdir -p "$CFG" "$BASE"
SERIAL=$(awk '/Serial/{print $3}' /proc/cpuinfo 2>/dev/null | tail -c 5 | tr a-f A-F || true)
SUFFIX=${SERIAL:-$(tr -dc 'A-F0-9' </dev/urandom | head -c4)}
DEFAULT=$(cat <<JSON
{
  "name": "Site Rig ${SUFFIX}",
  "ssid": "SONOR-RIG-${SUFFIX}",
  "psk": "$(tr -dc 'a-hjkmnp-z2-9' </dev/urandom | head -c 12)",
  "subnet": "10.77.0.1/24",
  "band": "bg",
  "channel": 6,
  "apps": ["sonor-net-scanner", "sonor-remotes"]
}
JSON
)
if [ -f "$CFG/config.json" ]; then echo "$DEFAULT" > "$CFG/config.json.new"; echo "Kept your config.json (new defaults in config.json.new)"; else echo "$DEFAULT" > "$CFG/config.json"; chmod 600 "$CFG/config.json"; fi
j() { node -e "const c=require('$CFG/config.json');console.log(c['$1'])"; }
SSID=$(j ssid); PSK=$(j psk); SUBNET=$(j subnet); BAND=$(j band); CHAN=$(j channel)

say "Hotspot $SSID on wlan0"
if iw dev 2>/dev/null | grep -q wlan0; then
  nmcli -t -f NAME con show | grep -qx sonor-rig-ap && nmcli con delete sonor-rig-ap >/dev/null || true
  nmcli con add type wifi ifname wlan0 con-name sonor-rig-ap autoconnect yes ssid "$SSID" \
    802-11-wireless.mode ap 802-11-wireless.band "$BAND" 802-11-wireless.channel "$CHAN" \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PSK" ipv4.method shared ipv4.addresses "$SUBNET" ipv6.method disabled >/dev/null
  nmcli con up sonor-rig-ap >/dev/null || echo "Hotspot will start on next boot"
else echo "No wlan0: skipping the hotspot (plug the tablet into the same switch instead)"; fi

say "Apps"
fetch() { # $1 repo  → $BASE/$1 (keeps that app's own data/config files)
  local repo=$1 tmp; tmp=$(mktemp -d)
  if curl -fsSL "https://codeload.github.com/sonorltd/$repo/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$tmp" --strip-components=1; then
    mkdir -p "$BASE/$repo"
    (cd "$tmp" && tar --exclude=scans --exclude=boxes.json --exclude=devices.json --exclude=relay.json --exclude=remote.json -cf - .) | tar -xf - -C "$BASE/$repo"
    echo "  $repo ✓"
  else echo "  $repo: could not download (private repo or no internet). Skipped."; fi
  rm -rf "$tmp"
}
for a in "${APPS[@]}"; do fetch "${a%%:*}"; done
fetch sonor-site-rig

say "RTSP server (mediamtx $MEDIAMTX_VERSION)"
case "$(uname -m)" in aarch64|arm64) MTX_ARCH=arm64 ;; armv7l) MTX_ARCH=armv7 ;; armv6l) MTX_ARCH=armv6 ;; x86_64) MTX_ARCH=amd64 ;; *) MTX_ARCH="" ;; esac
if [ -n "$MTX_ARCH" ] && [ "$(cat "$BASE/mediamtx/VERSION" 2>/dev/null)" != "$MEDIAMTX_VERSION" ]; then
  tmp=$(mktemp -d)
  if curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/$MEDIAMTX_VERSION/mediamtx_${MEDIAMTX_VERSION}_linux_${MTX_ARCH}.tar.gz" | tar -xz -C "$tmp"; then
    mkdir -p "$BASE/mediamtx"; install -m 755 "$tmp/mediamtx" "$BASE/mediamtx/mediamtx"; echo "$MEDIAMTX_VERSION" > "$BASE/mediamtx/VERSION"; echo "  mediamtx $MEDIAMTX_VERSION ✓"
  else echo "  mediamtx could not be downloaded: HDMI capture has no RTSP server until the next update"; fi
  rm -rf "$tmp"
else echo "  mediamtx ${MEDIAMTX_VERSION} already here"; fi
if [ "${RIG_HDMI_BRIDGE:-}" = "tc358743" ]; then
  BOOTCFG=/boot/firmware/config.txt; [ -f "$BOOTCFG" ] || BOOTCFG=/boot/config.txt
  grep -q '^dtoverlay=tc358743' "$BOOTCFG" || { printf '\n# Sonor Site Rig: HDMI-to-CSI bridge\ndtoverlay=tc358743\n' >> "$BOOTCFG"; echo "  TC358743 overlay added to $BOOTCFG: reboot the Pi once the install finishes"; }
fi
id -u sonorrig >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin sonorrig
getent group wireshark >/dev/null 2>&1 && usermod -aG wireshark sonorrig
usermod -aG video,audio sonorrig 2>/dev/null || true
mkdir -p /var/lib/sonor-rig/capture
DC=$(command -v dumpcap || true); [ -n "$DC" ] && setcap cap_net_raw,cap_net_admin=eip "$DC" 2>/dev/null || true
chown -R sonorrig:sonorrig "$BASE" /var/lib/sonor-rig

unit() { # name port dir entry extra-env
  cat > "/etc/systemd/system/$1.service" <<UNIT
[Unit]
Description=Sonor Site Rig: $1
After=network-online.target
Wants=network-online.target
[Service]
User=sonorrig
WorkingDirectory=$3
Environment=PORT=$2
$5
ExecStart=$(command -v node) $3/$4
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_RAW
[Install]
WantedBy=multi-user.target
UNIT
}
[ -f "$BASE/sonor-net-scanner/server.js" ] && unit sonor-rig-scanner 8050 "$BASE/sonor-net-scanner" server.js "Environment=NETSCAN_DATA=$CFG/scans"
[ -f "$BASE/sonor-remotes/server.js" ] && unit sonor-rig-remotes 8049 "$BASE/sonor-remotes" server.js "Environment=SKY_RELAY=1
Environment=SKY_RELAY_NAME=$(j name)"
[ -f "$BASE/sonor-site-rig/rig/server.js" ] && unit sonor-rig-home 80 "$BASE/sonor-site-rig/rig" server.js "Environment=RIG_CONFIG=$CFG/config.json
Environment=RIG_VERSION=$RIG_VERSION"
 [ -f "$BASE/sonor-site-rig/rig/capture/capture.js" ] && unit sonor-rig-capture 8056 "$BASE/sonor-site-rig/rig/capture" capture.js "Environment=CAPTURE_DATA=/var/lib/sonor-rig/capture
Environment=RIG_CONFIG=$CFG/config.json
Environment=MEDIAMTX=$BASE/mediamtx/mediamtx
Environment=RIG_VERSION=$RIG_VERSION
SupplementaryGroups=video audio"
mkdir -p "$CFG/scans"; chown -R sonorrig:sonorrig "$CFG/scans"
# old single-app installs on this Pi make way for the rig's units
for old in sonor-sky-remote sonor-remotes; do systemctl disable --now "$old.service" 2>/dev/null || true; done
# the rig home page's Update button runs this installer again
cat > /etc/sudoers.d/sonor-rig <<'SUDO'
sonorrig ALL=(root) NOPASSWD: /usr/local/bin/sonor-rig-update
SUDO
cat > /usr/local/bin/sonor-rig-update <<'UPD'
#!/bin/sh
# Runs in its own transient unit so restarting the rig's services mid-update doesn't kill the update itself.
exec systemd-run --unit="sonor-rig-update-$(date +%s)" --collect sh -c 'curl -fsSL "https://apps.sonor.co.uk/dl/sonor-site-rig/install-rig.sh?v=$(date +%s)" | bash > /var/log/sonor-rig-update.log 2>&1'
UPD
chmod 755 /usr/local/bin/sonor-rig-update; chmod 440 /etc/sudoers.d/sonor-rig
systemctl daemon-reload
for s in sonor-rig-scanner sonor-rig-remotes sonor-rig-capture sonor-rig-home; do [ -f "/etc/systemd/system/$s.service" ] && systemctl enable --now "$s" >/dev/null && systemctl restart "$s" || true; done

say "Done: Sonor Site Rig $RIG_VERSION"
LAN=$(ip -4 -o addr show eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true)
cat <<DONE
  Hotspot:   $SSID   password: $PSK
  Rig page:  http://10.77.0.1      (from the tablet on the hotspot)
  Site LAN:  ${LAN:-eth0 not connected}  (scanner :8050, remotes :8049, HDMI capture :8056 · RTSP :554)
  Services:  $(for s in sonor-rig-scanner sonor-rig-remotes sonor-rig-capture sonor-rig-home; do printf '%s=%s ' "$s" "$(systemctl is-active $s 2>/dev/null || echo missing)"; done)
  Update:    run the same one line again, or press Update on the rig page.
DONE
