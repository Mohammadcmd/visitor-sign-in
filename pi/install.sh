#!/usr/bin/env bash
# Installs (or updates) the Shock Tech visitor server on a Raspberry Pi.
#
#   cd visitor-sign-in/pi && sudo ./install.sh
#
# The Pi is named shocktech-rehtekpro, so office computers reach the dashboard at
# http://shocktech-rehtekpro.local. Choose another name with:
#   sudo VISITOR_PI_NAME=some-name ./install.sh
#
# Safe to run again after pulling a newer version: data, config and the PIN are kept.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it with sudo:  sudo ./install.sh" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/visitor-pi
DATA=/var/lib/visitor-pi
CONF_DIR=/etc/visitor-pi
CONF=$CONF_DIR/config.json
USER_NAME=visitor-pi
NAME=${VISITOR_PI_NAME:-shocktech-rehtekpro}

# A network name: letters, digits and hyphens only (no dots, spaces or underscores).
if ! [[ "$NAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "\"$NAME\" can't be a network name. Use lowercase letters, digits and hyphens, like shocktech-rehtekpro." >&2
  exit 1
fi

echo "== Installing packages"
apt-get update -qq
apt-get install -y -qq python3 python3-evdev avahi-daemon cifs-utils nfs-common >/dev/null

echo "== Naming the Pi $NAME (http://$NAME.local)"
OLD_NAME=$(hostname)
if [ "$OLD_NAME" != "$NAME" ]; then
  hostnamectl set-hostname "$NAME"
  if grep -q '^127\.0\.1\.1' /etc/hosts; then
    sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$NAME/" /etc/hosts
  else
    printf '127.0.1.1\t%s\n' "$NAME" >> /etc/hosts
  fi
fi
systemctl enable --now avahi-daemon >/dev/null
systemctl restart avahi-daemon   # announce the new .local name right away

echo "== Creating the service account"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --home "$DATA" --shell /usr/sbin/nologin "$USER_NAME"
fi
usermod -aG input "$USER_NAME"   # read the USB badge reader

echo "== Copying the server"
mkdir -p "$APP"
rm -rf "$APP/visitor_pi"
cp -r "$HERE/visitor_pi" "$APP/"
find "$APP" -name '__pycache__' -prune -exec rm -rf {} +

mkdir -p "$DATA" "$CONF_DIR"
chown "$USER_NAME:$USER_NAME" "$DATA"
chmod 750 "$DATA"
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<EOF
{
  "data_dir": "$DATA",
  "port": 80,
  "backup_dir": "/mnt/visitor-backup",
  "backup_hour": 2
}
EOF
fi
chmod 644 "$CONF"

echo "== Setting up the service"
cat > /etc/systemd/system/visitor-pi.service <<EOF
[Unit]
Description=Shock Tech visitor server
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
SupplementaryGroups=input
WorkingDirectory=$APP
Environment=VISITOR_PI_CONFIG=$CONF
ExecStart=/usr/bin/python3 -m visitor_pi serve
# Lets the server use the standard web port (80) without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$DATA -/mnt/visitor-backup

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

run_as() { sudo -u "$USER_NAME" env VISITOR_PI_CONFIG="$CONF" "$@"; }

if ! run_as python3 -c "import sys; sys.path.insert(0, '$APP'); from visitor_pi.store import Store; import json; s = Store(json.load(open('$CONF'))['data_dir']); sys.exit(0 if s.setting('admin_pin') else 1)"; then
  echo
  echo "== Choose the admin PIN (6 to 8 digits). It opens the tablet's admin screen and the dashboard."
  until (cd "$APP" && run_as python3 -m visitor_pi set-pin); do echo "Try again."; done
fi

systemctl enable --now visitor-pi.service >/dev/null
systemctl restart visitor-pi.service
sleep 2

KEY=$(cd "$APP" && run_as python3 -m visitor_pi show-key)
IP=$(hostname -I | awk '{print $1}')
PORT=$(python3 -c "import json; print(json.load(open('$CONF')).get('port', 80))")
SUFFIX=$([ "$PORT" = "80" ] && echo "" || echo ":$PORT")
echo
echo "================================================================"
echo " Visitor server is running."
echo
echo " Dashboard (office computers):  http://$NAME.local$SUFFIX"
echo "                                (or http://$IP$SUFFIX)"
echo " Tablet: admin → Settings → 5. Connection"
echo "   Address:    http://$IP$SUFFIX/api"
echo "   Kiosk key:  $KEY"
echo
echo " Give the Pi a fixed address in your router so the tablet always finds it."
echo " Status and logs:  systemctl status visitor-pi   /   journalctl -u visitor-pi -f"
echo "================================================================"
