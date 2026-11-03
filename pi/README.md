# Raspberry Pi: the local home base

The Raspberry Pi keeps **all visitor records inside the building**. Nothing is sent to the internet or any cloud service.

- **It stores everything:** visitors, visits, badges and photos, in a database on the Pi.
- **It's the tablet's server:** the sign-in tablet talks to the Pi over your local network.
- **It's a sign-out station:** a USB NFC reader on the Pi signs a visitor out the moment they tap their badge. No screen is needed.
- **It hosts the records dashboard:** any computer on the office network opens it in a browser, behind the admin PIN. Visits and visitors download as Excel/CSV files.
- **It backs up every night** to a shared folder on an office computer or NAS.

```
 Tablet (Android app)  ──office network──▶  Raspberry Pi  ◀── USB NFC reader (tap to sign out)
                                             • database + photos
 Office computers  ──browser──▶  dashboard   • nightly backup ──▶ shared folder (office PC / NAS)
```

The Pi only uses a little of its power, so it can keep doing other jobs too.

## What you need

| Item | Notes |
|---|---|
| Raspberry Pi | Pi 4 or Pi 5 recommended (a Pi 3B+ works), with its official power supply. |
| microSD card | 32 GB or larger, a good brand (it holds the records). |
| USB NFC reader | A generic "keyboard" reader, the same kind as the tablet's. It goes in any USB port. |
| Network | An Ethernet cable is best; Wi-Fi works. The tablet must be on the same network. |
| A shared folder | On an office computer or NAS, for the nightly backup. |

## 1. Prepare the Pi

1. On any computer, install **Raspberry Pi Imager** and write **Raspberry Pi OS Lite (64-bit)** to the card.
2. Before writing, open Imager's settings:
   - **Hostname:** `shocktech-rehtekpro` (the installer sets it anyway)
   - **Enable SSH**
   - **Username and password**
   - **Wi-Fi**, if you're not using a cable
3. Put the card in the Pi, connect it to the network, and power it on.
4. **Give the Pi a fixed address** in your router: look for "DHCP reservation" or "static lease". The tablet then always finds it.

## 2. Install the visitor server

Connect to the Pi with SSH (`ssh <username>@shocktech-rehtekpro.local`), or plug in a keyboard and screen for setup. Then run:

```bash
sudo apt-get install -y git
git clone https://github.com/Mohammadcmd/visitor-sign-in.git
cd visitor-sign-in/pi
sudo ./install.sh
```

A few notes:
- The repository is private, so `git clone` asks for your GitHub username and a **personal access token** (GitHub → Settings → Developer settings → Personal access tokens) instead of a password. Or copy the `pi` folder over on a USB stick.
- The installer asks you to **choose the admin PIN** (6 to 8 digits). It opens both the tablet's admin screen and the dashboard.
- At the end it prints the **dashboard address**, the **tablet address** and the **kiosk key**. Keep that screen handy for step 4.

## 3. Nightly backup to a shared folder

The memory card is the only copy of the records until this is set up.

1. **On the office computer or NAS:** create a shared folder (for example `VisitorBackup`) and an account that can write to it.
2. **On the Pi**, save that account's details where only the Pi's administrator can read them:

   ```bash
   sudo tee /etc/visitor-pi/backup-credentials >/dev/null <<'EOF'
   username=BACKUP_USER
   password=BACKUP_PASSWORD
   EOF
   sudo chmod 600 /etc/visitor-pi/backup-credentials
   ```

3. Tell the Pi to mount the share at boot. Replace `OFFICE-PC` with the computer's name or IP address:

   ```bash
   sudo mkdir -p /mnt/visitor-backup
   echo '//OFFICE-PC/VisitorBackup /mnt/visitor-backup cifs credentials=/etc/visitor-pi/backup-credentials,uid=visitor-pi,gid=visitor-pi,file_mode=0660,dir_mode=0770,nofail,x-systemd.automount 0 0' | sudo tee -a /etc/fstab
   sudo systemctl daemon-reload
   ls /mnt/visitor-backup   # should list the shared folder (empty is fine)
   ```

4. Open the dashboard and click **Back up now** on the Overview page. The Last backup card should turn green.

**What's kept:**
- Every night at 2 AM (change `backup_hour` in `/etc/visitor-pi/config.json`), the share gets `database/visitors-YYYY-MM-DD.db`, with the last 30 nights kept, plus a `photos/` folder mirroring every visitor photo.
- If the share isn't mounted, the backup **refuses to run** rather than copying onto the Pi's own card, and the dashboard shows why.

## 4. Connect the tablet

On the tablet, go to admin → **Settings** → **5. Connection**. Enter the address `http://<pi address>/api` and the kiosk key the installer printed, then tap **Save and reconnect**. The status line should read **Connected to the Raspberry Pi**.

If you'd rather not type them: add `KIOSK_API_URL` and `KIOSK_KEY` as GitHub secrets, then rebuild the app as described in [android/README.md](../android/README.md).

## 5. The Pi's badge reader

- Plug the USB NFC reader into the Pi.
- **The first badge you tap teaches the Pi which device is the reader.** After that, its taps never reach the Pi's own console.
- From then on, a visitor tapping their badge on the Pi is signed out, and the badge is free for the next guest.
- Most readers beep on every read. That beep is the only feedback, since the Pi has no screen.
- A mistaken tap can be undone from the dashboard (Overview → Signed out in the last 30 minutes → **Undo**).
- To watch taps as they happen: `journalctl -u visitor-pi -f`

## The dashboard

Open **http://shocktech-rehtekpro.local** on any office computer and enter the admin PIN. It works on Windows 10/11, Macs, iPhones and iPads with no setup, because the Pi announces that name on the network itself. If a computer can't find it, use the Pi's number address instead: `http://<pi address>`.

To use a different name, run the installer with it. Use letters, digits and hyphens only: `sudo VISITOR_PI_NAME=visitors ./install.sh` gives `http://visitors.local`.

| Tab | What it shows |
|---|---|
| **Overview** | Who's inside now, with a sign-out button for each. Recent sign-outs, with Undo. Today's numbers. Last backup, with **Back up now**. |
| **Visits** | Every visit, filtered by date and searchable, with **Download for Excel (CSV)**. |
| **Visitors** | Everyone on file, with their latest photo, citizenship, quick entry and visit count, plus **Download for Excel (CSV)**. |
| **Badges** | Every badge and who holds it. Badges are added from the tablet. |

## Updating

```bash
cd visitor-sign-in && git pull && cd pi && sudo ./install.sh
```

Records, settings and the PIN are kept.

## Security notes

- **Keep it on the office network.** Never forward the Pi's port 80 on your router to the internet.
- **Traffic isn't encrypted** inside the office network: the dashboard and tablet use plain `http`. That's normal for a device that never leaves the building. Use a trusted network (not a guest Wi-Fi) for the Pi and tablet.
- **The tablet needs the kiosk key to talk to the Pi,** and the dashboard needs the admin PIN. After 10 wrong PINs, entry pauses for 10 minutes.
- **The records include visitors' photos and citizenship.** Treat the Pi and the backup share like any personnel file.

## Troubleshooting

| Problem | Fix |
|---|---|
| Tablet says "We couldn't reach the server" | Check that the Pi is on and has the address the tablet uses (`hostname -I` on the Pi). Check that the tablet is on the same network. |
| Badge taps on the Pi do nothing | `journalctl -u visitor-pi -f` while tapping. "listening on …" should name the reader. If not, unplug and replug it. Check that the badge was added on the tablet first. |
| Backup card is red | Read its message. Usually the shared folder isn't mounted: `ls /mnt/visitor-backup`, check the PC is on, and check the user name and password in `/etc/visitor-pi/backup-credentials`. |
| Forgot the admin PIN | On the Pi: `cd /opt/visitor-pi && sudo -u visitor-pi python3 -m visitor_pi set-pin` |
| Need the kiosk key again | `cd /opt/visitor-pi && sudo -u visitor-pi python3 -m visitor_pi show-key` |

## For developers

```bash
cd pi && python3 -m unittest discover -s tests       # tests
python3 -m visitor_pi serve --config ./dev.json      # run locally (dev.json: {"data_dir": "./data", "port": 8090})
```

The server is plain Python 3 (standard library only, plus `python3-evdev` for the reader). It answers the `/api` actions the tablet app calls through `web/js/api.js`.
