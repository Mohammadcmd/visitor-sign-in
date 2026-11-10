# Screenless sign-in: a Raspberry Pi or PC

For a front door with no tablet. Visitors scan a QR code with their own phone and sign in there: the same questions, rules, signature and photo, and which visitor pass to take. A Raspberry Pi or a PC in the building keeps the records.

```
visitor's phone ─┐
admin screen ────┼── HTTPS ──▶ your website ── the connection the Pi keeps open ──▶ Raspberry Pi or PC (the records)
Android tablet ──┘   (optional)
```

- **No router setup and no domain.** The Pi or PC opens a connection out to your website and keeps it open, so phones on mobile data reach it too, over HTTPS (phones only allow the camera on HTTPS pages).
- **The records stay in the building**, in one folder: `records.json`, `settings.json`, photos and signatures as image files in `files/`, and a daily copy of the records in `backups/` (the last 30 days).
- **The website only passes requests along.** It checks that it's talking to your Pi with the box's secret, which the first computer to connect sets.
- It does the daily jobs a tablet would: signing everyone out at the end of the day and deleting records older than the retention period.
- **Not yet:** emails (host notifications, alerts, the daily summary). Declines and alerts show in the admin screen under Needs attention.

## A Raspberry Pi

Any Raspberry Pi 3, 4 or 5, or a Zero 2 W, with Raspberry Pi OS 12 (Bookworm) or newer and an internet connection.

1. Set up the Pi with Raspberry Pi Imager, then connect it to the internet (Ethernet is best).
2. Open a terminal on it (or `ssh` in) and run:

   ```bash
   curl -fsSL https://visitor-sign-in.mohammadjalbibi.workers.dev/downloads/install-pi.sh | sudo bash
   ```

   This installs Node.js 22 if needed and Visitor Sign-In in `/opt/visitor-sign-in`, with the records in `/var/lib/visitor-sign-in`. It also starts it now and whenever the Pi is switched on. Then it prints the **setup link**.
3. Open the setup link on the computer or tablet you'll use for the admin screen, and go through setup: company, admin PIN, numbered visitor passes, questions, rules.
4. In **Admin → Settings → Phone sign-in**, switch it on and print the poster for the door.

To update, run the same command again; the records are kept. `systemctl status visitor-sign-in` shows if it's running, and `journalctl -u visitor-sign-in -f` its messages. To name it in the admin screen, use `VSI_NAME="Front desk"` before `bash`: `… | sudo VSI_NAME="Front desk" bash`.

## A PC (Windows, Mac or Linux)

1. Install **Node.js 22 or newer** from [nodejs.org](https://nodejs.org/) (the LTS installer).
2. Download `visitor-sign-in-server.zip` from the website's Downloads page and unzip it, for example into Documents.
3. Double-click **`server/start-windows.cmd`** (Windows) or **`server/start-mac.command`** (Mac; the first time, right-click → Open). On Linux: `node server/visitor-server.mjs`.
4. It prints the setup link and keeps a window open: leave it running. The records are in a **Visitor Sign-In** folder in your home folder. Add `--data <folder>` to keep them elsewhere.
5. Open the setup link, set up, and switch on phone sign-in (steps 3 and 4 above).

So it starts by itself after a restart:
- **Windows:** press Win+R, type `shell:startup`, and put a shortcut to `start-windows.cmd` there.
- **Mac:** System Settings → General → Login Items → add `start-mac.command`.

The PC must stay on and must not go to sleep while the business is open.

## The setup link

The link contains the kiosk key: anyone with it can connect a screen to these records, and set them up before you do. Keep it private, the same as a password. After setup, the admin PIN protects the admin screen. The link is also saved as `setup-link.html` in the records folder, with a QR code, so you can scan it with a tablet. To connect another screen later: **Admin → Settings → Connect another tablet**.

## Backups and moving to a new computer

- Copy the whole records folder somewhere safe now and then (a USB stick, or a network folder). `backups/` holds a daily copy, but on the same disk.
- **To move to a new Pi or PC:** stop it, copy the folder to the new one, and start it there with `--data` pointing at the copy. It keeps the same box id, secret and kiosk key, so the QR code and connected screens keep working. Don't run both at once.
- If the folder is lost, set up again: it makes a new box, so print a new poster and open the new setup link.

## Licenses

Screenless sign-in is licensed like a QR code: the code is in **Admin → Settings → Phone sign-in** (see docs/PAYWALL.md).
