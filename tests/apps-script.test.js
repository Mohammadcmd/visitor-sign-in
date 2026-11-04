// Runs apps-script/Code.gs against in-memory stand-ins for SpreadsheetApp,
// DriveApp, CacheService, LockService, MailApp and friends (tests/fake-google.js).
// Usage: node tests/apps-script.test.js
const assert = require('assert');
const { loadBackend } = require('./fake-google');

const KEY = 'kiosk-key-0123456789-abcdefghij';
const photo = 'data:image/jpeg;base64,' + Buffer.from('fake jpeg').toString('base64');
const logo = 'data:image/png;base64,' + Buffer.from('fake png').toString('base64');
const descriptor = Array.from({ length: 128 }, (_, i) => Math.sin(i));
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

// ------------------------------------------------------------------ connecting
{
  const b = loadBackend();
  eq(b.handle({ key: KEY, action: 'ping' }).error, 'not_connected', 'nothing works before a kiosk connects');
  eq(b.handle({ action: 'claim', key: 'short' }).error, 'bad_key');
  const claim = b.handle({ action: 'claim', key: KEY });
  ok(claim.ok && claim.claimed, 'first kiosk claims the sheet');
  eq(claim.version, 3);
  eq(claim.setupComplete, false);
  eq(claim.hasPin, false);
  eq(b.order, ['Visitors', 'Visits', 'Badges', 'Face data', 'Settings']);
  ok(b.sheets['Face data'].hidden && b.sheets.Settings.hidden, 'helper tabs are hidden');
  const head = b.sheets.Visitors.rows[0];
  eq([head[0], head[1], head[head.length - 1]], ['First Name', 'Last Name', 'Photo folder']);
  eq(b.handle({ action: 'claim', key: KEY }).claimed, false, 'the same kiosk can reconnect');
  eq(b.handle({ action: 'claim', key: 'another-kiosk-key-000000000' }).error, 'claimed', 'a different key is refused');
  eq(b.handle({ key: 'nope', action: 'ping' }).error, 'kiosk_key');
  eq(b.props.KIOSK_KEY, KEY);
}

const b = loadBackend();
b.handle({ action: 'claim', key: KEY });
const api = (action, args) => b.handle({ key: KEY, action, args });

// ------------------------------------------------------------------ admin PIN
eq(api('adminLogin', { pin: '123456' }).error, 'no_pin');
eq(api('adminSetPin', { pin: '12' }).error, 'pin_format');
const first = api('adminSetPin', { pin: '246810' });
ok(first.ok && first.token, 'the first PIN can be set with the kiosk key');
ok(!b.props.ADMIN_PIN && /^[0-9a-f]{64}$/.test(b.props.ADMIN_PIN_HASH), 'only a hash of the PIN is stored');
eq(api('adminSetPin', { pin: '135790' }).error, 'admin', 'changing it needs an admin token');
eq(api('adminLogin', { pin: '000000' }).error, 'pin');
let token = api('adminLogin', { pin: '246810' }).token;
ok(token);
ok(api('adminSetPin', { pin: '135790', token }).ok);
token = api('adminLogin', { pin: '135790' }).token;
ok(token, 'the new PIN works');
eq(api('ping').hasPin, true);
{
  const legacy = loadBackend({ KIOSK_KEY: KEY, ADMIN_PIN: '246810' });
  ok(legacy.handle({ key: KEY, action: 'adminLogin', args: { pin: '246810' } }).ok, 'a hand-set ADMIN_PIN still works');
}

// ------------------------------------------------------------------ settings
eq(api('getSettings').settings, null);
eq(api('adminSaveSettings', { settings: { org: { name: 'Acme' } } }).error, 'admin');
const settings = {
  setupComplete: true,
  org: { name: 'Acme Aerospace', tagline: 'Precision parts', accent: '#0a5ea8', logo: 'data:image/png;base64,AAAA' },
  admin: { name: 'Jordan Lee', pinHash: 'should-not-be-stored' },
  form: { askHost: true, askPurpose: true, rules: ['Stay with your host.'] },
  photos: 'all',
  screening: { alertEmails: 'security@acme.test, front@acme.test', questions: [] },
};
ok(api('adminSaveSettings', { token, settings, logo }).ok);
let got = api('getSettings');
eq(got.settings.org.name, 'Acme Aerospace');
eq(got.settings.admin.pinHash, undefined, 'PIN hashes never go into the sheet');
eq(got.settings.org.logo, undefined, 'the logo is stored in Drive, not in the cell');
eq(got.logo, logo, 'the logo comes back as a data URL');
eq(api('ping').setupComplete, true);
ok(api('adminSaveSettings', { token, settings, logo: '' }).ok);
eq(api('getSettings').logo, '', 'the logo can be removed');
ok(api('adminSaveSettings', { token, settings, logo }).ok);

// ------------------------------------------------------------------ badges
eq(api('adminAddBadge', { token: 'bad' }).error, 'admin');
eq(api('adminAddBadge', { token, tag: '04aa11bb' }).badge, 'V1');
eq(api('adminAddBadge', { token, tag: '04CC22DD04CC22DD' }).badge, 'V2'); // doubled read collapses
eq(api('adminAddBadge', { token }).badge, 'V3');
eq(api('adminLinkTag', { token, badge: 'V3', tag: '04AA11BB' }).movedFrom, 'V1');

// ------------------------------------------------------------------ new visitor with screening answers
const missing = api('register', { first: 'Dana' });
eq(missing.error, 'missing');
eq(missing.fields, ['last', 'visiting', 'purpose', 'agreed', 'photo']);
const reg = api('register', {
  first: '=Dana', last: 'Lee', company: 'Acme Aerospace', visiting: 'Mike', purpose: 'Audit',
  agreed: true, quickEntry: true, photo, descriptor,
  answers: [
    { label: 'Citizenship status', value: 'Not a U.S. citizen or permanent resident' },
    { label: 'Country of citizenship', value: 'Canada' },
  ],
  flags: [{ label: 'Citizenship status', answer: 'Not a U.S. citizen or permanent resident', flagLabel: 'Foreign national' }],
});
ok(reg.ok, JSON.stringify(reg));
eq(reg.visitor.kind, 'Foreign national');
const vhead = b.sheets.Visitors.rows[0];
const vrow = b.sheets.Visitors.objects()[0];
eq(vrow['First Name'], 'Dana', 'leading = stripped so it never runs as a formula');
eq(vrow['Citizenship status'], 'Not a U.S. citizen or permanent resident');
eq(vrow['Country of citizenship'], 'Canada');
eq(vrow.Screening, 'Flagged: Foreign national');
eq(vhead.indexOf('Country of citizenship') + 1, vhead.indexOf('Visitor acknowledgment'), 'answers sit just before the bookkeeping columns');
ok(vhead.indexOf('Purpose of your visit') < vhead.indexOf('Citizenship status'));
ok(String(vrow['Photo folder']).startsWith('https://drive.google.com/drive/folders/'));
eq(b.mail.length, 1, 'flagged answers email the alert addresses');
eq(b.mail[0].to, 'security@acme.test,front@acme.test');
ok(/Visitor alert: Dana Lee/.test(b.mail[0].subject));
eq(b.mail[0].attachments[0].type, 'image/jpeg', 'with the photo attached');
eq(api('faceIndex').people[0].descriptors.length, 1);

// Badge tap at the end of sign-in.
eq(api('assignBadge', { visitorId: reg.visitor.id, tag: 'unknown1' }).error, 'badge_unknown');
const assigned = api('assignBadge', { visitorId: reg.visitor.id, tag: '04AA11BB', method: 'new visitor' });
eq(assigned.badge, 'V3');
const insideNow = api('adminInside', { token }).inside[0];
eq(insideNow.kind, 'Foreign national');
eq(insideNow.screening, 'Flagged: Foreign national');
eq(api('adminRetireBadge', { token, badge: 'V3' }).error, 'badge_in_use');
let attention = api('adminAttention', { token }).items;
eq(attention.map((i) => i.kind), ['flagged'], 'flagged visits need a look');
ok(api('adminReview', { token, visitId: attention[0].visitId }).ok);
eq(api('adminAttention', { token }).items.length, 0, 'reviewed items drop off');

// Second visitor can't take the same badge.
const reg2 = api('register', {
  first: 'Sam', last: 'Ortiz', company: 'N/A', visiting: 'Mike', purpose: 'Interview',
  agreed: true, quickEntry: false, photo, answers: [{ label: 'Citizenship status', value: 'U.S. citizen' }],
});
ok(reg2.ok);
eq(reg2.visitor.kind, 'Visitor');
eq(api('assignBadge', { visitorId: reg2.visitor.id, tag: '04AA11BB' }).error, 'badge_in_use');
eq(api('faceIndex').people.length, 1, 'opted-out visitors are never in the face index');

// Tap at the welcome screen signs out; undo puts them back.
const out = api('tapAtWelcome', { tag: '04aa11bb' });
eq(out.result, 'signed_out');
eq(out.first, 'Dana');
eq(api('tapAtWelcome', { tag: '04AA11BB' }).result, 'not_out');
ok(api('undoSignOut', { visitId: out.visitId }).ok);
eq(api('adminInside', { token }).inside.length, 1);

// Admin sign-out.
ok(api('adminSignOut', { token, visitId: out.visitId }).ok);
eq(api('adminInside', { token }).inside.length, 0);
eq(api('adminBadges', { token }).badges.find((x) => x.badge === 'V3').status, 'available');

// Returning visitor by name (one typo allowed in longer names), then a new face sample.
eq(api('findVisitor', { first: 'Dana' }).error, 'fullname');
eq(api('findVisitor', { first: 'dana', last: 'LEE', company: 'acme' }).matches.length, 1);
eq(api('findVisitor', { first: 'Dana', last: 'Lee', company: 'Boeing' }).matches.length, 0);
ok(api('addFaceSample', { visitorId: reg.visitor.id, photo, descriptor, source: 'return-name' }).saved);
eq(api('faceIndex').people[0].descriptors.length, 2);
eq(api('addFaceSample', { visitorId: reg2.visitor.id, photo, descriptor }).saved, false);

// Opting in later, then out again (face data removed).
ok(api('setQuickEntry', { visitorId: reg2.visitor.id, on: true }).ok);
ok(api('addFaceSample', { visitorId: reg2.visitor.id, photo, descriptor }).saved);
ok(api('setQuickEntry', { visitorId: reg2.visitor.id, on: false }).ok);
eq(api('faceIndex').people.length, 1);

// A second badge for someone already inside replaces the first.
api('assignBadge', { visitorId: reg.visitor.id, tag: '04AA11BB' });
api('assignBadge', { visitorId: reg.visitor.id, tag: '04CC22DD' });
eq(api('adminInside', { token }).inside.map((v) => v.badge), ['V2']);

// ------------------------------------------------------------------ declined visitors
const mailBefore = b.mail.length;
const decline = api('recordDecline', {
  first: 'Ivan', last: 'Petrov', company: 'Globex', visiting: 'Mike', purpose: 'Meeting', photo,
  reasons: [{ label: 'Citizenship status', answer: 'Not a U.S. citizen or permanent resident' }],
});
ok(decline.ok && decline.declineId, JSON.stringify(decline));
const drow = b.sheets.Visits.objects().find((r) => r['Visit ID'] === decline.declineId);
eq(drow.Kind, 'Declined');
ok(drow['Signed out'], 'a decline is never counted as inside');
eq(drow.Screening, 'Declined: Citizenship status = Not a U.S. citizen or permanent resident');
ok(/^https:\/\/drive\.google\.com\/file\//.test(drow.Photo), 'their photo is kept in Drive');
eq(b.mail.length, mailBefore + 1);
ok(/Visitor declined: Ivan Petrov/.test(b.mail.at(-1).subject));
ok(b.mail.at(-1).attachments, 'the decline alert has the photo');
eq(api('adminInside', { token }).inside.map((v) => v.first), ['Dana']);
attention = api('adminAttention', { token }).items;
eq(attention[0].kind, 'declined');
eq(attention[0].first, 'Ivan');

// An admin lets them in: the next attempt passes, and the sign-in records who allowed it.
eq(api('adminAllow', { token: 'bad', visitId: decline.declineId }).error, 'admin');
ok(api('adminAllow', { token, visitId: decline.declineId, reason: 'Escorted by security' }).ok);
eq(api('adminAttention', { token }).items.filter((i) => i.kind === 'declined').length, 0, 'an allowed decline is handled');
ok(api('adminAttention', { token }).items.every((i) => i.first === 'Dana'), "Dana's later visits are each flagged for a look");
const retry = api('recordDecline', { first: 'IVAN', last: 'petrov', reasons: [{ label: 'Citizenship status', answer: 'No' }] });
eq(retry.passed, true);
eq(retry.reason, 'Escorted by security');
eq(retry.by, 'Jordan Lee');
const third = api('recordDecline', { first: 'Ivan', last: 'Petrov', reasons: [{ label: 'x', answer: 'y' }] });
ok(third.declineId, 'a pass is used once');
const overridden = api('register', {
  first: 'Ivan', last: 'Petrov', company: 'Globex', visiting: 'Mike', purpose: 'Meeting', agreed: true, photo,
  answers: [{ label: 'Citizenship status', value: 'Not a U.S. citizen or permanent resident' }],
  override: { by: 'Jordan Lee', reason: 'Escorted by security' },
});
ok(overridden.ok);
eq(overridden.visitor.kind, 'Visitor (override)');
eq(b.sheets.Visitors.objects().at(-1).Screening, 'Overridden by Jordan Lee: Escorted by security');

// ------------------------------------------------------------------ kiosks without badges
const plain = api('checkIn', { visitorId: reg2.visitor.id, method: 'returning (name)' });
ok(plain.ok && plain.visitId);
eq(api('adminInside', { token }).inside.find((v) => v.first === 'Sam').badge, '');
eq(api('findOpenVisits', { first: 'Sam' }).error, 'fullname');
const open = api('findOpenVisits', { first: 'sam', last: 'ORTIZ' });
eq(open.matches.length, 1);
const bye = api('kioskSignOut', { visitId: open.matches[0].visitId });
eq(bye.first, 'Sam');
eq(api('kioskSignOut', { visitId: open.matches[0].visitId }).error, 'not_found');
ok(api('undoSignOut', { visitId: bye.visitId }).ok, 'undo works without a badge too');
eq(api('findOpenVisits', { first: 'Sam', last: 'Ortiz' }).matches.length, 1);

// Every-visit questions: this visit's flags decide its kind.
const flaggedVisit = api('checkIn', { visitorId: reg2.visitor.id, flags: [{ label: 'Tools on site', answer: 'Yes', flagLabel: 'Bringing tools' }] });
ok(flaggedVisit.ok);
eq(b.sheets.Visits.objects().find((r) => r['Visit ID'] === flaggedVisit.visitId).Kind, 'Bringing tools');

// ------------------------------------------------------------------ settings that relax the form
ok(api('adminSaveSettings', { token, settings: { ...settings, form: { askHost: false, askPurpose: false, rules: [] }, photos: 'off' } }).ok);
const quick = api('register', { first: 'Ana', last: 'Silva' });
ok(quick.ok, 'host, purpose, rules and photo are only required when the kiosk asks for them');
eq(b.sheets.Visitors.objects().at(-1)['Photo folder'], '');

// ------------------------------------------------------------------ older sheets
{
  const old = loadBackend({ KIOSK_KEY: KEY });
  const ss = old.globals.SpreadsheetApp.getActiveSpreadsheet();
  const vis = ss.insertSheet('Visitors');
  vis.appendRow(['First Name', 'Last Name', 'Company', 'Who are you visiting at Shock Tech?', 'Purpose of your visit', 'Citizenship status', 'Country of citizenship', 'Visitor acknowledgment', 'Quick entry', 'Registered', 'Last visit', 'Visit count', 'Visitor ID', 'Photo folder']);
  old.ctx.setup();
  const call = (action, args) => old.handle({ key: KEY, action, args });
  const r = call('register', { first: 'Lee', last: 'Wong', company: 'Initech', visiting: 'Mike', purpose: 'Audit', agreed: true, photo, answers: [{ label: 'Citizenship status', value: 'U.S. citizen' }] });
  ok(r.ok, JSON.stringify(r));
  const row = vis.objects()[0];
  eq(row['Who are you visiting at Shock Tech?'], 'Mike', 'company-named host column keeps being used');
  eq(row['Citizenship status'], 'U.S. citizen');
  ok(!vis.rows[0].includes('Who are you visiting?'), 'no duplicate host column is added');
  eq(call('findVisitor', { first: 'Lee', last: 'Wong' }).matches.length, 1);
}

// ------------------------------------------------------------------ host emails, history, photos, end of day
{
  const h = loadBackend();
  h.handle({ action: 'claim', key: KEY });
  const call = (action, args) => h.handle({ key: KEY, action, args });
  const tok = call('adminSetPin', { pin: '246810' }).token;
  const base = { setupComplete: true, org: { name: 'Initech' }, admin: { name: 'Sam' }, storage: 'cloud', badges: false, photos: 'all' };
  call('adminSaveSettings', { token: tok, settings: { ...base, notifyHosts: true, hosts: [{ name: 'Bill Lumbergh', email: 'bill@initech.example' }, { name: 'Peter Gibbons', email: '' }] } });
  const reg = call('register', { first: 'Milton', last: 'Waddams', company: 'Initech', visiting: 'bill lumberg', purpose: 'Stapler', agreed: true, photo });
  const mails = h.mail.length;
  const inn = call('checkIn', { visitorId: reg.visitor.id, method: 'new visitor' });
  eq(inn.hostNotified, 'Bill Lumbergh', 'host found despite case and a typo');
  eq(h.mail.length, mails + 1);
  const m = h.mail.at(-1);
  eq(m.to, 'bill@initech.example');
  ok(/Your visitor has arrived: Milton Waddams/.test(m.subject) && /Purpose: Stapler/.test(m.body), 'host email text');
  ok(/^Bill Lumbergh \(/.test(h.sheets.Visits.objects().at(-1)['Host notified']), 'host email noted on the visit');

  const reg2 = call('register', { first: 'Joanna', last: 'Smith', company: 'Chotchkies', visiting: 'Peter Gibbons', purpose: 'Lunch', agreed: true, photo });
  eq(call('checkIn', { visitorId: reg2.visitor.id }).hostNotified, '', 'hosts without an email are not notified');
  call('adminSaveSettings', { token: tok, settings: { ...base, notifyHosts: false, hosts: [{ name: 'Bill Lumbergh', email: 'bill@initech.example' }] } });
  const before = h.mail.length;
  call('checkIn', { visitorId: reg.visitor.id });
  eq(h.mail.length, before, 'host emails can be turned off');

  // History, newest first, with a search.
  const hist = call('adminHistory', { token: tok, days: 7 });
  ok(hist.ok && hist.visits.length === 3, JSON.stringify(hist).slice(0, 200));
  eq(hist.visits[0].first, 'Milton');
  ok(hist.visits.some((v) => v.signedOutBy === 'Signed in again'), 'replaced visit shows how it ended');
  eq(call('adminHistory', { token: tok, q: 'chotch' }).visits.map((v) => v.last), ['Smith'], 'history search by company');
  eq(call('adminHistory', { q: 'x' }).error, 'admin', 'history needs an admin');

  // Photos for the roll call: the visitor's own photo, from their Drive folder.
  const pic = call('adminPhoto', { token: tok, visitId: hist.visits[0].visitId });
  eq(pic.photo, photo);
  const dec = call('recordDecline', { first: 'Bob', last: 'Slydell', company: 'Consulting', photo, reasons: [{ label: 'Illness', answer: 'Yes' }] });
  eq(call('adminPhoto', { token: tok, visitId: dec.declineId }).photo, photo, 'declined visitor photo');
  eq(call('adminPhoto', { token: tok, visitId: 'nope' }).error, 'not_found');

  // End of day: signs out visits from before the cutoff only.
  const visits = h.sheets.Visits;
  const head = visits.rows[0];
  const open = visits.rows.slice(1).filter((r) => r[head.indexOf('Visit ID')] && !r[head.indexOf('Signed out')]);
  eq(open.length, 2);
  open[0][head.indexOf('Signed in')] = new Date(Date.now() - 3 * 3600 * 1000);
  const cutoff = new Date(Date.now() - 3600 * 1000).toISOString();
  eq(call('endOfDay', { before: cutoff }).signedOut, 1, 'only visits before the cutoff');
  eq(call('endOfDay', { before: cutoff }).signedOut, 0, 'running it again changes nothing');
  ok(visits.objects().some((r) => r['Signed out by'] === 'End of day'));
  eq(call('endOfDay', { before: new Date(Date.now() + 86400000).toISOString() }).signedOut, 1, 'a future cutoff means now');
  eq(call('adminInside', { token: tok }).inside.length, 0);
}

// ------------------------------------------------------------------ retries
// A retried write (same request id) replays the first answer instead of writing twice.
const before = b.sheets.Visitors.rows.length;
const args = { first: 'Ana', last: 'Silva', company: 'N/A' };
const firstTry = b.handle({ key: KEY, action: 'register', args, rid: 'abc123-retry' });
const again = b.handle({ key: KEY, action: 'register', args, rid: 'abc123-retry' });
eq(again.visitor.id, firstTry.visitor.id);
eq(b.sheets.Visitors.rows.length, before + 1);

console.log(`apps-script tests passed (${checks} checks)`);
