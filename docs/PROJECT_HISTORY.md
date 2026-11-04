# Project history

How the Shock Tech visitor sign-in kiosk came together: what was asked for, what was decided, and why. This is the design record. For setup, see the [main README](../README.md) and [android/README.md](../android/README.md).

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

## Where things are

| Thing | Location |
|---|---|
| Kiosk | `web/` |
| Android app | `android/` (guide: `android/README.md`), built with `scripts/build-android.mjs` |
| Backend | `apps-script/Code.gs`; tests in `tests/` |
| Demo videos | `media/` |
| Ready-to-install demo APK | `downloads/` (demo mode, not connected to a Sheet) |
| Demo video recording kit | `tools/demo-video/` |
| Original reference spec | `docs/reference/` |

## Open ideas

Not built yet, in rough order of value:

1. Notify the host when their visitor arrives (email or text).
2. Emergency roll call: everyone in the building, with photos, in one tap.
3. A foreign-national hold until an approver okays the visit (ITAR).
4. Expected visitors, pre-registered by staff.
5. An end-of-day sweep for anyone still signed in, and badges not returned.
6. Spanish and other languages.
7. A daily summary email.
