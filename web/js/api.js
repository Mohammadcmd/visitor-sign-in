// Talks to the Google Sheets backend (apps-script/Code.gs), or keeps everything
// on this tablet. Both answer the same actions with the same JSON, so the rest
// of the kiosk never needs to know which one it's using.
import { CONFIG } from '../config.js';
import { nameKey, companyWords, sameCompany, near, normalizeTag } from './match.js';
import { settings, saveLocal, hashPin, useSettings } from './settings.js';

export const MODE = CONFIG.API_URL ? 'cloud' : CONFIG.DEMO ? 'demo' : 'local';
export const DEMO = MODE === 'demo';
export const ON_TABLET = MODE !== 'cloud';
export const BACKEND_VERSION = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_WAITS = [0, 1500, 4000];
const TIMEOUT_MS = 20000;
const OUTBOX = 'kiosk-outbox';
const OUTBOX_MAX = 40;

/** Tells the page whether the backend is reachable (for the "Offline" indicator). */
function reportNet(ok) {
  window.dispatchEvent(new CustomEvent('kiosk-net', { detail: { ok } }));
}

const requestId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function send(url, key, action, args, rid) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // text/plain keeps this a "simple" request, so the browser skips the CORS
    // preflight that Apps Script can't answer.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key, action, args, rid }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(/<html/i.test(text) ? 'not_json_html' : 'not_json'); }
  } finally {
    clearTimeout(timer);
  }
}

/** How many writes are waiting to be sent to the Google Sheet (shown in Diagnostics). */
export const pendingCount = () => (ON_TABLET ? 0 : readOutbox().length);

/**
 * Calls the backend, retrying a couple of times on a network hiccup. Every
 * attempt carries the same request id, so the backend answers a repeat with
 * the first result instead of writing twice.
 */
export async function call(action, args = {}, rid = requestId()) {
  if (ON_TABLET) return local(action, args);
  let lastErr;
  for (const wait of RETRY_WAITS) {
    if (wait) await sleep(wait);
    try {
      const out = await send(CONFIG.API_URL, CONFIG.KIOSK_KEY, action, args, rid);
      reportNet(true);
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  reportNet(false);
  throw lastErr;
}

/** One call to a backend that isn't saved yet, so the setup wizard can test a connection. */
export function callBackend(url, key, action, args = {}) {
  return send(url, key, action, args, requestId());
}

/**
 * For calls nobody waits on (a new face photo, say): kept on the tablet and
 * sent whenever the backend is reachable, so a Wi-Fi drop loses nothing.
 */
export function queue(action, args) {
  if (ON_TABLET) { local(action, args); return; }
  const box = readOutbox();
  box.push({ action, args, rid: requestId() });
  writeOutbox(box.slice(-OUTBOX_MAX));
  flushOutbox();
}

let flushing = false;
export async function flushOutbox() {
  if (ON_TABLET || flushing) return;
  flushing = true;
  try {
    for (let box = readOutbox(); box.length; box = readOutbox()) {
      const item = box[0];
      let res;
      try {
        res = await call(item.action, item.args, item.rid);
      } catch {
        return; // still offline; try again later
      }
      // The sheet was busy: keep it for the next round (the request id stops it being written twice).
      if (res && res.ok === false && res.error === 'busy') return;
      writeOutbox(readOutbox().filter((x) => x.rid !== item.rid));
    }
  } finally {
    flushing = false;
  }
}

function readOutbox() {
  try {
    const box = JSON.parse(localStorage.getItem(OUTBOX)) || [];
    // Items waiting from before the kiosk became configurable.
    const legacy = JSON.parse(localStorage.getItem('shocktech-kiosk-outbox'));
    if (Array.isArray(legacy) && legacy.length) {
      localStorage.removeItem('shocktech-kiosk-outbox');
      const merged = legacy.concat(box);
      localStorage.setItem(OUTBOX, JSON.stringify(merged));
      return merged;
    }
    return box;
  } catch { return []; }
}

function writeOutbox(box) {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify(box));
  } catch {
    // Storage full: drop the oldest item and try once more.
    try { localStorage.setItem(OUTBOX, JSON.stringify(box.slice(1))); } catch { /* give up on this one */ }
  }
}

if (!ON_TABLET) {
  window.addEventListener('online', flushOutbox);
  setInterval(flushOutbox, 30 * 1000);
  setTimeout(flushOutbox, 3000);
}

// ------------------------------------------------------------------ photos on this tablet

/** Photos are big, so they live in IndexedDB rather than localStorage. */
export const photos = (() => {
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DEMO ? 'kiosk-demo-photos' : 'kiosk-photos', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('photos');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      dbp.catch(() => { dbp = null; });
    }
    return dbp;
  }
  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', mode);
      const req = fn(tx.objectStore('photos'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  }
  return {
    put: (k, v) => run('readwrite', (st) => st.put(v, k)).catch(() => {}),
    get: (k) => run('readonly', (st) => st.get(k)).then((v) => v || '').catch(() => ''),
    clear: () => run('readwrite', (st) => st.clear()).catch(() => {}),
    del: (k) => run('readwrite', (st) => st.delete(k)).catch(() => {}),
  };
})();

// ------------------------------------------------------------------ on this tablet (and demo mode)
//
// Mirrors apps-script/Code.gs action for action, so a kiosk kept on the tablet
// behaves exactly like one connected to Google Sheets.

const STORE = DEMO ? 'kiosk-demo-v1' : 'kiosk-local-v1';
const DEMO_PIN = '123456';
const ATTENTION_DAYS = 14;
const PASS_MS = 2 * 60 * 60 * 1000;

// The records are read from storage once and kept in memory; only actions that
// change something write them back. (A year of visits is a few MB: reading and
// writing all of it on every tap made a busy kiosk feel slow.)
let memo = null;

function load() {
  if (memo) return memo;
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && s.badges) { memo = { passes: [], expected: [], ...s }; return memo; }
  } catch { /* fall through to a fresh store */ }
  memo = {
    visitors: [], visits: [], faces: [], passes: [], expected: [],
    badges: DEMO ? [1, 2, 3, 4, 5].map((n) => ({ badge: `V${n}`, tag: `DEMO000${n}`, status: 'available' })) : [],
  };
  return memo;
}

/** Actions that only read: nothing to write back afterwards. */
const READS = new Set(['ping', 'getSettings', 'faceIndex', 'findVisitor', 'findOpenVisits', 'findExpected', 'adminLogin',
  'adminInside', 'adminBadges', 'adminAttention', 'adminHistory', 'adminVisitors', 'adminPhoto', 'adminExpected']);

function save(s) {
  try { localStorage.setItem(STORE, JSON.stringify(s)); } catch {
    // Keep the newest records if storage fills up; photos are elsewhere, so this is rare.
    s.visits = s.visits.slice(-2000);
    try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* nothing more to drop */ }
  }
}

/** Forgets every visitor, visit and badge on this tablet (Admin → Settings → Start over). */
export async function eraseTablet() {
  memo = null;
  try { localStorage.removeItem(STORE); } catch { /* nothing stored */ }
  await photos.clear();
}

let tail = Promise.resolve();
async function local(action, a) {
  // One action at a time, like the backend's script lock.
  const run = tail.then(async () => {
    // Demo mode pauses a moment, as a real sheet would; on the tablet there's no waiting.
    if (DEMO) await sleep(120);
    const s = load();
    let out;
    try {
      out = await localAction(s, action, a || {});
    } catch (err) {
      memo = null; // read the saved copy again rather than keep a half-done change
      throw err;
    }
    if (!READS.has(action)) save(s);
    return out;
  });
  tail = run.catch(() => {});
  return run;
}

const randomId = (p) => p + Math.random().toString(36).slice(2, 10).toUpperCase();
const now = () => new Date().toISOString();
const clean = (v, max = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().replace(/^[=+\-@\s]+/, '').slice(0, max);
const tokens = new Map();
let pinFails = { n: 0, until: 0 };

function newToken() {
  const t = randomId('T') + randomId('');
  tokens.set(t, Date.now() + 15 * 60 * 1000);
  return t;
}
function checkToken(t) {
  const exp = tokens.get(t);
  if (!exp || exp < Date.now()) { tokens.delete(t); return false; }
  tokens.set(t, Date.now() + 15 * 60 * 1000);
  return true;
}

function cleanAnswers(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30)
    .map((x) => ({ label: clean(x && x.label, 60), value: clean(x && x.value) })).filter((x) => x.label);
}
function cleanFlags(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20)
    .map((x) => ({ label: clean(x && x.label, 60), answer: clean(x && x.answer), flagLabel: clean(x && x.flagLabel, 40) }))
    .filter((x) => x.label);
}
const reasonList = (flags) => flags.map((f) => `${f.label} = ${f.answer}`).join('; ') || 'screening answer';
function screeningText(flags, override) {
  if (override) {
    const by = clean(override.by) || settings().admin.name || 'Admin';
    const reason = clean(override.reason);
    return `Overridden by ${by}${reason ? `: ${reason}` : ''}`;
  }
  if (flags.length) return `Flagged: ${[...new Set(flags.map((f) => f.flagLabel || f.label))].join(', ')}`;
  return 'Clear';
}
function kindOf(screening) {
  const m = /^Flagged: ([^,]+)/.exec(screening || '');
  if (m) return m[1];
  if (/^Overridden/.test(screening || '')) return 'Visitor (override)';
  if (/^Approved earlier/.test(screening || '')) return 'Visitor (approved earlier)';
  return 'Visitor';
}
const passKey = (first, last) => `${nameKey(first)}|${nameKey(last)}`;
function takePass(s, first, last) {
  s.passes = (s.passes || []).filter((p) => p.until > Date.now());
  const i = s.passes.findIndex((p) => p.key === passKey(first, last));
  return i < 0 ? null : s.passes.splice(i, 1)[0];
}
function attention(s) {
  const since = Date.now() - ATTENTION_DAYS * 86400000;
  return s.visits.filter((v) => !v.reviewed && /^(declined|flagged)/i.test(v.screening || '') && new Date(v.signedIn).getTime() >= since);
}

/** "2026-11-04" on this tablet's calendar. */
export function dayKey(d = new Date()) {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Today's expected visitor with this name (or id) who hasn't arrived yet. */
function matchExpected(s, first, last, id) {
  const today = dayKey();
  const list = s.expected.filter((e) => e.day === today && !e.arrived);
  return (id && list.find((e) => e.id === id))
    || list.find((e) => near(nameKey(e.first), nameKey(first)) && near(nameKey(e.last), nameKey(last))) || null;
}

function signOut(s, visit, by) {
  visit.signedOut = now();
  visit.signedOutBy = by;
  const b = s.badges.find((x) => x.badge === visit.badge);
  if (visit.badge && b && b.visitId === visit.id) Object.assign(b, { status: 'available', holder: '', visitorId: '', visitId: '', since: '' });
}

function startVisit(s, v, a, badgeNo, replacedBy) {
  const open = s.visits.find((x) => x.visitorId === v.id && !x.signedOut);
  if (open) signOut(s, open, replacedBy);
  const expected = matchExpected(s, v.first, v.last, a.expectedId);
  if (expected) expected.arrived = `Signed in ${new Date().toLocaleString()}`;
  const flags = cleanFlags(a.flags);
  const carried = /^overridden/i.test(v.screening || '') ? `Approved earlier: ${v.screening}` : (v.screening || 'Clear');
  const screening = flags.length || a.override ? screeningText(flags, a.override) : carried;
  const visit = {
    id: randomId('S'), visitorId: v.id, first: v.first, last: v.last, company: v.company,
    visiting: clean(a.visiting) || expected?.host || v.visiting, purpose: clean(a.purpose) || expected?.purpose || v.purpose,
    kind: kindOf(screening), badge: badgeNo,
    method: (clean(a.method) || 'kiosk') + (a.override ? ' (staff override)' : ''),
    signedIn: now(), screening,
  };
  visit.expected = !!expected;
  s.visits.push(visit);
  v.visits = (v.visits || 0) + 1;
  v.lastVisit = new Date().toLocaleDateString();
  v.lastVisitAt = now();
  return visit;
}

async function localAction(s, action, a) {
  const st = settings();
  const byTag = (t) => s.badges.find((b) => normalizeTag(b.tag) === normalizeTag(t) && normalizeTag(t));
  switch (action) {
    case 'ping': return {
      ok: true, version: BACKEND_VERSION, setupComplete: st.setupComplete,
      hasPin: DEMO || !!st.admin.pinHash, attention: attention(s).length,
    };
    case 'getSettings': return { ok: true, settings: st, logo: st.org.logo };
    case 'faceIndex': return {
      ok: true,
      people: s.visitors.filter((v) => v.quickEntry).map((v) => ({
        id: v.id, first: v.first, last: v.last, company: v.company,
        descriptors: s.faces.filter((f) => f.visitorId === v.id).slice(-12).map((f) => f.descriptor),
      })).filter((p) => p.descriptors.length),
    };
    case 'register': {
      const v = {
        id: randomId('P'), first: clean(a.first), last: clean(a.last), company: clean(a.company) || 'N/A',
        visiting: clean(a.visiting), purpose: clean(a.purpose), agreed: a.agreed === true, quickEntry: a.quickEntry === true,
        registered: now(), visits: 0, lastVisit: '',
      };
      const missing = ['first', 'last'].filter((k) => !v[k]);
      if (st.form.askHost && !v.visiting) missing.push('visiting');
      if (st.form.askPurpose && !v.purpose) missing.push('purpose');
      if (st.form.rules.length && !v.agreed) missing.push('agreed');
      if (!a.photo && st.photos === 'all') missing.push('photo');
      if (missing.length) return { ok: false, error: 'missing', fields: missing };
      v.answers = cleanAnswers(a.answers);
      const flags = cleanFlags(a.flags);
      const pass = takePass(s, v.first, v.last);
      v.screening = screeningText(flags, a.override || pass);
      s.visitors.push(v);
      if (a.photo) await photos.put(`visitor:${v.id}`, a.photo);
      if (v.quickEntry && Array.isArray(a.descriptor)) s.faces.push({ visitorId: v.id, descriptor: a.descriptor });
      return { ok: true, visitor: { id: v.id, first: v.first, last: v.last, company: v.company, quickEntry: v.quickEntry, kind: kindOf(v.screening) } };
    }
    case 'recordDecline': {
      const first = clean(a.first), last = clean(a.last);
      if (!first || !last) return { ok: false, error: 'missing', fields: ['first', 'last'] };
      const pass = takePass(s, first, last);
      if (pass) return { ok: true, passed: true, reason: pass.reason || '', by: pass.by || '' };
      const id = randomId('D');
      const exp = matchExpected(s, first, last, a.expectedId);
      if (exp) exp.arrived = `Declined at the kiosk ${new Date().toLocaleString()}`;
      if (a.photo) await photos.put(`decline:${id}`, a.photo);
      s.visits.push({
        id, visitorId: clean(a.visitorId), first, last, company: clean(a.company) || 'N/A',
        visiting: clean(a.visiting), purpose: clean(a.purpose), kind: 'Declined', badge: '',
        method: clean(a.method) || 'new visitor', signedIn: now(), signedOut: now(), signedOutBy: 'Declined at the kiosk',
        screening: `Declined: ${reasonList(cleanFlags(a.reasons))}`, photo: a.photo ? `decline:${id}` : '',
      });
      return { ok: true, declineId: id };
    }
    case 'findVisitor': {
      const f = nameKey(a.first), l = nameKey(a.last), c = companyWords(a.company);
      if (!f || !l) return { ok: false, error: 'fullname' };
      return {
        ok: true,
        matches: s.visitors.filter((v) => near(nameKey(v.first), f) && near(nameKey(v.last), l)
          && (!c.length || sameCompany(companyWords(v.company), c))).slice(0, 5)
          .map((v) => ({ id: v.id, first: v.first, last: v.last, company: v.company, quickEntry: !!v.quickEntry, lastVisit: v.lastVisit || '' })),
      };
    }
    case 'findExpected': {
      if (!nameKey(a.first) || !nameKey(a.last)) return { ok: false, error: 'fullname' };
      const e = matchExpected(s, a.first, a.last, '');
      return { ok: true, expected: e ? { id: e.id, first: e.first, last: e.last, company: e.company, host: e.host, purpose: e.purpose } : null };
    }
    case 'findOpenVisits': {
      const f = nameKey(a.first), l = nameKey(a.last);
      if (!f || !l) return { ok: false, error: 'fullname' };
      return {
        ok: true,
        matches: s.visits.filter((v) => !v.signedOut && near(nameKey(v.first), f) && near(nameKey(v.last), l)).slice(0, 5)
          .map((v) => ({ visitId: v.id, first: v.first, last: v.last, company: v.company, since: v.signedIn, badge: v.badge || '' })),
      };
    }
    case 'addFaceSample': {
      const v = s.visitors.find((x) => x.id === a.visitorId);
      if (!v) return { ok: false, error: 'not_found' };
      if (!v.quickEntry) return { ok: true, saved: false };
      s.faces.push({ visitorId: v.id, descriptor: a.descriptor });
      // The newest dozen are plenty for recognition, and keep storage small.
      const mine = s.faces.filter((f) => f.visitorId === v.id);
      if (mine.length > 12) { const drop = new Set(mine.slice(0, mine.length - 12)); s.faces = s.faces.filter((f) => !drop.has(f)); }
      return { ok: true, saved: true };
    }
    case 'setQuickEntry': {
      const v = s.visitors.find((x) => x.id === a.visitorId);
      if (!v) return { ok: false, error: 'not_found' };
      v.quickEntry = !!a.on;
      if (!a.on) s.faces = s.faces.filter((f) => f.visitorId !== v.id);
      return { ok: true };
    }
    case 'assignBadge': {
      const v = s.visitors.find((x) => x.id === a.visitorId);
      if (!v) return { ok: false, error: 'not_found' };
      const b = byTag(a.tag);
      if (!b) return { ok: false, error: 'badge_unknown' };
      if (b.status === 'retired') return { ok: false, error: 'badge_retired', badge: b.badge };
      if (b.status === 'in use') {
        return b.visitorId === v.id ? { ok: true, badge: b.badge, already: true } : { ok: false, error: 'badge_in_use', badge: b.badge };
      }
      const visit = startVisit(s, v, a, b.badge, `Switched to badge ${b.badge}`);
      Object.assign(b, { status: 'in use', holder: `${v.first} ${v.last}`, visitorId: v.id, visitId: visit.id, since: visit.signedIn, note: '' });
      return { ok: true, badge: b.badge, visitId: visit.id, expected: visit.expected };
    }
    case 'checkIn': {
      const v = s.visitors.find((x) => x.id === a.visitorId);
      if (!v) return { ok: false, error: 'not_found' };
      const visit = startVisit(s, v, a, '', 'Signed in again');
      return { ok: true, visitId: visit.id, expected: visit.expected };
    }
    case 'purgeOld': {
      const days = Number(st.retentionDays) || 0;
      if (days < 30) return { ok: true, removed: null };
      const cutoff = Date.now() - days * 86400000;
      const old = (iso) => { const t = new Date(iso).getTime(); return !Number.isNaN(t) && t < cutoff; };
      const before = { visits: s.visits.length, visitors: s.visitors.length, expected: s.expected.length };
      for (const v of s.visits) if (v.signedOut && old(v.signedIn) && v.photo) await photos.del(v.photo);
      s.visits = s.visits.filter((v) => !(v.signedOut && old(v.signedIn)));
      const gone = new Set(s.visitors.filter((v) => old(v.lastVisitAt || v.registered)).map((v) => v.id));
      for (const id of gone) await photos.del(`visitor:${id}`);
      s.visitors = s.visitors.filter((v) => !gone.has(v.id));
      s.faces = s.faces.filter((f) => !gone.has(f.visitorId));
      const day = dayKey(cutoff);
      s.expected = s.expected.filter((e) => e.day >= day);
      return { ok: true, removed: { visits: before.visits - s.visits.length, visitors: before.visitors - s.visitors.length, expected: before.expected - s.expected.length } };
    }
    case 'endOfDay': {
      let cutoff = new Date(a.before);
      if (Number.isNaN(cutoff.getTime()) || cutoff > new Date()) cutoff = new Date();
      let done = 0;
      for (const v of s.visits) {
        if (v.signedOut || new Date(v.signedIn) >= cutoff) continue;
        signOut(s, v, 'End of day');
        const b = v.badge && s.badges.find((x) => x.badge === v.badge);
        if (b && b.status === 'available') Object.assign(b, { status: 'not returned', note: `Not returned by ${v.first} ${v.last} (${new Date(v.signedIn).toLocaleDateString()})` });
        done++;
      }
      return { ok: true, signedOut: done, summary: false };
    }
    case 'tapAtWelcome': {
      const b = byTag(a.tag);
      if (!b) return { ok: true, result: 'unknown' };
      if (b.status === 'not returned') { Object.assign(b, { status: 'available', note: '' }); return { ok: true, result: 'returned', badge: b.badge }; }
      if (b.status !== 'in use') return { ok: true, result: 'not_out', badge: b.badge };
      const visit = s.visits.find((x) => x.id === b.visitId);
      const name = b.holder, visitId = b.visitId, badge = b.badge;
      if (visit) signOut(s, visit, 'Badge tap at kiosk');
      else Object.assign(b, { status: 'available', holder: '', visitorId: '', visitId: '', since: '' });
      return { ok: true, result: 'signed_out', badge, name, first: visit ? visit.first : name, visitId };
    }
    case 'kioskSignOut': {
      const visit = s.visits.find((x) => x.id === a.visitId);
      if (!visit || visit.signedOut) return { ok: false, error: 'not_found' };
      signOut(s, visit, 'Signed out at kiosk');
      return { ok: true, first: visit.first, badge: visit.badge || '', visitId: visit.id };
    }
    case 'undoSignOut': {
      const visit = s.visits.find((x) => x.id === a.visitId);
      if (!visit || !visit.signedOut) return { ok: false, error: 'not_found' };
      if (Date.now() - new Date(visit.signedOut).getTime() > 90 * 1000) return { ok: false, error: 'too_late' };
      if (!visit.badge) { visit.signedOut = ''; visit.signedOutBy = ''; return { ok: true }; }
      const b = s.badges.find((x) => x.badge === visit.badge);
      if (!b || b.status === 'in use') return { ok: false, error: 'badge_in_use' };
      visit.signedOut = ''; visit.signedOutBy = '';
      Object.assign(b, { status: 'in use', holder: `${visit.first} ${visit.last}`, visitorId: visit.visitorId, visitId: visit.id, since: visit.signedIn });
      return { ok: true };
    }
    case 'adminLogin': {
      if (pinFails.until > Date.now()) return { ok: false, error: 'locked' };
      const good = DEMO ? a.pin === DEMO_PIN : !!st.admin.pinHash && (await hashPin(String(a.pin || ''))) === st.admin.pinHash;
      if (!good) {
        pinFails.n += 1;
        if (pinFails.n >= 10) pinFails = { n: 0, until: Date.now() + 10 * 60 * 1000 };
        return { ok: false, error: DEMO || st.admin.pinHash ? 'pin' : 'no_pin' };
      }
      pinFails = { n: 0, until: 0 };
      return { ok: true, token: newToken(), ttl: 900 };
    }
    case 'adminSetPin': {
      const pin = String(a.pin || '');
      if (!/^\d{6,8}$/.test(pin)) return { ok: false, error: 'pin_format' };
      if ((DEMO || st.admin.pinHash) && !checkToken(a.token)) return { ok: false, error: 'admin' };
      if (!DEMO) saveLocal({ ...st, admin: { ...st.admin, pinHash: await hashPin(pin) } });
      return { ok: true, token: newToken(), ttl: 900 };
    }
  }
  if (!checkToken(a.token)) return { ok: false, error: 'admin' };
  switch (action) {
    case 'adminInside': return {
      ok: true,
      inside: s.visits.filter((v) => !v.signedOut).map((v) => ({
        visitId: v.id, first: v.first, last: v.last, company: v.company, visiting: v.visiting,
        kind: v.kind, badge: v.badge || '', since: v.signedIn, screening: v.screening || '', purpose: v.purpose,
      })),
    };
    case 'adminAttention': {
      const items = attention(s).slice().reverse().slice(0, 50);
      const out = [];
      for (const v of items) {
        const declined = /^declined/i.test(v.screening);
        out.push({
          visitId: v.id, first: v.first, last: v.last, company: v.company, visiting: v.visiting, purpose: v.purpose,
          when: v.signedIn, kind: declined ? 'declined' : 'flagged', label: declined ? 'Declined' : v.kind,
          screening: v.screening, photo: v.photo ? await photos.get(v.photo) : '', inside: !v.signedOut,
          allowed: / allowed by /i.test(v.screening),
        });
      }
      return { ok: true, items: out };
    }
    case 'adminHistory': {
      const days = Math.max(1, Math.min(3650, Number(a.days) || 30));
      const since = Date.now() - days * 86400000;
      const q = nameKey(a.q);
      const out = [];
      for (let i = s.visits.length - 1; i >= 0 && out.length < 2000; i--) {
        const v = s.visits[i];
        if (new Date(v.signedIn).getTime() < since) continue;
        if (q && !nameKey([v.first, v.last, v.company, v.visiting].join(' ')).includes(q)) continue;
        out.push({
          visitId: v.id, signedIn: v.signedIn, signedOut: v.signedOut || '', first: v.first, last: v.last,
          company: v.company, visiting: v.visiting, purpose: v.purpose, kind: v.kind, badge: v.badge || '',
          method: v.method, signedOutBy: v.signedOutBy || '', screening: v.screening || '', hostNotified: '',
        });
      }
      return { ok: true, visits: out };
    }
    case 'adminExpected': {
      const days = Math.max(1, Math.min(90, Number(a.days) || 14));
      const from = dayKey(Date.now() - 86400000), to = dayKey(Date.now() + days * 86400000);
      const list = s.expected.filter((e) => e.day >= from && e.day <= to).sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
      return { ok: true, today: dayKey(), expected: list.map((e) => ({ ...e })) };
    }
    case 'adminAddExpected': {
      const e = {
        id: randomId('E'), day: /^\d{4}-\d{2}-\d{2}$/.test(a.day || '') ? a.day : '',
        first: clean(a.first), last: clean(a.last), company: clean(a.company), host: clean(a.host),
        purpose: clean(a.purpose), note: clean(a.note), arrived: '', addedBy: `${st.admin.name || 'Admin'} (${new Date().toLocaleString()})`,
      };
      if (!e.first || !e.last) return { ok: false, error: 'missing', fields: ['first', 'last'] };
      if (!e.day) return { ok: false, error: 'missing', fields: ['day'] };
      s.expected.push(e);
      // Keep a year of history at most.
      const oldest = dayKey(Date.now() - 365 * 86400000);
      s.expected = s.expected.filter((x) => x.day >= oldest);
      return { ok: true, id: e.id };
    }
    case 'adminRemoveExpected': {
      const i = s.expected.findIndex((e) => e.id === a.id);
      if (i < 0) return { ok: false, error: 'not_found' };
      s.expected.splice(i, 1);
      return { ok: true };
    }
    case 'adminVisitors': return {
      ok: true,
      visitors: s.visitors.map((v) => ({
        first: v.first, last: v.last, company: v.company, visiting: v.visiting, purpose: v.purpose,
        answers: v.answers || [], quickEntry: !!v.quickEntry, registered: v.registered, lastVisit: v.lastVisit || '',
        visits: v.visits || 0, screening: v.screening || '',
      })),
    };
    case 'adminPhoto': {
      const v = s.visits.find((x) => x.id === a.visitId);
      if (!v) return { ok: false, error: 'not_found' };
      return { ok: true, photo: (v.photo && await photos.get(v.photo)) || await photos.get(`visitor:${v.visitorId}`) };
    }
    case 'adminReview': {
      const v = s.visits.find((x) => x.id === a.visitId);
      if (!v) return { ok: false, error: 'not_found' };
      v.reviewed = `Reviewed by ${st.admin.name || 'Admin'}`;
      return { ok: true };
    }
    case 'adminAllow': {
      const v = s.visits.find((x) => x.id === a.visitId);
      if (!v || !/^declined/i.test(v.screening)) return { ok: false, error: 'not_found' };
      const by = st.admin.name || 'Admin', reason = clean(a.reason);
      s.passes = (s.passes || []).filter((p) => p.until > Date.now() && p.key !== passKey(v.first, v.last));
      s.passes.push({ key: passKey(v.first, v.last), by, reason, until: Date.now() + PASS_MS });
      v.screening += `. Allowed by ${by}${reason ? `: ${reason}` : ''}`;
      v.reviewed = `Reviewed by ${by}`;
      return { ok: true, by };
    }
    case 'adminSaveSettings': {
      const next = { ...a.settings, admin: { ...(a.settings || {}).admin, pinHash: st.admin.pinHash } };
      next.org = { ...(next.org || {}) };
      if (a.logo === '') next.org.logo = '';
      else if (typeof a.logo === 'string' && a.logo) next.org.logo = a.logo;
      else next.org.logo = st.org.logo;
      if (DEMO) useSettings(next); else saveLocal(next);
      return { ok: true };
    }
    case 'adminBadges': return { ok: true, badges: s.badges.map((b) => ({ badge: b.badge, tag: b.tag || '', status: b.status, holder: b.holder || '', since: b.since || '', note: b.note || '' })) };
    case 'adminSignOut': {
      const v = s.visits.find((x) => x.id === a.visitId);
      if (!v) return { ok: false, error: 'not_found' };
      if (!v.signedOut) signOut(s, v, 'Admin');
      return { ok: true };
    }
    case 'adminAddBadge': {
      const max = s.badges.reduce((m, b) => Math.max(m, Number((/^V(\d+)$/i.exec(b.badge) || [])[1] || 0)), 0);
      const no = a.badge || `V${max + 1}`;
      if (s.badges.some((b) => b.badge.toLowerCase() === no.toLowerCase())) return { ok: false, error: 'badge_exists', badge: no };
      const tag = normalizeTag(a.tag);
      const prev = tag && byTag(tag);
      if (prev) prev.tag = '';
      s.badges.push({ badge: no, tag, status: 'available' });
      return { ok: true, badge: no, movedFrom: prev ? prev.badge : '' };
    }
    case 'adminLinkTag': {
      const b = s.badges.find((x) => x.badge === a.badge);
      if (!b) return { ok: false, error: 'not_found' };
      const tag = normalizeTag(a.tag);
      const prev = byTag(tag);
      if (prev) prev.tag = '';
      b.tag = tag;
      return { ok: true, movedFrom: prev && prev !== b ? prev.badge : '' };
    }
    case 'adminRetireBadge':
    case 'adminRestoreBadge': {
      const b = s.badges.find((x) => x.badge === a.badge);
      if (!b) return { ok: false, error: 'not_found' };
      if (action === 'adminRetireBadge' && b.status === 'in use') return { ok: false, error: 'badge_in_use' };
      b.status = action === 'adminRetireBadge' ? 'retired' : 'available';
      if (action === 'adminRestoreBadge') b.note = '';
      return { ok: true };
    }
  }
  return { ok: false, error: 'unknown_action' };
}
