# Screenless sign-in: a PC or Raspberry Pi on your Wi-Fi

For a front door with no tablet. Visitors scan a QR code by the door with their own phone and sign in there: the same questions, rules and signature, and which visitor pass to take. A PC or Raspberry Pi in the building keeps the records and shows the sign-in page on the building's Wi-Fi.

**No website, accounts or tokens. It works even without internet.**

```
visitor's phone ──┐
admin screen ─────┼── your Wi-Fi ──▶ PC or Raspberry Pi  http://<its address>:8080/  (the records)
Android tablet ───┘   (optional)
```

- **Visitors must be on the same Wi-Fi.** Type your guest Wi-Fi's name and password in Admin → Settings → Phone sign-in, and the poster shows two codes: one that connects the phone to the Wi-Fi, then the sign-in code.
- **No visitor photo from phones.** Phones only allow the camera on secure (https) websites, and a page on your own Wi-Fi isn't one, so phones skip the photo. Names, questions, rules, signatures and passes all work.
- **The records stay in the building**, in one folder:
  - `records.json` and `settings.json`
  - signatures as image files in `files/`
  - a daily copy of the records in `backups/`, keeping the last 30 days
- It does the daily jobs a tablet would: signing everyone out at the end of the day, and deleting records older than the retention period.
- **Not yet:** emails (host notifications, alerts, the daily summary). Declines and alerts show in the admin screen under Needs attention.

## The file to send

`npm run server:zip` makes `dist/visitor-sign-in-server.zip`: the program, the kiosk it serves, and a **START HERE.txt** with these steps.

## On a Windows PC or a Mac

1. Install **Node.js** (the LTS version) from [nodejs.org](https://nodejs.org/).
2. Unzip `visitor-sign-in-server.zip` somewhere it can stay, such as Documents.
3. Double-click **`server/start-windows.cmd`** (Windows) or **`server/start-mac.command`** (Mac; the first time, right-click → Open). When Windows asks about networks, **allow Node.js on private networks**.
4. Leave the window open. It shows the address on the Wi-Fi and a **setup link**. The records are in a **Visitor Sign-In** folder in your home folder.
5. Open the setup link in a browser on any computer, tablet or phone on the same Wi-Fi, and set up: company, admin PIN, numbered visitor passes, questions, rules.
6. In **Admin → Settings → Phone sign-in**:
   - switch it on
   - type the guest Wi-Fi's name and password
   - print the poster for the door

So it starts by itself after a restart:
- **Windows:** press Win+R, type `shell:startup`, and put a shortcut to `start-windows.cmd` there.
- **Mac:** System Settings → General → Login Items → add `start-mac.command`.

The computer must stay on, and must not go to sleep, while you're open for visitors.

## On a Raspberry Pi

Any Raspberry Pi 3, 4 or 5, or a Zero 2 W, with Raspberry Pi OS 12 (Bookworm) or newer, on the same Wi-Fi (or cable) as visitors.

1. Copy the unzipped folder to the Pi, with a USB stick or `scp`.
2. Open a terminal in that folder and run:

   ```bash
   sudo bash server/install-pi.sh
   ```

   It installs Node.js 22 if needed (this one step needs internet) and installs Visitor Sign-In in `/opt/visitor-sign-in`, with the records in `/var/lib/visitor-sign-in`. It starts it now and whenever the Pi is switched on, and prints the **setup link**.
3. Carry on from step 5 above.

To update, run the installer again from a newer folder. The records are kept.

**Checking on it:**
- `systemctl status visitor-sign-in` shows whether it's running.
- `journalctl -u visitor-sign-in -f` shows its messages.
- To name it in the admin screen, install with `sudo VSI_NAME="Front desk" bash server/install-pi.sh`.

## Keep the address the same

The poster's QR code contains the computer's address on the Wi-Fi, such as `http://192.168.1.20:8080/`. Ask your router to always give this computer the same address (a "DHCP reservation", in the router's settings) so the poster keeps working. If the address changes, print the poster again. Settings → Phone sign-in shows the current one.

## The setup link

The link contains the kiosk key: anyone with it can connect a screen to these records. Keep it private, the same as a password. After setup, the admin PIN protects the admin screen. The link is also saved as `setup-link.html` in the records folder, with a QR code. To connect another screen later, use **Admin → Settings → Connect another tablet**.

## Backups and moving to a new computer

- **Back up now and then:** copy the whole records folder somewhere safe, such as a USB stick or a network folder. `backups/` holds a daily copy, but on the same disk.
- **Moving to a new PC or Pi:** stop it, copy the folder to the new one, and start it there with `--data` pointing at the copy. Then print the poster again, since the address is new. Don't run both at once.

## Options

`node server/visitor-server.mjs`:
- `--data <folder>`: where the records are
- `--name "Front desk"`: its name in the admin screen
- `--port 8080`: the port on the Wi-Fi
- `--tz America/Chicago`: its time zone, if not the computer's
- `--print-link`: just print the setup link
- `--site <website>`: also connect to a website ([site/README.md](../site/README.md)), so phones on mobile data can reach it over https, with photos. That's optional, for later.

## Licenses

Screenless sign-in is licensed like a QR code. The code is in **Admin → Settings → Phone sign-in** (see docs/PAYWALL.md).
