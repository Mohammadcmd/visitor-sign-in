// Talks to the Apps Script backend, or to an in-browser stand-in in demo mode.
import { CONFIG } from '../config.js';
import { nameKey, companyWords, sameCompany, near, normalizeTag } from './match.js';

export const DEMO = !CONFIG.API_URL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_WAITS = [0, 1500, 4000];
const TIMEOUT_MS = 20000;
const OUTBOX = 'shocktech-kiosk-outbox';
const OUTBOX_MAX = 40;

/** Tells the page whether the backend is reachable (for the "Offline" indicator). */
function reportNet(ok) {
  window.dispatchEvent(new CustomEvent('kiosk-net', { detail: { ok } }));
}

const requestId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function send(action, args, rid) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // text/plain keeps this a "simple" request, so the browser skips the CORS
    // preflight that Apps Script can't answer.
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: CONFIG.KIOSK_KEY, action, args, rid }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls the backend, retrying a couple of times on a network hiccup. Every
 * attempt carries the same request id, so the backend answers a repeat with
 * the first result instead of writing twice.
 */
export async function call(action, args = {}, rid = requestId()) {
  if (DEMO) return demo(action, args);
  let lastErr;
  for (const wait of RETRY_WAITS) {
    if (wait) await sleep(wait);
    try {
      const out = await send(action, args, rid);
      reportNet(true);
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  reportNet(false);
  throw lastErr;
}

/**
 * For calls nobody waits on (a new face photo, say): kept on the tablet and
 * sent whenever the backend is reachable, so a Wi-Fi drop loses nothing.
 */
export function queue(action, args) {
  if (DEMO) { demo(action, args); return; }
  const box = readOutbox();
  box.push({ action, args, rid: requestId() });
  writeOutbox(box.slice(-OUTBOX_MAX));
  flushOutbox();
}

let flushing = false;
export async function flushOutbox() {
  if (DEMO || flushing) return;
  flushing = true;
  try {
    for (let box = readOutbox(); box.length; box = readOutbox()) {
      const item = box[0];
      try {
        await call(item.action, item.args, item.rid);
      } catch {
        return; // still offline; try again later
      }
      writeOutbox(readOutbox().filter((x) => x.rid !== item.rid));
    }
  } finally {
    flushing = false;
  }
}

function readOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX)) || []; } catch { return []; }
}

function writeOutbox(box) {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify(box));
  } catch {
    // Storage full: drop the oldest item and try once more.
    try { localStorage.setItem(OUTBOX, JSON.stringify(box.slice(1))); } catch { /* give up on this one */ }
  }
}

if (!DEMO) {
  window.addEventListener('online', flushOutbox);
  setInterval(flushOutbox, 30 * 1000);
  setTimeout(flushOutbox, 3000);
}

// ------------------------------------------------------------------ demo mode

const STORE = 'shocktech-kiosk-demo-v1';
const DEMO_PIN = '123456';
const US_PERSON = ['U.S. citizen', 'Lawful permanent resident (green card holder)',
  'Protected individual (asylee or refugee)'];

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && s.badges) return s;
  } catch { /* fall through to a fresh store */ }
  return {
    visitors: [], visits: [], faces: [], photos: {},
    badges: [1, 2, 3, 4, 5].map((n) => ({ badge: `V${n}`, tag: `DEMO000${n}`, status: 'available' })),
  };
}

function save(s) {
  try { localStorage.setItem(STORE, JSON.stringify(s)); } catch {
    // Photos can overflow storage; keep the records and drop stored photos.
    s.photos = {};
    try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* demo only */ }
  }
}

const rid = (p) => p + Math.random().toString(36).slice(2, 10).toUpperCase();
const now = () => new Date().toISOString();

async function demo(action, a) {
  await new Promise((r) => setTimeout(r, 250));
  const s = load();
  const out = demoAction(s, action, a);
  save(s);
  return out;
}

function signOut(s, visit, by) {
  visit.signedOut = now();
  visit.signedOutBy = by;
  const b = s.badges.find((x) => x.badge === visit.badge);
  if (b && b.visitId === visit.id) Object.assign(b, { status: 'available', holder: '', visitorId: '', visitId: '', since: '' });
}

function demoAction(s, action, a) {
  const byTag = (t) => s.badges.find((b) => normalizeTag(b.tag) === normalizeTag(t) && normalizeTag(t));
  switch (action) {
    case 'ping': return { ok: true };
    case 'faceIndex': return {
      ok: true,
      people: s.visitors.filter((v) => v.quickEntry).map((v) => ({
        id: v.id, first: v.first, last: v.last, company: v.company,
        descriptors: s.faces.filter((f) => f.visitorId === v.id).slice(-12).map((f) => f.descriptor),
      })).filter((p) => p.descriptors.length),
    };
    case 'register': {
      const v = { id: rid('P'), ...a, registered: now(), visits: 0 };
      delete v.photo; delete v.descriptor;
      s.visitors.push(v);
      s.photos[v.id] = [a.photo];
      if (a.quickEntry && a.descriptor) s.faces.push({ visitorId: v.id, descriptor: a.descriptor });
      return { ok: true, visitor: { id: v.id, first: v.first, last: v.last, company: v.company, quickEntry: !!v.quickEntry } };
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
    case 'addFaceSample': {
      const v = s.visitors.find((x) => x.id === a.visitorId);
      if (!v) return { ok: false, error: 'not_found' };
      if (!v.quickEntry) return { ok: true, saved: false };
      s.faces.push({ visitorId: v.id, descriptor: a.descriptor });
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
      const open = s.visits.find((x) => x.visitorId === v.id && !x.signedOut);
      if (open) signOut(s, open, `Switched to badge ${b.badge}`);
      const visit = {
        id: rid('S'), visitorId: v.id, first: v.first, last: v.last, company: v.company,
        visiting: v.visiting, kind: US_PERSON.includes(v.citizenship) ? 'Visitor' : 'Foreign national',
        badge: b.badge, method: a.method, signedIn: now(),
      };
      s.visits.push(visit);
      Object.assign(b, { status: 'in use', holder: `${v.first} ${v.last}`, visitorId: v.id, visitId: visit.id, since: visit.signedIn });
      v.visits += 1; v.lastVisit = new Date().toLocaleDateString();
      return { ok: true, badge: b.badge, visitId: visit.id };
    }
    case 'tapAtWelcome': {
      const b = byTag(a.tag);
      if (!b) return { ok: true, result: 'unknown' };
      if (b.status !== 'in use') return { ok: true, result: 'not_out', badge: b.badge };
      const visit = s.visits.find((x) => x.id === b.visitId);
      const name = b.holder, visitId = b.visitId, badge = b.badge;
      if (visit) signOut(s, visit, 'Badge tap at kiosk');
      return { ok: true, result: 'signed_out', badge, name, first: visit ? visit.first : name, visitId };
    }
    case 'undoSignOut': {
      const visit = s.visits.find((x) => x.id === a.visitId);
      if (!visit || !visit.signedOut) return { ok: false, error: 'not_found' };
      const b = s.badges.find((x) => x.badge === visit.badge);
      if (!b || b.status === 'in use') return { ok: false, error: 'badge_in_use' };
      visit.signedOut = ''; visit.signedOutBy = '';
      Object.assign(b, { status: 'in use', holder: `${visit.first} ${visit.last}`, visitorId: visit.visitorId, visitId: visit.id, since: visit.signedIn });
      return { ok: true };
    }
    case 'adminLogin':
      return a.pin === DEMO_PIN ? { ok: true, token: 'demo', ttl: 900 } : { ok: false, error: 'pin' };
  }
  if (a.token !== 'demo') return { ok: false, error: 'admin' };
  switch (action) {
    case 'adminInside': return {
      ok: true,
      inside: s.visits.filter((v) => !v.signedOut).map((v) => ({
        visitId: v.id, first: v.first, last: v.last, company: v.company, visiting: v.visiting,
        kind: v.kind, badge: v.badge, since: v.signedIn,
      })),
    };
    case 'adminBadges': return { ok: true, badges: s.badges.map((b) => ({ badge: b.badge, tag: b.tag || '', status: b.status, holder: b.holder || '', since: b.since || '' })) };
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
      return { ok: true };
    }
  }
  return { ok: false, error: 'unknown_action' };
}
