// In-memory stand-ins for the Google services apps-script/Code.gs uses
// (SpreadsheetApp, DriveApp, PropertiesService, CacheService, LockService,
// MailApp, Utilities…), so the backend can run in Node for tests.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function fakeGoogle(initialProps = {}) {
  const sheets = {};
  const order = [];
  const props = { ...initialProps };
  const cache = {};
  const mail = [];
  const files = {};
  let fileSeq = 0;
  let folderSeq = 0;

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
      insertColumnBefore(c) { rows.forEach((row) => { while (row.length < c - 1) row.push(''); row.splice(c - 1, 0, ''); }); },
      setFrozenRows() {},
      hideSheet() { sh.hidden = true; },
      /** Test helper: data rows as objects keyed by header. */
      objects() {
        const [head = [], ...rest] = rows;
        return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
      },
    };
    return sh;
  }

  const book = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { order.push(n); return (sheets[n] = makeSheet(n)); },
    getName: () => 'Visitor log',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/FAKE/edit',
  };

  function makeFile(blob, folderName) {
    const id = '1fakeDriveFile' + String(++fileSeq).padStart(6, '0');
    const created = new Date(Date.now() + Object.keys(files).length);
    const file = {
      blob, folderName, trashed: false,
      getId: () => id,
      getUrl: () => `https://drive.google.com/file/d/${id}/view`,
      getBlob: () => ({ getContentType: () => blob.type, getBytes: () => blob.bytes }),
      getDateCreated: () => created,
      setTrashed(t) { file.trashed = t; return file; },
    };
    files[id] = file;
    return file;
  }

  function folder(name) {
    const id = 'FOLDER' + (++folderSeq) + name.replace(/\W/g, '').slice(0, 12);
    const children = [];
    const f = {
      name, files: [],
      getId: () => id,
      getUrl: () => `https://drive.google.com/drive/folders/${id}`,
      createFolder(n) { const c = folder(n); children.push(c); return c; },
      getFoldersByName(n) { const list = children.filter((c) => c.name === n); return { hasNext: () => list.length > 0, next: () => list.shift() }; },
      createFile(blob) { const file = makeFile(blob, name); f.files.push(file); return file; },
      getFiles() { const list = f.files.filter((x) => !x.trashed); return { hasNext: () => list.length > 0, next: () => list.shift() }; },
    };
    allFolders.push(f);
    return f;
  }
  const rootFolders = [];
  const allFolders = [];

  const globals = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => book, openById: () => book },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    DriveApp: {
      getFolderById: (id) => {
        const hit = allFolders.find((x) => x.getId() === id);
        if (!hit) throw new Error('No folder ' + id);
        return hit;
      },
      getFoldersByName: (n) => { const list = rootFolders.filter((x) => x.name === n); return { hasNext: () => list.length > 0, next: () => list.shift() }; },
      createFolder: (n) => { const f = folder(n); rootFolders.push(f); return f; },
      getFileById: (id) => { if (!files[id]) throw new Error('No file ' + id); return files[id]; },
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => cache[k] ?? null,
        put: (k, v) => { cache[k] = v; },
        remove: (k) => { delete cache[k]; },
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    MailApp: { sendEmail: (o) => { mail.push(o); } },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      sleep() {},
      computeDigest: (_, s) => [...crypto.createHash('sha256').update(s).digest()].map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'sha256' },
      formatDate: (d) => new Date(d).toISOString(),
      base64Decode: (s) => Buffer.from(s, 'base64'),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
    },
    Session: { getScriptTimeZone: () => 'America/New_York' },
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => s }), MimeType: { JSON: 'json' } },
    Logger: { log() {} },
  };
  return { globals, sheets, order, props, cache, mail, files, rootFolders };
}

/** Loads apps-script/Code.gs into a fresh fake Google. */
function loadBackend(initialProps) {
  const g = fakeGoogle(initialProps);
  const ctx = vm.createContext(g.globals);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), ctx);
  // Requests and answers go through JSON, like the real HTTP transport.
  return { ...g, ctx, handle: (req) => JSON.parse(JSON.stringify(ctx.handle_(JSON.parse(JSON.stringify(req))))) };
}

module.exports = { fakeGoogle, loadBackend };
