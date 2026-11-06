# Visitor Sign-In cloud service

The cloud side of Visitor Sign-In, on Cloudflare Workers. It's being built in phases; see [docs/ROADMAP.md](../docs/ROADMAP.md).

## How it works

- **One Durable Object per company** (`src/company.js`). Each company's records live in that object's own SQLite database, one row per record (`src/store.js`). One company's data can never reach another's, and requests are handled one at a time, so tablets never overwrite each other.
- **The same rules as the kiosk.** The object runs the kiosk's shared engine (`web/js/engine.js`), the same code the on-tablet kiosk uses, and answers the same actions with the same JSON as the Google Sheets script.
- **Staff accounts** (`src/directory.js`, one Durable Object). Signing up and signing in are the same: type your email address, get a six-digit code, type it. There are no passwords to store, forget or leak.
  - Codes work once, for 10 minutes. Five wrong guesses end a code, and an address can be sent five codes an hour.
  - Codes and sessions are kept only as hashes. Sessions last 30 days.
  - The person who makes a company is its **owner**. Owners and admins add colleagues as **admin** or **front desk**.
- **Tablets locked to a company.**
  - **Activating:** an owner or admin signs in on the tablet. The tablet makes a key pair it can't export and registers the public half with the company.
  - **Checking in:** to work, the tablet signs a one-time challenge and gets a device token. The token is good for 7 days and renewed by checking in. Kiosk calls carry that token.
  - **Retiring:** a retired tablet's token stops working at once, and it can't check in again.
  - Another tablet can't pretend to be this one, and the token doesn't open any other company.
- **Photos, signatures and logos** go to R2 (`src/files.js`), in a folder per company.
- **Email** goes through Resend (`src/mail.js`). In the test environment it's logged instead of sent.

The routes are listed at the top of `src/index.js`. Companies can also work with a kiosk key, the way a Google Sheet does (the first kiosk claims the company, and others bring the same key). That's only allowed where `ALLOW_KIOSK_KEY_COMPANIES` is set (tests and local development), never in production and never for a company made by signing up.

## Run the tests

```bash
cd cloud
npm ci
npm test
```

All three run the real Worker and Durable Objects in Cloudflare's local runtime (workerd), with the `test` environment from `wrangler.jsonc`:

- `test/store.test.js`: the record store against SQLite.
- `test/worker.test.js`: the kiosk actions. It covers claiming, settings, photos, badges, retries, two tablets at once, records surviving a restart, company time zones, and companies kept apart.
- `test/accounts.test.js`: accounts and tablets. It covers signing up by code, guessing limits, companies and roles, activating a tablet with a real key pair, checking in by signature, kiosk calls with the device token, retiring, and the production defaults.

`npm run dev` runs the service locally at `http://localhost:8787`, logging emails instead of sending them.

## Deploy

It's free to start: the Workers Free plan includes SQLite Durable Objects, R2 is free up to 10 GB, and Resend is free up to 3,000 emails a month.

1. Make a free Cloudflare account, then from this folder run `npx wrangler login`.
2. Create the storage for photos (once): `npx wrangler r2 bucket create visitor-sign-in-files`.
3. **Email:** make a free Resend account and verify your domain there. Then:
   - Set `MAIL_FROM` in `wrangler.jsonc`, for example `"Visitor Sign-In <signin@yourdomain.com>"`.
   - Store the API key as a secret: `npx wrangler secret put RESEND_API_KEY`.
4. `npm run deploy`. Wrangler prints the address, such as `https://visitor-sign-in.<your-subdomain>.workers.dev`.

Move to the Workers Paid plan ($5 a month) once paying customers rely on it. It allows far more processing time per request than the Free plan's 10 ms.
