# The website (Cloudflare)

Your own website for Visitor Sign-In, on Cloudflare's free plan. It keeps everything working once the GitHub repository is private:

| Address | What it is |
|---|---|
| `/` | The install page: the Android app on an Android tablet, the browser kiosk on an iPad, a QR code on a computer, and "Buy" once licensing is on |
| `/web/` | The browser kiosk. Phone sign-in QR codes point here, from the Android app too |
| `/downloads.html`, `/downloads/…` | The Android app and the browser kiosk zip |
| `/latest.json` | The newest version: kiosks check it and offer the update in Admin → Settings → Diagnostics |
| `/license-status/<id>.txt` | Each license's signed status file. Kiosks read theirs to pick up renewals and switch-offs |
| `/launch.html`, `/privacy-notice.html` | The launch checklist and the visitor privacy notice template |

Address for now: **https://visitor-sign-in.mohammadjalbibi.workers.dev/** (`SITE_URL` in `web/config.js`).

## How it works

- `site/worker.js` is a Cloudflare Worker. Everything is a static file made by `scripts/build-site.mjs`, except the license status files.
- License status files are kept in Workers KV (`LICENSES` in `site/wrangler.jsonc`). Your license tools send them when they issue, renew or switch a license (`npm run license:publish` sends them all again).
- The website keeps a status file only if it's signed with your license key and newer than the one it has. So no one else can switch a kiosk off or back on, even though anyone can send one. It checks against `license-public-key.json`, which the build makes from `PAYWALL.publicKey`.
- Free plan limits: 100,000 requests a day, plus 1,000 status file changes a day. A kiosk checks its license a few times a day.

## Publishing

**Automatically, with each release.** Add your Cloudflare API token to GitHub once: **Settings → Secrets and variables → Actions → New repository secret**, named `CLOUDFLARE_API_TOKEN`. Then each release (pushing a `v*` tag) builds the app and publishes the website with it.

**Without a release** (a docs change, say): **Actions → Publish the website (Cloudflare) → Run workflow**. The Android app already on the website stays.

**From a computer:** `CLOUDFLARE_API_TOKEN=… npm run site:deploy`. Add `--apk app.apk` to `npm run site:build` for a new app.

**The API token:** Cloudflare dashboard → My Profile → API Tokens → Create Token → the **Edit Cloudflare Workers** template, with your account under Account Resources. Copy the token's value when it's shown (only once). If it's lost, use **Roll** to get a new value.

## Selling: switching it on

1. Make your signing key on your own computer: `npm run license:keygen`. Put the printed public key in `PAYWALL.publicKey` and set `enabled: true` in `web/js/plans.js` ([docs/PAYWALL.md](../docs/PAYWALL.md)).
2. Publish the website (a release, or the workflow above), so it has your public key.
3. Issue licenses as usual. Each status file goes to the website by itself.

## A domain of your own later

Buy one (Cloudflare Registrar, about $10 a year). Then:
1. In the dashboard, open **Workers & Pages → visitor-sign-in → Settings → Domains & Routes → Add → Custom domain**.
2. Change `SITE_URL` in `web/config.js` and `statusUrl` in `web/js/plans.js` to the new address, and release.

Kiosks already sold keep reading the old workers.dev address until they update. So keep both addresses working: the Worker answers on both.
