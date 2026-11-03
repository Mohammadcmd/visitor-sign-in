# Shock Tech Visitor Sign-In Kiosk

A visitor sign-in kiosk for **Shock Tech, Inc.** (Mahwah, NJ). Visitors sign in on a lobby **Android tablet** and tap a visitor badge on a USB NFC reader.

**Every record stays in the building**, on a **Raspberry Pi**. Nothing is sent to the internet or any cloud service. The Pi is also:
- a tap-to-sign-out station
- a records dashboard for office computers, with Excel/CSV downloads
- the source of a nightly backup to a shared folder

```
 Tablet (Android app)  ──office network──▶  Raspberry Pi  ◀── USB NFC reader (tap to sign out)
   sign-in kiosk                             • database + photos
 Office computers  ──browser──▶  dashboard   • nightly backup ──▶ shared folder (office PC / NAS)
```

```
web/           the kiosk itself (HTML/CSS/JS)
android/       the Android app that wraps web/ (guide: android/README.md)
pi/            the Raspberry Pi server, sign-out reader, dashboard and backups (guide: pi/README.md)
scripts/       build-android.mjs builds the APK
docs/          project history and the original reference spec
media/         product demo video and the badge-tap animation
downloads/     a ready-to-install demo build of the Android app
tools/         the kit that records the demo video
```

The story of how it was designed, and every decision along the way, is in [docs/PROJECT_HISTORY.md](docs/PROJECT_HISTORY.md).

## Setting it up

1. **Raspberry Pi:** install the visitor server with one command, then set up the nightly backup. See [pi/README.md](pi/README.md). The installer prints the Pi's address and the kiosk key.
2. **Tablet:** install the Android app, then connect it to the Pi in admin → Settings → **5. Connection**. See [android/README.md](android/README.md).
3. **Badges:** on the tablet, go to admin → **Badges → Add badge by tapping it**, and tap each badge card on the reader in turn.

To just try it out, install `downloads/shocktech-visitor-kiosk-demo.apk`, which runs in **demo mode**:
- nothing is saved outside the tablet
- the admin PIN is `123456`

## What visitors see

1. **Welcome screen**, always on: "Welcome to Shock Tech — Tap anywhere to get started".
2. **New visitor** or **Returning visitor**.
3. **New visitor** answers the sign-in questions one screen at a time:
   - first and last name
   - company, who they're visiting, and purpose of the visit
   - citizenship status, plus country when they're not a U.S. citizen
   - a picture taken with the tablet's camera
   - the visitor rules, agreed to as an electronic signature
   - an opt-in: *"Want quick entry next time?"*
4. **Returning visitor:** the visitor starts typing their name right away. Meanwhile, a small live camera in the corner compares what it sees with visitors who opted into quick entry. Whichever finds them first wins.
   - **Camera is sure:** a "Welcome back, Dana! — That's me" card appears at the top, often before they finish typing.
   - **Typing:** matching people appear as suggestions above the keyboard, with no need to press "Find me".
   - **Not sure, or never opted in:** the kiosk never guesses; the name search does the work. What the camera saw is added to their profile (only if they opted in) so recognition keeps improving. Visitors who haven't opted in are offered quick entry at that point.
5. **Tap any visitor badge on the reader.** An animated screen shows how. The tapped badge is assigned to that visitor.
6. **Leaving:** a visitor taps their badge, either on the Raspberry Pi's reader or on the tablet's reader while the welcome screen shows, and is signed out. The badge is released for the next guest.

**Admin on the tablet:** press and hold the Shock Tech logo on the welcome screen for 2.5 seconds, then enter the admin PIN.
- **Inside now:** everyone signed in, with a **Sign out** button for each.
- **Badges:** add badges by tapping them on the reader (they're numbered V1, V2, … automatically), link or relink NFC tags, and retire or restore badges.
- **Settings**, in eight numbered sections:
  - the connection to the Pi, with a live status line including the last backup
  - changing the admin PIN (stored only as a salted hash)
  - printing the badge labels and lobby sign
  - a "who can do what" card
  - Areas and Screening list, listed as coming later

**Records on office computers:** open **http://shocktech-rehtekpro.local** and enter the admin PIN. You get who's inside, visit history, visitors with photos and badges, plus **Download for Excel (CSV)** buttons.

## What's recorded

| Record | Contents |
|---|---|
| **Visitors** | First and last name, then every answer (company, who they're visiting, purpose, citizenship status, country, visitor acknowledgment, quick entry), registered, last visit, visit count, and their photos. |
| **Visits** | One per sign-in: time in, name, company, visiting, purpose, Visitor or Foreign national, badge, how they signed in, time out, and who or what signed them out. |
| **Badges** | Badge number, NFC tag, status (available / in use / retired) and current holder. |
| **Face data** | Numeric face signatures, only for visitors who opted into quick entry. Turning quick entry off deletes them. |

All of it lives in one database on the Pi, with photos as files next to it, and both are copied to the backup folder every night.

## Face recognition and privacy
- **On the tablet only.** Recognition runs entirely on the tablet with [face-api.js](https://github.com/vladmandic/face-api), whose files are bundled into the app. Photos are never sent to a face-recognition service.
- **It never guesses.** A match needs most frames to agree, a close distance, and a clear gap to the next-closest person. Anything less falls back to typing a name.
- **Quick entry is opt-in,** and visitors are told what's kept. Biometric privacy laws vary by state; have Shock Tech confirm the opt-in wording meets its legal requirements.
- **The kiosk key guards the data.** The tablet needs the Pi's kiosk key to read or write anything, including the face index. Keep the Pi on the office network, never open to the internet.
- **Tuning:** the match thresholds are in `web/config.js` (`FACE_MATCH_MAX`, `FACE_MATCH_MARGIN`).

## How the tablet talks to the Pi
The kiosk talks to the Pi only through `call(action, args)` in `web/js/api.js`. It sends JSON to `http://<pi address>/api`, with retries and replay-safe request ids so a dropped connection never records a visit twice. The Pi's side is `pi/visitor_pi/store.py`.

## Testing
- `cd pi && python3 -m unittest discover -s tests` (or `npm test`) tests the Raspberry Pi server: every kiosk action, the dashboard, CSV export, photos, backups and the reader's tap detection.
- To try the kiosk in a browser, run `python3 -m http.server -d web 8000` and open `http://localhost:8000`. It runs in demo mode, with a panel that simulates badge taps.

The visitor questions, rules and compliance approach are adapted from the Rehtek visitor sign-in specification.
