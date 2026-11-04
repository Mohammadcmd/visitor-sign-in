/* Visitor Sign In
 * A configurable visitor kiosk that runs entirely in the browser.
 *
 *  - Guided setup: company, admin login, logo, NFC/RFID cards, storage, spreadsheet, screening questions
 *  - Visitor flow: details, then screening questions, then agreement and signature, then photo
 *  - Screening rules can politely decline a visitor (photo, staff alert, admin override) or flag them
 *  - Card tap sign in/out via USB "keyboard" readers or Web NFC (Chrome on Android)
 *  - Storage: this device (localStorage + IndexedDB) or Google Sheets through a connector script
 *  - Admin: dashboard, needs-attention review, visitor log, people and cards, roll call, exports
 */
(() => {
  'use strict';

  // ===========================================================================
  // Constants
  // ===========================================================================
  const KEYS = { config: 'vsi.config.v1', visits: 'vsi.visits.v1', roster: 'vsi.roster.v1', outbox: 'vsi.outbox.v1' };
  const IDLE_MS = 90 * 1000;
  const PHOTO_IDLE_MS = 60 * 1000;
  const ADMIN_IDLE_MS = 5 * 60 * 1000;
  const SHEET_REFRESH_MS = 10 * 60 * 1000;
  const CLOUD_SYNC_MS = 60 * 1000;
  const CLOUD_DAYS = 30;
  const CARD_REPEAT_MS = 3000;
  const CARD_KEY_GAP_MS = 60;
  const PIN_MAX_TRIES = 5;
  const PIN_LOCK_MS = 30 * 1000;
  const STORAGE_BUDGET = 5 * 1024 * 1024;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /** Optional visitor form fields. Full name is always asked and isn't listed here. */
  const FIELDS = [
    { key: 'company', label: 'Company', input: 'text', autocomplete: 'organization', def: 'optional' },
    { key: 'phone', label: 'Phone', input: 'tel', autocomplete: 'tel', def: 'optional' },
    { key: 'email', label: 'Email', input: 'email', autocomplete: 'email', def: 'off' },
    { key: 'host', label: 'Who are you visiting?', short: 'Visiting', input: 'host', def: 'optional' },
    { key: 'vehicle', label: 'Vehicle registration', short: 'Vehicle', input: 'text', def: 'off' },
    { key: 'purpose', label: 'Reason for visit', short: 'Reason', input: 'purpose', def: 'required', wide: true },
    { key: 'notes', label: 'Notes', input: 'textarea', def: 'off', wide: true },
  ];

  const SWATCHES = ['#2563eb', '#0891b2', '#059669', '#65a30d', '#d97706', '#dc2626', '#db2777', '#7c3aed', '#0f172a'];

  const STEPS = {
    company: { label: 'Company', icon: 'building' },
    admin: { label: 'Admin login', icon: 'shield' },
    logo: { label: 'Logo', icon: 'image' },
    cards: { label: 'NFC / RFID cards', icon: 'card' },
    storage: { label: 'Storage', icon: 'database' },
    sheet: { label: 'Spreadsheet', icon: 'sheet' },
    questions: { label: 'Screening questions', icon: 'question' },
    form: { label: 'Visitor form', icon: 'sliders' },
    agreement: { label: 'Agreement', icon: 'file' },
    kiosk: { label: 'Kiosk behavior', icon: 'monitor' },
    finish: { label: 'Ready', icon: 'check-circle' },
  };
  const SETUP_FLOW = ['company', 'admin', 'logo', 'cards', 'storage', 'sheet', 'questions', 'finish'];
  const SETTINGS_FLOW = ['company', 'admin', 'logo', 'cards', 'storage', 'sheet', 'questions', 'form', 'agreement', 'kiosk'];

  const QUESTION_TEMPLATES = [
    { label: 'U.S. person (ITAR / EAR)', text: 'Are you a U.S. person (a U.S. citizen, lawful permanent resident, or protected individual such as a refugee or asylee)?', type: 'yesno', when: 'No', action: 'decline' },
    { label: 'Illness symptoms', text: 'Do you currently have symptoms of a contagious illness, such as a fever or cough?', type: 'yesno', when: 'Yes', action: 'decline' },
    { label: 'Prohibited items', text: 'Are you carrying any weapons or prohibited items?', type: 'yesno', when: 'Yes', action: 'decline' },
    { label: 'Safety induction', text: 'Have you completed our site safety induction?', type: 'yesno', when: 'No', action: 'flag' },
    { label: 'Tools & equipment', text: 'Are you bringing any tools or equipment on site?', type: 'yesno', when: 'Yes', action: 'flag' },
    { label: 'Accessibility', text: 'Do you need any accessibility assistance during your visit?', type: 'yesno', when: 'Yes', action: 'flag' },
    { label: 'First visit', text: 'Is this your first visit to our site?', type: 'yesno', when: 'Yes', action: 'none' },
  ];

  const DEFAULT_DECLINE = 'Thank you for visiting {company}. Unfortunately, we are unable to sign you in today. We apologize for any inconvenience.';

  const TIPS = {
    company: [
      'You can change the name, color and logo at any time in Admin → Settings.',
      'The live preview shows roughly how your welcome screen will look.',
      'Setting up a second kiosk? Import the settings file from your first kiosk to skip most steps.',
    ],
    admin: [
      'Your code is stored as a one-way hash, never as plain text.',
      'After 5 wrong attempts the login locks for 30 seconds.',
      'The admin panel locks itself after 5 minutes without activity.',
      'In the cards step you can register an admin card that unlocks the panel with a tap.',
    ],
    logo: [
      'Most design tools, including Canva, Figma, Illustrator and Photoshop, have a "transparent background" option when you export a PNG.',
      'Large images are shrunk automatically, so any size works.',
      'Your logo also appears on printed badges and the roll call.',
    ],
    cards: [
      'USB readers that "type" the card number work automatically, with no drivers or apps.',
      '125 kHz (EM4100) and 13.56 MHz (MIFARE / NFC) cards both work, as long as the reader outputs the number as keystrokes.',
      'iPhone and iPad don\'t let websites use NFC, so use a USB or Bluetooth reader there.',
      'Add each person\'s Card ID to your spreadsheet, or register cards later in Admin → People & cards.',
    ],
    storage: [
      'You can switch later. When you move to the cloud, existing records on this device are uploaded.',
      'Cloud mode also keeps a copy on this device, so the kiosk keeps working during internet outages.',
      'Both options are free.',
    ],
    sheetLocal: [
      'Changes you make in the sheet reach the kiosk within 10 minutes, or right away when you press Sync in the admin panel.',
      'Format the Card ID column as plain text (Format → Number → Plain text) so long card numbers keep their leading zeros.',
      'Want the sheet to stay private? Choose Cloud storage instead. The connector reads your People tab without making it public.',
    ],
    sheetCloud: [
      'The connector runs in your own Google account. This app has no servers, so data goes straight from the kiosk to your sheet.',
      'Free Google accounts can send about 100 emails a day. Google Workspace accounts can send more.',
      'For extra kiosks, use the same Web app URL and kiosk key on each, and give each kiosk its own name.',
      'If you change the script later, deploy a new version so the URL keeps working.',
    ],
    questions: [
      'Card holders, such as staff and contractors, skip screening questions.',
      'Declined visitors only see your general message. Only admins can see which answers led to the decision.',
      'Admins can override a decline at the kiosk (Staff override) or in the admin panel. Each override is recorded with the admin\'s name and reason.',
      'Photos need a camera and a secure (https) connection.',
    ],
    form: [
      'Fewer questions means faster sign-ins, so only ask what you need.',
      'Reasons for visit appear as large buttons that are easy to tap.',
    ],
    agreement: [
      'Visitors must accept the agreement before they can sign in.',
      'Signatures are stored with the visit and can be viewed in the admin panel.',
    ],
    kiosk: [
      'Auto sign-out keeps the "on site" list accurate for fire roll calls.',
      'Retention applies to this device only. In cloud mode, your Google Sheet keeps the full history.',
    ],
    finish: [
      'Bookmark this page or add it to your home screen to open the kiosk quickly.',
      'Everything you set up here can be changed later in Admin → Settings.',
    ],
  };

  // ===========================================================================
  // Utilities
  // ===========================================================================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const SVGNS = 'http://www.w3.org/2000/svg';

  function icon(name, cls = 'i') {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVGNS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'value' && 'value' in n) n.value = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid);
    return n;
  }

  const clone = x => JSON.parse(JSON.stringify(x));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
  const uniq = arr => [...new Map(arr.filter(Boolean).map(x => [x.toLowerCase(), x])).values()];
  const splitEmails = s => String(s || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);

  function uid() {
    const bytes = new Uint8Array(6);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Date.now().toString(36) + Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('');
  }

  const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const fmtDate = ts => ts ? new Date(ts).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const fmtDateTime = ts => ts ? `${fmtDate(ts)}, ${fmtTime(ts)}` : '';
  const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const addDays = (ts, n) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
  const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'there';
  const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  const finePointer = () => window.matchMedia('(pointer: fine)').matches;
  const isEditable = t => !!t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
    (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'color', 'file', 'range'].includes(t.type)));

  function fmtDuration(ms) {
    if (!(ms > 0)) return '–';
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  function timeAgo(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return fmtDateTime(ts);
  }
  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  /** Card IDs arrive in many shapes ("04:A3:2F:...", "0012345678"), so compare them loosely. */
  const normCard = id => String(id || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^0+(?=.)/, '');

  async function hashPin(pin) {
    const data = new TextEncoder().encode('vsi:' + pin);
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', data);
      return 'sha256:' + Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback for insecure contexts (plain http on a LAN), where SubtleCrypto is unavailable.
    let h = 2166136261;
    for (const b of data) { h ^= b; h = Math.imul(h, 16777619); }
    return 'fnv:' + (h >>> 0).toString(16);
  }
  const isEasyPin = p => /^(\d)\1+$/.test(p) || '01234567890'.includes(p) || '09876543210'.includes(p);

  let toastTimer;
  function toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const slug = s => (s || 'visitors').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'visitors';
  const isoDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    try {
      const ta = el('textarea', { style: 'position:fixed;top:0;left:0;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }

  // ===========================================================================
  // Defaults, storage and state
  // ===========================================================================
  const DEFAULT_CONFIG = {
    setupComplete: false,
    orgName: '',
    adminName: '',
    pinHash: '',
    accent: '#2563eb',
    logo: '',
    logoTone: '',
    cardMode: 'off',            // 'off' | 'usb' | 'nfc'
    localCards: [],             // [{ cardId, name, company, role, isAdmin }]
    storage: 'local',           // 'local' | 'cloud'
    sheetUrl: '',               // local mode: public people sheet
    cloudUrl: '',               // cloud mode: Apps Script web app URL
    cloudKey: '',
    cloudSheetName: '',
    cloudSheetUrl: '',
    kioskName: 'Front desk',
    notifyHosts: true,
    screening: { enabled: false, questions: [], declineMessage: DEFAULT_DECLINE, alertEmails: '' },
    photoMode: 'declined',      // 'off' | 'declined' | 'all'
    welcome: 'Welcome! Please sign in.',
    thanks: 'Thanks for signing in. Please take a seat and your host will be with you shortly.',
    fields: Object.fromEntries(FIELDS.map(f => [f.key, f.def])),
    hosts: [],
    purposes: ['Meeting', 'Interview', 'Delivery', 'Contractor / Maintenance', 'Other'],
    agreementEnabled: false,
    agreementText:
      'By signing in you agree to:\n' +
      '• Follow all safety instructions and signage while on site.\n' +
      '• Stay with your host unless authorized otherwise.\n' +
      '• Keep any confidential information you see or hear private.\n' +
      '• Sign out before you leave.\n\n' +
      'The information you provide is used only to manage site access and safety.',
    signatureRequired: false,
    resetSeconds: 10,
    autoSignOut: '',            // 'HH:MM' or ''
    retentionDays: 0,
    printBadges: true,
    keepAwake: true,
  };

  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) { console.error(e); toast('Couldn\'t save. Storage on this device is full or blocked.', 6000); return false; }
    },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  function normalizeQuestion(q) {
    if (!q || typeof q !== 'object') return null;
    const type = ['yesno', 'choice', 'text'].includes(q.type) ? q.type : 'yesno';
    const options = type === 'yesno' ? ['Yes', 'No']
      : type === 'choice' ? (Array.isArray(q.options) ? q.options.map(o => String(o).trim()).filter(Boolean) : []) : [];
    const action = type !== 'text' && ['none', 'decline', 'flag'].includes(q.action) ? q.action : 'none';
    const when = typeof q.when === 'string' && options.includes(q.when) ? q.when : (options[0] || '');
    return { id: typeof q.id === 'string' && q.id ? q.id : uid(), text: String(q.text || '').slice(0, 200), type, options, when, action };
  }

  function mergeConfig(c) {
    const base = clone(DEFAULT_CONFIG);
    if (!c || typeof c !== 'object') return base;
    const m = { ...base, ...c, fields: { ...base.fields, ...(c.fields || {}) } };
    if (!/^#[0-9a-f]{6}$/i.test(m.accent)) m.accent = base.accent;
    if (!['off', 'usb', 'nfc'].includes(m.cardMode)) m.cardMode = 'off';
    if (!['local', 'cloud'].includes(m.storage)) m.storage = 'local';
    if (!['off', 'declined', 'all'].includes(m.photoMode)) m.photoMode = base.photoMode;
    if (typeof m.logo !== 'string' || (m.logo && !/^data:image\//.test(m.logo))) m.logo = '';
    for (const k of ['orgName', 'adminName', 'pinHash', 'sheetUrl', 'cloudUrl', 'cloudKey', 'cloudSheetName', 'cloudSheetUrl', 'kioskName', 'welcome', 'thanks', 'agreementText', 'autoSignOut', 'logoTone']) {
      if (typeof m[k] !== 'string') m[k] = base[k];
    }
    if (m.autoSignOut && !/^\d{2}:\d{2}$/.test(m.autoSignOut)) m.autoSignOut = '';
    m.localCards = Array.isArray(m.localCards) ? m.localCards.filter(x => x && x.cardId && x.name).map(x => ({
      cardId: String(x.cardId), name: String(x.name), company: String(x.company || ''), role: String(x.role || ''), isAdmin: !!x.isAdmin,
    })) : [];
    m.hosts = Array.isArray(m.hosts) ? m.hosts.map(String) : [];
    m.purposes = Array.isArray(m.purposes) ? m.purposes.map(String) : base.purposes;
    m.resetSeconds = Math.min(120, Math.max(3, Number(m.resetSeconds) || base.resetSeconds));
    m.retentionDays = [0, 30, 90, 180, 365].includes(Number(m.retentionDays)) ? Number(m.retentionDays) : 0;
    const s = m.screening && typeof m.screening === 'object' ? m.screening : {};
    m.screening = {
      enabled: !!s.enabled,
      questions: Array.isArray(s.questions) ? s.questions.map(normalizeQuestion).filter(Boolean) : [],
      declineMessage: typeof s.declineMessage === 'string' && s.declineMessage.trim() ? s.declineMessage : DEFAULT_DECLINE,
      alertEmails: typeof s.alertEmails === 'string' ? s.alertEmails : '',
    };
    for (const k of ['notifyHosts', 'agreementEnabled', 'signatureRequired', 'printBadges', 'keepAwake', 'setupComplete']) m[k] = !!m[k];
    return m;
  }

  let config = mergeConfig(store.get(KEYS.config, null));
  let visits = store.get(KEYS.visits, []);
  if (!Array.isArray(visits)) visits = [];
  let roster = store.get(KEYS.roster, null) || { rows: [], syncedAt: 0, error: '' };
  if (!Array.isArray(roster.rows)) roster = { rows: [], syncedAt: 0, error: '' };
  let outbox = store.get(KEYS.outbox, []);
  if (!Array.isArray(outbox)) outbox = [];

  const saveConfig = () => store.set(KEYS.config, config);
  const saveVisits = () => store.set(KEYS.visits, visits);
  const saveRoster = () => store.set(KEYS.roster, roster);
  const saveOutbox = () => store.set(KEYS.outbox, outbox);

  function storageBytes() {
    let n = 0;
    try { for (const k of Object.values(KEYS)) n += (localStorage.getItem(k) || '').length; } catch { /* ignore */ }
    return n * 2; // UTF-16
  }

  // ---- Visit helpers ----
  const isOnSite = v => !v.outAt && v.status !== 'declined';
  const onSiteVisits = () => visits.filter(isOnSite).sort((a, b) => a.name.localeCompare(b.name));

  function parsePairs(text) {
    return String(text || '').split(' | ').filter(Boolean).map(s => {
      const i = s.lastIndexOf(' → ');
      return i < 0 ? { q: s, a: '' } : { q: s.slice(0, i), a: s.slice(i + 3) };
    });
  }
  /** Reasons a visit was declined or flagged: [{ q, a, action }]. */
  function visitReasons(v) {
    if (Array.isArray(v.reasons)) return v.reasons;
    if (!v.flagsText) return [];
    return parsePairs(v.flagsText).map(p => {
      const decline = /^Declined: /.test(p.q);
      return { q: p.q.replace(/^(Declined|Alert): /, ''), a: p.a, action: decline ? 'decline' : 'flag' };
    });
  }
  function visitAnswers(v) {
    const reasons = visitReasons(v);
    const hit = q => { const r = reasons.find(x => x.q === q); return r ? r.action : ''; };
    const list = Array.isArray(v.answers) ? v.answers : parsePairs(v.answersText);
    return list.map(a => ({ q: a.q, a: a.a, hit: hit(a.q) }));
  }
  const hasFlags = v => visitReasons(v).some(r => r.action === 'flag');
  const needsAttention = v => !v.reviewed && (v.status === 'declined' || hasFlags(v));
  const canOverride = v => v.status === 'declined' && v.inAt >= startOfDay();
  function overrideLine(v) {
    if (v.override) return `By ${v.override.by} on ${fmtDateTime(v.override.at)}${v.override.reason ? `: ${v.override.reason}` : ''}`;
    return v.overrideText || '';
  }

  // ===========================================================================
  // Theme
  // ===========================================================================
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0x2563eb;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const toHex = rgb => '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  function luminance(rgb) {
    const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const readableInk = hex => luminance(hexToRgb(hex)) > 0.4 ? '#0f172a' : '#ffffff';

  function applyTheme(accent = config.accent) {
    const rgb = hexToRgb(accent);
    const [r, g, b] = rgb;
    const L = luminance(rgb);
    const s = document.documentElement.style;
    s.setProperty('--accent', accent);
    s.setProperty('--accent-ink', readableInk(accent));
    s.setProperty('--accent-strong', toHex(mixRgb(rgb, [0, 0, 0], 0.14)));
    s.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, .13)`);
    s.setProperty('--accent-softer', `rgba(${r}, ${g}, ${b}, .06)`);
    s.setProperty('--accent-ring', `rgba(${r}, ${g}, ${b}, .3)`);
    s.setProperty('--accent-text-light', L > 0.45 ? toHex(mixRgb(rgb, [0, 0, 0], 0.5)) : accent);
    s.setProperty('--accent-text-dark', L < 0.18 ? toHex(mixRgb(rgb, [255, 255, 255], 0.55)) : accent);
    $('meta[name=theme-color]').setAttribute('content', accent);
  }
  const applyLogoTone = (tone = config.logoTone) => { document.documentElement.dataset.logoTone = tone || ''; };

  // ===========================================================================
  // Media store: photos and signatures live in IndexedDB (much more room than localStorage)
  // ===========================================================================
  const media = (() => {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
        let req;
        try { req = indexedDB.open('vsi-media', 1); } catch (e) { reject(e); return; }
        req.onupgradeneeded = () => req.result.createObjectStore('media');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB blocked'));
      });
      dbp.catch(() => { dbp = null; });
      return dbp;
    }
    async function run(mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('media', mode);
        const req = fn(tx.objectStore('media'));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    return {
      put: (key, value) => run('readwrite', st => st.put(value, key)),
      get: key => run('readonly', st => st.get(key)),
      del: keys => run('readwrite', st => { keys.forEach(k => st.delete(k)); return null; }),
      clear: () => run('readwrite', st => st.clear()),
    };
  })();

  async function saveMedia(v, kind, dataUrl) {
    if (!dataUrl) return;
    try { await media.put(`${v.id}:${kind}`, dataUrl); v[kind] = true; }
    catch { v[kind] = dataUrl; } // no IndexedDB: keep it inline in the record instead
  }
  async function loadMedia(v, kind) {
    const val = v && v[kind];
    if (typeof val === 'string' && val.startsWith('data:')) return val;
    if (val === true) { try { return (await media.get(`${v.id}:${kind}`)) || ''; } catch { return ''; } }
    return '';
  }
  function dropMedia(list) {
    const keys = [];
    for (const v of list) for (const k of ['photo', 'signature']) if (v[k] === true) keys.push(`${v.id}:${k}`);
    if (keys.length) media.del(keys).catch(() => {});
  }

  // ===========================================================================
  // People spreadsheet (on-device mode): a Google Sheet shared as "Anyone with the link: Viewer"
  // ===========================================================================
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', i = 0, inQ = false;
    text = String(text).replace(/^﻿/, '');
    while (i < text.length) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim() !== ''));
  }

  /** Turn the link the user pasted into a CSV address that can be fetched from the browser. */
  function sheetCsvUrl(raw) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    const gid = (u.hash.match(/gid=(\d+)/) || u.search.match(/gid=(\d+)/) || [])[1];
    if (u.hostname === 'docs.google.com') {
      const pub = u.pathname.match(/\/spreadsheets\/d\/e\/([\w-]+)/);
      if (pub) return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv${gid ? '&gid=' + gid : ''}`;
      const id = u.pathname.match(/\/spreadsheets\/d\/([\w-]+)/);
      if (id) return `https://docs.google.com/spreadsheets/d/${id[1]}/gviz/tq?tqx=out:csv${gid ? '&gid=' + gid : ''}`;
      return null;
    }
    return /\.csv($|\?)|output=csv/i.test(u.href) ? u.href : null;
  }

  const COLUMN_MATCHERS = {
    name: /^(full\s*)?name$|^(employee|person|staff|visitor|member)(\s*name)?$/i,
    cardId: /card|rfid|nfc|badge|fob|tag\s*id|uid/i,
    company: /company|organi[sz]ation|business|employer/i,
    role: /role|type|department|dept|title|position/i,
    admin: /^(is\s*)?admin/i,
  };

  function rowsToPeople(rows) {
    if (!rows.length) throw new Error('The spreadsheet is empty. Add the headings in row 1 and at least one person.');
    const header = rows[0].map(h => h.trim());
    const idx = {};
    for (const [key, re] of Object.entries(COLUMN_MATCHERS)) idx[key] = header.findIndex(h => re.test(h));
    if (idx.name < 0) {
      const fi = header.findIndex(h => /first/i.test(h)), li = header.findIndex(h => /last|sur/i.test(h));
      if (fi < 0) throw new Error('Couldn\'t find a "Name" column in row 1 of the sheet.');
      idx.first = fi; idx.last = li;
    }
    const people = [];
    for (const r of rows.slice(1)) {
      const get = i => (i >= 0 && i != null ? String(r[i] ?? '').trim() : '');
      const name = idx.name >= 0 ? get(idx.name) : [get(idx.first), get(idx.last)].filter(Boolean).join(' ');
      if (!name) continue;
      people.push({
        name, cardId: get(idx.cardId), company: get(idx.company), role: get(idx.role),
        isAdmin: /^(y|yes|true|1|x|admin)$/i.test(get(idx.admin)), source: 'sheet',
      });
    }
    return { people };
  }

  async function fetchSheet(rawUrl) {
    const url = sheetCsvUrl(rawUrl);
    if (!url) throw new Error('That doesn\'t look like a Google Sheets link. In the sheet, click Share, then Copy link.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    } catch (e) {
      throw new Error(e.name === 'AbortError'
        ? 'The spreadsheet took too long to respond. Check the internet connection.'
        : 'Couldn\'t open the spreadsheet. In Google Sheets click Share, set General access to "Anyone with the link" (Viewer), then try again.');
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error(`The spreadsheet couldn't be read (error ${res.status}). Make sure sharing is set to "Anyone with the link".`);
    const text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) {
      throw new Error('Google asked for a sign-in, so the sheet isn\'t shared yet. Set General access to "Anyone with the link" (Viewer).');
    }
    return rowsToPeople(parseCSV(text));
  }

  let rosterSyncing = null;
  async function syncRoster({ quiet = true } = {}) {
    if (cloudOn()) return cloudSync({ quiet });
    if (!config.sheetUrl) return false;
    if (rosterSyncing) return rosterSyncing;
    rosterSyncing = (async () => {
      try {
        const { people } = await fetchSheet(config.sheetUrl);
        roster = { rows: people, syncedAt: Date.now(), error: '' };
        if (!quiet) toast(`Spreadsheet synced: ${people.length} ${people.length === 1 ? 'person' : 'people'}`);
        return true;
      } catch (e) {
        roster = { ...roster, error: e.message }; // keep the last good copy so the kiosk keeps working
        if (!quiet) toast(e.message, 6000);
        return false;
      } finally {
        saveRoster();
        refreshLiveViews();
      }
    })();
    try { return await rosterSyncing; } finally { rosterSyncing = null; }
  }

  const normalizePerson = p => ({
    name: String((p && p.name) || '').trim(), cardId: String((p && p.cardId) || '').trim(),
    company: String((p && p.company) || ''), role: String((p && p.role) || ''),
    isAdmin: !!(p && p.isAdmin), hasEmail: !!(p && p.hasEmail), source: 'sheet',
  });
  const allPeople = () => [...config.localCards.map(p => ({ ...p, source: 'local' })), ...roster.rows];
  function findByCard(id) {
    const n = normCard(id);
    return n ? allPeople().find(p => p.cardId && normCard(p.cardId) === n) : undefined;
  }
  const hostOptions = () => uniq([...config.hosts, ...roster.rows.filter(p => !p.isAdmin).map(p => p.name)]);

  // ===========================================================================
  // Cloud: Google Sheets connector (Apps Script web app)
  // ===========================================================================
  const cloudOn = () => config.storage === 'cloud' && !!config.cloudUrl && !!config.cloudKey;
  let syncState = { state: 'idle', lastOk: 0, error: '' };

  function generateKey() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(20);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    const chars = Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
    return chars.match(/.{5}/g).join('-');
  }
  const connectorSource = key => (window.VSI_CONNECTOR_SOURCE || '').replace('%%KIOSK_KEY%%', key);

  function cloudUrlProblem(raw) {
    const url = String(raw || '').trim();
    if (!url) return 'Paste the Web app URL from Apps Script.';
    let u;
    try { u = new URL(url); } catch { return 'That isn\'t a complete web address. It should start with https://'; }
    if (u.protocol !== 'https:') return 'The Web app URL must start with https://';
    if (u.hostname === 'docs.google.com') return 'That\'s the link to the spreadsheet itself. We need the Web app URL from Apps Script: Deploy → Manage deployments → Web app (it ends in /exec).';
    if (u.hostname === 'script.google.com') {
      if (/\/dev\/?$/.test(u.pathname)) return 'That\'s the test URL (ending in /dev), which only works for you. Use the Web app URL ending in /exec from Deploy → Manage deployments.';
      if (!/\/exec\/?$/.test(u.pathname)) return 'That looks like the Apps Script editor address. Use the Web app URL from Deploy → Manage deployments (it ends in /exec).';
    }
    return '';
  }

  async function cloudRequest(body, { url = config.cloudUrl, key = config.cloudKey, timeout = 30000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      // A plain-text body keeps this a "simple" request, which Apps Script web apps accept from browsers.
      res = await fetch(url, {
        method: 'POST', body: JSON.stringify({ ...body, key, v: 1 }), credentials: 'omit',
        redirect: 'follow', cache: 'no-store', signal: ctrl.signal,
      });
    } catch (e) {
      const err = new Error(e.name === 'AbortError'
        ? 'Google Sheets took too long to respond. Check the internet connection.'
        : navigator.onLine === false
          ? 'This device is offline. Changes are saved and will sync when the connection is back.'
          : 'Couldn\'t reach the connector. Check that the Web app URL is right and that "Who has access" is set to "Anyone".');
      err.code = navigator.onLine === false ? 'offline' : 'network';
      throw err;
    } finally { clearTimeout(timer); }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* handled below */ }
    if (!data) {
      const err = new Error(/<html|<!doctype/i.test(text)
        ? 'Google returned a web page instead of data. Redeploy the script with "Who has access: Anyone" and use the /exec URL.'
        : `Unexpected response from the connector (status ${res.status}).`);
      err.code = 'bad_response';
      throw err;
    }
    if (data.ok !== true) {
      const err = new Error(data.error || 'The connector reported an error.');
      err.code = data.code || 'error';
      throw err;
    }
    return data;
  }

  function enqueue(op) {
    if (config.storage !== 'cloud') return;
    outbox.push({ opId: uid(), at: Date.now(), ...op });
    saveOutbox();
    scheduleSync(300);
  }

  let syncTimer = null;
  function scheduleSync(ms = 400) {
    if (!cloudOn()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => cloudSync(), ms);
  }

  const CLOUD_FIELDS = ['id', 'name', 'company', 'email', 'phone', 'host', 'purpose', 'vehicle', 'notes', 'role', 'cardId',
    'method', 'kiosk', 'inAt', 'outAt', 'autoOut', 'agreed', 'status', 'answers', 'reasons', 'override'];
  function forCloud(v) {
    const out = {};
    for (const k of CLOUD_FIELDS) if (v[k] != null && v[k] !== '') out[k] = v[k];
    return out;
  }

  /** Turn a queued operation into the payload the connector expects (media are read at send time). */
  async function buildOp(op) {
    const v = visits.find(x => x.id === op.id);
    if (op.type === 'signin') {
      if (!v) return null;
      const visit = forCloud(v);
      const signature = await loadMedia(v, 'signature');
      const photo = await loadMedia(v, 'photo');
      if (signature) visit.signature = signature;
      if (photo) visit.photo = photo;
      return { opId: op.opId, type: 'signin', visit };
    }
    if (op.type === 'signout') return { opId: op.opId, type: 'signout', id: op.id, outAt: op.outAt, auto: !!op.auto };
    if (op.type === 'override') {
      const o = (v && v.override) || {};
      return { opId: op.opId, type: 'override', id: op.id, by: o.by || config.adminName || 'Admin', at: o.at || op.at, reason: o.reason || '' };
    }
    return null;
  }

  let syncPromise = null;
  async function cloudSync({ quiet = true } = {}) {
    if (!cloudOn()) return false;
    if (syncPromise) return syncPromise;
    let again = false;
    syncPromise = (async () => {
      syncState = { ...syncState, state: 'syncing' };
      renderSyncIndicators();
      try {
        const batch = outbox.slice(0, 25);
        const ops = [];
        const dropped = [];
        for (const op of batch) {
          const built = await buildOp(op);
          if (built) ops.push(built); else dropped.push(op.opId);
        }
        const data = await cloudRequest({
          action: 'sync', ops, kiosk: config.kioskName, notifyHosts: config.notifyHosts,
          alertEmails: config.screening.alertEmails || '', days: CLOUD_DAYS,
        });
        const applied = new Set([...(Array.isArray(data.applied) ? data.applied.map(String) : []), ...dropped]);
        if (applied.size) { outbox = outbox.filter(o => !applied.has(o.opId)); saveOutbox(); }
        again = applied.size > 0 && outbox.length > 0;
        if (Array.isArray(data.people)) {
          roster = { rows: data.people.map(normalizePerson).filter(p => p.name), syncedAt: Date.now(), error: '' };
          saveRoster();
        }
        if (Array.isArray(data.visits)) mergeRemoteVisits(data.visits);
        if (data.sheetName && (data.sheetName !== config.cloudSheetName || (data.sheetUrl || '') !== config.cloudSheetUrl)) {
          config.cloudSheetName = String(data.sheetName);
          config.cloudSheetUrl = String(data.sheetUrl || '');
          saveConfig();
        }
        syncState = { state: 'ok', lastOk: Date.now(), error: '' };
        if (!quiet) toast(outbox.length ? 'Synced. A few changes are still uploading.' : 'Everything is synced with Google Sheets.');
        return true;
      } catch (e) {
        syncState = { state: e.code === 'offline' || navigator.onLine === false ? 'offline' : 'error', lastOk: syncState.lastOk, error: e.message };
        if (!quiet) toast(e.message, 6500);
        return false;
      } finally {
        renderSyncIndicators();
        refreshLiveViews();
      }
    })();
    try { return await syncPromise; } finally {
      syncPromise = null;
      if (again) scheduleSync(150);
    }
  }

  /** Merge visits from the sheet: other kiosks' visitors, and sign-outs or overrides made elsewhere. */
  function mergeRemoteVisits(remote) {
    const byId = new Map(visits.map(v => [v.id, v]));
    let changed = false;
    for (const r of remote) {
      if (!r || typeof r.id !== 'string' || !r.id) continue;
      const inAt = Number(r.inAt) || 0;
      if (!inAt) continue;
      const outAt = Number(r.outAt) || null;
      const local = byId.get(r.id);
      if (local) {
        if (outAt && !local.outAt && local.status !== 'declined') { local.outAt = outAt; if (r.autoOut) local.autoOut = true; changed = true; }
        if (r.status === 'overridden' && local.status === 'declined') {
          local.status = 'overridden'; local.overrideText = r.overrideText || ''; local.reviewed = true; changed = true;
        }
        continue;
      }
      const v = { id: r.id, inAt, outAt, method: r.method === 'card' ? 'card' : 'screen', remote: true };
      for (const k of ['name', 'company', 'email', 'phone', 'host', 'purpose', 'vehicle', 'notes', 'role', 'cardId', 'kiosk', 'answersText', 'flagsText', 'overrideText']) {
        if (r[k] != null && r[k] !== '') v[k] = String(r[k]);
      }
      if (!v.name) continue;
      if (r.status === 'declined' || r.status === 'overridden') v.status = r.status;
      if (r.agreed != null) v.agreed = !!r.agreed;
      if (r.autoOut) v.autoOut = true;
      if (r.signed) v.signedRemote = true;
      if (r.hasPhoto) v.photoRemote = true;
      // Alerts from other kiosks show here too, but only recent ones: older ones were handled by email.
      v.reviewed = v.status === 'overridden' || Date.now() - inAt > 24 * 3600 * 1000;
      visits.push(v);
      byId.set(v.id, v);
      changed = true;
    }
    if (changed) saveVisits();
  }

  const refreshPeople = opts => (cloudOn() ? cloudSync(opts) : syncRoster(opts));

  // ===========================================================================
  // Card readers: USB/Bluetooth "keyboard" readers and Web NFC
  // ===========================================================================
  let lastUnknownCard = '';

  const cards = (() => {
    let buf = '', lastKey = 0, flushTimer = null;
    let lastId = '', lastAt = 0;
    let nfc = null, nfcCtrl = null;
    const nfcSupported = 'NDEFReader' in window;

    function emit(raw) {
      const id = String(raw).trim();
      if (normCard(id).length < 4) return;
      const now = Date.now();
      if (normCard(id) === normCard(lastId) && now - lastAt < CARD_REPEAT_MS) return;
      lastId = id;
      lastAt = now;
      onCard(id);
    }

    const capturing = () => (current === 'setup' && stepName() === 'cards') || $('#enroll-dialog').open;

    // Keyboard-style readers "type" the card number very fast and press Enter. People can't type
    // 4+ characters with under 60 ms between keys, which is how the two are told apart.
    document.addEventListener('keydown', e => {
      if (config.cardMode !== 'usb' && !capturing()) return;
      const t = e.target;
      const editable = isEditable(t);
      if (editable && !(t.hasAttribute && t.hasAttribute('data-card-capture'))) return;
      const now = performance.now();
      if (now - lastKey > CARD_KEY_GAP_MS) buf = '';
      lastKey = now;
      clearTimeout(flushTimer);
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (buf.length >= 4) {
          e.preventDefault();
          e.stopPropagation();
          if (editable && typeof t.value === 'string' && t.value.endsWith(buf)) {
            t.value = t.value.slice(0, -buf.length);
            t.dispatchEvent(new Event('input', { bubbles: true }));
          }
          emit(buf);
        }
        buf = '';
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        buf += e.key;
        // A few readers never send Enter: flush after a short pause if it was clearly machine-typed.
        if (!editable) flushTimer = setTimeout(() => { if (buf.length >= 8) emit(buf); buf = ''; }, 150);
      }
    }, true);

    async function startNfc({ prompt = false } = {}) {
      if (!nfcSupported) throw new Error('NFC isn\'t available here. It needs Chrome on an Android phone or tablet with NFC turned on.');
      if (nfc) return true;
      if (!prompt) {
        if (!navigator.permissions) return false;
        try {
          const st = await navigator.permissions.query({ name: 'nfc' });
          if (st.state !== 'granted') return false;
        } catch { return false; }
      }
      nfcCtrl = new AbortController();
      const reader = new window.NDEFReader();
      await reader.scan({ signal: nfcCtrl.signal });
      reader.addEventListener('reading', ev => emit(ev.serialNumber || ''));
      reader.addEventListener('readingerror', () => toast('Couldn\'t read that card. Please try again.'));
      nfc = reader;
      return true;
    }
    function stopNfc() { if (nfcCtrl) nfcCtrl.abort(); nfc = null; nfcCtrl = null; }

    return { startNfc, stopNfc, nfcSupported, get nfcActive() { return !!nfc; } };
  })();

  /** Every card tap is routed here, depending on what is on screen. */
  function onCard(id) {
    if ($('#enroll-dialog').open) return enrollOnCard(id);
    if ($('#pin-dialog').open) return pinOnCard(id);
    if (current === 'setup') return setupOnCard(id);
    if (['home', 'done', 'bye', 'signout', 'declined'].includes(current)) return kioskOnCard(id);
    if (current === 'admin') { lastUnknownCard = findByCard(id) ? lastUnknownCard : id; toast(`Card read: ${id}`); }
  }

  function kioskOnCard(id) {
    const person = findByCard(id);
    if (!person) {
      lastUnknownCard = id;
      return showNotice('warn', 'Card not recognized', 'Please sign in using the screen, or ask reception to register your card.');
    }
    if (person.isAdmin) { toast('Admin card accepted'); return show('admin'); }

    const open = visits.find(v => isOnSite(v) && v.cardId && normCard(v.cardId) === normCard(person.cardId));
    if (open) return signOut(open.id);

    const record = {
      id: uid(), name: person.name, company: person.company || '', role: person.role || '', cardId: person.cardId,
      method: 'card', kiosk: config.kioskName, inAt: Date.now(), outAt: null,
    };
    if (!addVisit(record)) return;
    finalizeVisit(record);
    showDone(record);
  }

  // ===========================================================================
  // Views
  // ===========================================================================
  let current = null;
  let countdownTimer = null;
  let idleTimer = null;

  function show(name) {
    clearInterval(countdownTimer);
    if (current === 'photo' && name !== 'photo') camera.stop();
    $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
    current = name;
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
    window.scrollTo(0, 0);
    resetIdle();
    if (name === 'home') renderHome();
    if (name === 'signout') renderSignOut();
    if (name === 'admin') renderAdmin();
    keepAwake();
  }

  function closeDialogs() { $$('dialog[open]').forEach(d => d.close()); }

  function resetIdle() {
    clearTimeout(idleTimer);
    if (current === 'signin' || current === 'signout') idleTimer = setTimeout(() => { closeDialogs(); show('home'); }, IDLE_MS);
    else if (current === 'photo') idleTimer = setTimeout(photoTimeout, PHOTO_IDLE_MS);
    else if (current === 'done' || current === 'bye' || current === 'declined') {
      // The countdown normally returns home; this is a fallback if it was paused (printing, override).
      idleTimer = setTimeout(() => { closeDialogs(); show('home'); }, IDLE_MS);
    }
    else if (current === 'admin' || (current === 'setup' && editing)) {
      idleTimer = setTimeout(() => { closeDialogs(); toast('The admin panel locked after 5 minutes without activity.'); show('home'); }, ADMIN_IDLE_MS);
    }
  }
  ['pointerdown', 'keydown', 'input', 'wheel'].forEach(evt => document.addEventListener(evt, resetIdle, { passive: true, capture: true }));

  document.addEventListener('click', e => {
    const go = e.target.closest('[data-go]');
    if (go) show(go.dataset.go);
  });

  function countdownHome(seconds, label) {
    clearInterval(countdownTimer);
    let left = Math.max(1, Math.round(seconds));
    const tick = () => { if (label) label.textContent = `Returning to the welcome screen in ${left} s`; };
    tick();
    countdownTimer = setInterval(() => { left -= 1; if (left <= 0) show('home'); else tick(); }, 1000);
  }

  function refreshLiveViews() {
    if (current === 'signout') renderSignOutList();
    else if (current === 'admin') renderAdmin();
    else if (current === 'home') renderHomeStatus();
    updateAttentionIndicators();
  }

  // ===========================================================================
  // Dialogs
  // ===========================================================================
  /** Confirmation / prompt dialog. Resolves with the typed text ('' if no input), or null if cancelled. */
  function ask(opts) {
    const d = $('#confirm-dialog');
    if (d.open) d.close();
    return new Promise(resolve => {
      let settled = false;
      const finish = val => { if (settled) return; settled = true; if (d.open) d.close(); resolve(val); };
      const needInput = !!(opts.input || opts.typeToConfirm);
      const inp = $('#confirm-input');
      const ok = $('#confirm-ok');
      $('#confirm-title').textContent = opts.title || '';
      $('#confirm-msg').textContent = opts.message || '';
      $('#confirm-msg').hidden = !opts.message;
      $('#confirm-field').hidden = !needInput;
      $('#confirm-label').textContent = opts.typeToConfirm ? `Type ${opts.typeToConfirm} to confirm` : ((opts.input && opts.input.label) || '');
      inp.value = (opts.input && opts.input.value) || '';
      inp.placeholder = (opts.input && opts.input.placeholder) || opts.typeToConfirm || '';
      ok.textContent = opts.confirmText || 'Confirm';
      ok.className = 'btn ' + (opts.danger ? 'btn-danger-solid' : 'btn-primary');
      const sync = () => { ok.disabled = !!opts.typeToConfirm && inp.value.trim().toUpperCase() !== opts.typeToConfirm.toUpperCase(); };
      inp.oninput = sync;
      sync();
      $('#confirm-form').onsubmit = e => { e.preventDefault(); if (!ok.disabled) finish(needInput ? inp.value.trim() : ''); };
      $('#confirm-cancel').onclick = () => finish(null);
      d.onclose = () => finish(null);
      d.showModal();
      setTimeout(() => (needInput ? inp : ok).focus(), 30);
    });
  }

  // ---- Admin login (code or admin card) ----
  const pinDialog = $('#pin-dialog');
  let pinResolve = null;
  let pinFails = 0, pinLockedUntil = 0;

  function askPin({ title = 'Admin login', hint } = {}) {
    if (pinDialog.open) pinDialog.close();
    return new Promise(resolve => {
      pinResolve = resolve;
      const hasAdminCards = allPeople().some(p => p.isAdmin && p.cardId);
      $('#pin-title').textContent = title;
      $('#pin-hint').textContent = hint || (hasAdminCards ? 'Enter your admin code, or tap an admin card.' : 'Enter your admin code.');
      $('#pin-input').value = '';
      $('#pin-error').textContent = '';
      pinDialog.showModal();
      setTimeout(() => $('#pin-input').focus(), 30);
    });
  }
  function finishPin(ok) {
    const r = pinResolve;
    pinResolve = null;
    if (pinDialog.open) pinDialog.close();
    if (r) r(ok);
  }
  $('#pin-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (Date.now() < pinLockedUntil) {
      $('#pin-error').textContent = `Too many attempts. Try again in ${Math.ceil((pinLockedUntil - Date.now()) / 1000)} s.`;
      return;
    }
    if ((await hashPin($('#pin-input').value)) === config.pinHash) { pinFails = 0; finishPin(true); return; }
    pinFails += 1;
    if (pinFails >= PIN_MAX_TRIES) {
      pinFails = 0;
      pinLockedUntil = Date.now() + PIN_LOCK_MS;
      $('#pin-error').textContent = 'Too many attempts. The login is locked for 30 seconds.';
    } else {
      $('#pin-error').textContent = `Incorrect admin code. ${PIN_MAX_TRIES - pinFails} ${PIN_MAX_TRIES - pinFails === 1 ? 'try' : 'tries'} left.`;
    }
    $('#pin-input').select();
  });
  $('#pin-input').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 8); });
  function pinOnCard(id) {
    const p = findByCard(id);
    $('#pin-input').value = '';
    if (p && p.isAdmin) { toast('Admin card accepted'); finishPin(true); }
    else $('#pin-error').textContent = 'That card isn\'t an admin card.';
  }
  $('#pin-cancel').addEventListener('click', () => finishPin(false));
  pinDialog.addEventListener('close', () => finishPin(false));

  // ===========================================================================
  // Setup wizard and settings
  // ===========================================================================
  const setupForm = $('#setup-form');
  const sf = setupForm.elements;
  let flow = SETUP_FLOW;
  let stepIdx = 0;
  let editing = false;
  let draft = null;
  let lastTestCard = '';

  const stepName = () => flow[stepIdx];
  const radioValue = name => { const r = setupForm.querySelector(`input[name="${name}"]:checked`); return r ? r.value : ''; };
  const setRadio = (name, value) => { $$(`input[name="${name}"]`, setupForm).forEach(r => { r.checked = r.value === value; }); };
  const draftStorage = () => radioValue('storage') || 'local';
  const draftCardMode = () => radioValue('cardMode') || 'off';
  const draftScreening = () => radioValue('screeningEnabled') === 'yes';
  const visibleSteps = () => flow.filter(s => s !== 'finish');
  const isSkippable = name => !editing && (name === 'logo' || (name === 'sheet' && draftStorage() === 'local'));

  function stepLabel(s) {
    if (s === 'sheet') return draftStorage() === 'cloud' ? 'Google Sheets' : 'People spreadsheet';
    return STEPS[s].label;
  }
  function stepHint(s) {
    return {
      company: 'Name and brand color', admin: 'Name and admin code', logo: 'Optional', cards: 'Tap to sign in and out',
      storage: 'This device or the cloud', sheet: draftStorage() === 'cloud' ? 'Connect your sheet' : 'Optional',
      questions: 'Screening and photos', form: 'Fields visitors fill in', agreement: 'Rules and signature', kiosk: 'Behavior and retention',
    }[s] || '';
  }

  function syncChoiceStates() {
    $$('.choice').forEach(c => {
      const input = $('input', c);
      c.classList.toggle('is-checked', !!(input && input.checked));
      c.classList.toggle('is-disabled', !!(input && input.disabled));
    });
  }
  document.addEventListener('change', e => { if (e.target.closest && e.target.closest('.choice')) syncChoiceStates(); });

  function openSetup(isEdit, startAt) {
    editing = !!isEdit;
    flow = editing ? SETTINGS_FLOW : SETUP_FLOW;
    lastTestCard = '';
    const c = config;
    draft = {
      logo: c.logo, logoTone: c.logoTone,
      localCards: clone(c.localCards),
      questions: clone(c.screening.questions),
      sheetTest: c.storage === 'local' && c.sheetUrl ? { url: c.sheetUrl, people: roster.rows } : null,
      cloudTest: c.storage === 'cloud' && c.cloudUrl
        ? { url: c.cloudUrl, key: c.cloudKey, sheetName: c.cloudSheetName, sheetUrl: c.cloudSheetUrl, people: roster.rows } : null,
      imported: null,
    };
    fillSetupForm(c);
    $('#aside-mode').textContent = editing ? 'Settings' : 'Setup';
    $('#pin-keep-note').hidden = !(editing && c.pinHash);
    $$('[data-pin-req]').forEach(r => { r.hidden = editing && !!c.pinHash; });
    $('.import-line').hidden = editing;
    renderSheetStatus(draft.sheetTest && draft.sheetTest.people.length ? { ok: true, people: draft.sheetTest.people, cached: true } : null);
    renderCloudStatus(draft.cloudTest ? { ok: true, cached: true, ...draft.cloudTest } : null);
    applyTheme(sf.accent.value);
    show('setup');
    gotoStep(startAt ? Math.max(0, flow.indexOf(startAt)) : 0);
  }

  function fillSetupForm(c) {
    sf.orgName.value = c.orgName || '';
    sf.accent.value = /^#[0-9a-f]{6}$/i.test(c.accent) ? c.accent : DEFAULT_CONFIG.accent;
    sf.adminName.value = c.adminName || '';
    sf.pin.value = '';
    sf.pin2.value = '';
    setRadio('cardMode', c.cardMode || 'off');
    setRadio('storage', c.storage || 'local');
    sf.sheetUrl.value = c.sheetUrl || '';
    sf.cloudUrl.value = c.cloudUrl || '';
    sf.cloudKey.value = c.cloudKey || generateKey();
    sf.kioskName.value = c.kioskName || DEFAULT_CONFIG.kioskName;
    sf.notifyHosts.checked = c.notifyHosts !== false;
    setRadio('screeningEnabled', c.screening && c.screening.enabled ? 'yes' : 'no');
    sf.declineMessage.value = (c.screening && c.screening.declineMessage) || DEFAULT_DECLINE;
    sf.alertEmails.value = (c.screening && c.screening.alertEmails) || '';
    setRadio('photoMode', c.photoMode || 'declined');
    sf.hosts.value = (c.hosts || []).join('\n');
    sf.purposes.value = (c.purposes || []).join('\n');
    sf.agreementEnabled.checked = !!c.agreementEnabled;
    sf.agreementText.value = c.agreementText || '';
    sf.signatureRequired.checked = !!c.signatureRequired;
    sf.welcome.value = c.welcome || '';
    sf.thanks.value = c.thanks || '';
    sf.resetSeconds.value = c.resetSeconds || 10;
    sf.retentionDays.value = String(c.retentionDays || 0);
    sf.autoSignOutOn.checked = !!c.autoSignOut;
    sf.autoSignOutAt.value = c.autoSignOut || '18:00';
    sf.printBadges.checked = c.printBadges !== false;
    sf.keepAwake.checked = c.keepAwake !== false;
    renderFieldMatrix(c.fields || DEFAULT_CONFIG.fields);
    renderSwatches();
    renderBrandPreview();
    renderLogoPreview();
    syncAgreementOptions();
    syncAutoOut();
    syncChoiceStates();
    if (draft) renderQuestionsStep();
  }

  function gotoStep(i) {
    stepIdx = Math.max(0, Math.min(flow.length - 1, i));
    const name = stepName();
    $$('.setup-step').forEach(fs => { fs.hidden = fs.dataset.step !== name; });
    $('#setup-error').textContent = '';
    if (name === 'company') renderBrandPreview();
    if (name === 'admin') renderPinChecks();
    if (name === 'logo') renderLogoPreview();
    if (name === 'cards') renderCardStep();
    if (name === 'sheet') syncSheetVariant();
    if (name === 'questions') renderQuestionsStep();
    if (name === 'finish') renderReady();
    renderStepper();
    renderTips();
    renderSetupButtons();
    window.scrollTo(0, 0);
    const first = $(`.setup-step[data-step="${name}"] input[type=text]:not([hidden]), .setup-step[data-step="${name}"] textarea`);
    if (first && finePointer() && !first.closest('[hidden]') && !first.value) first.focus();
  }

  function renderStepper() {
    const steps = visibleSteps();
    const name = stepName();
    const finished = name === 'finish';
    const idx = steps.indexOf(name);
    $('#setup-steps').replaceChildren(...steps.map((s, i) => {
      const state = finished || i < idx ? 'done' : i === idx ? 'active' : '';
      const li = el('li', { class: `vstep ${state}${editing && !finished ? ' clickable' : ''}`, 'aria-current': i === idx ? 'step' : null },
        el('span', { class: 'vs-icon' }, icon(state === 'done' && !editing ? 'check' : STEPS[s].icon)),
        el('span', { class: 'vs-text' }, el('strong', {}, stepLabel(s)), el('small', {}, state === 'done' && !editing ? 'Done' : stepHint(s))));
      if (editing && !finished) {
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        const jump = () => { if (i === idx || validateStep(name)) gotoStep(flow.indexOf(s)); };
        li.addEventListener('click', jump);
        li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); } });
      }
      return li;
    }));
    const total = steps.length;
    $('#mp-label').textContent = finished ? 'Setup complete' : editing ? 'Settings' : `Step ${idx + 1} of ${total}`;
    $('#mp-name').textContent = finished ? '' : stepLabel(name);
    $('#mp-fill').style.width = `${finished ? 100 : Math.round(((idx + 1) / total) * 100)}%`;
    $('#step-count').textContent = finished ? '' : editing ? `Settings · ${stepLabel(name)}` : `Step ${idx + 1} of ${total}`;
  }

  function renderTips() {
    const name = stepName();
    const key = name === 'sheet' ? (draftStorage() === 'cloud' ? 'sheetCloud' : 'sheetLocal') : name;
    const items = TIPS[key] || [];
    const build = () => (items.length ? [
      el('div', { class: 'tip-title' }, icon('info'), 'Good to know'),
      el('ul', { class: 'tip-list' }, items.map(t => el('li', {}, t))),
    ] : []);
    $('#tip-aside').replaceChildren(...build());
    $('#tip-inline').replaceChildren(...build());
    $('#tip-inline-wrap').hidden = !items.length;
  }

  function renderSetupButtons() {
    const name = stepName();
    const isFinish = name === 'finish';
    const nextIsFinish = flow[stepIdx + 1] === 'finish';
    const lastStep = stepIdx === flow.length - 1;
    $('#setup-back').hidden = stepIdx === 0 || isFinish;
    $('#setup-skip').hidden = !isSkippable(name);
    $('#setup-next').hidden = isFinish || (!editing && nextIsFinish) || (editing && lastStep);
    $('#setup-save').hidden = isFinish || !(editing || nextIsFinish);
    $('#setup-save').textContent = editing ? 'Save settings' : 'Finish setup';
    $('#setup-open').hidden = !isFinish;
    $('#setup-cancel').hidden = !editing || isFinish;
  }

  /** Validate one step; shows the problem and returns false if something needs fixing. */
  function validateStep(name) {
    const err = (msg, field) => {
      $('#setup-error').textContent = msg;
      if (field) { field.classList.add('invalid'); field.focus(); }
      return false;
    };
    $$('.invalid', setupForm).forEach(x => x.classList.remove('invalid'));
    $('#setup-error').textContent = '';

    if (name === 'company' && !sf.orgName.value.trim()) return err('Please enter your company name.', sf.orgName);

    if (name === 'admin') {
      if (!sf.adminName.value.trim()) return err('Please enter a name for the admin.', sf.adminName);
      const pin = sf.pin.value, pin2 = sf.pin2.value;
      if (editing && config.pinHash && !pin && !pin2) return true;
      if (!/^\d{4,8}$/.test(pin)) return err('The admin code must be 4 to 8 digits.', sf.pin);
      if (isEasyPin(pin)) return err('That code is too easy to guess. Avoid repeated or sequential digits.', sf.pin);
      if (pin !== pin2) return err('The two codes don\'t match.', sf.pin2);
    }

    if (name === 'sheet') {
      if (draftStorage() === 'cloud') {
        const problem = cloudUrlProblem(sf.cloudUrl.value);
        if (problem) return err(problem, sf.cloudUrl);
        if (!/^[A-Za-z0-9-]{12,64}$/.test(sf.cloudKey.value.trim())) return err('The kiosk key should be 12 to 64 letters, numbers or dashes.', sf.cloudKey);
        const t = draft.cloudTest;
        if (!t || t.url !== sf.cloudUrl.value.trim() || t.key !== sf.cloudKey.value.trim()) {
          return err('Click "Test connection" first. Setup can continue once the kiosk can reach your sheet.');
        }
        if (!sf.kioskName.value.trim()) sf.kioskName.value = DEFAULT_CONFIG.kioskName;
      } else {
        const url = sf.sheetUrl.value.trim();
        if (url && !sheetCsvUrl(url)) return err('That doesn\'t look like a Google Sheets link. Use Share, then Copy link.', sf.sheetUrl);
        if (url && (!draft.sheetTest || draft.sheetTest.url !== url)) return err('Click "Test link" to check the spreadsheet first, or skip this step.');
      }
    }

    if (name === 'questions' && draftScreening()) {
      const qs = draft.questions;
      if (!qs.length) return err('Add at least one question, or choose "No extra questions".');
      for (let i = 0; i < qs.length; i++) {
        const q = qs[i];
        const input = $$('#q-list .q-text')[i];
        if (!q.text.trim()) return err(`Question ${i + 1} needs some text.`, input);
        const card = $$('#q-list .qcard')[i];
        if (q.type === 'choice' && q.options.length < 2) return err(`Question ${i + 1} needs at least two options, one per line.`, card && card.querySelector('textarea'));
        if (q.action !== 'none' && !q.options.includes(q.when)) return err(`Choose which answer triggers the rule for question ${i + 1}.`);
      }
      if (draftStorage() === 'cloud') {
        const bad = splitEmails(sf.alertEmails.value).filter(e => !EMAIL_RE.test(e));
        if (bad.length) return err(`Check this email address: ${bad[0]}`, sf.alertEmails);
      }
    }

    if (name === 'agreement' && sf.agreementEnabled.checked && !sf.agreementText.value.trim()) {
      return err('Please enter the agreement text, or turn the agreement off.', sf.agreementText);
    }

    if (name === 'kiosk') {
      const secs = Number(sf.resetSeconds.value);
      if (!Number.isFinite(secs) || secs < 3 || secs > 120) return err('The return time must be between 3 and 120 seconds.', sf.resetSeconds);
      if (sf.autoSignOutOn.checked && !/^\d{2}:\d{2}$/.test(sf.autoSignOutAt.value)) return err('Choose a time for the automatic sign-out.', sf.autoSignOutAt);
    }
    return true;
  }

  $('#setup-next').addEventListener('click', () => { if (validateStep(stepName())) gotoStep(stepIdx + 1); });
  $('#setup-back').addEventListener('click', () => gotoStep(stepIdx - 1));
  $('#setup-skip').addEventListener('click', () => {
    const name = stepName();
    if (name === 'logo') { draft.logo = ''; draft.logoTone = ''; renderLogoPreview(); $('#logo-note').hidden = true; }
    if (name === 'sheet') { sf.sheetUrl.value = ''; draft.sheetTest = null; renderSheetStatus(null); }
    if (flow[stepIdx + 1] === 'finish') saveSetup();
    else gotoStep(stepIdx + 1);
  });
  $('#setup-cancel').addEventListener('click', () => {
    if (config.cardMode !== 'nfc') cards.stopNfc();
    applyTheme();
    show('admin');
    startKioskReader();
  });
  $('#setup-open').addEventListener('click', () => { show('home'); startKioskReader(); });
  setupForm.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    if (['checkbox', 'radio', 'file', 'color'].includes(e.target.type)) return;
    e.preventDefault();
    if (e.target === sf.sheetUrl) { $('#sheet-test').click(); return; }
    if (e.target === sf.cloudUrl) { $('#cloud-test').click(); return; }
    if (e.target.classList.contains('q-text')) return;
    if (!$('#setup-next').hidden) $('#setup-next').click();
    else if (!$('#setup-save').hidden) saveSetup();
  });
  setupForm.addEventListener('submit', e => { e.preventDefault(); saveSetup(); });
  setupForm.addEventListener('input', e => { if (e.target.classList) e.target.classList.remove('invalid'); });

  async function saveSetup() {
    for (const s of visibleSteps()) {
      if (s === 'questions' && !draft) continue;
      if (!validateStep(s)) {
        const msg = $('#setup-error').textContent;
        gotoStep(flow.indexOf(s));
        validateStep(s);
        $('#setup-error').textContent = msg;
        return;
      }
    }
    const storage = draftStorage();
    const base = editing ? config : mergeConfig({ ...config, ...(draft.imported || {}) });
    const next = {
      ...base,
      setupComplete: true,
      orgName: sf.orgName.value.trim(),
      accent: sf.accent.value,
      adminName: sf.adminName.value.trim(),
      logo: draft.logo,
      logoTone: draft.logo ? draft.logoTone : '',
      cardMode: draftCardMode(),
      localCards: draft.localCards,
      storage,
      sheetUrl: sf.sheetUrl.value.trim(),
      cloudUrl: sf.cloudUrl.value.trim(),
      cloudKey: sf.cloudKey.value.trim(),
      kioskName: sf.kioskName.value.trim() || DEFAULT_CONFIG.kioskName,
      notifyHosts: sf.notifyHosts.checked,
      screening: {
        enabled: draftScreening() && draft.questions.length > 0,
        questions: draft.questions.map(normalizeQuestion).filter(Boolean),
        declineMessage: sf.declineMessage.value.trim() || DEFAULT_DECLINE,
        alertEmails: splitEmails(sf.alertEmails.value).join(', '),
      },
      photoMode: radioValue('photoMode') || 'declined',
    };
    if (storage === 'cloud' && draft.cloudTest) {
      next.cloudSheetName = draft.cloudTest.sheetName || '';
      next.cloudSheetUrl = draft.cloudTest.sheetUrl || '';
    }
    if (editing) {
      const fields = {};
      for (const fd of FIELDS) {
        const checked = setupForm.querySelector(`input[name="field_${fd.key}"]:checked`);
        fields[fd.key] = checked ? checked.value : (config.fields[fd.key] || fd.def);
      }
      Object.assign(next, {
        fields,
        hosts: lines(sf.hosts.value),
        purposes: lines(sf.purposes.value),
        agreementEnabled: sf.agreementEnabled.checked,
        agreementText: sf.agreementText.value.trim(),
        signatureRequired: sf.agreementEnabled.checked && sf.signatureRequired.checked,
        welcome: sf.welcome.value.trim(),
        thanks: sf.thanks.value.trim(),
        resetSeconds: Math.round(Number(sf.resetSeconds.value)),
        retentionDays: Number(sf.retentionDays.value) || 0,
        autoSignOut: sf.autoSignOutOn.checked ? sf.autoSignOutAt.value : '',
        printBadges: sf.printBadges.checked,
        keepAwake: sf.keepAwake.checked,
      });
    }
    if (sf.pin.value) next.pinHash = await hashPin(sf.pin.value);

    const prev = config;
    const movedToCloud = storage === 'cloud' && (prev.storage !== 'cloud' || prev.cloudUrl !== next.cloudUrl || prev.cloudKey !== next.cloudKey);
    config = mergeConfig(next);
    if (!saveConfig()) { config = prev; return; }

    if (config.storage === 'cloud') {
      if (draft.cloudTest && Array.isArray(draft.cloudTest.people)) {
        roster = { rows: draft.cloudTest.people.map(normalizePerson).filter(p => p.name), syncedAt: Date.now(), error: '' };
      }
    } else if (config.sheetUrl && draft.sheetTest && draft.sheetTest.url === config.sheetUrl) {
      roster = { rows: draft.sheetTest.people, syncedAt: Date.now(), error: '' };
    } else if (!config.sheetUrl) {
      roster = { rows: [], syncedAt: 0, error: '' };
    }
    saveRoster();

    if (movedToCloud) {
      const mine = visits.filter(v => !v.remote && !v.cloudPending);
      if (mine.length) {
        outbox = outbox.filter(o => o.type !== 'signin').concat(mine.map(v => ({ opId: uid(), at: Date.now(), type: 'signin', id: v.id })));
        saveOutbox();
        toast(`Uploading ${mine.length} existing ${mine.length === 1 ? 'visit' : 'visits'} to Google Sheets…`, 4500);
      }
    }
    applyTheme();
    applyLogoTone();
    if (config.cardMode !== 'nfc') cards.stopNfc();
    if (cloudOn()) scheduleSync(200);
    updateAttentionIndicators();

    if (editing) { toast('Settings saved'); show('admin'); startKioskReader(); }
    else gotoStep(flow.indexOf('finish'));
  }

  // ---- Company step ----
  function renderSwatches() {
    const cur = sf.accent.value.toLowerCase();
    $('#swatches').replaceChildren(...SWATCHES.map(c => el('button', {
      type: 'button', class: 'swatch', style: `background:${c}`, 'aria-label': `Use color ${c}`, 'aria-pressed': String(cur === c),
      onclick: () => { sf.accent.value = c; applyTheme(c); renderSwatches(); },
    })));
  }
  function renderBrandPreview() {
    $('#pv-name').textContent = sf.orgName.value.trim() || 'Your company';
    const img = $('#pv-logo');
    img.hidden = !(draft && draft.logo);
    if (draft && draft.logo) img.src = draft.logo;
  }
  sf.accent.addEventListener('input', e => { applyTheme(e.target.value); renderSwatches(); });
  sf.orgName.addEventListener('input', renderBrandPreview);

  function parseSettingsFile(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('That file isn\'t a valid settings export.'); }
    if (!data || data.type !== 'visitor-sign-in-settings' || !data.config || typeof data.config !== 'object') {
      throw new Error('That file isn\'t a Visitor Sign In settings export.');
    }
    const { pinHash, setupComplete, adminName, localCards = [], ...rest } = data.config;
    const cardsIn = (Array.isArray(localCards) ? localCards : []).filter(c => c && c.cardId && c.name && !c.isAdmin)
      .map(c => ({ cardId: String(c.cardId), name: String(c.name), company: String(c.company || ''), role: String(c.role || ''), isAdmin: false }));
    return { ...rest, localCards: cardsIn };
  }
  $('#setup-import').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imported = parseSettingsFile(await file.text());
      const merged = mergeConfig({ ...DEFAULT_CONFIG, ...imported });
      draft.imported = imported;
      draft.logo = merged.logo;
      draft.logoTone = merged.logoTone;
      draft.localCards = merged.localCards;
      draft.questions = clone(merged.screening.questions);
      draft.sheetTest = null;
      draft.cloudTest = null;
      fillSetupForm(merged);
      applyTheme(merged.accent);
      toast('Settings loaded. Check each step and create an admin code for this kiosk.', 5500);
    } catch (err) { toast(err.message, 5000); }
  });

  // ---- Admin step ----
  function renderPinChecks() {
    const p = sf.pin.value, q = sf.pin2.value;
    const keep = editing && config.pinHash && !p && !q;
    $('#pin-checks').hidden = keep;
    const st = { len: /^\d{4,8}$/.test(p), easy: p.length >= 4 && !isEasyPin(p), match: p.length >= 4 && p === q };
    $$('#pin-checks li').forEach(li => li.classList.toggle('ok', !!st[li.dataset.check]));
  }
  [sf.pin, sf.pin2].forEach(input => input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 8);
    renderPinChecks();
  }));
  $('#pin-show').addEventListener('click', () => {
    const btn = $('#pin-show');
    const showing = btn.getAttribute('aria-pressed') === 'true';
    [sf.pin, sf.pin2].forEach(i => { i.type = showing ? 'password' : 'text'; });
    btn.setAttribute('aria-pressed', String(!showing));
    btn.setAttribute('aria-label', showing ? 'Show code' : 'Hide code');
  });

  // ---- Logo step ----
  function renderLogoPreview() {
    const has = !!(draft && draft.logo);
    $('#logo-drop').hidden = has;
    $('#logo-result').hidden = !has;
    if (has) {
      ['#lp-a', '#lp-b', '#lp-c'].forEach(sel => $(sel).replaceChildren(el('img', { src: draft.logo, alt: '' })));
      const img = new Image();
      img.onload = () => { $('#logo-dims').textContent = `${img.naturalWidth} × ${img.naturalHeight} px · PNG`; };
      img.src = draft.logo;
    }
    renderBrandPreview();
  }

  /** Load a PNG, shrink it if needed, and check for transparency and overall brightness. */
  function analyzeLogo(file) {
    return new Promise((resolve, reject) => {
      const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
      if (!isPng) { reject(new Error('Please choose a PNG file. Other formats such as JPG can\'t have a transparent background.')); return; }
      if (file.size > 20 * 1024 * 1024) { reject(new Error('That file is too large. Please use a PNG under 20 MB.')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image couldn\'t be opened. Try exporting it again as a PNG.')); };
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = 800;
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, c.width, c.height);
        let transparent = 0, total = 0, lumSum = 0, lumCount = 0, cornersClear = false;
        try {
          const { data } = ctx.getImageData(0, 0, c.width, c.height);
          total = data.length / 4;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 250) transparent++;
            if (data[i + 3] > 128) { lumSum += luminance([data[i], data[i + 1], data[i + 2]]); lumCount++; }
          }
          const a = (x, y) => data[(y * c.width + x) * 4 + 3];
          cornersClear = [a(0, 0), a(c.width - 1, 0), a(0, c.height - 1), a(c.width - 1, c.height - 1)].some(v => v < 250);
        } catch { /* unreadable canvas: treat as opaque */ }
        const lum = lumCount ? lumSum / lumCount : 0.5;
        resolve({
          dataUrl: c.toDataURL('image/png'),
          hasAlpha: transparent / Math.max(total, 1) > 0.02 && cornersClear,
          tone: lum < 0.22 ? 'dark' : lum > 0.8 ? 'light' : '',
          width: img.naturalWidth, height: img.naturalHeight,
        });
      };
      img.src = url;
    });
  }

  async function handleLogoFile(file) {
    if (!file) return;
    const note = $('#logo-note');
    try {
      const res = await analyzeLogo(file);
      draft.logo = res.dataUrl;
      draft.logoTone = res.hasAlpha ? res.tone : '';
      renderLogoPreview();
      const msgs = [];
      if (res.hasAlpha) msgs.push(el('strong', {}, 'Looks great: the background is transparent. '));
      else msgs.push(el('strong', {}, 'This PNG has a solid background. '), 'A box will show behind your logo. For the cleanest look, export it again with a "transparent background". You can keep this one for now. ');
      if (res.width < 300) msgs.push('It\'s quite small, so it may look blurry on large screens. ');
      if (res.hasAlpha && res.tone === 'dark') msgs.push('Your logo is dark, so on dark screens the kiosk adds a light panel behind it.');
      if (res.hasAlpha && res.tone === 'light') msgs.push('Your logo is light, so on light screens the kiosk adds a dark panel behind it.');
      note.hidden = false;
      note.className = 'callout ' + (res.hasAlpha ? 'ok' : 'warn');
      note.replaceChildren(icon(res.hasAlpha ? 'check-circle' : 'alert'), el('div', {}, msgs));
    } catch (err) {
      note.hidden = false;
      note.className = 'callout err';
      note.replaceChildren(icon('alert'), el('div', {}, err.message));
    }
  }
  $('#logo-input').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; handleLogoFile(f); });
  const logoDrop = $('#logo-drop');
  logoDrop.addEventListener('click', () => $('#logo-input').click());
  logoDrop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#logo-input').click(); } });
  ['dragenter', 'dragover'].forEach(t => logoDrop.addEventListener(t, e => { e.preventDefault(); logoDrop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(t => logoDrop.addEventListener(t, e => { e.preventDefault(); logoDrop.classList.remove('drag'); }));
  logoDrop.addEventListener('drop', e => handleLogoFile(e.dataTransfer && e.dataTransfer.files[0]));
  $('#logo-replace').addEventListener('click', () => $('#logo-input').click());
  $('#logo-clear').addEventListener('click', () => { draft.logo = ''; draft.logoTone = ''; renderLogoPreview(); $('#logo-note').hidden = true; });

  // ---- Cards step ----
  function setTap(target, state, title, detail) {
    target.classList.remove('ok', 'err');
    if (state) target.classList.add(state);
    $('strong', target).textContent = title;
    $('small', target).textContent = detail;
  }

  function renderCardStep() {
    const mode = draftCardMode();
    const nfcChoice = $('#nfc-choice input');
    $('#nfc-support').textContent = cards.nfcSupported
      ? 'Uses this device\'s own NFC chip. NFC is available on this device.'
      : 'Uses the device\'s own NFC chip. Needs Chrome on Android, so it isn\'t available on this device.';
    nfcChoice.disabled = !cards.nfcSupported && config.cardMode !== 'nfc';
    syncChoiceStates();
    $('#card-test').hidden = mode === 'off';
    $('#nfc-start').hidden = !(mode === 'nfc' && !cards.nfcActive && cards.nfcSupported);
    if (!lastTestCard) {
      setTap($('#tap-target'), '', 'Test your reader',
        mode === 'nfc' ? (cards.nfcActive ? 'Hold a card against the back of this device.' : 'Press "Start NFC scan", then hold a card against the device.')
          : 'Tap any card on the reader now. Its number appears here.');
    }
    $('#make-admin-card').hidden = !lastTestCard;
    renderAdminCardsNote();
  }

  function renderAdminCardsNote() {
    const admins = draft ? draft.localCards.filter(c => c.isAdmin) : [];
    const note = $('#admin-cards-note');
    if (!admins.length) { note.textContent = 'Tip: register an admin card to unlock the admin panel with a tap instead of the code.'; return; }
    note.replaceChildren(`${admins.length} admin card${admins.length > 1 ? 's' : ''} registered on this kiosk. `,
      el('button', { type: 'button', class: 'link-btn', onclick: () => { draft.localCards = draft.localCards.filter(c => !c.isAdmin); renderCardStep(); } }, 'Remove'));
  }

  function setupOnCard(id) {
    lastTestCard = id;
    const known = findByCard(id) || draft.localCards.find(c => normCard(c.cardId) === normCard(id));
    setTap($('#tap-target'), 'ok', 'Card detected. Your reader works!', `Card ID: ${id}${known ? ` · ${known.isAdmin ? 'Admin card' : known.name}` : ''}`);
    $('#make-admin-card').hidden = false;
    $('#make-admin-card').disabled = !!(known && known.isAdmin);
  }

  $$('input[name=cardMode]').forEach(r => r.addEventListener('change', () => {
    lastTestCard = '';
    if (draftCardMode() !== 'nfc') cards.stopNfc();
    renderCardStep();
  }));
  $('#nfc-start').addEventListener('click', async () => {
    try { await cards.startNfc({ prompt: true }); renderCardStep(); }
    catch (e) { setTap($('#tap-target'), 'err', 'NFC couldn\'t start', e.message || 'Make sure NFC is turned on in the device settings.'); }
  });
  $('#make-admin-card').addEventListener('click', () => {
    if (!lastTestCard) return;
    draft.localCards = draft.localCards.filter(c => normCard(c.cardId) !== normCard(lastTestCard));
    draft.localCards.push({ cardId: lastTestCard, name: `${sf.adminName.value.trim() || 'Admin'} (admin card)`, company: '', role: 'Admin', isAdmin: true });
    $('#make-admin-card').disabled = true;
    toast('Admin card registered');
    renderAdminCardsNote();
  });

  // ---- Storage step ----
  $$('input[name=storage]').forEach(r => r.addEventListener('change', () => { renderStepper(); }));

  // ---- Spreadsheet step ----
  function syncSheetVariant() {
    const cloud = draftStorage() === 'cloud';
    $$('[data-storage]', setupForm).forEach(d => { d.hidden = d.dataset.storage !== (cloud ? 'cloud' : 'local'); });
    $('#key-display').textContent = sf.cloudKey.value.trim();
  }

  function renderSheetStatus(st) {
    const box = $('#sheet-status');
    if (!st) { box.hidden = true; return; }
    box.hidden = false;
    box.className = 'status-box' + (st.loading ? '' : st.ok ? ' ok' : ' err');
    if (st.loading) { box.replaceChildren(el('div', { class: 'sb-title' }, el('span', { class: 'spinner' }), 'Checking the spreadsheet…')); return; }
    if (!st.ok) { box.replaceChildren(el('div', { class: 'sb-title' }, icon('alert'), 'Couldn\'t read the sheet'), el('div', {}, st.error)); return; }
    const n = st.people.length, withCards = st.people.filter(p => p.cardId).length;
    box.replaceChildren(
      el('div', { class: 'sb-title' }, icon('check-circle'), st.cached ? 'Linked' : 'Connected!'),
      el('div', {}, `Found ${n} ${n === 1 ? 'person' : 'people'}${withCards ? `, ${withCards} with a card` : ''}.`),
      n ? el('table', {},
        el('thead', {}, el('tr', {}, ['Name', 'Card ID', 'Company', 'Role'].map(h => el('th', {}, h)))),
        el('tbody', {}, st.people.slice(0, 5).map(p => el('tr', {}, [p.name, p.cardId, p.company, p.isAdmin ? 'Admin' : p.role].map(v => el('td', {}, v || '–')))))) : null,
      n > 5 ? el('div', { class: 'hint' }, `…and ${n - 5} more`) : null);
  }

  $('#sheet-test').addEventListener('click', async () => {
    const url = sf.sheetUrl.value.trim();
    $('#setup-error').textContent = '';
    if (!url) { sf.sheetUrl.classList.add('invalid'); sf.sheetUrl.focus(); return; }
    const btn = $('#sheet-test');
    btn.disabled = true;
    renderSheetStatus({ loading: true });
    try {
      const { people } = await fetchSheet(url);
      draft.sheetTest = { url, people };
      renderSheetStatus({ ok: true, people });
    } catch (e) {
      draft.sheetTest = null;
      renderSheetStatus({ ok: false, error: e.message });
    } finally { btn.disabled = false; }
  });
  sf.sheetUrl.addEventListener('input', () => {
    if (draft.sheetTest && draft.sheetTest.url !== sf.sheetUrl.value.trim()) { draft.sheetTest = null; renderSheetStatus(null); }
  });
  $('#copy-headers').addEventListener('click', async () => {
    const ok = await copyText('Name\tCard ID\tCompany\tRole\tAdmin');
    toast(ok ? 'Copied. Click cell A1 in your sheet and paste.' : 'Type these in row 1: Name, Card ID, Company, Role, Admin');
  });

  function cloudTroubleshooting(code) {
    if (code === 'bad_key') return ['Click "Copy script" again and paste it over all of the old code in Apps Script.', 'Then deploy a new version: Deploy → Manage deployments → Edit → Version: New version → Deploy.'];
    if (code === 'not_configured') return ['Copy the script from this screen so that it includes your kiosk key, then deploy it again.'];
    if (code === 'offline') return ['Connect this device to the internet, then try again.'];
    return [
      'Check that "Who has access" is set to "Anyone", not "Only myself".',
      'Make sure you copied the Web app URL ending in /exec, not the address of the Apps Script editor.',
      'If you changed the script, deploy a new version: Deploy → Manage deployments → Edit → New version.',
    ];
  }

  function renderCloudStatus(st) {
    const box = $('#cloud-status');
    if (!st) { box.hidden = true; return; }
    box.hidden = false;
    box.className = 'status-box' + (st.loading ? '' : st.ok ? ' ok' : ' err');
    if (st.loading) { box.replaceChildren(el('div', { class: 'sb-title' }, el('span', { class: 'spinner' }), 'Connecting to Google Sheets…')); return; }
    if (!st.ok) {
      box.replaceChildren(el('div', { class: 'sb-title' }, icon('alert'), 'Not connected yet'), el('div', {}, st.error),
        el('ul', {}, cloudTroubleshooting(st.code).map(t => el('li', {}, t))));
      return;
    }
    const n = (st.people || []).length;
    box.replaceChildren(
      el('div', { class: 'sb-title' }, icon('check-circle'), st.cached ? 'Connected' : 'Connected! Everything is working.'),
      el('div', {}, 'Spreadsheet: ', st.sheetUrl ? el('a', { href: st.sheetUrl, target: '_blank', rel: 'noopener' }, st.sheetName || 'Open the sheet') : (st.sheetName || 'your sheet')),
      el('div', { class: 'hint' }, `People tab: ${n} ${n === 1 ? 'person' : 'people'}. Visits are saved to the Visits tab.`));
  }

  $('#cloud-test').addEventListener('click', async () => {
    const url = sf.cloudUrl.value.trim();
    const key = sf.cloudKey.value.trim();
    $('#setup-error').textContent = '';
    const problem = cloudUrlProblem(url);
    if (problem) { renderCloudStatus({ ok: false, error: problem, code: 'url' }); sf.cloudUrl.classList.add('invalid'); return; }
    const btn = $('#cloud-test');
    btn.disabled = true;
    renderCloudStatus({ loading: true });
    try {
      const data = await cloudRequest({ action: 'ping' }, { url, key });
      draft.cloudTest = { url, key, sheetName: data.sheetName || '', sheetUrl: data.sheetUrl || '', people: Array.isArray(data.people) ? data.people : [] };
      renderCloudStatus({ ok: true, ...draft.cloudTest });
    } catch (e) {
      draft.cloudTest = null;
      renderCloudStatus({ ok: false, error: e.message, code: e.code });
    } finally { btn.disabled = false; }
  });
  [sf.cloudUrl, sf.cloudKey].forEach(input => input.addEventListener('input', () => {
    $('#key-display').textContent = sf.cloudKey.value.trim();
    const t = draft.cloudTest;
    if (t && (t.url !== sf.cloudUrl.value.trim() || t.key !== sf.cloudKey.value.trim())) { draft.cloudTest = null; renderCloudStatus(null); }
  }));
  $('#copy-script').addEventListener('click', async () => {
    const src = connectorSource(sf.cloudKey.value.trim());
    if (!src) { toast('The connector script didn\'t load. Reload the page and try again.'); return; }
    if (await copyText(src)) toast('Script copied. Paste it into the Apps Script editor, replacing everything there.', 4500);
    else { download('Code.gs', src, 'text/plain'); toast('Copying isn\'t allowed here, so the script was downloaded instead.'); }
  });
  $('#download-script').addEventListener('click', () => {
    const src = connectorSource(sf.cloudKey.value.trim());
    if (src) download('Code.gs', src, 'text/plain');
  });

  // ---- Screening questions step ----
  function renderQuestionsStep() {
    const on = draftScreening();
    $('#screening-builder').hidden = !on;
    const cloud = draftStorage() === 'cloud';
    $('#alert-emails-field').hidden = !cloud;
    $('#alert-local-note').hidden = cloud;
    renderTemplates();
    renderQuestionList();
    renderPhotoHint();
  }
  $$('input[name=screeningEnabled]').forEach(r => r.addEventListener('change', renderQuestionsStep));
  $$('input[name=photoMode]').forEach(r => r.addEventListener('change', renderPhotoHint));

  function renderTemplates() {
    $('#q-templates').replaceChildren(...QUESTION_TEMPLATES.map(t => el('button', {
      type: 'button', class: 'qt-chip', disabled: draft.questions.some(q => q.text === t.text), onclick: () => addQuestion(t),
    }, icon('plus'), t.label)));
  }

  function addQuestion(t) {
    draft.questions.push(normalizeQuestion({ ...t, id: uid() }));
    renderQuestionList();
    renderTemplates();
    renderPhotoHint();
    if (!t.text) { const inputs = $$('#q-list .q-text'); const last = inputs[inputs.length - 1]; if (last) last.focus(); }
  }
  $('#q-add').addEventListener('click', () => addQuestion({ text: '', type: 'yesno', when: 'Yes', action: 'none' }));

  function moveQuestion(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= draft.questions.length) return;
    const qs = draft.questions;
    [qs[i], qs[j]] = [qs[j], qs[i]];
    renderQuestionList();
  }

  function ruleNote(q) {
    if (q.type === 'text') return 'Short answers are saved with the visit. They can\'t trigger a rule.';
    if (q.action === 'decline') return `Visitors who answer "${q.when}" are politely declined${radioValue('photoMode') !== 'off' ? ' after a quick photo' : ''}, and staff are alerted. An admin can override this.`;
    if (q.action === 'flag') return `Visitors who answer "${q.when}" can still sign in, and staff are alerted.`;
    return 'Answers are saved with the visit.';
  }

  function questionCard(q, i) {
    const n = draft.questions.length;
    const card = el('li', { class: 'qcard' });
    const setCardClass = () => { card.className = 'qcard' + (q.action === 'decline' ? ' rule-decline' : q.action === 'flag' ? ' rule-flag' : ''); };
    const note = el('p', { class: 'q-note' });

    const text = el('input', { type: 'text', class: 'q-text', value: q.text, placeholder: 'Type your question, e.g. Have you visited us before?', maxlength: '200', 'aria-label': `Question ${i + 1}` });
    text.addEventListener('input', () => { q.text = text.value; renderTemplates(); });

    const when = el('select', { class: 'q-when', 'aria-label': 'Answer that triggers the rule' });
    const fillWhen = () => {
      if (!q.options.includes(q.when)) q.when = q.options[0] || '';
      when.replaceChildren(...q.options.map(o => el('option', { value: o }, o)));
      when.value = q.when;
    };
    when.addEventListener('change', () => { q.when = when.value; note.textContent = ruleNote(q); });

    const action = el('select', { class: 'q-action', 'aria-label': 'What happens' },
      [['none', 'Do nothing'], ['decline', 'Politely decline'], ['flag', 'Allow & alert staff']].map(([v, l]) => el('option', { value: v }, l)));
    action.value = q.action;
    action.addEventListener('change', () => { q.action = action.value; setCardClass(); note.textContent = ruleNote(q); renderPhotoHint(); });

    const optionsArea = el('textarea', { rows: '3', placeholder: 'One option per line' });
    optionsArea.value = q.type === 'choice' ? q.options.join('\n') : '';
    optionsArea.addEventListener('input', () => { q.options = lines(optionsArea.value); q.choiceOptions = q.options; fillWhen(); });
    const optionsRow = el('label', { class: 'q-row q-options', style: 'flex-direction:column;align-items:stretch' }, el('span', { class: 'q-lbl' }, 'Options'), optionsArea);
    const ruleRow = el('div', { class: 'q-row q-rule' }, el('span', { class: 'q-lbl' }, 'If the answer is'), when, el('span', { class: 'q-lbl' }, 'then'), action);

    const typeSeg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Answer type' },
      [['yesno', 'Yes / No'], ['choice', 'Multiple choice'], ['text', 'Short answer']].map(([val, label]) => {
        const r = el('input', { type: 'radio', name: `qtype_${q.id}`, value: val, checked: q.type === val });
        r.addEventListener('change', () => {
          if (q.type === 'choice') q.choiceOptions = q.options;
          q.type = val;
          q.options = val === 'yesno' ? ['Yes', 'No'] : val === 'choice' ? (q.choiceOptions || []) : [];
          if (val === 'text') q.action = 'none';
          renderQuestionList();
        });
        return el('label', {}, r, el('span', {}, label));
      }));

    const tools = el('div', { class: 'qtools' },
      el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Move up', title: 'Move up', disabled: i === 0, onclick: () => moveQuestion(i, -1) }, icon('arrow-up')),
      el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Move down', title: 'Move down', disabled: i === n - 1, onclick: () => moveQuestion(i, 1) }, icon('arrow-down')),
      el('button', {
        type: 'button', class: 'icon-btn sm', 'aria-label': 'Delete question', title: 'Delete',
        onclick: () => { draft.questions.splice(i, 1); renderQuestionList(); renderTemplates(); renderPhotoHint(); },
      }, icon('trash')));

    optionsRow.hidden = q.type !== 'choice';
    ruleRow.hidden = q.type === 'text';
    fillWhen();
    setCardClass();
    note.textContent = ruleNote(q);
    card.append(
      el('div', { class: 'qcard-head' }, el('span', { class: 'qnum' }, String(i + 1)), text, tools),
      el('div', { class: 'qcard-body' }, el('div', { class: 'q-row' }, el('span', { class: 'q-lbl' }, 'Answer'), typeSeg), optionsRow, ruleRow, note));
    return card;
  }

  function renderQuestionList() {
    $('#q-list').replaceChildren(...draft.questions.map((q, i) => questionCard(q, i)));
  }

  function renderPhotoHint() {
    const mode = radioValue('photoMode');
    const hasDecline = draftScreening() && draft.questions.some(q => q.action === 'decline' && q.type !== 'text');
    let text = mode === 'off' ? 'No photos are taken.'
      : mode === 'all' ? 'Every visitor has a photo taken after the sign-in form. It is printed on their badge and kept with the visit record.'
        : hasDecline ? 'Visitors who are declined have a quick photo taken before they see the decline message. It is attached to the staff alert.'
          : 'This only applies when a screening question declines a visitor.';
    if (mode !== 'off' && !window.isSecureContext) text += ' Note: the camera needs a secure (https) connection.';
    else if (mode !== 'off' && !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) text += ' Note: this browser has no camera access.';
    $('#photo-hint').textContent = text;
    $$('#q-list .qcard').forEach((card, i) => { const q = draft.questions[i]; if (q) $('.q-note', card).textContent = ruleNote(q); });
  }

  // ---- Settings-only steps ----
  function renderFieldMatrix(fields) {
    const opts = [['off', 'Hidden'], ['optional', 'Optional'], ['required', 'Required']];
    $('#field-matrix').replaceChildren(...FIELDS.map(fd => {
      const cur = fields[fd.key] || fd.def;
      return el('div', { class: 'fm-row' },
        el('span', { class: 'fm-name' }, fd.short || fd.label),
        el('div', { class: 'seg', role: 'radiogroup', 'aria-label': fd.label },
          opts.map(([val, txt]) => el('label', {}, el('input', { type: 'radio', name: `field_${fd.key}`, value: val, checked: cur === val }), el('span', {}, txt)))));
    }));
  }
  const syncAgreementOptions = () => { $('#agreement-options').hidden = !sf.agreementEnabled.checked; };
  const syncAutoOut = () => { $('#auto-out-time').hidden = !sf.autoSignOutOn.checked; };
  sf.agreementEnabled.addEventListener('change', syncAgreementOptions);
  sf.autoSignOutOn.addEventListener('change', syncAutoOut);

  // ---- Finish ----
  function renderReady() {
    const c = config;
    const adminCards = allPeople().filter(p => p.isAdmin && p.cardId).length;
    const qs = c.screening.enabled ? c.screening.questions : [];
    const declines = qs.filter(q => q.action === 'decline').length;
    const flags = qs.filter(q => q.action === 'flag').length;
    const people = roster.rows.length;
    const row = (iconName, label, value, sub) => el('li', {},
      el('span', { class: 'sum-icon' }, icon(iconName)), el('span', { class: 'sum-label' }, label),
      el('span', { class: 'sum-value' }, value, sub ? el('small', {}, sub) : null));
    $('#ready-summary').replaceChildren(
      row('building', 'Company', [el('span', { class: 'color-dot', style: `background:${c.accent}` }), c.orgName]),
      row('shield', 'Admin', c.adminName, adminCards ? `Admin code set · ${adminCards} admin card${adminCards > 1 ? 's' : ''}` : 'Admin code set'),
      row('image', 'Logo', c.logo ? 'Uploaded' : 'Not added yet', c.logo ? '' : 'Add one any time in Settings'),
      row('card', 'Cards', { off: 'Off', usb: 'USB / Bluetooth reader', nfc: 'Built-in NFC' }[c.cardMode]),
      row(c.storage === 'cloud' ? 'cloud' : 'device', 'Storage', c.storage === 'cloud' ? 'Google Sheets' : 'On this device', c.storage === 'cloud' ? (c.cloudSheetName ? `"${c.cloudSheetName}" · kiosk "${c.kioskName}"` : '') : 'Works offline'),
      row('sheet', 'People', people ? `${people} ${people === 1 ? 'person' : 'people'} from your sheet` : (c.storage === 'cloud' ? 'People tab is empty' : 'No spreadsheet linked')),
      row('question', 'Screening', qs.length ? `${qs.length} question${qs.length > 1 ? 's' : ''}` : 'No extra questions',
        qs.length ? [declines && `${declines} can decline`, flags && `${flags} alert staff`].filter(Boolean).join(' · ') || 'Answers are recorded' : ''),
      row('camera', 'Photos', { off: 'No photos', declined: 'Declined visitors only', all: 'Every visitor' }[c.photoMode]));

    const steps = [
      ['Put the kiosk at your entrance', 'Mount the tablet or screen at reception and keep it plugged in. To stop visitors leaving the app, use Guided Access (iPad) or screen pinning (Android).'],
      ['Add it to the home screen', 'In the browser menu, choose "Add to Home Screen". The kiosk then opens full screen and keeps working offline.'],
      ['Open the admin panel', 'Tap the gear in the top-right corner of the welcome screen and enter your admin code' + (adminCards ? ', or tap your admin card.' : '.')],
    ];
    if (c.cardMode !== 'off') steps.push(['Register cards', c.storage === 'cloud' ? 'Add Card IDs to the People tab of your sheet, or use Admin → People & cards → Add a card and tap each card.' : 'Add Card IDs to your spreadsheet, or use Admin → People & cards → Add a card and tap each card.']);
    if (declines) steps.push(['Know what happens when someone is declined', c.storage === 'cloud' && c.screening.alertEmails ? `They see your polite message and ${c.screening.alertEmails} receive an email with their photo. Override from the kiosk with "Staff override" or in the admin panel.` : 'They see your polite message, and the admin panel shows an alert. Override from the kiosk with "Staff override" or in the admin panel.']);
    steps.push(c.storage === 'cloud'
      ? ['Bookmark your Google Sheet', 'The Visits tab updates live. Share the sheet with colleagues so they can see who\'s on site.']
      : ['Back up regularly', 'Visits are stored on this device. Download a CSV any time from Admin → Data.']);
    steps.push(['Be ready for emergencies', 'Admin → Dashboard → Print roll call lists everyone who is on site right now.']);
    $('#ready-next').replaceChildren(...steps.map(([t, s]) => el('li', {}, el('div', {}, el('strong', {}, t), el('span', {}, s)))));
  }

  // ===========================================================================
  // Welcome screen
  // ===========================================================================
  function renderHome() {
    const logo = $('#home-logo');
    logo.hidden = !config.logo;
    if (config.logo) { logo.src = config.logo; logo.alt = `${config.orgName} logo`; }
    $('#home-org').textContent = config.orgName;
    $('#home-welcome').textContent = config.welcome;
    document.title = config.orgName ? `${config.orgName} · Visitor Sign In` : 'Visitor Sign In';
    $('#card-hint').hidden = config.cardMode === 'off';
    $('#nfc-activate').hidden = !(config.cardMode === 'nfc' && cards.nfcSupported && !cards.nfcActive);
    renderHomeStatus();
    tickClock();
  }
  function renderHomeStatus() {
    updateAttentionIndicators();
    renderSyncIndicators();
  }
  function tickClock() {
    const now = new Date();
    $('#home-clock').textContent = `${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} · ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  setInterval(() => { if (current === 'home') tickClock(); }, 15 * 1000);

  function renderSyncIndicators() {
    const chip = $('#home-sync');
    if (!cloudOn()) { chip.hidden = true; }
    else {
      chip.hidden = false;
      const st = syncState.state;
      chip.className = 'sync-chip' + (st === 'offline' ? ' warn' : st === 'error' ? ' err' : '');
      chip.textContent = st === 'offline' ? `Offline · ${outbox.length} waiting` : st === 'error' ? 'Sync issue' : st === 'syncing' ? 'Syncing…' : outbox.length ? `${outbox.length} waiting` : 'Synced';
    }
    if (current === 'admin') renderStorageInfo();
  }

  function updateAttentionIndicators() {
    const n = visits.filter(needsAttention).length;
    $('#admin-dot').hidden = !n;
    $('#attn-badge').hidden = !n;
    $('#attn-badge').textContent = String(n);
  }

  $('#go-signin').addEventListener('click', () => startSignIn());
  $('#go-signout').addEventListener('click', () => show('signout'));
  $('#nfc-activate').addEventListener('click', async () => {
    try { await cards.startNfc({ prompt: true }); toast('Card reader is on'); }
    catch (e) { toast(e.message || 'Couldn\'t start NFC', 5000); }
    renderHome();
  });
  $('#open-admin').addEventListener('click', async () => { if (await askPin()) show('admin'); });

  /** Web NFC can only start without a tap if permission was granted before. */
  async function startKioskReader() {
    if (config.cardMode === 'nfc' && cards.nfcSupported && !cards.nfcActive) {
      try { await cards.startNfc({ prompt: false }); } catch { /* staff can tap the activate button */ }
      if (current === 'home') renderHome();
    }
  }

  let wakeLock = null;
  async function keepAwake() {
    if (!config.keepAwake || !('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      keepAwake();
      if (cloudOn() && current !== 'setup') cloudSync();
    }
  });

  // ===========================================================================
  // Sign-in flow: details, then questions, then agreement
  // ===========================================================================
  const signinForm = $('#signin-form');
  let flowSteps = [];
  let flowIdx = 0;
  let sigNeedsReset = true;
  const activeQuestions = () => (config.screening.enabled ? config.screening.questions.filter(q => q.text.trim()) : []);
  const agreementActive = () => config.agreementEnabled && !!config.agreementText.trim();

  function startSignIn() {
    flowSteps = ['details'];
    if (activeQuestions().length) flowSteps.push('questions');
    if (agreementActive()) flowSteps.push('agreement');
    signinForm.reset();
    sigNeedsReset = true;
    renderDetailsFields();
    renderScreeningFields();
    $('#agreement-text').textContent = config.agreementText;
    $('#signature-wrap').hidden = !(agreementActive() && config.signatureRequired);
    show('signin');
    gotoFlow(0);
  }

  function gotoFlow(i) {
    flowIdx = i;
    const step = flowSteps[i];
    $$('.flow-step', signinForm).forEach(s => { s.hidden = s.dataset.flow !== step; });
    $('#signin-error').textContent = '';
    $$('.invalid', signinForm).forEach(x => x.classList.remove('invalid'));
    const labels = { details: 'Details', questions: 'Questions', agreement: 'Agreement', photo: 'Photo' };
    const all = flowSteps.concat(config.photoMode === 'all' ? ['photo'] : []);
    $('#flow-steps').replaceChildren(...(all.length > 1 ? all.map((s, k) => el('li', { class: k < i ? 'done' : k === i ? 'active' : '' },
      k < i ? icon('check') : el('b', {}, String(k + 1)), el('span', {}, labels[s]))) : []));
    $('#flow-back span').textContent = i === 0 ? 'Cancel' : 'Back';
    const last = i === flowSteps.length - 1;
    $('#flow-next').textContent = last ? (config.photoMode === 'all' ? 'Continue to photo' : 'Sign in') : 'Continue';
    if (step === 'agreement' && config.signatureRequired && sigNeedsReset) {
      sigNeedsReset = false;
      requestAnimationFrame(() => sig.reset());
    }
    window.scrollTo(0, 0);
    const first = $(`.flow-step[data-flow="${step}"] input[type=text], .flow-step[data-flow="${step}"] input[type=email], .flow-step[data-flow="${step}"] input[type=tel]`);
    if (first && finePointer() && !first.value) first.focus();
  }
  $('#flow-back').addEventListener('click', () => { if (flowIdx === 0) show('home'); else gotoFlow(flowIdx - 1); });

  function labelFor(text, required) {
    return el('span', { class: 'label' }, text, required ? el('b', { class: 'req', 'aria-hidden': 'true' }, ' *') : el('small', { class: 'muted' }, ' (optional)'));
  }

  function renderDetailsFields() {
    const nodes = [el('label', { class: 'field wide' }, labelFor('Full name', true),
      el('input', { type: 'text', name: 'name', required: true, maxlength: '120', autocomplete: 'name', autocapitalize: 'words' }))];
    for (const fd of FIELDS) {
      const mode = config.fields[fd.key];
      if (!mode || mode === 'off') continue;
      const required = mode === 'required';
      const cls = 'field' + (fd.wide ? ' wide' : '');
      if (fd.input === 'purpose' && config.purposes.length) {
        nodes.push(el('div', { class: cls }, labelFor(fd.label, required),
          el('div', { class: 'chips', role: 'radiogroup', 'aria-label': fd.label, 'data-name': fd.key },
            config.purposes.map(p => el('label', { class: 'chip' }, el('input', { type: 'radio', name: fd.key, value: p }), el('span', {}, p))))));
      } else if (fd.input === 'host') {
        const hosts = hostOptions();
        nodes.push(el('label', { class: cls }, labelFor(fd.label, required),
          el('input', { type: 'text', name: fd.key, required, maxlength: '120', list: hosts.length ? 'host-options' : null, autocomplete: 'off', placeholder: hosts.length ? 'Start typing or pick a name' : null }),
          hosts.length ? el('datalist', { id: 'host-options' }, hosts.map(h => el('option', { value: h }))) : null));
      } else if (fd.input === 'textarea') {
        nodes.push(el('label', { class: cls }, labelFor(fd.label, required), el('textarea', { name: fd.key, required, maxlength: '500', rows: '3' })));
      } else {
        nodes.push(el('label', { class: cls }, labelFor(fd.label, required),
          el('input', { type: fd.input === 'purpose' ? 'text' : fd.input, name: fd.key, required, maxlength: '120', autocomplete: fd.autocomplete || 'off', inputmode: fd.input === 'tel' ? 'tel' : null })));
      }
    }
    $('#signin-fields').replaceChildren(...nodes);
  }

  function renderScreeningFields() {
    $('#screening-fields').replaceChildren(...activeQuestions().map((q, i) => {
      const name = `sq_${q.id}`;
      const answer = q.type === 'text'
        ? el('input', { type: 'text', name, maxlength: '200', autocomplete: 'off', 'aria-label': q.text })
        : el('div', { class: 'chips' + (q.type === 'yesno' ? ' yesno' : ''), role: 'radiogroup', 'aria-label': q.text, 'data-name': name },
          q.options.map(o => el('label', { class: 'chip' }, el('input', { type: 'radio', name, value: o }), el('span', {}, o))));
      return el('div', { class: 'sq', 'data-qid': q.id }, el('p', { class: 'sq-text' }, el('span', { class: 'sq-num' }, `${i + 1}.`), q.text), answer);
    }));
  }

  function fieldValue(name) {
    const ctl = signinForm.elements[name];
    if (!ctl) return '';
    return String(ctl.value || '').trim();
  }

  function collectDetails() {
    const d = { name: fieldValue('name').replace(/\s+/g, ' ') };
    for (const fd of FIELDS) {
      const mode = config.fields[fd.key];
      if (!mode || mode === 'off') continue;
      const v = fieldValue(fd.key);
      if (v) d[fd.key] = v;
    }
    return d;
  }

  function evaluateScreening() {
    const answers = [];
    const reasons = [];
    for (const q of activeQuestions()) {
      const a = fieldValue(`sq_${q.id}`);
      answers.push({ q: q.text, a });
      if (q.type !== 'text' && q.action !== 'none' && a && a.toLowerCase() === String(q.when).toLowerCase()) {
        reasons.push({ q: q.text, a, action: q.action });
      }
    }
    return { answers, reasons, declined: reasons.some(r => r.action === 'decline') };
  }

  function validateFlowStep(step) {
    const err = $('#signin-error');
    err.textContent = '';
    $$('.invalid', signinForm).forEach(x => x.classList.remove('invalid'));
    const problems = [];
    if (step === 'details') {
      if (!fieldValue('name')) problems.push(signinForm.elements.name);
      for (const fd of FIELDS) {
        const mode = config.fields[fd.key];
        if (!mode || mode === 'off') continue;
        const v = fieldValue(fd.key);
        if (mode === 'required' && !v) problems.push(fd.input === 'purpose' && config.purposes.length ? $(`.chips[data-name="${fd.key}"]`) : signinForm.elements[fd.key]);
        else if (v && fd.input === 'email' && !EMAIL_RE.test(v)) { problems.push(signinForm.elements[fd.key]); err.textContent = 'Please check your email address.'; }
      }
    }
    if (step === 'questions') {
      for (const q of activeQuestions()) {
        const name = `sq_${q.id}`;
        if (!fieldValue(name)) problems.push(q.type === 'text' ? signinForm.elements[name] : $(`.chips[data-name="${name}"]`));
      }
      if (problems.length && !err.textContent) err.textContent = 'Please answer every question.';
    }
    if (step === 'agreement') {
      if (!signinForm.elements.agree.checked) { problems.push(signinForm.elements.agree.closest('.toggle')); err.textContent = 'Please accept the agreement to continue.'; }
      if (config.signatureRequired && sig.isEmpty()) { problems.push($('#sig-pad')); if (!err.textContent) err.textContent = 'Please sign in the box.'; }
    }
    if (problems.length) {
      problems.forEach(p => p && p.classList.add('invalid'));
      if (!err.textContent) err.textContent = 'Please complete the highlighted fields.';
      const firstBad = problems.find(Boolean);
      if (firstBad && firstBad.scrollIntoView) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    return true;
  }

  let submitting = false;
  signinForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (submitting) return;
    const step = flowSteps[flowIdx];
    if (!validateFlowStep(step)) return;
    if (step === 'questions') {
      const result = evaluateScreening();
      if (result.declined) { submitting = true; try { await declineVisitor(result); } finally { submitting = false; } return; }
    }
    if (flowIdx < flowSteps.length - 1) { gotoFlow(flowIdx + 1); return; }
    submitting = true;
    try { await completeSignIn(); } finally { submitting = false; }
  });
  signinForm.addEventListener('input', e => {
    if (e.target.classList) e.target.classList.remove('invalid');
    const group = e.target.closest && e.target.closest('.chips, .toggle');
    if (group) group.classList.remove('invalid');
  });
  signinForm.addEventListener('change', e => {
    const group = e.target.closest && e.target.closest('.chips, .toggle');
    if (group) group.classList.remove('invalid');
  });

  function addVisit(record) {
    record.cloudPending = true;
    visits.push(record);
    if (!saveVisits()) { visits.pop(); return false; }
    return true;
  }

  /** The visit is complete (photo taken or skipped): queue it for the cloud and update alerts. */
  function finalizeVisit(record) {
    if (record.cloudPending) {
      delete record.cloudPending;
      saveVisits();
      enqueue({ type: 'signin', id: record.id });
    }
    updateAttentionIndicators();
  }

  async function completeSignIn() {
    const record = { id: uid(), ...collectDetails(), method: 'screen', kiosk: config.kioskName, inAt: Date.now(), outAt: null };
    const qs = activeQuestions();
    if (qs.length) {
      const result = evaluateScreening();
      record.answers = result.answers;
      if (result.reasons.length) record.reasons = result.reasons;
    }
    const signature = agreementActive() && config.signatureRequired ? sig.toDataURL() : '';
    if (agreementActive()) record.agreed = true;
    if (!addVisit(record)) return;
    if (signature) { await saveMedia(record, 'signature', signature); saveVisits(); }
    if (config.photoMode === 'all') { startPhoto(record, 'all'); return; }
    finalizeVisit(record);
    showDone(record);
  }

  async function declineVisitor(result) {
    const record = {
      id: uid(), ...collectDetails(), method: 'screen', kiosk: config.kioskName, inAt: Date.now(), outAt: null,
      status: 'declined', answers: result.answers, reasons: result.reasons,
    };
    if (!addVisit(record)) return;
    if (config.photoMode !== 'off') { startPhoto(record, 'declined'); return; }
    finalizeVisit(record);
    showDeclined(record);
  }

  function showDone(record) {
    show('done');
    $('#done-title').textContent = `Welcome, ${firstName(record.name)}!`;
    $('#done-msg').textContent = record.method === 'card'
      ? `Signed in at ${fmtTime(record.inAt)}. Tap your card again when you leave.`
      : record.status === 'overridden' ? 'You have been signed in by a member of staff. Welcome!' : config.thanks;
    $('#badge-org').textContent = config.orgName;
    const bl = $('#badge-logo');
    bl.hidden = !config.logo;
    if (config.logo) bl.src = config.logo;
    const bp = $('#badge-photo');
    bp.hidden = true;
    bp.removeAttribute('src');
    if (record.photo) loadMedia(record, 'photo').then(src => { if (src && current === 'done') { bp.src = src; bp.hidden = false; } });
    $('#badge-label').textContent = (record.role || 'Visitor').toUpperCase();
    $('#badge-name').textContent = record.name;
    $('#badge-meta').textContent = [record.company, record.host && `Visiting: ${record.host}`, fmtDateTime(record.inAt)].filter(Boolean).join('\n');
    $('#print-badge').hidden = !config.printBadges;
    countdownHome(config.resetSeconds, $('#done-countdown'));
  }

  $('#print-badge').addEventListener('click', () => {
    clearInterval(countdownTimer);
    $('#done-countdown').textContent = '';
    const copy = $('#done-badge').cloneNode(true);
    copy.removeAttribute('id');
    $$('[id]', copy).forEach(n => n.removeAttribute('id'));
    printNode(copy);
    countdownHome(config.resetSeconds, $('#done-countdown'));
  });
  function printNode(node) {
    $('#print-area').replaceChildren(node);
    window.print();
  }
  window.addEventListener('afterprint', () => $('#print-area').replaceChildren());

  // ===========================================================================
  // Signature pad
  // ===========================================================================
  const sig = (() => {
    const canvas = $('#sig-pad');
    const ctx = canvas.getContext('2d');
    let drawing = false, dirty = false, last = null;

    function reset() {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#0f172a';
      ctx.fillStyle = '#0f172a';
      ctx.clearRect(0, 0, rect.width, rect.height);
      dirty = false;
    }
    const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      drawing = true;
      last = pos(e);
      ctx.beginPath();
      ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      dirty = true;
      canvas.classList.remove('invalid');
    });
    canvas.addEventListener('pointermove', e => {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    });
    const end = () => { drawing = false; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    $('#sig-clear').addEventListener('click', reset);
    window.addEventListener('resize', () => { if (current === 'signin' && !dirty) reset(); });

    return {
      reset,
      isEmpty: () => !dirty,
      toDataURL() {
        const out = document.createElement('canvas');
        const w = 480;
        const h = Math.max(1, Math.round(w * canvas.height / Math.max(canvas.width, 1)));
        out.width = w;
        out.height = h;
        const o = out.getContext('2d');
        o.fillStyle = '#fff';
        o.fillRect(0, 0, w, h);
        o.drawImage(canvas, 0, 0, w, h);
        return out.toDataURL('image/png');
      },
    };
  })();

  // ===========================================================================
  // Camera and photo step
  // ===========================================================================
  const camera = (() => {
    let stream = null;
    return {
      async start(video) {
        if (!window.isSecureContext) throw new Error('The camera needs a secure (https) connection.');
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw new Error('This device or browser has no camera access.');
        this.stop();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
        video.srcObject = stream;
        try { await video.play(); } catch { /* autoplay muted is allowed; ignore */ }
      },
      stop() {
        if (stream) stream.getTracks().forEach(t => t.stop());
        stream = null;
        const v = $('#camera-video');
        if (v) v.srcObject = null;
      },
      capture(video) {
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return '';
        const tw = 360, th = 480, ratio = tw / th;
        let sw = w, sh = h;
        if (w / h > ratio) sw = Math.round(h * ratio); else sh = Math.round(w / ratio);
        const sx = Math.round((w - sw) / 2), sy = Math.round((h - sh) / 2);
        const c = document.createElement('canvas');
        c.width = tw;
        c.height = th;
        c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, tw, th);
        let q = 0.8;
        let out = c.toDataURL('image/jpeg', q);
        while (out.length > 45000 && q > 0.35) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
        return out;
      },
    };
  })();

  let photoCtx = null;

  function setPhotoUI(state) { // 'live' | 'review' | 'error'
    $('#photo-take').hidden = state !== 'live';
    $('#photo-take').disabled = false;
    $('#photo-retake').hidden = state !== 'review';
    $('#photo-use').hidden = state !== 'review';
    $('#photo-skip').hidden = state !== 'error';
    $('#camera-still').hidden = state !== 'review';
    $('#camera-video').hidden = state === 'review';
    $('#camera-count').hidden = true;
  }

  async function startPhoto(record, purpose) {
    photoCtx = { record, purpose, data: '' };
    show('photo');
    const all = purpose === 'all';
    $('#photo-title').textContent = all ? 'Smile! Time for your badge photo' : 'One last step: a quick photo';
    $('#photo-lead').textContent = all
      ? 'We take a photo of every visitor. It\'s printed on your badge and kept with your visit record.'
      : 'Please look at the camera. We keep a photo with each visit record.';
    setPhotoUI('live');
    $('#photo-take').disabled = true;
    const msg = $('#camera-msg');
    msg.hidden = false;
    msg.textContent = 'Starting the camera…';
    try {
      await camera.start($('#camera-video'));
      if (current !== 'photo') { camera.stop(); return; }
      msg.hidden = true;
      $('#photo-take').disabled = false;
    } catch (e) {
      if (current !== 'photo') return;
      msg.hidden = false;
      msg.textContent = e && e.name === 'NotAllowedError'
        ? 'Camera access is blocked on this device. Please continue, and a member of staff will help if needed.'
        : e && e.name === 'NotFoundError' ? 'No camera was found on this device. Please continue without a photo.'
          : (e && e.message) || 'The camera isn\'t available right now.';
      setPhotoUI('error');
    }
  }

  $('#photo-take').addEventListener('click', async () => {
    if (!photoCtx) return;
    $('#photo-take').disabled = true;
    const count = $('#camera-count');
    for (const n of [3, 2, 1]) {
      count.hidden = false;
      count.textContent = String(n);
      count.style.animation = 'none';
      void count.offsetWidth;
      count.style.animation = '';
      await sleep(750);
      if (current !== 'photo' || !photoCtx) return;
    }
    count.hidden = true;
    const data = camera.capture($('#camera-video'));
    if (!data) { $('#camera-msg').hidden = false; $('#camera-msg').textContent = 'The photo didn\'t work. Please try again.'; $('#photo-take').disabled = false; return; }
    const cam = $('.camera');
    cam.classList.remove('flash');
    void cam.offsetWidth;
    cam.classList.add('flash');
    photoCtx.data = data;
    $('#camera-still').src = data;
    setPhotoUI('review');
  });
  $('#photo-retake').addEventListener('click', () => { if (photoCtx) photoCtx.data = ''; setPhotoUI('live'); });
  $('#photo-use').addEventListener('click', () => finishPhoto(photoCtx ? photoCtx.data : ''));
  $('#photo-skip').addEventListener('click', () => finishPhoto(''));
  function photoTimeout() { if (photoCtx) finishPhoto(photoCtx.data || ''); }

  async function finishPhoto(data) {
    if (!photoCtx) return;
    const { record, purpose } = photoCtx;
    photoCtx = null;
    camera.stop();
    if (data) await saveMedia(record, 'photo', data);
    else record.photoMissing = true;
    saveVisits();
    finalizeVisit(record);
    if (purpose === 'declined') showDeclined(record);
    else showDone(record);
  }

  // ===========================================================================
  // Declined visitors and overrides
  // ===========================================================================
  let declinedId = null;
  const declineMessage = () => (config.screening.declineMessage || DEFAULT_DECLINE).replace(/\{company\}/gi, config.orgName || 'us');

  function showDeclined(record) {
    declinedId = record.id;
    show('declined');
    $('#declined-title').textContent = `Thank you, ${firstName(record.name)}`;
    $('#declined-msg').textContent = declineMessage();
    countdownHome(Math.max(config.resetSeconds, 20), $('#declined-countdown'));
  }
  $('#declined-done').addEventListener('click', () => show('home'));
  $('#declined-override').addEventListener('click', async () => {
    clearInterval(countdownTimer);
    $('#declined-countdown').textContent = '';
    const v = visits.find(x => x.id === declinedId);
    const resume = () => { if (current === 'declined') countdownHome(20, $('#declined-countdown')); };
    if (!v || v.status !== 'declined') { show('home'); return; }
    if (!(await askPin({ title: 'Staff override', hint: 'Enter the admin code, or tap an admin card, to let this visitor in.' }))) { resume(); return; }
    const reason = await ask({
      title: `Let ${v.name} in?`,
      message: 'They will be signed in now. The override is recorded with your name and the reason.',
      confirmText: 'Allow entry',
      input: { label: 'Reason (optional)', placeholder: 'e.g. Escorted visit approved by security' },
    });
    if (reason === null) { resume(); return; }
    overrideVisit(v, reason);
    showDone(v);
  });

  function overrideVisit(v, reason) {
    v.status = 'overridden';
    v.override = { by: config.adminName || 'Admin', at: Date.now(), reason: reason || '' };
    v.reviewed = true;
    saveVisits();
    enqueue({ type: 'override', id: v.id });
    updateAttentionIndicators();
  }

  async function adminOverride(v) {
    if (!canOverride(v)) { toast('Only today\'s declined visits can be overridden. Ask the visitor to sign in again.', 5000); return; }
    const reason = await ask({
      title: `Allow entry for ${v.name}?`,
      message: `${v.name} will be shown as on site. The override is recorded with your name and the reason.`,
      confirmText: 'Allow entry',
      input: { label: 'Reason (optional)', placeholder: 'e.g. Approved by the security manager' },
    });
    if (reason === null) return;
    overrideVisit(v, reason);
    if ($('#visit-dialog').open) $('#visit-dialog').close();
    toast(`${v.name} has been allowed in`);
    renderAdmin();
  }

  function markReviewed(v) {
    v.reviewed = true;
    saveVisits();
    updateAttentionIndicators();
    renderAdmin();
  }

  // ===========================================================================
  // Sign out and notices
  // ===========================================================================
  function avatar(v, size) {
    const a = el('span', { class: 'avatar', style: size ? `width:${size}px;height:${size}px` : null }, initials(v.name));
    if (v.photo) loadMedia(v, 'photo').then(src => { if (src) a.replaceChildren(el('img', { src, alt: '' })); });
    return a;
  }

  function renderSignOut() {
    $('#signout-search').value = '';
    renderSignOutList();
    if (finePointer()) $('#signout-search').focus();
  }
  function renderSignOutList() {
    const q = $('#signout-search').value.trim().toLowerCase();
    const all = onSiteVisits();
    const list = q ? all.filter(v => v.name.toLowerCase().includes(q) || (v.company || '').toLowerCase().includes(q)) : all;
    $('#signout-list').replaceChildren(...list.slice(0, 200).map(v => el('li', {},
      el('button', { type: 'button', onclick: () => signOut(v.id) },
        avatar(v),
        el('span', { class: 'vl-main' },
          el('div', { class: 'vl-name' }, v.name),
          el('div', { class: 'vl-meta' }, [v.company, `Signed in at ${fmtTime(v.inAt)}`].filter(Boolean).join(' · '))),
        el('span', { class: 'vl-cta' }, 'Sign out', icon('arrow-right'))))));
    const empty = $('#signout-empty');
    empty.hidden = list.length > 0;
    empty.textContent = all.length ? 'No match. Check the spelling of your name.' : 'Nobody is signed in right now.';
  }
  $('#signout-search').addEventListener('input', renderSignOutList);

  function signOut(id, fromAdmin = false) {
    const v = visits.find(x => x.id === id);
    if (!v || !isOnSite(v)) return;
    v.outAt = Date.now();
    saveVisits();
    enqueue({ type: 'signout', id: v.id, outAt: v.outAt });
    if (fromAdmin) { toast(`${v.name} signed out`); renderAdmin(); return; }
    showNotice('ok', `Goodbye, ${firstName(v.name)}!`, `Signed out at ${fmtTime(v.outAt)}. Thanks for visiting${config.orgName ? ` ${config.orgName}` : ''}, and have a great day!`);
  }

  function showNotice(kind, title, msg) {
    show('bye');
    const ic = $('#bye-icon');
    ic.className = 'state-icon ' + (kind === 'ok' ? 'state-success' : 'state-warn');
    ic.replaceChildren(icon(kind === 'ok' ? 'check' : 'alert'));
    $('#bye-title').textContent = title;
    $('#bye-msg').textContent = msg;
    countdownHome(kind === 'ok' ? config.resetSeconds : Math.max(config.resetSeconds, 8), $('#bye-countdown'));
  }

  // ===========================================================================
  // Admin panel
  // ===========================================================================
  $('#admin-close').addEventListener('click', () => show('home'));
  $('#admin-settings').addEventListener('click', () => openSetup(true));
  let adminTab = 'dash';
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    adminTab = t.dataset.tab;
    $$('.tab').forEach(x => x.setAttribute('aria-selected', String(x === t)));
    $$('.tab-panel').forEach(p => { p.hidden = p.dataset.panel !== adminTab; });
    renderAdmin();
  }));

  function pill(text, cls, iconName) { return el('span', { class: `pill ${cls}` }, iconName ? icon(iconName, 'i') : null, text); }
  function statusPills(v) {
    const out = [];
    if (v.status === 'declined') out.push(pill('Declined', 'pill-declined'));
    else {
      out.push(isOnSite(v) ? pill('On site', 'pill-on') : pill(v.autoOut ? 'Auto signed out' : 'Left', 'pill-off'));
      if (v.status === 'overridden') out.push(pill('Override', 'pill-override'));
    }
    if (hasFlags(v)) out.push(pill('Alert', 'pill-flag'));
    if (v.method === 'card') out.push(pill('Card', 'pill-card'));
    return el('span', { class: 'pills' }, out);
  }

  function renderAdmin() {
    if (current !== 'admin') return;
    const logo = $('#admin-logo');
    logo.hidden = !config.logo;
    if (config.logo) logo.src = config.logo;
    $('#admin-org').textContent = config.orgName;
    $('#admin-hello').textContent = config.adminName ? `Admin · ${config.adminName}` : 'Admin';
    updateAttentionIndicators();
    if (adminTab === 'dash') { renderAttention(); renderStats(); renderChart(); renderStorageInfo(); renderOnsite(); }
    if (adminTab === 'log') renderLog();
    if (adminTab === 'people') renderPeople();
    if (adminTab === 'data') renderDataTab();
  }

  function renderAttention() {
    const items = visits.filter(needsAttention).sort((a, b) => b.inAt - a.inAt);
    $('#attn-card').hidden = !items.length;
    $('#attn-count').textContent = String(items.length);
    $('#attn-list').replaceChildren(...items.slice(0, 25).map(v => el('li', {},
      avatar(v),
      el('div', { class: 'ol-main' },
        el('div', { class: 'ol-name' }, v.name, ' ', statusPills(v)),
        el('div', { class: 'ol-meta' }, [fmtDateTime(v.inAt), v.company, v.host && `Visiting ${v.host}`, v.kiosk].filter(Boolean).join(' · ')),
        visitReasons(v).map(r => el('div', { class: 'reason' }, el('b', {}, r.q), ` ${r.a}`))),
      el('div', { class: 'ol-actions' },
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => openVisit(v) }, 'Details'),
        canOverride(v) ? el('button', { class: 'btn btn-primary btn-sm', onclick: () => adminOverride(v) }, 'Allow entry') : null,
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => markReviewed(v) }, 'Reviewed')))));
  }
  $('#attn-clear').addEventListener('click', () => {
    visits.forEach(v => { if (needsAttention(v)) v.reviewed = true; });
    saveVisits();
    renderAdmin();
  });

  function renderStats() {
    const today = startOfDay();
    const weekStart = addDays(today, -6);
    const admitted = visits.filter(v => v.status !== 'declined');
    $('#stat-onsite').textContent = String(admitted.filter(isOnSite).length);
    $('#stat-today').textContent = String(admitted.filter(v => v.inAt >= today).length);
    $('#stat-week').textContent = String(admitted.filter(v => v.inAt >= weekStart).length);
    const closed = admitted.filter(v => v.outAt && !v.autoOut && v.inAt >= addDays(today, -29) && v.outAt > v.inAt);
    $('#stat-avg').textContent = closed.length ? fmtDuration(closed.reduce((s, v) => s + (v.outAt - v.inAt), 0) / closed.length) : '–';
  }

  function renderChart() {
    const today = startOfDay();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const start = addDays(today, -i), end = addDays(today, -i + 1);
      days.push({ start, count: visits.filter(v => v.status !== 'declined' && v.inAt >= start && v.inAt < end).length });
    }
    const max = Math.max(1, ...days.map(d => d.count));
    const chart = $('#chart');
    chart.replaceChildren(...days.map((d, i) => el('div', { class: 'bar-col' },
      el('span', { class: 'bar-val' }, String(d.count)),
      el('div', { class: 'bar-track' }, el('div', { class: `bar${d.count ? '' : ' zero'}${i === 6 ? ' today' : ''}`, style: `height:${d.count ? Math.max(4, (d.count / max) * 100) : 2}%` })),
      el('span', { class: 'bar-lbl' }, i === 6 ? 'Today' : new Date(d.start).toLocaleDateString([], { weekday: 'short' })))));
    chart.setAttribute('aria-label', `Visits per day over the last 7 days: ${days.map(d => d.count).join(', ')}`);
    const busiest = days.reduce((a, b) => (b.count > a.count ? b : a), days[0]);
    $('#chart-note').textContent = busiest.count ? `Busiest: ${new Date(busiest.start).toLocaleDateString([], { weekday: 'long' })} (${busiest.count})` : 'No visits yet';
  }

  function renderStorageInfo() {
    const box = $('#storage-info');
    if (!box) return;
    if (config.storage === 'cloud') {
      const st = syncState.state;
      const label = { syncing: 'Syncing…', ok: 'Connected', offline: 'Offline: changes are queued', error: 'Problem connecting', idle: 'Waiting for first sync' }[st];
      const dot = { ok: 'ok', offline: 'warn', error: 'err' }[st] || '';
      box.replaceChildren(
        el('div', { class: 'storage-head' }, el('span', { class: 'sum-icon' }, icon('cloud')),
          el('div', {}, el('strong', {}, 'Google Sheets'), el('small', {}, config.cloudSheetName || 'Your connected spreadsheet'))),
        el('dl', { class: 'info-list' },
          el('dt', {}, 'Status'), el('dd', {}, el('span', { class: `dot ${dot}` }), label),
          el('dt', {}, 'Last sync'), el('dd', {}, timeAgo(syncState.lastOk || roster.syncedAt)),
          el('dt', {}, 'Waiting to upload'), el('dd', {}, `${outbox.length} ${outbox.length === 1 ? 'change' : 'changes'}`),
          el('dt', {}, 'This kiosk'), el('dd', {}, config.kioskName || '–'),
          el('dt', {}, 'Alert emails'), el('dd', {}, config.screening.alertEmails || 'None')),
        st === 'error' && syncState.error ? el('p', { class: 'form-error', style: 'margin-top:.75rem' }, syncState.error) : null,
        el('div', { class: 'row-btns left', style: 'margin-top:1rem' },
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => cloudSync({ quiet: false }) }, icon('refresh'), 'Sync now'),
          config.cloudSheetUrl ? el('a', { class: 'btn btn-secondary btn-sm', href: config.cloudSheetUrl, target: '_blank', rel: 'noopener' }, icon('external'), 'Open sheet') : null));
    } else {
      const used = storageBytes();
      const pct = Math.min(100, (used / STORAGE_BUDGET) * 100);
      box.replaceChildren(
        el('div', { class: 'storage-head' }, el('span', { class: 'sum-icon' }, icon('device')),
          el('div', {}, el('strong', {}, 'On this device'), el('small', {}, 'Saved privately in this browser'))),
        el('dl', { class: 'info-list' },
          el('dt', {}, 'Visits stored'), el('dd', {}, String(visits.length)),
          el('dt', {}, 'Space used'), el('dd', {}, `${formatBytes(used)} of about 5 MB`),
          el('dt', {}, 'Kept for'), el('dd', {}, config.retentionDays ? `${config.retentionDays} days` : 'Forever')),
        el('div', { class: 'meter' + (pct > 80 ? ' warn' : ''), style: 'margin-top:.8rem' }, el('span', { style: `width:${pct.toFixed(1)}%` })),
        el('p', { class: 'hint', style: 'margin-top:.5rem' }, 'Photos and signatures are stored separately and don\'t count toward this. Export a CSV regularly as a backup.'),
        el('div', { class: 'row-btns left', style: 'margin-top:.9rem' },
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => exportCsv(visits) }, icon('download'), 'Export CSV'),
          el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openSetup(true, 'storage') }, icon('cloud'), 'Switch to cloud')));
    }
  }

  function renderOnsite() {
    const list = onSiteVisits();
    $('#onsite-count').textContent = String(list.length);
    $('#onsite-empty').hidden = list.length > 0;
    $('#onsite-list').replaceChildren(...list.slice(0, 300).map(v => el('li', {},
      avatar(v),
      el('div', { class: 'ol-main' },
        el('div', { class: 'ol-name' }, v.name, ' ', v.method === 'card' ? pill(v.role || 'Card', 'pill-card') : null, v.status === 'overridden' ? pill('Override', 'pill-override') : null, hasFlags(v) ? pill('Alert', 'pill-flag') : null),
        el('div', { class: 'ol-meta' }, [v.company, v.host && `Visiting ${v.host}`, `In at ${fmtTime(v.inAt)} (${fmtDuration(Date.now() - v.inAt)})`, v.kiosk].filter(Boolean).join(' · '))),
      el('div', { class: 'ol-actions' },
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openVisit(v) }, 'Details'),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => signOut(v.id, true) }, icon('logout'), 'Sign out')))));
  }

  $('#print-rollcall').addEventListener('click', async () => {
    if (cloudOn()) { toast('Getting the latest list from Google Sheets…'); await Promise.race([cloudSync(), sleep(6000)]); }
    const list = onSiteVisits();
    const doc = el('div', { class: 'print-doc' },
      el('header', {}, config.logo ? el('img', { src: config.logo, alt: '' }) : null,
        el('div', {}, el('h1', {}, 'Roll call'),
          el('p', { class: 'meta' }, `${config.orgName} · printed ${fmtDateTime(Date.now())} · ${list.length} ${list.length === 1 ? 'person' : 'people'} on site`))),
      el('table', {},
        el('thead', {}, el('tr', {}, ['✓', 'Name', 'Company', 'Visiting', 'Signed in', 'Type', 'Kiosk'].map(h => el('th', {}, h)))),
        el('tbody', {}, list.map(v => el('tr', {},
          el('td', {}, el('span', { class: 'box' })), el('td', {}, v.name), el('td', {}, v.company || ''), el('td', {}, v.host || ''),
          el('td', {}, fmtTime(v.inAt)), el('td', {}, v.method === 'card' ? (v.role || 'Card holder') : 'Visitor'), el('td', {}, v.kiosk || ''))))),
      el('p', { class: 'foot' }, 'Tick each person when they are accounted for at the assembly point.'));
    printNode(doc);
  });

  function logFilterMatch(v, filter, q) {
    const today = startOfDay();
    if (filter === 'onsite' && !isOnSite(v)) return false;
    if (filter === 'today' && v.inAt < today) return false;
    if (filter === 'week' && v.inAt < addDays(today, -6)) return false;
    if (filter === 'declined' && v.status !== 'declined') return false;
    if (filter === 'flagged' && !hasFlags(v)) return false;
    if (!q) return true;
    return ['name', 'company', 'host', 'purpose', 'email', 'phone', 'vehicle', 'notes', 'role', 'cardId', 'kiosk']
      .some(k => String(v[k] || '').toLowerCase().includes(q));
  }
  const filteredVisits = () => {
    const q = $('#log-search').value.trim().toLowerCase();
    const filter = $('#log-filter').value;
    return visits.filter(v => logFilterMatch(v, filter, q)).sort((a, b) => b.inAt - a.inAt);
  };

  function renderLog() {
    const rows = filteredVisits();
    const used = key => config.fields[key] !== 'off' || visits.some(v => v[key]);
    const kiosks = new Set(visits.map(v => v.kiosk).filter(Boolean));
    const cols = [
      ['Name', v => v.name, 'name-cell'],
      ['Status', v => statusPills(v)],
      used('company') && ['Company', v => v.company || ''],
      used('host') && ['Visiting', v => v.host || ''],
      used('purpose') && ['Reason', v => v.purpose || ''],
      used('phone') && ['Phone', v => v.phone || ''],
      used('email') && ['Email', v => v.email || ''],
      ['Signed in', v => fmtDateTime(v.inAt)],
      ['Signed out', v => (v.outAt ? fmtTime(v.outAt) + (startOfDay(new Date(v.outAt)) !== startOfDay(new Date(v.inAt)) ? `, ${fmtDate(v.outAt)}` : '') : '')],
      kiosks.size > 1 && ['Kiosk', v => v.kiosk || ''],
    ].filter(Boolean);
    $('#log-head').replaceChildren(el('tr', {}, cols.map(c => el('th', {}, c[0]))));
    $('#log-body').replaceChildren(...rows.slice(0, 500).map(v => {
      const tr = el('tr', { class: 'clickable', tabindex: '0', title: 'Show details' }, cols.map(c => el('td', { class: c[2] || null }, c[1](v))));
      tr.addEventListener('click', () => openVisit(v));
      tr.addEventListener('keydown', e => { if (e.key === 'Enter') openVisit(v); });
      return tr;
    }));
    $('#log-empty').hidden = rows.length > 0;
    $('#log-note').textContent = rows.length > 500 ? `Showing the latest 500 of ${rows.length} visits. Export a CSV to see them all.` : rows.length ? `${rows.length} ${rows.length === 1 ? 'visit' : 'visits'}. Click a row for details.` : '';
  }
  $('#log-search').addEventListener('input', renderLog);
  $('#log-filter').addEventListener('change', renderLog);
  $('#export-csv').addEventListener('click', () => exportCsv(filteredVisits()));
  $('#export-all').addEventListener('click', () => exportCsv(visits.slice().sort((a, b) => b.inAt - a.inAt)));

  function exportCsv(rows) {
    if (!rows.length) { toast('There\'s nothing to export yet.'); return; }
    const esc = val => {
      let s = String(val == null ? '' : val);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet apps running visitor input as formulas
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const ts = t => (t ? new Date(t).toLocaleString() : '');
    const header = ['Name', 'Status', 'Company', 'Visiting', 'Reason', 'Phone', 'Email', 'Vehicle', 'Notes', 'Role', 'Card ID', 'Method',
      'Kiosk', 'Signed in', 'Signed out', 'Minutes on site', 'Auto signed out', 'Screening answers', 'Flags', 'Override', 'Agreed', 'Signed', 'Photo'];
    const body = rows.map(v => [
      v.name, v.status === 'declined' ? 'Declined' : v.status === 'overridden' ? 'Overridden' : isOnSite(v) ? 'On site' : 'Left',
      v.company, v.host, v.purpose, v.phone, v.email, v.vehicle, v.notes, v.role, v.cardId, v.method === 'card' ? 'Card' : 'Screen',
      v.kiosk, ts(v.inAt), ts(v.outAt), v.outAt ? Math.round((v.outAt - v.inAt) / 60000) : '', v.autoOut ? 'Yes' : '',
      visitAnswers(v).map(a => `${a.q} ${a.a}`).join(' | '),
      visitReasons(v).map(r => `${r.action === 'decline' ? 'Declined' : 'Alert'}: ${r.q} ${r.a}`).join(' | '),
      overrideLine(v), v.agreed == null ? '' : v.agreed ? 'Yes' : 'No', v.signature || v.signedRemote ? 'Yes' : '', v.photo || v.photoRemote ? 'Yes' : '',
    ].map(esc).join(','));
    download(`${slug(config.orgName)}-visitors-${isoDate()}.csv`, '﻿' + [header.map(esc).join(','), ...body].join('\r\n'), 'text/csv;charset=utf-8');
  }

  // ---- Visit details ----
  function openVisit(v) {
    const d = $('#visit-dialog');
    $('#vd-title').textContent = v.name;
    const ph = $('#vd-photo');
    if (v.photo) {
      ph.replaceChildren(el('span', {}, 'Loading photo…'));
      loadMedia(v, 'photo').then(src => ph.replaceChildren(src ? el('img', { src, alt: `Photo of ${v.name}` }) : el('span', {}, 'Photo unavailable')));
    } else {
      ph.replaceChildren(el('span', {}, v.photoRemote ? 'Photo saved in Google Sheets' : v.photoMissing ? 'No photo taken' : 'No photo'));
    }
    const rows = [
      ['Status', statusPills(v)],
      ['Signed in', fmtDateTime(v.inAt)],
      ['Signed out', v.outAt ? fmtDateTime(v.outAt) + (v.autoOut ? ' (automatic)' : '') : ''],
      ['Time on site', v.outAt ? fmtDuration(v.outAt - v.inAt) : isOnSite(v) ? `${fmtDuration(Date.now() - v.inAt)} so far` : ''],
      ['Company', v.company], ['Visiting', v.host], ['Reason', v.purpose], ['Email', v.email], ['Phone', v.phone],
      ['Vehicle', v.vehicle], ['Role', v.role], ['Card ID', v.cardId], ['Signed in by', v.method === 'card' ? 'Card tap' : 'On-screen form'],
      ['Kiosk', v.kiosk], ['Notes', v.notes], ['Agreement', v.agreed == null ? '' : v.agreed ? 'Accepted' : 'Not accepted'],
    ].filter(([, val]) => val !== '' && val != null);
    $('#vd-list').replaceChildren(...rows.flatMap(([k, val]) => [el('dt', {}, k), el('dd', {}, val)]));

    const extra = [];
    const answers = visitAnswers(v);
    if (answers.length) {
      extra.push(el('div', { class: 'vd-section' }, el('h4', {}, 'Screening answers'),
        el('ul', { class: 'vd-answers' }, answers.map(a => el('li', { class: a.hit ? `hit-${a.hit}` : null }, el('span', {}, a.q), el('b', {}, a.a || '–'))))));
    }
    const ov = overrideLine(v);
    if (ov) extra.push(el('div', { class: 'vd-section' }, el('h4', {}, 'Override'), el('p', { style: 'margin:0' }, ov)));
    if (v.signature) {
      const wrap = el('div', { class: 'vd-section' }, el('h4', {}, 'Signature'));
      extra.push(wrap);
      loadMedia(v, 'signature').then(src => { if (src) wrap.append(el('img', { class: 'sig-img', src, alt: 'Visitor signature' })); });
    } else if (v.signedRemote) {
      extra.push(el('div', { class: 'vd-section' }, el('h4', {}, 'Signature'), el('p', { class: 'muted', style: 'margin:0' }, 'Saved in Google Sheets.')));
    }
    $('#vd-extra').replaceChildren(...extra);

    const acts = [];
    if (v.status === 'declined' && canOverride(v)) acts.push(el('button', { class: 'btn btn-primary', onclick: () => adminOverride(v) }, icon('unlock'), 'Allow entry'));
    if (isOnSite(v)) acts.push(el('button', { class: 'btn btn-secondary', onclick: () => { d.close(); signOut(v.id, true); } }, icon('logout'), 'Sign out'));
    if (needsAttention(v)) acts.push(el('button', { class: 'btn btn-secondary', onclick: () => { markReviewed(v); d.close(); } }, icon('check'), 'Mark as reviewed'));
    acts.push(el('button', { class: 'btn btn-ghost', onclick: () => d.close() }, 'Close'));
    $('#vd-actions').replaceChildren(...acts);
    d.showModal();
  }
  $('#vd-close').addEventListener('click', () => $('#visit-dialog').close());

  // ---- People & cards ----
  function renderPeople() {
    const line = $('#sheet-line');
    const sheetLink = cloudOn() ? config.cloudSheetUrl : config.sheetUrl;
    if (cloudOn()) {
      line.replaceChildren(el('span', {}, `Google Sheets · People tab · ${roster.rows.length} ${roster.rows.length === 1 ? 'person' : 'people'} · synced ${timeAgo(roster.syncedAt)}`));
    } else if (config.sheetUrl) {
      line.replaceChildren(el('span', {}, `Spreadsheet · ${roster.rows.length} ${roster.rows.length === 1 ? 'person' : 'people'} · synced ${timeAgo(roster.syncedAt)}`),
        roster.error ? el('span', { class: 'form-error', style: 'margin:0' }, roster.error) : null);
    } else {
      line.replaceChildren(el('span', {}, 'No spreadsheet linked. ', el('button', { class: 'link-btn', onclick: () => openSetup(true, 'sheet') }, 'Link one in Settings'), '.'));
    }
    $('#people-sync').hidden = !(cloudOn() || config.sheetUrl);
    const people = allPeople();
    $('#people-body').replaceChildren(...people.map(p => el('tr', {},
      el('td', { class: 'name-cell' }, p.name),
      el('td', {}, p.cardId ? el('code', {}, p.cardId) : el('span', { class: 'muted' }, 'No card')),
      el('td', {}, p.company || ''),
      el('td', {}, p.isAdmin ? pill('Admin', 'pill-admin') : (p.role || '')),
      el('td', {}, p.source === 'sheet' ? (cloudOn() ? 'Google Sheets' : 'Spreadsheet') : 'This device'),
      el('td', {}, p.source === 'local'
        ? el('button', { class: 'link-btn', onclick: () => removeLocalCard(p.cardId) }, 'Remove')
        : sheetLink ? el('a', { class: 'link-btn', href: sheetLink, target: '_blank', rel: 'noopener' }, 'Edit in sheet') : ''))));
    $('#people-empty').hidden = people.length > 0;
  }
  $('#people-sync').addEventListener('click', async () => {
    const b = $('#people-sync');
    b.disabled = true;
    await refreshPeople({ quiet: false });
    b.disabled = false;
  });

  async function removeLocalCard(cardId) {
    const p = config.localCards.find(c => c.cardId === cardId);
    if (!p) return;
    const ok = await ask({ title: 'Remove this card?', message: `${p.name}'s card will stop working on this kiosk.`, confirmText: 'Remove card', danger: true });
    if (ok === null) return;
    config.localCards = config.localCards.filter(c => c.cardId !== cardId);
    saveConfig();
    renderAdmin();
  }

  const enrollDialog = $('#enroll-dialog');
  const ef = $('#enroll-form').elements;
  $('#enroll-card').addEventListener('click', async () => {
    $('#enroll-form').reset();
    $('#enroll-error').textContent = '';
    if (lastUnknownCard) ef.cardId.value = lastUnknownCard;
    setTap($('#enroll-tap'), lastUnknownCard ? 'ok' : '', lastUnknownCard ? 'Last unrecognized card filled in' : 'Tap the card now',
      config.cardMode === 'nfc' ? 'Hold the card against this device, or type the ID below.' : 'Tap it on the reader, or type the card ID below.');
    $('#enroll-dest').textContent = cloudOn()
      ? 'Saved to the People tab of your Google Sheet, so every kiosk recognizes this card.'
      : 'Saved on this kiosk. To share cards between kiosks, add them to your spreadsheet instead.';
    enrollDialog.showModal();
    if (config.cardMode === 'nfc' && cards.nfcSupported) { try { await cards.startNfc({ prompt: true }); } catch { /* typing still works */ } }
    (lastUnknownCard ? ef.name : ef.cardId).focus();
  });
  function enrollOnCard(id) {
    ef.cardId.value = id;
    setTap($('#enroll-tap'), 'ok', 'Card read', `Card ID: ${id}`);
    ef.name.focus();
  }
  ef.cardId.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); if (ef.cardId.value.trim()) enrollOnCard(ef.cardId.value.trim()); }
  });
  $('#enroll-cancel').addEventListener('click', () => enrollDialog.close());
  $('#enroll-form').addEventListener('submit', async e => {
    e.preventDefault();
    const cardId = ef.cardId.value.trim();
    const name = ef.name.value.trim();
    const err = $('#enroll-error');
    err.textContent = '';
    if (normCard(cardId).length < 4) { err.textContent = 'Tap a card, or enter a card ID with at least 4 characters.'; ef.cardId.focus(); return; }
    if (!name) { err.textContent = 'Please enter the card holder\'s name.'; ef.name.focus(); return; }
    const person = { cardId, name, company: ef.company.value.trim(), role: ef.role.value.trim(), isAdmin: ef.isAdmin.checked };
    const existing = findByCard(cardId);
    if (existing && existing.source === 'sheet') { err.textContent = `That card already belongs to ${existing.name} in the spreadsheet.`; return; }
    const finish = msg => {
      if (normCard(lastUnknownCard) === normCard(cardId)) lastUnknownCard = '';
      enrollDialog.close();
      toast(msg);
      renderAdmin();
    };
    if (cloudOn()) {
      const btn = $('#enroll-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      let saveLocally = false;
      try {
        const data = await cloudRequest({ action: 'addPerson', person });
        if (Array.isArray(data.people)) {
          roster = { rows: data.people.map(normalizePerson).filter(p => p.name), syncedAt: Date.now(), error: '' };
          saveRoster();
        }
        finish(`Card saved to Google Sheets for ${name}`);
        return;
      } catch (ex) {
        if (ex.code === 'exists') { err.textContent = ex.message; return; }
        const choice = await ask({
          title: 'Couldn\'t reach Google Sheets',
          message: `${ex.message} Save this card on this kiosk only for now? You can add it to the People tab later.`,
          confirmText: 'Save on this kiosk',
        });
        if (choice === null) return;
        saveLocally = true;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save card';
      }
      if (!saveLocally) return;
    }
    if (existing && existing.source === 'local') {
      const ok = await ask({ title: 'Replace this card?', message: `This card is assigned to ${existing.name}. Assign it to ${name} instead?`, confirmText: 'Replace' });
      if (ok === null) return;
    }
    config.localCards = config.localCards.filter(c => normCard(c.cardId) !== normCard(cardId));
    config.localCards.push(person);
    if (!saveConfig()) return;
    finish(`Card saved for ${name}`);
  });

  // ---- Data tab ----
  function renderDataTab() {
    const cloud = config.storage === 'cloud';
    $('#clear-log').hidden = cloud;
    $('#clear-note').textContent = cloud
      ? 'Your visitor log is kept in Google Sheets. To delete records, remove rows from the Visits tab. "Erase everything" only clears this device.'
      : 'Permanently delete records from this device. Export a CSV first if you need a copy.';
    const info = [
      `Secure connection: ${window.isSecureContext ? 'yes' : 'no (the camera and NFC need https)'}`,
      `Camera: ${navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 'supported' : 'not supported'}`,
      `NFC: ${cards.nfcSupported ? 'supported' : 'not supported'}`,
      `Screen wake lock: ${'wakeLock' in navigator ? 'supported' : 'not supported'}`,
    ];
    $('#device-info').textContent = info.join(' · ');
    $('#fullscreen-btn span').textContent = document.fullscreenElement ? 'Exit full screen' : 'Enter full screen';
  }

  $('#fullscreen-btn').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { toast('Full screen isn\'t available in this browser. On iPad, use Add to Home Screen instead.', 5000); }
  });
  document.addEventListener('fullscreenchange', () => { if (current === 'admin' && adminTab === 'data') renderDataTab(); });

  $('#clear-log').addEventListener('click', async () => {
    if (!visits.length) { toast('The visitor log is already empty.'); return; }
    const ok = await ask({
      title: 'Clear the visitor log?',
      message: `This permanently deletes all ${visits.length} visit records, photos and signatures from this device. Export a CSV first if you need a copy.`,
      confirmText: 'Delete records', danger: true, typeToConfirm: 'DELETE',
    });
    if (ok === null) return;
    dropMedia(visits);
    visits = [];
    saveVisits();
    renderAdmin();
    toast('The visitor log was cleared.');
  });

  $('#export-config').addEventListener('click', () => {
    const { pinHash, setupComplete, ...rest } = config;
    rest.localCards = rest.localCards.filter(c => !c.isAdmin);
    download(`${slug(config.orgName)}-kiosk-settings.json`, JSON.stringify({ type: 'visitor-sign-in-settings', version: 1, exportedAt: new Date().toISOString(), config: rest }, null, 2), 'application/json');
    if (config.storage === 'cloud') toast('Exported. The file contains your cloud connection key, so keep it private.', 5000);
  });

  $('#import-config').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imported = parseSettingsFile(await file.text());
      const keepAdmins = config.localCards.filter(c => c.isAdmin);
      const ok = await ask({ title: 'Import these settings?', message: 'They replace this kiosk\'s current settings. The admin code and admin cards stay the same.', confirmText: 'Import' });
      if (ok === null) return;
      const prevStorage = config.storage;
      config = mergeConfig({ ...config, ...imported, adminName: config.adminName, localCards: [...keepAdmins, ...imported.localCards], pinHash: config.pinHash, setupComplete: true });
      saveConfig();
      applyTheme();
      applyLogoTone();
      if (config.storage === 'cloud' && prevStorage !== 'cloud') toast('Settings imported. Open Settings → Google Sheets and test the connection.', 6000);
      else toast('Settings imported');
      refreshPeople();
      renderAdmin();
    } catch (err) { toast(err.message, 5000); }
  });

  $('#factory-reset').addEventListener('click', async () => {
    const ok = await ask({
      title: 'Erase everything on this device?',
      message: 'This deletes all settings, cards, visit records, photos and signatures from this kiosk, then starts setup again. Data in Google Sheets is not affected.',
      confirmText: 'Erase everything', danger: true, typeToConfirm: 'ERASE',
    });
    if (ok === null) return;
    Object.values(KEYS).forEach(k => store.remove(k));
    media.clear().catch(() => {});
    config = mergeConfig(null);
    visits = [];
    roster = { rows: [], syncedAt: 0, error: '' };
    outbox = [];
    syncState = { state: 'idle', lastOk: 0, error: '' };
    cards.stopNfc();
    applyTheme();
    applyLogoTone();
    openSetup(false);
  });

  // ===========================================================================
  // Background jobs
  // ===========================================================================
  function runAutoSignOut() {
    if (!/^\d{2}:\d{2}$/.test(config.autoSignOut || '')) return;
    const [h, m] = config.autoSignOut.split(':').map(Number);
    const now = Date.now();
    let n = 0;
    for (const v of visits) {
      if (!isOnSite(v)) continue;
      const d = new Date(v.inAt);
      let cutoff = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
      if (cutoff <= v.inAt) cutoff = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m).getTime();
      if (now >= cutoff) {
        v.outAt = cutoff;
        v.autoOut = true;
        enqueue({ type: 'signout', id: v.id, outAt: cutoff, auto: true });
        n++;
      }
    }
    if (n) { saveVisits(); refreshLiveViews(); }
  }

  function purgeOld() {
    const days = Number(config.retentionDays) || 0;
    if (!days) return;
    const cutoff = Date.now() - days * 86400000;
    const keep = [], drop = [];
    for (const v of visits) ((v.outAt || v.status === 'declined') && v.inAt < cutoff ? drop : keep).push(v);
    if (!drop.length) return;
    visits = keep;
    saveVisits();
    dropMedia(drop);
  }

  /** A visit whose photo step was interrupted (e.g. the page reloaded) is finished now, without a photo. */
  function recoverPending() {
    for (const v of visits) if (v.cloudPending) { v.photoMissing = v.photoMissing || !v.photo; finalizeVisit(v); }
  }

  // ===========================================================================
  // Boot
  // ===========================================================================
  applyTheme();
  applyLogoTone();
  if (config.setupComplete && config.pinHash) {
    recoverPending();
    purgeOld();
    runAutoSignOut();
    show('home');
    startKioskReader();
    refreshPeople();
  } else {
    openSetup(false);
  }
  setInterval(() => { if (cloudOn() && current !== 'setup' && document.visibilityState === 'visible') cloudSync(); }, CLOUD_SYNC_MS);
  setInterval(() => { if (!cloudOn() && config.sheetUrl && current !== 'setup') syncRoster(); }, SHEET_REFRESH_MS);
  setInterval(runAutoSignOut, 60 * 1000);
  setInterval(purgeOld, 6 * 3600 * 1000);
  window.addEventListener('online', () => { if (current !== 'setup') refreshPeople(); });

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }

  // Exposed for automated tests only.
  window.__vsi = { get config() { return config; }, get visits() { return visits; }, get outbox() { return outbox; }, cloudSync, runAutoSignOut };
})();
