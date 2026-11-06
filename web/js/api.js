// Talks to the Google Sheets backend (apps-script/Code.gs), or keeps everything
// on this tablet. Both answer the same actions with the same JSON, so the rest
// of the kiosk never needs to know which one it's using.
import { CONFIG } from '../config.js';
import { settings, saveLocal, useSettings } from './settings.js';
import { createEngine, emptyStore, makeClock, READS } from './engine.js';

export const MODE = CONFIG.PHONE ? 'phone' : CONFIG.API_URL ? 'cloud' : CONFIG.DEMO ? 'demo' : 'local';
export const DEMO = MODE === 'demo';
export const ON_TABLET = MODE === 'local' || MODE === 'demo';
/** A visitor's own phone (the QR code by the door): only signing in and out. */
export const PHONE = MODE === 'phone';
export const BACKEND_VERSION = 6;

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
      body: JSON.stringify(PHONE ? { phone: key, action, args, rid } : { key, action, args, rid }),
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
  if (PHONE) {
    const mapped = phoneCall(action, args);
    if (!mapped) return { ok: false, error: 'not_on_phone' };
    [action, args] = mapped;
  }
  let lastErr;
  for (const wait of RETRY_WAITS) {
    if (wait) await sleep(wait);
    try {
      const out = PHONE ? await send(CONFIG.PHONE.api, CONFIG.PHONE.key, action, args, rid) : await send(CONFIG.API_URL, CONFIG.KIOSK_KEY, action, args, rid);
      reportNet(true);
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  reportNet(false);
  throw lastErr;
}

// ------------------------------------------------------------------ a visitor's phone

/**
 * The visitor this phone signed in, kept on the phone (per company link): who
 * they are, the secret token that lets this phone sign them in again or out,
 * and their open visit.
 */
const PHONE_MEMORY = PHONE ? `kiosk-phone-visitor:${CONFIG.PHONE.api.slice(-24)}` : '';
export const phoneVisitor = {
  get() { try { return JSON.parse(localStorage.getItem(PHONE_MEMORY)) || null; } catch { return null; } },
  set(v) { try { localStorage.setItem(PHONE_MEMORY, JSON.stringify(v)); } catch { /* private mode: not remembered */ } },
  clear() { try { localStorage.removeItem(PHONE_MEMORY); } catch { /* nothing stored */ } },
};

/** The kiosk's calls, as a phone makes them (or null: not on a phone). */
function phoneCall(action, args) {
  const me = phoneVisitor.get() || {};
  switch (action) {
    case 'getSettings':
    case 'ping': return ['phoneStart', {}];
    case 'register': return ['phoneRegister', args];
    case 'recordDecline': return ['phoneDecline', args];
    case 'checkIn': return ['phoneCheckIn', { ...args, visitorId: me.visitorId, token: me.token }];
    case 'kioskSignOut': return ['phoneSignOut', { ...args, token: me.token }];
    default: return null;
  }
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
  if (PHONE) return; // phones send only what they wait for
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

if (MODE === 'cloud') {
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
// The records are kept in this browser; the actions themselves are the shared
// engine (js/engine.js), which mirrors apps-script/Code.gs action for action, so
// a kiosk kept on the tablet behaves exactly like one connected to Google Sheets.

const STORE = DEMO ? 'kiosk-demo-v1' : 'kiosk-local-v1';

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
    ...emptyStore(),
    badges: DEMO ? [1, 2, 3, 4, 5].map((n) => ({ badge: `V${n}`, tag: `DEMO000${n}`, status: 'available' })) : [],
  };
  return memo;
}

const clock = makeClock();
/** "2026-11-04" on this tablet's calendar. */
export const dayKey = clock.dayKey;

const engine = createEngine({
  version: BACKEND_VERSION,
  settings,
  saveSettings: (next) => (DEMO ? useSettings(next) : saveLocal(next)),
  files: photos,
  clock,
  demo: DEMO,
});

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
      out = await engine.act(s, action, a || {});
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
