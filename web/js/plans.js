// Licenses: each kiosk tablet is sold with a license that's renewed yearly.
// Ready to switch on (see docs/PAYWALL.md).
//
// With PAYWALL.enabled false (the default) the kiosk is free to use and no
// license is ever mentioned.
//
// A license key is signed with your private key (ECDSA P-256), so the kiosk
// checks it on its own, offline, and nobody can make one without that key. Each
// key names one tablet (its tablet code, shown in Admin → Settings → License)
// and the date it's paid until. It only works on that tablet.
//
// When the yearly fee isn't paid (nothing is ever deleted or hidden):
//   - From warnDays before the paid-until date, the admin screen reminds the staff.
//   - For graceDays after it, everything keeps working; the admin screen says it's overdue.
//   - After that, or once you switch the license off: new sign-ins pause. Signing
//     out, badge returns, the roll call, the admin screen and exports keep
//     working, so nobody is stuck inside and the business always has its records.
//     A renewed key turns it straight back on.
// The trial works the same way: everything for trialDays after setup, then a
// license is needed.
//
// Switching a license off early (a bounced check) or renewing it without
// anyone typing a key: when online, the kiosk reads its license's status file
// from PAYWALL.statusUrl a few times a day. tools/license/status.mjs writes
// those files; put the folder on any website.
import { settings } from './settings.js';

export const PAYWALL = {
  enabled: false,
  trialDays: 30,
  graceDays: 14,
  warnDays: 30,
  // Who sells the kiosk, shown on the license screen and when a kiosk is paused.
  seller: '',
  supportEmail: '',
  supportPhone: '',
  // Shown on the license screen, such as '$499 per kiosk, then $149 a year'.
  price: '',
  // Your checkout page (a Stripe Payment Link…). Shown as a link and a QR code. Checks are welcome too.
  buyUrl: '',
  // Where the license status files are (tools/license/status.mjs), such as 'https://licenses.example.com/'.
  statusUrl: '',
  // The public half of your signing key, from tools/license/keygen.mjs: { kty: 'EC', crv: 'P-256', x: '…', y: '…' }
  publicKey: null,
};

/** What a license includes (every feature; listed on the license screen). */
export const FEATURES = {
  cloud: 'Google Sheets, several tablets and email alerts',
  screening: 'Screening questions',
  hostEmails: 'Emails to hosts when their visitor arrives',
  expected: 'Expected visitors',
  languages: 'Spanish for visitors',
  quickEntry: 'Quick entry by face',
  export: 'CSV export of visits and visitors',
  dailySummary: 'Daily summary email',
  signatures: 'Signatures on the visitor rules',
};
export const FREE_LIMITS = { screeningQuestions: Infinity };
export const PLANS = { pro: { name: 'Kiosk license', features: Object.keys(FEATURES) } };

/**
 * Whether a feature can be used. A license covers every feature, and a kiosk
 * without one is paused at the welcome screen instead (see isPaused), so the
 * admin screen, exports and settings always keep working.
 */
export const can = () => true;

// ------------------------------------------------------------------ this tablet

const KEYS = { code: 'kiosk-tablet-code', license: 'kiosk-license-v1', status: 'kiosk-license-status-v1', time: 'kiosk-server-time' };
const local = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage not available */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage not available */ } },
};
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
let code = null;

/** This tablet's code, such as K7M2-9XQ4: made once, kept with the kiosk's data. A license names it. */
export function tabletCode() {
  if (code) return code;
  const saved = local.get(KEYS.code);
  if (CODE_RE.test(saved || '')) { code = saved; return code; }
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => alphabet[b % 32]).join('');
  code = `${chars.slice(0, 4)}-${chars.slice(4)}`;
  local.set(KEYS.code, code);
  return code;
}

/** The latest time a server has told us, so setting the tablet's clock back doesn't stretch a license. */
function trustedNow() {
  const server = Number(local.get(KEYS.time)) || 0;
  return Math.max(Date.now(), server);
}

// ------------------------------------------------------------------ keys and status files

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function verifySigned(prefix, text, publicKey) {
  const m = new RegExp(`^${prefix}\\.([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)$`).exec(String(text || '').trim().replace(/\s+/g, ''));
  if (!m) return { error: 'format' };
  if (!publicKey || !crypto?.subtle) return { error: 'no_key' };
  const pub = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(m[2]), new TextEncoder().encode(`${prefix}.${m[1]}`));
  if (!good) return { error: 'signature' };
  try { return { data: JSON.parse(new TextDecoder().decode(unb64url(m[1]))) }; } catch { return { error: 'signature' }; }
}

/**
 * Checks a license key. Resolves with its details ({ id, customer, tablet,
 * expires, issued }) or throws an Error with a message for the admin. With
 * forTablet, a key for another tablet is refused.
 */
export async function verifyLicense(text, publicKey = PAYWALL.publicKey, forTablet = '') {
  const { data, error } = await verifySigned('VSI1', text, publicKey);
  if (error === 'format') throw new Error("That doesn't look like a license key. It starts with VSI1.");
  if (error === 'no_key') throw new Error("This copy of the kiosk can't check license keys yet.");
  if (error) throw new Error("That license key isn't valid. Check it was copied completely.");
  if (!PLANS[data.plan]) throw new Error("That license is for something this kiosk doesn't know. Update the kiosk.");
  const info = {
    id: String(data.id || ''), customer: String(data.customer || ''), plan: data.plan, tablet: String(data.tablet || ''),
    tablets: Number(data.tablets) || 0, expires: String(data.expires || ''), issued: String(data.issued || ''),
  };
  if (forTablet && info.tablet && info.tablet !== forTablet) {
    throw new Error(`That license is for tablet ${info.tablet}. This tablet is ${forTablet}: ask for a key for this tablet.`);
  }
  return info;
}

/** Checks a license status file: { id, status: 'active' | 'off', key (a renewed license), at }. */
export async function verifyStatus(text, publicKey = PAYWALL.publicKey) {
  const { data, error } = await verifySigned('VSS1', text, publicKey);
  if (error) return null;
  return { id: String(data.id || ''), status: data.status === 'off' ? 'off' : 'active', key: String(data.key || ''), at: String(data.at || '') };
}

/** For tools and tests: the text a license key or status file signs. */
export const signedPart = (payload, prefix = 'VSI1') => `${prefix}.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`;

// ------------------------------------------------------------------ the license, worked out

const OFF = { status: 'off', license: null, daysLeft: 0, until: '', reason: '', error: '', renewSoon: false, tablet: '' };
let state = OFF;

/** The license state: 'off' (no paywall), 'trial', 'licensed', 'grace' (overdue but working) or 'paused'. */
export const entitlement = () => state;

/** New sign-ins are paused: the trial ended, the license lapsed (after the grace period), or it was switched off. */
export const isPaused = () => state.status === 'paused';

const endOfDay = (ymd) => new Date(`${ymd}T23:59:59`).getTime();
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const days = (ms) => Math.max(0, Math.ceil(ms / 86400000));

/** This tablet's license key (kept on this tablet: each tablet has its own). */
export const savedKey = () => local.get(KEYS.license) || '';

/** Keeps a checked license key on this tablet. */
export function saveKey(text) {
  local.set(KEYS.license, String(text || '').trim());
}

/** Works out the license from the key on this tablet, its status file and the trial. Call after anything changes. */
export async function refresh(s = settings()) {
  if (!PAYWALL.enabled) { state = OFF; return state; }
  const tablet = tabletCode();
  const now = trustedNow();
  let license = null, error = '';
  const key = savedKey() || s.license || '';
  if (key) {
    try { license = await verifyLicense(key, PAYWALL.publicKey, tablet); } catch (err) { error = err.message; }
  }

  // The status file you publish: a renewal to pick up, or the license switched off.
  const status = license && await verifyStatus(local.get(KEYS.status));
  if (license && status && status.id === license.id) {
    if (status.key && status.key !== key) {
      try {
        const renewed = await verifyLicense(status.key, PAYWALL.publicKey, tablet);
        if (renewed.id === license.id && (!renewed.expires || renewed.expires > license.expires)) { saveKey(status.key); license = renewed; }
      } catch { /* a renewal for another tablet: ignore it */ }
    }
    if (status.status === 'off') {
      state = { ...OFF, status: 'paused', license, reason: 'off', tablet, error: '' };
      return state;
    }
  }

  if (license) {
    const end = license.expires ? endOfDay(license.expires) : Infinity;
    if (now <= end) {
      const left = end === Infinity ? Infinity : days(end - now);
      state = { ...OFF, status: 'licensed', license, daysLeft: left, until: license.expires, renewSoon: left <= PAYWALL.warnDays, tablet };
      return state;
    }
    const graceEnd = end + PAYWALL.graceDays * 86400000;
    if (now <= graceEnd) {
      state = { ...OFF, status: 'grace', license, daysLeft: days(graceEnd - now), until: ymd(graceEnd), renewSoon: true, tablet };
      return state;
    }
    state = { ...OFF, status: 'paused', license, reason: 'lapsed', until: license.expires, tablet };
    return state;
  }

  // No license: the trial starts when setup is finished, so setup itself is never paused.
  const started = s.trialStarted ? new Date(s.trialStarted).getTime() : now;
  const trialEnd = Number.isNaN(started) ? now : started + PAYWALL.trialDays * 86400000;
  if (now < trialEnd) {
    state = { ...OFF, status: 'trial', daysLeft: days(trialEnd - now), until: ymd(trialEnd), tablet, error };
  } else {
    state = { ...OFF, status: 'paused', reason: 'trial', until: ymd(trialEnd), tablet, error };
  }
  return state;
}

/**
 * Reads this license's status file (when online) and works the license out
 * again. A missing file or no network changes nothing.
 */
export async function checkStatus(fetchImpl = (url, init) => fetch(url, init)) {
  await refresh();
  if (!PAYWALL.enabled || !PAYWALL.statusUrl || !state.license?.id) return state;
  try {
    const url = `${PAYWALL.statusUrl.replace(/\/?$/, '/')}${encodeURIComponent(state.license.id)}.txt`;
    const res = await fetchImpl(url, { cache: 'no-store' });
    const date = Date.parse(res.headers.get('Date') || '');
    if (date && date > (Number(local.get(KEYS.time)) || 0)) local.set(KEYS.time, String(date));
    if (res.ok) {
      const text = (await res.text()).trim();
      const status = await verifyStatus(text);
      if (status && status.id === state.license.id) {
        const at = Date.parse(status.at);
        if (at && at > (Number(local.get(KEYS.time)) || 0)) local.set(KEYS.time, String(at));
        local.set(KEYS.status, text);
      }
    }
  } catch { /* offline: try again later */ }
  return refresh();
}

/** For tests: forget this tablet's license, status and code. */
export function forgetTablet() {
  for (const k of Object.values(KEYS)) local.del(k);
  code = null;
}
