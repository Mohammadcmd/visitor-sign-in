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
  eq(claim.version, 4);
  eq(claim.setupComplete, false);
  eq(claim.hasPin, false);
  eq(b.order, ['Visitors', 'Visits', 'Badges', 'Face data', 'Settings', 'Expected']);
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

// ------------------------------------------------------------------ expected visitors, badges not returned, daily summary
{
  const x = loadBackend();
  x.handle({ action: 'claim', key: KEY });
  const call = (action, args) => x.handle({ key: KEY, action, args });
  const tok = call('adminSetPin', { pin: '246810' }).token;
  call('adminSaveSettings', { token: tok, settings: {
    setupComplete: true, org: { name: 'Initech' }, admin: { name: 'Sam' }, storage: 'cloud', badges: true, photos: 'off',
    form: { rules: [] }, screening: { alertEmails: 'desk@initech.example' }, dailySummary: true,
    notifyHosts: true, hosts: [{ name: 'Bill Lumbergh', email: 'bill@initech.example' }],
  } });
  const today = x.ctx.dayKey_(new Date());
  const tomorrow = x.ctx.dayKey_(new Date(Date.now() + 86400000));

  // Staff add expected visitors from the kiosk, or by typing into the Expected tab.
  eq(call('adminAddExpected', { token: tok, first: 'Ann', day: today }).error, 'missing');
  ok(call('adminAddExpected', { token: tok, first: 'Michael', last: 'Bolton', company: 'Initech', host: 'Bill Lumbergh', purpose: 'TPS reports', day: today }).ok);
  call('adminAddExpected', { token: tok, first: 'Tom', last: 'Smykowski', host: 'Bill Lumbergh', day: tomorrow });
  x.sheets.Expected.appendRow([today, 'Samir', 'Nagheenanajar', 'Initech', 'Bill Lumbergh', 'Interview', '', '', '', '']);
  const list = call('adminExpected', { token: tok });
  eq(list.expected.map((e) => e.first), ['Michael', 'Samir', 'Tom'], 'today first, then tomorrow');
  ok(/^E[A-Z0-9]{8}$/.test(list.expected[1].id) && x.sheets.Expected.objects().find((r) => r['First Name'] === 'Samir')['Expected ID'] === list.expected[1].id, 'rows typed into the sheet are listed, and get an id');

  // The kiosk greets them after the name step (spelling slips allowed).
  const found = call('findExpected', { first: 'michael', last: 'boltan' }).expected;
  eq([found.company, found.host, found.purpose], ['Initech', 'Bill Lumbergh', 'TPS reports']);
  eq(call('findExpected', { first: 'Tom', last: 'Smykowski' }).expected, null, 'not expected until tomorrow');
  const samir = call('findExpected', { first: 'Samir', last: 'Nagheenanajar' }).expected;
  ok(/^E[A-Z0-9]{8}$/.test(samir.id) && x.sheets.Expected.objects().find((r) => r['First Name'] === 'Samir')['Expected ID'] === samir.id, 'a typed-in row gets an id');

  // Signing in marks them arrived and fills in the host, who is emailed.
  const mb = call('register', { first: 'Michael', last: 'Bolton', company: 'Initech', visiting: 'Peter', purpose: 'Lunch' });
  call('adminAddBadge', { token: tok, tag: '04BB00' });
  const got = call('assignBadge', { visitorId: mb.visitor.id, tag: '04BB00', expectedId: found.id });
  ok(got.ok && got.expected && got.hostNotified === 'Bill Lumbergh', JSON.stringify(got));
  const visit = x.sheets.Visits.objects().at(-1);
  eq([visit.Visiting, visit.Purpose], ['Bill Lumbergh', 'TPS reports'], 'the visit uses the expected host and purpose');
  ok(/^Signed in /.test(x.sheets.Expected.objects()[0].Arrived), 'expected visitor marked arrived');
  eq(call('findExpected', { first: 'Michael', last: 'Bolton' }).expected, null, 'only greeted once');
  call('recordDecline', { first: 'Samir', last: 'Nagheenanajar', reasons: [{ label: 'Prohibited items', answer: 'Yes' }] });
  ok(/^Declined at the kiosk/.test(x.sheets.Expected.objects().find((r) => r['First Name'] === 'Samir').Arrived), 'a decline is noted on the expected row');

  // Removing an expected visitor.
  const tomId = call('adminExpected', { token: tok }).expected.find((e) => e.first === 'Tom').id;
  ok(call('adminRemoveExpected', { token: tok, id: tomId }).ok);
  eq(call('adminExpected', { token: tok }).expected.length, 2);
  eq(call('adminRemoveExpected', { token: tok, id: 'nope' }).error, 'not_found');

  // End of day: Michael never tapped out, so his badge is "not returned", and the summary goes out once.
  const mails = x.mail.length;
  const eod = call('endOfDay', { before: new Date(Date.now() + 1000).toISOString() });
  ok(eod.signedOut === 1 && eod.summary === true, JSON.stringify(eod));
  const badge = x.sheets.Badges.objects()[0];
  ok(badge.Status === 'not returned' && /^Not returned by Michael Bolton/.test(badge.Note), 'badge marked not returned');
  eq(call('adminBadges', { token: tok }).badges[0].status, 'not returned');
  const summary = x.mail.at(-1);
  eq(x.mail.length, mails + 1);
  eq(summary.to, 'desk@initech.example');
  ok(/^Visitor summary for .+: 1 sign-in, 1 declined$/.test(summary.subject), summary.subject);
  ok(/Declined:\n  - Samir Nagheenanajar \(N\/A\)|Declined:\n  - Samir Nagheenanajar: /.test(summary.body), summary.body);
  ok(/Badges not returned:\n  - V1: Michael Bolton/.test(summary.body), 'summary lists badges not returned');
  ok(/signed out automatically\):\n  - Michael Bolton \(Initech\), badge V1/.test(summary.body), 'summary lists who was signed out');
  eq(call('endOfDay', { before: new Date().toISOString() }).summary, false, 'one summary a day');

  // The badge comes back: a tap at the welcome screen clears it.
  eq(call('tapAtWelcome', { tag: '04BB00' }).result, 'returned');
  eq(x.sheets.Badges.objects()[0].Status, 'available');
  eq(x.sheets.Badges.objects()[0].Note, '');

  // Sheets connected before the Expected tab existed get it when staff first add someone.
  const old = loadBackend();
  old.handle({ action: 'claim', key: KEY });
  delete old.sheets.Expected;
  const otok = old.handle({ key: KEY, action: 'adminSetPin', args: { pin: '246810' } }).token;
  eq(old.handle({ key: KEY, action: 'findExpected', args: { first: 'Ann', last: 'Lee' } }).expected, null, 'no Expected tab: nobody expected');
  ok(old.handle({ key: KEY, action: 'adminAddExpected', args: { token: otok, first: 'Ann', last: 'Lee', day: today } }).ok, 'tab created on demand');
}

// ------------------------------------------------------------------ visitors signing in another language
{
  const l = loadBackend();
  l.handle({ action: 'claim', key: KEY });
  const reg = l.handle({ key: KEY, action: 'register', args: { first: 'José', last: 'Muñoz', company: 'N/A', visiting: 'Pat', purpose: 'Reunión', agreed: true, photo, language: 'Español' } });
  ok(reg.ok, JSON.stringify(reg));
  ok(/^Agreed to the visitor rules on the kiosk, in Español \(/.test(l.sheets.Visitors.objects()[0]['Visitor acknowledgment']), 'the language the rules were agreed in is kept');
  l.handle({ key: KEY, action: 'register', args: { first: 'Ann', last: 'Lee', company: 'N/A', visiting: 'Pat', purpose: 'Meeting', agreed: true, photo, language: '=HYPERLINK("x")' } });
  ok(/^Agreed to the visitor rules on the kiosk \(/.test(l.sheets.Visitors.objects()[1]['Visitor acknowledgment']), 'odd language values are ignored');
  eq(l.handle({ key: KEY, action: 'findVisitor', args: { first: 'jose', last: 'munoz' } }).matches.length, 1, 'accents are ignored when searching');
}

// ------------------------------------------------------------------ deleting old records
{
  const k = loadBackend();
  k.handle({ action: 'claim', key: KEY });
  const call = (action, args) => k.handle({ key: KEY, action, args });
  const tok = call('adminSetPin', { pin: '246810' }).token;
  const save = (extra) => call('adminSaveSettings', { token: tok, settings: { setupComplete: true, org: { name: 'Initech' }, badges: false, photos: 'all', ...extra } });
  save({ retentionDays: 0 });
  const oldie = call('register', { first: 'Old', last: 'Timer', company: 'N/A', visiting: 'Pat', purpose: 'Audit', agreed: true, photo, quickEntry: true, descriptor });
  const fresh = call('register', { first: 'New', last: 'Comer', company: 'N/A', visiting: 'Pat', purpose: 'Audit', agreed: true, photo });
  call('checkIn', { visitorId: oldie.visitor.id });
  const oldVisit = call('checkIn', { visitorId: oldie.visitor.id }).visitId;
  call('kioskSignOut', { visitId: oldVisit });
  call('checkIn', { visitorId: fresh.visitor.id });
  const dec = call('recordDecline', { first: 'Ivy', last: 'Ancient', photo, reasons: [{ label: 'Illness', answer: 'Yes' }] });
  call('adminAddExpected', { token: tok, first: 'Long', last: 'Gone', day: '2020-01-01' });
  eq(call('purgeOld').removed, null, 'nothing is deleted while records are kept forever');

  // Age Old Timer's visits and the decline by a year.
  const ago = new Date(Date.now() - 400 * 86400000);
  const set = (tab, match, col, value) => {
    const sh = k.sheets[tab], head = sh.rows[0];
    sh.rows.slice(1).forEach((r) => { if (match(Object.fromEntries(head.map((h, i) => [h, r[i]])))) r[head.indexOf(col)] = value; });
  };
  set('Visits', (r) => r['First Name'] === 'Old' || r['First Name'] === 'Ivy', 'Signed in', ago);
  set('Visitors', (r) => r['First Name'] === 'Old', 'Last visit', ago);
  const folderUrl = k.sheets.Visitors.objects().find((r) => r['First Name'] === 'Old')['Photo folder'];
  const declinePhoto = k.sheets.Visits.objects().find((r) => r['Visit ID'] === dec.declineId).Photo;
  ok(k.sheets['Face data'].objects().some((r) => r['Visitor ID'] === oldie.visitor.id), 'face data before');

  save({ retentionDays: 365 });
  const res = call('purgeOld');
  ok(res.ok && res.removed, JSON.stringify(res));
  eq(res.removed, { visits: 3, visitors: 1, expected: 1 }, 'old visits, the visitor and the past expected row');
  eq(k.sheets.Visitors.objects().map((r) => r['First Name']), ['New']);
  eq(k.sheets.Visits.objects().map((r) => r['First Name']), ['New'], 'the open visit of a recent visitor stays');
  ok(!k.sheets['Face data'].objects().some((r) => r['Visitor ID'] === oldie.visitor.id), 'their face data is deleted');
  ok(k.globals.DriveApp.getFolderById(k.ctx.driveId_(folderUrl)).trashed, 'their photo folder is trashed');
  ok(k.files[k.ctx.driveId_(declinePhoto)].trashed, 'the declined visitor photo is trashed');
  eq(call('purgeOld').removed, null, 'once a day');
}

// ------------------------------------------------------------------ fixes from the launch review
{
  const f = loadBackend();
  f.handle({ action: 'claim', key: KEY });
  const call = (action, args) => f.handle({ key: KEY, action, args });
  const tok = call('adminSetPin', { pin: '246810' }).token;
  call('adminSaveSettings', { token: tok, settings: { setupComplete: true, org: { name: 'Initech' }, badges: false, photos: 'off', form: { rules: [] } } });

  // A retry that arrives while the first attempt is still running doesn't write twice.
  f.cache['rid:retry-while-running'] = '"in progress"';
  const before = f.sheets.Visitors.rows.length;
  eq(f.handle({ key: KEY, action: 'register', args: { first: 'Rita', last: 'Retry', visiting: 'Pat', purpose: 'Meeting' }, rid: 'retry-while-running' }).error, 'busy');
  eq(f.sheets.Visitors.rows.length, before, 'nothing written while the first attempt runs');

  // A staff override isn't repeated on later visits; the visit notes the earlier approval.
  const ov = call('register', { first: 'Olga', last: 'Override', visiting: 'Pat', purpose: 'Meeting', override: { by: 'Sam', reason: 'Escorted' } });
  call('checkIn', { visitorId: ov.visitor.id, override: { by: 'Sam', reason: 'Escorted' } });
  eq(f.sheets.Visits.objects().at(-1).Kind, 'Visitor (override)');
  call('checkIn', { visitorId: ov.visitor.id });
  const later = f.sheets.Visits.objects().at(-1);
  eq(later.Kind, 'Visitor (approved earlier)', 'a later visit is not counted as another override');
  ok(/^Approved earlier: Overridden by Sam/.test(later.Screening), later.Screening);

  // A once-only flag (like citizenship) keeps applying on later visits.
  const fl = call('register', { first: 'Fred', last: 'Flag', visiting: 'Pat', purpose: 'Meeting', flags: [{ label: 'Citizenship status', answer: 'No', flagLabel: 'Foreign national' }] });
  call('checkIn', { visitorId: fl.visitor.id });
  eq(f.sheets.Visits.objects().at(-1).Kind, 'Foreign national');

  // A settings save refused for size leaves the logo alone.
  ok(call('adminSaveSettings', { token: tok, settings: { setupComplete: true, org: { name: 'Initech' } }, logo }).ok);
  const logoId = JSON.parse(f.sheets.Settings.objects()[0].Value).org.logoFileId;
  const huge = { setupComplete: true, org: { name: 'Initech' }, form: { intro: 'x'.repeat(46000) } };
  eq(call('adminSaveSettings', { token: tok, settings: huge, logo }).error, 'too_big');
  eq(JSON.parse(f.sheets.Settings.objects()[0].Value).org.logoFileId, logoId, 'settings still point at the logo');
  ok(!f.files[logoId].trashed, 'and the logo is still there');
  eq(call('getSettings').logo, logo);

  // A purge that removes every visit keeps the tab usable.
  call('adminSaveSettings', { token: tok, settings: { setupComplete: true, org: { name: 'Initech' }, badges: false, photos: 'off', form: { rules: [] }, retentionDays: 30 } });
  const head = f.sheets.Visits.rows[0];
  f.sheets.Visits.rows.slice(1).forEach((r) => { r[head.indexOf('Signed in')] = new Date(Date.now() - 90 * 86400000); r[head.indexOf('Signed out')] = r[head.indexOf('Signed out')] || new Date(Date.now() - 89 * 86400000); });
  const res = call('purgeOld');
  ok(res.ok && res.removed.visits === 3, JSON.stringify(res));
  eq(f.sheets.Visits.objects().filter((r) => r['Visit ID']).length, 0, 'all old visits gone');
  ok(f.sheets.Visits.rows.length >= 2, 'one empty row stays (Sheets needs one)');
  ok(call('checkIn', { visitorId: fl.visitor.id }).ok, 'and new visits still work');
  eq(call('adminHistory', { token: tok, days: 1 }).visits.length, 1);
}

// The original Shock Tech sheet: foreign nationals stay flagged on every visit.
{
  const old = loadBackend({ KIOSK_KEY: KEY });
  const ss = old.globals.SpreadsheetApp.getActiveSpreadsheet();
  const vis = ss.insertSheet('Visitors');
  vis.appendRow(['First Name', 'Last Name', 'Company', 'Who are you visiting at Shock Tech?', 'Purpose of your visit', 'Citizenship status', 'Country of citizenship', 'Visitor acknowledgment', 'Quick entry', 'Registered', 'Last visit', 'Visit count', 'Visitor ID', 'Photo folder']);
  vis.appendRow(['Hans', 'Gruber', 'Nakatomi', 'Mike', 'Audit', 'Not a U.S. citizen or permanent resident', 'Germany', 'Agreed', 'No', new Date(), new Date(), 3, 'POLD0001', '']);
  vis.appendRow(['John', 'McClane', 'NYPD', 'Mike', 'Audit', 'U.S. citizen', 'United States', 'Agreed', 'No', new Date(), new Date(), 3, 'POLD0002', '']);
  old.ctx.setup();
  const call = (action, args) => old.handle({ key: KEY, action, args });
  call('checkIn', { visitorId: 'POLD0001' });
  call('checkIn', { visitorId: 'POLD0002' });
  const [hans, john] = old.sheets.Visits.objects();
  eq([hans.Kind, hans.Screening], ['Foreign national', 'Flagged: Foreign national'], 'citizenship from before screening questions still flags');
  eq([john.Kind, john.Screening], ['Visitor', 'Clear']);
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
