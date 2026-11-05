// Makes a license key for a customer.
//   node tools/license/issue.mjs --customer "Acme Robotics" [--plan pro] [--tablets 3]
//                                [--days 365 | --expires 2027-12-31 | --forever]
//                                [--key license-private.pem]
//                                [--link https://your-kiosk-address/] [--qr license.svg]
// Prints the key. The customer enters it in Admin → Settings → Plans and license,
// scans the QR code (--qr) with the kiosk's camera, or opens the link (--link)
// on the tablet's browser once.
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);

const customer = opt('customer', '');
if (!customer) { console.error('Usage: node tools/license/issue.mjs --customer "Company name" [--plan pro] [--tablets 3] [--days 365 | --expires YYYY-MM-DD | --forever]'); process.exit(1); }
const plan = opt('plan', 'pro');
let expires = opt('expires', '');
if (!expires && !flag('forever')) {
  const d = new Date(Date.now() + Number(opt('days', 365)) * 86400000);
  expires = d.toISOString().slice(0, 10);
}
if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) { console.error('--expires should look like 2027-12-31'); process.exit(1); }

const payload = {
  id: randomBytes(6).toString('hex'), customer, plan,
  tablets: Number(opt('tablets', 0)) || 0, expires, issued: new Date().toISOString().slice(0, 10),
};
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const signed = `VSI1.${b64url(JSON.stringify(payload))}`;
const key = createPrivateKey(readFileSync(opt('key', process.env.LICENSE_KEY_FILE || 'license-private.pem')));
const sig = sign('sha256', Buffer.from(signed), { key, dsaEncoding: 'ieee-p1363' });
const license = `${signed}.${b64url(sig)}`;
console.log(license);
const link = opt('link', '');
if (link) console.error(`\nLicense link: ${link.replace(/\/?$/, '/')}?license=${license}`);
const qrFile = opt('qr', '');
if (qrFile) {
  const here = dirname(fileURLToPath(import.meta.url));
  const { qrSvg } = await import(pathToFileURL(join(here, '../../web/js/qr.js')).href);
  writeFileSync(qrFile, qrSvg(license, { size: 360, label: 'Visitor Sign-In license key' }));
  console.error(`QR code saved to ${qrFile}: the kiosk can scan it (Plans and license → Scan the key's QR code).`);
}
console.error(`\n${customer}: ${plan}${payload.tablets ? `, ${payload.tablets} tablets` : ''}, ${expires ? `until ${expires}` : 'no end date'} (license ${payload.id})`);
