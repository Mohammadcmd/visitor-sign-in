# Selling Visitor Sign-In: licenses per kiosk

The kiosk ships with per-tablet licensing that is **switched off**: with it off, the kiosk is free to use and no license is mentioned anywhere. This guide is for whoever sells the kiosk. It covers switching licensing on, selling a kiosk, renewals, payments (checks included), and switching a kiosk off when it isn't paid.

## How it works

- **One license per tablet.** Every tablet has a code, such as `K7M2-9XQ4`, shown in **Admin → Settings → License** and on the paused screen. The key you issue names that tablet and only works there.
- **Paid until a date.** Keys are signed with your private key (ECDSA P-256), and the kiosk checks them offline with the matching public key. Changing anything in a key (the customer, the tablet, the date) breaks the signature, and nobody can make a key without your private key.
- **Reminders and a grace period.** From 30 days before the paid-until date (`warnDays`), the admin screen reminds the staff. For 14 days after it (`graceDays`), everything keeps working and the admin screen says it's overdue.
- **Not paid: new sign-ins pause.** The welcome screen says "Sign-ins are paused. Please see the front desk." Underneath, for staff, it shows the tablet code and your contact details. Even then:
  - Signing out, badge returns, the roll call, the admin screen, history and exports keep working.
  - Nothing is deleted. Nobody is stuck inside, and the business always has its records.
  - A renewed key turns everything straight back on.
- **The trial:** 30 days (`trialDays`) from when setup is finished, then a license is needed. Setup itself is never paused.
- **Status files** let you renew a kiosk or switch it off from your side. When online, each kiosk reads its own license's small signed file from your website (`statusUrl`) a few times a day. Renewals are picked up without anyone typing a key. A license you switch off pauses at the next check.
- **Clock tricks don't work.** The kiosk remembers the real date your website reported, so setting the tablet's clock back doesn't stretch a license.
- **A phone sign-in QR code is licensed like a kiosk.** It has its own code (Admin → Settings → Phone sign-in), and its key is entered there and kept in the shared settings. When it isn't paid, visitors' phones show "Sign-ins are paused", and signing out still works. Issue it the same way: `npm run license:issue -- --customer "Acme" --tablet <the QR code's code>`.
- **Each tablet keeps its own key.** If a tablet's app data is erased, it gets a new code and needs a new key (re-issue it, for free if it's the same tablet).

## Switching it on

1. **Make your signing key** (once, on your own computer, in a folder you back up):

   ```bash
   npm run license:keygen        # writes license-private.pem, prints the public key
   ```

   Keep `license-private.pem` secret and backed up: anyone with it can make license keys, and without it you can't make new ones. It's in `.gitignore`.

2. **Edit `PAYWALL` in [`web/js/plans.js`](../web/js/plans.js):**

   ```js
   export const PAYWALL = {
     enabled: true,
     trialDays: 30, graceDays: 14, warnDays: 30,
     seller: 'Shock Tech', supportEmail: 'sales@yourcompany.com', supportPhone: '555-0100',
     price: '$499 per kiosk, then $149 a year',
     buyUrl: 'https://buy.stripe.com/your-payment-link',   // optional; checks are welcome either way
     statusUrl: 'https://licenses.yourcompany.com/',        // where you publish license-status/
     publicKey: { kty: 'EC', crv: 'P-256', x: '…', y: '…' },  // printed by keygen
   };
   ```

3. Run the tests (`npm test` checks licenses end to end), then release a new version (push a `v*` tag).

## Selling a kiosk

1. The customer installs the app. The tablet code is in **Admin → Settings → License**, and on the paused screen once the trial ends.
2. When they've paid (or with net-30 terms, when you invoice):

   ```bash
   npm run license:issue -- --customer "Acme Robotics" --tablet K7M2-9XQ4 --email owner@acme.com \
     --paid check --amount 499 --ref 1001
   ```

   This:
   - Prints the key (`VSI1.…`), paid for a year from today. Use `--until 2027-12-31` for another date.
   - Records the license and the payment in `licenses.json`.
   - Writes the license's status file in `license-status/`.
   - Adds `--link https://your-kiosk-address/` for a license link and `--qr acme.svg` for a QR code.
3. Send the customer the key. They add it in **Admin → Settings → License** (type, paste or scan the QR code), or by opening the link on the tablet once (it asks for the admin PIN).
4. Publish the `license-status` folder (below).

`--any-tablet` instead of `--tablet` makes a key that works on any tablet, for your own kiosks.

## Renewals

```bash
npm run license:list -- --due 30            # licenses ending in the next 30 days (or already ended)
npm run license:renew -- --id 3f9a1c2b7d4e5f60 --paid check --amount 149 --ref 1002
```

Renewing adds a year from the current paid-until date, or from today if it ended long ago. `--until` or `--years 2` set something else. Publish the `license-status` folder afterwards, and the kiosk renews itself the next time it's online. The new key is printed too, for a kiosk that's kept offline.

## When a customer doesn't pay

- **Do nothing:** after the paid-until date and the 14-day grace period, the kiosk pauses by itself, even offline.
- **Switch it off now** (a bounced check, a refund):

  ```bash
  npm run license:off -- --id 3f9a1c2b7d4e5f60 --note "check 1002 bounced"
  npm run license:on  -- --id 3f9a1c2b7d4e5f60     # when it's sorted out
  ```

  Then publish the `license-status` folder. The kiosk pauses at its next check (within a few hours when online).

## Payments and your records

- `licenses.json` holds every license (customer, tablet, paid until, status, notes) and every payment (date, amount, check, card or bank, reference). Back it up with your signing key. Never commit it: it's in `.gitignore`.
- `npm run license:payments -- --csv payments.csv` saves every payment as a spreadsheet for your accountant.
- **Checks:** deposit them with your bank's mobile app. Keep a W-9 ready, since businesses often ask for one before paying a vendor. Sales tax on software depends on the state, so ask your accountant.

## Publishing the status folder

`license-status/` holds one small signed file per license, named by the license id, plus a `_headers` file that lets kiosks read them. Put the folder on any static website. For example, with a free Cloudflare account:

```bash
npx wrangler pages deploy license-status --project-name visitor-sign-in-licenses
```

Then use that address (or your own domain pointed at it) as `PAYWALL.statusUrl`. The files hold nothing secret, and the ids are random, so nobody can list your customers. Each file holds that license's key, which includes the customer's name.

## Limits to know about

- The check runs in the app on the tablet. It stops honest customers from running unpaid kiosks, but someone who edits the app's code could switch it off. **Keep the repository private** and give customers only the built APK.
- A kiosk that's never online can't hear that you switched it off. It still pauses on its own at the paid-until date plus the grace period.
- Changing your signing key makes every key issued with the old one stop working.
