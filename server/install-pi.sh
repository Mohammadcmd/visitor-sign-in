#!/bin/bash
# Installs Visitor Sign-In on a Raspberry Pi for screenless sign-in (server/README.md).
# Raspberry Pi OS 12 (Bookworm) or newer, connected to the internet:
#   curl -fsSL @SITE@downloads/install-pi.sh | sudo bash
# Run it again to update. The records (/var/lib/visitor-sign-in) are kept.
# VSI_NAME="Front desk" sets the name shown in the admin screen.
set -euo pipefail
SITE="${VSI_SITE:-@SITE@}"
APP=/opt/visitor-sign-in
DATA=/var/lib/visitor-sign-in

if [ "$(id -u)" != 0 ]; then echo "Please run it with sudo."; exit 1; fi

echo "== Node.js"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y unzip >/dev/null
NODE="$(command -v node)"

echo "== Visitor Sign-In"
id visitorsignin >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin visitorsignin
mkdir -p "$DATA" && chown visitorsignin: "$DATA" && chmod 700 "$DATA"
WORK="$(mktemp -d)"
curl -fsSL "${SITE}downloads/visitor-sign-in-server.zip" -o "$WORK/server.zip"
unzip -q "$WORK/server.zip" -d "$WORK/app"
rm -rf "$APP.old"
if [ -d "$APP" ]; then mv "$APP" "$APP.old"; fi
mv "$WORK/app" "$APP"
rm -rf "$WORK" "$APP.old"

cat > /etc/systemd/system/visitor-sign-in.service <<UNIT
[Unit]
Description=Visitor Sign-In (records for screenless sign-in)
After=network-online.target
Wants=network-online.target

[Service]
User=visitorsignin
ExecStart=$NODE $APP/server/visitor-server.mjs --data $DATA --site $SITE${VSI_NAME:+ --name "$VSI_NAME"}
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
echo "Open this setup link on the computer or tablet you'll use for the admin screen (keep it private):"
sudo -u visitorsignin "$NODE" "$APP/server/visitor-server.mjs" --data "$DATA" --site "$SITE" --print-link
echo
echo "Check on it: systemctl status visitor-sign-in   ·   journalctl -u visitor-sign-in -f"
