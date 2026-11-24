# APP - Site Rig (sonor-site-rig)
- Pages-served build page (gold ArtNet-style) + Pi installer + rig home server. Node built-ins only, no deps.
- Never overwrite /etc/sonor-rig/config.json (hotspot PSK lives there). Scanner data stays on the rig except net_scans uploads.
- Version: RIG_VERSION in install-rig.sh, APP version line in index.html header. Regenerate rig/preview.html after changing page() in rig/server.js.
- Pushed by Bryn from the Mac with the one git-push block.
