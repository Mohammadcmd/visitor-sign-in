// Visitor sign-in kiosk: screen flow and wiring.
import { CONFIG } from '../config.js';
import { call, queue, DEMO, MODE, BACKEND_VERSION, dayKey } from './api.js';
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
  // sign-out undo
  undo: null,
};

const kb = new Keyboard($('[data-keyboard]'));

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
    case 'unknown_action': return 'This needs the latest Apps Script code. Admin → Settings → Copy the latest Apps Script code, then deploy a new version.';
    default: return t('Something went wrong. Please see the front desk.');
  }
}

async function refreshFaceIndex() {
  if (!quickEntryOn()) { state.faceIndex = []; return; }
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
  $('[data-foot-badge]').hidden = !s.badges;
  $$('[data-leave-open]').forEach((b) => { b.hidden = s.badges; });
  $('[data-admin-tab="badges"]').hidden = !s.badges;
  $('[data-done-text]').textContent = s.badges
    ? t('Please wear your badge where it can be seen. Your host will meet you at the front desk.')
    : t('Please take a seat. Your host will meet you at the front desk.');
  $('[data-done-leave]').textContent = s.badges
    ? t('When you leave, tap your badge on the reader to sign out.')
    : t('When you leave, tap "Leaving?" on the welcome screen to sign out.');
  $('[data-find-hint]').textContent = quickEntryOn(s)
    ? t('Start typing your name. If you turned on quick entry, the camera may recognize you first.')
    : t('Start typing your name.');
  $('[data-cam-bubble]').hidden = !quickEntryOn(s);
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
}

/** Language buttons on the welcome screen, and a switch on the next screen. */
function renderLangPick() {
  const langs = settings().languages.filter((c) => LANGS[c]);
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
  },
  choice() {
    // Warm the camera so the returning-visitor check starts instantly.
    if (quickEntryOn()) face.startCamera($('[data-video="return"]')).catch(() => {});
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
  },
  admin() { adminTab('inside'); },
};

// ------------------------------------------------------------------ welcome

$('[data-screen="welcome"]').addEventListener('click', () => {
  if (suppressClick) { suppressClick = false; return; }
  if (state.busy) return;
  show('choice');
});

$$('[data-go]').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation();
  show(b.dataset.go);
}));
$('[data-action="new"]').addEventListener('click', (e) => { state.flow = 'new'; show('form', { rect: e.currentTarget.getBoundingClientRect() }); });
$('[data-action="returning"]').addEventListener('click', (e) => show('find', { rect: e.currentTarget.getBoundingClientRect() }));
$$('[data-leave-open]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); show('leave'); }));

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
  if (!settings().setupComplete) return;
  const res = await api('ping');
  if (!res.ok) return;
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
  if (state.flow === 'returning') return [];
  const out = [];
  if (s.photos === 'all') out.push('photo');
  if (s.form.rules.length) out.push('rules');
  if (quickEntryOn(s)) out.push('quick');
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
  if (!quickEntryOn()) return;
  // Check the picture shows a face; this descriptor is used only if they opt into quick entry.
  try {
    const d = await face.describe(shot.canvas);
    if (state.photo !== shot) return;
    state.photoDescriptor = d;
    if (!d) formError("We couldn't see your face clearly. You can retake the picture, or continue.");
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
    answers: answersForRecord(), flags: state.result?.flags || [], override: state.override || undefined,
  });
  busy(false);
  if (!res.ok) { formError(errorText(res)); return; }
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
  const res = await api('checkIn', {
    visitorId: state.visitor.id, method: state.method, flags: state.result?.flags || [], override: state.override || undefined,
    visiting: state.answers.visiting, purpose: canonicalPurpose(state.answers.purpose), expectedId: state.expected?.id,
  });
  busy(false);
  if (!res.ok) { toast(errorText(res)); return; }
  state.hostNotified = res.hostNotified || '';
  showDone('');
}

function showDone(badge) {
  $('[data-done-title]').textContent = state.method === 'new visitor'
    ? t("You're all set, {name}!", { name: state.visitor.first })
    : t('Welcome back, {name}!', { name: state.visitor.first });
  const b = $('[data-done-badge]');
  b.textContent = badge ? t('Badge {badge}', { badge }) : '';
  b.hidden = !badge;
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
  if (quickEntryOn()) recognizeInBackground();
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
  if (!everyVisitQuestions().length) { afterIdentified(origin); return; }
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
  if (!state.sample || !quickEntryOn()) { continueReturning(origin); return; }
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

listenForTaps(onTap, (key) => {
  touch();
  if (kb.input) kb.type(key);
  else if (key === 'Backspace' && $('[data-overlay="pin"]').hidden === false) pinPress('back');
  else if (/^\d$/.test(key) && $('[data-overlay="pin"]').hidden === false) pinPress(key);
});

function onTap(tag, typed) {
  kb.untype(typed);
  touch();
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
  $('[data-signout-text]').textContent = `${res.badge ? t("You're signed out. Please leave badge {badge} at the front desk.", { badge: res.badge }) : t("You're signed out.")} ${org ? t('Thanks for visiting {org}.', { org }) : t('Thanks for visiting.')}`;
  const undo = $('[data-undo]');
  undo.hidden = false;
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
  $('[data-expected-hint]').textContent = MODE === 'cloud'
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
    + (MODE === 'cloud' ? ' Your Google Sheet keeps every visit.' : '');
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
    </div>`;
  }).join('');
  fx.cascade(list, { step: 15 });
}

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
  const rows = hist.visits.map((v) => [
    v.signedIn ? new Date(v.signedIn).toLocaleString() : '', v.signedOut ? new Date(v.signedOut).toLocaleString() : '',
    v.first, v.last, v.company, v.visiting, v.purpose, v.kind, v.badge, v.method, v.signedOutBy, v.screening, v.hostNotified,
  ]);
  if (!rows.length) { toast('No visits to export. Pick a longer period.'); return; }
  exportFile(`visits-${dateStamp()}.csv`, toCsv(['Signed in', 'Signed out', 'First name', 'Last name', 'Company', 'Visiting', 'Purpose', 'Kind', 'Badge', 'How they signed in', 'Signed out by', 'Screening', 'Host notified'], rows));
});

$('[data-export-visitors]').addEventListener('click', async () => {
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
    ? `${s.hosts.length} ${s.hosts.length > 1 ? 'people' : 'person'}${MODE === 'cloud' && s.notifyHosts && s.hosts.some((h) => h.email) ? ' · emailed when their visitor arrives' : ''}`
    : 'Nobody listed: visitors type any name')],
  ['touches', 'Photos, reasons, rules, end of day and languages', (s) => `Photos: ${{ all: 'every new visitor', declined: 'declined visitors only', off: 'off' }[s.photos]} · ${s.form.rules.length} rules · ${s.endOfDay ? `everyone signed out at ${timeLabel(s.endOfDay)}${MODE === 'cloud' && s.dailySummary ? ', daily summary email' : ''}` : 'no automatic sign-out'} · ${s.languages.map((c) => LANGS[c]).join(', ')}`],
];

function loadSettingsPane() {
  const s = settings();
  $('[data-settings-rows]').innerHTML = SETTING_ROWS.map(([step, title, sum]) => `
    <div class="set-row"><div><strong>${esc(title)}</strong><span>${esc(sum(s))}</span></div>
      <button type="button" data-edit="${step}">Edit</button></div>`).join('');
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => openSetup({ edit: b.dataset.edit, token: state.adminToken })));
  const info = $('[data-storage-info]');
  const actions = $('[data-storage-actions]');
  const secret = $('[data-connect-link]');
  secret.hidden = true;
  if (MODE === 'cloud') {
    info.textContent = `Every sign-in goes to your Google Sheet${CONFIG.BUILT_IN ? ' (built into this app)' : ''}. Visitor photos are in your Google Drive.`
      + (state.oldBackend ? ' Your Apps Script code is out of date: copy the latest script into it and deploy a new version.' : '');
    actions.innerHTML = `${CONFIG.BUILT_IN ? '' : '<button type="button" class="btn-secondary" data-connect-another>Connect another tablet</button>'}
      <button type="button" class="btn-secondary" data-copy-latest>Copy the latest Apps Script code</button>`;
    $('[data-connect-another]', actions)?.addEventListener('click', (e) => confirmTap(e.currentTarget, 'Tap again to show the private link', () => {
      const link = `${location.origin}${location.pathname}?api=${encodeURIComponent(CONFIG.API_URL)}&key=${encodeURIComponent(CONFIG.KIOSK_KEY)}`;
      secret.hidden = false;
      secret.innerHTML = `Open this link once on the other tablet. It connects to the same sheet and settings. Keep it private: it works like a password.<br><code>${esc(link)}</code>`;
      e.currentTarget.disabled = false;
    }));
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
  const limit = state.screen === 'badge' ? CONFIG.BADGE_IDLE_MS : CONFIG.IDLE_MS;
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
  if (h === CONFIG.NIGHTLY_RELOAD_HOUR && state.screen === 'welcome' && Date.now() - loadedAt > 2 * 3600 * 1000) location.reload();
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
setInterval(endOfDayCheck, 60 * 1000);

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
  applySettings();
  return true;
}

function startKiosk() {
  applySettings();
  document.body.dataset.view = state.screen;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === 'welcome'));
  state.screen = 'welcome';
  document.body.dataset.view = 'welcome';
  fx.cascade(screenEl('welcome'), { delay: 150, step: 110 });
  tickClock();
  refreshFaceIndex();
  refreshAttention();
  endOfDayCheck();
}

initSetup({
  kb, show, toast, busy, confirmTap, esc,
  /** Setup finished (or an edit was saved): show the kiosk with the new settings. */
  done({ reload, toAdmin }) {
    if (reload) { location.replace(location.pathname); return; }
    applySettings();
    refreshFaceIndex();
    if (toAdmin) { show('admin'); adminTab('settings'); } else show('welcome');
  },
});

(async () => {
  if (DEMO) useSettings(demoSettings());
  else if (MODE === 'cloud') {
    const cached = loadCache();
    if (cached) useSettings(cached);
    applySettings();
    await refreshCloudSettings();
  }
  applySettings();
  if (!settings().setupComplete) {
    document.body.dataset.view = 'setup';
    $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === 'setup'));
    state.screen = 'setup';
    openSetup({});
  } else {
    startKiosk();
  }
  window.addEventListener('load', () => { if (quickEntryOn()) face.loadModels().catch((err) => console.warn('Face models not loaded yet:', err)); });
})();
