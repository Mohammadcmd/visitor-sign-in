// A license for one kiosk tablet, paid until a date (a year from today unless you say).
//   npm run license:issue -- --customer "Acme Robotics" --tablet K7M2-9XQ4
//        [--until 2027-11-05 | --days 365 | --forever] [--email owner@acme.com]
//        [--paid check --amount 499 --ref 1234]      records the payment too
//        [--link https://your-kiosk-address/] [--qr acme-license.svg]
//        [--any-tablet]                              instead of --tablet: works on any tablet (your own use)
//
// The tablet code is on the tablet: Admin → Settings → License (and on the
// paused screen). Prints the key; the customer enters it in Admin → Settings →
// License (type, paste, or scan --qr), or opens --link on the tablet once.
// Also saves it in licenses.json and writes its status file in license-status/.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TABLET_RE, addYears, fail, flag, isDate, makeKey, money, newId, opt, readLedger, recordPayment, today, writeLedger, writeStatus } from './lib.mjs';

const customer = opt('customer').trim();
if (!customer) fail('Usage: npm run license:issue -- --customer "Company name" --tablet K7M2-9XQ4 [--until 2027-11-05 | --days 365 | --forever] [--paid check --amount 499 --ref 1234]');
const tablet = opt('tablet').trim().toUpperCase();
if (!flag('any-tablet') && !TABLET_RE.test(tablet)) fail('--tablet should be the code shown on the tablet, such as K7M2-9XQ4 (or use --any-tablet)');

let until = opt('until') || opt('expires');
if (!until && !flag('forever')) {
  until = opt('days') ? new Date(Date.now() + Number(opt('days')) * 86400000).toISOString().slice(0, 10) : addYears(today(), 1);
}
if (until && !isDate(until)) fail('--until should look like 2027-11-05');

const ledger = readLedger();
const lic = { id: newId(), customer, email: opt('email'), tablet: flag('any-tablet') ? '' : tablet, until: until || '', issued: today(), status: 'active', key: '' };
lic.key = makeKey(lic);
ledger.licenses.push(lic);
const paid = recordPayment(ledger, lic, 'New license');
writeLedger(ledger);
const statusFile = writeStatus(lic);

console.log(lic.key);
const link = opt('link');
if (link) console.error(`\nLicense link: ${link.replace(/\/?$/, '/')}?license=${lic.key}`);
const qrFile = opt('qr');
if (qrFile) {
  const here = dirname(fileURLToPath(import.meta.url));
  const { qrSvg } = await import(pathToFileURL(join(here, '../../web/js/qr.js')).href);
  writeFileSync(qrFile, qrSvg(lic.key, { size: 360, label: 'Visitor Sign-In license key' }));
  console.error(`QR code saved to ${qrFile}: the kiosk can scan it (License → Scan the key's QR code).`);
}
console.error(`\n${customer}: tablet ${lic.tablet || 'any'}, ${lic.until ? `paid until ${lic.until}` : 'no end date'} (license ${lic.id})`);
if (paid) console.error(`Payment recorded: ${money(paid.amount)} by ${paid.method}${paid.ref ? ` (${paid.ref})` : ''}.`);
console.error(`Saved in licenses.json; status file ${statusFile} (publish the license-status folder to your website).`);
