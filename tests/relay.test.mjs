// The relay end to end: the website's Worker (site/worker.js) running locally
// in Cloudflare's runtime, a Raspberry Pi or PC (server/) connected to it the
// way it connects for real, and requests sent to the website the way phones
// and the admin screen send them. Needs Wrangler from cloud/ (cd cloud && npm ci).
//   node tests/relay.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openBox } from '../server/box.mjs';
import { connectRelay } from '../server/relay.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const until = async (cond, what, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await cond()) return;
  throw new Error(`timed out waiting for ${what}`);
};

// The site's files, then the Worker in workerd.
execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(root, 'scripts/build-site.mjs'), '--no-keep'], { stdio: 'ignore' });
const wrangler = createRequire(join(root, 'cloud/package.json')).resolve('wrangler');
const { createTestHarness } = await import(pathToFileURL(wrangler).href);
const server = createTestHarness({ root, workers: [{ configPath: './site/wrangler.jsonc' }] });
const { url } = await server.listen();
const site = url.href;

const dir = mkdtempSync(join(tmpdir(), 'vsi-relay-'));
const relays = [];
try {
  const box = openBox({ dataDir: dir, name: 'Lobby Pi' });
  const api = box.links(site).api;
  const post = async (body, to = api) => {
    const res = await fetch(to, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
    ok(res.headers.get('Access-Control-Allow-Origin') === '*', 'phones and kiosks on other addresses can read the answer');
    return { status: res.status, ...(await res.json()) };
  };

  // Before the box connects, the website says so.
  const offline = await post({ key: box.config.kioskKey, action: 'ping' });
  eq([offline.status, offline.error], [503, 'box_offline'], 'no box connected yet');
  eq((await fetch(`${site}box/not-a-box-id`, { method: 'POST', body: '{}' })).status, 404, 'only box ids');
  eq((await fetch(api, { method: 'OPTIONS' })).status, 204, 'a preflight is answered');

  const logs = [];
  const relay = connectRelay({ siteUrl: site, box, log: (m) => logs.push(m) });
  relays.push(relay);
  await until(() => relay.connected(), 'the box to connect');
  ok(logs.some((m) => /Connected to the website/.test(m)), 'the box says it is connected');

  // The kiosk's requests, through the website.
  const claim = await post({ action: 'claim', key: box.config.kioskKey });
  ok(claim.ok && claim.backend === 'box' && claim.sheetName === 'Lobby Pi', `a kiosk connects with the setup link's key: ${JSON.stringify(claim)}`);
  eq((await post({ key: 'k-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', action: 'ping' })).error, 'kiosk_key', 'the key is still checked, by the box');
  const token = (await post({ key: box.config.kioskKey, action: 'adminSetPin', args: { pin: '135790' }, rid: 'relay-0001' })).token;
  ok(token, 'an admin PIN, set through the website');
  ok((await post({ key: box.config.kioskKey, action: 'adminSaveSettings', args: { token, settings: { setupComplete: true, org: { name: 'Initech' }, badges: false, photos: 'all', form: { rules: [] } } }, rid: 'relay-0002' })).ok, 'settings saved');
  const phoneKey = (await post({ key: box.config.kioskKey, action: 'adminPhoneLink', args: { token }, rid: 'relay-0003' })).key;

  // A visitor's phone, with a large photo: it goes in parts and comes back whole.
  const big = `data:image/jpeg;base64,${Buffer.alloc(700 * 1024, 7).toString('base64')}`;
  const reg = await post({ phone: phoneKey, action: 'phoneRegister', args: { first: 'Joanna', last: 'Smith', company: 'Chotchkies', visiting: 'Bill', purpose: 'Interview', agreed: true, photo: big } });
  ok(reg.ok && reg.token, `a visitor signs in on their phone through the website: ${reg.error || ''}`);
  const shown = await post({ key: box.config.kioskKey, action: 'adminPhoto', args: { token, visitId: reg.visitId } });
  eq(shown.photo?.length, big.length, 'a photo larger than one message comes back whole, in parts');
  ok((await post({ phone: phoneKey, action: 'phoneSignOut', args: { visitId: reg.visitId, token: reg.token } })).ok, 'and signs out on it');
  eq((await post({ phone: 'phAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', action: 'phoneStart' })).error, 'phone_link', 'an old QR code stops working');

  // Another computer can't take over this box's address.
  const impostor = { ...box, config: { ...box.config, boxSecret: 'x'.repeat(43) } };
  const ilogs = [];
  const stranger = connectRelay({ siteUrl: site, box: impostor, log: (m) => ilogs.push(m) });
  relays.push(stranger);
  await until(() => ilogs.some((m) => /refused/.test(m)), 'the impostor to be refused');
  ok(!stranger.connected(), "a computer without the box's secret is refused");
  stranger.close();
  ok((await post({ key: box.config.kioskKey, action: 'ping' })).ok, 'and the real box keeps working');

  // When the box goes away, the website says so instead of waiting.
  relay.close();
  await until(async () => (await post({ key: box.config.kioskKey, action: 'ping' })).error === 'box_offline', 'the website to notice the box left');
  ok(true, 'a box that disconnects shows as offline');
  const back = connectRelay({ siteUrl: site, box, log: () => {} });
  relays.push(back);
  await until(() => back.connected(), 'the box to reconnect');
  ok((await post({ key: box.config.kioskKey, action: 'ping' })).ok, 'and works again when it reconnects');
} finally {
  for (const r of relays) r.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`relay tests passed (${checks} checks)`);
