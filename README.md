# Visitor Sign-In

A visitor sign-in kiosk for any business's lobby tablet. It runs as an **Android app** or in a browser (iPad or any tablet). A short **setup wizard** makes it yours: your company name, logo and colors, an admin PIN, your NFC/RFID visitor badges, where records are kept, and optional **screening questions** that can politely decline a visitor, alert your staff and still be overridden by an admin.

```
web/           the kiosk (static HTML/CSS/JS, no build step)
android/       the Android app that wraps web/ (guide: android/README.md)
apps-script/   the Google Sheets backend (Apps Script), used when records go to Google Sheets
scripts/       build-android.mjs builds the APK; sync-backend.mjs bundles the backend into the wizard
tests/         backend tests and an end-to-end browser test
docs/          project history, presets (docs/presets/) and the original reference spec
media/         product demo videos; downloads/ an earlier demo build of the app
tools/         icon rendering (tools/icons/) and the demo video kit (tools/demo-video/)
```

How it was designed, and why, is in [docs/PROJECT_HISTORY.md](docs/PROJECT_HISTORY.md).

## Setup: the first start

Open the kiosk on the tablet. The first time, it opens the setup wizard (about 5 minutes, or 10 with Google Sheets):

| Step | What you choose |
|---|---|
| **1. Company** | Name, a tagline, and one brand color. Every screen's colors are worked out from it, with a live preview. |
| **2. Admin login** | The admin's name and a 6 to 8 digit PIN. The PIN is only stored as a one-way hash. Easy PINs like `123456` are refused. |
| **3. Logo** | A PNG with a transparent background. The wizard checks the transparency and shrinks large files. No logo? A clean text logo in your color is made for you. |
| **4. Visitor badges** | Use NFC/RFID badges, or none. With badges, tap each card on the reader right there: they're numbered V1, V2, … Without badges, visitors sign out on the screen ("Leaving?"). |
| **5. Records** | **On this tablet** (private, nothing to set up) or **Google Sheets** (a live sheet your team can open anywhere, photos in your Google Drive, several tablets on one sheet). |
| **6. Connect Google Sheets** | Only with Google Sheets. Step-by-step instructions: make a sheet, paste the script (the wizard copies or downloads it for you), deploy it, and paste the web app URL. The wizard tests the connection and explains any problem. |
| **7. Screening questions** | Optional. Pick ready-made questions (U.S. person for ITAR/EAR, illness symptoms, prohibited items, safety induction, tools, NDA, accessibility) or write your own (yes/no, multiple choice or short answer). For each one: which answers **politely decline** the visitor or **let them in and alert staff**, and whether it's asked once or on every visit. Choose the decline message, and with Google Sheets, who gets alert emails. |
| **8. Hosts** | Optional. The people visitors come to see, with their email addresses. Their names come up as visitors type. With Google Sheets, each host gets an email the moment their visitor signs in ("Your visitor has arrived"), and the visitor is told "We've let Pat know you're here." |
| **9. Finishing touches** | Photos (every visitor, only declined visitors, or none), face-recognition quick entry, visit reasons, visitor rules, and an optional time each day when everyone still signed in is signed out ("End of day"). |

The last screen sums everything up and lists what to do next. Everything can be changed later: **press and hold the logo on the welcome screen for 2.5 seconds**, enter the PIN, then **Settings**.

Setting up another tablet: export the settings from Admin → Settings and import them on the first step, or, with Google Sheets, use **Connect another tablet** to get a private link that connects it to the same sheet and settings.

## What visitors see

1. **Welcome screen** with your logo, name and tagline. Tap anywhere to start.
2. **New visitor** or **Returning visitor**.
3. **New visitors** answer one screen at a time: name; company, who they're visiting (matching hosts are suggested as they type) and why; your screening questions; a photo; the visitor rules (agreed as an electronic signature); and an opt-in for quick entry next time.
4. **Returning visitors** start typing their name. If they opted into quick entry, the camera may recognize them first. Questions marked "every visit" are asked again.
5. **Finish:** tap any visitor badge on the reader, or (without badges) they're signed in straight away.
6. **Leaving:** tap the badge on the reader at the welcome screen, or tap **Leaving?** and find their name. "Not you? Undo" stays up for a few seconds.

### Declined visitors

When an answer is set to decline (for example "Not a U.S. citizen or permanent resident"):

- The visitor still takes their picture (unless photos are off), then sees your polite message, "A member of our team has been notified", and nothing about why.
- The visit is recorded as **Declined**, with the answers and the photo. A red dot appears on the welcome screen, the visit shows in **Admin → Needs attention**, and with Google Sheets an alert email (with the photo) goes to the addresses you chose.
- **Overriding:** a staff member can tap **Staff override** on the decline screen, enter the PIN and a reason, and the visitor finishes signing in. Or, in **Needs attention**, **Let in** lets that visitor sign in normally at the kiosk for the next two hours. Either way the admin's name and reason are saved with the visit, which shows as "Visitor (override)".

Answers set to **let in and alert** sign the visitor in, mark the visit (for example "Needs induction"), and alert staff the same way.

## Admin screen

Press and hold the logo for 2.5 seconds, then enter the PIN. It closes itself after 3 minutes without a touch.

- **Inside now:** everyone signed in, with a Sign out button.
  - **Roll call**, for an evacuation or drill: everyone on site as cards with their photo, company, host and badge. Tap each person as they're accounted for; the ones still missing stay at the top, with a running count.
- **Needs attention:** declined and flagged visitors from the last two weeks, with photos and answers. **Let in** or **Mark reviewed**.
- **History:** every visit and decline from today, the last 7 or 30 days, or the last year, with search by name, company or host. **Export visits (CSV)**, and on this tablet also **Export visitors (CSV)** with every screening answer. In the Android app, exports go to the tablet's Downloads folder.
- **Badges:** add badges by tapping them, link or relink tags, retire or restore badges.
- **Settings:** edit any part of the setup; export the settings; show the link to connect another tablet; copy the latest backend script; start over.

## Where records are kept

**On this tablet:** visitors, visits, badges and photos stay in the browser's storage on that tablet, private and offline. Good for one tablet and simple needs.

**Google Sheets:** the script in `apps-script/Code.gs` runs in your own Google account. It makes these tabs (columns are found by header name, so you can reorder or add columns):

| Tab | Contents |
|---|---|
| **Visitors** | Name, company, who they visit, purpose, one column per screening question, the visitor acknowledgment, quick entry, visit count, and a link to the visitor's Drive photo folder. |
| **Visits** | One row per sign-in or decline: time, name, company, visiting, purpose, kind (Visitor, a flag such as "Needs induction", "Visitor (override)" or Declined), badge, screening result, photo, which host was emailed, time out and by whom (including "End of day"), and review notes. |
| **Badges** | Badge number, NFC tag, status (available / in use / retired) and holder. |
| **Face data** *(hidden)* | Face signatures, only for visitors who opted into quick entry. Turning it off deletes their rows. |
| **Settings** *(hidden)* | The kiosk settings, shared by every tablet on the sheet. The logo is kept in Drive. |

The first kiosk to connect becomes the sheet's owner: its random kiosk key is saved in the script's properties, and requests without it are refused. Other tablets join with the private link from Admin → Settings. The tablet keeps working through Wi-Fi drops: nonessential writes wait in an outbox and go out when it's back.

The kiosk must be served over **HTTPS** for the camera (any static host: GitHub Pages, Netlify, Cloudflare Pages). Apps Script's own pages block the camera, which is why the kiosk is hosted separately and calls Apps Script as an API. A setup link also works: `https://<kiosk address>/?api=<web app URL>&key=<kiosk key>`; open `?disconnect` to forget it.

**Updating the script:** when a new version of this project changes `apps-script/Code.gs`, copy it into the Apps Script editor (Admin → Settings → Copy the latest Apps Script code), then **Deploy → Manage deployments → Edit → New version**, so the URL stays the same.

## The tablet

- **Android (recommended):** see [android/README.md](android/README.md). Full screen, locked to the app, starts after a reboot, and can have the Google Sheets connection built in.
- **iPad:** open the kiosk in Safari, allow the camera, set **Auto-Lock → Never**, and turn on **Guided Access** (Settings → Accessibility) to lock the iPad to it.
- **NFC/RFID reader:** any USB or Bluetooth reader that acts as a keyboard (types the card number, then Enter). The kiosk tells a tap from typing by speed. While such a reader is connected, tablets hide their own keyboard, so the kiosk brings its own.

## Privacy

- Face recognition runs on the tablet with [face-api.js](https://github.com/vladmandic/face-api). It's opt-in per visitor; photos are never sent to a recognition service. Biometric privacy laws vary; check the opt-in wording meets yours.
- A match needs most frames to agree, a close distance and a clear gap to the next person; anything less falls back to typing a name. Thresholds are in `web/config.js`.
- Visitors are asked not to enter ID numbers or other sensitive details. Declined visitors only see your general message; admins see the answers.
- Anyone with the kiosk key can call the backend. Keep the setup link private.

## Trying it and testing

- **Demo:** serve `web/` (`npm start`, then open `http://localhost:8080/?demo`). Sample company and data, a panel that simulates badge taps, admin PIN `123456`, nothing saved.
- `npm test` runs the backend against an in-memory Google Sheet and Drive, and checks the wizard's copy of the backend is current.
- `npm run test:e2e` runs the kiosk in Chromium with a fake camera: both setups (this tablet, and Google Sheets with the real script on fakes), sign-ins with and without badges, host suggestions and host emails, a decline, a staff override, the admin screen (history, CSV exports, roll call), end of day, and other tablets joining.
- After changing `apps-script/Code.gs`, run `node scripts/sync-backend.mjs`.

## Shock Tech

This kiosk started as Shock Tech, Inc.'s own. To set a tablet up exactly as Shock Tech's was (logo, colors, tagline, visit reasons, ITAR rules, and the citizenship question flagging foreign nationals), import [docs/presets/shock-tech.json](docs/presets/shock-tech.json) on the first setup step, then choose a PIN. An existing Shock Tech Google Sheet keeps working: update the script, connect with the same kiosk key, and use the same admin PIN; old columns such as "Who are you visiting at Shock Tech?" are kept. To update tablets that already have the old Android app, build with `KIOSK_APP_ID=com.shocktech.visitorkiosk` (see android/README.md).

The visitor questions, rules and compliance approach were first adapted from the Rehtek visitor sign-in specification in `docs/reference/`.
