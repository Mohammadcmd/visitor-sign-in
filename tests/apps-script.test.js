// Runs apps-script/Code.gs against in-memory stand-ins for SpreadsheetApp,
// DriveApp, CacheService, LockService and friends.
// Usage: node tests/apps-script.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const crypto = require('crypto');

function fakeGoogle() {
  const sheets = {};
  const props = { KIOSK_KEY: 'k', ADMIN_PIN: '246810' };
  const cache = {};
  let fileSeq = 0;

  function makeSheet(name) {
    const rows = [];
    const sh = {
      name, hidden: false, rows,
      getName: () => name,
      getLastRow: () => rows.length,
      getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
      getRange(r, c, nr = 1, nc = 1) {
        return {
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
            const v = (rows[r - 1 + i] || [])[c - 1 + j];
            return v === undefined ? '' : v;
          })),
          setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => { (rows[r - 1 + i] ||= [])[c - 1 + j] = v; })); return this; },
          setValue(v) { (rows[r - 1] ||= [])[c - 1] = v; return this; },
          setFontWeight() { return this; },
        };
      },
      appendRow(row) { rows.push(row.slice()); },
      deleteRow(r) { rows.splice(r - 1, 1); },
      setFrozenRows() {},
      hideSheet() { sh.hidden = true; },
    };
    return sh;
  }

  const book = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
  };
  const folder = (name) => ({
    name, files: [],
    getId: () => 'F' + name.length,
    getUrl: () => `https://drive.google.com/drive/folders/FOLDER${name.replace(/\W/g, '').slice(0, 20)}`,
    createFolder(n) { return folder(n); },
    createFile(blob) { this.files.push(blob); return { getId: () => 'file' + (++fileSeq) }; },
  });
  const root = folder('Shock Tech visitor photos');

  const globals = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => book, openById: () => book },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    DriveApp: {
      getFolderById: () => root,
      getFoldersByName: () => ({ hasNext: () => true, next: () => root }),
      createFolder: () => root,
    },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      sleep() {},
      computeDigest: (_, s) => [...crypto.createHash('sha256').update(s).digest()].map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'sha256' },
      formatDate: (d) => d.toISOString(),
      base64Decode: (s) => Buffer.from(s, 'base64'),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
    },
    Session: { getScriptTimeZone: () => 'America/New_York' },
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => s }), MimeType: { JSON: 'json' } },
    Logger: { log() {} },
  };
  return { globals, sheets, props, root };
}

const g = fakeGoogle();
const ctx = vm.createContext(g.globals);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), ctx);
const api = (action, args) => ctx.handle_({ key: 'k', action, args });

ctx.setup();
assert.deepStrictEqual(Object.keys(g.sheets).sort(), ['Badges', 'Face data', 'Visitors', 'Visits']);
assert.ok(g.sheets['Face data'].hidden);
const visitorHead = g.sheets.Visitors.rows[0];
assert.strictEqual(visitorHead[0], 'First Name');
assert.strictEqual(visitorHead[1], 'Last Name');
assert.strictEqual(visitorHead[visitorHead.length - 1], 'Photo folder');

// Wrong kiosk key is refused.
assert.strictEqual(ctx.handle_({ key: 'nope', action: 'ping' }).error, 'kiosk_key');

// Admin login and badges.
assert.strictEqual(api('adminLogin', { pin: '000000' }).error, 'pin');
const token = api('adminLogin', { pin: '246810' }).token;
assert.ok(token);
assert.strictEqual(api('adminAddBadge', { token: 'bad' }).error, 'admin');
assert.strictEqual(api('adminAddBadge', { token, tag: '04aa11bb' }).badge, 'V1');
assert.strictEqual(api('adminAddBadge', { token, tag: '04CC22DD04CC22DD' }).badge, 'V2'); // doubled read collapses
assert.strictEqual(api('adminAddBadge', { token }).badge, 'V3');
assert.strictEqual(api('adminLinkTag', { token, badge: 'V3', tag: '04AA11BB' }).movedFrom, 'V1');

// New visitor.
const photo = 'data:image/jpeg;base64,' + Buffer.from('fake jpeg').toString('base64');
const descriptor = Array.from({ length: 128 }, (_, i) => Math.sin(i));
const missing = api('register', { first: 'Dana' });
assert.strictEqual(missing.error, 'missing');
const reg = api('register', {
  first: '=Dana', last: 'Lee', company: 'Acme Aerospace', visiting: 'Mike', purpose: 'Audit',
  citizenship: 'Not a U.S. citizen or permanent resident', country: 'Canada', agreed: true,
  quickEntry: true, photo, descriptor,
});
assert.ok(reg.ok, JSON.stringify(reg));
const vrow = g.sheets.Visitors.rows[1];
assert.strictEqual(vrow[0], 'Dana', 'leading = stripped so it never runs as a formula');
assert.ok(String(vrow[vrow.length - 1]).startsWith('https://drive.google.com/drive/folders/'));
assert.strictEqual(api('faceIndex').people[0].descriptors.length, 1);

// Badge tap at the end of sign-in.
assert.strictEqual(api('assignBadge', { visitorId: reg.visitor.id, tag: 'unknown1' }).error, 'badge_unknown');
const assigned = api('assignBadge', { visitorId: reg.visitor.id, tag: '04AA11BB', method: 'new visitor' });
assert.strictEqual(assigned.badge, 'V3');
assert.strictEqual(api('adminInside', { token }).inside[0].kind, 'Foreign national');
assert.strictEqual(api('adminRetireBadge', { token, badge: 'V3' }).error, 'badge_in_use');

// Second visitor can't take the same badge.
const reg2 = api('register', {
  first: 'Sam', last: 'Ortiz', company: 'N/A', visiting: 'Mike', purpose: 'Interview',
  citizenship: 'U.S. citizen', agreed: true, quickEntry: false, photo,
});
assert.strictEqual(api('assignBadge', { visitorId: reg2.visitor.id, tag: '04AA11BB' }).error, 'badge_in_use');
assert.strictEqual(api('faceIndex').people.length, 1, 'opted-out visitors are never in the face index');

// Tap at the welcome screen signs out; undo puts them back.
const out = api('tapAtWelcome', { tag: '04aa11bb' });
assert.strictEqual(out.result, 'signed_out');
assert.strictEqual(out.first, 'Dana');
assert.strictEqual(api('tapAtWelcome', { tag: '04AA11BB' }).result, 'not_out');
assert.ok(api('undoSignOut', { visitId: out.visitId }).ok);
assert.strictEqual(api('adminInside', { token }).inside.length, 1);

// Admin sign-out.
assert.ok(api('adminSignOut', { token, visitId: out.visitId }).ok);
assert.strictEqual(api('adminInside', { token }).inside.length, 0);
assert.strictEqual(api('adminBadges', { token }).badges.find((b) => b.badge === 'V3').status, 'available');

// Returning visitor by name (one typo allowed in longer names), then a new face sample.
assert.strictEqual(api('findVisitor', { first: 'Dana' }).error, 'fullname');
const found = api('findVisitor', { first: 'dana', last: 'LEE', company: 'acme' });
assert.strictEqual(found.matches.length, 1);
assert.strictEqual(api('findVisitor', { first: 'Dana', last: 'Lee', company: 'Boeing' }).matches.length, 0);
assert.ok(api('addFaceSample', { visitorId: reg.visitor.id, photo, descriptor, source: 'return-name' }).saved);
assert.strictEqual(api('faceIndex').people[0].descriptors.length, 2);
assert.strictEqual(api('addFaceSample', { visitorId: reg2.visitor.id, photo, descriptor }).saved, false);

// Opting in later, then out again (face data removed).
assert.ok(api('setQuickEntry', { visitorId: reg2.visitor.id, on: true }).ok);
assert.ok(api('addFaceSample', { visitorId: reg2.visitor.id, photo, descriptor }).saved);
assert.ok(api('setQuickEntry', { visitorId: reg2.visitor.id, on: false }).ok);
assert.strictEqual(api('faceIndex').people.length, 1);

// A second badge for someone already inside replaces the first.
api('assignBadge', { visitorId: reg.visitor.id, tag: '04AA11BB' });
api('assignBadge', { visitorId: reg.visitor.id, tag: '04CC22DD' });
const inside = api('adminInside', { token }).inside;
assert.deepStrictEqual(inside.map((v) => v.badge), ['V2']);

// A retried write (same request id) replays the first answer instead of writing twice.
const before = g.sheets.Visitors.rows.length;
const args = { first: 'Ana', last: 'Silva', company: 'N/A', visiting: 'Mike', purpose: 'Interview', citizenship: 'U.S. citizen', agreed: true, photo };
const first = ctx.handle_({ key: 'k', action: 'register', args, rid: 'abc123-retry' });
const again = ctx.handle_({ key: 'k', action: 'register', args, rid: 'abc123-retry' });
assert.strictEqual(again.visitor.id, first.visitor.id);
assert.strictEqual(g.sheets.Visitors.rows.length, before + 1);

console.log('apps-script tests passed');
