// The cloud service end to end: the real Worker and Durable Objects, running
// locally in Cloudflare's runtime (workerd), called the way a kiosk calls them.
import assert from 'node:assert/strict';
import { createTestHarness } from 'wrangler';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const server = createTestHarness({ root: new URL('..', import.meta.url).pathname, workers: [{ configPath: './wrangler.jsonc', env: 'test' }] });
await server.listen();

try {
  const KEY = 'k-0123456789abcdef0123456789';
  const OTHER_KEY = 'k-fedcba9876543210fedcba9876';
  let n = 0;
  async function post(company, body, raw) {
    const res = await server.fetch(`http://cloud.test/v1/c/${company}`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: raw ?? JSON.stringify(body),
    });
    ok(res.headers.get('Access-Control-Allow-Origin') === '*', 'kiosks on another address can read the answer');
    return res.json();
  }
  const call = (company, action, args = {}, extra = {}) => post(company, { key: KEY, action, args, rid: `r-${++n}-test`, ...extra });

  // Health check and odd requests.
  const health = await (await server.fetch('http://cloud.test/')).json();
  ok(health.ok && health.version === 5, JSON.stringify(health));
  eq((await server.fetch('http://cloud.test/nope')).status, 404);
  eq((await server.fetch('http://cloud.test/v1/c/acme-0001', { method: 'OPTIONS' })).status, 204, 'a preflight is answered');
  eq((await post('acme-0001', null, 'not json')).error, 'bad_request');

  // The first kiosk claims the company with its key; others need the same key.
  eq((await call('acme-0001', 'ping')).error, 'not_connected', 'nothing works before a kiosk connects');
  eq((await post('acme-0001', { action: 'claim', key: 'short' })).error, 'bad_key');
  const claim = await post('acme-0001', { action: 'claim', key: KEY, tz: 'America/Chicago' });
  ok(claim.ok && claim.claimed && claim.version === 5 && claim.timeZone === 'America/Chicago' && !claim.setupComplete, JSON.stringify(claim));
  ok((await post('acme-0001', { action: 'claim', key: KEY })).claimed === false, 'the same key connects again');
  eq((await post('acme-0001', { action: 'claim', key: OTHER_KEY })).error, 'claimed', 'another key is refused');
  eq((await post('acme-0001', { key: OTHER_KEY, action: 'ping' })).error, 'kiosk_key');

  // Setup: a PIN and the settings, as the wizard saves them.
  const pin = await call('acme-0001', 'adminSetPin', { pin: '246810' });
  ok(pin.ok && pin.token, JSON.stringify(pin));
  const token = pin.token;
  eq((await call('acme-0001', 'adminSetPin', { pin: '111111' })).error, 'admin', 'changing the PIN needs the admin');
  const saved = await call('acme-0001', 'adminSaveSettings', {
    token, settings: { setupComplete: true, org: { name: 'Acme Robotics' }, badges: true, photos: 'all', form: { rules: [] }, admin: { name: 'Pat' } },
  });
  ok(saved.ok, JSON.stringify(saved));
  const got = await call('acme-0001', 'getSettings');
  ok(got.settings.org.name === 'Acme Robotics' && got.settings.setupComplete, 'settings are shared with every kiosk');
  eq(got.settings.admin.pinHash, '', "the PIN's hash never leaves the cloud");
  ok((await call('acme-0001', 'ping')).hasPin, 'but kiosks know there is a PIN');
  eq((await call('acme-0001', 'adminLogin', { pin: '000000' })).error, 'pin');

  // A visitor with a photo signs in with a badge and taps out.
  const photo = 'data:image/jpeg;base64,' + Buffer.from('a small photo').toString('base64');
  const reg = await call('acme-0001', 'register', { first: 'Ana', last: 'Lopez', company: 'Globex', visiting: 'Pat', purpose: 'Meeting', agreed: true, photo });
  ok(reg.ok && reg.visitor.id, JSON.stringify(reg));
  ok((await call('acme-0001', 'adminAddBadge', { token, tag: '04A1B2C3' })).badge === 'V1', 'badge added');
  const badge = await call('acme-0001', 'assignBadge', { visitorId: reg.visitor.id, tag: '04A1B2C3' });
  ok(badge.ok && badge.badge === 'V1', JSON.stringify(badge));
  const inside = await call('acme-0001', 'adminInside', { token });
  eq(inside.inside.map((v) => v.first), ['Ana']);
  eq((await call('acme-0001', 'adminPhoto', { token, visitId: badge.visitId })).photo, photo, 'the photo comes back from storage');

  // A retried request (same request id) is answered without writing twice.
  const retry = { key: KEY, action: 'register', args: { first: 'Sam', last: 'Lee', company: 'N/A', visiting: 'Pat', purpose: 'Meeting', agreed: true, photo }, rid: 'retry-abc123' };
  const first = await post('acme-0001', retry);
  const second = await post('acme-0001', retry);
  eq(second.visitor.id, first.visitor.id, 'the retry gets the first answer');
  eq((await call('acme-0001', 'findVisitor', { first: 'Sam', last: 'Lee' })).matches.length, 1, 'and only one visitor exists');

  // Requests from two tablets at once are handled one at a time.
  const both = await Promise.all([
    call('acme-0001', 'checkIn', { visitorId: first.visitor.id }),
    call('acme-0001', 'checkIn', { visitorId: first.visitor.id }),
  ]);
  ok(both.every((r) => r.ok), JSON.stringify(both));
  eq((await call('acme-0001', 'adminInside', { token })).inside.filter((v) => v.first === 'Sam').length, 1, 'the second sign-in replaces the first');

  // The records are kept: a fresh read from storage finds the same visitors and visits.
  const env = await server.getWorker().getEnv();
  await env.COMPANY.get(env.COMPANY.idFromName('acme-0001')).reload();
  eq((await call('acme-0001', 'findVisitor', { first: 'Ana', last: 'Lopez' })).matches.length, 1, 'visitors survive a restart');
  const history = await call('acme-0001', 'adminHistory', { token, days: 1 });
  eq(history.visits.map((v) => v.first), ['Sam', 'Sam', 'Ana'], 'and so does the history, newest first');
  const tap = await call('acme-0001', 'tapAtWelcome', { tag: '04A1B2C3' });
  ok(tap.result === 'signed_out' && tap.first === 'Ana', 'the badge tap signs Ana out');

  // The company's calendar: expected visitors are on Chicago's "today".
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  ok((await call('acme-0001', 'adminAddExpected', { token, first: 'Bill', last: 'Lumbergh', day: today })).ok);
  const expected = await call('acme-0001', 'adminExpected', { token });
  ok(expected.today === today && expected.expected.length === 1, JSON.stringify(expected));

  // Another company sees none of it.
  ok((await post('globex-0002', { action: 'claim', key: OTHER_KEY })).claimed, 'a second company connects with its own key');
  eq((await post('globex-0002', { key: OTHER_KEY, action: 'findVisitor', args: { first: 'Ana', last: 'Lopez' } })).matches, [], "companies never see each other's visitors");
  eq((await post('globex-0002', { key: KEY, action: 'ping' })).error, 'kiosk_key', "and one company's key doesn't open another");
  const otherPin = await post('globex-0002', { key: OTHER_KEY, action: 'adminSetPin', args: { pin: '135790' } });
  eq((await post('globex-0002', { key: OTHER_KEY, action: 'adminInside', args: { token } })).error, 'admin', "one company's admin session doesn't work in another");
  ok(otherPin.ok);

  // Unknown actions and oversized settings are refused.
  eq((await call('acme-0001', 'dropEverything')).error, 'admin', 'an unknown action needs the admin first');
  eq((await call('acme-0001', 'dropEverything', { token })).error, 'unknown_action');
  eq((await call('acme-0001', 'adminSaveSettings', { token, settings: { org: { name: 'x'.repeat(1600000) } } })).error, 'too_big');
} finally {
  await server.close();
}

console.log(`cloud service tests passed (${checks} checks)`);
