/**
 * Shock Tech visitor kiosk: Google Apps Script backend.
 *
 * The kiosk (web/) is a static page on the iPad. It calls this script as a
 * JSON API (POST, text/plain body) because Apps Script's own page sandbox
 * blocks camera access. This script owns the Google Sheet and the Drive
 * photo folders; the kiosk never touches either directly.
 *
 * Script properties (Project Settings > Script properties):
 *   KIOSK_KEY        shared secret the kiosk sends with every call (required)
 *   ADMIN_PIN        6 to 8 digits for the admin screen (required)
 *   PHOTO_FOLDER_ID  parent Drive folder for visitor photos (optional;
 *                    a folder named "Shock Tech visitor photos" is created otherwise)
 *   SPREADSHEET_ID   only needed when the script is NOT bound to the sheet
 */

var TABS = {
  visitors: 'Visitors',
  visits: 'Visits',
  badges: 'Badges',
  faces: 'Face data'
};

var HEADERS = {
  Visitors: [
    'First Name', 'Last Name', 'Company',
    'Who are you visiting at Shock Tech?', 'Purpose of your visit',
    'Citizenship status', 'Country of citizenship', 'Visitor acknowledgment',
    'Quick entry', 'Registered', 'Last visit', 'Visit count', 'Visitor ID', 'Photo folder'
  ],
  Visits: [
    'Signed in', 'First Name', 'Last Name', 'Company', 'Visiting', 'Purpose',
    'Kind', 'Badge', 'How they signed in', 'Signed out', 'Signed out by',
    'Visitor ID', 'Visit ID'
  ],
  Badges: ['Badge', 'NFC tag', 'Status', 'Holder', 'Visitor ID', 'Visit ID', 'Since', 'Note'],
  'Face data': ['Visitor ID', 'Descriptor', 'Captured', 'Source', 'Photo file ID']
};

var CITIZENSHIP_OPTIONS = [
  'U.S. citizen',
  'Lawful permanent resident (green card holder)',
  'Protected individual (asylee or refugee)',
  'Not a U.S. citizen or permanent resident'
];

var ADMIN_TOKEN_TTL = 15 * 60;   // seconds
var MAX_TEXT = 120;
var MAX_PHOTO_CHARS = 4 * 1024 * 1024;

// ---------------------------------------------------------------- setup

/** Run once by hand: creates the tabs and headers, and triggers the Drive permission prompt. */
function setup() {
  var ss = book_();
  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      // Add any missing headers on the right; never reorder or clear data.
      var have = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(lower_);
      HEADERS[name].forEach(function (h) {
        if (have.indexOf(h.toLowerCase()) < 0) {
          sh.getRange(1, sh.getLastColumn() + 1).setValue(h).setFontWeight('bold');
        }
      });
    }
  });
  ss.getSheetByName(TABS.faces).hideSheet();
  photoRoot_();
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('KIOSK_KEY')) props.setProperty('KIOSK_KEY', Utilities.getUuid());
  Logger.log('Setup done. KIOSK_KEY = ' + props.getProperty('KIOSK_KEY'));
  if (!props.getProperty('ADMIN_PIN')) Logger.log('Set an ADMIN_PIN script property (6 to 8 digits).');
}

// ---------------------------------------------------------------- HTTP

function doGet() {
  return json_({ ok: true, service: 'shocktech-visitor-kiosk' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  try {
    return json_(handle_(req));
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'server', message: String(err && err.message || err) });
  }
}

/** Dispatches one API call. Separate from doPost so tests can call it directly. */
// Calls that change the sheet. The kiosk retries these after a network hiccup
// with the same request id, so the first result is remembered and replayed.
var WRITE_ACTIONS = ['register', 'addFaceSample', 'setQuickEntry', 'assignBadge', 'tapAtWelcome',
  'undoSignOut', 'adminSignOut', 'adminAddBadge', 'adminLinkTag', 'adminRetireBadge', 'adminRestoreBadge'];
var REPLAY_TTL = 30 * 60;  // seconds

function handle_(req) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('KIOSK_KEY');
  if (!key || req.key !== key) return { ok: false, error: 'kiosk_key' };

  var rid = typeof req.rid === 'string' && /^[A-Za-z0-9-]{6,64}$/.test(req.rid) ? 'rid:' + req.rid : '';
  if (!rid || WRITE_ACTIONS.indexOf(req.action) < 0) return dispatch_(req);
  var cache = CacheService.getScriptCache();
  var seen = cache.get(rid);
  if (seen) return JSON.parse(seen);
  var out = dispatch_(req);
  if (out && out.error !== 'busy') cache.put(rid, JSON.stringify(out), REPLAY_TTL);
  return out;
}

function dispatch_(req) {
  var a = req.args || {};
  switch (req.action) {
    case 'ping': return { ok: true, citizenship: CITIZENSHIP_OPTIONS };
    case 'faceIndex': return faceIndex_();
    case 'register': return withLock_(function () { return register_(a); });
    case 'findVisitor': return findVisitor_(a);
    case 'addFaceSample': return withLock_(function () { return addFaceSample_(a); });
    case 'setQuickEntry': return withLock_(function () { return setQuickEntry_(a); });
    case 'assignBadge': return withLock_(function () { return assignBadge_(a); });
    case 'tapAtWelcome': return withLock_(function () { return tapAtWelcome_(a); });
    case 'undoSignOut': return withLock_(function () { return undoSignOut_(a); });
    case 'adminLogin': return adminLogin_(a);
  }

  // Everything below needs an admin token.
  if (!checkAdmin_(a.token)) return { ok: false, error: 'admin' };
  switch (req.action) {
    case 'adminInside': return adminInside_();
    case 'adminBadges': return adminBadges_();
    case 'adminSignOut': return withLock_(function () { return adminSignOut_(a); });
    case 'adminAddBadge': return withLock_(function () { return adminAddBadge_(a); });
    case 'adminLinkTag': return withLock_(function () { return adminLinkTag_(a); });
    case 'adminRetireBadge': return withLock_(function () { return adminRetireBadge_(a, true); });
    case 'adminRestoreBadge': return withLock_(function () { return adminRetireBadge_(a, false); });
  }
  return { ok: false, error: 'unknown_action' };
}

// ---------------------------------------------------------------- visitors

function register_(a) {
  var v = {
    first: clean_(a.first), last: clean_(a.last), company: clean_(a.company) || 'N/A',
    visiting: clean_(a.visiting), purpose: clean_(a.purpose),
    citizenship: clean_(a.citizenship), country: clean_(a.country),
    agreed: a.agreed === true, quickEntry: a.quickEntry === true
  };
  var missing = ['first', 'last', 'visiting', 'purpose', 'citizenship'].filter(function (k) { return !v[k]; });
  if (CITIZENSHIP_OPTIONS.indexOf(v.citizenship) < 0) missing.push('citizenship');
  if (v.citizenship === CITIZENSHIP_OPTIONS[0]) v.country = 'United States';
  if (!v.country) missing.push('country');
  if (!v.agreed) missing.push('agreed');
  if (!isPhoto_(a.photo)) missing.push('photo');
  if (missing.length) return { ok: false, error: 'missing', fields: missing };

  var id = 'P' + randomCode_(8);
  var folder = photoRoot_().createFolder(v.last + ', ' + v.first + ' (' + v.company + ') ' + id);
  var file = savePhoto_(folder, a.photo, 'signup');
  var now = new Date();

  appendRow_(TABS.visitors, {
    'First Name': v.first, 'Last Name': v.last, 'Company': v.company,
    'Who are you visiting at Shock Tech?': v.visiting, 'Purpose of your visit': v.purpose,
    'Citizenship status': v.citizenship, 'Country of citizenship': v.country,
    'Visitor acknowledgment': 'Agreed to the Shock Tech visitor rules on the kiosk (' + stamp_(now) + ')',
    'Quick entry': v.quickEntry ? 'Yes' : 'No',
    'Registered': now, 'Last visit': now, 'Visit count': 0,
    'Visitor ID': id, 'Photo folder': folder.getUrl()
  });

  if (v.quickEntry && isDescriptor_(a.descriptor)) {
    addFaceRow_(id, a.descriptor, 'signup', file.getId());
  }
  return { ok: true, visitor: publicVisitor_(id, v) };
}

/**
 * Name lookup for the "we couldn't confirm it's you" path. Needs first and
 * last name; company narrows it. Never returns a list of everyone.
 */
function findVisitor_(a) {
  var first = nameKey_(a.first), last = nameKey_(a.last), company = companyWords_(a.company);
  if (!first || !last) return { ok: false, error: 'fullname' };
  var rows = readTab_(TABS.visitors);
  var matches = rows.filter(function (r) {
    if (!near_(nameKey_(r['First Name']), first) || !near_(nameKey_(r['Last Name']), last)) return false;
    return !company.length || sameCompany_(companyWords_(r['Company']), company);
  }).slice(0, 5);
  return {
    ok: true,
    matches: matches.map(function (r) {
      return {
        id: r['Visitor ID'], first: r['First Name'], last: r['Last Name'], company: r['Company'],
        quickEntry: lower_(r['Quick entry']) === 'yes', lastVisit: dateOnly_(r['Last visit'])
      };
    })
  };
}

/** Every opted-in visitor's face descriptors, for matching on the iPad. */
function faceIndex_() {
  var people = {};
  readTab_(TABS.visitors).forEach(function (r) {
    if (lower_(r['Quick entry']) !== 'yes' || !r['Visitor ID']) return;
    people[r['Visitor ID']] = {
      id: r['Visitor ID'], first: r['First Name'], last: r['Last Name'], company: r['Company'], descriptors: []
    };
  });
  readTab_(TABS.faces).forEach(function (r) {
    var p = people[r['Visitor ID']];
    if (!p) return;
    try {
      var d = JSON.parse(r['Descriptor']);
      if (isDescriptor_(d)) p.descriptors.push(d);
    } catch (err) { /* skip a damaged row */ }
  });
  // Keep the newest 12 samples per person so the index stays small.
  var list = Object.keys(people).map(function (k) {
    var p = people[k];
    p.descriptors = p.descriptors.slice(-12);
    return p;
  }).filter(function (p) { return p.descriptors.length; });
  return { ok: true, people: list };
}

/** Saves another photo of a known visitor (only when they've opted into quick entry). */
function addFaceSample_(a) {
  var r = findRow_(TABS.visitors, 'Visitor ID', a.visitorId);
  if (!r) return { ok: false, error: 'not_found' };
  if (lower_(r.values['Quick entry']) !== 'yes') return { ok: true, saved: false };
  if (!isPhoto_(a.photo) || !isDescriptor_(a.descriptor)) return { ok: false, error: 'missing' };
  var folder = folderFromUrl_(r.values['Photo folder']);
  var fileId = folder ? savePhoto_(folder, a.photo, clean_(a.source) || 'return').getId() : '';
  addFaceRow_(a.visitorId, a.descriptor, clean_(a.source) || 'return', fileId);
  return { ok: true, saved: true };
}

function setQuickEntry_(a) {
  var r = findRow_(TABS.visitors, 'Visitor ID', a.visitorId);
  if (!r) return { ok: false, error: 'not_found' };
  setCell_(TABS.visitors, r.row, 'Quick entry', a.on ? 'Yes' : 'No');
  if (!a.on) removeFaceRows_(a.visitorId);
  return { ok: true };
}

// ---------------------------------------------------------------- badges and visits

/**
 * Called after the visitor taps a badge on the reader at the end of sign-in.
 * Creates the visit and marks the badge in use.
 */
function assignBadge_(a) {
  var person = findRow_(TABS.visitors, 'Visitor ID', a.visitorId);
  if (!person) return { ok: false, error: 'not_found' };
  var badge = badgeByTag_(a.tag);
  if (!badge) return { ok: false, error: 'badge_unknown' };
  var b = badge.values;
  if (lower_(b['Status']) === 'retired') return { ok: false, error: 'badge_retired', badge: b['Badge'] };
  if (lower_(b['Status']) === 'in use') {
    if (b['Visitor ID'] === a.visitorId) return { ok: true, badge: b['Badge'], already: true };
    return { ok: false, error: 'badge_in_use', badge: b['Badge'] };
  }

  // One open visit per person: a second badge replaces the first.
  var open = openVisitFor_(a.visitorId);
  if (open) signOutVisit_(open, 'Switched to badge ' + b['Badge']);

  var p = person.values, now = new Date(), visitId = 'S' + randomCode_(8);
  appendRow_(TABS.visits, {
    'Signed in': now, 'First Name': p['First Name'], 'Last Name': p['Last Name'],
    'Company': p['Company'],
    'Visiting': clean_(a.visiting) || p['Who are you visiting at Shock Tech?'],
    'Purpose': clean_(a.purpose) || p['Purpose of your visit'],
    'Kind': isUsPerson_(p['Citizenship status']) ? 'Visitor' : 'Foreign national',
    'Badge': b['Badge'], 'How they signed in': clean_(a.method) || 'kiosk',
    'Visitor ID': a.visitorId, 'Visit ID': visitId
  });
  setCells_(TABS.badges, badge.row, {
    'Status': 'in use', 'Holder': p['First Name'] + ' ' + p['Last Name'],
    'Visitor ID': a.visitorId, 'Visit ID': visitId, 'Since': now
  });
  setCells_(TABS.visitors, person.row, {
    'Last visit': now, 'Visit count': (Number(p['Visit count']) || 0) + 1
  });
  return { ok: true, badge: b['Badge'], visitId: visitId };
}

/** A badge tapped while the welcome screen shows: sign the holder out. */
function tapAtWelcome_(a) {
  var badge = badgeByTag_(a.tag);
  if (!badge) return { ok: true, result: 'unknown' };
  var b = badge.values;
  if (lower_(b['Status']) !== 'in use') return { ok: true, result: 'not_out', badge: b['Badge'] };
  var visit = findRow_(TABS.visits, 'Visit ID', b['Visit ID']);
  var name = b['Holder'];
  if (visit) signOutVisit_(visit, 'Badge tap at kiosk');
  else releaseBadge_(badge.row);
  return {
    ok: true, result: 'signed_out', badge: b['Badge'], name: name,
    first: visit ? visit.values['First Name'] : name, visitId: b['Visit ID']
  };
}

/** Puts a visitor back in after an accidental sign-out (kiosk Undo, within a minute). */
function undoSignOut_(a) {
  var visit = findRow_(TABS.visits, 'Visit ID', a.visitId);
  if (!visit) return { ok: false, error: 'not_found' };
  var out = visit.values['Signed out'];
  if (!out || (new Date() - new Date(out)) > 90 * 1000) return { ok: false, error: 'too_late' };
  var badge = findRow_(TABS.badges, 'Badge', visit.values['Badge']);
  if (!badge || lower_(badge.values['Status']) === 'in use') return { ok: false, error: 'badge_in_use' };
  setCells_(TABS.visits, visit.row, { 'Signed out': '', 'Signed out by': '' });
  setCells_(TABS.badges, badge.row, {
    'Status': 'in use', 'Holder': visit.values['First Name'] + ' ' + visit.values['Last Name'],
    'Visitor ID': visit.values['Visitor ID'], 'Visit ID': visit.values['Visit ID'],
    'Since': visit.values['Signed in']
  });
  return { ok: true };
}

function signOutVisit_(visit, by) {
  setCells_(TABS.visits, visit.row, { 'Signed out': new Date(), 'Signed out by': by });
  var badge = findRow_(TABS.badges, 'Badge', visit.values['Badge']);
  if (badge && badge.values['Visit ID'] === visit.values['Visit ID']) releaseBadge_(badge.row);
}

function releaseBadge_(row) {
  setCells_(TABS.badges, row, { 'Status': 'available', 'Holder': '', 'Visitor ID': '', 'Visit ID': '', 'Since': '' });
}

function openVisitFor_(visitorId) {
  var sh = sheet_(TABS.visits), rows = readTab_(TABS.visits);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i]['Visitor ID'] === visitorId && !rows[i]['Signed out']) {
      return { row: i + 2, values: rows[i], sheet: sh };
    }
  }
  return null;
}

function badgeByTag_(tag) {
  var t = normalizeTag_(tag);
  if (!t) return null;
  return findRow_(TABS.badges, 'NFC tag', t, function (v) { return normalizeTag_(v); });
}

// ---------------------------------------------------------------- admin

function adminLogin_(a) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('pinfails') || 0);
  if (fails >= 10) return { ok: false, error: 'locked' };
  var pin = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  if (!pin || String(a.pin || '') !== pin) {
    cache.put('pinfails', String(fails + 1), 600);
    Utilities.sleep(700);
    return { ok: false, error: 'pin' };
  }
  var token = Utilities.getUuid();
  cache.put('admin:' + token, '1', ADMIN_TOKEN_TTL);
  return { ok: true, token: token, ttl: ADMIN_TOKEN_TTL };
}

function checkAdmin_(token) {
  if (!token) return false;
  var cache = CacheService.getScriptCache();
  if (!cache.get('admin:' + token)) return false;
  cache.put('admin:' + token, '1', ADMIN_TOKEN_TTL);  // sliding expiry
  return true;
}

function adminInside_() {
  var people = {};
  readTab_(TABS.visitors).forEach(function (r) { people[r['Visitor ID']] = r; });
  var inside = readTab_(TABS.visits).filter(function (r) { return r['Visit ID'] && !r['Signed out']; })
    .map(function (r) {
      return {
        visitId: r['Visit ID'], first: r['First Name'], last: r['Last Name'], company: r['Company'],
        visiting: r['Visiting'], kind: r['Kind'], badge: r['Badge'], since: iso_(r['Signed in']),
        photoFolder: (people[r['Visitor ID']] || {})['Photo folder'] || ''
      };
    });
  return { ok: true, inside: inside };
}

function adminBadges_() {
  return {
    ok: true,
    badges: readTab_(TABS.badges).filter(function (r) { return r['Badge']; }).map(function (r) {
      return {
        badge: String(r['Badge']), tag: String(r['NFC tag'] || ''), status: r['Status'] || 'available',
        holder: r['Holder'] || '', since: iso_(r['Since'])
      };
    })
  };
}

function adminSignOut_(a) {
  var visit = findRow_(TABS.visits, 'Visit ID', a.visitId);
  if (!visit) return { ok: false, error: 'not_found' };
  if (!visit.values['Signed out']) signOutVisit_(visit, 'Admin');
  return { ok: true };
}

/** Adds a badge. With a tag, the tag is linked at once; without a number, the next V number is used. */
function adminAddBadge_(a) {
  var rows = readTab_(TABS.badges);
  var no = clean_(a.badge).replace(/[^A-Za-z0-9.\-]/g, '').slice(0, 20);
  if (!no) {
    var max = 0;
    rows.forEach(function (r) {
      var m = /^V(\d+)$/i.exec(String(r['Badge']));
      if (m) max = Math.max(max, Number(m[1]));
    });
    no = 'V' + (max + 1);
  }
  if (rows.some(function (r) { return lower_(r['Badge']) === no.toLowerCase(); })) {
    return { ok: false, error: 'badge_exists', badge: no };
  }
  var tag = normalizeTag_(a.tag), moved = '';
  if (tag) moved = unlinkTag_(tag);
  appendRow_(TABS.badges, { 'Badge': no, 'NFC tag': tag, 'Status': 'available' });
  return { ok: true, badge: no, movedFrom: moved };
}

function adminLinkTag_(a) {
  var badge = findRow_(TABS.badges, 'Badge', a.badge);
  if (!badge) return { ok: false, error: 'not_found' };
  var tag = normalizeTag_(a.tag);
  if (!tag) return { ok: false, error: 'tag' };
  var moved = unlinkTag_(tag);
  setCell_(TABS.badges, badge.row, 'NFC tag', tag);
  return { ok: true, movedFrom: moved === badge.values['Badge'] ? '' : moved };
}

function adminRetireBadge_(a, retire) {
  var badge = findRow_(TABS.badges, 'Badge', a.badge);
  if (!badge) return { ok: false, error: 'not_found' };
  if (retire && lower_(badge.values['Status']) === 'in use') return { ok: false, error: 'badge_in_use' };
  setCell_(TABS.badges, badge.row, 'Status', retire ? 'retired' : 'available');
  return { ok: true };
}

/** A tag lives on one badge only; returns the badge it was taken from. */
function unlinkTag_(tag) {
  var existing = badgeByTag_(tag);
  if (!existing) return '';
  setCell_(TABS.badges, existing.row, 'NFC tag', '');
  return String(existing.values['Badge']);
}

// ---------------------------------------------------------------- matching helpers (same rules as the kiosk)

/** Uppercase, strip accents, keep A-Z/0-9 as space-separated tokens, drop one-letter tokens. */
function nameKey_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(function (t) { return t.length > 1; }).join(' ');
}

var COMPANY_STOP = ['INC', 'LLC', 'LTD', 'CO', 'CORP', 'CORPORATION', 'COMPANY', 'THE', 'GROUP', 'LP', 'PLC', 'GMBH', 'AND', 'OF', 'NA'];

function companyWords_(s) {
  return nameKey_(s).split(' ').filter(function (w) { return w && COMPANY_STOP.indexOf(w) < 0; });
}

function sameCompany_(a, b) {
  if (!a.length && !b.length) return true;
  return a.some(function (x) {
    return x.length >= 3 && b.some(function (y) { return y.length >= 3 && near_(x, y); });
  });
}

/** Equal, or both at least 5 characters and one edit apart. */
function near_(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  var i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function normalizeTag_(s) {
  var t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Some readers send the number twice in one read.
  if (t.length >= 8 && t.length % 2 === 0 && t.slice(0, t.length / 2) === t.slice(t.length / 2)) {
    t = t.slice(0, t.length / 2);
  }
  return t;
}

function isUsPerson_(c) {
  return CITIZENSHIP_OPTIONS.slice(0, 3).indexOf(String(c)) >= 0;
}

function isDescriptor_(d) {
  return Array.isArray(d) && d.length === 128 && d.every(function (x) { return typeof x === 'number' && isFinite(x); });
}

function isPhoto_(s) {
  return typeof s === 'string' && s.length < MAX_PHOTO_CHARS &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(s);
}

function publicVisitor_(id, v) {
  return { id: id, first: v.first, last: v.last, company: v.company, quickEntry: v.quickEntry };
}

// ---------------------------------------------------------------- Drive

function photoRoot_() {
  var id = PropertiesService.getScriptProperties().getProperty('PHOTO_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var it = DriveApp.getFoldersByName('Shock Tech visitor photos');
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder('Shock Tech visitor photos');
  PropertiesService.getScriptProperties().setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

function savePhoto_(folder, dataUrl, label) {
  var m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
  var ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  var name = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HHmmss') + ' ' + label + '.' + ext;
  return folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[3]), m[1], name));
}

function folderFromUrl_(url) {
  var m = /folders\/([A-Za-z0-9_-]{10,})/.exec(String(url || ''));
  if (!m) return null;
  try { return DriveApp.getFolderById(m[1]); } catch (err) { return null; }
}

// ---------------------------------------------------------------- Sheets

function book_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  var sh = book_().getSheetByName(name);
  if (!sh) throw new Error('The "' + name + '" tab is missing. Run setup() in the Apps Script editor.');
  return sh;
}

function headerMap_(sh) {
  var head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  var map = {};
  head.forEach(function (h, i) { if (h) map[String(h).trim().toLowerCase()] = i + 1; });
  return map;
}

/** All data rows as objects keyed by header text. Columns are found by name, never position. */
function readTab_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var width = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, width).getValues()[0];
  return sh.getRange(2, 1, last - 1, width).getValues().map(function (row) {
    var o = {};
    head.forEach(function (h, i) { if (h) o[String(h).trim()] = row[i]; });
    // Also expose the canonical header spelling so lookups survive case changes.
    (HEADERS[name] || []).forEach(function (h) {
      if (!(h in o)) {
        var k = Object.keys(o).filter(function (x) { return x.toLowerCase() === h.toLowerCase(); })[0];
        if (k) o[h] = o[k];
      }
    });
    return o;
  });
}

function findRow_(name, column, value, normalize) {
  if (value === undefined || value === null || value === '') return null;
  var rows = readTab_(name);
  var want = normalize ? normalize(value) : String(value).toLowerCase();
  for (var i = rows.length - 1; i >= 0; i--) {
    var have = normalize ? normalize(rows[i][column]) : String(rows[i][column]).toLowerCase();
    if (have && have === want) return { row: i + 2, values: rows[i] };
  }
  return null;
}

function appendRow_(name, obj) {
  var sh = sheet_(name), map = headerMap_(sh);
  var width = sh.getLastColumn(), row = new Array(width);
  for (var c = 0; c < width; c++) row[c] = '';
  Object.keys(obj).forEach(function (k) {
    var col = map[k.toLowerCase()];
    if (col) row[col - 1] = cellValue_(obj[k]);
  });
  sh.appendRow(row);
}

function setCell_(name, row, column, value) {
  var o = {};
  o[column] = value;
  setCells_(name, row, o);
}

function setCells_(name, row, obj) {
  var sh = sheet_(name), map = headerMap_(sh);
  Object.keys(obj).forEach(function (k) {
    var col = map[k.toLowerCase()];
    if (col) sh.getRange(row, col).setValue(cellValue_(obj[k]));
  });
}

function addFaceRow_(visitorId, descriptor, source, fileId) {
  var rounded = descriptor.map(function (x) { return Math.round(x * 10000) / 10000; });
  appendRow_(TABS.faces, {
    'Visitor ID': visitorId, 'Descriptor': JSON.stringify(rounded),
    'Captured': new Date(), 'Source': source, 'Photo file ID': fileId
  });
}

function removeFaceRows_(visitorId) {
  var sh = sheet_(TABS.faces), rows = readTab_(TABS.faces);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i]['Visitor ID'] === visitorId) sh.deleteRow(i + 2);
  }
}

// ---------------------------------------------------------------- small utilities

/** Visitor text: trimmed, collapsed, length-capped. */
function clean_(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

/** Strings that start with = + - @ would run as formulas in the sheet. */
function cellValue_(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/^[=+\-@\s]+/, '');
}

function lower_(s) { return String(s === undefined || s === null ? '' : s).trim().toLowerCase(); }

function randomCode_(n) {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', out = '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Math.random());
  for (var i = 0; i < n; i++) out += chars[(bytes[i] + 256) % chars.length];
  return out;
}

function tz_() { return Session.getScriptTimeZone() || 'America/New_York'; }
function stamp_(d) { return Utilities.formatDate(d, tz_(), 'M/d/yyyy h:mm a'); }
function iso_(d) { return d instanceof Date ? d.toISOString() : (d ? String(d) : ''); }
function dateOnly_(d) { return d instanceof Date ? Utilities.formatDate(d, tz_(), 'MMM d, yyyy') : ''; }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy' };
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
