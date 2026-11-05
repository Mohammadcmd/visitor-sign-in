# Visitor Sign-In cloud service

The cloud side of Visitor Sign-In, on Cloudflare Workers. It's being built in phases; see [docs/ROADMAP.md](../docs/ROADMAP.md).

## How it works

- **One Durable Object per company** (`src/company.js`). Each company's records live in that object's own SQLite database, one row per record (`src/store.js`). One company's data can never reach another's, and requests are handled one at a time, so tablets never overwrite each other.
- **The same rules as the kiosk.** The object runs the kiosk's shared engine (`web/js/engine.js`), the same code the on-tablet kiosk uses, and answers the same actions with the same JSON as the Google Sheets script. A kiosk claims a company with a kiosk key, then sends that key with every call.
- **Photos, signatures and logos** go to R2 (`src/files.js`), in a folder per company.
- **The Worker** (`src/index.js`) sends `POST /v1/c/<company id>` to that company's object. `GET /` is a health check.

For now, kiosks connect with a company id and a kiosk key, as they do with a Google Sheet. Sign-up, staff logins, tablets locked to a company and billing come next (Phase 1 and 3 of the roadmap).

## Run the tests

```bash
cd cloud
npm ci
npm test
```

`test/store.test.js` checks the record store against SQLite. `test/worker.test.js` starts the real Worker and Durable Objects in Cloudflare's local runtime and checks claiming, settings, photos, badges, retries, two tablets at once, records surviving a restart, company time zones, and that companies are kept apart.

`npm run dev` runs the service locally at `http://localhost:8787`.

## Deploy

Free to start (the Workers Free plan includes SQLite Durable Objects; R2 is free up to 10 GB).

1. Make a free Cloudflare account, then from this folder: `npx wrangler login`.
2. Create the storage for photos once: `npx wrangler r2 bucket create visitor-sign-in-files`.
3. `npm run deploy`. Wrangler prints the address, such as `https://visitor-sign-in.<your-subdomain>.workers.dev`.

Move to the Workers Paid plan ($5 a month) once paying customers rely on it: it allows far more processing time per request than the Free plan's 10 ms.
