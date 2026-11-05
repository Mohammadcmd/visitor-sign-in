# Project history

How the visitor sign-in kiosk came together, first for Shock Tech and then for any business: what was asked for, what was decided, and why. This is the design record. For setup, see the [main README](../README.md) and [android/README.md](../android/README.md).

## Starting point

The project began with an outside reference: a rebuild specification for **Rehtek Machine Co.'s** visitor sign-in system ([docs/reference](reference/)). Rehtek's system is a phone-based sign-in for an export-controlled CNC shop. Its key ideas:

- a Google Sheet as the record
- citizenship screening under ITAR and EAR (U.S. export-control rules)
- Empowered Official approvals
- reusable QR and NFC badges
- an NFC sign-out kiosk
- a strict audit trail

We used it as inspiration, not as a blueprint.

## The brief

> A beautiful visitor sign-in for **Shock Tech** (Shock Tech, Inc., Mahwah, NJ: shock and vibration isolation for aerospace and defense) on a provided tablet.

- The kiosk always shows **"Welcome to Shock Tech — Tap anywhere to get started."**
- A tap offers **Returning visitor** or **New visitor**.
- **New visitor:**
  - answers the sign-in questions
  - the answers go to a Google Sheet's **Visitors** tab: first name, then last name, then every answer, ending with a link to a Google Drive folder of their photo
  - a polished screen then demonstrates **tapping any visitor badge** on the reader, and the tapped badge is assigned to them
- **Returning visitor:**
  - a quiet background snapshot recognizes them from the photo database
  - when sure: "Welcome back, (name)", then tap a badge
  - when not sure: it doesn't guess, and the picture is kept as more data for next time

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Brand | Shock Tech, Inc.; logo and colors taken from shocktech.com | Confirmed by the owner. |
| Questions | Rehtek's full question set: name, photo, company, host, purpose, citizenship, country, visitor rules | Shock Tech serves defense customers, so the export-control questions apply. |
| Badges | A generic USB NFC reader that acts as a keyboard | Cheap, works on any tablet, no extra drivers. |
| Face recognition | Opt-in "quick entry", offered at the end of the first sign-in | Visitors should consent before their face is used, and biometric privacy laws vary by state. |
| When the camera isn't sure | Never guess: find the visitor by name, and save that look at them as a new sample (opted-in visitors only) | Accuracy, plus more samples over time. |
| Backend | Google Apps Script, writing to the Sheet and Drive | Free and needs no server. It can be replaced later through one file (`web/js/api.js`). |
| Hosting | Kiosk outside Apps Script | Apps Script pages block camera access. |
| Signing out | Tap a badge on the welcome screen, or sign out from the admin screen | As requested. |
| Look and feel | Keynote-style screen transitions, kept professional: calm colors and motion, no confetti or sparkles | The owner asked for "good but professional". |
| Returning visitors | Name screen first, with the face check running in the background while they type | Faster: no waiting on a camera scan. |
| Device | **Android app (APK)** on whatever Android tablet is available, plus a generic USB NFC reader | No hosting, works offline for face data, and a real kiosk lockdown. |
| Repository | Fresh repository `visitor-sign-in` with a clean history | The owner wanted nothing left from an earlier, unrelated project. |

## What was built, in order

1. **Kiosk and backend:**
   - welcome, choice and guided new-visitor screens
   - built-in on-screen keyboard: Android and iPadOS hide theirs while a keyboard-style reader is connected
   - camera photo, rules signature, quick-entry opt-in
   - animated badge tap and the "All set" screen
   - badge-tap sign-out with Undo
   - PIN-protected admin: who's inside, sign out, badges by tapping
   - a demo mode
   - an Apps Script backend with tests
2. **Transitions:**
   - zoom with a logo "magic move", the tapped card expanding, a 3D cube between steps, an iris reveal, a card flip, a fall-away home
   - content builds in piece by piece
   - interrupted transitions settle cleanly
   - plain crossfades when Reduce Motion is on
3. **Demo video:**
   - a 2-minute captioned product video covering every part, including the admin side
   - an illustrated stand-in replaces the live camera, so no real faces appear
4. **Bug found while recording:** the welcome title could stay invisible after the "All set" screen had been showing for a while. Fixed by hiding inactive screens with `display: none`.
5. **Returning visitors in the background:**
   - the camera bubble looks while they type
   - a "Welcome back — That's me" card when sure
   - name matches as chips above the keyboard
6. **Badge-tap animation:**
   - rebuilt as a 3D scene: the badge on a lanyard lies flat on a reader, and the reader's ring fills
   - live reading, success and error states replace the old loading overlay
   - then toned down to look professional
7. **Android app:**
   - Capacitor wrapper with full screen, screen kept on, lock task, home-app option, Shock Tech icon and splash
   - face models bundled
   - connection built in at build time
   - retries with replay-safe request ids, an offline outbox
   - scaling for small screens, a lite mode for slow tablets
   - a GitHub Actions APK build

## Making it work for any business

The second brief: *create a setup screen and generalize the whole process so it's not Shock Tech specific.* The ideas that came with it: ask for the company name, create an admin login and PIN, upload a PNG logo with no background, set up the NFC/RFID cards, then connect a spreadsheet; offer local or cloud storage; make it look professional and informative. Then one more: *let visitors be declined.* Ask during onboarding whether the business wants extra questions; if someone answers something like "not a U.S. citizen", take them through the photo, politely decline them, notify the admins and record it, with a way to override.

A separate, simpler configurable kiosk was first built at the repository root. Once the Shock Tech kiosk landed in the same repository, we folded everything into it instead (option 2 of three offered), so there is one app with face recognition, the Android app and the transitions, and the root kiosk was retired.

Decisions:

- **Settings, not code.** Everything Shock Tech-specific became a setting (`web/js/settings.js`): name, tagline, logo, color, host question, visit reasons, rules, screening questions, decline message, photos, quick entry, badges. The whole palette is derived from one brand color, so any color looks deliberate; the default blue reproduces the original palette. No logo gets a generated text logo.
- **The wizard** (`web/js/setup.js`) runs on first start and reopens single sections from Admin → Settings. It validates as it goes (PIN strength, logo transparency, the Apps Script URL, question rules) and explains problems in plain words. A summary and next steps end it.
- **Two places for records with the same API.** "On this tablet" is a full local implementation of every backend action (localStorage plus IndexedDB for photos), so the rest of the kiosk doesn't know the difference. "Google Sheets" uses the Apps Script backend, which the wizard hands over (copy or download) from a bundled copy kept in sync by `scripts/sync-backend.mjs`.
- **No secrets to type.** The first kiosk to connect claims the sheet with a random key (trust on first use); the PIN is set from the kiosk and only its hash is stored. Settings live in a hidden Settings tab, so every tablet on the sheet looks the same. More tablets join with a private link.
- **Screening questions** have a rule each: an answer can decline (photo, polite message, alert, record) or let in and flag. Questions can be asked once or every visit. Overrides are explicit and attributed: "Staff override" on the decline screen, or "Let in" from Needs attention for two hours. Alerts appear as a dot on the welcome screen, a Needs attention tab, and optional emails with the photo.
- **Badges optional.** Without badges, visitors are signed in straight away and sign out with "Leaving?".
- **Shock Tech keeps its kiosk.** `docs/presets/shock-tech.json` restores its look and questions; its sheet, old column names and PIN keep working; `KIOSK_APP_ID` lets its tablets update in place.

## Hosts, history, roll call and end of day

The next round, picked from the open ideas plus a gap: a kiosk keeping records on the tablet had no way to get them out.

- **Hosts.** An optional wizard step lists the people visitors come to see. Names are suggested as visitors type. With Google Sheets the backend emails the host when their visitor signs in (matching names with the same forgiving rules as the visitor search), notes it on the visit, and the visitor sees "We've let Pat know you're here." Declined visitors never reach the host; staff alerts handle them.
- **History and CSV export.** A History tab with ranges and search. Exports are CSV with formula-like cells defused. Because a web download does nothing inside the Android app, the app's Kiosk plugin gained `saveFile`, which writes to Downloads.
- **Roll call.** A full-screen list of everyone inside, with photos fetched one at a time (`adminPhoto`) so the list appears immediately even when photos live in Drive. The same action now shows Drive photos in Needs attention.
- **End of day.** A daily time when everyone still signed in is signed out. Each kiosk runs it once per cutoff (catching up after being switched off), and the backend action only touches visits from before the cutoff, so two tablets running it is harmless.
- Backend version 3 (4 with expected visitors): kiosks tell admins to update older scripts, and actions an older script doesn't know explain how to update.

## Expected visitors, badges not returned, daily summary

- **Expected visitors** come from the admin screen or, with Google Sheets, from rows typed straight into a new Expected tab, so staff can pre-register visitors from their desk. The kiosk looks the visitor up after the name step and fills in what staff entered; the backend also matches by name when any visit starts, so returning visitors and face matches are marked arrived without extra steps. Rows typed by hand get an id the first time they match.
- **Badges not returned.** End of day marks a badge still checked out as "not returned" rather than available, because the badge most likely left with the visitor. Tapping it at the welcome screen clears it, and handing it to the next visitor does too.
- **Daily summary** (Google Sheets): at the end-of-day time, one email per day to the alert addresses with sign-ins, declines, flags, who was signed out automatically, badges not returned and expected visitors who didn't arrive. A kiosk's very first end-of-day run skips it, so turning the feature on doesn't send a summary for a day before setup.
- Two fixes found by the new tests: the first tap on the welcome screen after leaving the admin screen was swallowed, and the on-screen keyboard covered forms in the admin screen.

## Spanish for visitors

- Visitor screens switch languages per visitor (welcome screen buttons, a switch on the next screen); the kiosk returns to English for the next person. Staff screens stay in English.
- `web/js/i18n.js` holds the kiosk's own text in Spanish plus translations of every built-in question, rule, reason and decline message. The static page text is translated in place, so `index.html` keeps reading as plain English.
- The business's own text is translated in setup, one box per item, falling back to the built-in translation and then English. Options keep their English value underneath, so recorded answers, decline rules and alerts never depend on the language. A reason picked from the Spanish chips is saved in English; the rules agreement notes the language.
- The on-screen keyboard gained one-shot accented letters.

## Getting it ready for launch (1.0.0)

The brief: *go crazy, I want this to be ready to be put into use, a final version ready for launch.* What stood between "works in tests" and "safe in a lobby":

- **Starting without Wi-Fi.** Browser kiosks reload every night; without a network that meant a blank page. `web/sw.js` keeps a copy (network first, so updates still arrive at once). Records kept on the tablet ask the browser for persistent storage, and face samples are capped per visitor so storage can't fill up.
- **Data retention.** Records can be deleted automatically after 30 days to 2 years, in both storage modes; the period comes from the saved settings, never from a request.
- **Diagnostics** in Admin → Settings, and one **version** (1.0.0) shared by `package.json`, the kiosk, the offline cache and the Android version code.
- **Release pipeline:** a test workflow (including the end-to-end test), GitHub Pages hosting, and tagged releases with the APK, a web zip and `Code.gs`.
- **Docs:** a launch checklist, a privacy notice template, a changelog and screenshots.
- **A full code review** of the branch found ten issues, all fixed with tests: a retry arriving while the first request still ran could write twice; old Shock Tech sheets would lose the foreign-national flag on returning visitors; device-owner tablets would lose kiosk lock when updated in place; a one-time override was repeated on later visits; a refused settings save could lose the logo; removing a hand-typed expected visitor could hit the wrong row; the outbox dropped items the sheet was too busy to take; a purge emptying a whole tab would fail; expected dates used the script's time zone rather than the sheet's; and every status check read the whole Visits tab.

## Easy setup and a paywall, ready to switch on

The ask: *make the setup process super easy as far as downloading and making sure hardware and software works, and get ready to make a pay wall.*

- **Install page.** The site's home page recognizes the device: Android tablets get the latest APK from the newest GitHub Release, iPads get the kiosk with Add to Home Screen and Guided Access steps, computers get a QR code to scan with the tablet. Setup, demo and license links still go straight to the kiosk.
- **Checking the tablet** became the first setup step: a live camera preview, face recognition on a real frame, a badge tap, internet and Google reachability, the clock against the server's time, persistent storage, screen size and orientation, and the browser or WebView version. Each result says what to do about it; nothing blocks setup.
- **QR codes** (an MIT library vendored in `web/vendor/qrcode/`) for connecting another tablet, updates and buying.
- **The paywall** is built but off: plans in one file, a trial from the end of setup, ECDSA-signed license keys checked offline, gates at the places features are switched on, a few visitor-facing extras that pause at runtime, and tools to make keys. The rule throughout: nothing that protects the business or its visitors (sign-in, screening, records, roll call) ever stops for a plan.

## Making it fast

*Make sure it runs fast.* Measured on a CPU slowed 4× with a modest connection, then fixed what the numbers showed:

- **Start-up: 2.5 s → 1 s, 8.6 MB → 0.4 MB.** face-api.js (1.3 MB) was a blocking script on every start; it now loads only when face recognition is used, and the 6.8 MB of models load after the kiosk is showing and the tablet is idle (with Google Sheets, a timing slip had meant they never preloaded at all). The QR library loads with the admin screens that use it.
- **Published builds start from the saved copy.** The workflows stamp each deploy into `sw.js`, so a new deploy installs as a whole and the kiosk switches over on its own at a quiet moment on the welcome screen; unstamped development copies still fetch fresh files first.
- **Records on the tablet** are read once and kept in memory, written back only by actions that change something; a year of visits had made every tap re-read and re-write several MB. Demo mode's artificial pause went from 250 to 120 ms.
- **The Google script** keeps each tab for the rest of the request and reads header and data in one call: a badge sign-in went from 12 sheet reads to 4, a badge sign-out from 8 to 2. A test holds it there.
- Google connections open early (preconnect) when the kiosk uses Google Sheets.

## Signatures on the visitor rules (1.1.0)

Asked for next after launch: visitors sign the rules with a finger instead of ticking a box.

- **The pad** (`web/js/signature.js`): smooth strokes from pointer events (with coalesced samples, so quick signatures stay smooth), sized to the screen's pixel density, and a check that there's enough ink to be a signature rather than a tap. The saved image is trimmed to the ink, on a transparent background, at most 600 px wide.
- **Setup:** tick box only, new visitors sign, or sign every visit; with Google Sheets, an option to email visitors their copy. Pro when the paywall is on.
- **What's kept** is the rules as the visitor saw them (their language, the company name filled in), the statement, the signature and the time. On the tablet it's stored with the visit; with Google Sheets, the script (version 5) saves a PDF and the signature image in the visitor's Drive folder, links them in the Visitors and Visits tabs, and can email the PDF. A first visit shares the copy signed at registration.
- **Admin → History** shows the signed copy, with a QR code to the PDF; the visits CSV says who signed. Retention deletes signed copies with their visits and visitors.
- **Safe with an old script:** a sheet still on version 4 can't keep a signature, so visitors tick the box until the script is updated (Diagnostics says so).
- A late photo check no longer shows its "couldn't see your face" note on the rules step.

## Becoming a real app: the cloud service begins

Asked for next: a true app, sold per kiosk tablet (non-transferable), the most cost-effective way. The plan is in [ROADMAP.md](ROADMAP.md): Cloudflare (free to build, about $5 a month with customers), Stripe, Android first.

- **One engine:** every action moved out of the on-tablet backend into `web/js/engine.js`, which takes its storage, settings and calendar from the caller. The tablet runs it in the browser; the cloud runs it in a Durable Object. The 139-check kiosk test passed unchanged, and `tests/engine.test.mjs` runs it in Node.
- **The cloud service** (`cloud/`): a Worker sends each company to its own Durable Object, whose SQLite database holds one row per record (only changed rows are written), with photos and signatures in R2. Same API and kiosk-key model as the Google script, retries answered once, one request at a time, each company on its own calendar, and the admin PIN's hash never sent to tablets. `cloud/test/` runs it in Cloudflare's local runtime.
- **Accounts** (`cloud/src/directory.js`): sign-up and sign-in by six-digit emailed code (Resend; logged in tests), sessions, companies, and roles (owner, admin, front desk). Codes and sessions are stored only as hashes; guessing is limited.
- **Tablets locked to a company:** a manager activates a tablet's public key; the tablet checks in by signing a one-time challenge (ECDSA P-256) and gets a 7-day device token for kiosk calls; retiring revokes it. Kiosk-key companies (like a Google Sheet) only where `ALLOW_KIOSK_KEY_COMPANIES` is set, never in production.

## Selling the APK directly, per kiosk

The plan changed: no Google Play. The APK is sold directly, per kiosk tablet, with a yearly fee for updates and support (proposed: $499, then $149 a year), and the kiosk pauses if it isn't paid. The cloud service stays in `cloud/`, parked.

- **Per-tablet licenses** (`web/js/plans.js`): each tablet makes a code once, and a key names that tablet and a paid-until date. Reminders start 30 days before, a 14-day grace period follows, then new sign-ins pause. The welcome screen asks visitors to see the front desk. Signing out, badge returns, the roll call, the admin screen and exports keep working, and nothing is deleted. The Free/Pro split is gone: a license includes everything.
- **Status files** the seller publishes on any static site: one signed file per license, read by its kiosk a few times a day. Renewals are picked up without typing a key, and a license can be switched off (a bounced check) and on. The site's date header stops clock rollback.
- **Seller tools** (`tools/license/`): issue, renew, switch off/on, list what's due, and payments to CSV, with checks recorded. The ledger (`licenses.json`) and status folder stay on the seller's computer and are git-ignored.
- **Tests:** 53 license checks (tools and kiosk logic, including the clock) and an end-to-end paused kiosk. In it, a visitor badges out while paused, the wrong tablet's key is refused, a key restores sign-ins, and the seller switches the license off and on.

## Where things are

| Thing | Location |
|---|---|
| Kiosk | `web/` (setup wizard: `web/js/setup.js`, settings: `web/js/settings.js`) |
| Android app | `android/` (guide: `android/README.md`), built with `scripts/build-android.mjs` |
| Backend | `apps-script/Code.gs`, bundled into the wizard by `scripts/sync-backend.mjs`; tests in `tests/` |
| Shared engine (every action) | `web/js/engine.js`, run by the tablet (`web/js/api.js`) and the cloud |
| Cloud service | `cloud/` (guide: `cloud/README.md`) |
| Roadmap | `docs/ROADMAP.md` |
| Licenses: kiosk side, seller tools, guide | `web/js/plans.js`, `tools/license/`, `docs/PAYWALL.md` |
| Shock Tech preset | `docs/presets/` |
| Launch checklist, privacy notice, screenshots | `docs/LAUNCH.md`, `docs/privacy-notice.md`, `docs/screenshots/` |
| Demo videos | `media/` |
| Earlier demo APK | `downloads/` (the Shock Tech-only build, demo mode) |
| Demo video recording kit | `tools/demo-video/` |
| Original reference spec | `docs/reference/` |

## Open ideas

Not built yet, in rough order of value:

1. More languages (French, Portuguese, Chinese…): a dictionary each in `web/js/i18n.js`.
2. Text-message host notifications, and notifying hosts in on-tablet mode.
3. Calendar integration for expected visitors (Google Calendar invites with visitors).
4. QR invitations: expected visitors get a QR code by email and scan it at the kiosk to skip typing.
5. Printed name badges (a small label printer by the kiosk).
6. Automatic license sales: a checkout (for example Stripe or Lemon Squeezy) that issues and emails a license key when someone pays. Decisions to make first: pricing, which payment service, and where the key-signing step runs.
