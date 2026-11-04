/* Unit tests for the Google Sheets connector (apps-script.js), run against an in-memory Apps Script mock.
 * Run with: node tests/connector.test.js */
'use strict';
const assert = require('assert');
const path = require('path');
const { createRuntime } = require('./gas-mock');

global.window = {};
require(path.join(__dirname, '..', 'apps-script.js'));
const SOURCE = window.VSI_CONNECTOR_SOURCE;
const KEY = 'abcde-fghjk-mnpqr-stuvw';
const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack}`); process.exitCode = 1; }
}
const fresh = () => createRuntime(SOURCE, { key: KEY });
const visit = (over = {}) => ({ id: 'v1', name: 'Alex Morgan', company: 'Globex', method: 'screen', kiosk: 'Front desk', inAt: Date.now(), ...over });

console.log('Connector');

test('refuses to run before the kiosk key is filled in', () => {
  const rt = createRuntime(SOURCE, { key: null });
  const res = rt.post({ key: '%%KIOSK_KEY%%', action: 'ping' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'not_configured');
});

test('rejects a wrong key', () => {
  const res = fresh().post({ key: 'nope', action: 'ping' });
  assert.strictEqual(res.code, 'bad_key');
});

test('rejects invalid JSON', () => {
  assert.strictEqual(fresh().post('{not json').code, 'bad_json');
});

test('GET without an action explains what the URL is for', () => {
  assert.match(fresh().get({}), /connector v1 is running/);
});

test('ping creates the People and Visits tabs (reusing the empty first tab)', () => {
  const rt = fresh();
  const res = rt.post({ key: KEY, action: 'ping' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.sheetName, 'Visitor log');
  assert.deepStrictEqual(rt.ss.sheets.map(s => s.getName()), ['People', 'Visits']);
  assert.deepStrictEqual(rt.tab('People').data[0], ['Name', 'Card ID', 'Company', 'Role', 'Email', 'Admin']);
  assert.strictEqual(rt.tab('Visits').data[0][0], 'Visit ID');
});

test('sign-in ops are written once, as text, and applied', () => {
  const rt = fresh();
  const v = visit({ phone: '0412 345 678', cardId: '0004123456', notes: '=HYPERLINK("http://evil")' });
  const res = rt.post({ key: KEY, action: 'sync', ops: [{ opId: 'o1', type: 'signin', visit: v }, { opId: 'o2', type: 'signin', visit: v }] });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.applied, ['o1', 'o2']);
  const rows = rt.tab('Visits').rows();
  assert.strictEqual(rows.length, 1, 'duplicate sign-in must not add a second row');
  assert.strictEqual(rows[0].Name, 'Alex Morgan');
  assert.strictEqual(rows[0].Phone, '0412 345 678');
  assert.strictEqual(rows[0]['Card ID'], '0004123456');
  assert.strictEqual(rows[0].Status, 'Allowed');
  const raw = rt.tab('Visits').writes.at(-1)[0];
  assert.ok(raw.includes('\'=HYPERLINK("http://evil")'), 'visitor input is stored as text, never as a formula');
  // Returned to kiosks as an open visit.
  assert.strictEqual(res.visits.length, 1);
  assert.strictEqual(res.visits[0].id, 'v1');
  assert.strictEqual(res.visits[0].outAt, null);
  // A second sync must not duplicate the row either.
  rt.post({ key: KEY, action: 'sync', ops: [{ opId: 'o3', type: 'signin', visit: v }] });
  assert.strictEqual(rt.tab('Visits').rows().length, 1);
});

test('sign-out sets the time once; a later sign-out does not overwrite it', () => {
  const rt = fresh();
  rt.post({ key: KEY, action: 'sync', ops: [{ opId: 'o1', type: 'signin', visit: visit() }] });
  const t1 = Date.now() + 1000;
  rt.post({ key: KEY, action: 'sync', ops: [{ opId: 'o2', type: 'signout', id: 'v1', outAt: t1 }] });
  rt.post({ key: KEY, action: 'sync', ops: [{ opId: 'o3', type: 'signout', id: 'v1', outAt: t1 + 99999, auto: true }] });
  const row = rt.tab('Visits').rows()[0];
  assert.strictEqual(new Date(row['Signed out']).getTime(), t1);
  const res = rt.post({ key: KEY, action: 'sync', ops: [] });
  assert.strictEqual(res.visits[0].outAt, t1);
});

test('sign-in and sign-out in the same batch end up in one finished row', () => {
  const rt = fresh();
  const out = Date.now() + 5000;
  rt.post({ key: KEY, action: 'sync', ops: [{ opId: 'a', type: 'signin', visit: visit() }, { opId: 'b', type: 'signout', id: 'v1', outAt: out, auto: true }] });
  const row = rt.tab('Visits').rows()[0];
  assert.strictEqual(new Date(row['Signed out']).getTime(), out);
  assert.strictEqual(row['Auto signed out'], 'Yes');
});

test('declined visitors are recorded with flags and photo, staff are emailed, hosts are not', () => {
  const rt = fresh();
  rt.post({ key: KEY, action: 'ping' });
  rt.tab('People').getRange(2, 1, 1, 6).setValues([['Maria Lopez', '', 'Initech', 'Engineer', 'maria@initech.test', '']]);
  const v = visit({
    id: 'd1', name: 'Eve Adams', host: 'Maria Lopez', status: 'declined', photo: PHOTO,
    answers: [{ q: 'Are you a U.S. person?', a: 'No' }], reasons: [{ q: 'Are you a U.S. person?', a: 'No', action: 'decline' }],
  });
  const res = rt.post({ key: KEY, action: 'sync', ops: [{ opId: 'o1', type: 'signin', visit: v }], alertEmails: 'security@initech.test, bad-address', notifyHosts: true });
  assert.strictEqual(res.emailed, 1);
  assert.strictEqual(rt.mail.length, 1);
  assert.strictEqual(rt.mail[0].to, 'security@initech.test');
  assert.match(rt.mail[0].subject, /Visitor declined: Eve Adams/);
  assert.match(rt.mail[0].body, /U\.S\. person/);
  assert.strictEqual(rt.mail[0].attachments[0].type, 'image/jpeg');
  const row = rt.tab('Visits').rows()[0];
  assert.strictEqual(row.Status, 'Declined');
  assert.match(row.Flags, /^Declined: Are you a U\.S\. person\? → No$/);
  assert.strictEqual(row.Answers, 'Are you a U.S. person? → No');
  assert.strictEqual(row.Photo, PHOTO);
  const back = res.visits[0];
  assert.strictEqual(back.status, 'declined');
  assert.strictEqual(back.hasPhoto, true);
  assert.ok(!('photo' in back), 'photos are not sent back to kiosks');
});

test('allowed visitors trigger a host email when the host has an Email on the People tab', () => {
  const rt = fresh();
  rt.post({ key: KEY, action: 'ping' });
  rt.tab('People').getRange(2, 1, 1, 6).setValues([['Maria Lopez', '', 'Initech', 'Engineer', 'maria@initech.test', '']]);
  rt.post({ key: KEY, action: 'sync', notifyHosts: true, ops: [{ opId: 'o1', type: 'signin', visit: visit({ host: 'maria lopez', purpose: 'Meeting' }) }] });
  assert.strictEqual(rt.mail.length, 1);
  assert.strictEqual(rt.mail[0].to, 'maria@initech.test');
  assert.match(rt.mail[0].subject, /Your visitor has arrived: Alex Morgan/);
  // Old visits uploaded in bulk (e.g. when switching to the cloud) never send email.
  rt.post({ key: KEY, action: 'sync', notifyHosts: true, ops: [{ opId: 'o2', type: 'signin', visit: visit({ id: 'old', host: 'Maria Lopez', inAt: Date.now() - 2 * 86400000 }) }] });
  assert.strictEqual(rt.mail.length, 1);
});

test('emails are not included in the people list sent to kiosks', () => {
  const rt = fresh();
  rt.post({ key: KEY, action: 'ping' });
  rt.tab('People').getRange(2, 1, 1, 6).setValues([['Sam Rivera', 99887766, 'Acme', 'Staff', 'sam@acme.test', 'Yes']]);
  const res = rt.post({ key: KEY, action: 'ping' });
  assert.deepStrictEqual(res.people, [{ name: 'Sam Rivera', cardId: '99887766', company: 'Acme', role: 'Staff', isAdmin: true, hasEmail: true }]);
});

test('override ops mark a declined visit as overridden with who and why', () => {
  const rt = fresh();
  rt.post({ key: KEY, action: 'sync', ops: [{ opId: 'o1', type: 'signin', visit: visit({ status: 'declined' }) }] });
  const res = rt.post({ key: KEY, action: 'sync', ops: [{ opId: 'o2', type: 'override', id: 'v1', by: 'Jordan Lee', at: Date.now(), reason: 'Escorted' }] });
  const row = rt.tab('Visits').rows()[0];
  assert.strictEqual(row.Status, 'Overridden');
  assert.match(row.Override, /^By Jordan Lee at .+: Escorted$/);
  assert.strictEqual(res.visits[0].status, 'overridden');
});

test('visits from other kiosks come back; old finished visits do not', () => {
  const rt = fresh();
  const old = Date.now() - 40 * 86400000;
  rt.post({ key: KEY, action: 'sync', ops: [
    { opId: 'a', type: 'signin', visit: visit({ id: 'old-done', inAt: old, outAt: old + 3600000 }) },
    { opId: 'b', type: 'signin', visit: visit({ id: 'old-open', inAt: old }) },
    { opId: 'c', type: 'signin', visit: visit({ id: 'recent', kiosk: 'Side door' }) },
  ] });
  const ids = rt.post({ key: KEY, action: 'sync', ops: [], days: 30 }).visits.map(v => v.id).sort();
  assert.deepStrictEqual(ids, ['old-open', 'recent']);
});

test('addPerson appends to the People tab and refuses duplicate cards', () => {
  const rt = fresh();
  rt.post({ key: KEY, action: 'ping' });
  const ok = rt.post({ key: KEY, action: 'addPerson', person: { name: 'Chris Doe', cardId: '0007770001', company: 'Acme', role: 'Contractor' } });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.people[0].name, 'Chris Doe');
  assert.strictEqual(rt.tab('People').rows()[0]['Card ID'], '0007770001');
  const dup = rt.post({ key: KEY, action: 'addPerson', person: { name: 'Someone Else', cardId: '7770001' } });
  assert.strictEqual(dup.code, 'exists');
});

test('unknown ops are acknowledged so they never block the queue', () => {
  const res = fresh().post({ key: KEY, action: 'sync', ops: [{ opId: 'x', type: 'mystery' }] });
  assert.deepStrictEqual(res.applied, ['x']);
});

console.log(`\n${passed} connector tests passed${process.exitCode ? ', some FAILED' : ''}.`);
