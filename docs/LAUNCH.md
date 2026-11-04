# Launch checklist

Everything needed to put the kiosk into use, in order. Allow about an hour for the first tablet, most of it unhurried testing.

## 1. Decide

- [ ] **Where records live.** *On this tablet* for one tablet and the simplest setup. *Google Sheets* for several tablets, email alerts, host emails, a daily summary, or seeing visitors from your desk.
- [ ] **How visitors sign out.** NFC/RFID badges (buy a reader that "types" the card number, plus cards or fobs), or on screen with no badges.
- [ ] **What you ask.** Only questions your business is required or entitled to ask. Decide what each answer does: nothing, politely decline, or let in and alert staff.
- [ ] **How long you keep records.** Pick a period your policies allow (Setup → Finishing touches → Keep visitor records for).
- [ ] **Who the admins are**, and who receives alert emails.

## 2. Google Sheets (skip for "On this tablet")

The setup wizard walks through this on the tablet; doing it on a computer first is quicker.

- [ ] Create a Google Sheet in the account that should own the records. Share it only with the people who need it.
- [ ] **Extensions → Apps Script.** Replace everything in `Code.gs` with [`apps-script/Code.gs`](../apps-script/Code.gs). In Project Settings, tick *Show "appsscript.json"* and paste [`apps-script/appsscript.json`](../apps-script/appsscript.json).
- [ ] **Deploy → New deployment → Web app**, *Execute as* **Me**, *Who has access* **Anyone**. Allow access when asked. Copy the URL ending in `/exec`.
- [ ] Optional: in the sheet, set **File → Settings → Time zone** to your local time zone (expected-visitor dates and the daily summary use it).

## 3. The kiosk on a tablet

**Android tablet (recommended)**
- [ ] Get the APK: the latest **Release** (`visitor-sign-in-<version>.apk`), or **Actions → Build Android app → visitor-sign-in**.
- [ ] For updates that install over the old version, set the signing secrets once ([android/README.md](../android/README.md#updates)).
- [ ] Install, allow the camera, accept app pinning, and choose it as the **Home app** so it returns after a reboot ([android/README.md](../android/README.md)).

**iPad or any tablet with a browser**
- [ ] Host the kiosk over HTTPS. Easiest: **Settings → Pages → Source: GitHub Actions**, then **Actions → Publish the kiosk (GitHub Pages) → Run workflow**. The address is `https://<owner>.github.io/<repository>/`. Or put the `visitor-sign-in-web-<version>.zip` from a Release on any static host.
- [ ] Open the address once while online (it then opens even without Wi-Fi), allow the camera, and **Add to Home Screen**.
- [ ] iPad: **Auto-Lock → Never**, and **Guided Access** on (Settings → Accessibility) to lock the iPad to the kiosk.

## 4. Set up

- [ ] Run the setup wizard on the tablet. With Google Sheets, paste the `/exec` URL on the *Connect* step.
- [ ] Choose an admin PIN only admins know (6 to 8 digits). It's stored as a one-way hash; it can be changed in Admin → Settings → Admin login.
- [ ] Register the badges by tapping them during setup (or later in Admin → Badges). Label each card with its number (V1, V2, …).
- [ ] Offer Spanish if your visitors would use it, and translate your own questions and rules (Finishing touches → Languages).
- [ ] More tablets on the same sheet: Admin → Settings → **Connect another tablet**, and open the private link on each one.

## 5. Test before the first visitor

- [ ] Sign in as a new visitor, start to finish, as a visitor would.
- [ ] Sign in again as a returning visitor (by name, and with quick entry if it's on).
- [ ] Answer a screening question so it **declines**: check the polite message, the red dot, Admin → Needs attention, and the email (Google Sheets).
- [ ] Use **Staff override** on the decline screen, and **Let in** from Needs attention.
- [ ] Sign out (badge tap, or "Leaving?") and try **Undo**.
- [ ] Add an expected visitor and sign in as them; check the host email (Google Sheets).
- [ ] Open **Admin → Settings → Diagnostics**: everything should read normally (connection, script version, badge reader, camera, offline start-up).
- [ ] Run a **Roll call** once so staff know where it is.
- [ ] Then clear the test records: delete the test rows in the sheet, or (on the tablet) Admin → Settings → Start over and set up again.

## 6. On the day

- [ ] Put up the privacy notice by the kiosk ([template](privacy-notice.md)).
- [ ] Keep the tablet plugged in, with the badge tray next to the reader.
- [ ] Show front-desk staff: the admin screen (hold the logo 2.5 s), Needs attention, Expected, Roll call, and Staff override.

## Keeping it running

- **Updates:** new versions are GitHub Releases. Android: install the new APK over the old one. Browser: the kiosk picks up the new version by itself the next time it loads (it reloads itself every night). If a release changes `Code.gs`, Admin → Settings → Diagnostics says the script needs updating: copy the latest code into Apps Script and **Deploy → Manage deployments → Edit → New version**.
- **Backups:** Google Sheets keeps its own version history. On the tablet, export visits and visitors from Admin → History now and then, and keep the settings file from Admin → Settings → Export settings.
- **Forgotten PIN:** Google Sheets: delete `ADMIN_PIN_HASH` in Apps Script → Project Settings → Script properties and add `ADMIN_PIN` with a new PIN. On the tablet: Start over is behind the PIN, so the only way back in is to clear the browser's data for the kiosk (or reinstall the app) and set up again, which also erases the records kept on the tablet. Keep the PIN somewhere safe, and export regularly.
- **Something wrong?** Admin → Settings → Diagnostics first, then [android/README.md](../android/README.md#troubleshooting).
