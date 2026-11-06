# Roadmap: selling the kiosk

The plan: sell the Android app (the APK) directly, priced per kiosk tablet, with a yearly fee for updates and support. A license is locked to one tablet and paid until a date. If the yearly fee isn't paid, new sign-ins pause until it's renewed. There's no Google Play listing and no servers to run. Customers keep their records on the tablet or in their own Google Sheet.

This file is the plan and the progress. Each work session updates the checklists.

## What it costs

| Part | Choice | Cost |
|---|---|---|
| The app | The APK from your own website (built by GitHub Actions) | Free |
| Google's developer verification | Google is making Android tablets install apps only from verified developers, even outside the Play Store (in four countries since September 2026, worldwide from 2027). Register once in the Android Developer Console | **$25 once**, with an ID check |
| Licenses | Signed keys made on your computer (`npm run license:*`), checked by the kiosk offline | Free |
| License status files (renewals, switching off) and APK downloads | Any static website, such as Cloudflare Pages | Free |
| Domain | Cloudflare Registrar (sold at cost) | About $10 a year for a .com |
| Payments | Checks (no fee), or a Stripe Payment Link for cards | Stripe: about 2.9% + 30¢ per card payment, and no monthly fee |
| Customer records | On their tablet, or in their own Google Sheet (their Google account) | Nothing to you |
| Terms of service, license agreement, privacy policy | Drafted here; a lawyer's review is worth paying for before launch | Review fee only |

**To launch: about $36**: $25 for Google's registration and about $11 for a domain.

## Pricing (proposed)

- **$499 per kiosk**, including the first year of updates and support.
- **$149 per kiosk per year** after that.
- Paid by check or card. Checks are recorded with `npm run license:issue` / `license:renew -- --paid check --amount … --ref <check number>`.

## How licensing works (built: `web/js/plans.js`, `tools/license/`)

- **One license per tablet.** Each tablet shows its code (such as `K7M2-9XQ4`) in Admin → Settings → License, and the key you issue names it. A key won't work on another tablet.
- **Paid until a date.** The admin screen reminds the staff 30 days before. After the date there's a 14-day grace period where everything still works and the admin screen says it's overdue.
- **Not paid: new sign-ins pause.** The welcome screen asks visitors to see the front desk. Signing out, badge returns, the roll call, the admin screen and exports keep working. Nothing is deleted, and the business always has its records. A renewed key turns it straight back on.
- **Switching a kiosk off early** (for example, a bounced check): `npm run license:off`. The kiosk pauses the next time it's online.
- **Renewing without anyone typing a key:** `npm run license:renew` writes the new key into the license's status file. Once the status folder is on your website, the kiosk picks it up by itself.
- **Clock tricks don't work.** Once the kiosk has heard the real date from your website, setting the tablet's clock back doesn't stretch a license.
- **The trial:** 30 days from setup, then a license is needed.
- **Your records:** `licenses.json` lists every license and payment. `npm run license:list -- --due 30` shows what's coming up, and `npm run license:payments -- --csv payments.csv` is for your accountant.

## Phases

### Phase 0: owner's to-dos
- [ ] **Make the GitHub repository private.** It's public under the Apache 2.0 license, which lets anyone build the app for free and remove the license check. Settings → General → Danger Zone → Change visibility.
- [ ] Product name and a domain
- [ ] Your signing key: `npm run license:keygen`, then paste the public key into `web/js/plans.js`. Back up `license-private.pem` and `licenses.json` in two safe places.
- [ ] The Android signing key, set once in GitHub secrets ([android/README.md](../android/README.md#updates)) and backed up. Every update must be signed with it, or customers must uninstall and reinstall.
- [ ] Google's Android Developer Console: register as an organization ($25, ID check) before Google's verification reaches your customers' countries (from 2027)
- [ ] For checks: a business bank account with mobile deposit, the name checks are made payable to, a mailing address, and a W-9 ready (businesses often ask for one before paying a vendor)
- [ ] Optional: a Stripe account and a Payment Link for card payments
- [ ] A support email address and phone number to show on the license screen

### Phase 1: licenses per tablet, with a pause when unpaid
- [x] Tablet codes, keys naming a tablet and a paid-until date, reminders, grace period, pause
- [x] The paused welcome screen (signing out, badges, roll call, admin and exports still work)
- [x] License status files: renewals picked up automatically, switching off and on
- [x] The real date from your website, so setting the clock back doesn't help
- [x] Seller tools: issue, renew, switch off/on, list what's due, payments (checks included) to CSV
- [ ] Switch it on: your public key, seller details and price in `PAYWALL` (`web/js/plans.js`), then a release

### Phase 1b: phone sign-in (built)
- [x] A QR code by the door instead of a tablet (Google Sheets): visitors sign in and out on their own phone
- [x] A phone key with limited rights, per-visitor tokens on the phone, a sign-in limit, a printable poster, changing the code
- [x] A QR code is licensed like a kiosk (its own code in Admin → Settings → Phone sign-in)
- [ ] Decide the price of a QR code (the same as a kiosk, or less: there's no tablet)

### Phase 2: selling without Google Play
- [ ] Downloads and update checks from your own website instead of GitHub's public releases (needed once the repository is private)
- [ ] Updates that install themselves overnight on tablets in locked kiosk mode (no one has to tap Install)
- [ ] The website: what it does, the price, how to buy (check or card), the APK download, the license status folder
- [ ] A license agreement shown at setup (per tablet, yearly fee, what happens if it isn't paid), plus terms and a privacy policy

### Phase 3: less work for you
- [ ] A renewal invoice to email or print, with "make checks payable to" and your mailing address
- [ ] Renewal reminder emails to customers, 30 and 7 days before
- [ ] A simple seller page instead of the command line, if you'd rather click than type

### Parked: the cloud service (`cloud/`)
Built and tested, but not needed for this plan. It includes per-company storage on Cloudflare, sign-up by emailed code, staff roles, and tablets locked by device keys. It's there if you later want an office dashboard, several sites in sync, or records kept for customers. Running it would cost about $5 a month plus email.
