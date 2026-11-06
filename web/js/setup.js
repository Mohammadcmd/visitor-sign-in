// The setup wizard: the questions a business answers once to make the kiosk
// theirs. It runs on first start, and the admin screen reopens single sections
// of it to change them later.
import { CONFIG, saveConnection } from '../config.js';
import { call, callBackend, MODE, BACKEND_VERSION } from './api.js';
import {
  settings, normalize, saveLocal, useSettings, hashPin, QUESTION_TEMPLATES, fromTemplate, normalizeQuestion,
  DEFAULT_RULES, DEFAULT_DECLINE, logoFor, wordmark, parseImport, fill, uid, timeLabel,
} from './settings.js';
import { normalizeTag } from './match.js';
import * as fx from './transitions.js';
import { saveFile } from './files.js';
import { builtIn, LANGS } from './i18n.js';
import { runChecks, stopChecks, readerTapped } from './checks.js';
import { can, FREE_LIMITS, PAYWALL } from './plans.js';
import { AGREEMENT_VERSION, agreementHtml } from './agreement.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clone = (x) => JSON.parse(JSON.stringify(x));

const SWATCHES = ['#0a5ea8', '#0e7490', '#047857', '#4d7c0f', '#b45309', '#b91c1c', '#be185d', '#6d28d9', '#1f2937'];
const DECLINE_PRESETS = [
  DEFAULT_DECLINE,
  "Thank you for coming in. We're not able to complete your sign-in at the kiosk today. Please wait here, and a member of our team will help you shortly.",
  "Thank you for visiting {company}. For security reasons we can't sign you in at the kiosk. Please speak with the front desk.",
];

const STEPS = {
  device: { title: 'This tablet', hint: 'Camera, reader, internet' },
  company: { title: 'Company', hint: 'Name and brand color' },
  agreement: { title: 'License agreement', hint: 'Read and accept' },
  admin: { title: 'Admin login', hint: 'Name and PIN' },
  logo: { title: 'Logo', hint: 'Optional' },
  badges: { title: 'Visitor badges', hint: 'NFC or RFID' },
  storage: { title: 'Records', hint: 'This tablet or Google Sheets' },
  connect: { title: 'Connect Google Sheets', hint: 'About 5 minutes' },
  screening: { title: 'Screening questions', hint: 'Decline or alert' },
  hosts: { title: 'Hosts', hint: 'Optional' },
  touches: { title: 'Finishing touches', hint: 'Optional' },
  ready: { title: 'Ready', hint: '' },
};

const TIPS = {
  device: ['Use the tablet where it will stand, with the badge reader plugged in.', 'In the Android app, Android asks for the camera once: tap Allow.', 'You can run this check again any time: Admin → Settings → Diagnostics.'],
  company: ['Everything here can be changed later: hold the logo on the welcome screen, then Settings.', 'Setting up another tablet? Import a settings file, or connect it to the same Google Sheet.'],
  agreement: ['Your visitor records stay on this tablet or in your own Google account. The seller never receives them.', 'Questions about the agreement? Ask the seller before you accept.'],
  admin: ['The PIN is only stored as a one-way code, never as the digits themselves.', 'After 10 wrong tries the PIN pad locks for 10 minutes.', 'The admin screen closes itself after 3 minutes without a touch.'],
  logo: ['Most design tools (Canva, Figma, Illustrator, Photoshop) can export a PNG with a transparent background.', 'Large files are fine: the kiosk shrinks them.', 'No logo? The kiosk shows your company name in your brand color instead.'],
  badges: ['Generic USB or Bluetooth NFC/RFID readers that "type" the card number work without drivers.', 'The kiosk tells a card tap apart from typing by its speed.', 'A badge is released when its visitor taps it on the way out.'],
  storage: ['Both options are free.', 'With Google Sheets, the tablet keeps working through Wi-Fi drops and sends everything when it\'s back.', 'Switching later means starting setup again on this tablet.'],
  connect: ['Records go straight from the tablet to your own sheet. There are no servers in between.', 'The first tablet to connect becomes the owner. To add more, use Admin → Settings → Connect another tablet.', 'Free Google accounts can send about 100 alert emails a day.'],
  screening: ['Questions asked once are saved with the visitor. Mark a question "Every visit" to ask returning visitors again.', 'Declined visitors only see your general message. Admins see the answers.', 'Every override records the admin\'s name and reason.'],
  hosts: ['You can add people later in the admin screen → Settings → Hosts.', 'Hosts without an email address are still suggested to visitors.', 'A visitor who types a name that isn\'t on the list can still sign in.'],
  touches: ['Quick entry needs a photo of every new visitor.', 'Quick entry is opt-in for each visitor, and they can ask the front desk to delete it.'],
  ready: ['To open the admin screen, press and hold the logo on the welcome screen for 2.5 seconds.'],
};

let ctx = null;           // { kb, show, toast, busy, confirmTap, esc, done } from app.js
let draft = null;         // the settings being edited
let extra = null;         // things that aren't settings: PIN, badges tapped, the connection
let flow = [];
let idx = 0;
let edit = null;          // the section being edited from the admin screen, or null during setup
let token = null;         // admin token when editing
let saved = false;        // setup finished and saved (the ready step)

const esc = (s) => ctx.esc(s);
const body = () => $('[data-setup-body]');
const stepEl = (name) => $(`[data-sstep="${name}"]`);
const field = (name) => $(`[data-screen="setup"] input[name="${name}"]`);
const val = (name) => field(name).value.trim();
const connected = () => !!CONFIG.API_URL;

export function initSetup(context) {
  ctx = context;
  wire();
}

/** Opens the wizard. opts.edit: one section to edit from the admin screen; opts.token: the admin token. */
export function openSetup(opts = {}) {
  edit = opts.edit || null;
  token = opts.token || null;
  saved = false;
  draft = clone(settings());
  if (!edit) {
    if (connected()) draft.storage = 'cloud';
    if (!draft.screening.declineMessage) draft.screening.declineMessage = DEFAULT_DECLINE;
  }
  extra = {
    pinTouched: false, badges: [], badgeWarned: false,
    key: generateKey(), cloud: null, joining: false,
    screeningOn: activeCount(draft) > 0, editing: null, logoNote: null,
  };
  flow = edit ? [edit] : buildFlow();
  idx = 0;
  fillForm();
  $('[data-setup-mode]').textContent = edit ? 'Settings' : 'Setup';
  $('[data-setup-cancel]').hidden = !edit;
  $$('[data-sstep]').forEach((s) => s.classList.remove('active', 'leaving'));
  stepEl(flow[0]).classList.add('active');
  if (ctx && document.body.dataset.view !== 'setup') ctx.show('setup');
  render({ instant: true });
}

function renderAgreement() {
  $('[data-agreement-text]').innerHTML = agreementHtml(draft.org.name);
  $$('[data-agreement-company]').forEach((e) => { e.textContent = draft.org.name || 'your business'; });
  $('[data-agreement-version]').textContent = AGREEMENT_VERSION;
  $('[data-agree-toggle]').setAttribute('aria-checked', String(!!extra.agreed));
}

function buildFlow() {
  if (extra?.joining) return ['connect'];
  // With licensing on, the business accepts the license agreement after giving its name.
  const f = ['device', 'company', ...(PAYWALL.enabled ? ['agreement'] : []), 'admin', 'logo', 'badges', 'storage'];
  if (draft.storage === 'cloud') f.push('connect');
  f.push('screening', 'hosts', 'touches', 'ready');
  return f;
}

const activeCount = (s) => s.screening.questions.filter((q) => q.text).length;

function generateKey() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}

// ------------------------------------------------------------------ filling the form from the draft

function fillForm() {
  field('s-org').value = draft.org.name;
  field('s-tagline').value = draft.org.tagline;
  field('s-admin').value = draft.admin.name;
  field('s-pin').value = '';
  field('s-pin2').value = '';
  field('s-url').value = '';
  field('s-key').value = '';
  field('s-alerts').value = draft.screening.alertEmails;
  $('[data-pin-keep]').hidden = !edit;
  renderSwatches();
  renderPreview();
  renderPinChecks();
  renderLogo();
  renderChoice('[data-badges-choice]', draft.badges ? 'yes' : draft.passes ? 'passes' : 'no');
  field('s-passes').value = extra.passCount ? String(extra.passCount) : '';
  renderBadgePanel();
  renderChoice('[data-storage-choice]', draft.storage);
  $$('[data-storage-choice] .option').forEach((o) => { o.disabled = connected() || !!edit; });
  $('[data-storage-choice] .option[data-value="cloud"]').classList.toggle('pro-locked', !can('cloud'));
  $('[data-lang-toggle="es"]').classList.toggle('pro-locked', !can('languages'));
  $('[data-quick-toggle]').classList.toggle('pro-locked', !can('quickEntry'));
  $('[data-notify-toggle]').classList.toggle('pro-locked', !can('hostEmails'));
  $('[data-summary-toggle]').classList.toggle('pro-locked', !can('dailySummary'));
  $('[data-storage-builtin]').hidden = !connected();
  renderConnect();
  renderChoice('[data-screening-choice]', extra.screeningOn ? 'yes' : 'no');
  renderBuilder();
  renderHosts();
  renderTouches();
}

function renderChoice(sel, value) {
  $$(`${sel} .option`).forEach((o) => {
    const on = o.dataset.value === value;
    o.classList.toggle('on', on);
    o.setAttribute('aria-checked', String(on));
  });
}

// ------------------------------------------------------------------ steps, rail and buttons

function render({ instant = false, back = false } = {}) {
  const name = flow[idx];
  const steps = $$('[data-sstep]');
  const from = steps.find((s) => s.classList.contains('active'));
  const to = stepEl(name);
  if (instant || !from) steps.forEach((s) => s.classList.toggle('active', s === to));
  else if (from !== to) fx.step(from, to, back);
  body().scrollTop = 0;
  ctx.kb.close();
  // Two fields share the alert addresses (screening alerts and the daily summary).
  field('s-alerts').value = draft.screening.alertEmails;
  field('s-summary-to').value = draft.screening.alertEmails;
  $('[data-setup-error]').textContent = '';

  const visible = flow.filter((s) => s !== 'ready');
  const pos = visible.indexOf(name);
  $('[data-setup-count]').textContent = edit ? `Settings · ${STEPS[name].title}` : name === 'ready' ? 'Setup complete' : `Step ${pos + 1} of ${visible.length}`;
  $('[data-setup-rail]').innerHTML = visible.map((s, i) => {
    const cls = name === 'ready' || i < pos ? 'done' : i === pos ? 'active' : '';
    return `<li class="${cls}"><span class="rnum">${cls === 'done' ? '✓' : i + 1}</span><span><strong>${esc(STEPS[s].title)}</strong><small>${esc(STEPS[s].hint)}</small></span></li>`;
  }).join('');
  const tips = TIPS[name] || [];
  $('[data-setup-tip]').innerHTML = tips.length ? `<strong>Good to know</strong><ul>${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '';

  const next = $('[data-setup-next]');
  const backBtn = $('[data-setup-back]');
  const skip = $('[data-setup-skip]');
  backBtn.hidden = !!edit || (idx === 0 && !extra.joining) || name === 'ready';
  skip.hidden = !!edit || !['logo', 'hosts', 'touches'].includes(name);
  if (edit) next.textContent = edit === 'device' ? 'Done' : 'Save';
  else if (name === 'ready') next.textContent = 'Open the kiosk';
  else if (flow[idx + 1] === 'ready') next.textContent = 'Finish setup';
  else next.textContent = 'Continue';
  next.hidden = name === 'connect' && extra.joining && !extra.cloud;

  if (name === 'connect') autoConnect();
  if (name === 'agreement') renderAgreement();
  if (name === 'ready') renderReady();
  // The tablet check runs while its step is showing (it uses the camera).
  if (name === 'device' && !extra.checking) { extra.checking = true; runChecks(); }
  if (name !== 'device' && extra.checking) { extra.checking = false; stopChecks(); }
}

function go(delta) {
  idx = Math.max(0, Math.min(flow.length - 1, idx + delta));
  render({ back: delta < 0 });
}

function error(msg, input) {
  $('[data-setup-error]').textContent = msg;
  if (input) input.classList.add('invalid');
  return false;
}

/** Checks the current step; shows what's wrong and returns false if anything is. */
function validate(name) {
  $$('[data-screen="setup"] .invalid').forEach((i) => i.classList.remove('invalid'));
  if (name === 'company') {
    if (!draft.org.name) return error('Please enter your company name.', field('s-org'));
  }
  if (name === 'admin') {
    if (!draft.admin.name) return error('Please enter a name for the admin.', field('s-admin'));
    const p = val('s-pin'), p2 = val('s-pin2');
    if (edit && !p && !p2) return true;
    if (!/^\d{6,8}$/.test(p)) return error('The admin PIN must be 6 to 8 digits.', field('s-pin'));
    if (easyPin(p)) return error('That PIN is too easy to guess. Avoid repeated or sequential digits.', field('s-pin'));
    if (p !== p2) return error("The two PINs don't match.", field('s-pin2'));
  }
  if (name === 'agreement') {
    const who = val('s-agree-name');
    if (!who) return error('Type your name to accept the license agreement.', field('s-agree-name'));
    if (!extra.agreed) return error('Tick "I agree" to accept the license agreement. Questions? Ask the seller first.');
    draft.agreement = { version: AGREEMENT_VERSION, by: who, at: new Date().toISOString() };
  }
  if (name === 'badges' && draft.passes && !edit) {
    const n = Number(val('s-passes') || 10);
    if (!Number.isInteger(n) || n < 1 || n > 200) return error('Enter how many visitor passes you have, from 1 to 200.', field('s-passes'));
    extra.passCount = n;
  }
  if (name === 'badges' && draft.badges && !edit && !extra.badges.length && !extra.badgeWarned) {
    extra.badgeWarned = true;
    return error('No badges registered yet. You can add them later in the admin screen → Badges. Tap Continue again to go on without them.');
  }
  if (name === 'hosts' && val('s-host-name') && !addHost()) return false;
  if (name === 'connect' && !extra.cloud) return error('Connect to your Google Sheet first, or go back and choose "On this tablet".');
  if (name === 'screening' && extra.screeningOn) {
    const qs = draft.screening.questions;
    if (!qs.length) return error('Add at least one question, or choose "No extra questions".');
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (!q.text) return error(`Question ${i + 1} needs some text.`);
      if (q.type === 'choice' && q.options.length < 2) return error(`Question ${i + 1} needs at least two answers to choose from.`);
      if (q.rule.action !== 'none' && !q.rule.answers.length) return error(`For question ${i + 1}, tap the answer that should ${q.rule.action === 'decline' ? 'decline the visitor' : 'alert staff'}.`);
    }
    const bad = draft.screening.alertEmails.split(/[\s,;]+/).filter(Boolean).filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (bad.length) return error(`Check this email address: ${bad[0]}`, field('s-alerts'));
  }
  if (name === 'touches' && draft.storage === 'cloud' && draft.endOfDay && draft.dailySummary) {
    const list = draft.screening.alertEmails.split(/[\s,;]+/).filter(Boolean);
    const bad = list.filter((e) => !EMAIL_RE.test(e));
    if (!list.length) return error('Add an email address for the daily summary, or turn the summary off.', field('s-summary-to'));
    if (bad.length) return error(`Check this email address: ${bad[0]}`, field('s-summary-to'));
  }
  return true;
}

const easyPin = (p) => /^(\d)\1+$/.test(p) || '01234567890123'.includes(p) || '98765432109876'.includes(p);

async function onNext() {
  const name = flow[idx];
  if (edit === 'device') { leaveChecks(); ctx.done({ toAdmin: true, cancelled: true }); return; }
  if (name === 'ready') { ctx.done({ reload: draft.storage === 'cloud' && MODE !== 'cloud' }); return; }
  if (!validate(name)) return;
  if (edit) { await saveEdit(); return; }
  if (name === 'connect' && extra.joining) {
    if (extra.cloud.setupComplete) { join(); return; }
    // The sheet isn't set up yet: carry on with the full setup, already connected.
    extra.joining = false;
    flow = buildFlow();
    idx = 0;
    render();
    ctx.toast("Connected. This sheet isn't set up yet, so let's set it up now.");
    return;
  }
  if (flow[idx + 1] === 'ready') { if (await finish()) go(1); return; }
  go(1);
}

// ------------------------------------------------------------------ saving

/** Everything the wizard collected becomes the kiosk's settings. */
async function finish() {
  const s = normalize({ ...draft, setupComplete: true, trialStarted: draft.trialStarted || new Date().toISOString() });
  if (!extra.screeningOn) s.screening.questions = [];
  ctx.busy(true, 'Saving your setup…');
  try {
    if (s.storage === 'local') {
      s.admin.pinHash = await hashPin(val('s-pin'));
      saveLocal(s);
      const login = await call('adminLogin', { pin: val('s-pin') });
      for (const b of extra.badges) await call('adminAddBadge', { token: login.token, tag: b.tag });
      if (s.passes) for (let i = 0; i < (extra.passCount || 0); i++) await call('adminAddBadge', { token: login.token });
      return true;
    }
    const { api, key, hasPin } = extra.cloud;
    const send = async (action, args) => {
      const res = await callBackend(api, key, action, args);
      if (!res.ok) throw Object.assign(new Error(res.error), { code: res.error });
      return res;
    };
    const pinNow = val('s-pin');
    let tok;
    if (hasPin) {
      const login = await callBackend(api, key, 'adminLogin', { pin: pinNow });
      if (!login.ok) {
        ctx.busy(false);
        idx = flow.indexOf('admin');
        render({ back: true });
        error("This sheet already has an admin PIN, and that isn't it. Enter the PIN that was set on the first tablet.", field('s-pin'));
        return false;
      }
      tok = login.token;
    } else {
      tok = (await send('adminSetPin', { pin: pinNow })).token;
    }
    const logo = s.org.logo;
    const toSave = clone(s);
    toSave.org.logo = '';
    toSave.admin.pinHash = '';
    await send('adminSaveSettings', { token: tok, settings: toSave, logo: logo || '' });
    for (const b of extra.badges) await callBackend(api, key, 'adminAddBadge', { token: tok, tag: b.tag });
    if (s.passes) for (let i = 0; i < (extra.passCount || 0); i++) await callBackend(api, key, 'adminAddBadge', { token: tok });
    if (!CONFIG.BUILT_IN) saveConnection(api, key);
    useSettings(s, { cache: true });
    return true;
  } catch (err) {
    console.error(err);
    error(err.code === 'too_big' ? 'The logo is too large to save. Try a smaller PNG.' : "Couldn't save to your Google Sheet. Check the internet connection and try again.");
    return false;
  } finally {
    saved = true;
    ctx.busy(false);
  }
}

/** Saves the one section opened from the admin screen. */
async function saveEdit() {
  const s = normalize({ ...draft, setupComplete: true });
  if (edit === 'screening' && !extra.screeningOn) s.screening.questions = [];
  ctx.busy(true, 'Saving…');
  try {
    const pinNow = val('s-pin');
    if (edit === 'admin' && pinNow) {
      const r = await call('adminSetPin', { pin: pinNow, token });
      if (!r.ok) throw new Error(r.error);
      token = r.token;
    }
    const logoChanged = edit === 'logo';
    const toSave = clone(s);
    if (MODE === 'cloud') toSave.org.logo = '';
    const r = await call('adminSaveSettings', { token, settings: toSave, ...(logoChanged ? { logo: s.org.logo || '' } : {}) });
    if (!r.ok) throw new Error(r.error);
    useSettings(s, { cache: MODE === 'cloud' });
    ctx.toast('Saved.');
    ctx.done({ toAdmin: true });
  } catch (err) {
    console.error(err);
    error(err.message === 'admin' ? 'The admin session ended. Close this and unlock the admin screen again.' : "Couldn't save. Check the connection and try again.");
  } finally {
    ctx.busy(false);
  }
}

/** A second tablet joining a sheet that's already set up: use the sheet's settings. */
function join() {
  const { api, key } = extra.cloud;
  if (!CONFIG.BUILT_IN) saveConnection(api, key);
  ctx.done({ reload: true });
}

// ------------------------------------------------------------------ company

function renderSwatches() {
  const cur = draft.org.accent;
  $('[data-swatches]').innerHTML = SWATCHES.map((c) => `<button type="button" class="swatch${c === cur ? ' on' : ''}" style="background:${c}" data-swatch="${c}" aria-label="Color ${c}"></button>`).join('')
    + `<label class="swatch swatch-custom${SWATCHES.includes(cur) ? '' : ' on'}" aria-label="Any color"><input type="color" value="${esc(cur)}" data-swatch-custom></label>`;
}

function renderPreview() {
  const s = { ...draft, org: { ...draft.org } };
  $('[data-preview-logo]').src = logoFor(s);
  $('[data-preview-name]').textContent = draft.org.name || 'your company';
  $('[data-preview-tagline]').textContent = draft.org.tagline;
}

function setAccent(color) {
  draft.org.accent = color;
  import('./settings.js').then(({ applyTheme }) => applyTheme(normalize(draft)));
  renderSwatches();
  renderPreview();
}

// ------------------------------------------------------------------ admin

function renderPinChecks() {
  const p = val('s-pin'), p2 = val('s-pin2');
  const st = { len: /^\d{6,8}$/.test(p), easy: p.length >= 6 && !easyPin(p), match: p.length >= 6 && p === p2 };
  $$('[data-pin-checks] li').forEach((li) => li.classList.toggle('ok', !!st[li.dataset.check]));
}

// ------------------------------------------------------------------ logo

function renderLogo() {
  const has = !!draft.org.logo;
  $('[data-logo-drop]').hidden = has;
  $('[data-logo-result]').hidden = !has;
  $('[data-logo-actions]').hidden = !has;
  ['a', 'b', 'c'].forEach((k) => { $(`[data-logo-${k}]`).src = has ? draft.org.logo : ''; });
  const note = $('[data-logo-note]');
  note.hidden = !extra.logoNote;
  if (extra.logoNote) { note.className = `note ${extra.logoNote.ok ? 'ok' : ''}`; note.textContent = extra.logoNote.text; }
  renderPreview();
}

/** Shrinks the PNG and checks it has a transparent background. */
function readLogo(file) {
  return new Promise((resolve, reject) => {
    if (!(file.type === 'image/png' || /\.png$/i.test(file.name))) { reject(new Error('Please choose a PNG file. Other formats, like JPG, can\'t have a transparent background.')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image couldn't be opened. Try exporting it again as a PNG.")); };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, c.width, c.height);
      let clear = 0, corners = false;
      try {
        const { data } = g.getImageData(0, 0, c.width, c.height);
        for (let i = 3; i < data.length; i += 4) if (data[i] < 250) clear++;
        const a = (x, y) => data[(y * c.width + x) * 4 + 3];
        corners = [a(0, 0), a(c.width - 1, 0), a(0, c.height - 1), a(c.width - 1, c.height - 1)].some((v) => v < 250);
      } catch { /* treat as opaque */ }
      resolve({ dataUrl: c.toDataURL('image/png'), transparent: corners && clear / (c.width * c.height) > 0.02, width: img.naturalWidth });
    };
    img.src = url;
  });
}

async function chooseLogo(file) {
  if (!file) return;
  try {
    const r = await readLogo(file);
    draft.org.logo = r.dataUrl;
    extra.logoNote = r.transparent
      ? { ok: true, text: `Looks great: the background is transparent.${r.width < 300 ? ' It\'s quite small, so it may look soft on large screens.' : ''}` }
      : { ok: false, text: 'This PNG has a solid background, so a box will show around your logo on the dark welcome screen. For the cleanest look, export it again with a transparent background. You can keep this one for now.' };
  } catch (err) {
    extra.logoNote = { ok: false, text: err.message };
  }
  renderLogo();
}

// ------------------------------------------------------------------ badges

function renderBadgePanel() {
  $('[data-badge-panel]').hidden = !draft.badges;
  // Numbered passes: how many to make (when editing, they're managed in the admin screen → Badges).
  $('[data-pass-panel]').hidden = !draft.passes;
  field('s-passes').closest('.field').hidden = !!edit;
  $('[data-pass-hint]').textContent = edit
    ? 'Add or retire passes in the admin screen → Badges.'
    : "They're numbered V1, V2, … Label your passes to match. You can add or retire passes later in the admin screen → Badges.";
  const list = extra.badges;
  $('[data-badge-panel]').classList.toggle('got', list.length > 0);
  $('[data-badge-panel-title]').textContent = edit
    ? 'Tap a new badge to add it'
    : list.length ? `${list.length} badge${list.length > 1 ? 's' : ''} registered. Tap the next one` : 'Tap each visitor badge on the reader';
  $('[data-badge-panel-text]').textContent = edit
    ? 'Manage existing badges in the admin screen → Badges.'
    : "They're numbered V1, V2, … in the order you tap them. You can add more later in the admin screen.";
  $('[data-badge-chips]').innerHTML = list.map((t, i) => `<span class="badge-chip"><b>${esc(t.no || `V${i + 1}`)}</b><span>…${esc(t.tag.slice(-6))}</span>${edit ? '' : `<button type="button" data-unbadge="${i}" aria-label="Remove">×</button>`}</span>`).join('');
}

function leaveChecks() {
  if (extra?.checking) { extra.checking = false; stopChecks(); }
}

/** A card was tapped on the reader while setup is open. */
export async function setupTap(tag) {
  if (flow[idx] === 'device') { readerTapped(tag); return; }
  if (flow[idx] !== 'badges' || !draft.badges) { ctx.toast(`Reader works: card …${tag.slice(-6)} read.`); return; }
  if (extra.badges.some((b) => normalizeTag(b.tag) === normalizeTag(tag))) { ctx.toast('That badge is already registered.'); return; }
  if (edit) {
    const r = await call('adminAddBadge', { token, tag });
    if (!r.ok) { ctx.toast(r.error === 'badge_exists' ? `Badge ${r.badge} already exists.` : "Couldn't add that badge."); return; }
    extra.badges.push({ tag, no: r.badge });
  } else {
    extra.badges.push({ tag });
  }
  $('[data-setup-error]').textContent = '';
  renderBadgePanel();
}

// ------------------------------------------------------------------ Google Sheets

const URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/;

function renderConnect() {
  const builtIn = connected();
  const guide = $('[data-sstep="connect"] .guide');
  guide.hidden = builtIn;
  field('s-url').closest('.field').hidden = builtIn;
  $('[data-paste-url]').closest('.row-actions').hidden = builtIn;
  $('[data-key-field]').hidden = !extra.needKey;
  status(extra.cloudStatus || null);
}

function status(st) {
  extra.cloudStatus = st;
  const box = $('[data-connect-status]');
  if (!st) { box.hidden = true; return; }
  box.hidden = false;
  box.className = `status ${st.kind || ''}`;
  box.innerHTML = st.html;
  if (st.kind) requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

async function autoConnect() {
  if (!connected() || extra.cloud || extra.connecting) return;
  await connect(CONFIG.API_URL, CONFIG.KIOSK_KEY);
}

async function connect(api, key) {
  extra.connecting = true;
  status({ html: '<strong>Connecting…</strong>Talking to your Google Sheet.' });
  let res;
  try {
    res = await callBackend(api, key, 'claim');
  } catch (err) {
    extra.connecting = false;
    status({
      kind: 'err',
      html: `<strong>Couldn't reach the script</strong>Check these, then tap Connect again:<ul>
        <li>In the deployment, <em>Who has access</em> is <kbd>Anyone</kbd> (not "Only myself").</li>
        <li>You copied the <em>Web app</em> URL ending in <code>/exec</code>, not the editor's address.</li>
        <li>If you changed the script, deploy a new version: <kbd>Deploy</kbd> → <kbd>Manage deployments</kbd> → edit → <kbd>New version</kbd>.</li>
        <li>This tablet is online.</li></ul>`,
    });
    return;
  }
  extra.connecting = false;
  if (!res.ok) {
    if (res.error === 'claimed') {
      extra.needKey = true;
      renderConnect();
      status({ kind: 'err', html: '<strong>This sheet is already connected to another tablet</strong>Enter that tablet\'s kiosk key below and tap Connect again. On the first tablet: admin screen → Settings → Connect another tablet.' });
    } else if (res.error === 'kiosk_key') {
      status({ kind: 'err', html: '<strong>This sheet has an older kiosk script</strong>Copy the script again (step 2), paste it over the old code, then deploy a new version: <kbd>Deploy</kbd> → <kbd>Manage deployments</kbd> → edit → <kbd>New version</kbd>.' });
    } else {
      status({ kind: 'err', html: `<strong>The script answered with a problem</strong>${esc(res.error || 'unknown')}. Copy the script again and redeploy it.` });
    }
    return;
  }
  extra.cloud = { api, key, ...res };
  $('[data-setup-error]').textContent = '';
  const already = res.setupComplete && !edit;
  status({
    kind: 'ok',
    html: `<strong>Connected to "${esc(res.sheetName || 'your sheet')}"</strong>${already
      ? 'This sheet is already set up for a kiosk. Use its settings on this tablet, or carry on to replace them with this setup.'
      : 'Visitors, visits and badges will be saved to its tabs, and photos to a folder in your Google Drive.'}`
      + (already ? '<div class="row-actions"><button type="button" class="btn-primary" data-use-sheet>Use the settings saved in this sheet</button></div>' : ''),
  });
  $('[data-use-sheet]')?.addEventListener('click', join);
  if (extra.joining) { $('[data-setup-next]').hidden = false; $('[data-setup-next]').textContent = res.setupComplete ? 'Use these settings' : 'Continue'; }
}

async function copyScript() {
  const { BACKEND_CODE } = await import('./backend-code.js');
  try {
    await navigator.clipboard.writeText(BACKEND_CODE);
    ctx.toast('Script copied. Paste it into the Apps Script editor, replacing everything there.');
  } catch {
    downloadScript(BACKEND_CODE);
    ctx.toast("Copying isn't allowed here, so the script was downloaded instead.");
  }
}

async function downloadScript(code) {
  const text = code || (await import('./backend-code.js')).BACKEND_CODE;
  try {
    const where = await saveFile('Code.gs', text);
    if (!code) ctx.toast(`Code.gs saved to ${where}.`);
  } catch { ctx.toast("Couldn't save the file on this tablet. Use Copy the script instead."); }
}

// ------------------------------------------------------------------ screening questions

function renderBuilder() {
  $('[data-builder]').hidden = !extra.screeningOn;
  const qs = draft.screening.questions;
  const used = new Set(qs.map((q) => q.template).filter(Boolean));
  $('[data-templates]').innerHTML = QUESTION_TEMPLATES.map((t) => `<button type="button" class="chip add" data-template="${t.key}"${used.has(t.key) ? ' disabled' : ''}>${esc(t.name)}</button>`).join('');
  $('[data-qlist]').innerHTML = qs.map((q, i) => questionCard(q, i, qs.length)).join('');
  $('[data-decline-message]').textContent = fill(draft.screening.declineMessage, draft);
  $('[data-decline-presets]').innerHTML = DECLINE_PRESETS.map((m, i) => `<button type="button" class="chip${m === draft.screening.declineMessage ? ' on' : ''}" data-decline-preset="${i}">${['Standard', 'Please wait for staff', 'Speak with the front desk'][i]}</button>`).join('');
  const cloud = draft.storage === 'cloud';
  $('[data-alert-field]').hidden = !cloud;
  $('[data-alert-local]').hidden = cloud;
}

function questionCard(q, i, n) {
  const editing = extra.editing === q.id;
  const ruleCls = q.rule.action === 'decline' ? 'decline' : q.rule.action === 'flag' ? 'flag' : '';
  const typeName = { yesno: 'Yes / No', choice: 'Choose one', text: 'Short answer' }[q.type];
  const what = q.rule.action === 'decline' ? 'politely declined after their photo, and staff are alerted'
    : q.rule.action === 'flag' ? `let in, and staff are alerted ("${q.rule.flagLabel || q.label}")` : '';
  const note = q.type === 'text' ? 'Short answers are saved with the visit. They can\'t decline or alert.'
    : q.rule.action === 'none' ? 'The answer is saved with the visit.'
      : q.rule.answers.length ? `Visitors who answer ${q.rule.answers.map((a) => `"${a}"`).join(' or ')} are ${what}.` : 'Tap the answer that should trigger this.';
  return `<li class="qcard ${ruleCls}" data-qcard="${i}">
    <div class="qhead">
      <span class="qnum">${i + 1}</span>
      <div class="qtext"><strong>${esc(q.text || 'New question')}</strong><small>${esc(typeName)} · saved as "${esc(q.label || '…')}"${q.followUp ? ` · then asks for ${esc(q.followUp.label.toLowerCase())}` : ''}</small></div>
      <div class="qtools">
        <button type="button" data-qedit="${i}" aria-label="Edit">✎</button>
        <button type="button" data-qup="${i}" aria-label="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" data-qdown="${i}" aria-label="Move down"${i === n - 1 ? ' disabled' : ''}>↓</button>
        <button type="button" data-qdel="${i}" aria-label="Delete">🗑</button>
      </div>
    </div>
    ${editing ? `<div class="qedit">
      <label class="field"><span>Question</span><input readonly inputmode="none" name="q-text" data-cap="sentence" maxlength="200" autocomplete="off" value="${esc(q.text)}"></label>
      <div class="qrow"><span class="qlbl">Answer</span><div class="seg">${['yesno', 'choice', 'text'].map((t) => `<button type="button" data-qtype="${t}" class="${q.type === t ? 'on' : ''}">${{ yesno: 'Yes / No', choice: 'Choose one', text: 'Short answer' }[t]}</button>`).join('')}</div></div>
      ${q.type === 'choice' ? `<label class="field"><span>Answers to choose from, separated by commas</span><input readonly inputmode="none" name="q-options" data-cap="sentence" maxlength="300" autocomplete="off" value="${esc(q.options.join(', '))}"></label>` : ''}
      <div class="row-actions"><button type="button" class="btn-primary" data-qdone="${i}">Done</button></div>
    </div>` : ''}
    ${q.type !== 'text' ? `<div class="qrow"><span class="qlbl">If the answer is</span>${q.options.map((o) => `<button type="button" class="chip${q.rule.answers.includes(o) ? ' hit' : ''}" data-qhit="${i}" data-value="${esc(o)}">${esc(o)}</button>`).join('')}</div>
    <div class="qrow"><span class="qlbl">then</span><div class="seg">${[['none', 'Nothing'], ['decline', 'Politely decline'], ['flag', 'Let in, alert staff']].map(([v, l]) => `<button type="button" data-qaction="${i}" data-value="${v}" class="${q.rule.action === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>` : ''}
    <div class="qrow"><span class="qlbl">Ask</span><div class="seg"><button type="button" data-qevery="${i}" data-value="0" class="${q.every ? '' : 'on'}">Once, when they first sign in</button><button type="button" data-qevery="${i}" data-value="1" class="${q.every ? 'on' : ''}">Every visit</button></div></div>
    <p class="qnote">${esc(note)}</p>
  </li>`;
}

function addQuestion(q) {
  if (!can('screening') && draft.screening.questions.length >= FREE_LIMITS.screeningQuestions) { ctx.upgrade('screening'); return false; }
  draft.screening.questions.push(q);
  renderBuilder();
}

// ------------------------------------------------------------------ hosts

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function renderHosts() {
  const list = draft.hosts;
  $('[data-host-list]').innerHTML = list.map((h, i) => `<li>
      <span class="avatar">${esc(h.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase())}</span>
      <span class="who"><strong>${esc(h.name)}</strong><small>${h.email ? esc(h.email) : 'No email: suggested to visitors only'}</small></span>
      <button type="button" data-unhost="${i}" aria-label="Remove ${esc(h.name)}">×</button></li>`).join('')
    || '<li class="empty hint small">Nobody added yet. Visitors can still type any name.</li>';
  const cloud = draft.storage === 'cloud';
  const t = $('[data-notify-toggle]');
  t.hidden = !cloud;
  t.setAttribute('aria-checked', String(!!draft.notifyHosts));
  $('[data-notify-local]').hidden = cloud;
}

/** Adds (or updates) the host typed into the two fields. Returns false and shows why when it can't. */
function addHost() {
  const name = val('s-host-name').replace(/\s+/g, ' ');
  const email = val('s-host-email').toLowerCase();
  if (!name) return error('Enter the host\'s name.', field('s-host-name'));
  if (email && !EMAIL_RE.test(email)) return error(`Check this email address: ${email}`, field('s-host-email'));
  const same = draft.hosts.find((h) => h.name.toLowerCase() === name.toLowerCase());
  if (same) same.email = email || same.email;
  else draft.hosts.push({ name, email });
  draft.hosts.sort((a, b) => a.name.localeCompare(b.name));
  field('s-host-name').value = '';
  field('s-host-email').value = '';
  $('[data-setup-error]').textContent = '';
  ctx.kb.close();
  renderHosts();
  return true;
}

// ------------------------------------------------------------------ finishing touches

function renderTouches() {
  $$('[data-photos-choice] button').forEach((b) => {
    const on = b.dataset.value === draft.photos;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('[data-photos-hint]').textContent = {
    all: 'Each new visitor takes a photo for their visit record. Needed for quick entry.',
    declined: 'Only visitors declined by a screening question take a photo, so staff know who was turned away.',
    off: 'No photos are taken. Quick entry needs photos, so it\'s turned off too.',
  }[draft.photos];
  const qe = $('[data-quick-toggle]');
  const quickOn = draft.quickEntry && draft.photos === 'all';
  qe.setAttribute('aria-checked', String(quickOn));
  qe.disabled = draft.photos !== 'all';
  $('[data-purpose-chips]').innerHTML = draft.form.purposes.map((p, i) => `<button type="button" class="chip" data-unpurpose="${i}">${esc(p)}</button>`).join('')
    || '<span class="hint small">No reasons: visitors type their own.</span>';
  $$('[data-eod-choice] button').forEach((b) => {
    const on = b.dataset.value === (draft.endOfDay || '');
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  $$('[data-sign-choice] button').forEach((b) => {
    const on = b.dataset.value === draft.signature.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('[data-sign-choice]').classList.toggle('pro-locked', !can('signatures'));
  const emailToggle = $('[data-sign-email-toggle]');
  emailToggle.hidden = draft.storage !== 'cloud' || draft.signature.mode === 'off';
  emailToggle.setAttribute('aria-checked', String(!!draft.signature.emailCopy));
  $$('[data-retention-choice] button').forEach((b) => {
    const on = Number(b.dataset.value) === (draft.retentionDays || 0);
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('[data-summary-box]').hidden = !(draft.storage === 'cloud' && draft.endOfDay);
  $('[data-summary-toggle]').setAttribute('aria-checked', String(!!draft.dailySummary));
  $('[data-summary-to]').hidden = !draft.dailySummary;
  renderLanguages();
  $('[data-rules-edit]').innerHTML = draft.form.rules.map((r, i) => `<li>${esc(fill(r, draft))}<button type="button" data-unrule="${i}" aria-label="Remove">×</button></li>`).join('')
    || '<li class="hint small">No rules: the rules step is skipped.</li>';
}

// ------------------------------------------------------------------ languages

/** The business's own text that visitors see, for the translation list. */
function translatableTexts() {
  const out = [];
  const add = (x) => { const v = String(x || '').trim(); if (v && !out.includes(v)) out.push(v); };
  add(draft.org.tagline);
  if (draft.form.askHost) { add(draft.form.hostLabel); add(draft.form.hostHint); }
  String(draft.form.intro || '').split(/\n{2,}/).forEach(add);
  if (extra.screeningOn) {
    draft.screening.questions.forEach((q) => {
      add(q.text); add(q.hint); q.options.forEach(add);
      if (q.followUp) add(q.followUp.label);
      add(q.intro);
    });
    add(draft.screening.declineMessage);
  }
  if (draft.form.askPurpose) draft.form.purposes.forEach(add);
  draft.form.rules.forEach(add);
  return out;
}

function renderLanguages() {
  const on = draft.languages.includes('es');
  const toggle = $('[data-lang-toggle="es"]');
  toggle.setAttribute('aria-checked', String(on));
  $('[data-translations]').hidden = !on;
  if (!on) return;
  const keys = translatableTexts();
  extra.trKeys = keys;
  const map = draft.translations.es || {};
  $('[data-tr-list]').innerHTML = keys.map((k, i) => {
    const value = map[k] || builtIn('es', k);
    const st = map[k] ? 'custom' : value ? 'built' : 'missing';
    return `<li data-state="${st}"><span class="tr-en">${esc(k)}</span>
      <label class="field"><input readonly inputmode="none" name="tr" data-tr="${i}" data-cap="sentence" maxlength="600" autocomplete="off" lang="es" value="${esc(value)}" placeholder="${esc('Shown in English')}"></label></li>`;
  }).join('');
  renderTrTitle();
}

function renderTrTitle() {
  const keys = extra.trKeys || [];
  const map = draft.translations.es || {};
  const missing = keys.filter((k) => !map[k] && !builtIn('es', k)).length;
  $('[data-translations-title]').textContent = !keys.length ? 'Nothing of your own to translate.'
    : missing ? `${keys.length - missing} of ${keys.length} translated · ${missing} still shown in English` : `All ${keys.length} translated`;
}

// ------------------------------------------------------------------ ready

function renderReady() {
  const s = normalize(draft);
  const qs = extra.screeningOn ? s.screening.questions : [];
  const declines = qs.filter((q) => q.rule.action === 'decline').length;
  const flags = qs.filter((q) => q.rule.action === 'flag').length;
  const rows = [
    ['Company', `<span class="dot" style="background:${esc(s.org.accent)}"></span>${esc(s.org.name)}`, s.org.tagline],
    ['Admin', esc(s.admin.name), 'PIN set. Hold the logo on the welcome screen for 2.5 seconds to open the admin screen.'],
    ['Logo', s.org.logo ? 'Your logo' : 'Text logo with your company name', ''],
    ...(PAYWALL.enabled ? [['License agreement', s.agreement.by ? `Accepted by ${s.agreement.by}` : 'Not accepted yet', `Version ${s.agreement.version || AGREEMENT_VERSION}. Read it again in Admin → Settings → License.`]] : []),
    ['Visitor badges', s.badges ? `Yes${extra.badges.length ? `: ${extra.badges.length} registered` : ''}` : s.passes ? `Numbered passes${extra.passCount ? `: V1 to V${extra.passCount}` : ''}` : 'No badges',
      s.badges ? 'Visitors tap a badge to finish signing in, and again to sign out.' : s.passes ? 'The kiosk tells each visitor which pass to take, and asks for it back when they sign out.' : 'Visitors sign in and out on the screen.'],
    ['Records', s.storage === 'cloud' ? `Google Sheets: "${esc(extra.cloud?.sheetName || 'your sheet')}"` : 'On this tablet', s.storage === 'cloud' ? 'Photos go to your Google Drive.' : 'Kept privately on this tablet.'],
    ['Screening', qs.length ? `${qs.length} question${qs.length > 1 ? 's' : ''}` : 'No extra questions',
      qs.length ? [declines && `${declines} can decline`, flags && `${flags} alert staff`, s.screening.alertEmails && `emails to ${s.screening.alertEmails}`].filter(Boolean).join(' · ') : ''],
    ['Hosts', s.hosts.length ? `${s.hosts.length} ${s.hosts.length > 1 ? 'people' : 'person'}` : 'None listed',
      s.hosts.length ? (s.storage === 'cloud' && s.notifyHosts && s.hosts.some((h) => h.email) ? 'Suggested to visitors, and emailed when their visitor arrives.' : 'Suggested to visitors as they type.') : 'Visitors type the name of the person they\'re visiting.'],
    ['Photos', { all: 'Every new visitor', declined: 'Declined visitors only', off: 'No photos' }[s.photos], s.quickEntry && s.photos === 'all' ? 'Quick entry is on for returning visitors who opt in.' : ''],
    ['Signature', { off: 'Tick box only', new: 'New visitors sign the rules', every: 'Visitors sign the rules every visit' }[s.signature.mode],
      s.signature.mode !== 'off' && s.storage === 'cloud' && s.signature.emailCopy ? 'Visitors can have the signed copy emailed to them.' : ''],
    ['Records kept', s.retentionDays ? `${{ 30: '30 days', 90: '90 days', 180: '6 months', 365: '1 year', 730: '2 years' }[s.retentionDays]}, then deleted` : 'Until you delete them', ''],
    ['Languages', s.languages.map((c) => LANGS[c]).join(', '), s.languages.length > 1 ? 'Visitors choose on the welcome screen.' : ''],
    ['End of day', s.endOfDay ? `Everyone is signed out at ${esc(timeLabel(s.endOfDay))}` : 'Visitors stay signed in until they sign out',
      s.endOfDay && s.storage === 'cloud' && s.dailySummary ? `A daily summary is emailed to ${s.screening.alertEmails}.` : ''],
  ];
  $('[data-summary]').innerHTML = rows.map(([k, v, sub]) => `<li><span class="k">${esc(k)}</span><span class="v">${v}${sub ? `<small>${esc(sub)}</small>` : ''}</span></li>`).join('');
  const steps = [
    ['Put the tablet at your entrance', 'Keep it plugged in. In the Android app, kiosk mode keeps visitors in the app. On an iPad, turn on Guided Access (Settings → Accessibility).'],
    ['Try it once yourself', 'Tap the welcome screen and sign in as a visitor, so you see exactly what your visitors see.'],
  ];
  if (s.badges) steps.push(['Keep the badges by the reader', 'Visitors pick one up, tap it to finish signing in, and tap it again when they leave.']);
  if (declines) steps.push(['Know what happens when someone is declined', `They see your polite message${s.photos !== 'off' ? ' after a quick photo' : ''}. ${s.storage === 'cloud' && s.screening.alertEmails ? `An email goes to ${s.screening.alertEmails}. ` : ''}It shows in the admin screen under Needs attention, where you can let them in, or use "Staff override" on the kiosk.`]);
  steps.push(s.storage === 'cloud'
    ? ['Bookmark your Google Sheet', 'The Visits tab fills in live. Share the sheet with colleagues who need to see who\'s on site.']
    : ['Remember where the records are', 'Everything is on this tablet. The admin screen shows who\'s inside and lets you export the settings as a backup.']);
  $('[data-next-steps]').innerHTML = steps.map(([t, d]) => `<li><strong>${esc(t)}</strong>${esc(d)}</li>`).join('');
}

// ------------------------------------------------------------------ wiring

function wire() {
  $('[data-setup-next]').addEventListener('click', onNext);
  $('[data-setup-back]').addEventListener('click', () => {
    if (extra.joining) { extra.joining = false; draft.storage = 'local'; flow = buildFlow(); idx = 0; render({ back: true }); return; }
    go(-1);
  });
  $('[data-setup-skip]').addEventListener('click', () => {
    if (flow[idx] === 'logo') { draft.org.logo = ''; extra.logoNote = null; renderLogo(); }
    if (flow[idx + 1] === 'ready') onNext(); else go(1);
  });
  $('[data-setup-cancel]').addEventListener('click', () => { leaveChecks(); ctx.done({ toAdmin: true, cancelled: true }); });
  $('[data-checks-again]').addEventListener('click', () => { extra.checking = true; runChecks(); });

  // Text fields write straight into the draft.
  $('[data-screen="setup"]').addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    const v = t.value.trim();
    switch (t.name) {
      case 's-org': draft.org.name = v; renderPreview(); break;
      case 's-tagline': draft.org.tagline = v; renderPreview(); break;
      case 's-admin': draft.admin.name = v; break;
      case 's-pin': case 's-pin2': renderPinChecks(); break;
      case 's-alerts': case 's-summary-to': draft.screening.alertEmails = v; break;
      case 's-key': break;
      case 'tr': {
        const key = extra.trKeys?.[Number(t.dataset.tr)];
        if (!key) break;
        const map = (draft.translations.es ||= {});
        if (!v || v === builtIn('es', key)) delete map[key]; else map[key] = v;
        const row = t.closest('li');
        if (row) row.dataset.state = v ? (map[key] ? 'custom' : 'built') : 'missing';
        renderTrTitle();
        break;
      }
      case 'q-text': {
        const q = draft.screening.questions.find((x) => x.id === extra.editing);
        if (q) { q.text = v; if (!q.template || !q.label) q.label = v.slice(0, 60); }
        break;
      }
      case 'q-options': {
        const q = draft.screening.questions.find((x) => x.id === extra.editing);
        if (q) {
          q.options = v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12);
          q.rule.answers = q.rule.answers.filter((a) => q.options.includes(a));
        }
        break;
      }
      case 'decline-custom': draft.screening.declineMessage = v; break;
      default: break;
    }
    $('[data-setup-error]').textContent = '';
  });
  // A finished question edit re-renders its card.
  $('[data-screen="setup"]').addEventListener('change', (e) => {
    if (['q-text', 'q-options'].includes(e.target.name)) renderBuilder();
  });

  $('[data-swatches]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-swatch]');
    if (b) setAccent(b.dataset.swatch);
  });
  $('[data-swatches]').addEventListener('input', (e) => {
    if (e.target.matches('[data-swatch-custom]')) setAccent(e.target.value.toLowerCase());
  });
  $('[data-setup-import]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const s = parseImport(await file.text());
      draft = { ...s, storage: connected() ? 'cloud' : s.storage };
      extra.screeningOn = activeCount(draft) > 0;
      flow = buildFlow();
      fillForm();
      setAccent(draft.org.accent);
      ctx.toast('Settings loaded. Check each step and choose an admin PIN for this tablet.');
    } catch (err) { ctx.toast(err.message); }
  });

  $('[data-logo-input]').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; chooseLogo(f); });
  $('[data-logo-replace]').addEventListener('click', () => $('[data-logo-input]').click());
  $('[data-logo-remove]').addEventListener('click', () => { draft.org.logo = ''; extra.logoNote = null; renderLogo(); });

  $('[data-agree-toggle]').addEventListener('click', (e) => {
    extra.agreed = !extra.agreed;
    e.currentTarget.setAttribute('aria-checked', String(extra.agreed));
    if (extra.agreed) $('[data-setup-error]').textContent = '';
  });
  // Licensing switched on or off while setup is open: the agreement step comes or goes.
  document.addEventListener('kiosk-license-changed', () => {
    if (!draft || edit || extra?.joining) return;
    const at = flow[idx];
    flow = buildFlow();
    idx = Math.max(0, flow.indexOf(at));
    render({ instant: true });
  });

  $('[data-badges-choice]').addEventListener('click', (e) => {
    const o = e.target.closest('.option');
    if (!o) return;
    draft.badges = o.dataset.value === 'yes';
    draft.passes = o.dataset.value === 'passes';
    renderChoice('[data-badges-choice]', o.dataset.value);
    renderBadgePanel();
  });
  $('[data-badge-chips]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unbadge]');
    if (!b) return;
    extra.badges.splice(Number(b.dataset.unbadge), 1);
    renderBadgePanel();
  });

  $('[data-storage-choice]').addEventListener('click', (e) => {
    const o = e.target.closest('.option');
    if (!o || o.disabled) return;
    if (o.dataset.value === 'cloud' && !can('cloud')) { ctx.upgrade('cloud'); return; }
    draft.storage = o.dataset.value;
    renderChoice('[data-storage-choice]', draft.storage);
    const at = flow[idx];
    flow = buildFlow();
    idx = flow.indexOf(at);
    renderBuilder();
    renderHosts();
    render({ instant: true });
  });

  $('[data-copy-script]').addEventListener('click', copyScript);
  $('[data-download-script]').addEventListener('click', () => downloadScript());
  $('[data-paste-url]').addEventListener('click', async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) { field('s-url').value = text; field('s-url').dispatchEvent(new Event('input', { bubbles: true })); }
    } catch { ctx.toast("Pasting isn't allowed here. Tap the field and type the URL, or open this setup on a computer."); }
  });
  $('[data-connect]').addEventListener('click', () => {
    ctx.kb.close();
    const api = val('s-url');
    if (!URL_RE.test(api)) {
      if (/docs\.google\.com/.test(api)) error("That's the link to the spreadsheet itself. Use the Web app URL from Deploy → Manage deployments (it ends in /exec).", field('s-url'));
      else if (/\/dev$/.test(api)) error("That's the test URL ending in /dev. Use the Web app URL ending in /exec.", field('s-url'));
      else error('The Web app URL should look like https://script.google.com/macros/s/…/exec', field('s-url'));
      return;
    }
    const key = extra.needKey ? val('s-key') : extra.key;
    if (extra.needKey && !/^[A-Za-z0-9-]{24,64}$/.test(key)) { error("That doesn't look like a kiosk key.", field('s-key')); return; }
    connect(api, key);
  });

  $('[data-screening-choice]').addEventListener('click', (e) => {
    const o = e.target.closest('.option');
    if (!o) return;
    extra.screeningOn = o.dataset.value === 'yes';
    renderChoice('[data-screening-choice]', o.dataset.value);
    renderBuilder();
  });
  $('[data-templates]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-template]');
    if (!b) return;
    addQuestion(fromTemplate(QUESTION_TEMPLATES.find((t) => t.key === b.dataset.template)));
  });
  $('[data-add-question]').addEventListener('click', () => {
    const q = normalizeQuestion({ id: uid(), text: '', type: 'yesno', rule: { action: 'none', answers: [] } });
    if (addQuestion(q) === false) return;
    extra.editing = q.id;
    renderBuilder();
    setTimeout(() => ctx.kb.open($('[data-qlist] input[name="q-text"]')), 50);
  });
  $('[data-qlist]').addEventListener('click', (e) => {
    const qs = draft.screening.questions;
    const t = e.target.closest('button');
    if (!t) return;
    const at = (attr) => Number(t.getAttribute(attr));
    if (t.hasAttribute('data-qedit')) { extra.editing = extra.editing === qs[at('data-qedit')].id ? null : qs[at('data-qedit')].id; }
    else if (t.hasAttribute('data-qdone')) { extra.editing = null; ctx.kb.close(); }
    else if (t.hasAttribute('data-qup')) { const i = at('data-qup'); [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; }
    else if (t.hasAttribute('data-qdown')) { const i = at('data-qdown'); [qs[i + 1], qs[i]] = [qs[i], qs[i + 1]]; }
    else if (t.hasAttribute('data-qdel')) { qs.splice(at('data-qdel'), 1); }
    else if (t.hasAttribute('data-qhit')) {
      const q = qs[at('data-qhit')];
      const v = t.dataset.value;
      q.rule.answers = q.rule.answers.includes(v) ? q.rule.answers.filter((a) => a !== v) : [...q.rule.answers, v];
      if (q.rule.action === 'none' && q.rule.answers.length) q.rule.action = 'decline';
    } else if (t.hasAttribute('data-qaction')) {
      const q = qs[at('data-qaction')];
      q.rule.action = t.dataset.value;
      if (q.rule.action === 'flag' && !q.rule.flagLabel) q.rule.flagLabel = q.label;
    } else if (t.hasAttribute('data-qevery')) {
      qs[at('data-qevery')].every = t.dataset.value === '1';
    } else if (t.hasAttribute('data-qtype')) {
      const q = qs.find((x) => x.id === extra.editing);
      if (q) {
        q.type = t.dataset.qtype;
        q.options = q.type === 'yesno' ? ['Yes', 'No'] : q.type === 'choice' ? (q.options.length > 2 || q.options[0] !== 'Yes' ? q.options : []) : [];
        q.rule.answers = q.rule.answers.filter((a) => q.options.includes(a));
        if (q.type === 'text') q.rule.action = 'none';
      }
    } else return;
    $('[data-setup-error]').textContent = '';
    renderBuilder();
  });
  $('[data-decline-presets]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-decline-preset]');
    if (!b) return;
    draft.screening.declineMessage = DECLINE_PRESETS[Number(b.dataset.declinePreset)];
    renderBuilder();
  });

  $('[data-photos-choice]').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    draft.photos = b.dataset.value;
    if (draft.photos === 'all' && !extra.quickTouched) draft.quickEntry = true;
    renderTouches();
  });
  $('[data-quick-toggle]').addEventListener('click', (e) => {
    if (e.currentTarget.disabled) return;
    if (!draft.quickEntry && !can('quickEntry')) { ctx.upgrade('quickEntry'); return; }
    extra.quickTouched = true;
    draft.quickEntry = !(draft.quickEntry && draft.photos === 'all');
    renderTouches();
  });
  $('[data-purpose-chips]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unpurpose]');
    if (!b) return;
    draft.form.purposes.splice(Number(b.dataset.unpurpose), 1);
    renderTouches();
  });
  $('[data-add-purpose]').addEventListener('click', () => {
    const v = val('s-purpose');
    if (!v) return;
    if (!draft.form.purposes.includes(v)) draft.form.purposes.push(v);
    field('s-purpose').value = '';
    ctx.kb.close();
    renderTouches();
  });
  $('[data-rules-edit]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unrule]');
    if (!b) return;
    draft.form.rules.splice(Number(b.dataset.unrule), 1);
    renderTouches();
  });
  $('[data-add-rule]').addEventListener('click', () => {
    const v = val('s-rule');
    if (!v) return;
    draft.form.rules.push(v);
    field('s-rule').value = '';
    ctx.kb.close();
    renderTouches();
  });
  $('[data-reset-rules]').addEventListener('click', () => { draft.form.rules = [...DEFAULT_RULES]; renderTouches(); });
  $('[data-eod-choice]').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    draft.endOfDay = b.dataset.value;
    renderTouches();
  });

  $('[data-add-host]').addEventListener('click', addHost);
  $('[data-host-list]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unhost]');
    if (!b) return;
    draft.hosts.splice(Number(b.dataset.unhost), 1);
    renderHosts();
  });
  $('[data-notify-toggle]').addEventListener('click', () => {
    if (!draft.notifyHosts && !can('hostEmails')) { ctx.upgrade('hostEmails'); return; }
    draft.notifyHosts = !draft.notifyHosts;
    renderHosts();
  });
  $('[data-sign-choice]').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.value !== 'off' && !can('signatures')) { ctx.upgrade('signatures'); return; }
    draft.signature = { ...draft.signature, mode: b.dataset.value };
    renderTouches();
  });
  $('[data-sign-email-toggle]').addEventListener('click', () => {
    draft.signature = { ...draft.signature, emailCopy: !draft.signature.emailCopy };
    renderTouches();
  });
  $('[data-retention-choice]').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    draft.retentionDays = Number(b.dataset.value);
    renderTouches();
  });
  $('[data-lang-toggle="es"]').addEventListener('click', () => {
    if (!draft.languages.includes('es') && !can('languages')) { ctx.upgrade('languages'); return; }
    draft.languages = draft.languages.includes('es') ? ['en'] : ['en', 'es'];
    renderLanguages();
  });
  $('[data-summary-toggle]').addEventListener('click', () => {
    if (!draft.dailySummary && !can('dailySummary')) { ctx.upgrade('dailySummary'); return; }
    draft.dailySummary = !draft.dailySummary;
    renderTouches();
    if (draft.dailySummary && !draft.screening.alertEmails) setTimeout(() => ctx.kb.open(field('s-summary-to')), 50);
  });

  // "Already set up on another tablet?" from the first step: connect straight to the sheet.
  const joinLink = document.createElement('p');
  joinLink.className = 'setup-import';
  joinLink.innerHTML = 'Already using this kiosk on another tablet with Google Sheets? <button type="button" class="link" data-setup-join>Connect this tablet to the same sheet</button>';
  stepEl('company').appendChild(joinLink);
  $('[data-setup-join]').addEventListener('click', () => {
    extra.joining = true;
    draft.storage = 'cloud';
    flow = ['connect'];
    idx = 0;
    render();
  });
}
