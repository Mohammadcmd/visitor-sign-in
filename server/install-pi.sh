#!/bin/bash
# Installs Visitor Sign-In on a Raspberry Pi for screenless sign-in (server/README.md).
# Raspberry Pi OS 12 (Bookworm) or newer. From the unzipped visitor-sign-in-server folder:
#   sudo bash server/install-pi.sh
# Run it again to update from a newer folder. The records (/var/lib/visitor-sign-in) are kept.
#   VSI_NAME="Front desk"   the name shown in the admin screen
#   VSI_PORT=8080           the port of the sign-in page on the Wi-Fi
set -euo pipefail
APP=/opt/visitor-sign-in
DATA=/var/lib/visitor-sign-in
PORT="${VSI_PORT:-8080}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
SITE="${VSI_SITE:-@SITE@}"
case "$SITE" in @SITE@) SITE="";; esac

if [ "$(id -u)" != 0 ]; then echo "Please run it with sudo: sudo bash server/install-pi.sh"; exit 1; fi

echo "== Node.js"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  if ! command -v curl >/dev/null 2>&1; then apt-get update && apt-get install -y curl; fi
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE="$(command -v node)"

echo "== Visitor Sign-In"
WORK="$(mktemp -d)"
if [ -n "$HERE" ] && [ -f "$HERE/visitor-server.mjs" ] && [ -d "$HERE/../web" ]; then
  # From the unzipped folder this script is in.
  mkdir -p "$WORK/app"
  cp -r "$HERE/.." "$WORK/app/bundle"
  mv "$WORK/app/bundle" "$WORK/new"
elif [ -n "$SITE" ]; then
  apt-get install -y unzip >/dev/null
  curl -fsSL "${SITE}downloads/visitor-sign-in-server.zip" -o "$WORK/server.zip"
  unzip -q "$WORK/server.zip" -d "$WORK/new"
else
  echo "Run this from the unzipped visitor-sign-in-server folder: sudo bash server/install-pi.sh"; exit 1
fi
if [ ! -f "$WORK/new/web/package.json" ]; then echo '{ "type": "module" }' > "$WORK/new/web/package.json"; fi
id visitorsignin >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin visitorsignin
mkdir -p "$DATA" && chown visitorsignin: "$DATA" && chmod 700 "$DATA"
rm -rf "$APP.old"
if [ -d "$APP" ]; then mv "$APP" "$APP.old"; fi
mv "$WORK/new" "$APP"
rm -rf "$WORK" "$APP.old"

EXTRA="--port $PORT"
if [ -n "${VSI_SITE:-}" ]; then EXTRA="$EXTRA --site $VSI_SITE"; fi
cat > /etc/systemd/system/visitor-sign-in.service <<UNIT
[Unit]
Description=Visitor Sign-In (screenless sign-in on the Wi-Fi)
After=network-online.target
Wants=network-online.target

[Service]
User=visitorsignin
ExecStart=$NODE --disable-warning=ExperimentalWarning $APP/server/visitor-server.mjs --data $DATA $EXTRA${VSI_NAME:+ --name "$VSI_NAME"}
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable visitor-sign-in >/dev/null
systemctl restart visitor-sign-in

echo
echo "Installed. It starts by itself whenever the Pi is switched on."
echo "Open this setup link on a computer, tablet or phone on the same Wi-Fi (keep it private):"
sudo -u visitorsignin "$NODE" --disable-warning=ExperimentalWarning "$APP/server/visitor-server.mjs" --data "$DATA" $EXTRA --print-link
echo
echo "Check on it: systemctl status visitor-sign-in   ·   journalctl -u visitor-sign-in -f"
