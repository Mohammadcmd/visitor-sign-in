# Changelog

## Unreleased

**Selling the kiosk per tablet**
- Licenses are per tablet. Each tablet has a code, and a key names one tablet and the date it's paid until.
- Reminders start 30 days before the paid-until date, and a 14-day grace period follows it. Then new sign-ins pause: visitors are asked to see the front desk.
- While paused, signing out, badge returns, the roll call, the admin screen and exports keep working. Nothing is deleted.
- The seller can renew a kiosk, or switch it off early (a bounced check), through signed status files on their website. The kiosk picks up renewals by itself.
- Setting the tablet's clock back doesn't stretch a license once the kiosk has heard the real date.
- Seller tools: `license:issue`, `license:renew`, `license:off` / `license:on`, `license:list` (what's due) and `license:payments` (a CSV with checks included). The ledger stays on the seller's computer.
- This replaces the earlier Free/Pro plans: a license includes every feature.

- The kiosk's actions are now one shared engine (`web/js/engine.js`), used by the on-tablet kiosk and by the new cloud service. No change in behavior.
- The start of the cloud service (`cloud/`): Cloudflare Workers with one Durable Object per company, photos in R2, the same actions as the Google Sheets script. Tested in Cloudflare's local runtime. Not used by the kiosk yet.
- Cloud accounts: sign up and sign in with a six-digit code sent by email (no passwords), companies with owners, admins and front-desk staff.
- Tablets locked to a company: a tablet registers a key it can't export, checks in by signing a one-time challenge, and gets a device token; retiring a tablet stops it at once. In production, companies can only be made by signing up.
- The plan: sell the APK directly, per kiosk, with a yearly fee; no Google Play. The cloud service is parked for later ([docs/ROADMAP.md](docs/ROADMAP.md)).

## 1.1.0 — signatures

**Visitors**
- Visitors can sign the visitor rules with a finger instead of ticking a box: new visitors once, or every visit. A tap isn't accepted as a signature, and **Clear** starts over. Set up in Finishing touches → Signature (Pro when the paywall is on).
- With Google Sheets, visitors can have the signed copy emailed to them as a PDF.

**Staff**
- Admin → History: **Signed copy** shows the rules as the visitor saw them, in their language, with their signature and the time. With Google Sheets, a QR code opens the PDF in Drive. The visits CSV has a Signed copy column.
- Google Sheets backend (`apps-script/Code.gs`, version 5): a PDF of each signed copy and the signature image in the visitor's Drive folder, and new Email, Signature and Signed copy columns. Copy the new script and deploy a new version (Admin → Settings → Diagnostics says so). Version 4 scripts keep working, without signatures.
- Retention deletes signed copies along with the visits and visitors they belong to.

**Fixes**
- The "we couldn't see your face clearly" note no longer appears on a later step when the photo check finishes after the visitor has moved on.

## 1.0.0 — first release for any business

The kiosk that began as Shock Tech's own visitor sign-in, made configurable for any business.

**Setting up**
- A setup wizard on first start: company name, tagline and brand color; admin name and PIN; logo (PNG, transparency checked); NFC/RFID visitor badges or none; records on the tablet or in Google Sheets (guided connection); screening questions; hosts; photos, quick entry, visit reasons and rules; end-of-day sign-out, a daily summary email, record retention and languages.
- Every part can be changed later in Admin → Settings. Settings export and import, and a ready-made Shock Tech preset (`docs/presets/shock-tech.json`).

**Visitors**
- New and returning visitors, face-recognition quick entry (opt-in), badge tap or on-screen sign-in and sign-out.
- Screening questions that politely decline (with a photo and a staff alert) or let a visitor in and flag them; staff override on the spot or from the admin screen.
- Host names suggested as visitors type, and (Google Sheets) an email to the host on arrival.
- Expected visitors are greeted and their details filled in.
- Spanish for every visitor screen, with translations for the business's own text.

**Staff**
- Admin screen: Inside now with an emergency roll call, Expected, Needs attention, History with CSV export, Badges (including badges not returned), Settings with Diagnostics.
- Google Sheets backend (`apps-script/Code.gs`, version 4): tabs for visitors, visits, badges, expected visitors, face data and settings; photos in Drive; alert, host and daily summary emails.
- Records are deleted automatically after the period chosen in setup.

**Getting started**
- An install page at the kiosk's address: the Android app download on Android tablets, the browser kiosk with Add to Home Screen steps on iPads, and a QR code on computers.
- Setup starts by checking the tablet (camera, face recognition, badge reader, internet, clock, storage, screen, software), with fixes in plain words; Diagnostics can run it again.
- QR codes for connecting another tablet and for updates; Diagnostics says when a new release is out.

**Selling it**
- A plan and license system, switched off by default: Free and Pro, a Pro trial, signed license keys checked offline, PRO tags and an upgrade screen, and tools to make keys (`docs/PAYWALL.md`).

**Running it**
- Android app (kiosk mode, starts on boot), or any browser over HTTPS, with offline start-up.
- Fast on modest tablets: the kiosk is ready in about a second (400 KB to start; face recognition loads only when it's used, once the tablet is idle), published builds start from the saved copy, and taps respond within a frame or two. Records on the tablet are kept in memory, and the Google script reads each tab once per request (a badge sign-in went from 12 sheet reads to 4).
- GitHub Actions: tests on every push, an APK on every change, a GitHub Release with the APK for every `v*` tag, and GitHub Pages hosting for the browser kiosk.
