// Shared by the license tools: your signing key, the ledger of licenses and
// payments, and the status files the kiosks read.
//
// Everything lives in the folder you run the tools from (next to
// license-private.pem), never in the repository:
//   licenses.json      every license you've issued and every payment recorded (keep it backed up)
//   license-status/    one small signed file per license. Each one is also sent to the
//                      website (PAYWALL.statusUrl, site/README.md), which keeps it only if
//                      it's signed with your key. Kiosks read their own file to pick up
//                      renewals and to know if a license was switched off.
import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const args = process.argv.slice(2);
export const opt = (name, fallback = '') => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
export const flag = (name) => args.includes(`--${name}`);
export const fail = (msg) => { console.error(msg); process.exit(1); };

const b64url = (buf) => Buffer.from(buf).toString('base64url');
let privateKey = null;
function key() {
  if (!privateKey) {
    const file = opt('key', process.env.LICENSE_KEY_FILE || 'license-private.pem');
    if (!existsSync(file)) fail(`No signing key at ${file}. Make one with: npm run license:keygen`);
    privateKey = createPrivateKey(readFileSync(file));
  }
  return privateKey;
}

/** Signs a payload as prefix.<payload>.<signature> (VSI1 license keys, VSS1 status files). */
export function signed(prefix, payload) {
  const body = `${prefix}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${b64url(sign('sha256', Buffer.from(body), { key: key(), dsaEncoding: 'ieee-p1363' }))}`;
}

export const newId = () => randomBytes(8).toString('hex');
export const today = () => new Date().toISOString().slice(0, 10);
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
/** The same day a number of years later, as YYYY-MM-DD. */
export function addYears(ymd, years) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
export const TABLET_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const ledgerFile = () => opt('ledger', 'licenses.json');
const statusDir = () => opt('out', 'license-status');

export function readLedger() {
  const file = ledgerFile();
  if (!existsSync(file)) return { licenses: [], payments: [] };
  const l = JSON.parse(readFileSync(file, 'utf8'));
  return { licenses: l.licenses || [], payments: l.payments || [] };
}
export function writeLedger(l) {
  writeFileSync(ledgerFile(), `${JSON.stringify(l, null, 2)}\n`);
}

export function findLicense(l, id) {
  const lic = l.licenses.find((x) => x.id === id);
  if (!lic) fail(`No license ${id} in ${ledgerFile()}. See them all with: npm run license:list`);
  return lic;
}

/** A license key: who, which tablet, paid until when. */
export function makeKey(lic) {
  return signed('VSI1', { id: lic.id, customer: lic.customer, plan: 'pro', tablet: lic.tablet || '', expires: lic.until || '', issued: today() });
}

/** Writes the license's status file (and the website's headers file the first time). */
export function writeStatus(lic) {
  const dir = statusDir();
  mkdirSync(dir, { recursive: true });
  const headers = join(dir, '_headers');
  // Cloudflare Pages and Netlify read this: kiosks (on another address) may read the files and the server's time.
  if (!existsSync(headers)) writeFileSync(headers, '/*\n  Access-Control-Allow-Origin: *\n  Access-Control-Expose-Headers: Date\n  Cache-Control: no-store\n');
  writeFileSync(join(dir, `${lic.id}.txt`), `${signed('VSS1', { id: lic.id, status: lic.status, key: lic.key, at: new Date().toISOString() })}\n`);
  return join(dir, `${lic.id}.txt`);
}

/**
 * Where status files are sent: --publish <url>, or PAYWALL.statusUrl in
 * web/js/plans.js once licensing is switched on there with this signing key's
 * public half. Otherwise { why } says why not. --no-publish: never.
 */
export async function publishTarget() {
  if (flag('no-publish')) return { why: '--no-publish' };
  if (opt('publish')) return { url: opt('publish').replace(/\/?$/, '/') };
  globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const here = dirname(fileURLToPath(import.meta.url));
  const { PAYWALL } = await import(pathToFileURL(join(here, '../../web/js/plans.js')).href);
  if (!PAYWALL.statusUrl) return { why: 'PAYWALL.statusUrl in web/js/plans.js is empty' };
  if (!PAYWALL.enabled) return { why: "licensing isn't switched on in web/js/plans.js yet (PAYWALL.enabled)" };
  const mine = createPublicKey(key()).export({ format: 'jwk' });
  if (PAYWALL.publicKey?.x !== mine.x || PAYWALL.publicKey?.y !== mine.y) return { why: "this signing key isn't the one in PAYWALL.publicKey (web/js/plans.js)" };
  return { url: PAYWALL.statusUrl.replace(/\/?$/, '/') };
}

/** Sends a license's status file to the website. Returns a line to print. */
export async function publishStatus(id, target) {
  const file = join(statusDir(), `${id}.txt`);
  if (!target) target = await publishTarget();
  if (!target.url) return `Not sent to the website: ${target.why}. Kiosks pick it up once it is (npm run license:publish).`;
  try {
    const res = await fetch(`${target.url}${id}.txt`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: readFileSync(file, 'utf8') });
    const text = (await res.text()).trim();
    if (res.ok) return `Sent to the website: ${text}`;
    process.exitCode = 1;
    return `The website refused it (${res.status}): ${text}`;
  } catch (err) {
    process.exitCode = 1;
    return `Couldn't reach the website (${err.cause?.code || err.message}). When you're online: npm run license:publish -- --id ${id}`;
  }
}

/** Records a payment if --paid was given: --paid check|card|bank|other --amount 149 --ref 1234 --note "…" */
export function recordPayment(l, lic, what) {
  const method = opt('paid');
  if (!method) return null;
  if (!['check', 'card', 'bank', 'other'].includes(method)) fail('--paid should be check, card, bank or other');
  const amount = Number(opt('amount'));
  if (!(amount > 0)) fail('--amount should be the amount paid, such as 149');
  const p = { date: opt('date', today()), license: lic.id, customer: lic.customer, tablet: lic.tablet, amount, method, ref: opt('ref'), note: opt('note', what) };
  if (!isDate(p.date)) fail('--date should look like 2026-11-05');
  l.payments.push(p);
  return p;
}

export const money = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
