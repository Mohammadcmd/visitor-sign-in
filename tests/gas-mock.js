/* A small in-memory stand-in for the Google Apps Script services the connector uses
 * (SpreadsheetApp, LockService, ContentService, MailApp, Utilities, Session), so the real
 * connector source from apps-script.js can be exercised in tests without a Google account. */
'use strict';
const vm = require('vm');

/** Sheets hides the leading apostrophe that forces a value to be stored as text. */
const stored = v => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);

function createRange(sheet, r, c, nr, nc) {
  const ensureRows = n => { while (sheet.data.length < n) sheet.data.push([]); };
  return {
    getValues() {
      const out = [];
      for (let i = 0; i < nr; i++) {
        const row = sheet.data[r - 1 + i] || [];
        const vals = [];
        for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; vals.push(v == null ? '' : v); }
        out.push(vals);
      }
      return out;
    },
    getValue() { return this.getValues()[0][0]; },
    setValues(values) {
      if (values.length !== nr || values.some(row => row.length !== nc)) {
        throw new Error(`setValues size mismatch: data ${values.length}x${values[0] && values[0].length}, range ${nr}x${nc}`);
      }
      ensureRows(r - 1 + nr);
      sheet.writes.push(values.map(row => row.slice()));
      for (let i = 0; i < nr; i++) {
        const row = sheet.data[r - 1 + i];
        for (let j = 0; j < nc; j++) row[c - 1 + j] = stored(values[i][j]);
      }
      return this;
    },
    setValue(v) { return this.setValues([[v]]); },
    setFontWeight() { return this; },
  };
}

function createSheet(name) {
  return {
    name,
    data: [],
    writes: [], // raw values as the connector sent them (before Sheets strips leading apostrophes)
    getName() { return this.name; },
    setName(n) { this.name = n; return this; },
    getLastRow() {
      for (let r = this.data.length; r > 0; r--) if ((this.data[r - 1] || []).some(v => v !== '' && v != null)) return r;
      return 0;
    },
    getLastColumn() {
      let max = 0;
      for (const row of this.data) {
        for (let c = row.length; c > 0; c--) if (row[c - 1] !== '' && row[c - 1] != null) { max = Math.max(max, c); break; }
      }
      return max;
    },
    getRange(r, c, nr = 1, nc = 1) { return createRange(this, r, c, nr, nc); },
    getDataRange() { return createRange(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); },
    setFrozenRows() { return this; },
    /** Test helper: rows as objects keyed by the header row. */
    rows() {
      const [header = [], ...rest] = this.data;
      return rest.filter(r => r && r.some(v => v !== '' && v != null)).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] == null ? '' : r[i]])));
    },
  };
}

function createSpreadsheet(name) {
  const sheets = [createSheet('Sheet1')];
  return {
    sheets,
    getName: () => name,
    getUrl: () => 'https://docs.google.com/spreadsheets/d/TEST-SHEET/edit',
    getSheets: () => sheets.slice(),
    getSheetByName: n => sheets.find(s => s.getName() === n) || null,
    insertSheet: n => { const s = createSheet(n); sheets.push(s); return s; },
  };
}

function createRuntime(source, { key, sheetName = 'Visitor log' } = {}) {
  const ss = createSpreadsheet(sheetName);
  const mail = [];
  const context = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getActive: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ text, setMimeType() { return this; }, getContent() { return this.text; } }),
    },
    MailApp: { sendEmail: options => { mail.push(options); } },
    Utilities: {
      formatDate: d => new Date(d).toISOString(),
      base64Decode: s => Buffer.from(s, 'base64'),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
    },
    Session: { getScriptTimeZone: () => 'UTC' },
    console,
  };
  vm.createContext(context);
  vm.runInContext(key == null ? source : source.replace('%%KIOSK_KEY%%', key), context);
  return {
    ss,
    mail,
    post(body) {
      const out = context.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
      return JSON.parse(out.getContent());
    },
    get(parameter) { return context.doGet({ parameter }).getContent(); },
    tab(name) { return ss.getSheetByName(name); },
  };
}

module.exports = { createRuntime };
