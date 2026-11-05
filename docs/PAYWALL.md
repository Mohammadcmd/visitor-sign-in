# Selling Visitor Sign-In: the paywall

The kiosk ships with a complete plan and license system that is **switched off**. With it off, every feature is available and no plan is shown anywhere. This guide is for whoever sells the kiosk: switching it on, choosing what's paid, issuing license keys and taking payment.

## How it works

- **Two plans**, defined in [`web/js/plans.js`](../web/js/plans.js): **Free** and **Pro**. Pro includes the features listed in `FEATURES`; everything else is in both.
- **A free Pro trial** (30 days by default) starts when a business finishes setup. During setup itself nothing is ever locked.
- **License keys** are signed by you with a private key (ECDSA P-256). The kiosk checks the signature on the tablet with the matching public key, offline. Changing anything in a key (the customer, the end date) breaks the signature, and nobody can make a key without your private key.
- A license is saved in the kiosk settings, so with Google Sheets one key covers every tablet on that sheet.
- **What never stops:** signing visitors in, screening questions, saving records where they are kept (on the tablet or in Google Sheets), and the roll call. When a trial or license ends, the Pro extras pause, the admin screen says so once, and **Admin → Settings → Plan** offers an upgrade.

Default Pro features (change the list in `FEATURES` and `FREE_LIMITS`):

| Feature | Free | Pro |
|---|---|---|
| Sign-in and sign-out, badges, photos, rules, roll call, history, badges not returned, end of day, retention, diagnostics | ✓ | ✓ |
| Records on the tablet | ✓ | ✓ |
| Screening questions | 1 | Unlimited |
| Google Sheets, several tablets, email alerts | | ✓ |
| Host emails · daily summary email | | ✓ |
| Expected visitors · Spanish · quick entry by face · CSV export | | ✓ |

When something is locked, the kiosk shows a **PRO** tag on it, and tapping it opens the upgrade screen: what Pro adds, a QR code and link to your checkout page, and a box for the license key (type it, paste it, or scan its QR code).

What pauses after a trial: on the kiosk, Spanish, quick entry, expected visitors and CSV export; in setup, switching on Google Sheets, more screening questions, host emails or the daily summary. A kiosk already using Google Sheets keeps saving to it, and screening questions set up during the trial keep being asked. Emails that are already switched on keep going too, because they run in the customer's own Google script, which the kiosk can't control. Pausing never deletes anything: adding a license turns everything straight back on.

## Switching it on

1. **Make your signing key** (once, on your own computer):

   ```bash
   npm run license:keygen        # writes license-private.pem, prints the public key
   ```

   Keep `license-private.pem` secret and backed up: anyone with it can make license keys, and without it you can't make new ones. It is in `.gitignore`. Store it in a password manager or your payment automation's secrets, not in the repository.

2. **Edit `PAYWALL` in [`web/js/plans.js`](../web/js/plans.js):**

   ```js
   export const PAYWALL = {
     enabled: true,
     trialDays: 30,
     buyUrl: 'https://buy.stripe.com/your-payment-link',
     supportEmail: 'sales@yourcompany.com',
     publicKey: { kty: 'EC', crv: 'P-256', x: '…', y: '…' },  // printed by keygen
   };
   ```

3. Adjust `FEATURES` / `FREE_LIMITS` if you want a different split, then run the tests (`npm test` checks licenses end to end) and release a new version (push a `v*` tag).

## Issuing a license

```bash
npm run license:issue -- --customer "Acme Robotics" --tablets 3 --days 365 \
  --link https://you.github.io/visitor-sign-in/ --qr acme-license.svg
```

- Prints the license key (`VSI1.…`), and with `--link` a license link, and with `--qr` a QR code image.
- `--days 365`, `--expires 2027-12-31` or `--forever`. `--tablets` is recorded in the key and shown to the customer (the kiosk can't count tablets on its own).
- Send the customer the key, the link and the QR code. They add it in **Admin → Settings → Plans and license** (type, paste or scan), or open the link once on the tablet's browser (it asks for the admin PIN).

## Taking payment

The kiosk only needs a page to send buyers to (`buyUrl`) and a way to get them a key. Simple options:

- **Stripe Payment Links** or **Lemon Squeezy / Gumroad** checkout as `buyUrl`. Issue keys by hand from each order notification (one command per customer) to start with.
- **Automatic keys:** a small webhook (a Cloudflare Worker, a Google Apps Script web app, or a serverless function) that receives the payment provider's "order paid" event, runs the same signing as `tools/license/issue.mjs` with your private key from its secrets, and emails the key. Renewals: issue a new key with a later end date.

## Limits to know about

- The check runs on the tablet, so it stops honest customers from using Pro without paying. Someone who edits the kiosk's code can switch it off. If that matters, keep your repository (and its GitHub Pages site) private and distribute the kiosk only as the built Android app and the release zip. For enforcement that survives code changes you would need a licensing server the kiosk checks with (for example Lemon Squeezy's or Keygen's license API) — `verifyLicense` in `plans.js` is the one place to change.
- Keys can't be revoked once issued (there's no server to ask). Use end dates and renewals.
- Changing your signing key invalidates every key issued with the old one.
