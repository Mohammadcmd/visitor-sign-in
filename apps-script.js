/* Google Sheets connector for Visitor Sign In.
 *
 * This file only stores the connector's source code as a string. The setup screen fills in
 * the kiosk key and lets you copy or download it. The code runs in YOUR Google account
 * (Extensions > Apps Script inside your spreadsheet), never on this kiosk.
 *
 * Keep the source free of backticks and dollar-brace sequences: it lives inside a template literal.
 */
window.VSI_CONNECTOR_VERSION = 1;
window.VSI_CONNECTOR_SOURCE = String.raw`/**
 * Visitor Sign In: Google Sheets connector (version 1)
 *
 * Connects your visitor sign-in kiosk(s) to this spreadsheet. It creates two tabs:
 *   People : staff and card holders (Name, Card ID, Company, Role, Email, Admin)
 *   Visits : every sign-in, sign-out, decline and override, written by the kiosk
 *
 * INSTALL
 *   1. In this spreadsheet open Extensions > Apps Script, replace any code with this file, click Save.
 *   2. Deploy > New deployment > Select type (gear icon) > Web app.
 *        Execute as: Me        Who has access: Anyone
 *   3. Authorize when asked, then paste the Web app URL (ending in /exec) into the kiosk.
 *
 * UPDATING THIS CODE LATER
 *   Use Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy,
 *   so the Web app URL stays the same.
 *
 * PRIVACY
 *   The kiosk can only use this script with the private key below. Visitor data is stored in
 *   this spreadsheet only. Emails are sent from your account to the hosts and staff you list.
 *
 * @OnlyCurrentDoc
 */

var KIOSK_KEY = '%%KIOSK_KEY%%';
var CONNECTOR_VERSION = 1;
var PEOPLE_TAB = 'People';
var VISITS_TAB = 'Visits';
var PEOPLE_HEADERS = ['Name', 'Card ID', 'Company', 'Role', 'Email', 'Admin'];
var VISIT_COLUMNS = [
  ['id', 'Visit ID'], ['status', 'Status'], ['name', 'Name'], ['company', 'Company'], ['host', 'Visiting'],
  ['purpose', 'Reason'], ['email', 'Email'], ['phone', 'Phone'], ['vehicle', 'Vehicle'], ['notes', 'Notes'],
  ['role', 'Role'], ['cardId', 'Card ID'], ['method', 'Method'], ['kiosk', 'Kiosk'], ['inAt', 'Signed in'],
  ['outAt', 'Signed out'], ['autoOut', 'Auto signed out'], ['answers', 'Answers'], ['flags', 'Flags'],
  ['override', 'Override'], ['agreed', 'Agreed'], ['signature', 'Signature'], ['photo', 'Photo']
];
var TEXT_FIELDS = ['id', 'name', 'company', 'host', 'purpose', 'email', 'phone', 'vehicle', 'notes', 'role', 'cardId'];
var CARD_HEADER = /card|rfid|nfc|badge|fob|tag\s*id|uid/i;
var RECENT_MS = 6 * 60 * 60 * 1000; // only email about visits from the last 6 hours
var CELL_LIMIT = 49000;              // Google Sheets allows 50,000 characters per cell

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.action) {
    return ContentService.createTextOutput('Visitor Sign In connector v' + CONNECTOR_VERSION +
      ' is running. Paste this page address into the kiosk setup screen.');
  }
  return json_(handle_(p));
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 'bad_json', error: 'The request was not valid JSON.' });
  }
  return json_(handle_(req));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  if (/^%%/.test(KIOSK_KEY)) {
    return { ok: false, code: 'not_configured', error: 'This script has no kiosk key yet. Copy it again from the kiosk setup screen.' };
  }
  if (!req || String(req.key || '') !== KIOSK_KEY) {
    return { ok: false, code: 'bad_key', error: 'The kiosk key does not match this script. Check the key in the kiosk settings, or copy the script again and redeploy it.' };
  }
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    return { ok: false, code: 'busy', error: 'The spreadsheet is busy right now. The kiosk will try again shortly.' };
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    ensureTabs_(ss);
    if (req.action === 'ping') {
      return {
        ok: true, version: CONNECTOR_VERSION, sheetName: ss.getName(), sheetUrl: ss.getUrl(),
        people: publicPeople_(readPeople_(ss))
      };
    }
    if (req.action === 'sync') return sync_(ss, req);
    if (req.action === 'addPerson') return addPerson_(ss, req);
    return { ok: false, code: 'bad_action', error: 'Unknown action: ' + req.action };
  } catch (err) {
    return { ok: false, code: 'script_error', error: 'Script error: ' + (err && err.message ? err.message : String(err)) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Tabs and columns ---------- */

function ensureTabs_(ss) {
  var people = ss.getSheetByName(PEOPLE_TAB);
  if (!people) {
    var sheets = ss.getSheets();
    // A brand-new spreadsheet has one empty tab: reuse it rather than leave it blank.
    if (sheets.length === 1 && sheets[0].getLastRow() === 0 && sheets[0].getName() !== VISITS_TAB) {
      people = sheets[0];
      people.setName(PEOPLE_TAB);
    } else {
      people = ss.insertSheet(PEOPLE_TAB);
    }
    people.getRange(1, 1, 1, PEOPLE_HEADERS.length).setValues([PEOPLE_HEADERS]).setFontWeight('bold');
    people.setFrozenRows(1);
  }
  if (!ss.getSheetByName(VISITS_TAB)) {
    var visits = ss.insertSheet(VISITS_TAB);
    var headers = VISIT_COLUMNS.map(function (c) { return c[1]; });
    visits.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    visits.setFrozenRows(1);
  }
}

function headerRow_(sheet) {
  var width = sheet.getLastColumn();
  if (width < 1) return [];
  return sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
}

/** Map each visit field to its column, adding any missing column headers at the end. */
function visitColumns_(sheet) {
  var header = headerRow_(sheet);
  var map = {};
  VISIT_COLUMNS.forEach(function (c) {
    var i = header.indexOf(c[1]);
    if (i === -1) {
      header.push(c[1]);
      i = header.length - 1;
      sheet.getRange(1, i + 1).setValue(c[1]).setFontWeight('bold');
    }
    map[c[0]] = i;
  });
  return { map: map, width: header.length };
}

/* ---------- Sync: apply the kiosk's queued changes, return the latest data ---------- */

function sync_(ss, req) {
  var sheet = ss.getSheetByName(VISITS_TAB);
  var cols = visitColumns_(sheet);
  var m = cols.map;
  var lastRow = sheet.getLastRow();
  var rowById = {};
  if (lastRow > 1) {
    var ids = sheet.getRange(2, m.id + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var existing = String(ids[i][0] || '');
      if (existing) rowById[existing] = i + 2;
    }
  }
  var people = readPeople_(ss);
  var ops = Array.isArray(req.ops) ? req.ops.slice(0, 100) : [];
  var pending = {};
  var newRows = [];
  var applied = [];
  var emailed = 0;

  ops.forEach(function (op) {
    if (!op || !op.opId) return;
    if (op.type === 'signin' && op.visit && op.visit.id) {
      var v = op.visit;
      var vid = String(v.id);
      if (!rowById[vid] && !pending[vid]) {
        var row = visitRow_(v, cols, req.kiosk);
        pending[vid] = row;
        newRows.push(row);
        var recent = Date.now() - Number(v.inAt || 0) < RECENT_MS;
        if (recent && (v.status === 'declined' || (Array.isArray(v.reasons) && v.reasons.length))) {
          if (alertStaff_(v, req, ss)) emailed++;
        }
        if (recent && req.notifyHosts && v.status !== 'declined' && !v.outAt) {
          if (notifyHost_(v, people, ss, req.kiosk)) emailed++;
        }
      }
    } else if (op.type === 'signout' && op.id) {
      var when = toDate_(op.outAt);
      if (when) {
        setIfEmpty_(sheet, pending, rowById, String(op.id), m.outAt, when);
        if (op.auto) setCell_(sheet, pending, rowById, String(op.id), m.autoOut, 'Yes');
      }
    } else if (op.type === 'override' && op.id) {
      var note = 'By ' + String(op.by || 'Admin') + ' at ' + formatTime_(op.at) + (op.reason ? ': ' + String(op.reason) : '');
      setCell_(sheet, pending, rowById, String(op.id), m.status, 'Overridden');
      setCell_(sheet, pending, rowById, String(op.id), m.override, text_(note));
    }
    applied.push(String(op.opId));
  });

  if (newRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, cols.width).setValues(newRows);
  }
  var days = Math.min(Math.max(Number(req.days) || 30, 1), 365);
  return {
    ok: true, version: CONNECTOR_VERSION, applied: applied, emailed: emailed,
    people: publicPeople_(people),
    visits: readVisits_(sheet, cols, Date.now() - days * 86400000),
    sheetName: ss.getName(), sheetUrl: ss.getUrl(), serverTime: Date.now()
  };
}

function setCell_(sheet, pending, rowById, id, col, value) {
  if (pending[id]) pending[id][col] = value;
  else if (rowById[id]) sheet.getRange(rowById[id], col + 1).setValue(value);
}

function setIfEmpty_(sheet, pending, rowById, id, col, value) {
  if (pending[id]) {
    if (pending[id][col] === '') pending[id][col] = value;
  } else if (rowById[id]) {
    var cell = sheet.getRange(rowById[id], col + 1);
    var current = cell.getValue();
    if (current === '' || current === null) cell.setValue(value);
  }
}

function visitRow_(v, cols, kiosk) {
  var row = [];
  for (var i = 0; i < cols.width; i++) row.push('');
  function set(key, value) { if (cols.map[key] != null) row[cols.map[key]] = value; }
  TEXT_FIELDS.forEach(function (k) { set(k, text_(v[k])); });
  set('status', v.status === 'declined' ? 'Declined' : v.status === 'overridden' ? 'Overridden' : 'Allowed');
  set('method', v.method === 'card' ? 'Card' : 'Screen');
  set('kiosk', text_(v.kiosk || kiosk));
  set('inAt', toDate_(v.inAt) || new Date());
  set('outAt', toDate_(v.outAt) || '');
  set('autoOut', v.autoOut ? 'Yes' : '');
  set('answers', text_((Array.isArray(v.answers) ? v.answers : []).map(function (a) {
    return String(a.q) + ' → ' + String(a.a);
  }).join(' | '), 5000));
  set('flags', text_((Array.isArray(v.reasons) ? v.reasons : []).map(function (r) {
    return (r.action === 'decline' ? 'Declined: ' : 'Alert: ') + String(r.q) + ' → ' + String(r.a);
  }).join(' | '), 5000));
  if (v.override) {
    set('override', text_('By ' + String(v.override.by || 'Admin') + ' at ' + formatTime_(v.override.at) +
      (v.override.reason ? ': ' + String(v.override.reason) : '')));
  }
  set('agreed', v.agreed === true ? 'Yes' : v.agreed === false ? 'No' : '');
  set('signature', image_(v.signature));
  set('photo', image_(v.photo));
  return row;
}

function readVisits_(sheet, cols, since) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, cols.width).getValues();
  var m = cols.map;
  var out = [];
  for (var i = values.length - 1; i >= 0 && out.length < 3000; i--) {
    var r = values[i];
    var id = String(r[m.id] || '');
    if (!id) continue;
    var inAt = toMs_(r[m.inAt]);
    var outAt = toMs_(r[m.outAt]);
    if (!inAt || (inAt < since && (outAt || String(r[m.status]) === 'Declined'))) continue;
    var v = { id: id, inAt: inAt, outAt: outAt || null };
    TEXT_FIELDS.forEach(function (k) {
      if (k !== 'id' && r[m[k]] !== '' && r[m[k]] != null) v[k] = String(r[m[k]]);
    });
    var status = String(r[m.status] || '').toLowerCase();
    if (status === 'declined' || status === 'overridden') v.status = status;
    v.method = String(r[m.method]).toLowerCase() === 'card' ? 'card' : 'screen';
    if (r[m.kiosk]) v.kiosk = String(r[m.kiosk]);
    if (r[m.autoOut]) v.autoOut = true;
    if (r[m.answers]) v.answersText = String(r[m.answers]);
    if (r[m.flags]) v.flagsText = String(r[m.flags]);
    if (r[m.override]) v.overrideText = String(r[m.override]);
    var agreed = String(r[m.agreed] || '').toLowerCase();
    if (agreed) v.agreed = agreed === 'yes';
    if (r[m.signature]) v.signed = true;
    if (r[m.photo]) v.hasPhoto = true;
    out.push(v);
  }
  return out;
}

/* ---------- People ---------- */

function readPeople_(ss) {
  var sheet = ss.getSheetByName(PEOPLE_TAB);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var header = values[0].map(function (h) { return String(h).trim(); });
  function find(re) {
    for (var i = 0; i < header.length; i++) if (re.test(header[i])) return i;
    return -1;
  }
  var ix = {
    name: find(/^(full\s*)?name$/i), card: find(CARD_HEADER),
    company: find(/company|organi[sz]ation|business|employer/i),
    role: find(/role|type|department|dept|title|position/i),
    email: find(/e-?mail/i), admin: find(/^(is\s*)?admin/i)
  };
  if (ix.name === -1) ix.name = 0;
  var people = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var cell = function (i) { return i === -1 || row[i] == null ? '' : String(row[i]).trim(); };
    var name = cell(ix.name);
    if (!name) continue;
    people.push({
      name: name, cardId: cell(ix.card), company: cell(ix.company), role: cell(ix.role),
      email: cell(ix.email), isAdmin: /^(y|yes|true|1|x|admin)$/i.test(cell(ix.admin))
    });
  }
  return people;
}

/** Email addresses stay in the spreadsheet: the kiosk only learns whether someone can be emailed. */
function publicPeople_(people) {
  return people.map(function (p) {
    return { name: p.name, cardId: p.cardId, company: p.company, role: p.role, isAdmin: p.isAdmin, hasEmail: !!p.email };
  });
}

function addPerson_(ss, req) {
  var p = req.person || {};
  var name = String(p.name || '').trim();
  var card = String(p.cardId || '').trim();
  if (!name) return { ok: false, code: 'bad_person', error: 'A name is required.' };
  if (card) {
    var everyone = readPeople_(ss);
    for (var i = 0; i < everyone.length; i++) {
      if (everyone[i].cardId && normCard_(everyone[i].cardId) === normCard_(card)) {
        return { ok: false, code: 'exists', error: 'That card already belongs to ' + everyone[i].name + ' on the People tab.' };
      }
    }
  }
  var sheet = ss.getSheetByName(PEOPLE_TAB);
  var header = headerRow_(sheet);
  function col(label, re) {
    for (var j = 0; j < header.length; j++) if (re.test(header[j])) return j;
    header.push(label);
    sheet.getRange(1, header.length).setValue(label).setFontWeight('bold');
    return header.length - 1;
  }
  var ix = {
    name: col('Name', /^(full\s*)?name$/i), card: col('Card ID', CARD_HEADER),
    company: col('Company', /company|organi[sz]ation|business|employer/i),
    role: col('Role', /role|type|department|dept|title|position/i), admin: col('Admin', /^(is\s*)?admin/i)
  };
  var row = [];
  for (var k = 0; k < header.length; k++) row.push('');
  row[ix.name] = text_(name);
  row[ix.card] = text_(card);
  row[ix.company] = text_(p.company);
  row[ix.role] = text_(p.role);
  row[ix.admin] = p.isAdmin ? 'Yes' : '';
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, header.length).setValues([row]);
  return { ok: true, people: publicPeople_(readPeople_(ss)) };
}

/* ---------- Email ---------- */

function notifyHost_(v, people, ss, kiosk) {
  var hostName = String(v.host || '').trim().toLowerCase();
  if (!hostName) return false;
  var host = null;
  for (var i = 0; i < people.length; i++) {
    if (people[i].email && people[i].name.toLowerCase() === hostName) { host = people[i]; break; }
  }
  if (!host) return false;
  var who = String(v.name || 'A visitor');
  var lines = [who + (v.company ? ' from ' + v.company : '') + ' has arrived to see you.', ''];
  if (v.purpose) lines.push('Reason: ' + v.purpose);
  if (v.phone) lines.push('Phone: ' + v.phone);
  lines.push('Signed in at: ' + (v.kiosk || kiosk || 'Reception') + ', ' + formatTime_(v.inAt));
  try {
    MailApp.sendEmail({
      to: host.email,
      subject: 'Your visitor has arrived: ' + who,
      body: lines.join('\n') + '\n\nSent by the ' + ss.getName() + ' visitor sign-in kiosk.',
      name: 'Visitor Sign In'
    });
    return true;
  } catch (err) {
    return false; // for example, the daily email quota has been reached
  }
}

function alertStaff_(v, req, ss) {
  var to = String(req.alertEmails || '').split(/[\s,;]+/).filter(function (e) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  }).slice(0, 10);
  if (!to.length) return false;
  var declined = v.status === 'declined';
  var reasons = Array.isArray(v.reasons) ? v.reasons : [];
  var where = String(v.kiosk || req.kiosk || 'the kiosk');
  var lines = [];
  lines.push(declined
    ? 'A visitor was politely declined at ' + where + ' because of their screening answers.'
    : 'A visitor signed in at ' + where + ' and gave an answer that needs your attention.');
  lines.push('');
  lines.push('Name: ' + v.name);
  if (v.company) lines.push('Company: ' + v.company);
  if (v.host) lines.push('Visiting: ' + v.host);
  if (v.phone) lines.push('Phone: ' + v.phone);
  if (v.email) lines.push('Email: ' + v.email);
  lines.push('Time: ' + formatTime_(v.inAt));
  if (reasons.length) {
    lines.push('');
    lines.push(declined ? 'Answers that led to the decline:' : 'Answers that raised an alert:');
    reasons.forEach(function (r) { lines.push('  - ' + r.q + '  ' + r.a); });
  }
  if (declined) {
    lines.push('');
    lines.push('To let them in, tap "Staff override" on the kiosk screen, or open the admin panel and choose "Allow entry".');
  }
  lines.push('');
  lines.push('Visitor log: ' + ss.getUrl());
  var options = {
    to: to.join(','),
    subject: (declined ? 'Visitor declined: ' : 'Visitor alert: ') + v.name,
    body: lines.join('\n'),
    name: 'Visitor Sign In'
  };
  var photo = photoBlob_(v.photo);
  if (photo) options.attachments = [photo];
  try {
    MailApp.sendEmail(options);
    return true;
  } catch (err) {
    return false;
  }
}

function photoBlob_(dataUrl) {
  var match = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  try {
    return Utilities.newBlob(Utilities.base64Decode(match[2]), match[1], 'visitor-photo.' + (match[1] === 'image/png' ? 'png' : 'jpg'));
  } catch (err) {
    return null;
  }
}

/* ---------- Helpers ---------- */

/** Store visitor input as plain text: keeps leading zeros and stops anything being run as a formula. */
function text_(value, max) {
  var s = value == null ? '' : String(value).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max || 500);
  return s ? "'" + s : '';
}

function image_(dataUrl) {
  var s = typeof dataUrl === 'string' ? dataUrl : '';
  if (!/^data:image\//.test(s)) return '';
  return s.length < CELL_LIMIT ? s : '(image too large to store)';
}

function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function toDate_(value) {
  if (value === '' || value == null) return null;
  var d = isDate_(value) ? value : new Date(/^\d+$/.test(String(value)) ? Number(value) : String(value));
  return isNaN(d.getTime()) ? null : d;
}

function toMs_(value) {
  var d = toDate_(value);
  return d ? d.getTime() : 0;
}

function formatTime_(value) {
  return Utilities.formatDate(toDate_(value) || new Date(), Session.getScriptTimeZone(), 'EEE d MMM yyyy, h:mm a');
}

function normCard_(id) {
  return String(id || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^0+(?=.)/, '');
}
`;
