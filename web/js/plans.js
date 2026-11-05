// Plans and licenses: the paywall, ready to switch on.
//
// With PAYWALL.enabled false (the default) every feature is available and no
// plan is shown anywhere. To start charging, see docs/PAYWALL.md:
//   1. node tools/license/keygen.mjs     makes your signing key; paste the public key below
//   2. set PAYWALL.enabled = true, and buyUrl to your checkout page
//   3. node tools/license/issue.mjs …    makes a license key for each customer
//
// A license key is signed with your private key (ECDSA P-256), so the kiosk
// can check it on its own, offline, and nobody can make one without that key.
//
// What a plan never takes away: visitors are always let through the sign-in,
// screening questions are always asked, records always keep being saved
// where they are, and the roll call always works. When a trial or license
// ends, the extras pause and the admin screen offers an upgrade.
import { settings } from './settings.js';

export const PAYWALL = {
  enabled: false,
  trialDays: 30,
  // Your checkout page (Stripe Payment Link, Lemon Squeezy, Gumroad…). Shown as a link and a QR code.
  buyUrl: '',
  // Where customers write for help with a license.
  supportEmail: '',
  // The public half of your signing key, from tools/license/keygen.mjs: { kty: 'EC', crv: 'P-256', x: '…', y: '…' }
  publicKey: null,
};

/** What each plan includes. Features not listed here are in every plan. */
export const FEATURES = {
  cloud: 'Google Sheets, several tablets and email alerts',
  screening: 'More than one screening question',
  hostEmails: 'Emails to hosts when their visitor arrives',
  expected: 'Expected visitors',
  languages: 'Spanish for visitors',
  quickEntry: 'Quick entry by face',
  export: 'CSV export of visits and visitors',
  dailySummary: 'Daily summary email',
  signatures: 'Signatures on the visitor rules',
};
export const FREE_LIMITS = { screeningQuestions: 1 };
export const PLANS = {
  free: { name: 'Free', features: [] },
  pro: { name: 'Pro', features: Object.keys(FEATURES) },
};

let state = { status: 'off', plan: 'pro', license: null, trialEndsAt: 0, daysLeft: 0, error: '' };

/** The current plan; refresh() works it out. */
export const entitlement = () => state;

/** Whether a feature can be used right now. */
export function can(feature) {
  if (!PAYWALL.enabled) return true;
  if (!FEATURES[feature]) return true;
  return (PLANS[state.plan]?.features || []).includes(feature);
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/**
 * Checks a license key. Resolves with its details ({ id, customer, plan,
 * tablets, expires }) or throws an Error with a message for the admin.
 */
export async function verifyLicense(text, publicKey = PAYWALL.publicKey) {
  const key = String(text || '').trim().replace(/\s+/g, '');
  const m = /^VSI1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(key);
  if (!m) throw new Error("That doesn't look like a license key. It starts with VSI1.");
  if (!publicKey || !crypto?.subtle) throw new Error("This copy of the kiosk can't check license keys yet.");
  const pub = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(m[2]), new TextEncoder().encode(`VSI1.${m[1]}`));
  if (!good) throw new Error("That license key isn't valid. Check it was copied completely.");
  let data;
  try { data = JSON.parse(new TextDecoder().decode(unb64url(m[1]))); } catch { throw new Error("That license key isn't valid."); }
  if (!PLANS[data.plan]) throw new Error('That license is for a plan this kiosk doesn\'t know. Update the kiosk.');
  return { id: String(data.id || ''), customer: String(data.customer || ''), plan: data.plan, tablets: Number(data.tablets) || 0, expires: String(data.expires || ''), issued: String(data.issued || '') };
}

/** Works out the plan from the saved license and trial. Call after settings change. */
export async function refresh(s = settings()) {
  if (!PAYWALL.enabled) { state = { status: 'off', plan: 'pro', license: null, trialEndsAt: 0, daysLeft: 0, error: '' }; return state; }
  let license = null, error = '';
  if (s.license) {
    try { license = await verifyLicense(s.license); } catch (err) { error = err.message; }
  }
  const now = Date.now();
  if (license) {
    const end = license.expires ? new Date(`${license.expires}T23:59:59`).getTime() : Infinity;
    if (end >= now) {
      state = { status: 'licensed', plan: license.plan, license, trialEndsAt: 0, daysLeft: end === Infinity ? Infinity : Math.ceil((end - now) / 86400000), error: '' };
      return state;
    }
    error = `The license for ${license.customer || 'this kiosk'} ended on ${license.expires}.`;
  }
  // Not set up yet: the trial starts when setup is finished, so setup itself is never locked.
  const started = s.trialStarted ? new Date(s.trialStarted).getTime() : now;
  const trialEndsAt = Number.isNaN(started) ? 0 : started + PAYWALL.trialDays * 86400000;
  if (trialEndsAt > now) {
    state = { status: 'trial', plan: 'pro', license, trialEndsAt, daysLeft: Math.ceil((trialEndsAt - now) / 86400000), error };
  } else {
    state = { status: license ? 'expired' : trialEndsAt ? 'trial-ended' : 'free', plan: 'free', license, trialEndsAt, daysLeft: 0, error };
  }
  return state;
}

/** For tools and tests: the text a license key signs. */
export const signedPart = (payload) => `VSI1.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
