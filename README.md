# Shock Tech Visitor Sign-In Kiosk

A visitor sign-in kiosk for **Shock Tech, Inc.** (Mahwah, NJ). It runs on a lobby tablet, either as an **Android app** or in a browser. It uses a USB NFC reader for visitor badges and saves everything to a Google Sheet, with visitor photos in Google Drive.

```
web/           the kiosk itself (static HTML/CSS/JS)
android/       the Android app that wraps web/ (setup guide: android/README.md)
apps-script/   the Google Apps Script backend (Sheets + Drive)
scripts/       build-android.mjs builds the APK
tests/         backend tests (node tests/apps-script.test.js)
```

## What visitors see

1. **Welcome screen**, always on: "Welcome to Shock Tech — Tap anywhere to get started".
2. **New visitor** or **Returning visitor**.
3. **New visitor** answers the sign-in questions one screen at a time:
   - first and last name
   - company, who they're visiting, and purpose of the visit
   - citizenship status, plus country when they're not a U.S. citizen
   - a picture taken with the iPad camera
   - the visitor rules, agreed to as an electronic signature
   - an opt-in: *"Want quick entry next time?"*
4. **Returning visitor:** the visitor starts typing their name right away. Meanwhile, a small live camera in the corner compares what it sees with visitors who opted into quick entry. Whichever finds them first wins.
   - **Camera is sure:** a "Welcome back, Dana! — That's me" card appears at the top, often before they finish typing.
   - **Typing:** matching people appear as suggestions above the keyboard, with no need to press "Find me".
   - **Not sure, or never opted in:** the kiosk never guesses; the name search does the work. What the camera saw is added to their profile (only if they opted in) so recognition keeps improving. Visitors who haven't opted in are offered quick entry at that point.
5. **Tap any visitor badge on the reader.** An animated screen shows how. The tapped badge is assigned to that visitor.
6. **Leaving:** a visitor taps their badge while the welcome screen shows and is signed out. The badge is released, and a "Not you? Undo" button stays up for a few seconds.

**Admin:** press and hold the Shock Tech logo on the welcome screen for 2.5 seconds, then enter the admin PIN.
- **Inside now:** everyone signed in, with a **Sign out** button for each.
- **Badges:** add badges by tapping them on the reader (they're numbered V1, V2, … automatically), link or relink NFC tags, and retire or restore badges.

## The Google Sheet

`setup()` creates four tabs. Columns are looked up by header name, so you can reorder them.

| Tab | Contents |
|---|---|
| **Visitors** | First Name, Last Name, then every answer (Company, Who are you visiting, Purpose, Citizenship status, Country, Visitor acknowledgment, Quick entry), Registered, Last visit, Visit count, Visitor ID, and finally **Photo folder**: a link to that visitor's own Drive folder of pictures. |
| **Visits** | One row per sign-in: time in, name, company, visiting, purpose, Visitor or Foreign national, badge, how they signed in, time out, and who signed them out. |
| **Badges** | Badge number, NFC tag, status (available / in use / retired) and current holder. |
| **Face data** *(hidden)* | Numeric face signatures, only for visitors who opted into quick entry. Turning quick entry off deletes their rows. |

## Setup

### 1. Google Sheet + Apps Script
1. Create a Google Sheet in the Shock Tech Google account. Share it only with front desk staff.
2. **Extensions → Apps Script.** Replace `Code.gs` with `apps-script/Code.gs`. In Project Settings, turn on "Show appsscript.json" and paste in `apps-script/appsscript.json`.
3. **Project Settings → Script properties:**
   - `ADMIN_PIN`: 6 to 8 digits.
   - `PHOTO_FOLDER_ID` *(optional)*: the Drive folder for photos. If you leave it out, a folder named "Shock Tech visitor photos" is created.
4. Run **`setup`** once from the editor and allow access. It creates the tabs and a `KIOSK_KEY` (shown in the log and in Script properties).
5. **Deploy → New deployment → Web app.** Set *Execute as:* **Me** and *Who has access:* **Anyone**. Copy the URL ending in `/exec`.
   - To update the code later, use **Deploy → Manage deployments → Edit → New version**, so the URL stays the same.

### 2. Put the kiosk on the tablet
**Android tablet (recommended):** build and install the app as described in [android/README.md](android/README.md). The connection to the Sheet is built into the app, so steps 2 to 4 below are only for running the kiosk in a browser.

**Browser (iPad or any tablet):** `web/` is a static site. It must be served over **HTTPS** for the camera to work. Any static host works, for example GitHub Pages from this repo, Netlify or Cloudflare Pages.

Apps Script's own web pages block camera access, which is why the kiosk is hosted separately and calls Apps Script as an API.

### 3. Connect the tablet (browser only)
On the tablet, open this link once:

```
https://<kiosk address>/?api=<your /exec URL>&key=<KIOSK_KEY>
```

The tablet remembers both values and removes them from the address bar. Open `?disconnect` to forget them. Without a connection, the kiosk runs in **demo mode**:
- data stays in that browser only
- a panel simulates badge taps
- the admin PIN is `123456`

### 4. iPad kiosk settings (browser only)
- **Settings → Display & Brightness → Auto-Lock → Never.**
- **Settings → Accessibility → Guided Access → On.** Open the kiosk in Safari and triple-click the side or top button to lock the iPad to it.
- Allow camera access for the site when Safari asks.
- **NFC reader:** use a reader that acts as a keyboard (types the tag number, then Enter), connected by USB-C or Bluetooth.
  - The kiosk tells a tap apart from typing by speed, and handles readers that send the number twice.
  - While a keyboard-style reader is connected, the iPad hides its own keyboard. That's why the kiosk has its own on-screen keyboard.

### 5. Badges
Open the admin screen, go to **Badges → Add badge by tapping it**, and tap each badge card on the reader in turn.

## Face recognition and privacy
- Runs entirely on the iPad with [face-api.js](https://github.com/vladmandic/face-api). Photos are never sent to a face-recognition service.
- A match needs most frames to agree, a close distance, and a clear gap to the next-closest person. Anything less falls back to typing a name.
- Quick entry is **opt-in**, and visitors are told what's kept. Biometric privacy laws vary by state; have Shock Tech confirm the opt-in wording meets its legal requirements.
- Anyone with the `KIOSK_KEY` can call the backend, including reading the face index. Keep the key off public pages: use the setup link above rather than committing it.
- The match thresholds are in `web/config.js` (`FACE_MATCH_MAX`, `FACE_MATCH_MARGIN`).

## Moving off Apps Script later
The kiosk talks to the backend only through `call(action, args)` in `web/js/api.js`. To move to another backend, implement the same actions (`register`, `findVisitor`, `faceIndex`, `addFaceSample`, `setQuickEntry`, `assignBadge`, `tapAtWelcome`, `undoSignOut`, `admin*`) with the same JSON shapes, then point `API_URL` at it.

## Testing
- `node tests/apps-script.test.js` runs the backend against an in-memory fake Google Sheet and Drive.
- To try the kiosk locally, run `python3 -m http.server -d web 8000` and open `http://localhost:8000` (demo mode).

The visitor questions, rules and compliance approach are adapted from the Rehtek visitor sign-in specification.
