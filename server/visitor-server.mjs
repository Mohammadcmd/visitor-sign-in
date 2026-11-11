#!/usr/bin/env node
// Visitor Sign-In on a Raspberry Pi or a PC (server/README.md).
//   node server/visitor-server.mjs [--data <folder>] [--name "Front desk"] [--port 8080] [--tz America/Chicago]
//   node server/visitor-server.mjs --print-link     just print the setup link
//
// Keeps the visitor records in the data folder and serves the sign-in page
// on this building's Wi-Fi (http://<this computer>:8080/): the admin screen,
// and visitors' phones from the QR code by the door. No website, accounts or
// internet needed. It also does the daily jobs: signing everyone out at the
// end of the day and deleting old records. Leave it running (install-pi.sh
// makes it start by itself on a Pi).
//
// With --site <website> it also stays connected to that website (site/,
// relay.mjs), so phones on mobile data reach it too, over https.
import { homedir, hostname } from 'node:os';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBox } from './box.mjs';
import { connectRelay } from './relay.mjs';
import { lanAddress, serveLocal } from './local.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback = '') => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) { console.error(`Visitor Sign-In needs Node.js 22 or newer (this is ${process.versions.node}). Get it from https://nodejs.org/`); process.exit(1); }

const rawSite = opt('site', process.env.VSI_SITE || '');
const site = rawSite ? rawSite.replace(/\/?$/, '/') : '';
const online = !!site;
const port = Number(opt('port', process.env.VSI_PORT || 8080));
const address = opt('address', process.env.VSI_ADDRESS || lanAddress());
const dataDir = resolve(opt('data', process.env.VSI_DATA || join(homedir(), 'Visitor Sign-In')));
const box = openBox({ dataDir, name: opt('name', process.env.VSI_NAME || ''), defaultName: hostname(), timeZone: opt('tz', process.env.VSI_TZ || '') });
const localBase = `http://${address}:${port}/`;
const { setup } = box.links(online ? site : localBase);
if (args.includes('--print-link')) { console.log(setup); process.exit(0); }

let local;
try {
  local = await serveLocal({ box, webDir: join(here, '../web'), port, address });
} catch (err) {
  console.error(err.code === 'EADDRINUSE'
    ? `Port ${port} is already in use: is Visitor Sign-In already running in another window? To use another port: --port 8081`
    : `Couldn't start the sign-in page: ${err.message}`);
  process.exit(1);
}
box.setLocal(local.base);

// The setup link, as a page with a QR code to scan with a tablet or phone.
const { qrSvg } = await import('../web/js/qr.js');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
writeFileSync(join(dataDir, 'setup-link.html'), `<!doctype html><meta charset="utf-8"><title>Set up Visitor Sign-In</title>
<body style="font:17px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px">
<h1>Set up Visitor Sign-In</h1>
<p>Open this link on the computer, tablet or phone you'll use for the admin screen${online ? '' : ', on the same Wi-Fi as this computer'}. It's connected to <strong>${esc(box.config.name)}</strong>, which keeps the records.</p>
${qrSvg(setup, { size: 260, label: 'Setup link' })}
<p style="word-break:break-all"><a href="${esc(setup)}">${esc(setup)}</a></p>
<p><strong>Keep this link private:</strong> it gives admin access to the setup (the admin PIN protects the admin screen afterwards).</p>
</body>`);

console.log(`Visitor Sign-In on "${box.config.name}"
  Records:     ${dataDir}
  On the Wi-Fi: ${local.base}
  Setup link:  ${setup}
               (also in ${join(dataDir, 'setup-link.html')}, with a QR code)
Open the setup link on a computer, tablet or phone on the same Wi-Fi as this one.
If Windows asks about Node.js and networks, allow it on private networks.
Keep this window open while you're open for visitors.`);

const log = (m) => console.log(`${new Date().toLocaleString()}  ${m}`);
const relay = online ? connectRelay({ siteUrl: site, box, log }) : null;
const chores = () => box.chores().then((r) => {
  if (r.endOfDay) log(`End of day: signed out ${r.endOfDay} visitor(s).`);
}).catch((err) => console.error('Daily jobs failed:', err.message));
chores();
const timer = setInterval(chores, 60 * 1000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { clearInterval(timer); relay?.close(); local.server.close(); console.log('Stopped.'); process.exit(0); });
}
