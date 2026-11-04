# Visitor Sign In

A professional, configurable visitor sign-in kiosk for any business. It runs entirely in the browser on an iPad, Android tablet, Chromebook or PC. There's nothing to install and no server to run.

- **Guided setup.** Your company name, an admin login, your logo, NFC/RFID cards, where records are stored, your people spreadsheet and optional screening questions.
- **Smooth visitor flow.** Details, then screening questions, then the agreement and signature, then a photo, then a badge.
- **Screening and declines.** Questions can politely decline a visitor, or let them in but alert staff. Declined visitors are photographed, recorded and reported to staff, and an admin can override the decision.
- **NFC / RFID cards.** Staff and regular visitors tap once to sign in and again to sign out.
- **Two storage options.** Records can stay **on this device**, or go to the **cloud** in a Google Sheet that you own. Cloud mode supports several kiosks, email alerts and offline queueing.
- **Admin panel.** A live dashboard, a "Needs attention" review list, the visitor log with details, people and cards, a fire roll call, CSV export and settings backup.

Your data stays yours: it lives on the kiosk or in your own Google account. This project has no servers of its own.

---

## Quick start

1. **Host the files** on any HTTPS web host. GitHub Pages works well and is free:
   *Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`*.
   Your kiosk will then be at `https://<your-user>.github.io/visitor-sign-in/`.
2. **Open it on the kiosk device.** The setup wizard starts automatically.
3. **Add it to the home screen** so it opens full screen and works offline.
4. **Lock the device to the app.** Use Guided Access on iPad or screen pinning on Android.

> HTTPS matters: the camera (visitor photos) and built-in NFC only work on a secure connection. For local testing, `http://localhost` also counts as secure, so you can run `npx serve .` or `python3 -m http.server`.

---

## The setup wizard

| Step | What it asks | Notes |
| --- | --- | --- |
| 1. Company | Company name and brand color | A live preview shows the welcome screen. You can import settings from another kiosk here. |
| 2. Admin login | Admin name and a 4–8 digit admin code | Easy codes such as `1234` or `1111` are rejected. The code is stored only as a SHA-256 hash. |
| 3. Logo | A **PNG with a transparent background** | The kiosk checks the transparency, previews the logo on light and dark screens, and shrinks large files. Optional. |
| 4. NFC / RFID cards | No cards, a USB/Bluetooth reader, or built-in NFC | Tap a card to test the reader, and optionally register it as an admin card. |
| 5. Storage | On this device, or the cloud (Google Sheets) | See [Storage options](#storage-options). |
| 6. Spreadsheet | **On device:** a Google Sheet link shared as "Anyone with the link: Viewer" (optional)<br>**Cloud:** connect the Google Sheets connector | Step-by-step instructions and a connection test are built in. |
| 7. Screening questions | "Do you want to ask visitors extra questions?" | Templates, rules, the decline message, email alerts and photo settings. |
| Ready | A summary and next steps | Opens the kiosk. |

Everything can be changed later in **Admin → Settings**. Settings also covers the visitor form fields, the agreement and signature, and kiosk behavior.

---

## Screening questions, declines and overrides

Screening questions appear after the visitor's details. Each question has an answer type (Yes / No, Multiple choice or Short answer) and an optional rule:

- **Politely decline.** The visitor sees your general message, such as *"Thank you for visiting {company}. Unfortunately, we are unable to sign you in today…"*. They aren't told which answer caused the decision.
- **Allow & alert staff.** The visitor signs in normally and staff are alerted.

When someone is declined:

1. **Photo.** If photos are on, the kiosk takes a quick photo with a 3-2-1 countdown and a retake option.
2. **Polite message.** The visitor is told a team member has been notified.
3. **Staff are notified.** The visit appears under **Needs attention** on the admin dashboard, and the gear icon shows a red dot. In cloud mode, an **email with the photo attached** also goes to the alert addresses you set.
4. **It's recorded.** The record keeps the answers, the reason and the photo, with the status *Declined*.
5. **It can be overridden.** Staff can tap **Staff override** on the kiosk, then enter the admin code or tap an admin card. Admins can also choose **Allow entry** in the admin panel. Each override records who made it, when, and why.

Quick-add templates include a **U.S. person check (ITAR / EAR export control)**, illness symptoms, prohibited items, safety induction, tools and equipment, accessibility needs and first visit.

> **Compliance:** make sure your questions follow local law. Questions about citizenship, nationality or health are usually only appropriate where your business is legally required to ask them, for example under ITAR/EAR export-control rules. Answers and photos are stored with each visit record, so set a retention period that suits your policies.

Card holders, such as staff and contractors, skip the screening questions.

---

## Storage options

| | On this device | Cloud: Google Sheets |
| --- | --- | --- |
| Setup | None | About 5 minutes, once |
| Works offline | Yes | Yes. Changes queue and upload later |
| Multiple kiosks | Each has its own log | All kiosks share one log |
| See who's on site remotely | No | Yes, open the sheet from anywhere |
| Staff alerts | Admin panel | Admin panel **and email (with photo)** |
| Host notifications | No | Email when their visitor arrives |
| People / cards list | Optional public Google Sheet (read only) | People tab in your private sheet |

On-device mode keeps records in `localStorage`, and photos and signatures in IndexedDB. Cloud mode also keeps a local copy, so the kiosk never waits on the network.

### Connecting Google Sheets (cloud mode)

The setup screen walks you through these steps:

1. Create a Google Sheet, for example with [sheets.new](https://sheets.new).
2. In the sheet, open **Extensions → Apps Script**. Delete the code there, then paste the connector from **Copy script**. It already contains your kiosk's private key. Click **Save**.
3. Click **Deploy → New deployment**. Click the gear and choose **Web app**. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**.
4. Authorize the script: choose your account, then **Advanced → Go to … (unsafe) → Allow**. Google shows this warning for any script you add yourself.
5. Paste the **Web app URL** (it ends in `/exec`) into the kiosk and click **Test connection**.

The connector (see [`apps-script.js`](apps-script.js)) creates two tabs:

- **People:** `Name`, `Card ID`, `Company`, `Role`, `Email`, `Admin`. Add an `Email` for hosts who should be notified. Put `Yes` in `Admin` for admin cards.
- **Visits:** every sign-in, sign-out, decline and override, with answers, flags, signature and photo.

The connector is limited to the one spreadsheet it's attached to (`@OnlyCurrentDoc`). Every request must carry the kiosk key, visitor input is stored as plain text (never as formulas), and email addresses are never sent back to the kiosks.

**More kiosks:** in **Admin → Data → Export settings**, export from the first kiosk, then use **Import settings** on the first setup screen of the new one. Give each kiosk its own name. If you edit the script later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

Free Google accounts can send about 100 emails a day. Google Workspace accounts can send more.

---

## NFC / RFID cards

- **USB or Bluetooth readers** that "type" the card number work automatically on any device, with no drivers needed. The kiosk tells reader input apart from a person typing by its speed. Both 125 kHz (EM4100) and 13.56 MHz (MIFARE/NFC) readers work if they output keystrokes.
- **Built-in NFC** uses Web NFC, which is available in Chrome on Android. iPhone and iPad don't allow websites to use NFC, so use a USB or Bluetooth reader there.
- Card IDs are compared loosely: separators and leading zeros are ignored, so `04:A3:2F` matches `04A32F`, and `0012345` matches `12345`.
- Register cards in the spreadsheet (`Card ID` column), or in **Admin → People & cards → Add a card** by tapping the card. In cloud mode, cards added this way are written to the People tab, so every kiosk recognizes them.
- An unrecognized card shows a friendly message. The card number is remembered, so staff can register it straight away.

---

## Admin panel

Open it with the **gear** in the top-right corner of the welcome screen, using your admin code or an admin card. It locks itself after 5 minutes without activity, and the login locks for 30 seconds after 5 wrong attempts.

- **Dashboard:** Needs attention (declines and alerts), on site now, today, last 7 days, average visit length, a 7-day chart, storage and sync status, the on-site list, and a **printable roll call** for evacuations.
- **Visitor log:** search, filters (on site, today, 7 days, declined, flagged), a details dialog for each visit (photo, answers, signature, override) and CSV export.
- **People & cards:** everyone from your spreadsheet plus cards registered on the kiosk.
- **Data:** a full CSV export, settings export and import, full-screen mode, device capability checks, and clearing or erasing data.

Settings also include an automatic daily sign-out time, the retention period, badge printing, keeping the screen awake, the welcome and thank-you messages, visitor form fields, reasons for visit and the visitor agreement with an optional signature.

---

## Privacy and security notes

- No third-party servers: data stays on the device, or goes directly from the device to your own Google Sheet.
- The admin code is stored as a SHA-256 hash. Settings exports never include it or any admin cards.
- CSV exports and the connector stop visitor input from being run as spreadsheet formulas.
- Photos are only taken when you turn them on, and visitors see the camera preview and can retake their photo.
- Retention settings automatically remove old records from the device.

---

## Project structure

```
index.html            All screens (setup, kiosk, admin, dialogs) and the icon sprite
styles.css            Design system, light and dark themes, responsive and print styles
app.js                Application logic
apps-script.js        Google Sheets connector source (Apps Script), copied from the setup screen
sw.js                 Offline support (service worker)
manifest.webmanifest  Install as an app (home screen)
icon.svg, icon-*.png  App icons
tests/                Connector unit tests and end-to-end browser tests
```

There's no build step: edit the files and reload.

## Development and tests

```bash
npm run test:connector   # connector logic against an in-memory Apps Script mock (Node only)
npm run test:e2e         # full browser run with a fake camera (needs Playwright + Chromium)
npm test                 # both
```

To save screenshots while the end-to-end tests run, set `SHOTS_DIR=/path/to/folder`.

## Browser support

The kiosk works in current versions of Safari (iPadOS 16+), Chrome, Edge and Firefox. Built-in NFC needs Chrome on Android. The camera and NFC need HTTPS (or `localhost`).

## License

See [LICENSE](LICENSE).
