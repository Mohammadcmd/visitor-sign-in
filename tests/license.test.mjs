// The paywall's license keys, end to end: the vendor tools make a signing key
// and a license, and the kiosk's own code (web/js/plans.js) checks it.
//   node tests/license.test.mjs
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plans = await import(join(root, 'web/js/plans.js'));
const { PAYWALL, verifyLicense, refresh, can, entitlement, signedPart } = plans;
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };
const rejects = async (p, re, m) => { try { await p; } catch (err) { ok(re.test(err.message), `${m}: ${err.message}`); return; } assert.fail(`${m}: expected an error`); };

const dir = mkdtempSync(join(tmpdir(), 'vsi-license-'));
try {
  const node = (script, args) => execFileSync(process.execPath, [join(root, 'tools/license', script), ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = node('keygen.mjs', []);
  const publicKey = JSON.parse(/publicKey: (\{.*\}),/.exec(out)[1]);
  ok(publicKey.kty === 'EC' && publicKey.crv === 'P-256' && publicKey.x && !publicKey.d, 'the public key has no private part');
  let refused = false;
  try { node('keygen.mjs', []); } catch { refused = true; }
  ok(refused, "keygen won't overwrite an existing key");

  const license = node('issue.mjs', ['--customer', 'Acme Robotics', '--tablets', '3', '--days', '30']).trim();
  ok(/^VSI1\.[\w-]+\.[\w-]+$/.test(license), license);
  const forever = node('issue.mjs', ['--customer', 'Initech', '--forever']).trim();
  const lapsed = node('issue.mjs', ['--customer', 'Globex', '--expires', '2020-01-31']).trim();

  // The kiosk checks it.
  const info = await verifyLicense(license, publicKey);
  eq([info.customer, info.plan, info.tablets], ['Acme Robotics', 'pro', 3]);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(info.expires), 'expiry date');
  eq((await verifyLicense(forever, publicKey)).expires, '', 'no end date');
  await rejects(verifyLicense('hello', publicKey), /doesn't look like a license/, 'not a key');
  const [, body, sig] = license.split('.');
  const forged = signedPart({ ...JSON.parse(Buffer.from(body, 'base64url')), tablets: 99 });
  await rejects(verifyLicense(`${forged}.${sig}`, publicKey), /isn't valid/, 'an edited license is refused');
  await rejects(verifyLicense(license.slice(0, -4), publicKey), /isn't valid/, 'a cut-off license is refused');
  const other = mkdtempSync(join(tmpdir(), 'vsi-license-other-'));
  const otherKey = JSON.parse(/publicKey: (\{.*\}),/.exec(execFileSync(process.execPath, [join(root, 'tools/license/keygen.mjs')], { cwd: other, encoding: 'utf8' }))[1]);
  rmSync(other, { recursive: true, force: true });
  await rejects(verifyLicense(license, otherKey), /isn't valid/, "another vendor's key doesn't accept it");
  await rejects(verifyLicense(license, null), /can't check/, 'no public key configured');

  // Plans: off by default, then trial, free, licensed and expired.
  eq(PAYWALL.enabled, false, 'the paywall ships switched off');
  eq((await refresh({})).status, 'off');
  ok(can('cloud') && can('languages'), 'everything is available while it is off');

  PAYWALL.enabled = true;
  PAYWALL.publicKey = publicKey;
  const day = 86400000;
  let st = await refresh({ trialStarted: new Date(Date.now() - 5 * day).toISOString() });
  eq([st.status, st.plan, st.daysLeft], ['trial', 'pro', 25]);
  ok(can('cloud') && can('export'), 'the trial includes Pro');
  st = await refresh({ trialStarted: new Date(Date.now() - 31 * day).toISOString() });
  eq([st.status, st.plan], ['trial-ended', 'free']);
  ok(!can('cloud') && !can('languages') && can('rollCall'), 'after the trial: Pro features pause, everything else stays');
  st = await refresh({ trialStarted: new Date(Date.now() - 400 * day).toISOString(), license });
  eq([st.status, st.plan, st.license.customer], ['licensed', 'pro', 'Acme Robotics']);
  ok(st.daysLeft > 28 && st.daysLeft <= 31, `days left on the license: ${st.daysLeft}`);
  ok(can('cloud'), 'a license unlocks Pro');
  st = await refresh({ license: forever });
  eq([st.status, st.daysLeft], ['licensed', Infinity]);
  st = await refresh({ license: lapsed, trialStarted: new Date(Date.now() - 400 * day).toISOString() });
  eq([st.status, st.plan], ['expired', 'free']);
  eq((await refresh({})).status, 'trial', 'a kiosk not set up yet is on the trial, so setup is never locked');
  ok(/ended on 2020-01-31/.test(st.error), st.error);
  st = await refresh({ license: 'VSI1.bad.key', trialStarted: new Date().toISOString() });
  eq(st.status, 'trial', 'a bad key during the trial keeps the trial');
  ok(st.error, 'and says what is wrong with the key');
  eq(entitlement(), st);
} finally {
  rmSync(dir, { recursive: true, force: true });
  PAYWALL.enabled = false;
}
console.log(`license tests passed (${checks} checks)`);
