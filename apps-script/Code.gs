/**
 * Visitor sign-in kiosk: Google Apps Script backend.
 *
 * The kiosk (web/) is a static page on the tablet. It calls this script as a
 * JSON API (POST, text/plain body) because Apps Script's own page sandbox
 * blocks camera access. This script owns the Google Sheet and the Drive
 * photo folders; the kiosk never touches either directly.
 *
 * Connecting: deploy this script as a web app (Execute as: Me, Who has access:
 * Anyone) and paste its /exec URL into the kiosk's setup screen. The first
 * kiosk that connects becomes the owner: its key is saved as KIOSK_KEY, and
 * every later call must carry that key. Settings chosen on the kiosk (company
 * name, logo, questions…) are kept in the hidden "Settings" tab, so every
 * tablet connected to this sheet shares them.
 *
 * Script properties (Project Settings > Script properties), set automatically:
 *   KIOSK_KEY        shared secret the kiosk sends with every call
 *   ADMIN_PIN_HASH   hash of the admin PIN chosen on the kiosk. A plain ADMIN_PIN
 *                    (6 to 8 digits) set by hand works too.
 *   PHOTO_FOLDER_ID  parent Drive folder for visitor photos (created if missing)
 *   SPREADSHEET_ID   only needed when the script is NOT bound to the sheet
 */

var BACKEND_VERSION = 3;

var TABS = {
  visitors: 'Visitors',
  visits: 'Visits',
  badges: 'Badges',
  faces: 'Face data',
  settings: 'Settings'
};

var HEADERS = {
  Visitors: [
    'First Name', 'Last Name', 'Company', 'Who are you visiting?', 'Purpose of your visit',
    'Visitor acknowledgment', 'Quick entry', 'Screening', 'Registered', 'Last visit', 'Visit count',
    'Visitor ID', 'Photo folder'
  ],
  Visits: [
    'Signed in', 'First Name', 'Last Name', 'Company', 'Visiting', 'Purpose',
    'Kind', 'Badge', 'How they signed in', 'Signed out', 'Signed out by',
    'Screening', 'Reviewed', 'Photo', 'Host notified', 'Visitor ID', 'Visit ID'
  ],
  Badges: ['Badge', 'NFC tag', 'Status', 'Holder', 'Visitor ID', 'Visit ID', 'Since', 'Note'],
  'Face data': ['Visitor ID', 'Descriptor', 'Captured', 'Source', 'Photo file ID'],
  Settings: ['Setting', 'Value']
};

// Older sheets named this column after the company ("Who are you visiting at …?").
var HEADER_PATTERNS = { 'who are you visiting?': /^who are you visiting\b/ };

// Screening answers get their own Visitors column, placed just before this one,
// so the tab reads: names, then every answer, then the bookkeeping columns.
var ANSWERS_BEFORE = 'Visitor acknowledgment';

var ADMIN_TOKEN_TTL = 15 * 60;   // seconds
var PASS_TTL = 2 * 60 * 60;      // an admin's "let them in" lasts 2 hours
var ATTENTION_DAYS = 14;
var MAX_TEXT = 120;
var MAX_PHOTO_CHARS = 4 * 1024 * 1024;
var MAX_SETTINGS_CHARS = 45000;  // a sheet cell holds 50,000 characters

// ---------------------------------------------------------------- setup

/** Optional: run once by hand to create the tabs. Connecting a kiosk does the same. */
function setup() {
  setupTabs_();
  var props = PropertiesService.getScriptProperties();
  Logger.log('Setup done. Paste this web app\'s /exec URL into the kiosk to connect it.' +
    (props.getProperty('KIOSK_KEY') ? ' (A kiosk is already connected.)' : ''));
}

function setupTabs_() {
  var ss = book_();
  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      // Add any missing headers on the right; never reorder or clear data.
      HEADERS[name].forEach(function (h) {
        if (!findCol_(headerMap_(sh), h)) sh.getRange(1, sh.getLastColumn() + 1).setValue(h).setFontWeight('bold');
      });
    }
  });
  ss.getSheetByName(TABS.faces).hideSheet();
  ss.getSheetByName(TABS.settings).hideSheet();
  photoRoot_();
}

// ---------------------------------------------------------------- HTTP

function doGet() {
  return json_({ ok: true, service: 'visitor-sign-in-kiosk', version: BACKEND_VERSION });
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

// Calls that change the sheet. The kiosk retries these after a network hiccup
// with the same request id, so the first result is remembered and replayed.
var WRITE_ACTIONS = ['endOfDay', 'register', 'addFaceSample', 'setQuickEntry', 'assignBadge', 'checkIn', 'tapAtWelcome',
  'kioskSignOut', 'undoSignOut', 'recordDecline', 'adminSignOut', 'adminAddBadge', 'adminLinkTag',
  'adminRetireBadge', 'adminRestoreBadge', 'adminSetPin', 'adminSaveSettings', 'adminReview', 'adminAllow'];
var REPLAY_TTL = 30 * 60;  // seconds

/** Dispatches one API call. Separate from doPost so tests can call it directly. */
function handle_(req) {
  if (req && req.action === 'claim') return withLock_(function () { return claim_(req.key); });
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('KIOSK_KEY');
  if (!key) return { ok: false, error: 'not_connected' };
  if (req.key !== key) return { ok: false, error: 'kiosk_key' };

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
    case 'ping': return status_();
    case 'getSettings': return getSettings_();
    case 'faceIndex': return faceIndex_();
    case 'register': return withLock_(function () { return register_(a); });
    case 'recordDecline': return withLock_(function () { return recordDecline_(a); });
    case 'findVisitor': return findVisitor_(a);
    case 'findOpenVisits': return findOpenVisits_(a);
    case 'addFaceSample': return withLock_(function () { return addFaceSample_(a); });
    case 'setQuickEntry': return withLock_(function () { return setQuickEntry_(a); });
    case 'assignBadge': return withLock_(function () { return assignBadge_(a); });
    case 'checkIn': return withLock_(function () { return checkIn_(a); });
    case 'tapAtWelcome': return withLock_(function () { return tapAtWelcome_(a); });
    case 'kioskSignOut': return withLock_(function () { return kioskSignOut_(a); });
    case 'undoSignOut': return withLock_(function () { return undoSignOut_(a); });
    case 'endOfDay': return withLock_(function () { return endOfDay_(a); });
    case 'adminLogin': return adminLogin_(a);
    case 'adminSetPin': return withLock_(function () { return adminSetPin_(a); });
  }

  // Everything below needs an admin token.
  if (!checkAdmin_(a.token)) return { ok: false, error: 'admin' };
  switch (req.action) {
    case 'adminInside': return adminInside_();
    case 'adminBadges': return adminBadges_();
    case 'adminAttention': return adminAttention_();
    case 'adminHistory': return adminHistory_(a);
    case 'adminPhoto': return adminPhoto_(a);
    case 'adminSignOut': return withLock_(function () { return adminSignOut_(a); });
    case 'adminAddBadge': return withLock_(function () { return adminAddBadge_(a); });
    case 'adminLinkTag': return withLock_(function () { return adminLinkTag_(a); });
    case 'adminRetireBadge': return withLock_(function () { return adminRetireBadge_(a, true); });
    case 'adminRestoreBadge': return withLock_(function () { return adminRetireBadge_(a, false); });
    case 'adminSaveSettings': return withLock_(function () { return adminSaveSettings_(a); });
    case 'adminReview': return withLock_(function () { return adminReview_(a); });
    case 'adminAllow': return withLock_(function () { return adminAllow_(a); });
  }
  return { ok: false, error: 'unknown_action' };
}

// ---------------------------------------------------------------- connecting and settings

/** The first kiosk to connect claims the sheet with its key; the same key may reconnect. */
function claim_(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9-]{24,64}$/.test(key)) return { ok: false, error: 'bad_key' };
  var props = PropertiesService.getScriptProperties();
  var have = props.getProperty('KIOSK_KEY');
  if (have && have !== key) return { ok: false, error: 'claimed' };
  if (!have) props.setProperty('KIOSK_KEY', key);
  setupTabs_();
  var out = status_();
  out.claimed = !have;
  return out;
}

function status_() {
  var settings = readSettings_();
  var ss = book_();
  return {
    ok: true, version: BACKEND_VERSION,
    setupComplete: !!(settings && settings.setupComplete),
    hasPin: hasPin_(),
    sheetName: ss.getName ? ss.getName() : '',
    sheetUrl: ss.getUrl ? ss.getUrl() : '',
    attention: attentionRows_().length
  };
}

function getSettings_() {
  var settings = readSettings_();
  var logo = '';
  if (settings && settings.org && settings.org.logoFileId) logo = readLogo_(settings.org.logoFileId);
  return { ok: true, settings: settings, logo: logo };
}

/** Saves the kiosk's settings. args.logo: a data URL to replace the logo, '' to remove it, or absent to keep it. */
function adminSaveSettings_(a) {
  var s = a.settings;
  if (!s || typeof s !== 'object') return { ok: false, error: 'missing' };
  var old = readSettings_() || {};
  var oldLogo = old.org && old.org.logoFileId || '';
  s.org = s.org || {};
  delete s.org.logo;
  if (s.admin) delete s.admin.pinHash;
  if (a.logo === '' && oldLogo) { trashFile_(oldLogo); oldLogo = ''; }
  if (typeof a.logo === 'string' && a.logo) {
    if (!isPhoto_(a.logo)) return { ok: false, error: 'logo' };
    if (oldLogo) trashFile_(oldLogo);
    oldLogo = savePhoto_(photoRoot_(), a.logo, 'kiosk logo').getId();
  }
  s.org.logoFileId = oldLogo;
  var text = JSON.stringify(s);
  if (text.length > MAX_SETTINGS_CHARS) return { ok: false, error: 'too_big' };
  var row = findRow_(TABS.settings, 'Setting', 'kiosk');
  if (row) setCell_(TABS.settings, row.row, 'Value', text);
  else appendRow_(TABS.settings, { 'Setting': 'kiosk', 'Value': text });
  return { ok: true };
}

function readSettings_() {
  var sh = book_().getSheetByName(TABS.settings);
  if (!sh || sh.getLastRow() < 2) return null;
  var row = findRow_(TABS.settings, 'Setting', 'kiosk');
  if (!row) return null;
  try { return JSON.parse(row.values['Value']); } catch (err) { return null; }
}

function readLogo_(fileId) {
  try {
    var blob = DriveApp.getFileById(fileId).getBlob();
    return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
  } catch (err) {
    return '';
  }
}

function trashFile_(fileId) {
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (err) { /* already gone */ }
}

// ---------------------------------------------------------------- visitors

/**
 * A new visitor finished the sign-in questions. args:
 *   first, last, company, visiting, purpose, agreed, quickEntry, photo, descriptor
 *   answers   [{ label, value }]  one column each on the Visitors tab
 *   flags     [{ label, answer, flagLabel }]  answers that need staff attention
 *   override  { reason }  a staff member let them in after a decline
 */
function register_(a) {
  var s = readSettings_();
  var form = (s && s.form) || {};
  var v = {
    first: clean_(a.first), last: clean_(a.last), company: clean_(a.company) || 'N/A',
    visiting: clean_(a.visiting), purpose: clean_(a.purpose),
    agreed: a.agreed === true, quickEntry: a.quickEntry === true
  };
  var missing = ['first', 'last'].filter(function (k) { return !v[k]; });
  if (form.askHost !== false && !v.visiting) missing.push('visiting');
  if (form.askPurpose !== false && !v.purpose) missing.push('purpose');
  var rulesShown = !s || !Array.isArray(form.rules) || form.rules.length > 0;
  if (rulesShown && !v.agreed) missing.push('agreed');
  var photoRequired = !s || s.photos === 'all' || s.photos === undefined;
  if (a.photo ? !isPhoto_(a.photo) : photoRequired) missing.push('photo');
  if (missing.length) return { ok: false, error: 'missing', fields: missing };

  var answers = cleanAnswers_(a.answers);
  var flags = cleanFlags_(a.flags);
  var pass = takePass_(v.first, v.last);
  var screening = screeningText_(flags, a.override || pass);

  var id = 'P' + randomCode_(8);
  var folderUrl = '', fileId = '';
  if (a.photo) {
    var folder = photoRoot_().createFolder(v.last + ', ' + v.first + ' (' + v.company + ') ' + id);
    fileId = savePhoto_(folder, a.photo, 'signup').getId();
    folderUrl = folder.getUrl();
  }
  var now = new Date();
  var row = {
    'First Name': v.first, 'Last Name': v.last, 'Company': v.company,
    'Who are you visiting?': v.visiting, 'Purpose of your visit': v.purpose,
    'Visitor acknowledgment': v.agreed ? 'Agreed to the visitor rules on the kiosk (' + stamp_(now) + ')' : '',
    'Quick entry': v.quickEntry ? 'Yes' : 'No', 'Screening': screening,
    'Registered': now, 'Last visit': now, 'Visit count': 0,
    'Visitor ID': id, 'Photo folder': folderUrl
  };
  answers.forEach(function (ans) {
    ensureColumn_(TABS.visitors, ans.label, ANSWERS_BEFORE);
    row[ans.label] = ans.value;
  });
  appendRow_(TABS.visitors, row);

  if (v.quickEntry && fileId && isDescriptor_(a.descriptor)) {
    addFaceRow_(id, a.descriptor, 'signup', fileId);
  }
  if (flags.length && !a.override && !pass) alert_('flagged', v, flags, a.photo);
  return { ok: true, visitor: publicVisitor_(id, v, screening) };
}

/**
 * Screening declined someone. Nothing is signed in: the attempt is kept on the
 * Visits tab (with their photo) for staff, and the alert emails go out. If an
 * admin already let this person in (adminAllow), the pass is used instead.
 */
function recordDecline_(a) {
  var v = {
    first: clean_(a.first), last: clean_(a.last), company: clean_(a.company) || 'N/A',
    visiting: clean_(a.visiting), purpose: clean_(a.purpose)
  };
  if (!v.first || !v.last) return { ok: false, error: 'missing', fields: ['first', 'last'] };
  var pass = takePass_(v.first, v.last);
  if (pass) return { ok: true, passed: true, reason: pass.reason || '', by: pass.by || '' };

  var reasons = cleanFlags_(a.reasons);
  var photoUrl = '';
  if (isPhoto_(a.photo)) {
    photoUrl = savePhoto_(declinedFolder_(), a.photo, v.last + ', ' + v.first + ' (declined)').getUrl();
  }
  var now = new Date(), id = 'D' + randomCode_(8);
  appendRow_(TABS.visits, {
    'Signed in': now, 'First Name': v.first, 'Last Name': v.last, 'Company': v.company,
    'Visiting': v.visiting, 'Purpose': v.purpose, 'Kind': 'Declined', 'Badge': '',
    'How they signed in': clean_(a.method) || 'new visitor', 'Signed out': now, 'Signed out by': 'Declined at the kiosk',
    'Screening': 'Declined: ' + reasonList_(reasons), 'Photo': photoUrl,
    'Visitor ID': clean_(a.visitorId), 'Visit ID': id
  });
  alert_('declined', v, reasons, a.photo);
  return { ok: true, declineId: id };
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

/** Every opted-in visitor's face descriptors, for matching on the tablet. */
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
  var started = startVisit_(person, a, b['Badge'], 'Switched to badge ' + b['Badge']);
  var visitId = started.visitId;
  var p = person.values, now = new Date();
  setCells_(TABS.badges, badge.row, {
    'Status': 'in use', 'Holder': p['First Name'] + ' ' + p['Last Name'],
    'Visitor ID': a.visitorId, 'Visit ID': visitId, 'Since': now
  });
  return { ok: true, badge: b['Badge'], visitId: visitId, hostNotified: started.hostNotified };
}

/** Signs a visitor in without a badge (kiosks set up without visitor badges). */
function checkIn_(a) {
  var person = findRow_(TABS.visitors, 'Visitor ID', a.visitorId);
  if (!person) return { ok: false, error: 'not_found' };
  var started = startVisit_(person, a, '', 'Signed in again');
  return { ok: true, visitId: started.visitId, hostNotified: started.hostNotified };
}

/**
 * Creates the Visits row. One open visit per person: a new one replaces the old.
 * Returns { visitId, hostNotified } (the host's name when their arrival email went out).
 */
function startVisit_(person, a, badgeNo, replacedBy) {
  var open = openVisitFor_(a.visitorId);
  if (open) signOutVisit_(open, replacedBy);
  var p = person.values, now = new Date(), visitId = 'S' + randomCode_(8);
  var flags = cleanFlags_(a.flags);
  var screening = flags.length || a.override ? screeningText_(flags, a.override) : String(p['Screening'] || 'Clear');
  var visiting = clean_(a.visiting) || p['Who are you visiting?'];
  var host = notifyHost_(visiting, { first: p['First Name'], last: p['Last Name'], company: p['Company'], purpose: clean_(a.purpose) || p['Purpose of your visit'] }, badgeNo, now);
  if (host) ensureColumn_(TABS.visits, 'Host notified', 'Visitor ID');
  appendRow_(TABS.visits, {
    'Signed in': now, 'First Name': p['First Name'], 'Last Name': p['Last Name'],
    'Company': p['Company'],
    'Visiting': clean_(a.visiting) || p['Who are you visiting?'],
    'Purpose': clean_(a.purpose) || p['Purpose of your visit'],
    'Kind': kindOf_(screening), 'Badge': badgeNo,
    'How they signed in': (clean_(a.method) || 'kiosk') + (a.override ? ' (staff override)' : ''),
    'Screening': screening,
    'Host notified': host ? host + ' (' + stamp_(now) + ')' : '',
    'Visitor ID': a.visitorId, 'Visit ID': visitId
  });
  setCells_(TABS.visitors, person.row, {
    'Last visit': now, 'Visit count': (Number(p['Visit count']) || 0) + 1
  });
  if (flags.length && !a.override) alert_('flagged', { first: p['First Name'], last: p['Last Name'], company: p['Company'], visiting: visiting }, flags, '');
  return { visitId: visitId, hostNotified: host };
}

/**
 * Signs out everyone still signed in from before args.before (an ISO time; at
 * most now). Kiosks call it at the end-of-day time chosen in setup. Running it
 * twice, or from two tablets, does no harm.
 */
function endOfDay_(a) {
  var now = new Date(), cutoff = new Date(a.before);
  if (isNaN(cutoff.getTime()) || cutoff > now) cutoff = now;
  var rows = readTab_(TABS.visits), done = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r['Visit ID'] || r['Signed out']) continue;
    var t = new Date(r['Signed in']);
    if (isNaN(t.getTime()) || t >= cutoff) continue;
    signOutVisit_({ row: i + 2, values: r }, 'End of day');
    done++;
  }
  return { ok: true, signedOut: done };
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

/** Visitors who are signed in, by name (kiosks without badges sign out this way). */
function findOpenVisits_(a) {
  var first = nameKey_(a.first), last = nameKey_(a.last);
  if (!first || !last) return { ok: false, error: 'fullname' };
  var matches = readTab_(TABS.visits).filter(function (r) {
    return r['Visit ID'] && !r['Signed out'] &&
      near_(nameKey_(r['First Name']), first) && near_(nameKey_(r['Last Name']), last);
  }).slice(0, 5);
  return {
    ok: true,
    matches: matches.map(function (r) {
      return { visitId: r['Visit ID'], first: r['First Name'], last: r['Last Name'], company: r['Company'], since: iso_(r['Signed in']), badge: String(r['Badge'] || '') };
    })
  };
}

function kioskSignOut_(a) {
  var visit = findRow_(TABS.visits, 'Visit ID', a.visitId);
  if (!visit || visit.values['Signed out']) return { ok: false, error: 'not_found' };
  signOutVisit_(visit, 'Signed out at kiosk');
  return { ok: true, first: visit.values['First Name'], badge: String(visit.values['Badge'] || ''), visitId: a.visitId };
}

/** Puts a visitor back in after an accidental sign-out (kiosk Undo, within a minute). */
function undoSignOut_(a) {
  var visit = findRow_(TABS.visits, 'Visit ID', a.visitId);
  if (!visit) return { ok: false, error: 'not_found' };
  var out = visit.values['Signed out'];
  if (!out || (new Date() - new Date(out)) > 90 * 1000) return { ok: false, error: 'too_late' };
  if (!visit.values['Badge']) {
    setCells_(TABS.visits, visit.row, { 'Signed out': '', 'Signed out by': '' });
    return { ok: true };
  }
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
  if (!visit.values['Badge']) return;
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
  if (!pinMatches_(String(a.pin || ''))) {
    cache.put('pinfails', String(fails + 1), 600);
    Utilities.sleep(700);
    return { ok: false, error: hasPin_() ? 'pin' : 'no_pin' };
  }
  return { ok: true, token: newToken_(), ttl: ADMIN_TOKEN_TTL };
}

/** Sets the admin PIN. The first one can be set with the kiosk key alone; changing it needs an admin token. */
function adminSetPin_(a) {
  var pin = String(a.pin || '');
  if (!/^\d{6,8}$/.test(pin)) return { ok: false, error: 'pin_format' };
  if (hasPin_() && !checkAdmin_(a.token)) return { ok: false, error: 'admin' };
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ADMIN_PIN_HASH', pinHash_(pin));
  props.deleteProperty('ADMIN_PIN');
  return { ok: true, token: newToken_(), ttl: ADMIN_TOKEN_TTL };
}

function newToken_() {
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('admin:' + token, '1', ADMIN_TOKEN_TTL);
  return token;
}

function checkAdmin_(token) {
  if (!token) return false;
  var cache = CacheService.getScriptCache();
  if (!cache.get('admin:' + token)) return false;
  cache.put('admin:' + token, '1', ADMIN_TOKEN_TTL);  // sliding expiry
  return true;
}

function hasPin_() {
  var props = PropertiesService.getScriptProperties();
  return !!(props.getProperty('ADMIN_PIN_HASH') || props.getProperty('ADMIN_PIN'));
}

function pinMatches_(pin) {
  var props = PropertiesService.getScriptProperties();
  var hash = props.getProperty('ADMIN_PIN_HASH');
  if (hash) return pinHash_(pin) === hash;
  var plain = props.getProperty('ADMIN_PIN');
  return !!plain && pin === plain;
}

function pinHash_(pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'visitor-kiosk-pin:' + pin);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function adminName_() {
  var s = readSettings_();
  return (s && s.admin && clean_(s.admin.name)) || 'Admin';
}

function adminInside_() {
  var people = {};
  readTab_(TABS.visitors).forEach(function (r) { people[r['Visitor ID']] = r; });
  var inside = readTab_(TABS.visits).filter(function (r) { return r['Visit ID'] && !r['Signed out']; })
    .map(function (r) {
      return {
        visitId: r['Visit ID'], first: r['First Name'], last: r['Last Name'], company: r['Company'],
        visiting: r['Visiting'], kind: r['Kind'], badge: String(r['Badge'] || ''), since: iso_(r['Signed in']),
        screening: String(r['Screening'] || ''),
        photoFolder: (people[r['Visitor ID']] || {})['Photo folder'] || ''
      };
    });
  return { ok: true, inside: inside };
}

/** Recent declines and flagged visits that nobody has reviewed yet. */
function attentionRows_() {
  var sh = book_().getSheetByName(TABS.visits);
  if (!sh || sh.getLastRow() < 2) return [];
  var since = new Date().getTime() - ATTENTION_DAYS * 86400000;
  return readTab_(TABS.visits).filter(function (r) {
    if (!r['Visit ID'] || lower_(r['Reviewed'])) return false;
    if (!/^(declined|flagged)/i.test(String(r['Screening'] || ''))) return false;
    var t = new Date(r['Signed in']).getTime();
    return !isNaN(t) && t >= since;
  });
}

function adminAttention_() {
  var items = attentionRows_().map(function (r) {
    var declined = /^declined/i.test(String(r['Screening']));
    return {
      visitId: r['Visit ID'], first: r['First Name'], last: r['Last Name'], company: r['Company'],
      visiting: r['Visiting'], purpose: r['Purpose'], when: iso_(r['Signed in']),
      kind: declined ? 'declined' : 'flagged', label: declined ? 'Declined' : String(r['Kind'] || 'Flagged'),
      screening: String(r['Screening'] || ''), photo: String(r['Photo'] || ''),
      inside: !r['Signed out'], allowed: / allowed by /i.test(String(r['Screening']))
    };
  }).reverse().slice(0, 50);
  return { ok: true, items: items };
}

/** Visits from the last args.days days (default 30), newest first, optionally filtered by args.q. */
function adminHistory_(a) {
  var days = Math.max(1, Math.min(3650, Number(a.days) || 30));
  var since = new Date().getTime() - days * 86400000;
  var q = nameKey_(a.q);
  var out = [];
  var rows = readTab_(TABS.visits);
  for (var i = rows.length - 1; i >= 0 && out.length < 2000; i--) {
    var r = rows[i];
    if (!r['Visit ID']) continue;
    var t = new Date(r['Signed in']).getTime();
    if (isNaN(t) || t < since) continue;
    if (q && nameKey_([r['First Name'], r['Last Name'], r['Company'], r['Visiting']].join(' ')).indexOf(q) < 0) continue;
    out.push({
      visitId: r['Visit ID'], signedIn: iso_(r['Signed in']), signedOut: iso_(r['Signed out']),
      first: r['First Name'], last: r['Last Name'], company: r['Company'], visiting: r['Visiting'],
      purpose: r['Purpose'], kind: r['Kind'], badge: String(r['Badge'] || ''),
      method: r['How they signed in'], signedOutBy: r['Signed out by'], screening: String(r['Screening'] || ''),
      hostNotified: String(r['Host notified'] || '')
    });
  }
  return { ok: true, visits: out, sheetUrl: book_().getUrl() };
}

/** One visit's photo as a data URL: the declined visitor's photo, or the visitor's latest photo. */
function adminPhoto_(a) {
  var visit = findRow_(TABS.visits, 'Visit ID', a.visitId);
  if (!visit) return { ok: false, error: 'not_found' };
  var file = null;
  try {
    var id = driveId_(visit.values['Photo']);
    if (id) file = DriveApp.getFileById(id);
    if (!file) {
      var person = findRow_(TABS.visitors, 'Visitor ID', visit.values['Visitor ID']);
      var folderId = person && driveId_(person.values['Photo folder']);
      if (folderId) {
        var it = DriveApp.getFolderById(folderId).getFiles(), newest = 0;
        while (it.hasNext()) {
          var f = it.next(), when = f.getDateCreated ? f.getDateCreated().getTime() : 0;
          if (!file || when >= newest) { file = f; newest = when; }
        }
      }
    }
  } catch (err) {
    file = null;
  }
  if (!file) return { ok: true, photo: '' };
  var blob = file.getBlob();
  return { ok: true, photo: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

/** The file or folder id in a Drive link. */
function driveId_(url) {
  var m = /\/(?:d|folders)\/([\w-]{10,})/.exec(String(url || '')) || /[?&]id=([\w-]{10,})/.exec(String(url || ''));
  return m ? m[1] : '';
}

function adminReview_(a) {
  var visit = findRow_(TABS.visits, 'Visit ID', a.visitId);
  if (!visit) return { ok: false, error: 'not_found' };
  setCell_(TABS.visits, visit.row, 'Reviewed', 'Reviewed by ' + adminName_() + ' (' + stamp_(new Date()) + ')');
  return { ok: true };
}

/** Lets a declined visitor in: they can sign in normally for the next 2 hours. */
function adminAllow_(a) {
  var visit = findRow_(TABS.visits, 'Visit ID', a.visitId);
  if (!visit || !/^declined/i.test(String(visit.values['Screening']))) return { ok: false, error: 'not_found' };
  var by = adminName_(), reason = clean_(a.reason);
  setPass_(visit.values['First Name'], visit.values['Last Name'], { by: by, reason: reason });
  setCells_(TABS.visits, visit.row, {
    'Screening': String(visit.values['Screening']) + '. Allowed by ' + by + (reason ? ': ' + reason : ''),
    'Reviewed': 'Reviewed by ' + by + ' (' + stamp_(new Date()) + ')'
  });
  return { ok: true, by: by };
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

// ---------------------------------------------------------------- screening helpers

function cleanAnswers_(list) {
  if (!Array.isArray(list)) return [];
  var reserved = {};
  HEADERS.Visitors.forEach(function (h) { reserved[h.toLowerCase()] = true; });
  return list.slice(0, 30).map(function (x) {
    var label = clean_(x && x.label).slice(0, 60);
    if (reserved[label.toLowerCase()]) label = 'Answer: ' + label;
    return { label: label, value: clean_(x && x.value) };
  }).filter(function (x) { return x.label; });
}

function cleanFlags_(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map(function (x) {
    return { label: clean_(x && x.label).slice(0, 60), answer: clean_(x && x.answer), flagLabel: clean_(x && x.flagLabel).slice(0, 40) };
  }).filter(function (x) { return x.label; });
}

function reasonList_(flags) {
  return flags.map(function (f) { return f.label + ' = ' + f.answer; }).join('; ') || 'screening answer';
}

/** The Screening column: Clear, Flagged: <labels>, or Overridden by <admin>: <reason>. */
function screeningText_(flags, override) {
  if (override) {
    var by = clean_(override.by) || adminName_();
    var reason = clean_(override.reason);
    return 'Overridden by ' + by + (reason ? ': ' + reason : '');
  }
  if (flags.length) {
    var labels = [];
    flags.forEach(function (f) { var l = f.flagLabel || f.label; if (labels.indexOf(l) < 0) labels.push(l); });
    return 'Flagged: ' + labels.join(', ');
  }
  return 'Clear';
}

/** Visit "Kind": Visitor, the first flag label (e.g. Foreign national), or Visitor (override). */
function kindOf_(screening) {
  var s = String(screening || '');
  var m = /^Flagged: ([^,]+)/.exec(s);
  if (m) return m[1];
  if (/^Overridden/.test(s)) return 'Visitor (override)';
  return 'Visitor';
}

function passKey_(first, last) { return 'pass:' + nameKey_(first) + '|' + nameKey_(last); }

function setPass_(first, last, pass) {
  CacheService.getScriptCache().put(passKey_(first, last), JSON.stringify(pass), PASS_TTL);
}

function takePass_(first, last) {
  var cache = CacheService.getScriptCache(), key = passKey_(first, last);
  var raw = cache.get(key);
  if (!raw) return null;
  cache.remove(key);
  try { return JSON.parse(raw); } catch (err) { return null; }
}

/** Emails the alert addresses from the kiosk settings (with the photo attached). */
function alert_(kind, v, flags, photo) {
  var s = readSettings_() || {};
  var to = String((s.screening && s.screening.alertEmails) || '').split(/[\s,;]+/).filter(function (e) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  }).slice(0, 10);
  if (!to.length) return false;
  var org = (s.org && clean_(s.org.name)) || 'The';
  var declined = kind === 'declined';
  var name = v.first + ' ' + v.last;
  var lines = [
    declined ? name + ' was politely declined at the ' + org + ' visitor kiosk because of their screening answers.'
      : name + ' signed in at the ' + org + ' visitor kiosk with an answer that needs your attention.',
    '',
    'Company: ' + (v.company || 'N/A')
  ];
  if (v.visiting) lines.push('Visiting: ' + v.visiting);
  lines.push('Time: ' + stamp_(new Date()));
  lines.push('');
  lines.push(declined ? 'Why they were declined:' : 'Answers to check:');
  flags.forEach(function (f) { lines.push('  - ' + f.label + ': ' + f.answer); });
  if (declined) {
    lines.push('');
    lines.push('To let them in: tap "Staff override" on the kiosk, or open the admin screen and choose "Let in".');
  }
  lines.push('');
  lines.push('Visitor log: ' + book_().getUrl());
  var options = {
    to: to.join(','), name: org + ' visitor kiosk',
    subject: (declined ? 'Visitor declined: ' : 'Visitor alert: ') + name,
    body: lines.join('\n')
  };
  var m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(String(photo || ''));
  if (m) options.attachments = [Utilities.newBlob(Utilities.base64Decode(m[3]), m[1], 'visitor-photo.' + (m[2] === 'jpeg' ? 'jpg' : m[2]))];
  try {
    MailApp.sendEmail(options);
    return true;
  } catch (err) {
    console.warn('Alert email not sent: ' + err);
    return false;
  }
}

/**
 * Emails the person a visitor came to see, when the kiosk settings list them
 * with an email address and host emails are turned on. Returns the host's name, or ''.
 */
function notifyHost_(visiting, v, badgeNo, when) {
  var s = readSettings_() || {};
  if (!s.notifyHosts || !Array.isArray(s.hosts)) return '';
  var host = matchHost_(s.hosts, visiting);
  if (!host) return '';
  var org = (s.org && clean_(s.org.name)) || 'the';
  var name = v.first + ' ' + v.last;
  var lines = [
    'Hi ' + host.name.split(' ')[0] + ',',
    '',
    name + (v.company && v.company !== 'N/A' ? ' from ' + v.company : '') + ' just signed in at the ' + org + ' front desk to see you.',
    ''
  ];
  if (v.purpose) lines.push('Purpose: ' + v.purpose);
  if (badgeNo) lines.push('Visitor badge: ' + badgeNo);
  lines.push('Time: ' + stamp_(when));
  lines.push('');
  lines.push('Please come and meet them at the front desk.');
  try {
    MailApp.sendEmail({ to: host.email, name: org + ' visitor kiosk', subject: 'Your visitor has arrived: ' + name, body: lines.join('\n') });
    return host.name;
  } catch (err) {
    console.warn('Host email not sent: ' + err);
    return '';
  }
}

/** The host whose name matches what the visitor typed (same name rules as visitor search). */
function matchHost_(hosts, visiting) {
  var want = nameKey_(visiting);
  if (!want) return null;
  var best = null;
  hosts.forEach(function (h) {
    if (best || !h || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(h.email || ''))) return;
    var key = nameKey_(h.name);
    if (key && (key === want || near_(key, want))) best = { name: clean_(h.name), email: String(h.email).trim() };
  });
  return best;
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

function isDescriptor_(d) {
  return Array.isArray(d) && d.length === 128 && d.every(function (x) { return typeof x === 'number' && isFinite(x); });
}

function isPhoto_(s) {
  return typeof s === 'string' && s.length < MAX_PHOTO_CHARS &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(s);
}

function publicVisitor_(id, v, screening) {
  return { id: id, first: v.first, last: v.last, company: v.company, quickEntry: v.quickEntry, kind: kindOf_(screening) };
}

// ---------------------------------------------------------------- Drive

function photoRoot_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* folder deleted: make a new one */ }
  }
  var s = readSettings_();
  var name = (s && s.org && clean_(s.org.name) ? clean_(s.org.name) + ' visitor photos' : 'Visitor photos');
  var it = DriveApp.getFoldersByName(name);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

function declinedFolder_() {
  var root = photoRoot_();
  var it = root.getFoldersByName('Declined visitors');
  return it.hasNext() ? it.next() : root.createFolder('Declined visitors');
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
  if (!sh) throw new Error('The "' + name + '" tab is missing. Connect the kiosk again, or run setup() in the Apps Script editor.');
  return sh;
}

function headerMap_(sh) {
  var head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  var map = {};
  head.forEach(function (h, i) { if (h) map[String(h).trim().toLowerCase()] = i + 1; });
  return map;
}

/** Column number for a header, by name (case-insensitive), or one of its older spellings. */
function findCol_(map, header) {
  var key = String(header).toLowerCase();
  if (map[key]) return map[key];
  var pattern = HEADER_PATTERNS[key];
  if (!pattern) return 0;
  var hit = Object.keys(map).filter(function (k) { return pattern.test(k); })[0];
  return hit ? map[hit] : 0;
}

/** Adds a header if the tab doesn't have it yet, before `beforeHeader` when given. */
function ensureColumn_(name, header, beforeHeader) {
  var sh = sheet_(name), map = headerMap_(sh);
  if (findCol_(map, header)) return;
  var before = beforeHeader ? findCol_(map, beforeHeader) : 0;
  if (before) {
    sh.insertColumnBefore(before);
    sh.getRange(1, before).setValue(header).setFontWeight('bold');
  } else {
    sh.getRange(1, sh.getLastColumn() + 1).setValue(header).setFontWeight('bold');
  }
}

/** All data rows as objects keyed by header text. Columns are found by name, never position. */
function readTab_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var width = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, width).getValues()[0];
  var map = {};
  head.forEach(function (h, i) { if (h) map[String(h).trim().toLowerCase()] = i + 1; });
  return sh.getRange(2, 1, last - 1, width).getValues().map(function (row) {
    var o = {};
    head.forEach(function (h, i) { if (h) o[String(h).trim()] = row[i]; });
    // Also expose the canonical header spelling so lookups survive case changes and older names.
    (HEADERS[name] || []).forEach(function (h) {
      if (!(h in o)) {
        var col = findCol_(map, h);
        if (col) o[h] = row[col - 1];
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
    var col = findCol_(map, k);
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
    var col = findCol_(map, k);
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

/** Visitor text: trimmed, collapsed, length-capped, and never starting like a formula. */
function clean_(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim()
    .replace(/^[=+\-@\s]+/, '').slice(0, MAX_TEXT);
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
