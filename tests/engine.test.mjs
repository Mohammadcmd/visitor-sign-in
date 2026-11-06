// The shared record engine (web/js/engine.js) on its own, outside a browser,
// the way the cloud service runs it. The kiosk end-to-end test covers it in the
// browser; this checks the parts the cloud relies on.
import assert from 'node:assert/strict';
import { createEngine, emptyStore, makeClock, READS } from '../web/js/engine.js';
import { normalize, hashPin } from '../web/js/settings.js';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

// Calendars: the device's own, or a company's time zone.
const late = new Date('2026-11-05T03:30:00Z'); // still Nov 4 in Chicago
eq(makeClock('America/Chicago').dayKey(late), '2026-11-04', 'a company calendar uses its time zone');
eq(makeClock('Asia/Tokyo').dayKey(late), '2026-11-05');
eq(makeClock('UTC').dayKey('not a date'), '');
ok(/2026/.test(makeClock('America/Chicago').stamp(late)), 'readable time stamp');

// One company's engine, with settings and files kept in memory.
let current = normalize({ setupComplete: true, org: { name: 'Initech' }, badges: true, photos: 'off', form: { rules: [] }, admin: { name: 'Bill' } });
const files = new Map();
const engine = createEngine({
  version: 5,
  settings: () => current,
  saveSettings: (next) => { current = normalize(next); },
  files: { put: async (k, v) => { files.set(k, v); }, get: async (k) => files.get(k) || '', del: async (k) => { files.delete(k); } },
  clock: makeClock('America/Chicago'),
});
const s = emptyStore();
const act = (action, args = {}) => engine.act(s, action, args);

eq((await act('ping')).version, 5);
ok(READS.has('ping') && !READS.has('register'), 'reads and writes are told apart');
eq((await act('register', { first: 'Peter', last: 'Gibbons' })).fields, ['visiting', 'purpose'], 'required answers are checked');
const reg = await act('register', { first: 'Peter', last: 'Gibbons', company: 'Initech', visiting: 'Bill', purpose: 'TPS reports', agreed: true });
ok(reg.ok && reg.visitor.id, JSON.stringify(reg));
eq((await act('findVisitor', { first: 'peter', last: 'GIBBONS' })).matches.length, 1, 'found by name');

// Badges need an admin: first a PIN, then a token.
const pin = await act('adminSetPin', { pin: '246810' });
ok(pin.ok && pin.token, 'PIN set');
ok(current.admin.pinHash === await hashPin('246810'), 'the PIN is kept as a hash in the settings');
eq((await act('adminAddBadge', { tag: '04A1B2' })).error, 'admin', 'admin actions need a token');
const login = await act('adminLogin', { pin: '246810' });
ok(login.ok, 'admin login');
eq((await act('adminAddBadge', { token: login.token, tag: '04A1B2' })).badge, 'V1');

const visit = await act('assignBadge', { visitorId: reg.visitor.id, tag: '04 a1 b2' });
ok(visit.ok && visit.badge === 'V1', JSON.stringify(visit));
eq(s.badges[0].status, 'in use');
const tap = await act('tapAtWelcome', { tag: '04A1B2' });
ok(tap.result === 'signed_out' && tap.first === 'Peter', 'a badge tap signs out');
eq(s.badges[0].status, 'available');

// A signature goes to the file store under the visit.
const sig = 'data:image/png;base64,' + Buffer.from('signature').toString('base64');
const again = await act('checkIn', { visitorId: reg.visitor.id, signature: sig, agreement: { rules: ['Stay with your host.'] } });
ok(files.get(`signature:${again.visitId}`) === sig, 'the signature is saved before the answer comes back');
const shown = await act('adminSignature', { token: login.token, visitId: again.visitId });
ok(shown.ok && shown.signature === sig && shown.agreement.rules[0] === 'Stay with your host.', 'and can be shown');

// Numbered passes (no reader): the lowest free pass, and the same one when signing in again.
await act('adminAddBadge', { token: login.token });
eq(s.badges.map((b) => b.badge), ['V1', 'V2'], 'a pass is a badge without a tag');
const pass = await act('assignPass', { visitorId: reg.visitor.id });
ok(pass.ok && pass.badge === 'V1' && !pass.noPass, `the lowest free pass: ${JSON.stringify(pass)}`);
const passAgain = await act('assignPass', { visitorId: reg.visitor.id });
ok(passAgain.badge === 'V1' && passAgain.visitId !== pass.visitId, 'signing in again keeps it');
const samir = await act('register', { first: 'Samir', last: 'Nagheenanajar', company: 'Initech', visiting: 'Bill', purpose: 'TPS reports', agreed: true });
eq((await act('assignPass', { visitorId: samir.visitor.id })).badge, 'V2');
const third = await act('register', { first: 'Michael', last: 'Bolton', company: 'Initech', visiting: 'Bill', purpose: 'TPS reports', agreed: true });
ok((await act('assignPass', { visitorId: third.visitor.id })).noPass, 'with every pass out, still signed in, without one');

// Two companies never share admin sessions.
const other = createEngine({ version: 5, settings: () => current, saveSettings: () => {}, files: { put: async () => {}, get: async () => '', del: async () => {} } });
eq((await other.act(emptyStore(), 'adminInside', { token: login.token })).error, 'admin', 'a token only works for its own company');

console.log(`engine tests passed (${checks} checks)`);
