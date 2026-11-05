// Staff accounts and tablets locked to a company, end to end in Cloudflare's
// local runtime: signing up by emailed code, making a company, adding
// colleagues, activating a tablet with a key pair it can't export, checking in
// by signing a challenge, kiosk calls with the device token, and retiring.
import assert from 'node:assert/strict';
import { createTestHarness } from 'wrangler';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const server = createTestHarness({ root: new URL('..', import.meta.url).pathname, workers: [{ configPath: './wrangler.jsonc', env: 'test' }] });
await server.listen();

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** A tablet: a P-256 key pair whose private half can't be exported, as the kiosk will make. */
async function tablet() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', keys.publicKey);
  return {
    publicKey: { kty, crv, x, y },
    sign: async (text) => b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(text))),
  };
}

try {
  const post = async (path, body) => (await server.fetch(`http://cloud.test${path}`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })).json();
  const env = await server.getWorker().getEnv();
  const outbox = () => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory')).outbox();
  const lastCode = async (to) => {
    const mail = (await outbox()).filter((m) => m.to === to).at(-1);
    return mail && /(\d{6}) is your Visitor Sign-In code/.exec(mail.subject)[1];
  };
  async function signIn(email) {
    ok((await post('/v1/auth/start', { email })).ok, `code sent to ${email}`);
    const res = await post('/v1/auth/verify', { email, code: await lastCode(email.toLowerCase()) });
    ok(res.ok && res.session, JSON.stringify(res));
    return res;
  }

  // ------------------------------------------------------------ signing up by emailed code
  eq((await post('/v1/auth/start', { email: 'not an email' })).error, 'email');
  ok((await post('/v1/auth/start', { email: ' Owner@Acme.example ' })).ok, 'a code is sent');
  const mail = (await outbox()).at(-1);
  ok(mail.to === 'owner@acme.example' && /Your sign-in code is \d{6}/.test(mail.text) && /10 minutes/.test(mail.text), 'the email has the code');
  const code = await lastCode('owner@acme.example');
  eq((await post('/v1/auth/verify', { email: 'owner@acme.example', code: code === '000000' ? '111111' : '000000' })).error, 'code', 'a wrong code is refused');
  const owner = await post('/v1/auth/verify', { email: 'OWNER@acme.example', code });
  ok(owner.ok && owner.session.length >= 40 && owner.user.email === 'owner@acme.example', JSON.stringify(owner));
  eq(owner.companies, [], 'a new account has no companies yet');
  eq((await post('/v1/auth/verify', { email: 'owner@acme.example', code })).error, 'code_expired', 'a code works only once');
  eq((await post('/v1/auth/me', { session: owner.session })).user.email, 'owner@acme.example', 'the session works');
  eq((await post('/v1/auth/me', { session: 'x'.repeat(43) })).error, 'session');

  // Guessing is limited: 5 wrong tries end a code, 5 codes an hour per address.
  ok((await post('/v1/auth/start', { email: 'guess@acme.example' })).ok);
  const real = await lastCode('guess@acme.example');
  const wrong = real === '123456' ? '654321' : '123456';
  for (let i = 0; i < 4; i++) eq((await post('/v1/auth/verify', { email: 'guess@acme.example', code: wrong })).error, 'code');
  eq((await post('/v1/auth/verify', { email: 'guess@acme.example', code: wrong })).error, 'code_expired', 'the fifth wrong guess ends the code');
  eq((await post('/v1/auth/verify', { email: 'guess@acme.example', code: real })).error, 'code_expired', 'even the right code is refused after that');
  for (let i = 0; i < 4; i++) ok((await post('/v1/auth/start', { email: 'guess@acme.example' })).ok);
  eq((await post('/v1/auth/start', { email: 'guess@acme.example' })).error, 'too_many', 'a sixth code in an hour is refused');

  // ------------------------------------------------------------ a company and colleagues
  eq((await post('/v1/companies', { session: 'nope'.repeat(11), name: 'Acme' })).error, 'session');
  eq((await post('/v1/companies', { session: owner.session, name: '  ' })).error, 'name');
  const made = await post('/v1/companies', { session: owner.session, name: 'Acme Robotics', tz: 'America/Chicago' });
  ok(made.ok && /^co-[0-9A-Z]{20}$/.test(made.company.id) && made.company.role === 'owner', JSON.stringify(made));
  const acme = made.company.id;
  eq((await post('/v1/auth/me', { session: owner.session })).companies, [{ id: acme, name: 'Acme Robotics', role: 'owner' }]);

  ok((await post(`/v1/c/${acme}/members`, { session: owner.session, email: 'desk@acme.example', role: 'frontdesk' })).ok, 'a front-desk colleague is added');
  ok((await post(`/v1/c/${acme}/members`, { session: owner.session, email: 'boss@acme.example', role: 'admin' })).ok, 'an admin is added');
  eq((await post(`/v1/c/${acme}/members`, { session: owner.session, email: 'x@acme.example', role: 'king' })).error, 'role');
  const desk = await signIn('desk@acme.example');
  eq(desk.companies, [{ id: acme, name: 'Acme Robotics', role: 'frontdesk' }], 'they see the company when they sign in');
  const boss = await signIn('boss@acme.example');
  eq((await post(`/v1/c/${acme}/members`, { session: desk.session, email: 'y@acme.example', role: 'frontdesk' })).error, 'forbidden', 'the front desk cannot add people');
  eq((await post(`/v1/c/${acme}/members`, { session: boss.session, email: 'y@acme.example', role: 'owner' })).error, 'role', 'only an owner makes owners');
  eq((await post(`/v1/c/${acme}/members`, { session: boss.session, email: 'owner@acme.example', role: 'frontdesk' })).error, 'forbidden', 'an admin cannot demote the owner');
  const stranger = await signIn('someone@globex.example');

  // ------------------------------------------------------------ locking a tablet to the company
  eq((await post(`/v1/c/${acme}`, { key: 'k-0123456789abcdef0123456789', action: 'ping' })).error, 'not_connected', 'a kiosk key does not open an account company');
  eq((await post(`/v1/c/${acme}`, { action: 'claim', key: 'k-0123456789abcdef0123456789' })).error, 'account', 'and an account company cannot be claimed with one');

  const t1 = await tablet();
  eq((await post(`/v1/c/${acme}/devices/activate`, { session: desk.session, publicKey: t1.publicKey })).error, 'forbidden', 'the front desk cannot activate tablets');
  eq((await post(`/v1/c/${acme}/devices/activate`, { session: stranger.session, publicKey: t1.publicKey })).error, 'forbidden', 'nor can someone from another company');
  eq((await post(`/v1/c/${acme}/devices/activate`, { session: owner.session, publicKey: { kty: 'EC', crv: 'P-256', x: 'bad', y: 'bad' } })).error, 'public_key');
  const act = await post(`/v1/c/${acme}/devices/activate`, { session: owner.session, publicKey: t1.publicKey, name: 'Front desk' });
  ok(act.ok && /^dev-/.test(act.device.id) && act.device.name === 'Front desk', JSON.stringify(act));
  const dev1 = act.device.id;
  const again = await post(`/v1/c/${acme}/devices/activate`, { session: boss.session, publicKey: t1.publicKey });
  ok(again.ok && again.already && again.device.id === dev1, 'the same tablet activated again keeps its place');

  async function checkIn(deviceId, t) {
    const ch = await post(`/v1/c/${acme}/devices/challenge`, { deviceId });
    if (!ch.ok) return ch;
    return post(`/v1/c/${acme}/devices/checkin`, { deviceId, nonce: ch.nonce, signature: await t.sign(`vsi-checkin:${deviceId}:${ch.nonce}`) });
  }
  const ch = await post(`/v1/c/${acme}/devices/challenge`, { deviceId: dev1 });
  ok(ch.ok && ch.nonce.length >= 40);
  eq((await post(`/v1/c/${acme}/devices/checkin`, { deviceId: dev1, nonce: ch.nonce, signature: await t1.sign('something else') })).error, 'signature', 'a signature over the wrong text is refused');
  eq((await post(`/v1/c/${acme}/devices/checkin`, { deviceId: dev1, nonce: ch.nonce, signature: await t1.sign(`vsi-checkin:${dev1}:${ch.nonce}`) })).error, 'challenge', 'a challenge works only once');
  const t2 = await tablet();
  eq((await checkIn(dev1, t2)).error, 'signature', "another tablet can't check in as this one");
  const done = await checkIn(dev1, t1);
  ok(done.ok && /^dt\./.test(done.token) && done.name === 'Acme Robotics' && done.timeZone === 'America/Chicago' && done.expires > Date.now(), JSON.stringify(done));

  // ------------------------------------------------------------ the kiosk with its device token
  const kiosk = (action, args = {}, token = done.token) => post(`/v1/c/${acme}`, { key: token, action, args });
  const ping = await kiosk('ping');
  ok(ping.ok && ping.account && ping.timeZone === 'America/Chicago' && ping.version === 5, JSON.stringify(ping));
  eq((await kiosk('getSettings')).settings.org.name, 'Acme Robotics', 'the company name from sign-up is in the settings');
  const pin = await kiosk('adminSetPin', { pin: '246810' });
  ok(pin.ok, 'the tablet sets the admin PIN');
  eq((await kiosk('register', { first: 'Ana', last: 'Lopez', company: 'Globex', visiting: 'Pat', purpose: 'Meeting', agreed: true })).fields, ['photo'], 'a new company asks every visitor for a photo');
  const photo = 'data:image/jpeg;base64,' + Buffer.from('photo').toString('base64');
  const reg = await kiosk('register', { first: 'Ana', last: 'Lopez', company: 'Globex', visiting: 'Pat', purpose: 'Meeting', agreed: true, photo });
  ok(reg.ok, `and signs visitors in: ${JSON.stringify(reg)}`);
  eq((await kiosk('ping', {}, 'dt.' + 'x'.repeat(43))).error, 'device_token', 'a made-up device token is refused');

  const list = await post(`/v1/c/${acme}/devices/list`, { session: boss.session });
  ok(list.ok && list.devices.length === 1 && list.devices[0].status === 'active' && list.devices[0].activatedBy === 'owner@acme.example' && list.devices[0].lastSeen > 0, JSON.stringify(list));
  eq((await post(`/v1/c/${acme}/devices/list`, { session: desk.session })).error, 'forbidden');

  // A second tablet, then retire the first.
  const act2 = await post(`/v1/c/${acme}/devices/activate`, { session: owner.session, publicKey: t2.publicKey, name: 'Warehouse' });
  ok(act2.ok && act2.device.id !== dev1);
  const done2 = await checkIn(act2.device.id, t2);
  ok(done2.ok && done2.token !== done.token, 'each tablet has its own token');
  eq((await kiosk('findVisitor', { first: 'Ana', last: 'Lopez' }, done2.token)).matches.length, 1, 'tablets share the company records');
  ok((await post(`/v1/c/${acme}/devices/retire`, { session: owner.session, deviceId: dev1 })).ok, 'the first tablet is retired');
  eq((await kiosk('ping')).error, 'device_token', "a retired tablet's token stops working at once");
  eq((await checkIn(dev1, t1)).error, 'device', 'and it cannot check in again');
  ok((await kiosk('ping', {}, done2.token)).ok, 'the other tablet keeps working');
  eq((await post(`/v1/c/${acme}/devices/list`, { session: owner.session })).devices.map((d) => d.status), ['retired', 'active']);

  // A company the stranger makes is theirs alone.
  const globex = (await post('/v1/companies', { session: stranger.session, name: 'Globex' })).company.id;
  eq((await post(`/v1/c/${globex}/devices/list`, { session: owner.session })).error, 'forbidden', "Acme's owner can't see Globex's tablets");
  eq((await kiosk('ping', {}, done2.token).then(() => post(`/v1/c/${globex}`, { key: done2.token, action: 'ping' }))).error, 'device_token', "Acme's tablet token doesn't open Globex");

  // Signing out ends the session.
  ok((await post('/v1/auth/signout', { session: owner.session })).ok);
  eq((await post('/v1/auth/me', { session: owner.session })).error, 'session', 'signed out');
} finally {
  await server.close();
}

// ------------------------------------------------------------ production settings (no test environment)
// Without ALLOW_KIOSK_KEY_COMPANIES nobody can make a company with just a kiosk key (it would be
// free storage for anyone), and without a Resend key no email is pretended to be sent.
const prod = createTestHarness({ root: new URL('..', import.meta.url).pathname, workers: [{ configPath: './wrangler.jsonc' }] });
await prod.listen();
try {
  const post = async (path, body) => (await prod.fetch(`http://cloud.test${path}`, { method: 'POST', body: JSON.stringify(body) })).json();
  eq((await post('/v1/c/anything-123', { action: 'claim', key: 'k-0123456789abcdef0123456789' })).error, 'sign_up', 'in production, companies are made by signing up');
  eq((await post('/v1/auth/start', { email: 'owner@acme.example' })).error, 'mail_not_configured', 'and sign-in codes need the email service set up');
} finally {
  await prod.close();
}

console.log(`cloud accounts and tablets tests passed (${checks} checks)`);
