// The kiosk's record engine: every action (signing in, badges, the admin screen)
// against one company's records. The on-tablet kiosk (js/api.js) and the cloud
// service (cloud/) both run it, so they follow exactly the same rules. It
// mirrors apps-script/Code.gs action for action.
//
// It knows nothing about where things are kept: the caller hands it the records
// (a plain object, see emptyStore), the settings, a place for photos and
// signatures, and a calendar.
import { nameKey, companyWords, sameCompany, near, normalizeTag } from './match.js';
import { hashPin } from './settings.js';

const ATTENTION_DAYS = 14;
const PASS_MS = 2 * 60 * 60 * 1000;

/** The actions a visitor's phone may use (with the phone key from the QR code), and nothing else. */
export const PHONE_ACTIONS = ['phoneStart', 'phoneRegister', 'phoneCheckIn', 'phoneSignOut', 'phoneDecline'];

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** A random code of letters and digits, from the system's secure random numbers. */
export const randomCode = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => CODE_ALPHABET[x % 36]).join('');
async function phoneHash(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`visitor-phone:${token}`)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Only what a visitor may send from a phone: no override, no quick entry, no expected-visitor lookup. */
const phoneArgs = (a) => ({
  first: a.first, last: a.last, company: a.company, visiting: a.visiting, purpose: a.purpose, agreed: a.agreed === true,
  photo: a.photo, answers: a.answers, flags: a.flags, reasons: a.reasons, signature: a.signature, agreement: a.agreement,
  language: a.language, email: a.email, method: 'phone',
});

/** A company with no records yet. */
export const emptyStore = () => ({ visitors: [], visits: [], faces: [], passes: [], expected: [], badges: [] });

/** Actions that only read: nothing to save afterwards. */
export const READS = new Set(['ping', 'getSettings', 'phoneStart', 'faceIndex', 'findVisitor', 'findOpenVisits', 'findExpected', 'adminLogin',
  'adminInside', 'adminBadges', 'adminAttention', 'adminHistory', 'adminVisitors', 'adminPhoto', 'adminExpected', 'adminSignature']);

/**
 * Dates on a calendar: the device's own (timeZone '') or a company's (an IANA
 * name such as 'America/Chicago', for the cloud, which runs in UTC).
 */
export function makeClock(timeZone = '') {
  const tz = timeZone || undefined;
  const parts = tz && new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return {
    /** "2026-11-04" on this calendar. */
    dayKey(d = new Date()) {
      const x = new Date(d);
      if (Number.isNaN(x.getTime())) return '';
      if (!parts) return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
      const p = Object.fromEntries(parts.formatToParts(x).map((q) => [q.type, q.value]));
      return `${p.year}-${p.month}-${p.day}`;
    },
    /** A date and time for people to read, such as "11/4/2026, 2:05:00 PM". */
    stamp: (d = new Date()) => new Date(d).toLocaleString(undefined, { timeZone: tz }),
    /** A date for people to read, such as "11/4/2026". */
    date: (d = new Date()) => new Date(d).toLocaleDateString(undefined, { timeZone: tz }),
  };
}

const randomId = (p) => p + Math.random().toString(36).slice(2, 10).toUpperCase();
const now = () => new Date().toISOString();
const clean = (v, max = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().replace(/^[=+\-@\s]+/, '').slice(0, max);
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

const isSignature = (x) => typeof x === 'string' && x.length < 400000 && /^data:image\/png;base64,/.test(x);
function cleanAgreement(x) {
  const ag = x && typeof x === 'object' ? x : {};
  return {
    title: clean(ag.title, 120) || 'Visitor rules',
    rules: (Array.isArray(ag.rules) ? ag.rules : []).slice(0, 20).map((r) => String(r || '').trim().slice(0, 800)).filter(Boolean),
    statement: clean(ag.statement, 300),
  };
}

function signOut(s, visit, by) {
  visit.signedOut = now();
  visit.signedOutBy = by;
  const b = s.badges.find((x) => x.badge === visit.badge);
  if (visit.badge && b && b.visitId === visit.id) Object.assign(b, { status: 'available', holder: '', visitorId: '', visitId: '', since: '' });
}

/**
 * The actions for one company.
 *   version       the backend version reported by ping
 *   settings()    the company's current settings (normalized)
 *   saveSettings  keeps new settings
 *   files         { put(key, dataUrl), get(key) → dataUrl or '', del(key) } for photos and signatures
 *   clock         from makeClock
 *   demo          demo mode: the admin PIN is always 123456
 * Returns { act(store, action, args) }, which changes the store in place; the
 * caller saves it afterwards unless the action is one of READS.
 */
export function createEngine({ version, settings, saveSettings, files, clock = makeClock(), demo = false, demoPin = '123456' }) {
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

  function screeningText(flags, override) {
    if (override) {
      const by = clean(override.by) || settings().admin.name || 'Admin';
      const reason = clean(override.reason);
      return `Overridden by ${by}${reason ? `: ${reason}` : ''}`;
    }
    if (flags.length) return `Flagged: ${[...new Set(flags.map((f) => f.flagLabel || f.label))].join(', ')}`;
    return 'Clear';
  }
  /** Today's expected visitor with this name (or id) who hasn't arrived yet. */
  function matchExpected(s, first, last, id) {
    const today = clock.dayKey();
    const list = s.expected.filter((e) => e.day === today && !e.arrived);
    return (id && list.find((e) => e.id === id))
      || list.find((e) => near(nameKey(e.first), nameKey(first)) && near(nameKey(e.last), nameKey(last))) || null;
  }

  async function startVisit(s, v, a, badgeNo, replacedBy) {
    const open = s.visits.find((x) => x.visitorId === v.id && !x.signedOut);
    if (open) signOut(s, open, replacedBy);
    const expected = matchExpected(s, v.first, v.last, a.expectedId);
    if (expected) expected.arrived = `Signed in ${clock.stamp()}`;
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
    // The signed rules: signed for this visit, or (on a first visit) the copy signed at registration.
    if (isSignature(a.signature)) {
      await files.put(`signature:${visit.id}`, a.signature);
      Object.assign(visit, { signature: `signature:${visit.id}`, agreement: cleanAgreement(a.agreement), signedLanguage: clean(a.language, 20) });
    } else if (!v.visits && v.signature) {
      Object.assign(visit, { signature: v.signature, agreement: v.agreement, signedLanguage: v.signedLanguage });
    }
    s.visits.push(visit);
    v.visits = (v.visits || 0) + 1;
    v.lastVisit = clock.date();
    v.lastVisitAt = now();
    return visit;
  }

  /** The visitor this phone signed in, if its token matches. */
  async function phonePerson(s, visitorId, token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const v = s.visitors.find((x) => x.id === String(visitorId || ''));
    return v && v.phoneKey && v.phoneKey === (await phoneHash(token)) ? v : null;
  }
  /** A visit started on a phone: with numbered passes, the phone tells them which pass to take. */
  function phoneVisit(s, a) {
    const st = settings();
    return act(s, st.passes && !st.badges ? 'assignPass' : 'checkIn', a);
  }

  async function act(s, action, a) {
    const st = settings();
    const byTag = (t) => s.badges.find((b) => normalizeTag(b.tag) === normalizeTag(t) && normalizeTag(t));
    switch (action) {
      case 'ping': return {
        ok: true, version, setupComplete: st.setupComplete,
        hasPin: demo || !!st.admin.pinHash, attention: attention(s).length,
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
        if (a.photo) await files.put(`visitor:${v.id}`, a.photo);
        if (isSignature(a.signature)) {
          await files.put(`signature:${v.id}`, a.signature);
          Object.assign(v, { signature: `signature:${v.id}`, agreement: cleanAgreement(a.agreement), signedAt: now(), signedLanguage: clean(a.language, 20) });
        }
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
        if (exp) exp.arrived = `Declined at the kiosk ${clock.stamp()}`;
        if (a.photo) await files.put(`decline:${id}`, a.photo);
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
        const visit = await startVisit(s, v, a, b.badge, `Switched to badge ${b.badge}`);
        Object.assign(b, { status: 'in use', holder: `${v.first} ${v.last}`, visitorId: v.id, visitId: visit.id, since: visit.signedIn, note: '' });
        return { ok: true, badge: b.badge, visitId: visit.id, expected: visit.expected };
      }
      case 'checkIn': {
        const v = s.visitors.find((x) => x.id === a.visitorId);
        if (!v) return { ok: false, error: 'not_found' };
        const visit = await startVisit(s, v, a, '', 'Signed in again');
        return { ok: true, visitId: visit.id, expected: visit.expected };
      }
      case 'assignPass': {
        // Numbered passes (no reader): the pass they hold, or the free one with the lowest number.
        const v = s.visitors.find((x) => x.id === a.visitorId);
        if (!v) return { ok: false, error: 'not_found' };
        const open = s.visits.find((x) => x.visitorId === v.id && !x.signedOut);
        const held = open && open.badge ? s.badges.find((x) => x.badge === open.badge) : null;
        const passNo = (no) => { const m = /(\d+)/.exec(String(no)); return m ? Number(m[1]) : 1e9; };
        const free = s.badges.filter((x) => (x.status || 'available') === 'available').sort((x, y) => passNo(x.badge) - passNo(y.badge))[0];
        const pass = held || free || null;
        const visit = await startVisit(s, v, a, pass ? pass.badge : '', 'Signed in again');
        if (pass) Object.assign(pass, { status: 'in use', holder: `${v.first} ${v.last}`, visitorId: v.id, visitId: visit.id, since: visit.signedIn, note: '' });
        return { ok: true, badge: pass ? pass.badge : '', noPass: !pass, visitId: visit.id, expected: visit.expected };
      }
      case 'purgeOld': {
        const days = Number(st.retentionDays) || 0;
        if (days < 30) return { ok: true, removed: null };
        const cutoff = Date.now() - days * 86400000;
        const old = (iso) => { const t = new Date(iso).getTime(); return !Number.isNaN(t) && t < cutoff; };
        const before = { visits: s.visits.length, visitors: s.visitors.length, expected: s.expected.length };
        for (const v of s.visits) {
          if (!v.signedOut || !old(v.signedIn)) continue;
          if (v.photo) await files.del(v.photo);
          if (v.signature && v.signature !== `signature:${v.visitorId}`) await files.del(v.signature);
        }
        s.visits = s.visits.filter((v) => !(v.signedOut && old(v.signedIn)));
        const gone = new Set(s.visitors.filter((v) => old(v.lastVisitAt || v.registered)).map((v) => v.id));
        for (const id of gone) { await files.del(`visitor:${id}`); await files.del(`signature:${id}`); }
        s.visitors = s.visitors.filter((v) => !gone.has(v.id));
        s.faces = s.faces.filter((f) => !gone.has(f.visitorId));
        const day = clock.dayKey(cutoff);
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
          if (b && b.status === 'available') Object.assign(b, { status: 'not returned', note: `Not returned by ${v.first} ${v.last} (${clock.date(v.signedIn)})` });
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
        const good = demo ? a.pin === demoPin : !!st.admin.pinHash && (await hashPin(String(a.pin || ''))) === st.admin.pinHash;
        if (!good) {
          pinFails.n += 1;
          if (pinFails.n >= 10) pinFails = { n: 0, until: Date.now() + 10 * 60 * 1000 };
          return { ok: false, error: demo || st.admin.pinHash ? 'pin' : 'no_pin' };
        }
        pinFails = { n: 0, until: 0 };
        return { ok: true, token: newToken(), ttl: 900 };
      }
      case 'adminSetPin': {
        const pin = String(a.pin || '');
        if (!/^\d{6,8}$/.test(pin)) return { ok: false, error: 'pin_format' };
        if ((demo || st.admin.pinHash) && !checkToken(a.token)) return { ok: false, error: 'admin' };
        if (!demo) saveSettings({ ...st, admin: { ...st.admin, pinHash: await hashPin(pin) } });
        return { ok: true, token: newToken(), ttl: 900 };
      }

      // ---------------------------------------------------------- phone sign-in (a QR code by the door)
      // The server checks the phone key and allows a phone only these actions
      // (PHONE_ACTIONS). Each visitor's phone keeps a secret token, and only its
      // hash is kept here, so a phone can sign in again, or out, only the visitor it signed in.
      case 'phoneStart': {
        if (!st.setupComplete) return { ok: false, error: 'not_set_up' };
        return {
          ok: true, version, logo: st.org.logo || '',
          settings: {
            setupComplete: true, storage: 'cloud', badges: false, passes: !!st.passes && !st.badges, quickEntry: false, hosts: [], notifyHosts: false,
            org: { name: st.org.name || '', tagline: st.org.tagline || '', accent: st.org.accent || '' },
            form: st.form, screening: { questions: st.screening.questions || [], declineMessage: st.screening.declineMessage || '' },
            photos: st.photos, languages: st.languages, translations: st.translations, signature: { ...st.signature, emailCopy: false },
            trialStarted: st.trialStarted || '', phone: st.phone || {},
          },
        };
      }
      case 'phoneRegister': {
        const args = phoneArgs(a);
        const reg = await act(s, 'register', args);
        if (!reg.ok) return reg;
        const token = randomCode(32);
        const v = s.visitors.find((x) => x.id === reg.visitor.id);
        v.phoneKey = await phoneHash(token);
        const started = await phoneVisit(s, { visitorId: v.id, method: 'phone', flags: args.flags, visiting: args.visiting, purpose: args.purpose });
        return { ok: true, visitor: reg.visitor, visitId: started.visitId, hostNotified: false, badge: started.badge || '', noPass: !!started.noPass, token };
      }
      case 'phoneCheckIn': {
        const v = await phonePerson(s, a.visitorId, a.token);
        if (!v) return { ok: false, error: 'phone_visitor' };
        const args = phoneArgs(a);
        // Staff may have let them in after a decline (Needs attention → Let in): that approval is kept with the visit.
        const pass = takePass(s, v.first, v.last);
        const started = await phoneVisit(s, {
          visitorId: v.id, method: 'phone', flags: pass ? [] : args.flags, visiting: args.visiting, purpose: args.purpose,
          signature: args.signature, agreement: args.agreement, language: args.language, override: pass || undefined,
        });
        return { ok: true, visitId: started.visitId, hostNotified: false, badge: started.badge || '', noPass: !!started.noPass, first: v.first };
      }
      case 'phoneSignOut': {
        const visit = s.visits.find((x) => x.id === a.visitId);
        if (!visit) return { ok: false, error: 'not_found' };
        if (!(await phonePerson(s, visit.visitorId, a.token))) return { ok: false, error: 'phone_visitor' };
        if (visit.signedOut) return { ok: true, already: true, first: visit.first };
        signOut(s, visit, 'Signed out on their phone');
        return { ok: true, first: visit.first, badge: visit.badge || '' };
      }
      case 'phoneDecline': {
        // If staff already let them in, the phone carries on, and the approval stays for phoneRegister or phoneCheckIn.
        const key = passKey(clean(a.first), clean(a.last));
        const pass = (s.passes || []).find((x) => x.key === key && x.until > Date.now());
        if (pass) return { ok: true, passed: true, reason: pass.reason || '', by: pass.by || '' };
        return act(s, 'recordDecline', phoneArgs(a));
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
            screening: v.screening, photo: v.photo ? await files.get(v.photo) : '', inside: !v.signedOut,
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
            method: v.method, signedOutBy: v.signedOutBy || '', screening: v.screening || '', hostNotified: '', signedCopy: v.signature ? 'on this tablet' : '',
          });
        }
        return { ok: true, visits: out };
      }
      case 'adminExpected': {
        const days = Math.max(1, Math.min(90, Number(a.days) || 14));
        const from = clock.dayKey(Date.now() - 86400000), to = clock.dayKey(Date.now() + days * 86400000);
        const list = s.expected.filter((e) => e.day >= from && e.day <= to).sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
        return { ok: true, today: clock.dayKey(), expected: list.map((e) => ({ ...e })) };
      }
      case 'adminAddExpected': {
        const e = {
          id: randomId('E'), day: /^\d{4}-\d{2}-\d{2}$/.test(a.day || '') ? a.day : '',
          first: clean(a.first), last: clean(a.last), company: clean(a.company), host: clean(a.host),
          purpose: clean(a.purpose), note: clean(a.note), arrived: '', addedBy: `${st.admin.name || 'Admin'} (${clock.stamp()})`,
        };
        if (!e.first || !e.last) return { ok: false, error: 'missing', fields: ['first', 'last'] };
        if (!e.day) return { ok: false, error: 'missing', fields: ['day'] };
        s.expected.push(e);
        // Keep a year of history at most.
        const oldest = clock.dayKey(Date.now() - 365 * 86400000);
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
      case 'adminSignature': {
        const v = s.visits.find((x) => x.id === a.visitId);
        if (!v || !v.signature) return { ok: false, error: 'not_found' };
        return {
          ok: true, signature: await files.get(v.signature), agreement: v.agreement || null, signedCopy: '',
          first: v.first, last: v.last, company: v.company, when: v.signedIn, language: v.signedLanguage || '',
        };
      }
      case 'adminPhoto': {
        const v = s.visits.find((x) => x.id === a.visitId);
        if (!v) return { ok: false, error: 'not_found' };
        return { ok: true, photo: (v.photo && await files.get(v.photo)) || await files.get(`visitor:${v.visitorId}`) };
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
        saveSettings(next);
        return { ok: true };
      }
      case 'adminPhoneLink': {
        // Switches phone sign-in on (making the key the QR code carries), changes the key (a new QR code), or off; peek only reads it.
        if (a.off) { s.phoneKey = ''; return { ok: true, key: '' }; }
        if (a.peek) return { ok: true, key: s.phoneKey || '' };
        if (!s.phoneKey || a.change) s.phoneKey = `ph${randomCode(30)}`;
        return { ok: true, key: s.phoneKey };
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

  return { act };
}
