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

## Where things are

| Thing | Location |
|---|---|
| Kiosk | `web/` (setup wizard: `web/js/setup.js`, settings: `web/js/settings.js`) |
| Android app | `android/` (guide: `android/README.md`), built with `scripts/build-android.mjs` |
| Backend | `apps-script/Code.gs`, bundled into the wizard by `scripts/sync-backend.mjs`; tests in `tests/` |
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
