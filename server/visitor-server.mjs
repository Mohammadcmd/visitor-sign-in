#!/usr/bin/env node
// Visitor Sign-In on a Raspberry Pi or a PC (server/README.md).
//   node server/visitor-server.mjs [--data <folder>] [--name "Front desk"] [--site <website>] [--tz America/Chicago]
//   node server/visitor-server.mjs --print-link     just print the setup link
//
// Keeps the visitor records in the data folder, stays connected to the
// website so visitors' phones (the QR code by the door) and the admin screen
// can reach it, and does the daily jobs: signing everyone out at the end of
// the day and deleting old records. Leave it running (install-pi.sh makes it
// start by itself).
import { homedir } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBox } from './box.mjs';
import { connectRelay } from './relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback = '') => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) { console.error(`Visitor Sign-In needs Node.js 22 or newer (this is ${process.versions.node}). Get it from https://nodejs.org/`); process.exit(1); }

const siteFromConfig = (/^\s*SITE_URL: '([^']*)'/m.exec(readFileSync(join(here, '../web/config.js'), 'utf8')) || [])[1] || '';
const site = (opt('site', process.env.VSI_SITE || siteFromConfig)).replace(/\/?$/, '/');
const dataDir = resolve(opt('data', process.env.VSI_DATA || join(homedir(), 'Visitor Sign-In')));
const box = openBox({ dataDir, name: opt('name', process.env.VSI_NAME || ''), timeZone: opt('tz', process.env.VSI_TZ || '') });
const { setup } = box.links(site);
if (args.includes('--print-link')) { console.log(setup); process.exit(0); }

// The setup link, as a page with a QR code to scan with a tablet or phone.
const { qrSvg } = await import('../web/js/qr.js');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
writeFileSync(join(dataDir, 'setup-link.html'), `<!doctype html><meta charset="utf-8"><title>Set up Visitor Sign-In</title>
<body style="font:17px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px">
<h1>Set up Visitor Sign-In</h1>
<p>Open this link on the computer, tablet or phone you'll use for the admin screen. It's connected to <strong>${esc(box.config.name)}</strong>, which keeps the records.</p>
${qrSvg(setup, { size: 260, label: 'Setup link' })}
<p style="word-break:break-all"><a href="${esc(setup)}">${esc(setup)}</a></p>
<p><strong>Keep this link private:</strong> it gives admin access to the setup (the admin PIN protects the admin screen afterwards).</p>
</body>`);

console.log(`Visitor Sign-In ${box.config.name}
  Records:    ${dataDir}
  Website:    ${site}
  Setup link: ${setup}
              (also in ${join(dataDir, 'setup-link.html')}, with a QR code)
Keep this window open, or install it as a service (server/README.md).`);

const relay = connectRelay({ siteUrl: site, box, log: (m) => console.log(`${new Date().toLocaleString()}  ${m}`) });
const chores = () => box.chores().then((r) => {
  if (r.endOfDay) console.log(`${new Date().toLocaleString()}  End of day: signed out ${r.endOfDay} visitor(s).`);
}).catch((err) => console.error('Daily jobs failed:', err.message));
chores();
const timer = setInterval(chores, 60 * 1000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { clearInterval(timer); relay.close(); console.log('Stopped.'); process.exit(0); });
}
