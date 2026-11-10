// Screenless sign-in on a Raspberry Pi or PC (server/): the records box on its
// own, without the website: keys, the phone key's limits, retried writes,
// records surviving a restart, photos as files, and the daily jobs.
//   node tests/server.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBox, BACKEND_VERSION, PHONE_RATE } from '../server/box.mjs';
import { chunks } from '../server/relay.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

eq(BACKEND_VERSION, Number(/BACKEND_VERSION = (\d+)/.exec(readFileSync(join(root, 'web/js/api.js'), 'utf8'))[1]), 'the box speaks the version the kiosk expects');

const dir = mkdtempSync(join(tmpdir(), 'vsi-box-'));
try {
  let box = openBox({ dataDir: dir, name: 'Front desk Pi' });
  const { config } = box;
  ok(/^[a-z0-9]{20}$/.test(config.boxId) && config.boxSecret.length >= 40 && /^k-[A-Z0-9]{30}$/.test(config.kioskKey), 'a box id, secret and kiosk key are made the first time');
  const links = box.links('https://site.example/');
  eq(links.api, `https://site.example/box/${config.boxId}`, 'its address on the website');
  ok(links.setup.startsWith('https://site.example/web/?api=') && links.setup.includes(encodeURIComponent(config.kioskKey)), 'and a setup link with the kiosk key');
  let n = 0;
  const call = (action, args = {}, extra = {}) => box.handle({ key: config.kioskKey, action, args, rid: `r-${++n}-test`, ...extra });

  // Connecting: only with the kiosk key the box made.
  eq((await box.handle({ action: 'claim', key: 'short' })).error, 'bad_key');
  eq((await box.handle({ action: 'claim', key: 'k-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).error, 'claimed', 'another key is told to ask for this one');
  const claim = await box.handle({ action: 'claim', key: config.kioskKey });
  ok(claim.ok && claim.backend === 'box' && claim.sheetName === 'Front desk Pi' && claim.version === BACKEND_VERSION && !claim.setupComplete, JSON.stringify(claim));
  eq((await box.handle({ key: 'nope', action: 'ping' })).error, 'kiosk_key');
  eq((await box.handle('not an object')).error, 'bad_request');

  // Setting it up from the admin screen.
  const pin = await call('adminSetPin', { pin: '246810' });
  ok(pin.ok && pin.token, 'an admin PIN');
  const token = pin.token;
  ok((await call('adminSaveSettings', { token, settings: { setupComplete: true, org: { name: 'Initech' }, badges: false, passes: true, photos: 'all', form: { rules: [] }, endOfDay: '18:00', retentionDays: 30 } })).ok, 'settings saved');
  await call('adminAddBadge', { token });
  ok(existsSync(join(dir, 'settings.json')) && JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).org.name === 'Initech', 'settings are kept in settings.json');

  // Phones: nothing until phone sign-in is switched on, then only the visitor actions.
  eq((await box.handle({ phone: 'phAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', action: 'phoneStart' })).error, 'phone_link', 'no phone key yet');
  const phoneKey = (await call('adminPhoneLink', { token })).key;
  const phone = (action, args = {}) => box.handle({ phone: phoneKey, action, args });
  ok((await phone('phoneStart')).settings.org.name === 'Initech', 'a phone gets the visitor screens');
  eq((await phone('adminInside', { token })).error, 'not_allowed', 'and nothing else, even with an admin token');
  eq((await phone('findVisitor', { first: 'a', last: 'b' })).error, 'not_allowed', 'no looking people up');
  const photo = `data:image/jpeg;base64,${Buffer.from('a photo').toString('base64')}`;
  const reg = await phone('phoneRegister', { first: 'Joanna', last: 'Smith', company: 'Chotchkies', visiting: 'Bill', purpose: 'Interview', agreed: true, photo });
  ok(reg.ok && reg.badge === 'V1' && reg.token, `signed in on a phone with pass V1: ${reg.error || ''}`);
  const files = readdirSync(join(dir, 'files'));
  ok(files.includes(`visitor-${reg.visitor.id}.jpg`), `the photo is a .jpg file: ${files}`);
  eq(readFileSync(join(dir, 'files', `visitor-${reg.visitor.id}.jpg`), 'utf8'), 'a photo');

  // A retried write gets the first answer instead of signing in twice.
  const a1 = await call('checkIn', { visitorId: reg.visitor.id }, { rid: 'retry-0001' });
  const a2 = await call('checkIn', { visitorId: reg.visitor.id }, { rid: 'retry-0001' });
  eq(a1.visitId, a2.visitId, 'the same answer for a retry');
  eq((await call('adminInside', { token })).inside.length, 1, 'and only one visit open');

  // Records survive a restart.
  box = openBox({ dataDir: dir });
  eq(box.config.boxId, config.boxId, 'the same box after a restart');
  eq(box.config.name, 'Front desk Pi', 'with its name');
  const relog = await box.handle({ key: config.kioskKey, action: 'adminLogin', args: { pin: '246810' } });
  ok(relog.ok, 'the PIN still works');
  const inside = await box.handle({ key: config.kioskKey, action: 'adminInside', args: { token: relog.token } });
  eq(inside.inside.map((v) => v.first), ['Joanna'], 'and the visit is still there');
  ok((await box.handle({ phone: phoneKey, action: 'phoneStart' })).ok, 'and so is the phone key');
  ok(readdirSync(join(dir, 'backups')).some((f) => /^records-\d{4}-\d{2}-\d{2}\.json$/.test(f)), 'a daily backup copy is made');

  // Anyone could photograph the poster: phones get a limited number of sign-ins.
  let refused = 0;
  for (let i = 0; i < PHONE_RATE.max + 3; i++) {
    const r = await box.handle({ phone: phoneKey, action: 'phoneDecline', args: { first: `Test${i}`, last: 'Person', reasons: [] } });
    if (r.error === 'too_many') refused++;
  }
  ok(refused >= 3, `after ${PHONE_RATE.max} in ${PHONE_RATE.seconds / 60} minutes, phones are told to wait (${refused} refused)`);
  ok((await box.handle({ phone: phoneKey, action: 'phoneStart' })).ok, 'opening the page still works');
  ok((await box.handle({ key: config.kioskKey, action: 'ping' })).ok, 'and so does the admin screen');

  // The daily jobs a kiosk would do: the end of day and old records.
  const late = new Date();
  late.setHours(19, 0, 0, 0);
  if (late < new Date()) late.setDate(late.getDate() + 1); // the next 7 p.m. from now, after the 6 p.m. end of day
  const done = await box.chores(late);
  eq(done.endOfDay, 1, 'at the end of the day, everyone still inside is signed out');
  eq((await box.chores(late)).endOfDay, 0, 'once');
  ok(done.purged, 'old records are checked once a day');
  eq((await box.handle({ key: config.kioskKey, action: 'adminInside', args: { token: relog.token } })).inside.length, 0, 'nobody inside');

  // The connection to the website carries long answers in parts.
  const long = 'x'.repeat(600 * 1024);
  const parts = chunks('id1', 'res', long).map((p) => JSON.parse(p));
  ok(parts.length === 3 && parts.every((p) => p.parts === 3 && p.id === 'id1'), 'a long answer goes in parts');
  eq(parts.map((p) => p.data).join(''), long, 'and joins back up');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`server tests passed (${checks} checks)`);
