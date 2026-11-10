// Visitor sign-in kiosk: screen flow and wiring.
import { CONFIG, APP_VERSION } from '../config.js';
import { call, queue, DEMO, MODE, PHONE, phoneVisitor, BACKEND_VERSION, dayKey, pendingCount } from './api.js';
import { Keyboard } from './keyboard.js';
import { listenForTaps } from './nfc.js';
import * as face from './face.js';
import * as fx from './transitions.js';
import {
  settings, useSettings, loadCache, applyTheme, logoFor, fill, activeQuestions, everyVisitQuestions,
  quickEntryOn, splitOption, demoSettings, hostMatches, timeLabel,
} from './settings.js';
import { initSetup, openSetup, setupTap } from './setup.js';
import { Kiosk, saveFile, toCsv, dateStamp } from './files.js';
import { t, tc, setLang, lang, LANGS, translateDom, locale } from './i18n.js';
import { PAYWALL, FEATURES, can, entitlement, refresh as refreshPlan, verifyLicense, isPaused, tabletCode, saveKey, checkStatus, usePoint } from './plans.js';
import { SignaturePad } from './signature.js';
import { AGREEMENT_VERSION, AGREEMENT_TITLE, agreementHtml, agreementAccepted } from './agreement.js';
// QR codes are only drawn in the admin screen, so their code loads when first needed.
let qrModule = null;
const qrSvg = async (text, opts) => (await (qrModule ||= import('./qr.js'))).qrSvg(text, opts);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (p) => `${(p.first || '?')[0]}${(p.last || '')[0] || ''}`.toUpperCase();

const state = {
  screen: 'welcome',
  lastTouch: Date.now(),
  busy: false,
  faceIndex: [],
  // current visitor flow
  flow: 'new',            // 'new' (sign-in questions) | 'returning' (every-visit questions)
  steps: [],              // the form's steps for this visitor
  visitor: null,          // { id, first, last, company, quickEntry }
  method: '',
  answers: {},            // form fields by input name
  qa: {},                 // screening answers by question id
  qf: {},                 // follow-up answers by question id
  result: null,           // { declined, reasons, flags } once the questions are answered
  hostNotified: '',       // the host's name when the backend emailed them
  expected: null,         // { id, company, host, purpose } when staff are expecting this visitor
  declineId: '',
  override: null,         // { by, reason } after a staff member let a declined visitor in
  resume: false,
  step: 0,
  photo: null,            // { dataUrl, canvas }
  photoDescriptor: null,
  sample: null,           // { descriptor, photo } from the returning-visitor camera
  recognition: 0,         // increments to cancel a running recognition
  faceHit: null,          // person the camera recognized on the returning-visitor screen
  faceFrames: [],         // descriptors the background camera has seen so far
  // admin
  adminToken: null,
  adminMode: null,        // null | { type: 'add' } | { type: 'link', badge }
  adminBadges: [],
  attention: 0,
  lastPing: null,         // the backend's last status answer, and when
  lastTapAt: 0,           // when the badge reader last read a card (Diagnostics)
  // sign-out undo
  undo: null,
};

const kb = new Keyboard($('[data-keyboard]'));

// On a visitor's phone (the QR code by the door) its own keyboard is used: the
// visitor fields are ordinary inputs, so its "next" key and autofill work too.
function nativeInput(input) {
  if (!PHONE || !input || !input.readOnly) return;
  input.readOnly = false;
  const mode = { email: 'email', digits: 'numeric', url: 'url' }[input.dataset.kb];
  if (mode) input.setAttribute('inputmode', mode); else input.removeAttribute('inputmode');
  if (input.dataset.cap === 'words') input.setAttribute('autocapitalize', 'words');
}
const nativeInputs = (root) => $$('input[readonly]', root).forEach(nativeInput);
if (PHONE) {
  document.body.classList.add('phone');
  document.addEventListener('pointerdown', (e) => nativeInput(e.target.closest?.('input[readonly]')), true);
  kb.open = (input) => nativeInput(input);
  kb.close = () => {};
}

/** Quick entry is on in the settings, and the plan includes it. */
const quickOn = (s = settings()) => quickEntryOn(s) && can('quickEntry');

/**
 * Who signs the rules with a finger: 'off', 'new' visitors, or 'every' visit (rules and plan permitting).
 * An Apps Script older than version 5 can't keep a signature, so until it's updated visitors tick the box.
 */
const signMode = (s = settings()) => (s.form.rules.length && can('signatures') && !state.oldBackend ? s.signature.mode : 'off');
const EMAIL_OK = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

const pad = new SignaturePad($('[data-sign-pad]'), {
  onChange(signed) {
    $('.sign-area').classList.toggle('signed', signed);
    state.answers.agreed = signed;
    if (signed) $('[data-form-error]').textContent = '';
  },
});
$('[data-sign-clear]').addEventListener('click', () => pad.clear());

/** What the visitor signed, as they saw it (their language, the company's name filled in). */
function agreementShown() {
  const s = settings();
  return { title: t('Visitor rules'), rules: s.form.rules.map((r) => fill(tc(r, s), s)), statement: t('By signing below, I agree to the visitor rules.') };
}

/** The signature, the rules it signs and an optional email, for the sign-in that's being saved. */
function signedFields() {
  if (signMode() === 'off' || !pad.isSigned()) return {};
  const email = (state.answers.email || '').trim();
  return {
    signature: pad.toDataURL(), agreement: agreementShown(),
    email: email && EMAIL_OK.test(email) ? email : undefined,
    language: lang() === 'en' ? undefined : LANGS[lang()],
  };
}

// ------------------------------------------------------------------ helpers

const screenEl = (name) => $(`.screen[data-screen="${name}"]`);

/** Which Keynote-style transition plays between two screens. */
function transitionKind(from, to) {
  if (to === 'welcome') return 'home';
  if (from === 'welcome' && to === 'choice') return 'zoom';
  if (from === 'choice' && (to === 'form' || to === 'find')) return 'expand';
  if (to === 'badge') return 'iris';
  if (to === 'done' || to === 'declined') return 'flip';
  if (to === 'admin' || to === 'setup') return 'rise';
  return 'push';
}

/**
 * Moves to another screen. opts.rect (the tapped card) feeds the expand
 * transition; opts.origin ({x, y}) is where the iris opens from.
 */
function show(name, opts = {}) {
  const prev = state.screen;
  if (prev === 'find' && name !== 'find') { state.recognition++; face.stopCamera(); }
  kb.close();
  state.screen = name;
  document.body.dataset.view = name;
  touch();
  ENTER[name]?.();
  if (prev !== name) fx.screen(screenEl(prev), screenEl(name), transitionKind(prev, name), opts);
}

const centerOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

function touch() { state.lastTouch = Date.now(); }

let toastTimer;
function toast(msg, ms = 4000) {
  const el = $('[data-toast]');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function busy(on, text = 'One moment…') {
  state.busy = on;
  $('[data-busy-text]').textContent = t(text);
  $('[data-overlay="busy"]').hidden = !on;
}

async function api(action, args) {
  try {
    return await call(action, args);
  } catch (err) {
    console.error(action, err);
    return { ok: false, error: 'network' };
  }
}

function errorText(res) {
  switch (res.error) {
    case 'network': return t("We couldn't reach the server. Please try again, or see the front desk.");
    case 'busy': return t('The system is busy. Please try again.');
    case 'badge_unknown': return t("This badge isn't set up yet. Please use a different badge, or see the front desk.");
    case 'badge_in_use': return t('Badge {badge} is already checked out to someone. Please use a different badge.', { badge: res.badge });
    case 'badge_retired': return t('Badge {badge} is out of service. Please use a different badge.', { badge: res.badge });
    case 'missing': return t('Some answers are missing. Please go back and check.');
    case 'kiosk_key': case 'not_connected': return t('This kiosk is not connected correctly. Please see the front desk.');
    case 'phone_link': case 'not_allowed': case 'not_on_phone': return t("This sign-in link isn't working. Please see the front desk.");
    case 'too_many': return t('Lots of people are signing in right now. Please try again in a few minutes, or see the front desk.');
    case 'unknown_action': return 'This needs the latest Apps Script code. Admin → Settings → Copy the latest Apps Script code, then deploy a new version.';
    default: return t('Something went wrong. Please see the front desk.');
  }
}

async function refreshFaceIndex() {
  if (!quickOn()) { state.faceIndex = []; return; }
  const res = await api('faceIndex');
  if (res.ok) state.faceIndex = res.people;
}

function rememberSample(person, descriptor) {
  let p = state.faceIndex.find((x) => x.id === person.id);
  if (!p) { p = { ...person, descriptors: [] }; state.faceIndex.push(p); }
  p.descriptors.push(descriptor);
}

/** Keeps the new photo and face signature on file (only for visitors with quick entry on). */
function saveSample(source) {
  const s = state.sample, v = state.visitor;
  if (!s || !v) return;
  rememberSample(v, s.descriptor);
  // Nobody waits on this, so it goes through the outbox and survives a Wi-Fi drop.
  queue('addFaceSample', { visitorId: v.id, photo: s.photo, descriptor: s.descriptor, source });
  state.sample = null;
}

// ------------------------------------------------------------------ settings → screens

/** Puts the company's name, logo, colors, questions and rules on every screen. */
function applySettings() {
  const s = settings();
  applyTheme(s);
  const logo = logoFor(s);
  $$('[data-org-logo]').forEach((img) => { img.src = logo; img.alt = s.org.name; });
  $$('[data-org-name]').forEach((el) => { el.textContent = s.org.name || 'us'; });
  const tagline = $('[data-org-tagline]');
  tagline.textContent = tc(s.org.tagline, s);
  tagline.hidden = !s.org.tagline;
  document.title = s.org.name ? `${s.org.name} Visitor Sign-In` : 'Visitor Sign-In';

  // Intro: a fixed opening, any notes the screening questions need, and the company's own text.
  const intro = [t('Please sign in before your visit. It takes about two minutes.')];
  activeQuestions(s).forEach((q) => { if (q.intro && !q.every) intro.push(tc(q.intro, s)); });
  if (s.form.intro) intro.push(...s.form.intro.split(/\n{2,}/).map((p) => tc(p, s)));
  intro.push(t('We use this information only to manage your visit. Please don\'t enter ID numbers or other sensitive details.'), t('Need help? Ask at the front desk.'));
  $('[data-intro]').innerHTML = intro.map((p) => `<p>${esc(fill(p, s))}</p>`).join('');

  $('[data-host-field]').hidden = !s.form.askHost;
  $('[data-host-label]').textContent = fill(tc(s.form.hostLabel, s), s);
  $('[data-host-hint]').textContent = fill(tc(s.form.hostHint, s), s);
  $('[data-purpose-field]').hidden = !s.form.askPurpose;
  const chips = $('[data-chips="purpose"]');
  chips.hidden = !s.form.askPurpose || !s.form.purposes.length;
  chips.innerHTML = s.form.purposes.map((p) => `<button type="button" class="chip">${esc(tc(p, s))}</button>`).join('');
  $('[data-rules]').innerHTML = s.form.rules.map((r) => `<li>${esc(fill(tc(r, s), s))}</li>`).join('');

  // With badges, visitors sign out by tapping them; without, there's a button.
  $('[data-foot-badge]').hidden = !s.badges || PHONE;
  // On a phone, "Leaving?" appears only while the visitor this phone signed in is inside.
  $$('[data-leave-open]').forEach((b) => { b.hidden = PHONE ? !phoneVisitor.get()?.visitId : s.badges; });
  $('[data-admin-tab="badges"]').hidden = !s.badges && !s.passes;
  $('[data-add-badge]').hidden = !s.badges;
  $('[data-add-pass]').hidden = !s.passes;
  $('[data-done-text]').textContent = s.badges ? t('Please wear your badge where it can be seen. Your host will meet you at the front desk.')
    : s.passes ? t('Please wear your pass where it can be seen. Your host will meet you at the front desk.')
      : t('Please take a seat. Your host will meet you at the front desk.');
  $('[data-done-leave]').textContent = PHONE ? t(s.passes ? 'When you leave, give your pass back, open this page again and tap "Leaving?" to sign out.' : 'When you leave, open this page again and tap "Leaving?" to sign out.')
    : s.badges ? t('When you leave, tap your badge on the reader to sign out.')
      : s.passes ? t('When you leave, give your pass back and tap "Leaving?" on the welcome screen to sign out.')
        : t('When you leave, tap "Leaving?" on the welcome screen to sign out.');
  $('[data-find-hint]').textContent = quickOn(s)
    ? t('Start typing your name. If you turned on quick entry, the camera may recognize you first.')
    : t('Start typing your name.');
  $('[data-cam-bubble]').hidden = !quickOn(s);
  buildScreeningSteps();
  translateDom(visitorRoots());
  renderLangPick();
}

// ------------------------------------------------------------------ visitor languages

/** The screens and overlays visitors see (setup and admin stay in English). */
const visitorRoots = () => $$('.screen').filter((el) => !['setup', 'admin'].includes(el.dataset.screen))
  .concat([$('[data-overlay="idle"]'), $('[data-overlay="signout"]')]);

/** Switches the visitor screens to another language. */
function useLang(code) {
  if (code === lang()) return;
  setLang(code);
  applySettings();
  kb.render();
  tickClock();
  if (PHONE) renderPhoneChoice();
}

/** Language buttons on the welcome screen, and a switch on the next screen. */
function renderLangPick() {
  const langs = can('languages') ? settings().languages.filter((c) => LANGS[c]) : ['en'];
  const pick = $('[data-lang-pick]');
  pick.hidden = langs.length < 2;
  pick.innerHTML = langs.map((c) => `<button type="button" lang="${c}" data-lang="${c}" class="${c === lang() ? 'on' : ''}">${esc(LANGS[c])}</button>`).join('');
  const other = langs.find((c) => c !== lang());
  const sw = $('[data-lang-switch]');
  sw.hidden = langs.length < 2;
  if (other) { sw.textContent = LANGS[other]; sw.dataset.lang = other; sw.setAttribute('lang', other); }
}
$('[data-lang-pick]').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang]');
  if (!b) return;
  e.stopPropagation();
  useLang(b.dataset.lang);
  show('choice');
});
$('[data-lang-switch]').addEventListener('click', (e) => { e.stopPropagation(); useLang(e.currentTarget.dataset.lang); });

/** A visit reason picked from the chips is recorded in English, whatever language was on screen. */
function canonicalPurpose(value) {
  const v = String(value || '').trim();
  if (lang() === 'en') return v;
  return settings().form.purposes.find((p) => tc(p) === v) || v;
}

/** One step per screening question, placed before the photo step. */
function buildScreeningSteps() {
  $$('[data-screen="form"] .step[data-step^="q:"]').forEach((el) => el.remove());
  const photoStep = $('[data-screen="form"] .step[data-step="photo"]');
  for (const q of activeQuestions()) {
    const el = document.createElement('div');
    el.className = 'step';
    el.dataset.step = `q:${q.id}`;
    const answer = q.type === 'text'
      ? `<label class="field"><span>${esc(t('Your answer'))}</span><input readonly inputmode="none" name="qa-${esc(q.id)}" data-cap="sentence" maxlength="120" autocomplete="off"></label>`
      : `<div class="options" role="radiogroup">${q.options.map((o) => {
        const { main, note } = splitOption(tc(o));
        return `<button type="button" class="option" role="radio" aria-checked="false" data-q="${esc(q.id)}" data-value="${esc(o)}">${esc(main)}${note ? ` <small>${esc(note)}</small>` : ''}</button>`;
      }).join('')}</div>`;
    el.innerHTML = `<p class="eyebrow" data-step-count></p><h2>${esc(fill(tc(q.text)))}</h2>${q.hint ? `<p class="hint">${esc(fill(tc(q.hint)))}</p>` : ''}${answer}`
      + (q.followUp ? `<label class="field" data-followup="${esc(q.id)}" hidden><span>${esc(tc(q.followUp.label))}</span><input readonly inputmode="none" name="qf-${esc(q.id)}" data-cap="words" maxlength="60" autocomplete="off"></label>` : '');
    photoStep.before(el);
  }
}

// ------------------------------------------------------------------ screen entry hooks

const ENTER = {
  welcome() {
    suppressClick = false;
    // Each visitor starts in the kiosk's own language.
    if (lang() !== 'en') useLang('en');
    face.stopCamera();
    Object.assign(state, {
      visitor: null, method: '', answers: {}, qa: {}, qf: {}, result: null, declineId: '', override: null, hostNotified: '', expected: null,
      resume: false, photo: null, photoDescriptor: null, sample: null, flow: 'new',
    });
    stopIdle();
    refreshAttention();
    renderPaused();
    // On a phone, "Leaving?" shows while the visitor it signed in is inside.
    if (PHONE) $$('[data-leave-open]').forEach((btn) => { btn.hidden = !phoneVisitor.get()?.visitId; });
  },
  choice() {
    // Warm the camera so the returning-visitor check starts instantly.
    if (quickOn()) face.startCamera($('[data-video="return"]')).catch(() => {});
  },
  form() {
    if (state.resume) { state.resume = false; renderStep({ instant: true }); return; }
    resetForm();
  },
  find() { resetFind(); },
  leave() { resetLeave(); },
  badge() {
    const v = state.visitor;
    const returning = state.method !== 'new visitor';
    $('[data-badge-eyebrow]').textContent = returning ? t('Welcome back, {name}', { name: v.first }) : t('Thanks, {name}!', { name: v.first });
    $('[data-badge-title]').textContent = returning
      ? t('Tap any visitor badge on the reader to finish')
      : t('Last step: tap any visitor badge on the reader');
    $('[data-badge-status]').textContent = '';
    $('[data-tap-scene]').classList.remove('locked', 'reading', 'success', 'error');
    $('[data-badge-no]').textContent = '';
    face.stopCamera();
  },
  done() {
    // Redraw the check mark once the flip has landed.
    const strokes = $$('[data-screen="done"] .done-check circle, [data-screen="done"] .done-check path');
    strokes.forEach((el) => { el.style.animation = 'none'; });
    setTimeout(() => strokes.forEach((el) => { el.style.animation = ''; }), 480);
  },
  declined() {
    face.stopCamera();
    const first = state.answers.first || state.visitor?.first || '';
    $('[data-declined-title]').textContent = first ? t('Thank you, {name}', { name: first }) : t('Thank you');
    $('[data-declined-text]').textContent = fill(tc(settings().screening.declineMessage));
    $('[data-staff-override]').hidden = PHONE;
  },
  admin() {
    adminTab('inside');
    const note = licenseNotice();
    if (note && !state.planNoted) {
      state.planNoted = true;
      setTimeout(() => toast(note, 7000), 600);
    }
  },
};

// ------------------------------------------------------------------ welcome

$('[data-screen="welcome"]').addEventListener('click', () => {
  if (suppressClick) { suppressClick = false; return; }
  if (state.busy) return;
  if (isPaused() || state.phoneDown) { const card = $('[data-paused]'); card.classList.remove('nudge'); void card.offsetWidth; card.classList.add('nudge'); return; }
  // A phone that hasn't signed anyone in goes straight to the new-visitor questions.
  if (PHONE && !phoneVisitor.get()?.visitorId) { state.flow = 'new'; show('form'); return; }
  if (PHONE) renderPhoneChoice();
  show('choice');
});

/** On a phone that signed someone in before: "Sign in as Ana Lopez" or "Someone else". */
function renderPhoneChoice() {
  const me = phoneVisitor.get();
  if (!me) return;
  const card = (sel) => $(`[data-screen="choice"] ${sel}`);
  card('[data-action="returning"] .choice-title').textContent = t('Sign in as {name}', { name: `${me.first} ${me.last}` });
  card('[data-action="returning"] .choice-text').textContent = t('This phone remembers you.');
  card('[data-action="new"] .choice-title').textContent = t('Someone else');
  card('[data-action="new"] .choice-text').textContent = t('Sign in as a new visitor.');
  for (const el of $$('[data-screen="choice"] .choice-title, [data-screen="choice"] .choice-text')) el.setAttribute('data-no-i18n', '');
}

$$('[data-go]').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation();
  show(b.dataset.go);
}));
$('[data-action="new"]').addEventListener('click', (e) => { state.flow = 'new'; show('form', { rect: e.currentTarget.getBoundingClientRect() }); });
$('[data-action="returning"]').addEventListener('click', (e) => {
  if (PHONE) {
    // Phones can't look visitors up: this one signs in the visitor it remembers.
    const me = phoneVisitor.get();
    if (!me) return;
    state.visitor = { id: me.visitorId, first: me.first, last: me.last, company: me.company };
    state.method = 'phone';
    continueReturning(centerOf(e.currentTarget));
    return;
  }
  show('find', { rect: e.currentTarget.getBoundingClientRect() });
});
$$('[data-leave-open]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); if (PHONE) phoneSignOut(); else show('leave'); }));

/** Signing out the visitor this phone signed in. */
async function phoneSignOut() {
  const me = phoneVisitor.get();
  if (!me?.visitId || state.busy) return;
  busy(true, 'Signing you out…');
  const res = await api('kioskSignOut', { visitId: me.visitId });
  busy(false);
  if (!res.ok && res.error !== 'not_found') { toast(errorText(res)); return; }
  phoneVisitor.set({ ...me, visitId: '' });
  applySettings();
  showSignedOut({ first: res.first || me.first, badge: res.badge || '', visitId: '' });
}

function tickClock() {
  $('[data-clock]').textContent = new Date().toLocaleString(locale(), { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Press and hold the logo for 2.5 s to open the admin PIN pad.
let suppressClick = false;
(() => {
  const logo = $('[data-admin-hold]');
  let timer;
  const cancel = () => clearTimeout(timer);
  logo.addEventListener('pointerdown', () => {
    if (PHONE) return;
    timer = setTimeout(() => {
      // Swallow the click that ends this press, but not a later tap (the PIN pad may take that click).
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 800);
      openPin();
    }, 2500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => logo.addEventListener(ev, cancel));
})();

/** The small red dot by the clock: declined or flagged visitors nobody has reviewed yet. */
async function refreshAttention() {
  if (!settings().setupComplete || PHONE) return;
  const res = await api('ping');
  if (!res.ok) return;
  state.lastPing = { ...res, at: Date.now() };
  state.attention = Number(res.attention) || 0;
  $('[data-attn-dot]').hidden = !state.attention;
  const count = $('[data-attn-count]');
  count.hidden = !state.attention;
  count.textContent = state.attention;
  if (MODE === 'cloud' && (res.version || 1) < BACKEND_VERSION) state.oldBackend = true;
}

// ------------------------------------------------------------------ visitor questions
//
// New visitors: intro, name, visit details, each screening question, photo,
// rules, quick entry. Returning visitors only answer the questions asked on
// every visit. If an answer declines them, they take their photo and see a
// polite message instead of the rest.

function questionSteps() {
  return state.flow === 'returning' ? everyVisitQuestions() : activeQuestions();
}

/** The steps that follow the questions, given how the questions came out. */
function stepsAfterQuestions() {
  const s = settings();
  if (state.result?.declined) return s.photos === 'off' ? [] : ['photo'];
  if (state.flow === 'returning') return signMode(s) === 'every' ? ['rules'] : [];
  const out = [];
  if (s.photos === 'all') out.push('photo');
  if (s.form.rules.length) out.push('rules');
  if (quickOn(s)) out.push('quick');
  return out;
}

function buildSteps() {
  const qs = questionSteps().map((q) => `q:${q.id}`);
  const head = state.flow === 'returning' ? [] : ['intro', 'name', 'visit'];
  return [...head, ...qs, ...stepsAfterQuestions()];
}

function resetForm() {
  state.step = 0;
  state.answers = {};
  state.qa = {};
  state.qf = {};
  state.result = null;
  state.declineId = '';
  state.override = null;
  state.photo = null;
  state.photoDescriptor = null;
  state.steps = buildSteps();
  $$('[data-screen="form"] input').forEach((i) => { i.value = ''; i.classList.remove('invalid'); });
  $$('[data-screen="form"] .option').forEach((o) => { o.classList.remove('on'); o.setAttribute('aria-checked', 'false'); });
  $$('[data-chips="purpose"] .chip').forEach((c) => c.classList.remove('on'));
  $$('[data-followup]').forEach((f) => { f.hidden = true; });
  renderHostSuggest('');
  state.expected = null;
  $('[data-expected-note]').hidden = true;
  $('[data-agree]').setAttribute('aria-checked', 'false');
  pad.clear();
  clearPhoto();
  renderStep({ instant: true });
}

const currentStep = () => state.steps[state.step];
const questionById = (id) => activeQuestions().find((q) => q.id === id);

function renderStep({ instant = false, back = false } = {}) {
  const name = currentStep();
  const steps = $$('[data-screen="form"] .step');
  const from = steps.find((s) => s.classList.contains('active'));
  const to = steps.find((s) => s.dataset.step === name);
  if (PHONE) nativeInputs(screenEl('form'));
  if (instant || !from) steps.forEach((s) => s.classList.toggle('active', s === to));
  else if (from !== to) fx.step(from, to, back);
  const total = state.steps.filter((s) => s !== 'intro').length;
  const at = state.steps.slice(0, state.step + 1).filter((s) => s !== 'intro').length;
  const label = state.flow === 'returning' ? t('Quick question {at} of {total}', { at, total }) : t('Step {at} of {total}', { at, total });
  if (to) $$('[data-step-count]', to).forEach((e) => { e.textContent = label; });
  $('[data-progress]').style.width = `${(state.step / Math.max(1, state.steps.length - 1)) * 100}%`;
  $('[data-form-error]').textContent = '';
  const next = $('[data-form-next]');
  $('[data-screen="form"] .form-foot').hidden = name === 'quick';
  next.hidden = name === 'quick';
  const last = state.step === state.steps.length - 1;
  next.textContent = t(name === 'intro' ? "Let's begin" : last && !state.result?.declined ? (state.flow === 'returning' ? 'Continue' : 'Sign in') : 'Continue');
  $('[data-form-back]').style.visibility = state.step === 0 || state.override ? 'hidden' : '';
  $('[data-screen="form"] .form-body').scrollTop = 0;
  kb.close();
  if (name === 'photo') startPhotoCamera();
  if (name === 'rules') {
    const signing = signMode() !== 'off';
    $('[data-agree]').hidden = signing;
    $('[data-sign-box]').hidden = !signing;
    $('[data-sign-email]').hidden = !(signing && (MODE === 'cloud' || PHONE) && !CONFIG.BOX && settings().signature.emailCopy);
    $('[data-screen="form"] .step[data-step="rules"]').classList.toggle('signing', signing);
    if (signing) setTimeout(() => pad.resize(), 450); // after the step transition
  }
  else if (state.screen === 'form') face.stopCamera();
}

function formError(msg, inputs = []) {
  $('[data-screen="form"] .form-foot').hidden = false;
  $('[data-form-error]').textContent = t(msg);
  inputs.forEach((i) => i.classList.add('invalid'));
}

const answerOf = (q) => (q.type === 'text' ? (state.answers[`qa-${q.id}`] || '').trim() : state.qa[q.id] || '');
const needsFollowUp = (q) => !!q.followUp && q.followUp.answers.includes(answerOf(q));

function validateStep() {
  const a = state.answers;
  const s = settings();
  const field = (n) => $(`[data-screen="form"] input[name="${n}"]`);
  const name = currentStep();
  if (name.startsWith('q:')) {
    const q = questionById(name.slice(2));
    if (!q) return true;
    if (!answerOf(q)) { formError(q.type === 'text' ? 'Please answer the question.' : 'Please choose an answer.', q.type === 'text' ? [field(`qa-${q.id}`)] : []); return false; }
    if (needsFollowUp(q) && !(a[`qf-${q.id}`] || '').trim()) { formError(t('Please enter your {what}.', { what: tc(q.followUp.label).toLowerCase() }), [field(`qf-${q.id}`)]); return false; }
    return true;
  }
  switch (name) {
    case 'name': {
      const bad = ['first', 'last'].filter((n) => !(a[n] || '').trim());
      if (bad.length) { formError('Please enter your first and last name.', bad.map(field)); return false; }
      return true;
    }
    case 'visit': {
      const need = ['company'];
      if (s.form.askHost) need.push('visiting');
      if (s.form.askPurpose) need.push('purpose');
      const bad = need.filter((n) => !(a[n] || '').trim());
      if (bad.length) {
        formError(bad.includes('company') && bad.length === 1 ? 'Please enter your company, or “N/A”.' : 'Please answer each question.', bad.map(field));
        return false;
      }
      return true;
    }
    case 'photo':
      if (!state.photo && settings().photos === 'all' && !state.result?.declined) { formError('Please take your picture.'); return false; }
      if (!state.photo && state.result?.declined && $('[data-camera-error]').hidden) { formError('Please take your picture.'); return false; }
      return true;
    case 'rules':
      if (signMode() !== 'off') {
        if (!pad.isSigned()) { formError('Please sign in the box to agree to the visitor rules.'); return false; }
        if ((a.email || '').trim() && !EMAIL_OK.test(a.email.trim())) { formError('Please check the email address, or leave it empty.', [field('email')]); return false; }
        return true;
      }
      if (!a.agreed) { formError('Please check the box to agree to the visitor rules.'); return false; }
      return true;
    default:
      return true;
  }
}

/** Decides the questions once the last one is answered. */
function evaluate() {
  const flags = [], reasons = [];
  for (const q of questionSteps()) {
    const answer = answerOf(q);
    if (q.rule.action === 'none' || !q.rule.answers.includes(answer)) continue;
    const item = { label: q.label, answer, flagLabel: q.rule.flagLabel || q.label };
    (q.rule.action === 'decline' ? reasons : flags).push(item);
  }
  return { declined: reasons.length > 0, reasons, flags };
}

function answersForRecord() {
  const out = [];
  for (const q of activeQuestions()) {
    out.push({ label: q.label, value: answerOf(q) });
    if (q.followUp) out.push({ label: q.followUp.label, value: needsFollowUp(q) ? (state.answers[`qf-${q.id}`] || '').trim() : q.followUp.otherwise });
  }
  return out;
}

$('[data-form-next]').addEventListener('click', () => {
  if (state.busy || !validateStep()) return;
  const name = currentStep();
  const qs = questionSteps();
  const lastQuestion = qs.length && name === `q:${qs[qs.length - 1].id}`;
  if (lastQuestion) {
    state.result = evaluate();
    state.steps = [...state.steps.slice(0, state.step + 1), ...stepsAfterQuestions()];
    if (state.result.declined && state.step === state.steps.length - 1) { submitDecline(); return; }
  }
  if (state.result?.declined && name === 'photo') { submitDecline(); return; }
  if (name === 'name') lookUpExpected();
  if (state.step < state.steps.length - 1) { state.step++; renderStep(); return; }
  finishQuestions(false, centerOf($('[data-form-next]')));
});
$('[data-form-back]').addEventListener('click', () => {
  if (state.step > 0) { state.step--; renderStep({ back: true }); }
});

/** Staff expecting this visitor: greet them and fill in what staff already told us. */
let expectedSeq = 0;
async function lookUpExpected() {
  if (!can('expected') || PHONE) return;
  const first = (state.answers.first || '').trim(), last = (state.answers.last || '').trim();
  const seq = ++expectedSeq;
  const res = await api('findExpected', { first, last });
  if (seq !== expectedSeq || state.screen !== 'form') return;
  const e = res.ok ? res.expected : null;
  state.expected = e;
  const note = $('[data-expected-note]');
  note.hidden = !e;
  if (!e) return;
  note.textContent = e.host ? t("Welcome, {name}! We're expecting you. {host} will be told you're here.", { name: first, host: e.host }) : t("Welcome, {name}! We're expecting you.", { name: first });
  for (const [name, value] of [['company', e.company], ['visiting', e.host], ['purpose', e.purpose]]) {
    const input = $(`[data-screen="form"] input[name="${name}"]`);
    if (!value || !input || input.value.trim()) continue;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  renderHostSuggest('');
}

/** Every field on every screen opens the on-screen keyboard. */
document.addEventListener('click', (e) => {
  const input = e.target.closest('input[readonly]');
  if (input && !input.closest('[hidden]')) kb.open(input);
});
document.addEventListener('input', (e) => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) return;
  input.classList.remove('invalid');
  if (!input.closest('[data-screen="form"]')) return;
  state.answers[input.name] = input.value;
  if (input.name === 'purpose') $$('[data-chips="purpose"] .chip').forEach((c) => c.classList.toggle('on', c.textContent === input.value));
  if (input.name === 'visiting') renderHostSuggest(input.value);
});

/** People from the setup's host list whose name matches what the visitor is typing. */
function renderHostSuggest(typed) {
  const box = $('[data-host-suggest]');
  const hits = hostMatches(typed);
  box.innerHTML = hits.map((h) => `<button type="button" class="chip host-chip" data-host="${esc(h.name)}"><span class="avatar">${esc(initials({ first: h.name.split(/\s+/)[0], last: h.name.split(/\s+/).slice(1).join(' ') }))}</span>${esc(h.name)}</button>`).join('');
  box.hidden = !hits.length;
}
$('[data-host-suggest]').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-host]');
  if (!chip) return;
  const input = $('input[name="visiting"]');
  input.value = chip.dataset.host;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  renderHostSuggest('');
  // Move on to the next field, as if they'd finished typing.
  const purpose = $('input[name="purpose"]');
  if (settings().form.askPurpose && !purpose.value) kb.open(purpose); else kb.close();
});
document.addEventListener('paste', (e) => {
  if (!kb.input) return;
  e.preventDefault();
  kb.insert(e.clipboardData?.getData('text') || '');
});

$('[data-chips="purpose"]').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const input = $('input[name="purpose"]');
  input.value = chip.textContent;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  kb.close();
});

// Screening answers (generated steps, so one delegated handler).
$('[data-form-body]').addEventListener('click', (e) => {
  const opt = e.target.closest('.option[data-q]');
  if (!opt) return;
  const q = questionById(opt.dataset.q);
  if (!q) return;
  $$('.option', opt.parentElement).forEach((o) => {
    o.classList.toggle('on', o === opt);
    o.setAttribute('aria-checked', String(o === opt));
  });
  state.qa[q.id] = opt.dataset.value;
  $('[data-form-error]').textContent = '';
  const follow = $(`[data-followup="${CSS.escape(q.id)}"]`);
  if (follow) {
    follow.hidden = !needsFollowUp(q);
    if (!follow.hidden) kb.open($('input', follow));
    else kb.close();
  }
});

$('[data-agree]').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-checked') !== 'true';
  e.currentTarget.setAttribute('aria-checked', String(on));
  state.answers.agreed = on;
  $('[data-form-error]').textContent = '';
});

// Photo step
async function startPhotoCamera() {
  const video = $('[data-video="photo"]');
  $('[data-camera-error]').hidden = true;
  if (state.photo) return;
  try {
    await face.startCamera(video);
  } catch (err) {
    console.error(err);
    $('[data-camera-error]').hidden = false;
  }
}

function clearPhoto() {
  state.photo = null;
  state.photoDescriptor = null;
  $('[data-shot]').hidden = true;
  $('[data-video="photo"]').hidden = false;
  $('[data-capture]').hidden = false;
  $('[data-retake]').hidden = true;
}

$('[data-capture]').addEventListener('click', async () => {
  const video = $('[data-video="photo"]');
  if (!video.videoWidth) { $('[data-camera-error]').hidden = false; return; }
  const cd = $('[data-countdown]');
  cd.hidden = false;
  for (const n of [3, 2, 1]) { cd.textContent = n; await sleep(700); }
  cd.hidden = true;
  const shot = face.snapshot(video);
  const frame = $('.camera-frame');
  frame.classList.remove('flash'); void frame.offsetWidth; frame.classList.add('flash');
  state.photo = shot;
  $('[data-shot]').src = shot.dataUrl;
  $('[data-shot]').hidden = false;
  video.hidden = true;
  $('[data-capture]').hidden = true;
  $('[data-retake]').hidden = false;
  $('[data-form-error]').textContent = '';
  face.stopCamera();
  if (!quickOn()) return;
  // Check the picture shows a face; this descriptor is used only if they opt into quick entry.
  try {
    const d = await face.describe(shot.canvas);
    if (state.photo !== shot) return;
    state.photoDescriptor = d;
    // The check can finish after the visitor has moved on: only say so on the photo step.
    if (!d && currentStep() === 'photo') formError("We couldn't see your face clearly. You can retake the picture, or continue.");
  } catch { /* face models unavailable: the photo is still fine */ }
});
$('[data-retake]').addEventListener('click', () => { clearPhoto(); startPhotoCamera(); });

// Quick-entry choice submits the sign-in.
$$('[data-quick]').forEach((b) => b.addEventListener('click', () => finishQuestions(b.dataset.quick === 'yes', centerOf(b))));

function finishQuestions(quickEntry, origin) {
  if (state.flow === 'returning') { afterIdentified(origin); return; }
  submitNewVisitor(quickEntry, origin);
}

async function submitNewVisitor(quickEntry, origin) {
  if (state.busy) return;
  busy(true, 'Saving your sign-in…');
  let descriptor = state.photoDescriptor;
  if (quickEntry && !descriptor && state.photo) {
    try { descriptor = await face.describe(state.photo.canvas); } catch { descriptor = null; }
  }
  const a = state.answers;
  const res = await api('register', {
    first: a.first, last: a.last, company: a.company, visiting: a.visiting, purpose: canonicalPurpose(a.purpose),
    language: lang() === 'en' ? undefined : LANGS[lang()],
    agreed: !!a.agreed, quickEntry, photo: state.photo?.dataUrl || '', descriptor: quickEntry ? descriptor : null,
    ...signedFields(),
    answers: answersForRecord(), flags: state.result?.flags || [], override: state.override || undefined,
  });
  busy(false);
  if (!res.ok) { formError(errorText(res)); return; }
  if (PHONE) {
    // Signed in already (no badge); the phone keeps the visitor so it can sign them in again or out.
    phoneVisitor.set({ visitorId: res.visitor.id, token: res.token, first: res.visitor.first, last: res.visitor.last, company: res.visitor.company, visitId: res.visitId });
    state.visitor = res.visitor;
    state.method = 'new visitor';
    state.hostNotified = res.hostNotified || '';
    state.noPass = !!res.noPass;
    showDone(res.badge || '');
    return;
  }
  state.visitor = res.visitor;
  state.method = 'new visitor';
  if (quickEntry && descriptor) rememberSample(res.visitor, descriptor);
  // Every-visit flags already went in with the registration.
  state.result = state.result ? { ...state.result, flags: [] } : null;
  afterIdentified(origin);
}

/** The visitor is known: finish with a badge tap, or sign them straight in when there are no badges. */
async function afterIdentified(origin) {
  if (settings().badges) { show('badge', { origin }); return; }
  busy(true, 'Signing you in…');
  // Numbered passes: the kiosk gives out the next free one (a phone's sign-in does it on the sheet).
  const withPass = settings().passes && !PHONE;
  let res = await api(withPass ? 'assignPass' : 'checkIn', {
    visitorId: state.visitor.id, method: state.method, flags: state.result?.flags || [], override: state.override || undefined,
    visiting: state.answers.visiting, purpose: canonicalPurpose(state.answers.purpose), expectedId: state.expected?.id,
    ...(state.flow === 'returning' ? signedFields() : {}),
  });
  // An Apps Script older than version 7 doesn't give out passes: sign in without one.
  if (withPass && !res.ok && res.error === 'unknown_action') {
    res = await api('checkIn', { visitorId: state.visitor.id, method: state.method, flags: state.result?.flags || [], override: state.override || undefined, visiting: state.answers.visiting, purpose: canonicalPurpose(state.answers.purpose), expectedId: state.expected?.id });
    if (res.ok) res.noPass = true;
  }
  busy(false);
  if (!res.ok) {
    // The phone's visitor is no longer on file (deleted, say): start again as new.
    if (PHONE && res.error === 'phone_visitor') { phoneVisitor.clear(); toast(t('Please sign in as a new visitor.')); show('welcome'); return; }
    toast(errorText(res));
    return;
  }
  if (PHONE) phoneVisitor.set({ ...phoneVisitor.get(), visitId: res.visitId });
  state.hostNotified = res.hostNotified || '';
  state.noPass = !!res.noPass;
  showDone(res.badge || '');
}

function showDone(badge) {
  $('[data-done-title]').textContent = state.method === 'new visitor'
    ? t("You're all set, {name}!", { name: state.visitor.first })
    : t('Welcome back, {name}!', { name: state.visitor.first });
  const b = $('[data-done-badge]');
  const passes = settings().passes;
  b.textContent = badge ? t(passes ? 'Pass {badge}' : 'Badge {badge}', { badge }) : '';
  b.hidden = !badge;
  // Numbered passes: which one to take (or, with all of them out, to ask at the front desk).
  const pass = $('[data-done-pass]');
  pass.textContent = !passes ? '' : badge ? t('Please take visitor pass {badge}.', { badge }) : state.noPass ? t('All the visitor passes are in use. Please ask at the front desk for one.') : '';
  pass.hidden = !pass.textContent;
  const host = $('[data-done-host]');
  host.textContent = state.hostNotified ? t("We've let {host} know you're here.", { host: state.hostNotified }) : '';
  host.hidden = !state.hostNotified;
  show('done');
  if (state.result?.flags?.length || state.override) setTimeout(refreshAttention, 1500);
}

// ------------------------------------------------------------------ declined visitors

async function submitDecline() {
  if (state.busy) return;
  busy(true, 'One moment…');
  const a = state.answers, v = state.visitor;
  const res = await api('recordDecline', {
    first: a.first || v?.first, last: a.last || v?.last, company: a.company || v?.company,
    visiting: a.visiting, purpose: canonicalPurpose(a.purpose), visitorId: v?.id || '', method: state.flow === 'returning' ? state.method : 'new visitor',
    photo: state.photo?.dataUrl || '', reasons: state.result.reasons, expectedId: state.expected?.id,
  });
  busy(false);
  if (!res.ok) { formError(errorText(res)); return; }
  if (res.passed) {
    // An admin already let this person in: carry on as normal.
    continueAfterOverride({ by: res.by, reason: res.reason });
    toast(t('Welcome! A member of staff has already approved your visit.'));
    return;
  }
  state.declineId = res.declineId;
  show('declined');
  setTimeout(refreshAttention, 1500);
}

/** A declined visitor was let in: skip the rest of the questions and finish signing in. */
function continueAfterOverride(override) {
  state.override = override;
  state.result = { declined: false, reasons: [], flags: [] };
  const lastQ = state.steps.map((s) => s.startsWith('q:')).lastIndexOf(true);
  const rest = stepsAfterQuestions().filter((s) => s !== 'photo' || !state.photo);
  state.steps = [...state.steps.slice(0, lastQ + 1), ...rest];
  if (!rest.length) { finishQuestions(false, { x: innerWidth / 2, y: innerHeight / 2 }); return; }
  state.step = lastQ + 1;
  if (state.screen !== 'form') { state.resume = true; show('form'); } else renderStep();
}

$('[data-staff-override]').addEventListener('click', () => {
  const first = state.answers.first || state.visitor?.first || 'this visitor';
  openPin({
    title: 'Staff override',
    hint: `Enter the admin PIN to let ${first} in.`,
    async onSuccess(token) {
      const reason = await askReason({
        title: `Let ${first} in?`,
        text: "They'll finish signing in now. Your name and the reason are saved with the visit.",
      });
      if (reason === null) return;
      busy(true, 'One moment…');
      const res = await api('adminAllow', { token, visitId: state.declineId, reason });
      busy(false);
      if (!res.ok) { toast(errorText(res)); return; }
      continueAfterOverride({ by: res.by || settings().admin.name || 'Admin', reason });
    },
  });
});

/** Asks a staff member why (optional). Resolves with the reason, or null if cancelled. */
function askReason({ title, text }) {
  const ov = $('[data-overlay="reason"]');
  const input = $('input[name="reason"]', ov);
  $('[data-reason-title]').textContent = title;
  $('[data-reason-text]').textContent = text;
  input.value = '';
  ov.hidden = false;
  return new Promise((resolve) => {
    const done = (value) => {
      kb.close();
      ov.hidden = true;
      $('[data-reason-ok]').onclick = null;
      $('[data-reason-cancel]').onclick = null;
      resolve(value);
    };
    $('[data-reason-ok]').onclick = () => done(input.value.trim());
    $('[data-reason-cancel]').onclick = () => done(null);
  });
}
$('[data-reason-chips]').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const input = $('[data-overlay="reason"] input[name="reason"]');
  input.value = chip.textContent;
  kb.close();
});

// ------------------------------------------------------------------ returning visitor
//
// One screen: the visitor types their name while the camera quietly looks for
// them in the background. Whichever finds them first wins.

const FACE_LOOK_MS = 12000;

function resetFind() {
  $$('[data-screen="find"] input').forEach((i) => { i.value = ''; });
  $('[data-matches]').innerHTML = '';
  $('[data-matches]').dataset.ids = '';
  $('[data-suggest]').innerHTML = '';
  $('[data-find-error]').textContent = '';
  $('[data-face-match]').hidden = true;
  state.sample = null;
  state.faceHit = null;
  state.faceFrames = [];
  setTimeout(() => { if (state.screen === 'find') kb.open($('input[name="ffirst"]')); }, 450);
  if (quickOn()) recognizeInBackground();
}

function camStatus(cls, text) {
  const bubble = $('[data-cam-bubble]');
  bubble.classList.remove('found', 'idle');
  if (cls) bubble.classList.add(cls);
  $('[data-cam-label]').textContent = t(text);
}

async function recognizeInBackground() {
  const run = ++state.recognition;
  const video = $('[data-video="return"]');
  camStatus('', 'Looking for you…');
  try {
    await face.startCamera(video);
    await face.loadModels();
  } catch (err) {
    console.warn(err);
    if (run === state.recognition) camStatus('idle', 'Camera off');
    return;
  }

  // A sliding window of the latest frames; identify() needs most of them to agree.
  const recent = [];
  state.faceFrames = recent;
  const deadline = Date.now() + FACE_LOOK_MS;
  await sleep(300); // let auto-exposure settle
  while (Date.now() < deadline) {
    if (run !== state.recognition) return;
    const d = await face.describe(face.snapshot(video, 640).canvas).catch(() => null);
    if (run !== state.recognition) return;
    if (d) {
      recent.push(d);
      if (recent.length > CONFIG.FACE_FRAMES) recent.shift();
      const hit = recent.length === CONFIG.FACE_FRAMES && face.identify(recent, state.faceIndex);
      if (hit) {
        // The camera stays live (and green) until they leave this screen.
        keepSample(video, recent);
        showFaceMatch(hit.person);
        return;
      }
    }
    await sleep(350);
  }
  if (run !== state.recognition) return;
  // Not recognized: keep this look at them anyway. It becomes a new sample once
  // they find themselves by name (and only if they use quick entry).
  if (recent.length) keepSample(video, recent);
  face.stopCamera();
  camStatus('idle', 'Type your name');
}

function keepSample(video, descriptors) {
  state.sample = { descriptor: face.average(descriptors), photo: face.snapshot(video).dataUrl };
}

function showFaceMatch(person) {
  state.faceHit = person;
  camStatus('found', 'Found you!');
  $('[data-face-title]').textContent = t('Welcome back, {name}!', { name: person.first });
  $('[data-face-name]').textContent = `${person.first} ${person.last}`;
  $('[data-face-company]').textContent = person.company || '';
  $('[data-face-match]').hidden = false;
  $('[data-screen="find"] .form-body').scrollTop = 0;
}

$('[data-face-yes]').addEventListener('click', (e) => {
  const p = state.faceHit;
  if (!p) return;
  state.visitor = { id: p.id, first: p.first, last: p.last, company: p.company, quickEntry: true };
  state.method = 'returning (face)';
  saveSample('return-face');
  continueReturning(centerOf(e.currentTarget));
});

/** Returning visitors answer the every-visit questions (if any), then finish. */
function continueReturning(origin) {
  if (!everyVisitQuestions().length && signMode() !== 'every') { afterIdentified(origin); return; }
  state.flow = 'returning';
  state.resume = false;
  show('form');
}

// Matches appear as they type; "Find me" also says so when nobody matches.
let liveSearch = null;
let searchSeq = 0;
$$('[data-screen="find"] input').forEach((input) => input.addEventListener('input', () => {
  clearTimeout(liveSearch);
  liveSearch = setTimeout(() => findMe({ live: true }), 500);
}));
$('[data-find-go]').addEventListener('click', () => findMe());

async function findMe({ live = false } = {}) {
  const v = (n) => $(`input[name="${n}"]`).value.trim();
  if (live && (v('ffirst').length < 2 || v('flast').length < 2)) return;
  if (!live) {
    kb.close();
    if (!v('ffirst') || !v('flast')) { $('[data-find-error]').textContent = t('Please enter your first and last name.'); return; }
    busy(true, 'Looking you up…');
  }
  $('[data-find-error]').textContent = '';
  const seq = ++searchSeq;
  const res = await api('findVisitor', { first: v('ffirst'), last: v('flast'), company: v('fcompany') });
  if (!live) busy(false);
  if (seq !== searchSeq || state.screen !== 'find') return;
  const box = $('[data-matches]');
  if (!res.ok) { if (!live) $('[data-find-error]').textContent = errorText(res); return; }
  if (!res.matches.length) {
    box.dataset.ids = '';
    $('[data-suggest]').innerHTML = '';
    box.innerHTML = live ? '' : `<div class="no-match"><strong>${esc(t("We couldn't find you."))}</strong> ${esc(t('Check the spelling, or sign in as a new visitor. It only takes two minutes.'))}
      <div class="quick-actions"><button type="button" class="btn-primary" data-new-instead>${esc(t('Sign in as a new visitor'))}</button></div></div>`;
    $('[data-new-instead]', box)?.addEventListener('click', () => { state.flow = 'new'; show('form'); });
    return;
  }
  const shown = box.dataset.ids;
  const ids = res.matches.map((m) => m.id).join(',');
  box.dataset.ids = ids;
  box.innerHTML = `<p class="hint">${esc(t(res.matches.length > 1 ? 'Which one is you?' : 'Is this you?'))}</p>` + res.matches.map((m, i) => `
    <button type="button" class="match" data-match="${i}">
      <span class="avatar">${esc(initials(m))}</span>
      <span><strong>${esc(m.first)} ${esc(m.last)}</strong><span>${esc(m.company)}${m.lastVisit ? ` · ${esc(t('last visit {date}', { date: m.lastVisit }))}` : ''}</span></span>
      <span class="go">${esc(t("That's me ›"))}</span>
    </button>`).join('');
  const suggest = $('[data-suggest]');
  suggest.innerHTML = res.matches.map((m, i) => `
    <button type="button" class="suggest-chip" data-match="${i}">
      <span class="avatar">${esc(initials(m))}</span>
      <span><strong>${esc(m.first)} ${esc(m.last)}</strong><span>${esc(m.company)}</span></span>
      <em>${esc(t("That's me ›"))}</em>
    </button>`).join('');
  $$('[data-match]', box).concat($$('[data-match]', suggest)).forEach((b) => b.addEventListener('click', () => chooseMatch(res.matches[Number(b.dataset.match)], centerOf(b))));
  if (shown !== ids) fx.cascade(box, { step: 70 });
}

function chooseMatch(m, origin) {
  // Found by name before the camera finished: keep what it has seen as their new sample.
  const video = $('[data-video="return"]');
  if (!state.sample && state.faceFrames.length && video.videoWidth) keepSample(video, state.faceFrames);
  state.recognition++;
  state.visitor = m;
  state.method = 'returning (name)';
  if (m.quickEntry) { saveSample('return-name'); continueReturning(origin); return; }
  if (!state.sample || !quickOn()) { continueReturning(origin); return; }
  $('[data-optin-title]').textContent = t('Hi, {name}!', { name: m.first });
  show('optin');
}

$$('[data-optin]').forEach((b) => b.addEventListener('click', async () => {
  if (b.dataset.optin === 'yes' && state.visitor) {
    busy(true, 'Turning on quick entry…');
    const res = await api('setQuickEntry', { visitorId: state.visitor.id, on: true });
    busy(false);
    if (res.ok) { state.visitor.quickEntry = true; saveSample('opt-in'); }
  }
  state.sample = null;
  continueReturning(centerOf(b));
}));

// ------------------------------------------------------------------ signing out without a badge

let leaveSearch = null;
let leaveSeq = 0;
function resetLeave() {
  $$('[data-screen="leave"] input').forEach((i) => { i.value = ''; });
  $('[data-leave-matches]').innerHTML = '';
  $('[data-leave-error]').textContent = '';
  setTimeout(() => { if (state.screen === 'leave') kb.open($('input[name="lfirst"]')); }, 450);
}
$$('[data-screen="leave"] input').forEach((input) => input.addEventListener('input', () => {
  clearTimeout(leaveSearch);
  leaveSearch = setTimeout(() => findOpen({ live: true }), 500);
}));
$('[data-leave-go]').addEventListener('click', () => findOpen());

async function findOpen({ live = false } = {}) {
  const v = (n) => $(`input[name="${n}"]`).value.trim();
  if (live && (v('lfirst').length < 2 || v('llast').length < 2)) return;
  if (!live) {
    kb.close();
    if (!v('lfirst') || !v('llast')) { $('[data-leave-error]').textContent = t('Please enter your first and last name.'); return; }
  }
  const seq = ++leaveSeq;
  const res = await api('findOpenVisits', { first: v('lfirst'), last: v('llast') });
  if (seq !== leaveSeq || state.screen !== 'leave') return;
  const box = $('[data-leave-matches]');
  if (!res.ok) { if (!live) $('[data-leave-error]').textContent = errorText(res); return; }
  if (!res.matches.length) {
    box.innerHTML = live ? '' : `<div class="no-match"><strong>${esc(t("We couldn't find you signed in."))}</strong> ${esc(t('Check the spelling, or see the front desk.'))}</div>`;
    return;
  }
  box.innerHTML = `<p class="hint">${esc(t(res.matches.length > 1 ? 'Which one is you?' : 'Is this you?'))}</p>` + res.matches.map((m, i) => `
    <button type="button" class="match" data-leave-match="${i}">
      <span class="avatar">${esc(initials(m))}</span>
      <span><strong>${esc(m.first)} ${esc(m.last)}</strong><span>${esc(m.company)} · ${esc(t('signed in {time}', { time: timeOf(m.since) }))}</span></span>
      <span class="go">${esc(t('Sign me out ›'))}</span>
    </button>`).join('');
  $$('[data-leave-match]', box).forEach((b) => b.addEventListener('click', async () => {
    const m = res.matches[Number(b.dataset.leaveMatch)];
    busy(true, 'Signing you out…');
    const out = await api('kioskSignOut', { visitId: m.visitId });
    busy(false);
    if (!out.ok) { $('[data-leave-error]').textContent = errorText(out); return; }
    // The goodbye is shown in the visitor's language, before the kiosk switches back.
    showSignedOut(out);
    show('welcome');
  }));
}

// ------------------------------------------------------------------ badge taps

if (!PHONE) listenForTaps(onTap, (key) => {
  touch();
  if (kb.input) kb.type(key);
  else if (key === 'Backspace' && $('[data-overlay="pin"]').hidden === false) pinPress('back');
  else if (/^\d$/.test(key) && $('[data-overlay="pin"]').hidden === false) pinPress(key);
});

function onTap(tag, typed) {
  kb.untype(typed);
  touch();
  if (tag) state.lastTapAt = Date.now();
  if (!tag || state.busy) return;
  if (!$('[data-overlay="pin"]').hidden) return;
  if (state.screen === 'setup') { setupTap(tag); return; }
  if (!settings().badges) { toast(t("This kiosk doesn't use badges. Sign in and out on the screen.")); return; }
  if (state.screen === 'admin') { adminTap(tag); return; }
  if (state.screen === 'welcome') { welcomeTap(tag); return; }
  if (state.screen === 'badge') { badgeTap(tag); return; }
  if (state.screen !== 'done') toast(t('Finish signing in first. You will tap your badge at the end.'));
}

/**
 * Glides the animated badge from wherever it is in its loop onto the reader,
 * so a real tap never makes the scene jump.
 */
function lockBadge(scene) {
  if (scene.classList.contains('locked')) return;
  const rig = $('.badge-rig', scene);
  const from = getComputedStyle(rig);
  const start = { transform: from.transform, opacity: from.opacity };
  scene.classList.add('locked');
  const end = getComputedStyle(rig);
  rig.animate([start, { transform: end.transform, opacity: end.opacity }], { duration: 420, easing: 'cubic-bezier(.2,.9,.3,1)' });
}

async function badgeTap(tag) {
  const scene = $('[data-tap-scene]');
  const status = $('[data-badge-status]');
  if (scene.classList.contains('reading') || scene.classList.contains('success')) return;
  state.busy = true;
  scene.classList.remove('error');
  lockBadge(scene);
  scene.classList.add('reading');
  status.textContent = t('Reading your badge…');
  const [res] = await Promise.all([
    api('assignBadge', {
      visitorId: state.visitor.id, tag, method: state.method,
      flags: state.result?.flags || [], override: state.override || undefined,
      visiting: state.answers.visiting, purpose: canonicalPurpose(state.answers.purpose), expectedId: state.expected?.id,
      ...(state.flow === 'returning' ? signedFields() : {}),
    }),
    sleep(700), // long enough to see the reader at work
  ]);
  state.busy = false;
  scene.classList.remove('reading');
  if (!res.ok) {
    status.textContent = errorText(res);
    scene.classList.add('error');
    // After the shake, fade the badge off the reader and let the demo loop restart.
    setTimeout(async () => {
      await $('.badge-rig', scene).animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260 }).finished.catch(() => {});
      scene.classList.remove('error', 'locked');
    }, 1300);
    return;
  }
  // Accepted: the ring completes in green, the check draws and the badge number appears, then the screen flips over.
  state.hostNotified = res.hostNotified || '';
  $('[data-badge-no]').textContent = res.badge;
  scene.classList.add('success');
  status.textContent = t('Badge {badge} is yours!', { badge: res.badge });
  await sleep(1500);
  showDone(res.badge);
}

async function welcomeTap(tag) {
  busy(true, 'Signing you out…');
  const res = await api('tapAtWelcome', { tag });
  busy(false);
  if (!res.ok) { toast(errorText(res)); return; }
  if (res.result === 'unknown') { toast("This badge isn't set up yet. Please see the front desk."); return; }
  if (res.result === 'returned') { toast(`Thanks for bringing back badge ${res.badge}. Please leave it at the front desk.`, 6000); return; }
  if (res.result === 'not_out') { toast(`Badge ${res.badge} isn't checked out. To sign in, tap the screen.`); return; }
  showSignedOut(res);
}

function showSignedOut(res) {
  const ov = $('[data-overlay="signout"]');
  const org = settings().org.name;
  $('[data-signout-title]').textContent = t('Goodbye, {name}!', { name: res.first });
  const giveBack = res.badge ? t(settings().passes ? "You're signed out. Please give visitor pass {badge} back at the front desk." : "You're signed out. Please leave badge {badge} at the front desk.", { badge: res.badge }) : t("You're signed out.");
  $('[data-signout-text]').textContent = `${giveBack} ${org ? t('Thanks for visiting {org}.', { org }) : t('Thanks for visiting.')}`;
  const undo = $('[data-undo]');
  undo.hidden = PHONE;
  undo.textContent = t('Not you? Undo');
  ov.hidden = false;
  clearTimeout(state.undo?.timer);
  state.undo = { visitId: res.visitId, timer: setTimeout(() => { ov.hidden = true; state.undo = null; }, 7000) };
}

$('[data-undo]').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!state.undo) return;
  const { visitId, timer } = state.undo;
  clearTimeout(timer);
  state.undo = null;
  const res = await api('undoSignOut', { visitId });
  $('[data-overlay="signout"]').hidden = true;
  toast(t(res.ok ? 'Undone. You are still signed in.' : 'Too late to undo. Please see the front desk.'));
});
$('[data-overlay="signout"]').addEventListener('click', (e) => {
  if (e.target.closest('[data-undo]')) return;
  clearTimeout(state.undo?.timer);
  state.undo = null;
  e.currentTarget.hidden = true;
});

// ------------------------------------------------------------------ admin

let pin = '';
let pinOpts = {};
/** The PIN pad. With opts.onSuccess, a correct PIN calls it with the admin token instead of opening the admin screen. */
function openPin(opts = {}) {
  pin = '';
  pinOpts = opts;
  renderPin();
  $('[data-pin-title]').textContent = opts.title || 'Admin';
  $('[data-pin-hint]').textContent = opts.hint || 'Enter the admin PIN';
  $('[data-pin-error]').textContent = '';
  $('[data-overlay="pin"]').hidden = false;
}
function renderPin() {
  $('[data-pin-dots]').innerHTML = '<i></i>'.repeat(pin.length);
}
async function pinPress(k) {
  touch();
  if (k === 'cancel') { $('[data-overlay="pin"]').hidden = true; return; }
  if (k === 'back') { pin = pin.slice(0, -1); renderPin(); return; }
  if (k === 'go') {
    if (pin.length < 4) return;
    busy(true, 'Checking…');
    const res = await api('adminLogin', { pin });
    busy(false);
    pin = '';
    renderPin();
    if (!res.ok) {
      $('[data-pin-error]').textContent = res.error === 'locked' ? 'Too many tries. Wait 10 minutes.'
        : res.error === 'pin' ? 'Wrong PIN.' : res.error === 'no_pin' ? 'No admin PIN has been set yet.' : errorText(res);
      return;
    }
    $('[data-overlay="pin"]').hidden = true;
    if (pinOpts.onSuccess) { pinOpts.onSuccess(res.token); return; }
    state.adminToken = res.token;
    show('admin');
    return;
  }
  if (pin.length < 8) { pin += k; renderPin(); }
}
(() => {
  const pad = $('[data-pin-pad]');
  const go = document.createElement('button');
  go.type = 'button';
  go.dataset.pin = 'go';
  go.className = 'pin-go';
  go.textContent = 'Unlock';
  pad.appendChild(go);
  pad.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) pinPress(b.dataset.pin || b.textContent.trim());
  });
})();

async function adminApi(action, args = {}) {
  const res = await api(action, { ...args, token: state.adminToken });
  if (!res.ok && res.error === 'admin') {
    exitAdmin();
    toast('Admin session ended. Please unlock again.');
  }
  return res;
}

// ------------------------------------------------------------------ Android app

// Present only inside the Android app (see android/). Kiosk mode keeps the
// tablet locked to this app; admins can unlock it to reach Android settings.
if (Kiosk) {
  const unlock = $('[data-kiosk-unlock]');
  unlock.hidden = false;
  unlock.addEventListener('click', () => confirmTap(unlock, 'Tap again to unlock the tablet', async () => {
    try { await Kiosk.unlock(); toast('Tablet unlocked. Kiosk mode comes back when the app reopens.'); } catch { toast("Couldn't unlock the tablet."); }
    unlock.disabled = false;
  }));
}

function exitAdmin() {
  state.adminToken = null;
  state.adminMode = null;
  $('[data-overlay="rollcall"]').hidden = true;
  $('[data-overlay="signed"]').hidden = true;
  $('[data-overlay="agreement"]').hidden = true;
  $('[data-expected-form]').hidden = true;
  show('welcome');
}
$('[data-admin-exit]').addEventListener('click', exitAdmin);

$$('[data-admin-tab]').forEach((t) => t.addEventListener('click', () => adminTab(t.dataset.adminTab)));
$('[data-admin-refresh]').addEventListener('click', () => adminTab('inside'));
$('[data-attn-refresh]').addEventListener('click', () => adminTab('attention'));

function adminTab(name) {
  state.adminMode = null;
  kb.close();
  $('[data-admin-banner]').hidden = true;
  $$('[data-admin-tab]').forEach((t) => t.classList.toggle('active', t.dataset.adminTab === name));
  $$('[data-admin-pane]').forEach((p) => { p.hidden = p.dataset.adminPane !== name; });
  if (name === 'inside') loadInside();
  else if (name === 'attention') loadAttention();
  else if (name === 'history') loadHistory();
  else if (name === 'expected') loadExpected();
  else if (name === 'badges') loadBadges();
  else loadSettingsPane();
}

async function loadInside() {
  const list = $('[data-inside-list]');
  list.innerHTML = '<div class="empty">Loading…</div>';
  refreshAttention();
  adminApi('adminExpected', { days: 1 }).then((r) => { if (r.ok) updateExpectedCount(r); });
  const res = await adminApi('adminInside');
  if (!res.ok) { list.innerHTML = `<div class="empty">${esc(errorText(res))}</div>`; return; }
  $('[data-inside-count]').textContent = res.inside.length;
  if (!res.inside.length) { list.innerHTML = '<div class="empty">Nobody is signed in right now.</div>'; return; }
  list.innerHTML = res.inside.sort((a, b) => String(a.last).localeCompare(String(b.last))).map((v) => `
    <div class="admin-row">
      <span class="badge-no">${esc(v.badge || '—')}</span>
      <div class="who"><strong>${esc(v.first)} ${esc(v.last)}</strong>
        <span class="meta">${esc(v.company)} · visiting ${esc(v.visiting || '—')} · since ${esc(timeOf(v.since))}</span></div>
      ${v.kind && v.kind !== 'Visitor' ? `<span class="pill ${/override/i.test(v.kind) ? 'override' : 'foreign'}">${esc(v.kind)}</span>` : ''}
      <div class="actions"><button type="button" data-signout="${esc(v.visitId)}">Sign out</button></div>
    </div>`).join('');
  fx.cascade(list, { step: 40 });
  $$('[data-signout]', list).forEach((b) => b.addEventListener('click', () => confirmTap(b, 'Tap again to sign out', async () => {
    const r = await adminApi('adminSignOut', { visitId: b.dataset.signout });
    toast(r.ok ? 'Signed out.' : errorText(r));
    loadInside();
  })));
}

async function loadAttention() {
  const list = $('[data-attn-list]');
  list.innerHTML = '<div class="empty">Loading…</div>';
  const res = await adminApi('adminAttention');
  if (!res.ok) { list.innerHTML = `<div class="empty">${esc(errorText(res))}</div>`; return; }
  refreshAttention();
  if (!res.items.length) { list.innerHTML = '<div class="empty">Nothing needs a look right now.</div>'; return; }
  list.innerHTML = res.items.map((it, i) => `
    <div class="admin-row attn-row">
      ${it.photo && it.photo.startsWith('data:') ? `<img class="attn-photo" src="${esc(it.photo)}" alt="">` : `<span class="badge-no">${esc(initials(it))}</span>`}
      <div class="who"><strong>${esc(it.first)} ${esc(it.last)}</strong>
        <span class="meta">${esc(it.company)}${it.visiting ? ` · visiting ${esc(it.visiting)}` : ''} · ${esc(timeOf(it.when))}${it.inside ? ' · inside now' : ''}</span>
        <span class="reason">${esc(it.screening)}</span>
        ${it.photo && !it.photo.startsWith('data:') ? `<span class="meta drive-note">Photo saved in Google Drive</span>` : ''}</div>
      <span class="pill ${it.kind}">${esc(it.label)}</span>
      <div class="actions">
        ${it.kind === 'declined' && !it.allowed ? `<button type="button" data-allow="${i}">Let in</button>` : ''}
        <button type="button" data-review="${i}">Mark reviewed</button>
      </div>
    </div>`).join('');
  fx.cascade(list, { step: 40 });
  // Photos kept in Google Drive are fetched one at a time.
  (async () => {
    for (const [i, it] of res.items.entries()) {
      if (!it.photo || it.photo.startsWith('data:')) continue;
      const p = await api('adminPhoto', { token: state.adminToken, visitId: it.visitId });
      if (!p.ok) break;
      const row = $$('.attn-row', list)[i];
      if (!p.photo || !row || !row.isConnected) continue;
      row.querySelector('.badge-no')?.replaceWith(Object.assign(document.createElement('img'), { className: 'attn-photo', src: p.photo, alt: '' }));
      row.querySelector('.drive-note')?.remove();
    }
  })();
  $$('[data-review]', list).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const r = await adminApi('adminReview', { visitId: res.items[Number(b.dataset.review)].visitId });
    if (!r.ok) toast(errorText(r));
    loadAttention();
  }));
  $$('[data-allow]', list).forEach((b) => b.addEventListener('click', async () => {
    const it = res.items[Number(b.dataset.allow)];
    const reason = await askReason({
      title: `Let ${it.first} ${it.last} in?`,
      text: `For the next two hours, ${it.first} can sign in normally at the kiosk. Your name and the reason are saved with the record.`,
    });
    if (reason === null) return;
    const r = await adminApi('adminAllow', { visitId: it.visitId, reason });
    toast(r.ok ? `${it.first} can sign in now.` : errorText(r));
    loadAttention();
  }));
}

// ------------------------------------------------------------------ expected visitors

const expected = { day: '', list: [] };

function dayChoices() {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86400000);
    out.push([dayKey(d), i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })]);
  }
  return out;
}
function dayLabel(key, today) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const long = date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  if (key === today) return `Today · ${long}`;
  if (key === dayKey(Date.now() + 86400000)) return `Tomorrow · ${long}`;
  if (key < today) return `Yesterday · ${long}`;
  return long;
}

async function loadExpected() {
  const list = $('[data-expected-list]');
  $('[data-expected-new]').hidden = !can('expected');
  if (!can('expected')) { list.innerHTML = upsell('expected'); return; }
  $('[data-expected-hint]').textContent = MODE === 'cloud' && !CONFIG.BOX
    ? 'Visitors staff are expecting today and in the next two weeks. When they sign in, their company, host and purpose are filled in for them. Staff can also type rows straight into the Expected tab of your Google Sheet: a date, a first and last name, and anything else.'
    : 'Visitors staff are expecting today and in the next two weeks. When they sign in, their company, host and purpose are filled in for them.';
  list.innerHTML = '<div class="empty">Loading…</div>';
  const res = await adminApi('adminExpected', { days: 14 });
  if (!res.ok) { list.innerHTML = `<div class="empty">${esc(errorText(res))}</div>`; return; }
  expected.list = res.expected;
  updateExpectedCount(res);
  if (!res.expected.length) { list.innerHTML = '<div class="empty">Nobody expected yet. Tap “Add a visitor” to let the front desk know who\'s coming.</div>'; return; }
  let html = '', lastDay = '';
  res.expected.forEach((e, i) => {
    if (e.day !== lastDay) { html += `<p class="exp-day">${esc(dayLabel(e.day, res.today))}</p>`; lastDay = e.day; }
    const declined = /^declined/i.test(e.arrived);
    const status = e.arrived ? (declined ? ['declined', 'Declined'] : ['arrived', e.arrived.replace(/^Signed in /, 'Arrived ')]) : e.day < res.today ? ['retired', 'Didn\'t arrive'] : ['expected', 'Expected'];
    html += `<div class="admin-row exp-row">
      <span class="badge-no">${esc(initials(e))}</span>
      <div class="who"><strong>${esc(e.first)} ${esc(e.last)}</strong>
        <span class="meta">${[e.company, e.host && `visiting ${e.host}`, e.purpose].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</span>
        ${e.note ? `<span class="note-line">${esc(e.note)}</span>` : ''}</div>
      <span class="pill ${status[0]}">${esc(status[1])}</span>
      <div class="actions">${e.arrived ? '' : `<button type="button" data-unexpect="${i}">Remove</button>`}</div>
    </div>`;
  });
  list.innerHTML = html;
  fx.cascade(list, { step: 30 });
  $$('[data-unexpect]', list).forEach((b) => b.addEventListener('click', () => confirmTap(b, 'Tap again to remove', async () => {
    const r = await adminApi('adminRemoveExpected', { id: expected.list[Number(b.dataset.unexpect)].id });
    if (!r.ok) toast(errorText(r));
    loadExpected();
  })));
}

function updateExpectedCount(res) {
  const n = res.expected.filter((e) => e.day === res.today && !e.arrived).length;
  const c = $('[data-expected-count]');
  c.textContent = n;
  c.hidden = !n;
}

function renderExpectedForm() {
  $('[data-expected-day]').innerHTML = dayChoices().map(([key, label]) => `<button type="button" role="radio" data-value="${key}" class="${key === expected.day ? 'on' : ''}" aria-checked="${key === expected.day}">${esc(label)}</button>`).join('');
  const typed = $('input[name="e-host"]').value;
  const hits = typed ? hostMatches(typed) : settings().hosts.slice(0, 8);
  $('[data-expected-hosts]').innerHTML = hits.map((h) => `<button type="button" class="chip" data-host="${esc(h.name)}">${esc(h.name)}</button>`).join('');
}

$('[data-expected-new]').addEventListener('click', () => {
  const form = $('[data-expected-form]');
  form.hidden = false;
  $$('input', form).forEach((i) => { i.value = ''; i.classList.remove('invalid'); });
  $('[data-expected-error]').textContent = '';
  expected.day = dayKey();
  renderExpectedForm();
  kb.open($('input[name="e-first"]'));
});
$('[data-expected-cancel]').addEventListener('click', () => { kb.close(); $('[data-expected-form]').hidden = true; });
$('[data-expected-day]').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  expected.day = b.dataset.value;
  renderExpectedForm();
});
$('input[name="e-host"]').addEventListener('input', renderExpectedForm);
$('[data-expected-form]').addEventListener('input', () => { $('[data-expected-error]').textContent = ''; });
$('[data-expected-hosts]').addEventListener('click', (e) => {
  const b = e.target.closest('[data-host]');
  if (!b) return;
  $('input[name="e-host"]').value = b.dataset.host;
  renderExpectedForm();
  kb.open($('input[name="e-purpose"]'));
});
$('[data-expected-save]').addEventListener('click', async () => {
  const v = (n) => $(`input[name="e-${n}"]`).value.trim();
  const missing = ['first', 'last'].filter((n) => !v(n));
  if (missing.length) {
    $('[data-expected-error]').textContent = 'Enter the visitor\'s first and last name.';
    missing.forEach((n) => $(`input[name="e-${n}"]`).classList.add('invalid'));
    return;
  }
  kb.close();
  busy(true, 'Saving…');
  const res = await adminApi('adminAddExpected', { first: v('first'), last: v('last'), company: v('company'), host: v('host'), purpose: v('purpose'), note: v('note'), day: expected.day });
  busy(false);
  if (!res.ok) { $('[data-expected-error]').textContent = errorText(res); return; }
  $('[data-expected-form]').hidden = true;
  toast(`${v('first')} ${v('last')} added. The front desk will be ready for them.`);
  loadExpected();
});

// ------------------------------------------------------------------ admin history and export

const hist = { days: 7, q: '', visits: [] };
const HISTORY_SHOWN = 300;

async function loadHistory() {
  const list = $('[data-history-list]');
  const note = $('[data-history-note]');
  $$('[data-history-range] button').forEach((b) => {
    const on = Number(b.dataset.value) === hist.days;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('[data-export-visitors]').hidden = MODE === 'cloud';
  list.innerHTML = '<div class="empty">Loading…</div>';
  const res = await adminApi('adminHistory', { days: hist.days, q: hist.q });
  if (!res.ok) { list.innerHTML = `<div class="empty">${esc(errorText(res))}</div>`; note.textContent = ''; return; }
  hist.visits = res.visits;
  const span = { 1: 'today', 7: 'in the last 7 days', 30: 'in the last 30 days', 365: 'in the last year' }[hist.days];
  const n = res.visits.length;
  note.textContent = `${n ? n.toLocaleString() : 'No'} visit${n === 1 ? '' : 's'} ${span}${hist.q ? ` matching "${hist.q}"` : ''}.`
    + (n > HISTORY_SHOWN ? ` Showing the latest ${HISTORY_SHOWN}; the export has them all.` : '')
    + (MODE === 'cloud' ? ` ${CONFIG.BOX ? 'The Raspberry Pi or PC' : 'Your Google Sheet'} keeps every visit.` : '');
  if (!n) { list.innerHTML = '<div class="empty">Nothing to show.</div>'; return; }
  list.innerHTML = res.visits.slice(0, HISTORY_SHOWN).map((v) => {
    const declined = /^declined/i.test(v.kind || '') || /^declined/i.test(v.screening || '');
    const special = v.kind && v.kind !== 'Visitor';
    return `<div class="admin-row history-row">
      <span class="when"><strong>${esc(dayOf(v.signedIn))}</strong><span>${esc(clockOf(v.signedIn))}${v.signedOut && !declined ? `–${esc(clockOf(v.signedOut))}` : ''}</span></span>
      <div class="who"><strong>${esc(v.first)} ${esc(v.last)}</strong>
        <span class="meta">${esc(v.company)}${v.visiting ? ` · visiting ${esc(v.visiting)}` : ''}${v.purpose ? ` · ${esc(v.purpose)}` : ''}</span>
        ${v.signedOutBy && !declined && v.signedOutBy !== 'Badge tap at kiosk' && v.signedOutBy !== 'Signed out at kiosk' ? `<span class="meta">Signed out: ${esc(v.signedOutBy)}</span>` : ''}
        ${v.hostNotified ? `<span class="meta">Host emailed: ${esc(v.hostNotified)}</span>` : ''}</div>
      ${special ? `<span class="pill ${declined ? 'declined' : /override/i.test(v.kind) ? 'override' : 'foreign'}">${esc(v.kind)}</span>` : ''}
      ${v.badge ? `<span class="badge-no small">${esc(v.badge)}</span>` : ''}
      ${!v.signedOut ? '<span class="pill in-use">inside</span>' : ''}
      ${v.signedCopy ? `<div class="actions"><button type="button" data-signed="${esc(v.visitId)}">Signed copy</button></div>` : ''}
    </div>`;
  }).join('');
  fx.cascade(list, { step: 15 });
  $$('[data-signed]', list).forEach((b) => b.addEventListener('click', () => showSigned(b.dataset.signed)));
}

/** Shows what a visitor signed: the rules as they saw them and their signature (with Google Sheets, a QR code to the PDF). */
async function showSigned(visitId) {
  busy(true, 'One moment…');
  const res = await adminApi('adminSignature', { visitId });
  busy(false);
  if (!res.ok) { toast(res.error === 'not_found' ? 'No signed copy was found for that visit.' : errorText(res)); return; }
  $('[data-signed-title]').textContent = `${res.first} ${res.last}`;
  $('[data-signed-meta]').textContent = [res.company, res.when ? `signed ${new Date(res.when).toLocaleString()}` : '', res.language].filter(Boolean).join(' · ');
  const ag = res.agreement || null;
  $('[data-signed-rules]').innerHTML = ag ? ag.rules.map((r) => `<li>${esc(r)}</li>`).join('') : '';
  $('[data-signed-rules]').hidden = !ag;
  $('[data-signed-statement]').textContent = ag ? ag.statement : '';
  $('[data-signed-image]').src = res.signature || '';
  const link = $('[data-signed-link]');
  link.hidden = !res.signedCopy;
  if (res.signedCopy) link.innerHTML = `${await qrSvg(res.signedCopy, { size: 120, label: 'Link to the signed copy' })}<span>The full signed copy, with the rules as the visitor saw them, is a PDF in your Google Drive. Scan to open it on your phone:<br><code>${esc(res.signedCopy)}</code></span>`;
  $('[data-overlay="signed"]').hidden = false;
}
$('[data-signed-close]').addEventListener('click', () => { $('[data-overlay="signed"]').hidden = true; });

function dayOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function clockOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

$('[data-history-range]').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  hist.days = Number(b.dataset.value);
  loadHistory();
});
let historySearch = null;
$('input[name="h-search"]').addEventListener('input', (e) => {
  clearTimeout(historySearch);
  historySearch = setTimeout(() => { hist.q = e.target.value.trim(); loadHistory(); }, 450);
});

async function exportFile(name, text) {
  try {
    const where = await saveFile(name, text, 'text/csv');
    toast(`Saved ${name} to ${where}.`);
  } catch (err) {
    console.error(err);
    toast("Couldn't save the file on this tablet.");
  }
}

$('[data-export-visits]').addEventListener('click', () => {
  if (!requirePro('export')) return;
  const rows = hist.visits.map((v) => [
    v.signedIn ? new Date(v.signedIn).toLocaleString() : '', v.signedOut ? new Date(v.signedOut).toLocaleString() : '',
    v.first, v.last, v.company, v.visiting, v.purpose, v.kind, v.badge, v.method, v.signedOutBy, v.screening, v.hostNotified,
    /^https?:/.test(v.signedCopy || '') ? v.signedCopy : v.signedCopy ? 'Yes' : '',
  ]);
  if (!rows.length) { toast('No visits to export. Pick a longer period.'); return; }
  exportFile(`visits-${dateStamp()}.csv`, toCsv(['Signed in', 'Signed out', 'First name', 'Last name', 'Company', 'Visiting', 'Purpose', 'Kind', 'Badge', 'How they signed in', 'Signed out by', 'Screening', 'Host notified', 'Signed copy'], rows));
});

$('[data-export-visitors]').addEventListener('click', async () => {
  if (!requirePro('export')) return;
  const res = await adminApi('adminVisitors');
  if (!res.ok) { toast(errorText(res)); return; }
  const labels = [...new Set(res.visitors.flatMap((v) => v.answers.map((a) => a.label)))];
  const rows = res.visitors.map((v) => [
    v.first, v.last, v.company, v.visiting, v.purpose,
    ...labels.map((l) => (v.answers.find((a) => a.label === l) || {}).value || ''),
    v.registered ? new Date(v.registered).toLocaleString() : '', v.lastVisit, v.visits, v.quickEntry ? 'Yes' : 'No', v.screening,
  ]);
  if (!rows.length) { toast('No visitors yet.'); return; }
  exportFile(`visitors-${dateStamp()}.csv`, toCsv(['First name', 'Last name', 'Company', 'Visiting', 'Purpose', ...labels, 'Registered', 'Last visit', 'Visits', 'Quick entry', 'Screening'], rows));
});

// ------------------------------------------------------------------ emergency roll call

const roll = { items: [], seen: new Set(), run: 0 };

$('[data-rollcall-open]').addEventListener('click', async () => {
  kb.close();
  busy(true, 'Loading everyone inside…');
  const res = await adminApi('adminInside');
  busy(false);
  if (!res.ok) { toast(errorText(res)); return; }
  const run = ++roll.run;
  roll.items = res.inside.sort((a, b) => `${a.last} ${a.first}`.localeCompare(`${b.last} ${b.first}`));
  roll.seen = new Set();
  $('[data-rollcall-time]').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  renderRoll();
  $('[data-overlay="rollcall"]').hidden = false;
  // Faces help most here, so fetch each visitor's photo after the list is up.
  for (const it of roll.items) {
    if (run !== roll.run || $('[data-overlay="rollcall"]').hidden) return;
    const p = await api('adminPhoto', { token: state.adminToken, visitId: it.visitId });
    if (!p.ok) return;
    if (!p.photo) continue;
    it.photo = p.photo;
    const img = $(`[data-roll="${CSS.escape(it.visitId)}"] .roll-face`);
    if (img) img.outerHTML = `<img class="roll-face" src="${esc(p.photo)}" alt="">`;
  }
});

function renderRoll() {
  const total = roll.items.length;
  const done = roll.items.filter((it) => roll.seen.has(it.visitId)).length;
  $('[data-rollcall-done]').textContent = done;
  $('[data-rollcall-total]').textContent = total;
  $('[data-rollcall-progress]').style.width = `${total ? (done / total) * 100 : 100}%`;
  $('[data-overlay="rollcall"]').classList.toggle('all-done', total > 0 && done === total);
  const order = [...roll.items].sort((a, b) => roll.seen.has(a.visitId) - roll.seen.has(b.visitId));
  $('[data-rollcall-list]').innerHTML = total ? order.map((it) => {
    const seen = roll.seen.has(it.visitId);
    return `<button type="button" class="roll-card${seen ? ' seen' : ''}" data-roll="${esc(it.visitId)}" aria-pressed="${seen}">
      ${it.photo ? `<img class="roll-face" src="${esc(it.photo)}" alt="">` : `<span class="roll-face">${esc(initials(it))}</span>`}
      <span class="roll-who"><strong>${esc(it.first)} ${esc(it.last)}</strong>
        <span>${esc(it.company)}</span>
        <span>${it.visiting ? `Visiting ${esc(it.visiting)}` : ''}${it.badge ? `${it.visiting ? ' · ' : ''}Badge ${esc(it.badge)}` : ''}</span></span>
      <span class="roll-check" aria-hidden="true">✓</span>
    </button>`;
  }).join('') : '<div class="empty">Nobody is signed in right now.</div>';
}

$('[data-rollcall-list]').addEventListener('click', (e) => {
  const card = e.target.closest('[data-roll]');
  if (!card) return;
  const id = card.dataset.roll;
  if (roll.seen.has(id)) roll.seen.delete(id); else roll.seen.add(id);
  renderRoll();
});
$('[data-rollcall-close]').addEventListener('click', () => {
  if (roll.seen.size < roll.items.length && !$('[data-rollcall-close]').classList.contains('confirm')) {
    confirmTap($('[data-rollcall-close]'), `Tap again: ${roll.items.length - roll.seen.size} not accounted for`, () => {});
    return;
  }
  const close = $('[data-rollcall-close]');
  close.disabled = false;
  close.classList.remove('confirm');
  close.textContent = 'Close';
  roll.run++;
  $('[data-overlay="rollcall"]').hidden = true;
});

async function loadBadges() {
  const list = $('[data-badge-list]');
  list.innerHTML = '<div class="empty">Loading…</div>';
  const res = await adminApi('adminBadges');
  if (!res.ok) { list.innerHTML = `<div class="empty">${esc(errorText(res))}</div>`; return; }
  state.adminBadges = res.badges;
  if (!res.badges.length) { list.innerHTML = '<div class="empty">No badges yet. Tap “Add badge” and tap each badge card on the reader.</div>'; return; }
  const order = (b) => [String(b.badge).replace(/\d+/g, ''), Number((/\d+/.exec(b.badge) || [0])[0])];
  list.innerHTML = res.badges.slice().sort((a, b) => {
    const [pa, na] = order(a), [pb, nb] = order(b);
    return pa.localeCompare(pb) || na - nb;
  }).map((b) => {
    const status = String(b.status || 'available').toLowerCase();
    return `<div class="admin-row">
      <span class="badge-no">${esc(b.badge)}</span>
      <div class="who"><strong>${status === 'in use' ? esc(b.holder) : status === 'retired' ? 'Out of service' : status === 'not returned' ? esc(b.note || 'Not returned') : 'Available'}</strong>
        <span class="meta">${b.tag ? `NFC tag …${esc(String(b.tag).slice(-6))}` : 'No NFC tag linked'}${status === 'in use' ? ` · since ${esc(timeOf(b.since))}` : ''}${status === 'not returned' ? ' · signed out at the end of the day' : ''}</span></div>
      <span class="pill ${status.replace(' ', '-')}">${esc(status)}</span>
      <div class="actions">
        <button type="button" data-link="${esc(b.badge)}">${b.tag ? 'Relink tag' : 'Link tag'}</button>
        ${status === 'not returned' ? `<button type="button" data-restore="${esc(b.badge)}">Mark returned</button>` : ''}
        ${status === 'retired' ? `<button type="button" data-restore="${esc(b.badge)}">Restore</button>`
          : status === 'in use' ? '' : `<button type="button" data-retire="${esc(b.badge)}">${status === 'not returned' ? 'Lost: retire' : 'Retire'}</button>`}
      </div>
    </div>`;
  }).join('');
  fx.cascade(list, { step: 30 });
  $$('[data-link]', list).forEach((btn) => btn.addEventListener('click', () => {
    state.adminMode = { type: 'link', badge: btn.dataset.link };
    adminBanner(`Tap badge ${btn.dataset.link}'s card on the reader now.`, true);
  }));
  $$('[data-retire]', list).forEach((btn) => btn.addEventListener('click', () => confirmTap(btn, 'Tap again to retire', async () => {
    const r = await adminApi('adminRetireBadge', { badge: btn.dataset.retire });
    if (!r.ok) toast(errorText(r));
    loadBadges();
  })));
  $$('[data-restore]', list).forEach((btn) => btn.addEventListener('click', async () => {
    const r = await adminApi('adminRestoreBadge', { badge: btn.dataset.restore });
    if (!r.ok) toast(errorText(r));
    loadBadges();
  }));
}

$('[data-add-badge]').addEventListener('click', () => {
  state.adminMode = { type: 'add' };
  adminBanner('Tap a new badge card on the reader. It gets the next number (V1, V2, …). Keep tapping to add more.', true);
});

$('[data-add-pass]').addEventListener('click', async () => {
  const r = await adminApi('adminAddBadge', {});
  if (!r.ok) { toast(errorText(r)); return; }
  toast(`Added pass ${r.badge}. Label a pass to match.`);
  loadBadges();
});

function adminBanner(text, withStop) {
  const b = $('[data-admin-banner]');
  b.hidden = false;
  b.innerHTML = esc(text) + (withStop ? ' <button type="button" class="btn-ghost" data-stop-mode>Stop</button>' : '');
  const stop = $('[data-stop-mode]', b);
  if (stop) stop.addEventListener('click', () => { state.adminMode = null; b.hidden = true; });
}

async function adminTap(tag) {
  const mode = state.adminMode;
  if (mode?.type === 'add') {
    const r = await adminApi('adminAddBadge', { tag });
    if (!r.ok) { adminBanner(r.error === 'badge_exists' ? `Badge ${r.badge} already exists.` : errorText(r), true); return; }
    adminBanner(`Added badge ${r.badge}${r.movedFrom ? ` (tag moved from ${r.movedFrom})` : ''}. Tap the next new badge, or Stop.`, true);
    loadBadges();
    return;
  }
  if (mode?.type === 'link') {
    const r = await adminApi('adminLinkTag', { badge: mode.badge, tag });
    state.adminMode = null;
    adminBanner(r.ok ? `Linked the tag to badge ${mode.badge}${r.movedFrom ? ` (moved from ${r.movedFrom})` : ''}.` : errorText(r), false);
    loadBadges();
    return;
  }
  // No mode: tell the admin which badge this is.
  if (!state.adminBadges.length) {
    const res = await adminApi('adminBadges');
    if (res.ok) state.adminBadges = res.badges;
  }
  const b = state.adminBadges.find((x) => String(x.tag).toUpperCase() === tag);
  toast(b ? `That's badge ${b.badge}${b.holder ? `, held by ${b.holder}` : ''}.` : "That tag isn't linked to a badge.");
}

// ------------------------------------------------------------------ admin settings

const SETTING_ROWS = [
  ['company', 'Company and colors', (s) => [s.org.name, s.org.tagline].filter(Boolean).join(' · ')],
  ['admin', 'Admin login', (s) => `${s.admin.name || 'Admin'} · PIN set`],
  ['logo', 'Logo', (s) => (s.org.logo ? 'Your logo' : 'Text logo with your company name')],
  ['badges', 'Visitor badges', (s) => (s.badges ? 'Visitors tap an NFC/RFID badge' : 'No badges: sign in and out on screen')],
  ['screening', 'Screening questions', (s) => {
    const qs = activeQuestions(s);
    return qs.length ? `${qs.length} question${qs.length > 1 ? 's' : ''}: ${qs.map((q) => q.label).join(', ')}` : 'No extra questions';
  }],
  ['hosts', 'Hosts', (s) => (s.hosts.length
    ? `${s.hosts.length} ${s.hosts.length > 1 ? 'people' : 'person'}${MODE === 'cloud' && !CONFIG.BOX && s.notifyHosts && s.hosts.some((h) => h.email) ? ' · emailed when their visitor arrives' : ''}`
    : 'Nobody listed: visitors type any name')],
  ['touches', 'Photos, reasons, rules, records, end of day and languages', (s) => `Photos: ${{ all: 'every new visitor', declined: 'declined visitors only', off: 'off' }[s.photos]} · ${s.form.rules.length} rules · ${s.endOfDay ? `everyone signed out at ${timeLabel(s.endOfDay)}${MODE === 'cloud' && !CONFIG.BOX && s.dailySummary ? ', daily summary email' : ''}` : 'no automatic sign-out'} · ${s.languages.map((c) => LANGS[c]).join(', ')}`],
];

function loadSettingsPane() {
  renderDiagnostics();
  const s = settings();
  $('[data-settings-rows]').innerHTML = SETTING_ROWS.map(([step, title, sum]) => `
    <div class="set-row"><div><strong>${esc(title)}</strong><span>${esc(sum(s))}</span></div>
      <button type="button" data-edit="${step}">Edit</button></div>`).join('');
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => openSetup({ edit: b.dataset.edit, token: state.adminToken })));
  const info = $('[data-storage-info]');
  const actions = $('[data-storage-actions]');
  const secret = $('[data-connect-link]');
  secret.hidden = true;
  $('[data-connect-qr]').hidden = true;
  renderPlanCard();
  renderPhoneCard();
  if (MODE === 'cloud' && CONFIG.BOX) {
    info.textContent = `Every sign-in, photo and badge is kept on your Raspberry Pi or PC${state.lastPing?.sheetName ? ` ("${state.lastPing.sheetName}")` : ''}, which phones and this screen reach through your website. Keep it switched on and connected to the internet.`;
    actions.innerHTML = '<button type="button" class="btn-secondary" data-connect-another>Connect another tablet</button>';
    $('[data-connect-another]', actions)?.addEventListener('click', (e) => { const btn = e.currentTarget; confirmTap(btn, 'Tap again to show the private link', async () => {
      secret.hidden = false;
      secret.innerHTML = `Open this link on the other tablet or computer: it connects to the same Raspberry Pi or PC.<br><code>${esc(location.origin + location.pathname)}?api=${esc(encodeURIComponent(CONFIG.API_URL))}&amp;key=${esc(encodeURIComponent(CONFIG.KIOSK_KEY))}</code>`;
    }); });
  } else if (MODE === 'cloud') {
    info.textContent = `Every sign-in goes to your Google Sheet${CONFIG.BUILT_IN ? ' (built into this app)' : ''}. Visitor photos are in your Google Drive.`
      + (state.oldBackend ? ' Your Apps Script code is out of date: copy the latest script into it and deploy a new version.' : '');
    actions.innerHTML = `${CONFIG.BUILT_IN ? '' : '<button type="button" class="btn-secondary" data-connect-another>Connect another tablet</button>'}
      <button type="button" class="btn-secondary" data-copy-latest>Copy the latest Apps Script code</button>`;
    $('[data-connect-another]', actions)?.addEventListener('click', (e) => { const btn = e.currentTarget; confirmTap(btn, 'Tap again to show the private link', async () => {
      const link = `${location.origin}${location.pathname}?api=${encodeURIComponent(CONFIG.API_URL)}&key=${encodeURIComponent(CONFIG.KIOSK_KEY)}`;
      secret.hidden = false;
      secret.innerHTML = `Scan this code with the other tablet's camera, or open the link on it once. It connects to the same sheet and settings. Keep it private: it works like a password.<br><code>${esc(link)}</code>`;
      const qr = $('[data-connect-qr]');
      qr.hidden = false;
      qr.innerHTML = `${await qrSvg(link, { size: 200, label: 'Link to connect another tablet' })}<span class="small">Android: open the camera app and point it at the code, then open the link in the kiosk's browser. With the Android app, build it with the connection instead (android/README.md).</span>`;
      btn.disabled = false;
    }); });
    $('[data-copy-latest]', actions).addEventListener('click', async () => {
      const { BACKEND_CODE } = await import('./backend-code.js');
      try { await navigator.clipboard.writeText(BACKEND_CODE); toast('Copied. Paste it over the code in Apps Script, then deploy a new version.'); } catch { toast("Copying isn't allowed here. Use apps-script/Code.gs from the project instead."); }
    });
  } else {
    info.textContent = DEMO ? 'Demo mode: sample data, kept only in this browser.'
      : 'Records and photos are kept privately on this tablet. To switch to Google Sheets, choose "Start over" and pick Google Sheets (records already on this tablet stay here).';
    actions.innerHTML = '';
  }
}

// ------------------------------------------------------------------ diagnostics

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`);

/** What a support person would ask first, on one card. */
async function renderDiagnostics() {
  const box = $('[data-diagnostics]');
  const rows = [];
  const add = (k, v, warn = false) => rows.push(`<dt>${esc(k)}</dt><dd class="${warn ? 'warn' : ''}">${esc(v)}</dd>`);
  add('App version', `${APP_VERSION}${Kiosk ? ' · Android app' : ' · browser'}`);
  if (MODE === 'cloud') {
    await refreshAttention();
    const p = state.lastPing;
    const where = CONFIG.BOX ? 'Raspberry Pi or PC' : 'Google Sheets';
    add('Records', p?.sheetName ? `${where}: "${p.sheetName}"` : where);
    add('Connection', p && Date.now() - p.at < 60000 ? `Connected · checked ${ago(p.at)}` : `Can't reach the ${CONFIG.BOX ? 'Raspberry Pi or PC (is it on, and online?)' : 'Google Sheet'} right now`, !(p && Date.now() - p.at < 60000));
    const v = p?.version || 1;
    add(CONFIG.BOX ? 'Server version' : 'Apps Script version', v < BACKEND_VERSION ? `${v} · update needed (copy the latest code, deploy a new version)` : `${v} · up to date`, v < BACKEND_VERSION);
    const waiting = pendingCount();
    add('Waiting to send', waiting ? `${waiting} item${waiting > 1 ? 's' : ''} (sent automatically when the connection is back)` : 'Nothing', waiting > 10);
  } else {
    add('Records', DEMO ? 'Demo mode: nothing is kept' : 'On this tablet');
  }
  try {
    const est = await navigator.storage?.estimate?.();
    const kept = await navigator.storage?.persisted?.();
    if (est) add('Storage', `${mb(est.usage || 0)} used of ${mb(est.quota || 0)}${MODE === 'cloud' ? '' : kept ? ' · kept permanently' : ' · the browser may clear it if space runs low'}`, MODE !== 'cloud' && !kept && !Kiosk);
  } catch { /* not available */ }
  add('Badge reader', !settings().badges ? 'Not used' : state.lastTapAt ? `Last card read ${ago(state.lastTapAt)}` : 'No card read since the kiosk started. Tap one now: it says which badge it is.');
  let cam = 'Not checked';
  try { cam = (await navigator.permissions.query({ name: 'camera' })).state; } catch { /* not supported */ }
  add('Camera', settings().photos === 'off' && !quickOn() ? 'Not used' : { granted: 'Allowed', denied: 'Blocked: allow the camera for this site or app', prompt: 'Will ask the first time a visitor takes a photo' }[cam] || cam, cam === 'denied');
  add('Quick entry', quickOn() ? (face.modelsLoaded ? 'Face recognition ready' : 'Face recognition loading…') : 'Off');
  add('Offline start-up', Kiosk ? 'Built into the app' : navigator.serviceWorker?.controller ? 'Ready: the kiosk opens even without Wi-Fi' : 'Not active (needs an HTTPS address)', !Kiosk && !navigator.serviceWorker?.controller);
  add('Screen', `${innerWidth} × ${innerHeight}${document.documentElement.classList.contains('lite') ? ' · light effects for this tablet' : ''}`);
  if (PAYWALL.enabled) add('License', `${planLine()} · tablet ${tabletCode()}`, ['paused', 'grace'].includes(entitlement().status));
  box.innerHTML = rows.join('');
  checkForUpdate();
}
$('[data-diag-refresh]').addEventListener('click', renderDiagnostics);
$('[data-run-checks]').addEventListener('click', () => openSetup({ edit: 'device', token: state.adminToken }));

// ------------------------------------------------------------------ updates

let latest = null;
const newer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
/** The newest version from the website (latest.json), in the shape of a GitHub release; null if unavailable. */
async function siteRelease() {
  if (!CONFIG.SITE_URL) return null;
  try {
    const res = await fetch(`${CONFIG.SITE_URL.replace(/\/?$/, '/')}latest.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    const l = await res.json();
    if (!l?.version) return null;
    // The Android app updates to the newest app on the website; a browser kiosk to the newest kiosk.
    const version = Kiosk ? (l.apk ? l.apk.version || l.version : '0') : l.version;
    return { tag_name: `v${version}`, html_url: l.page || CONFIG.SITE_URL, assets: l.apk ? [{ name: l.apk.name, size: l.apk.size, browser_download_url: l.apk.url }] : [] };
  } catch { return null; }
}
/** Asks the website (or GitHub) for the newest version, once per session, and offers it in Diagnostics. */
async function checkForUpdate() {
  const box = $('[data-update-box]');
  if (!CONFIG.SITE_URL && !CONFIG.UPDATES_FROM) return;
  if (!latest) latest = await siteRelease();
  if (!latest && CONFIG.UPDATES_FROM) {
    try {
      const res = await fetch(`https://api.github.com/repos/${CONFIG.UPDATES_FROM}/releases/latest`, { cache: 'no-store' });
      if (!res.ok) return;
      latest = await res.json();
    } catch { return; }
  }
  if (!latest) return;
  if (!latest?.tag_name || !newer(latest.tag_name, APP_VERSION)) { box.hidden = true; return; }
  const version = latest.tag_name.replace(/^v/, '');
  const apk = (latest.assets || []).find((a) => /\.apk$/i.test(a.name));
  const url = Kiosk && apk ? apk.browser_download_url : latest.html_url;
  box.hidden = false;
  box.innerHTML = `${await qrSvg(url, { size: 120, label: 'Link to the new version' })}<div><strong>Version ${esc(version)} is available.</strong><br>${Kiosk
    ? 'Scan the code (or open the link) on this tablet to download the new app, then install it over this one. Your settings stay.'
    : 'This kiosk picks it up by itself the next time it loads (it reloads every night).'}<br><code>${esc(url)}</code>${Kiosk ? '' : '<br><button type="button" class="btn-secondary" data-reload-now>Load it now</button>'}</div>`;
  $('[data-reload-now]', box)?.addEventListener('click', () => location.reload());
}

// ------------------------------------------------------------------ phone sign-in (a QR code by the door)

const POINT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newPointCode = () => {
  const c = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => POINT_ALPHABET[x % 32]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};
/** Where this kiosk is on the web, for the QR code: PUBLIC_URL, the address it's open at, or (the Android app) the website's kiosk. */
function kioskWebAddress() {
  if (CONFIG.PUBLIC_URL) return CONFIG.PUBLIC_URL.replace(/\/?$/, '/');
  if (Kiosk || !/^https?:$/.test(location.protocol)) return CONFIG.SITE_URL ? `${CONFIG.SITE_URL.replace(/\/?$/, '/')}web/` : '';
  return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
}
const phoneLink = (key) => `${kioskWebAddress()}?visit=${encodeURIComponent(key)}&api=${encodeURIComponent(CONFIG.API_URL)}`;

/** Admin → Settings → Phone sign-in: switch it on, the QR code and poster, a new code, off. Google Sheets only. */
async function renderPhoneCard() {
  const card = $('[data-phone-card]');
  card.hidden = MODE !== 'cloud';
  if (card.hidden) return;
  const text = $('[data-phone-text]'), qr = $('[data-phone-qr]'), actions = $('[data-phone-actions]');
  const res = await adminApi('adminPhoneLink', { peek: true });
  qr.hidden = true;
  $('[data-phone-license]').hidden = true;
  if (!res.ok) { text.textContent = errorText(res); actions.innerHTML = ''; return; }
  if (!res.key) {
    text.textContent = `No tablet by the door? Put up a QR code: visitors scan it and sign in on their own phone, with the same questions, rules and photo, and the sign-ins go to ${CONFIG.BOX ? 'your Raspberry Pi or PC' : 'your Google Sheet'}. `
      + 'Phones can only sign visitors in and out: they never see other visitors, your staff list or anything on this admin screen.';
    actions.innerHTML = '<button type="button" class="btn-primary" data-phone-on>Switch on phone sign-in</button>';
    $('[data-phone-on]', actions).addEventListener('click', () => phoneLinkAction({}));
    return;
  }
  const s = settings();
  let licensed = '';
  if (PAYWALL.enabled) {
    $('[data-phone-license]').hidden = false;
    if (!s.phone.license) licensed = 'no license yet (the trial applies)';
    else {
      try {
        const info = await verifyLicense(s.phone.license, PAYWALL.publicKey, s.phone.code);
        licensed = info.expires ? `licensed until ${info.expires}` : 'licensed';
      } catch (err) { licensed = err.message; }
    }
  }
  const web = kioskWebAddress();
  text.textContent = `Phone sign-in is on${PAYWALL.enabled ? ` · QR code ${s.phone.code} · ${licensed}` : ''}. `
    + (web ? 'Print the poster and put it by the door. Visitors who sign in on their phone sign out on it, or at the front desk.'
      : "To make its QR code, open this admin screen in the browser kiosk, or set the kiosk's web address (PUBLIC_URL in web/config.js).");
  actions.innerHTML = `${web ? '<button type="button" class="btn-primary" data-phone-poster>Print the poster</button>' : ''}
    <button type="button" class="btn-secondary" data-phone-change>Change the QR code</button>
    <button type="button" class="btn-ghost" data-phone-off>Switch off</button>`;
  if (web) {
    const link = phoneLink(res.key);
    qr.hidden = false;
    qr.innerHTML = `${await qrSvg(link, { size: 170, label: 'Phone sign-in link' })}<code>${esc(link)}</code>`;
    $('[data-phone-poster]', actions).addEventListener('click', () => openPoster(link));
  }
  $('[data-phone-change]', actions).addEventListener('click', (e) => confirmTap(e.currentTarget, 'Tap again: printed posters stop working', () => phoneLinkAction({ change: true })));
  $('[data-phone-off]', actions).addEventListener('click', (e) => confirmTap(e.currentTarget, 'Tap again to switch off', () => phoneLinkAction({ off: true })));
}

async function phoneLinkAction(args) {
  busy(true, 'One moment…');
  const res = await adminApi('adminPhoneLink', args);
  // The QR code is licensed like a kiosk, so it gets its own code the first time.
  if (res.ok && res.key && !settings().phone.code) await savePhoneSettings({ code: newPointCode(), license: '' });
  busy(false);
  if (!res.ok) { toast(errorText(res)); return; }
  toast(args.off ? 'Phone sign-in is off: the QR code no longer works.'
    : args.change ? 'A new QR code: print the new poster. The old one no longer works.' : 'Phone sign-in is on. Print the poster.', 6000);
  renderPhoneCard();
}

const savePhoneSettings = (phone) => saveSettingsAsAdmin({ ...settings(), phone });

/** Saves changed settings from the admin screen (the logo stays as it is). */
async function saveSettingsAsAdmin(next) {
  const toSave = JSON.parse(JSON.stringify(next));
  toSave.org.logo = '';
  const res = await adminApi('adminSaveSettings', { settings: toSave });
  if (res.ok) useSettings(next, { cache: MODE === 'cloud' });
  return res;
}

$('[data-phone-license-apply]').addEventListener('click', async () => {
  const err = $('[data-phone-license-error]');
  err.textContent = '';
  const key = $('input[name="phone-license"]').value.trim();
  try { await verifyLicense(key, PAYWALL.publicKey, settings().phone.code); } catch (e) { err.textContent = e.message; return; }
  busy(true, 'Saving…');
  const res = await savePhoneSettings({ ...settings().phone, license: key });
  busy(false);
  if (!res.ok) { err.textContent = errorText(res); return; }
  $('input[name="phone-license"]').value = '';
  toast('License added for the QR code.');
  renderPhoneCard();
});

// The poster: print it, or save it as an image to print elsewhere.
let posterLink = '';
async function openPoster(link) {
  posterLink = link;
  $('[data-poster-qr]').innerHTML = await qrSvg(link, { size: 340, label: 'Scan to sign in' });
  $('[data-overlay="poster"]').hidden = false;
}
$('[data-poster-close]').addEventListener('click', () => { $('[data-overlay="poster"]').hidden = true; });
$('[data-poster-print]').addEventListener('click', () => {
  document.body.classList.add('printing-poster');
  window.print();
  setTimeout(() => document.body.classList.remove('printing-poster'), 1000);
});
$('[data-poster-save]').addEventListener('click', async () => {
  try {
    const where = await saveFile('visitor-sign-in-poster.svg', await posterSvg(posterLink), 'image/svg+xml');
    toast(`Poster saved to ${where}. Open it there to print.`, 6000);
  } catch { toast("The poster couldn't be saved here."); }
});

/** The poster as a letter-size SVG image: logo, title, the QR code and how to use it. */
async function posterSvg(link) {
  const s = settings();
  const qr = await qrSvg(link, { size: 480, label: 'Scan to sign in' });
  const qrData = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(qr)))}`;
  const logo = logoFor(s);
  const text = (y, size, value, color = '#0d1b2a', weight = 400) => `<text x="425" y="${y}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${esc(value)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="850" height="1100" viewBox="0 0 850 1100">
  <rect width="850" height="1100" fill="#ffffff"/>
  <image href="${logo}" xlink:href="${logo}" x="225" y="70" width="400" height="140" preserveAspectRatio="xMidYMid meet"/>
  ${text(290, 64, 'Visitor sign-in', '#0d1b2a', 700)}
  ${text(345, 32, s.org.name, '#4a5a6b')}
  <image href="${qrData}" xlink:href="${qrData}" x="185" y="400" width="480" height="480"/>
  ${text(950, 30, "Open your phone's camera and point it at the code.")}
  ${text(995, 26, 'Iniciar sesión: escanee el código con la cámara.', '#4a5a6b')}
</svg>`;
}

// ------------------------------------------------------------------ plans (only with the paywall switched on)

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function planLine() {
  const e = entitlement();
  const who = e.license?.customer || 'this business';
  if (e.status === 'licensed') return e.license.expires ? `Licensed to ${who}, paid until ${e.license.expires}` : `Licensed to ${who}`;
  if (e.status === 'grace') return `Renewal overdue: the license ended on ${e.license.expires}. New sign-ins pause on ${e.until}`;
  if (e.status === 'trial') return `Trial: ${plural(e.daysLeft, 'day')} left`;
  if (e.status === 'paused') {
    if (e.reason === 'off') return 'Switched off by the seller: new sign-ins are paused';
    if (e.reason === 'lapsed') return `The license ended on ${e.license.expires}: new sign-ins are paused`;
    return 'The trial has ended: new sign-ins are paused';
  }
  return '';
}

/** A reminder for the admin screen, or ''. */
function licenseNotice() {
  const e = entitlement();
  if (!PAYWALL.enabled) return '';
  if (e.status === 'paused') return `${planLine()}. Signing out, the roll call and exports still work. Settings → License to renew.`;
  if (e.status === 'grace') return `${planLine()}. Settings → License.`;
  if (!agreementAccepted(settings())) return 'Please read and accept the license agreement: Settings → License → License agreement.';
  if (e.status === 'licensed' && e.renewSoon) return `This kiosk's license is due for renewal on ${e.license.expires} (${plural(e.daysLeft, 'day')}). Settings → License.`;
  if (e.status === 'trial' && e.daysLeft <= 7) return `The trial ends in ${plural(e.daysLeft, 'day')}. Settings → License.`;
  return '';
}

function sellerLine() {
  const bits = [PAYWALL.seller, PAYWALL.supportEmail, PAYWALL.supportPhone].filter(Boolean);
  return bits.length ? `Contact ${bits.join(' · ')}` : '';
}

// The license may have changed (a key added, settings imported): read the status file and work it out again.
document.addEventListener('kiosk-license-changed', () => {
  checkStatus().then(() => {
    applySettings();
    renderPaused();
    if (state.screen === 'admin') renderPlanCard();
  }).catch(() => {});
});

/** While paused, the welcome screen asks visitors to see the front desk; signing out and badge returns still work. */
function renderPaused() {
  const paused = isPaused() || !!state.phoneDown;
  screenEl('welcome').classList.toggle('paused', paused);
  $('[data-paused]').hidden = !paused;
  if (state.phoneDown) $('[data-paused-staff]').textContent = t("This sign-in link isn't working. Please see the front desk.");
  else if (paused) $('[data-paused-staff]').textContent = [`Kiosk license: ${planLine().split(':')[0]}`, `${PHONE ? 'QR code' : 'Tablet'} ${tabletCode()}`, sellerLine()].filter(Boolean).join(' · ');
}

function renderPlanCard() {
  const card = $('[data-plan-card]');
  card.hidden = !PAYWALL.enabled;
  if (!PAYWALL.enabled) return;
  const e = entitlement();
  $('[data-plan-text]').innerHTML = `<strong>${esc(planLine())}</strong>${e.error ? `<br><span class="warn">${esc(e.error)}</span>` : ''}`
    + `<br>Tablet code: <strong>${esc(tabletCode())}</strong>${sellerLine() ? `<br>${esc(sellerLine())}` : ''}`
    + '<br>Signing out, records, exports and the roll call always keep working, even without a license.'
    + `<br>${esc(agreementLine())}`;
  $('[data-agreement-open]').textContent = agreementAccepted(settings()) ? 'License agreement' : 'Read and accept the license agreement';
}

function agreementLine() {
  const ag = settings().agreement;
  if (agreementAccepted(settings())) return `License agreement (version ${ag.version}) accepted by ${ag.by} on ${new Date(ag.at).toLocaleDateString()}.`;
  return ag.by ? `An updated license agreement (version ${AGREEMENT_VERSION}) needs accepting.` : "The license agreement hasn't been accepted on this kiosk yet.";
}

/** The license agreement: to read, and to accept when this kiosk hasn't accepted the current version. */
function openAgreement() {
  const s = settings();
  const need = PAYWALL.enabled && !agreementAccepted(s);
  $('[data-ag-title]').textContent = AGREEMENT_TITLE;
  $('[data-ag-version]').textContent = AGREEMENT_VERSION;
  $('[data-ag-status]').textContent = agreementAccepted(s) ? ` · accepted by ${s.agreement.by} on ${new Date(s.agreement.at).toLocaleDateString()}` : '';
  $('[data-ag-text]').innerHTML = agreementHtml(s.org.name);
  $('[data-ag-company]').textContent = s.org.name || 'your business';
  $('[data-ag-accept]').hidden = !need;
  $('[data-ag-agree]').hidden = !need;
  $('input[name="ag-name"]').value = '';
  $('[data-ag-error]').textContent = '';
  $('[data-overlay="agreement"]').hidden = false;
}
$('[data-agreement-open]').addEventListener('click', openAgreement);
$('[data-ag-close]').addEventListener('click', () => { kb.close(); $('[data-overlay="agreement"]').hidden = true; });
$('[data-ag-agree]').addEventListener('click', async () => {
  const who = $('input[name="ag-name"]').value.trim();
  if (!who) { $('[data-ag-error]').textContent = 'Type your name to accept it.'; return; }
  busy(true, 'Saving…');
  const res = await saveSettingsAsAdmin({ ...settings(), agreement: { version: AGREEMENT_VERSION, by: who, at: new Date().toISOString() } });
  busy(false);
  if (!res.ok) { $('[data-ag-error]').textContent = errorText(res); return; }
  kb.close();
  $('[data-overlay="agreement"]').hidden = true;
  toast('License agreement accepted.');
  renderPlanCard();
});

/** Has the feature, or shows what Pro adds and how to get it. */
function requirePro(feature) {
  if (can(feature)) return true;
  openUpgrade(feature);
  return false;
}

function upsell(feature) {
  return `<div class="empty"><strong>${esc(FEATURES[feature])} is part of Visitor Sign-In Pro.</strong><br>
    <button type="button" class="btn-primary" onclick="document.dispatchEvent(new CustomEvent('kiosk-upgrade', { detail: '${feature}' }))">See Pro</button></div>`;
}
document.addEventListener('kiosk-upgrade', (e) => openUpgrade(e.detail));

let scanStop = null;
async function openUpgrade(feature) {
  const ov = $('[data-overlay="upgrade"]');
  const e = entitlement();
  $('[data-upgrade-title]').textContent = "This tablet's license";
  $('[data-upgrade-text]').textContent = `${planLine()}.${PAYWALL.price ? ` ${PAYWALL.price}, with every feature, updates and support.` : ''}`;
  $('[data-tablet-code]').textContent = tabletCode();
  $('[data-upgrade-seller]').textContent = sellerLine();
  const buy = $('[data-upgrade-buy]');
  buy.hidden = !PAYWALL.buyUrl;
  if (PAYWALL.buyUrl) {
    $('[data-upgrade-qr]').innerHTML = await qrSvg(PAYWALL.buyUrl, { size: 150, label: 'Link to buy or renew' });
    $('[data-upgrade-url]').textContent = PAYWALL.buyUrl;
  }
  $('input[name="license"]').value = '';
  $('[data-upgrade-error]').textContent = e.error || '';
  $('[data-license-scan]').hidden = !('BarcodeDetector' in window);
  ov.hidden = false;
}
function closeUpgrade() {
  scanStop?.();
  kb.close();
  $('[data-overlay="upgrade"]').hidden = true;
}
$('[data-upgrade-close]').addEventListener('click', closeUpgrade);
$('[data-plan-open]').addEventListener('click', () => openUpgrade(''));
$('[data-license-paste]').addEventListener('click', async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) $('input[name="license"]').value = text;
  } catch { $('[data-upgrade-error]').textContent = "Pasting isn't allowed here. Type the key, scan its QR code, or open the license link on this tablet."; }
});
$('[data-license-scan]').addEventListener('click', async () => {
  const video = $('[data-video="license"]');
  try {
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    await face.startCamera(video);
    video.hidden = false;
    let on = true;
    scanStop = () => { on = false; video.hidden = true; face.stopCamera(); scanStop = null; };
    while (on) {
      const codes = await detector.detect(video).catch(() => []);
      const hit = codes.map((c) => c.rawValue).find((v) => /VSI1\./.test(v));
      if (hit) { $('input[name="license"]').value = /VSI1\.[\w.-]+/.exec(hit)[0]; scanStop?.(); break; }
      await sleep(300);
    }
  } catch { $('[data-upgrade-error]').textContent = "The camera couldn't scan here. Type or paste the key instead."; scanStop?.(); }
});
$('[data-upgrade-apply]').addEventListener('click', () => applyLicense($('input[name="license"]').value));

/** Checks a license key and keeps it on this tablet (each tablet has its own key). */
async function applyLicense(key) {
  const err = $('[data-upgrade-error]');
  err.textContent = '';
  let info;
  try { info = await verifyLicense(key, PAYWALL.publicKey, tabletCode()); } catch (e) { err.textContent = e.message; return false; }
  saveKey(key);
  await refreshPlan();
  applySettings();
  renderPaused();
  closeUpgrade();
  if (state.screen === 'admin') loadSettingsPane();
  toast(`License added: ${info.customer || 'this business'}${info.expires ? `, paid until ${info.expires}` : ''}.`, 6000);
  checkStatus().then(renderPaused);
  return true;
}

$('[data-export-settings]').addEventListener('click', async () => {
  const { exportable } = await import('./settings.js');
  const name = `${(settings().org.name || 'kiosk').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-kiosk-settings.json`;
  try {
    const where = await saveFile(name, JSON.stringify(exportable(), null, 2), 'application/json');
    toast(`Settings saved to ${where} as ${name}.`);
  } catch { toast("Couldn't save the file on this tablet."); }
});

$('[data-start-over]').addEventListener('click', (e) => confirmTap(e.currentTarget, 'Tap again: this tablet starts setup again', async () => {
  const { forgetLocal } = await import('./settings.js');
  const { eraseTablet } = await import('./api.js');
  const { forgetConnection } = await import('../config.js');
  if (MODE !== 'cloud') await eraseTablet();
  forgetLocal();
  if (!CONFIG.BUILT_IN) forgetConnection();
  location.replace(location.pathname);
}));

/** Destructive buttons need a second tap within 3 s (no browser dialogs on a kiosk). */
function confirmTap(btn, label, action) {
  if (btn.classList.contains('confirm')) { btn.disabled = true; action(); return; }
  const text = btn.textContent;
  btn.classList.add('confirm');
  btn.textContent = label;
  setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = text; }, 3000);
}

function timeOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString([], today ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ------------------------------------------------------------------ idle timeout, clock, upkeep

let idleCountdown = null;
$('[data-idle-stay]').addEventListener('click', () => { stopIdle(); touch(); });
function stopIdle() {
  clearInterval(idleCountdown);
  idleCountdown = null;
  $('[data-overlay="idle"]').hidden = true;
}

setInterval(() => {
  if (state.busy || idleCountdown) return;
  const idle = Date.now() - state.lastTouch;
  if (state.screen === 'welcome' || state.screen === 'setup') return;
  if (state.screen === 'admin') { if (idle > 3 * 60 * 1000 && $('[data-overlay="rollcall"]').hidden) exitAdmin(); return; }
  if (state.screen === 'done') { if (idle > 15 * 1000) show('welcome'); return; }
  if (state.screen === 'declined') { if (idle > 45 * 1000 && $('[data-overlay="pin"]').hidden && $('[data-overlay="reason"]').hidden) show('welcome'); return; }
  const limit = (state.screen === 'badge' ? CONFIG.BADGE_IDLE_MS : CONFIG.IDLE_MS) * (PHONE ? 4 : 1);
  if (idle < limit) return;
  let n = 10;
  $('[data-idle-count]').textContent = n;
  $('[data-overlay="idle"]').hidden = false;
  idleCountdown = setInterval(() => {
    n -= 1;
    $('[data-idle-count]').textContent = n;
    if (n <= 0) { stopIdle(); $('[data-overlay="reason"]').hidden = true; $('[data-overlay="pin"]').hidden = true; show('welcome'); }
  }, 1000);
}, 1000);

const loadedAt = Date.now();
setInterval(() => {
  tickClock();
  const h = new Date().getHours();
  const quiet = state.screen === 'welcome' && Date.now() - state.lastTouch > 60 * 1000 && $('[data-overlay="signout"]').hidden;
  if (h === CONFIG.NIGHTLY_RELOAD_HOUR && quiet && Date.now() - loadedAt > 2 * 3600 * 1000) location.reload();
  if (state.updateReady && quiet) location.reload();
}, 15 * 1000);
setInterval(() => { if (state.screen === 'welcome') { refreshFaceIndex(); refreshCloudSettings(); } }, 5 * 60 * 1000);
setInterval(() => { if (state.screen === 'welcome') refreshAttention(); }, 2 * 60 * 1000);

// ------------------------------------------------------------------ end-of-day sign-out

const EOD_KEY = 'kiosk-eod-last';

/** The latest end-of-day time that has already passed (today's, or yesterday's). */
function lastCutoff(hhmm, now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number);
  const c = new Date(now);
  c.setHours(h, m, 0, 0);
  if (c > now) c.setDate(c.getDate() - 1);
  return c;
}

let eodRunning = false;
async function endOfDayCheck() {
  const s = settings();
  if (!s.setupComplete || !s.endOfDay || eodRunning) return;
  const cutoff = lastCutoff(s.endOfDay);
  let last = 0;
  try { last = Number(localStorage.getItem(EOD_KEY)) || 0; } catch { /* private mode */ }
  if (last >= cutoff.getTime()) return;
  eodRunning = true;
  try {
    const res = await api('endOfDay', { before: cutoff.toISOString(), summary: last > 0 });
    if (res.ok) {
      try { localStorage.setItem(EOD_KEY, String(cutoff.getTime())); } catch { /* runs again next time */ }
      if (res.signedOut && state.screen === 'admin') toast(`End of day: ${res.signedOut} visitor${res.signedOut > 1 ? 's' : ''} signed out.`);
    }
  } finally {
    eodRunning = false;
  }
}
if (!PHONE) setInterval(endOfDayCheck, 60 * 1000);

// ------------------------------------------------------------------ deleting old records

const PURGE_KEY = 'kiosk-purge-day';
async function retentionCheck() {
  const s = settings();
  if (!s.setupComplete || !s.retentionDays || DEMO) return;
  let last = '';
  try { last = localStorage.getItem(PURGE_KEY) || ''; } catch { /* private mode */ }
  if (last === dayKey()) return;
  const res = await api('purgeOld');
  if (res.ok) { try { localStorage.setItem(PURGE_KEY, dayKey()); } catch { /* runs again later */ } }
}
if (!PHONE) setInterval(() => { if (state.screen === 'welcome') retentionCheck(); }, 10 * 60 * 1000);

// Keep the screen awake where the browser allows it.
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); wakeLock?.addEventListener('release', () => { wakeLock = null; }); } catch { /* not allowed here */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
document.addEventListener('pointerdown', () => { touch(); keepAwake(); }, true);
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Small "Offline" pill whenever the backend can't be reached.
window.addEventListener('kiosk-net', (e) => { $('[data-net]').hidden = e.detail.ok; });

// Older, slower tablets: skip the expensive blur effects (also forced with ?lite).
if (new URLSearchParams(location.search).has('lite')
  || (navigator.deviceMemory && navigator.deviceMemory <= 2)
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)) {
  document.documentElement.classList.add('lite');
}

// ------------------------------------------------------------------ demo helper

if (DEMO) {
  const panel = $('[data-demo]');
  panel.hidden = false;
  const taps = $('[data-demo-taps]');
  const tags = [1, 2, 3, 4, 5].map((n) => [`Tap V${n}`, `DEMO000${n}`]);
  tags.push(['Tap a new card', null]);
  taps.innerHTML = tags.map(([label], i) => `<button type="button" data-demo-tap="${i}">${label}</button>`).join('');
  taps.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-demo-tap]');
    if (!b) return;
    const [, tag] = tags[Number(b.dataset.demoTap)];
    onTap(tag || `NEW${Math.random().toString(16).slice(2, 10).toUpperCase()}`, 0);
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
}

// ------------------------------------------------------------------ start

/** Settings saved in the Google Sheet win, so every tablet on the same sheet looks the same. */
async function refreshCloudSettings() {
  if (MODE !== 'cloud') return false;
  const res = await api('getSettings');
  if (!res.ok || !res.settings) return false;
  useSettings({ ...res.settings, storage: 'cloud', org: { ...res.settings.org, logo: res.logo || '' } }, { cache: true });
  await refreshPlan().catch(() => {});
  applySettings();
  return true;
}

function startKiosk() {
  applySettings();
  renderPaused();
  document.body.dataset.view = state.screen;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === 'welcome'));
  state.screen = 'welcome';
  document.body.dataset.view = 'welcome';
  fx.cascade(screenEl('welcome'), { delay: 150, step: 110 });
  tickClock();
  refreshFaceIndex();
  refreshAttention();
  if (!PHONE) { endOfDayCheck(); retentionCheck(); }
}

initSetup({
  kb, show, toast, busy, confirmTap, esc, upgrade: openUpgrade,
  /** Setup finished (or an edit was saved): show the kiosk with the new settings. */
  async done({ reload, toAdmin }) {
    if (reload) { location.replace(location.pathname); return; }
    await refreshPlan().catch(() => {});
    applySettings();
    refreshFaceIndex();
    if (toAdmin) { show('admin'); adminTab('settings'); } else show('welcome');
  },
});

/** A visitor's phone: the company's visitor settings from the sheet, then the welcome screen. */
async function startPhone() {
  let res;
  try { res = await api('getSettings'); } catch { res = { ok: false, error: 'network' }; }
  state.phoneDown = !res.ok || (res.version || 1) < BACKEND_VERSION;
  if (res.ok) {
    useSettings({ ...res.settings, org: { ...res.settings.org, logo: res.logo || '' } });
    usePoint(settings().phone);
  }
  await refreshPlan().catch(() => {});
  startKiosk();
  renderPaused();
  if (res.ok && PAYWALL.enabled) checkStatus().then(renderPaused).catch(() => {});
}

(async () => {
  if (PHONE) { await startPhone(); return; }
  if (DEMO) useSettings(demoSettings());
  else if (MODE === 'cloud') {
    const cached = loadCache();
    if (cached) useSettings(cached);
    applySettings();
    await refreshCloudSettings();
  }
  await refreshPlan().catch(() => {});
  applySettings();
  if (PAYWALL.enabled) {
    checkStatus().then(renderPaused).catch(() => {});
    setInterval(() => { if (state.screen === 'welcome') checkStatus().then(renderPaused).catch(() => {}); }, 6 * 60 * 60 * 1000);
    // The paid-until date can pass while the kiosk is running.
    setInterval(() => refreshPlan().then(renderPaused).catch(() => {}), 60 * 60 * 1000);
  }
  if (!settings().setupComplete) {
    document.body.dataset.view = 'setup';
    $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === 'setup'));
    state.screen = 'setup';
    openSetup({});
  } else {
    startKiosk();
  }
  // A license link (…/?license=VSI1…) opened on the tablet: an admin confirms it with the PIN.
  const linkKey = new URLSearchParams(location.search).get('license');
  if (linkKey && PAYWALL.enabled && settings().setupComplete) {
    history.replaceState(null, '', location.pathname);
    openPin({ title: 'Add a license', hint: 'Enter the admin PIN to add the license to this kiosk.', onSuccess() { openUpgrade(''); $('input[name="license"]').value = linkKey; applyLicense(linkKey); } });
  }
  // Face recognition loads once the kiosk is showing and the tablet is idle, so it never slows the start.
  const whenIdle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 10000 }) : setTimeout(fn, 3000));
  const preloadFaces = () => setTimeout(() => whenIdle(() => {
    if (quickOn()) face.loadModels().catch((err) => console.warn('Face models not loaded yet:', err));
  }), 2500);
  if (document.readyState === 'complete') preloadFaces(); else window.addEventListener('load', preloadFaces, { once: true });
  // With Google Sheets, open the connection to Google early.
  if (MODE === 'cloud') {
    for (const href of ['https://script.google.com', 'https://script.googleusercontent.com']) {
      const l = document.createElement('link');
      Object.assign(l, { rel: 'preconnect', href, crossOrigin: 'anonymous' });
      document.head.appendChild(l);
    }
  }
  // Offline start-up for browser kiosks (the Android app has its files built in).
  if (!Kiosk && 'serviceWorker' in navigator && window.isSecureContext && !new URLSearchParams(location.search).has('nosw')) {
    const hadOne = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline start-up not available:', err));
    // A new version was published and is saved: switch to it at the next quiet moment.
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadOne) state.updateReady = true; });
  }
  // Records kept on the tablet: ask the browser never to clear them to save space.
  if (MODE !== 'cloud' && !DEMO) navigator.storage?.persist?.().catch(() => {});
})();
