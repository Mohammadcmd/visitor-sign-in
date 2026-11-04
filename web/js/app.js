// Shock Tech visitor kiosk: screen flow and wiring.
import { CONFIG } from '../config.js';
import { call, queue, DEMO } from './api.js';
import { Keyboard } from './keyboard.js';
import { listenForTaps } from './nfc.js';
import * as face from './face.js';
import * as fx from './transitions.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (p) => `${(p.first || '?')[0]}${(p.last || '')[0] || ''}`.toUpperCase();

const STEPS = ['intro', 'name', 'visit', 'citizenship', 'photo', 'rules', 'quick'];
const US_CITIZEN = 'U.S. citizen';

const state = {
  screen: 'welcome',
  lastTouch: Date.now(),
  busy: false,
  faceIndex: [],
  // current visitor flow
  visitor: null,          // { id, first, last, company, quickEntry }
  method: '',
  answers: {},
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
  if (to === 'done') return 'flip';
  if (to === 'admin') return 'rise';
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
  const t = $('[data-toast]');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function busy(on, text = 'One moment…') {
  state.busy = on;
  $('[data-busy-text]').textContent = text;
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
    case 'network': return "We couldn't reach the server. Please try again, or see the front desk.";
    case 'busy': return 'The system is busy. Please try again.';
    case 'badge_unknown': return "This badge isn't set up yet. Please use a different badge, or see the front desk.";
    case 'badge_in_use': return `Badge ${res.badge} is already checked out to someone. Please use a different badge.`;
    case 'badge_retired': return `Badge ${res.badge} is out of service. Please use a different badge.`;
    case 'missing': return 'Some answers are missing. Please go back and check.';
    case 'kiosk_key': return 'This kiosk is not connected correctly. Please see the front desk.';
    default: return 'Something went wrong. Please see the front desk.';
  }
}

async function refreshFaceIndex() {
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

// ------------------------------------------------------------------ screen entry hooks

const ENTER = {
  welcome() {
    face.stopCamera();
    Object.assign(state, { visitor: null, method: '', answers: {}, photo: null, photoDescriptor: null, sample: null });
    stopIdle();
  },
  choice() {
    // Warm the camera so the returning-visitor check starts instantly.
    face.startCamera($('[data-video="return"]')).catch(() => {});
  },
  form() { resetForm(); },
  find() { resetFind(); },
  badge() {
    const v = state.visitor;
    const returning = state.method !== 'new visitor';
    $('[data-badge-eyebrow]').textContent = returning ? `Welcome back, ${v.first}` : `Thanks, ${v.first}!`;
    $('[data-badge-title]').textContent = returning
      ? 'Tap any visitor badge on the reader to finish'
      : 'Last step: tap any visitor badge on the reader';
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
$('[data-action="new"]').addEventListener('click', (e) => show('form', { rect: e.currentTarget.getBoundingClientRect() }));
$('[data-action="returning"]').addEventListener('click', (e) => show('find', { rect: e.currentTarget.getBoundingClientRect() }));

function tickClock() {
  $('[data-clock]').textContent = new Date().toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Press and hold the logo for 2.5 s to open the admin PIN pad.
let suppressClick = false;
(() => {
  const logo = $('[data-admin-hold]');
  let timer;
  const cancel = () => clearTimeout(timer);
  logo.addEventListener('pointerdown', () => {
    timer = setTimeout(() => { suppressClick = true; openPin(); }, 2500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => logo.addEventListener(ev, cancel));
})();

// ------------------------------------------------------------------ new visitor form

function resetForm() {
  state.step = 0;
  state.answers = {};
  state.photo = null;
  state.photoDescriptor = null;
  $$('[data-screen="form"] input').forEach((i) => { i.value = ''; i.classList.remove('invalid'); });
  $$('[data-options="citizenship"] .option').forEach((o) => { o.classList.remove('on'); o.setAttribute('aria-checked', 'false'); });
  $$('[data-chips="purpose"] .chip').forEach((c) => c.classList.remove('on'));
  $('[data-country]').hidden = true;
  $('[data-agree]').setAttribute('aria-checked', 'false');
  clearPhoto();
  renderStep({ instant: true });
}

function renderStep({ instant = false, back = false } = {}) {
  const name = STEPS[state.step];
  const steps = $$('[data-screen="form"] .step');
  const from = steps.find((s) => s.classList.contains('active'));
  const to = steps.find((s) => s.dataset.step === name);
  if (instant) steps.forEach((s) => s.classList.toggle('active', s === to));
  else fx.step(from, to, back);
  $('[data-progress]').style.width = `${(state.step / (STEPS.length - 1)) * 100}%`;
  $('[data-form-error]').textContent = '';
  const next = $('[data-form-next]');
  $('[data-screen="form"] .form-foot').hidden = name === 'quick';
  next.hidden = name === 'quick';
  next.textContent = name === 'intro' ? "Let's begin" : 'Continue';
  $('[data-form-back]').style.visibility = state.step === 0 ? 'hidden' : '';
  $('[data-screen="form"] .form-body').scrollTop = 0;
  kb.close();
  if (name === 'photo') startPhotoCamera();
  else if (state.screen === 'form') face.stopCamera();
}

function formError(msg, inputs = []) {
  $('[data-screen="form"] .form-foot').hidden = false;
  $('[data-form-error]').textContent = msg;
  inputs.forEach((i) => i.classList.add('invalid'));
}

function validateStep() {
  const a = state.answers;
  const field = (n) => $(`[data-screen="form"] input[name="${n}"]`);
  switch (STEPS[state.step]) {
    case 'name': {
      const bad = ['first', 'last'].filter((n) => !(a[n] || '').trim());
      if (bad.length) { formError('Please enter your first and last name.', bad.map(field)); return false; }
      return true;
    }
    case 'visit': {
      const bad = ['company', 'visiting', 'purpose'].filter((n) => !(a[n] || '').trim());
      if (bad.length) {
        formError(bad.includes('company') && bad.length === 1 ? 'Please enter your company, or “N/A”.' : 'Please answer each question.', bad.map(field));
        return false;
      }
      return true;
    }
    case 'citizenship':
      if (!a.citizenship) { formError('Please choose your citizenship status.'); return false; }
      if (a.citizenship !== US_CITIZEN && !(a.country || '').trim()) { formError('Please enter your country of citizenship.', [field('country')]); return false; }
      return true;
    case 'photo':
      if (!state.photo) { formError('Please take your picture.'); return false; }
      return true;
    case 'rules':
      if (!a.agreed) { formError('Please check the box to agree to the visitor rules.'); return false; }
      return true;
    default:
      return true;
  }
}

$('[data-form-next]').addEventListener('click', () => {
  if (!validateStep()) return;
  if (state.step < STEPS.length - 1) { state.step++; renderStep(); }
});
$('[data-form-back]').addEventListener('click', () => {
  if (state.step > 0) { state.step--; renderStep({ back: true }); }
});

$$('.screen input[readonly]').forEach((input) => {
  input.addEventListener('click', () => kb.open(input));
  input.addEventListener('input', () => {
    input.classList.remove('invalid');
    if (input.closest('[data-screen="form"]')) state.answers[input.name] = input.value;
    if (input.name === 'purpose') $$('[data-chips="purpose"] .chip').forEach((c) => c.classList.toggle('on', c.textContent === input.value));
  });
});

$$('[data-chips="purpose"] .chip').forEach((chip) => chip.addEventListener('click', () => {
  const input = $('input[name="purpose"]');
  input.value = chip.textContent;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  kb.close();
}));

$$('[data-options="citizenship"] .option').forEach((opt) => opt.addEventListener('click', () => {
  $$('[data-options="citizenship"] .option').forEach((o) => {
    o.classList.toggle('on', o === opt);
    o.setAttribute('aria-checked', String(o === opt));
  });
  state.answers.citizenship = opt.dataset.value;
  const needsCountry = opt.dataset.value !== US_CITIZEN;
  $('[data-country]').hidden = !needsCountry;
  $('[data-form-error]').textContent = '';
  if (needsCountry) kb.open($('input[name="country"]'));
  else kb.close();
}));

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
$$('[data-quick]').forEach((b) => b.addEventListener('click', () => submitNewVisitor(b.dataset.quick === 'yes', centerOf(b))));

async function submitNewVisitor(quickEntry, origin) {
  if (state.busy) return;
  busy(true, 'Saving your sign-in…');
  let descriptor = state.photoDescriptor;
  if (quickEntry && !descriptor) {
    try { descriptor = await face.describe(state.photo.canvas); } catch { descriptor = null; }
  }
  const a = state.answers;
  const res = await api('register', {
    first: a.first, last: a.last, company: a.company, visiting: a.visiting, purpose: a.purpose,
    citizenship: a.citizenship, country: a.citizenship === US_CITIZEN ? 'United States' : a.country,
    agreed: !!a.agreed, quickEntry, photo: state.photo.dataUrl, descriptor: quickEntry ? descriptor : null,
  });
  busy(false);
  if (!res.ok) { formError(errorText(res)); return; }
  state.visitor = res.visitor;
  state.method = 'new visitor';
  if (quickEntry && descriptor) rememberSample(res.visitor, descriptor);
  show('badge', { origin });
}

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
  recognizeInBackground();
}

function camStatus(cls, text) {
  const bubble = $('[data-cam-bubble]');
  bubble.classList.remove('found', 'idle');
  if (cls) bubble.classList.add(cls);
  $('[data-cam-label]').textContent = text;
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
  $('[data-face-title]').textContent = `Welcome back, ${person.first}!`;
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
  show('badge', { origin: centerOf(e.currentTarget) });
});

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
    if (!v('ffirst') || !v('flast')) { $('[data-find-error]').textContent = 'Please enter your first and last name.'; return; }
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
    box.innerHTML = live ? '' : `<div class="no-match"><strong>We couldn't find you.</strong> Check the spelling, or sign in as a new visitor. It only takes two minutes.
      <div class="quick-actions"><button type="button" class="btn-primary" data-new-instead>Sign in as a new visitor</button></div></div>`;
    $('[data-new-instead]', box)?.addEventListener('click', () => show('form'));
    return;
  }
  const shown = box.dataset.ids;
  const ids = res.matches.map((m) => m.id).join(',');
  box.dataset.ids = ids;
  box.innerHTML = `<p class="hint">${res.matches.length > 1 ? 'Which one is you?' : 'Is this you?'}</p>` + res.matches.map((m, i) => `
    <button type="button" class="match" data-match="${i}">
      <span class="avatar">${esc(initials(m))}</span>
      <span><strong>${esc(m.first)} ${esc(m.last)}</strong><span>${esc(m.company)}${m.lastVisit ? ` · last visit ${esc(m.lastVisit)}` : ''}</span></span>
      <span class="go">That's me ›</span>
    </button>`).join('');
  const suggest = $('[data-suggest]');
  suggest.innerHTML = res.matches.map((m, i) => `
    <button type="button" class="suggest-chip" data-match="${i}">
      <span class="avatar">${esc(initials(m))}</span>
      <span><strong>${esc(m.first)} ${esc(m.last)}</strong><span>${esc(m.company)}</span></span>
      <em>That's me ›</em>
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
  if (m.quickEntry) { saveSample('return-name'); show('badge', { origin }); return; }
  if (!state.sample) { show('badge', { origin }); return; }
  $('[data-optin-title]').textContent = `Hi, ${m.first}!`;
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
  show('badge', { origin: centerOf(b) });
}));

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
  if (state.screen === 'admin') { adminTap(tag); return; }
  if (state.screen === 'welcome') { welcomeTap(tag); return; }
  if (state.screen === 'badge') { badgeTap(tag); return; }
  if (state.screen !== 'done') toast('Finish signing in first. You will tap your badge at the end.');
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
  status.textContent = 'Reading your badge…';
  const [res] = await Promise.all([
    api('assignBadge', { visitorId: state.visitor.id, tag, method: state.method }),
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
  $('[data-badge-no]').textContent = res.badge;
  scene.classList.add('success');
  status.textContent = `Badge ${res.badge} is yours!`;
  await sleep(1500);
  $('[data-done-title]').textContent = state.method === 'new visitor'
    ? `You're all set, ${state.visitor.first}!`
    : `Welcome back, ${state.visitor.first}!`;
  $('[data-done-badge]').textContent = `Badge ${res.badge}`;
  show('done');
}

async function welcomeTap(tag) {
  busy(true, 'Signing you out…');
  const res = await api('tapAtWelcome', { tag });
  busy(false);
  if (!res.ok) { toast(errorText(res)); return; }
  if (res.result === 'unknown') { toast("This badge isn't set up yet. Please see the front desk."); return; }
  if (res.result === 'not_out') { toast(`Badge ${res.badge} isn't checked out. To sign in, tap the screen.`); return; }
  showSignedOut(res);
}

function showSignedOut(res) {
  const ov = $('[data-overlay="signout"]');
  $('[data-signout-title]').textContent = `Goodbye, ${res.first}!`;
  $('[data-signout-text]').textContent = `You're signed out. Please leave badge ${res.badge} at the front desk. Thanks for visiting Shock Tech.`;
  const undo = $('[data-undo]');
  undo.hidden = false;
  undo.textContent = 'Not you? Undo';
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
  toast(res.ok ? 'Undone. You are still signed in.' : 'Too late to undo. Please see the front desk.');
});
$('[data-overlay="signout"]').addEventListener('click', (e) => {
  if (e.target.closest('[data-undo]')) return;
  clearTimeout(state.undo?.timer);
  state.undo = null;
  e.currentTarget.hidden = true;
});

// ------------------------------------------------------------------ admin

let pin = '';
function openPin() {
  pin = '';
  renderPin();
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
      $('[data-pin-error]').textContent = res.error === 'locked' ? 'Too many tries. Wait 10 minutes.' : res.error === 'pin' ? 'Wrong PIN.' : errorText(res);
      return;
    }
    state.adminToken = res.token;
    $('[data-overlay="pin"]').hidden = true;
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
const Native = window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null;
const Kiosk = Native?.registerPlugin?.('Kiosk');
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
  show('welcome');
}
$('[data-admin-exit]').addEventListener('click', exitAdmin);

$$('[data-admin-tab]').forEach((t) => t.addEventListener('click', () => adminTab(t.dataset.adminTab)));
$('[data-admin-refresh]').addEventListener('click', () => adminTab('inside'));

function adminTab(name) {
  state.adminMode = null;
  $('[data-admin-banner]').hidden = true;
  $$('[data-admin-tab]').forEach((t) => t.classList.toggle('active', t.dataset.adminTab === name));
  $$('[data-admin-pane]').forEach((p) => { p.hidden = p.dataset.adminPane !== name; });
  if (name === 'inside') loadInside();
  else loadBadges();
}

async function loadInside() {
  const list = $('[data-inside-list]');
  list.innerHTML = '<div class="empty">Loading…</div>';
  const res = await adminApi('adminInside');
  if (!res.ok) { list.innerHTML = `<div class="empty">${esc(errorText(res))}</div>`; return; }
  $('[data-inside-count]').textContent = res.inside.length;
  if (!res.inside.length) { list.innerHTML = '<div class="empty">Nobody is signed in right now.</div>'; return; }
  list.innerHTML = res.inside.sort((a, b) => String(a.last).localeCompare(String(b.last))).map((v) => `
    <div class="admin-row">
      <span class="badge-no">${esc(v.badge)}</span>
      <div class="who"><strong>${esc(v.first)} ${esc(v.last)}</strong>
        <span class="meta">${esc(v.company)} · visiting ${esc(v.visiting || '—')} · since ${esc(timeOf(v.since))}</span></div>
      ${v.kind === 'Foreign national' ? '<span class="pill foreign">Foreign national</span>' : ''}
      <div class="actions"><button type="button" data-signout="${esc(v.visitId)}">Sign out</button></div>
    </div>`).join('');
  fx.cascade(list, { step: 40 });
  $$('[data-signout]', list).forEach((b) => b.addEventListener('click', () => confirmTap(b, 'Tap again to sign out', async () => {
    const r = await adminApi('adminSignOut', { visitId: b.dataset.signout });
    toast(r.ok ? 'Signed out.' : errorText(r));
    loadInside();
  })));
}

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
      <div class="who"><strong>${status === 'in use' ? esc(b.holder) : status === 'retired' ? 'Out of service' : 'Available'}</strong>
        <span class="meta">${b.tag ? `NFC tag …${esc(String(b.tag).slice(-6))}` : 'No NFC tag linked'}${status === 'in use' ? ` · since ${esc(timeOf(b.since))}` : ''}</span></div>
      <span class="pill ${status.replace(' ', '-')}">${esc(status)}</span>
      <div class="actions">
        <button type="button" data-link="${esc(b.badge)}">${b.tag ? 'Relink tag' : 'Link tag'}</button>
        ${status === 'retired' ? `<button type="button" data-restore="${esc(b.badge)}">Restore</button>`
          : status === 'in use' ? '' : `<button type="button" data-retire="${esc(b.badge)}">Retire</button>`}
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
  if (state.screen === 'welcome') return;
  if (state.screen === 'admin') { if (idle > 3 * 60 * 1000) exitAdmin(); return; }
  if (state.screen === 'done') { if (idle > 15 * 1000) show('welcome'); return; }
  const limit = state.screen === 'badge' ? CONFIG.BADGE_IDLE_MS : CONFIG.IDLE_MS;
  if (idle < limit) return;
  let n = 10;
  $('[data-idle-count]').textContent = n;
  $('[data-overlay="idle"]').hidden = false;
  idleCountdown = setInterval(() => {
    n -= 1;
    $('[data-idle-count]').textContent = n;
    if (n <= 0) { stopIdle(); show('welcome'); }
  }, 1000);
}, 1000);

const loadedAt = Date.now();
setInterval(() => {
  tickClock();
  const h = new Date().getHours();
  if (h === CONFIG.NIGHTLY_RELOAD_HOUR && state.screen === 'welcome' && Date.now() - loadedAt > 2 * 3600 * 1000) location.reload();
}, 15 * 1000);
setInterval(() => { if (state.screen === 'welcome') refreshFaceIndex(); }, 5 * 60 * 1000);

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

document.body.dataset.view = state.screen;
fx.cascade(screenEl('welcome'), { delay: 150, step: 110 });
tickClock();
refreshFaceIndex();
window.addEventListener('load', () => { face.loadModels().catch((err) => console.warn('Face models not loaded yet:', err)); });
