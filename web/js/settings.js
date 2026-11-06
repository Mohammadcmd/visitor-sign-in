// Kiosk settings: everything that makes the kiosk yours. The company name,
// logo and colors, the visitor questions, rules and screening.
//
// Chosen in the setup wizard (js/setup.js). Kept on the tablet, and when the
// kiosk is connected to Google Sheets, also in the sheet's hidden Settings tab,
// so every tablet connected to that sheet shares them.

const LOCAL_KEY = 'kiosk-settings-v1';
const CACHE_KEY = 'kiosk-settings-cache-v1';

export const DEFAULT_DECLINE = 'Thank you for visiting {company}. Unfortunately, we are unable to sign you in today. We apologize for any inconvenience.';

export const DEFAULT_RULES = [
  'I will stay with my host or escort at all times while I am past the front desk.',
  'I will not take photos, video or audio recordings in production or restricted areas.',
  'Anything confidential I see or hear during my visit stays confidential.',
  'I will follow all safety instructions and wear any protective equipment I am given.',
  'I will sign out before I leave and return any visitor badge I was given.',
];

export const DEFAULT_PURPOSES = ['Meeting', 'Interview', 'Delivery', 'Supplier visit', 'Contractor or maintenance', 'Other'];

/** Ready-made screening questions offered in the setup wizard. */
export const QUESTION_TEMPLATES = [
  {
    key: 'us-person', name: 'U.S. person (ITAR / EAR)',
    label: 'Citizenship status', text: 'Citizenship status',
    hint: 'Required by U.S. export law. The front desk may confirm it against your photo ID.',
    type: 'choice',
    options: [
      'U.S. citizen',
      'Lawful permanent resident (green card holder)',
      'Protected individual (asylee or refugee)',
      'Not a U.S. citizen or permanent resident',
    ],
    rule: { answers: ['Not a U.S. citizen or permanent resident'], action: 'decline', flagLabel: 'Foreign national' },
    followUp: {
      answers: ['Lawful permanent resident (green card holder)', 'Protected individual (asylee or refugee)', 'Not a U.S. citizen or permanent resident'],
      label: 'Country of citizenship', otherwise: 'United States',
    },
    every: false,
    intro: "Some of the products and technical data we work with are controlled under U.S. export laws (ITAR and EAR). To follow these laws, we need to know each visitor's citizenship status before they go past the front desk.",
  },
  {
    key: 'illness', name: 'Illness symptoms', label: 'Illness symptoms',
    text: 'Do you have symptoms of a contagious illness today, such as a fever or a cough?',
    type: 'yesno', rule: { answers: ['Yes'], action: 'decline' }, every: true,
  },
  {
    key: 'prohibited', name: 'Prohibited items', label: 'Prohibited items',
    text: 'Are you carrying any weapons or other prohibited items?',
    type: 'yesno', rule: { answers: ['Yes'], action: 'decline' }, every: true,
  },
  {
    key: 'induction', name: 'Safety induction', label: 'Safety induction',
    text: 'Have you completed our site safety induction?',
    type: 'yesno', rule: { answers: ['No'], action: 'flag', flagLabel: 'Needs induction' }, every: false,
  },
  {
    key: 'tools', name: 'Tools & equipment', label: 'Tools or equipment',
    text: 'Are you bringing any tools or equipment on site today?',
    type: 'yesno', rule: { answers: ['Yes'], action: 'flag', flagLabel: 'Bringing tools' }, every: true,
  },
  {
    key: 'nda', name: 'NDA on file', label: 'NDA on file',
    text: 'Has your company signed a non-disclosure agreement with us?',
    type: 'choice', options: ['Yes', 'No', 'Not sure'],
    rule: { answers: ['No', 'Not sure'], action: 'flag', flagLabel: 'Check NDA' }, every: false,
  },
  {
    key: 'access', name: 'Accessibility', label: 'Accessibility help',
    text: 'Would you like any accessibility assistance during your visit?',
    type: 'yesno', rule: { answers: ['Yes'], action: 'flag', flagLabel: 'Needs assistance' }, every: true,
  },
];

export const DEFAULTS = Object.freeze({
  version: 1,
  setupComplete: false,
  org: { name: '', tagline: '', accent: '#0a5ea8', logo: '' },
  admin: { name: '', pinHash: '' },
  storage: 'local',            // 'local': this tablet | 'cloud': Google Sheets
  badges: true,                // visitors tap an NFC/RFID badge to finish signing in and to sign out
  passes: false,               // no reader: numbered visitor passes, and the kiosk tells each visitor which one to take
  form: {
    askHost: true,
    askPurpose: true,
    hostLabel: 'Who are you visiting at {company}?',
    hostHint: 'The person you are meeting.',
    purposes: DEFAULT_PURPOSES,
    rules: DEFAULT_RULES,
    intro: '',
  },
  screening: { questions: [], declineMessage: DEFAULT_DECLINE, alertEmails: '' },
  photos: 'all',               // 'all' | 'declined' (only declined visitors) | 'off'
  quickEntry: true,            // face recognition for returning visitors (opt-in for each visitor)
  hosts: [],                   // [{ name, email }]: suggested as visitors type, emailed on arrival (Google Sheets)
  notifyHosts: true,
  endOfDay: '',                // 'HH:MM': sign everyone still inside out at this time each day; '' = never
  dailySummary: false,         // Google Sheets: email the alert addresses a summary at the end-of-day time
  retentionDays: 0,            // delete visits, visitors and photos older than this (0 = keep everything)
  languages: ['en'],           // languages visitors can choose; English is always first
  translations: {},            // { es: { "English text": "texto" } } for the business's own text
  signature: { mode: 'off', emailCopy: false }, // visitors sign the rules: 'off' (tick box), 'new' visitors, 'every' visit
  license: '',                 // a license key from the vendor (see js/plans.js)
  phone: { code: '', license: '' }, // phone sign-in by QR code (Google Sheets): the QR code's license code and key
  agreement: { version: '', by: '', at: '' }, // who accepted the license agreement, when, and which version (licensing on)
  trialStarted: '',            // when setup was first finished: the Pro trial runs from here
});

const VISITOR_LANGS = ['en', 'es'];

function translationMap(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const code of VISITOR_LANGS.slice(1)) {
    const src = v[code];
    if (!src || typeof src !== 'object') continue;
    const m = {};
    let n = 0;
    for (const [k, val] of Object.entries(src)) {
      if (n >= 400) break;
      const key = typeof k === 'string' ? k.trim().slice(0, 600) : '';
      const text = typeof val === 'string' ? val.trim().slice(0, 600) : '';
      if (key && text) { m[key] = text; n++; }
    }
    if (n) out[code] = m;
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hostList(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  return v.map((h) => ({ name: str(h && h.name, 60), email: str(h && h.email, 120).toLowerCase() }))
    .map((h) => ({ ...h, email: EMAIL_RE.test(h.email) ? h.email : '' }))
    .filter((h) => h.name && !seen.has(h.name.toLowerCase()) && seen.add(h.name.toLowerCase()))
    .slice(0, 300);
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, max = 30, len = 300) => (Array.isArray(v) ? v.map((x) => str(String(x ?? ''), len)).filter(Boolean).slice(0, max) : null);
export const uid = () => Math.random().toString(36).slice(2, 10);

/** One screening question, with everything it can have and nothing it shouldn't. */
export function normalizeQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const type = ['yesno', 'choice', 'text'].includes(q.type) ? q.type : 'yesno';
  const options = type === 'yesno' ? ['Yes', 'No'] : type === 'choice' ? (list(q.options, 12, 120) || []) : [];
  const text = str(q.text, 240);
  const label = str(q.label, 60) || text.slice(0, 60);
  const rule = q.rule && typeof q.rule === 'object' ? q.rule : {};
  const action = type !== 'text' && ['none', 'decline', 'flag'].includes(rule.action) ? rule.action : 'none';
  const answers = (list(rule.answers, 12, 120) || []).filter((a) => options.includes(a));
  let followUp = null;
  if (q.followUp && typeof q.followUp === 'object' && type !== 'text') {
    const fa = (list(q.followUp.answers, 12, 120) || []).filter((a) => options.includes(a));
    const fl = str(q.followUp.label, 60);
    if (fa.length && fl) followUp = { answers: fa, label: fl, otherwise: str(q.followUp.otherwise, 60) };
  }
  return {
    id: str(q.id, 20) || uid(),
    template: str(q.template || q.key, 30),
    label, text, hint: str(q.hint, 240), type, options,
    rule: { answers: action === 'none' ? [] : answers, action: answers.length ? action : 'none', flagLabel: str(rule.flagLabel, 40) },
    followUp,
    every: !!q.every,
    intro: str(q.intro, 600),
  };
}

export function fromTemplate(t) {
  return normalizeQuestion({ ...clone(t), template: t.key, id: uid() });
}

/** Fills in defaults and drops anything malformed. Safe on imported files. */
export function normalize(input) {
  const s = input && typeof input === 'object' ? input : {};
  const d = clone(DEFAULTS);
  const org = s.org || {};
  const form = s.form || {};
  const scr = s.screening || {};
  const out = {
    version: 1,
    setupComplete: !!s.setupComplete,
    org: {
      name: str(org.name, 80),
      tagline: str(org.tagline, 120),
      accent: /^#[0-9a-f]{6}$/i.test(org.accent || '') ? org.accent.toLowerCase() : d.org.accent,
      logo: typeof org.logo === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(org.logo) ? org.logo : '',
      logoFileId: str(org.logoFileId, 100),
    },
    admin: { name: str((s.admin || {}).name, 60), pinHash: str((s.admin || {}).pinHash, 100) },
    storage: s.storage === 'cloud' ? 'cloud' : 'local',
    badges: s.badges !== false,
    passes: s.badges === false && s.passes === true,
    form: {
      askHost: form.askHost !== false,
      askPurpose: form.askPurpose !== false,
      hostLabel: str(form.hostLabel, 100) || d.form.hostLabel,
      hostHint: typeof form.hostHint === 'string' ? str(form.hostHint, 160) : d.form.hostHint,
      purposes: list(form.purposes, 12, 60) ?? d.form.purposes,
      rules: list(form.rules, 12, 400) ?? d.form.rules,
      intro: str(form.intro, 1200),
    },
    screening: {
      questions: (Array.isArray(scr.questions) ? scr.questions : []).map(normalizeQuestion).filter((q) => q && q.text).slice(0, 12),
      declineMessage: str(scr.declineMessage, 600) || d.screening.declineMessage,
      alertEmails: str(scr.alertEmails, 400),
    },
    photos: ['all', 'declined', 'off'].includes(s.photos) ? s.photos : d.photos,
    quickEntry: s.quickEntry !== false,
    hosts: hostList(s.hosts),
    notifyHosts: s.notifyHosts !== false,
    endOfDay: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.endOfDay || '') ? s.endOfDay : '',
    dailySummary: s.dailySummary === true,
    retentionDays: [30, 90, 180, 365, 730].includes(Number(s.retentionDays)) ? Number(s.retentionDays) : 0,
    languages: ['en', ...(Array.isArray(s.languages) ? VISITOR_LANGS.slice(1).filter((c) => s.languages.includes(c)) : [])],
    translations: translationMap(s.translations),
    signature: {
      mode: ['off', 'new', 'every'].includes((s.signature || {}).mode) ? s.signature.mode : 'off',
      emailCopy: (s.signature || {}).emailCopy === true,
    },
    license: typeof s.license === 'string' ? s.license.trim().slice(0, 2000) : '',
    agreement: {
      version: str((s.agreement || {}).version, 40),
      by: str((s.agreement || {}).by, 80),
      at: typeof (s.agreement || {}).at === 'string' && !Number.isNaN(new Date(s.agreement.at).getTime()) ? s.agreement.at : '',
    },
    phone: {
      code: /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test((s.phone || {}).code || '') ? s.phone.code : '',
      license: typeof (s.phone || {}).license === 'string' ? s.phone.license.trim().slice(0, 2000) : '',
    },
    trialStarted: typeof s.trialStarted === 'string' && !Number.isNaN(new Date(s.trialStarted).getTime()) ? s.trialStarted : '',
  };
  // Quick entry recognizes faces, so it needs a photo of every new visitor.
  if (out.photos !== 'all') out.quickEntry = false;
  return out;
}

// ------------------------------------------------------------------ the current settings

let current = normalize(read(LOCAL_KEY));

function read(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function settings() { return current; }

/** Replaces the settings in memory (and in the cloud cache when connected). */
export function useSettings(s, { cache = false } = {}) {
  current = normalize(s);
  if (cache) write(CACHE_KEY, current);
  return current;
}

export function saveLocal(s) {
  current = normalize(s);
  return write(LOCAL_KEY, current);
}

export function loadLocal() { return normalize(read(LOCAL_KEY)); }
export function loadCache() { return read(CACHE_KEY) ? normalize(read(CACHE_KEY)) : null; }
export function forgetLocal() {
  try { localStorage.removeItem(LOCAL_KEY); localStorage.removeItem(CACHE_KEY); } catch { /* nothing stored */ }
  current = normalize(null);
}

/** For export: everything except the PIN hash. */
export function exportable(s = current) {
  const out = clone(s);
  out.admin.pinHash = '';
  delete out.org.logoFileId;
  return { type: 'visitor-kiosk-settings', version: 1, exported: new Date().toISOString(), settings: out };
}

/** Reads an exported settings file (or a bare settings object). Throws on anything else. */
export function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("That file isn't a settings file."); }
  const s = data && data.type === 'visitor-kiosk-settings' ? data.settings : data;
  if (!s || typeof s !== 'object' || !s.org) throw new Error("That file doesn't contain kiosk settings.");
  const out = normalize(s);
  out.admin.pinHash = '';
  out.setupComplete = false;
  return out;
}

// ------------------------------------------------------------------ helpers used across the kiosk

/** Replaces {company} with the company name. */
export function fill(text, s = current) {
  return String(text || '').replace(/\{company\}/gi, s.org.name || 'us');
}

/** Settings for ?demo: a sample company (or whatever a demo recording stored in kiosk-demo-settings). */
export function demoSettings() {
  try {
    const custom = JSON.parse(localStorage.getItem('kiosk-demo-settings'));
    if (custom) return normalize({ ...custom, setupComplete: true });
  } catch { /* use the sample */ }
  const us = fromTemplate(QUESTION_TEMPLATES[0]);
  us.rule.action = 'flag';
  return normalize({
    setupComplete: true,
    org: { name: 'Northwind Labs', tagline: 'Engineering & testing', accent: '#0a5ea8' },
    admin: { name: 'Demo admin' },
    badges: true,
    screening: { questions: [us, fromTemplate(QUESTION_TEMPLATES[1])] },
    hosts: [{ name: 'Lisa Chen' }, { name: 'Pat Kim' }, { name: 'Tom Alvarez' }],
    languages: ['en', 'es'],
  });
}

export const activeQuestions = (s = current) => s.screening.questions.filter((q) => q.text);
export const everyVisitQuestions = (s = current) => activeQuestions(s).filter((q) => q.every);
export const quickEntryOn = (s = current) => s.quickEntry && s.photos === 'all';

/** Hosts whose name matches what a visitor has typed so far (any word starting with it). */
export function hostMatches(typed, s = current) {
  const q = String(typed || '').trim().toLowerCase();
  if (q.length < 2) return [];
  return s.hosts.filter((h) => {
    const name = h.name.toLowerCase();
    return name !== q && (name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q)));
  }).slice(0, 6);
}

/** "18:00" → "6:00 PM" in the tablet's own format. */
export function timeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export async function hashPin(pin) {
  const bytes = new TextEncoder().encode('visitor-kiosk-pin:' + pin);
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 16777619); }
  return 'fnv' + (h >>> 0).toString(16);
}

/** Splits "Lawful permanent resident (green card holder)" into the main text and a quieter note. */
export function splitOption(text) {
  const m = /^(.*?)\s*(\([^()]+\))$/.exec(text);
  return m ? { main: m[1], note: m[2] } : { main: text, note: '' };
}

// ------------------------------------------------------------------ brand colors

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
}
const hex = (rgb) => '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * The whole color scheme from one brand color: deep backgrounds, a bright
 * highlight, light tints, and a warm accent plus aurora colors around the hue
 * wheel. The default blue reproduces the original palette closely.
 */
export function palette(accent) {
  const [h, s0, l] = rgbToHsl(hexToRgb(accent));
  const s = clamp(s0, 35, 90);
  const c = (dh, ss, ll) => hslToRgb(h + dh, ss, ll);
  const p = {
    blue: hexToRgb(accent),
    blueBright: c(0, s, clamp(l + 12, 42, 62)),
    blueDeep: c(0, s, clamp(l - 16, 12, 26)),
    navy: c(0, clamp(s, 40, 85), clamp(l - 28, 6, 13)),
    light: c(0, clamp(s + 10, 50, 95), 76),
    tint: c(0, 70, 95),
    tint2: c(0, 75, 97.5),
    warm: c(180, 88, 54),
    aurora2: c(150, 78, 40),
    aurora3: c(250, 45, 42),
  };
  return p;
}

export function applyTheme(s = current) {
  const p = palette(s.org.accent);
  const root = document.documentElement.style;
  const set = (name, rgb) => { root.setProperty(`--${name}`, hex(rgb)); root.setProperty(`--${name}-rgb`, rgb.join(',')); };
  set('blue', p.blue);
  set('blue-bright', p.blueBright);
  set('blue-deep', p.blueDeep);
  set('navy', p.navy);
  set('brand-light', p.light);
  set('tint', p.tint);
  set('tint-2', p.tint2);
  set('orange', p.warm);
  set('aurora-2', p.aurora2);
  set('aurora-3', p.aurora3);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', hex(p.blueDeep));
}

// ------------------------------------------------------------------ logo

const wordmarks = new Map();

/** A clean text logo for companies that haven't uploaded one. */
export function wordmark(name, accent) {
  const key = `${name}|${accent}`;
  if (wordmarks.has(key)) return wordmarks.get(key);
  const text = (name || 'Visitor Sign-In').trim();
  const canvas = document.createElement('canvas');
  const H = 220, pad = 24;
  const ctx = canvas.getContext('2d');
  const font = (px) => `800 ${px}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
  let px = 132;
  ctx.font = font(px);
  while (ctx.measureText(text).width > 1100 && px > 60) { px -= 6; ctx.font = font(px); }
  canvas.width = Math.ceil(ctx.measureText(text).width + pad * 2);
  canvas.height = H;
  ctx.font = font(px);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hex(palette(accent).blueDeep);
  ctx.fillText(text, pad, H / 2 + 4);
  const url = canvas.toDataURL('image/png');
  wordmarks.set(key, url);
  return url;
}

export const logoFor = (s = current) => s.org.logo || wordmark(s.org.name, s.org.accent);
