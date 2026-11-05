// Licenses end to end: the seller's tools (tools/license/) make a signing key,
// issue a license for one tablet, record payments, renew and switch it off,
// and the kiosk's own code (web/js/plans.js) checks all of it.
//   node tests/license.test.mjs
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plans = await import(join(root, 'web/js/plans.js'));
const { PAYWALL, verifyLicense, verifyStatus, refresh, checkStatus, can, entitlement, isPaused, signedPart, tabletCode, saveKey, savedKey, forgetTablet } = plans;
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };
const rejects = async (p, re, m) => { try { await p; } catch (err) { ok(re.test(err.message), `${m}: ${err.message}`); return; } assert.fail(`${m}: expected an error`); };

// The kiosk keeps its tablet code, key and status in localStorage: a small one for Node.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const day = 86400000;
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dir = mkdtempSync(join(tmpdir(), 'vsi-license-'));
try {
  const tool = (script, args) => execFileSync(process.execPath, [join(root, 'tools/license', script), ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const fails = (script, args, re, m) => {
    try { tool(script, args); } catch (err) { ok(re.test(String(err.stderr)), `${m}: ${err.stderr}`); return; }
    assert.fail(`${m}: expected the tool to refuse`);
  };
  const ledger = () => JSON.parse(readFileSync(join(dir, 'licenses.json'), 'utf8'));
  const statusText = (id) => readFileSync(join(dir, 'license-status', `${id}.txt`), 'utf8');

  // ------------------------------------------------------------ the seller's signing key
  const publicKey = JSON.parse(/publicKey: (\{.*\}),/.exec(tool('keygen.mjs', []))[1]);
  ok(publicKey.kty === 'EC' && publicKey.crv === 'P-256' && publicKey.x && !publicKey.d, 'the public key has no private part');
  fails('keygen.mjs', [], /already exists/, "keygen won't overwrite an existing key");

  // ------------------------------------------------------------ this tablet's code
  forgetTablet();
  const tablet = tabletCode();
  ok(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(tablet), `a readable tablet code: ${tablet}`);
  eq(tabletCode(), tablet, 'the same code every time');
  ok(mem.get('kiosk-tablet-code') === tablet, 'kept with the kiosk data');

  // ------------------------------------------------------------ issuing, with a check payment
  fails('issue.mjs', ['--customer', 'Acme'], /--tablet should be the code/, 'a license names a tablet');
  const issued = tool('issue.mjs', ['--customer', 'Acme Robotics', '--tablet', tablet, '--email', 'owner@acme.example', '--paid', 'check', '--amount', '499', '--ref', '1001']).trim();
  ok(/^VSI1\.[\w-]+\.[\w-]+$/.test(issued), issued);
  const lic = ledger().licenses[0];
  ok(lic.customer === 'Acme Robotics' && lic.tablet === tablet && lic.status === 'active' && /^[0-9a-f]{16}$/.test(lic.id), JSON.stringify(lic));
  const nextYear = new Date(); nextYear.setFullYear(nextYear.getFullYear() + 1);
  eq(lic.until, nextYear.toISOString().slice(0, 10), 'paid for a year from today');
  eq(ledger().payments.map((p) => [p.amount, p.method, p.ref, p.license]), [[499, 'check', '1001', lic.id]], 'the check is recorded');
  ok(existsSync(join(dir, 'license-status', '_headers')) && /Access-Control-Allow-Origin: \*/.test(readFileSync(join(dir, 'license-status', '_headers'), 'utf8')), 'the status folder is ready for a website');

  // ------------------------------------------------------------ the kiosk checks keys
  const info = await verifyLicense(issued, publicKey, tablet);
  eq([info.customer, info.tablet, info.expires], ['Acme Robotics', tablet, lic.until]);
  await rejects(verifyLicense(issued, publicKey, 'ZZZZ-ZZZZ'), /is for tablet .*This tablet is ZZZZ-ZZZZ/, 'a key for another tablet is refused');
  await rejects(verifyLicense('hello', publicKey), /doesn't look like a license/, 'not a key');
  const [, body, sig] = issued.split('.');
  const edited = signedPart({ ...JSON.parse(Buffer.from(body, 'base64url')), expires: '2099-12-31' });
  await rejects(verifyLicense(`${edited}.${sig}`, publicKey), /isn't valid/, 'a key with its date changed is refused');
  await rejects(verifyLicense(issued.slice(0, -4), publicKey), /isn't valid/, 'a cut-off key is refused');
  const other = mkdtempSync(join(tmpdir(), 'vsi-license-other-'));
  const otherKey = JSON.parse(/publicKey: (\{.*\}),/.exec(execFileSync(process.execPath, [join(root, 'tools/license/keygen.mjs')], { cwd: other, encoding: 'utf8' }))[1]);
  rmSync(other, { recursive: true, force: true });
  await rejects(verifyLicense(issued, otherKey), /isn't valid/, "another seller's key doesn't accept it");

  // ------------------------------------------------------------ off by default: free to use
  eq(PAYWALL.enabled, false, 'licensing ships switched off');
  eq((await refresh({})).status, 'off');
  ok(!isPaused() && can('export'), 'nothing is paused while it is off');

  PAYWALL.enabled = true;
  PAYWALL.publicKey = publicKey;
  const ago = (n) => new Date(Date.now() - n * day).toISOString();

  // The trial: everything, then paused.
  let st = await refresh({ trialStarted: ago(5) });
  eq([st.status, st.daysLeft], ['trial', 25]);
  eq((await refresh({})).status, 'trial', 'a kiosk not set up yet is on the trial, so setup is never paused');
  st = await refresh({ trialStarted: ago(31) });
  eq([st.status, st.reason], ['paused', 'trial'], 'after the trial, new sign-ins pause');
  ok(isPaused() && can('export'), 'exports still work while paused');

  // Licensed.
  saveKey(issued);
  eq(savedKey(), issued, 'the key is kept on this tablet');
  st = await refresh({ trialStarted: ago(400) });
  eq([st.status, st.license.customer, st.renewSoon], ['licensed', 'Acme Robotics', false]);
  ok(st.daysLeft >= 364 && st.daysLeft <= 366, `days left: ${st.daysLeft}`);

  // Near the end, overdue (grace), then paused.
  const keyEnding = (until) => {
    const t = tool('issue.mjs', ['--customer', 'Initech', '--tablet', tablet, '--until', until]).trim();
    return { key: t, id: ledger().licenses.at(-1).id };
  };
  saveKey(keyEnding(ymd(Date.now() + 10 * day)).key);
  st = await refresh({ trialStarted: ago(400) });
  ok(st.status === 'licensed' && st.renewSoon && st.daysLeft <= 11, 'the admin is reminded a month before');
  saveKey(keyEnding(ymd(Date.now() - 3 * day)).key);
  st = await refresh({ trialStarted: ago(400) });
  ok(st.status === 'grace' && !isPaused() && st.daysLeft >= 10 && st.daysLeft <= 12, `overdue but still working for the grace period: ${JSON.stringify(st)}`);
  const lapsed = keyEnding(ymd(Date.now() - 20 * day));
  saveKey(lapsed.key);
  st = await refresh({ trialStarted: ago(400) });
  eq([st.status, st.reason], ['paused', 'lapsed'], 'after the grace period, new sign-ins pause');

  // A key in the shared settings (older kiosks) still counts, but only on its tablet.
  forgetTablet();
  const newTablet = tabletCode();
  ok(newTablet !== tablet, 'another tablet has another code');
  st = await refresh({ license: issued, trialStarted: ago(400) });
  ok(st.status === 'paused' && /is for tablet/.test(st.error), "a key copied to another tablet doesn't work there");
  forgetTablet();
  mem.set('kiosk-tablet-code', tablet);

  // ------------------------------------------------------------ renewing: the kiosk picks it up by itself
  saveKey(lapsed.key);
  const renewed = tool('renew.mjs', ['--id', lapsed.id, '--paid', 'check', '--amount', '149', '--ref', '1002']).trim();
  const r = ledger().licenses.find((l) => l.id === lapsed.id);
  eq(r.until, (() => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); })(), 'a lapsed license renews from today');
  ok(renewed === r.key, 'the renewed key is printed');
  ok((await verifyStatus(statusText(lapsed.id), publicKey)).key === renewed, 'and published in its status file');
  const site = (text, date = new Date()) => async () => ({ ok: !!text, status: text ? 200 : 404, headers: { get: (h) => (h === 'Date' ? date.toUTCString() : null) }, text: async () => text || '' });
  st = await refresh({ trialStarted: ago(400) });
  eq(st.status, 'paused');
  st = await checkStatus(site(statusText(lapsed.id)));
  ok(st.status === 'paused', 'no status URL set: nothing is fetched');
  PAYWALL.statusUrl = 'https://licenses.example.com/';
  let asked = '';
  st = await checkStatus(async (url) => { asked = url; return site(statusText(lapsed.id))(); });
  eq(asked, `https://licenses.example.com/${lapsed.id}.txt`, "the kiosk asks for its own license's file");
  ok(st.status === 'licensed' && st.license.expires === r.until && savedKey() === renewed, 'the renewal turns the kiosk back on without typing a key');
  eq(ledger().payments.map((p) => p.amount), [499, 149], 'both payments in the ledger');
  fails('renew.mjs', ['--id', lapsed.id, '--until', '2020-01-01'], /isn't after/, 'a renewal must move the date forward');

  // ------------------------------------------------------------ switching a license off (a bounced check), and on
  tool('switch.mjs', ['off', '--id', lapsed.id, '--note', 'check 1002 bounced']);
  st = await checkStatus(site(statusText(lapsed.id)));
  eq([st.status, st.reason], ['paused', 'off'], 'switched off: new sign-ins pause at the next check');
  st = await checkStatus(site(''));
  eq(st.status, 'paused', 'a missing file or no network changes nothing');
  ok(ledger().licenses.find((l) => l.id === lapsed.id).notes.some((n) => /bounced/.test(n)), 'the reason is noted');
  tool('switch.mjs', ['on', '--id', lapsed.id]);
  st = await checkStatus(site(statusText(lapsed.id)));
  eq(st.status, 'licensed', 'switched back on');

  // A status file can't be forged, and one for another license is ignored.
  const forgedOff = `${signedPart({ id: lapsed.id, status: 'off', key: '', at: new Date().toISOString() }, 'VSS1')}.${'A'.repeat(86)}`;
  st = await checkStatus(site(forgedOff));
  eq(st.status, 'licensed', 'a forged status file is ignored');
  st = await checkStatus(site(statusText(ledger().licenses[0].id)));
  eq(st.status, 'licensed', "another license's file is ignored");

  // ------------------------------------------------------------ setting the clock back doesn't stretch a license
  const shortKey = keyEnding(ymd(Date.now() - 30 * day));
  saveKey(shortKey.key);
  mem.delete('kiosk-server-time'); // a tablet that hasn't heard from a server yet
  const realNow = Date.now;
  Date.now = () => realNow() - 40 * day; // the tablet's clock set back 40 days
  st = await refresh({ trialStarted: ago(400) });
  eq(st.status, 'licensed', 'with only the tablet clock to go on, it looks paid');
  await checkStatus(site(statusText(shortKey.id), new Date(realNow())));
  st = await refresh({ trialStarted: ago(400) });
  eq([st.status, st.reason], ['paused', 'lapsed'], "once a server has told it the real date, the clock can't be set back");
  Date.now = realNow;

  // ------------------------------------------------------------ the seller's lists
  const list = tool('list.mjs', []);
  ok(/Acme Robotics/.test(list) && /ENDED/.test(list), list);
  const due = tool('list.mjs', ['--due', '15']);
  ok(/Initech/.test(due) && !/Acme Robotics/.test(due), `only what's due: ${due}`);
  const csv = tool('list.mjs', ['payments']);
  ok(/^Date,Customer,Tablet,License,Amount,Method,Reference,Note\r\n/.test(csv) && /Acme Robotics,.*,499,check,1001/.test(csv), csv);
  eq(entitlement(), st);
} finally {
  rmSync(dir, { recursive: true, force: true });
  PAYWALL.enabled = false;
  PAYWALL.statusUrl = '';
}
console.log(`license tests passed (${checks} checks)`);
