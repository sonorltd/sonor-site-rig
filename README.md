# Sonor Site Rig (v1.0.0)

A Raspberry Pi that lives in the van. Its Ethernet goes into the site switch, it makes its own Wi-Fi hotspot, and the tablet uses the Network Scanner and Remotes through it.

- Build page: `index.html` at apps.sonor.co.uk/sonor-site-rig. It covers the parts list, flashing, the one-line install, wiring, pairing and testing.
- Installer: `install-rig.sh`. Run it with `curl -fsSL "https://apps.sonor.co.uk/dl/sonor-site-rig/install-rig.sh?v=$(date +%s)" | sudo bash`. Running it again updates the rig. Settings in `/etc/sonor-rig/config.json` are kept, and new defaults go to `config.json.new`.
- Rig home page: `rig/server.js` serves http://10.77.0.1 on port 80. It shows status, a tile for each tool and an Update button. `rig/preview.html` is the same page with sample data, built with `node -e "require('./rig/server.js').page(...)"`.
- Services: `sonor-rig-home` (:80), `sonor-rig-scanner` (:8050) and `sonor-rig-remotes` (:8049). The hotspot is the NetworkManager connection `sonor-rig-ap` (10.77.0.1/24, shared).
