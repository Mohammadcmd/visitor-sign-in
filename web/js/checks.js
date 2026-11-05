// "Let's check this tablet": the first setup step, and Admin → Settings →
// Diagnostics → Check this tablet. Each check says plainly what's wrong and
// how to fix it. Nothing here is saved.
import * as face from './face.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const native = !!window.Capacitor?.isNativePlatform?.();

const CHECKS = [
  ['camera', 'Camera'],
  ['face', 'Face recognition'],
  ['reader', 'Badge reader'],
  ['internet', 'Internet'],
  ['clock', 'Date and time'],
  ['storage', 'Storage'],
  ['screen', 'Screen'],
  ['browser', 'Software'],
];

let run = 0;
let results = {};
let onChange = () => {};

function set(key, state, detail) {
  results[key] = { state, detail };
  const li = $(`[data-checks] [data-check="${key}"]`);
  if (li) {
    li.dataset.state = state;
    $('.ck-detail', li).innerHTML = detail;
  }
  summary();
}

function summary() {
  const vals = Object.values(results);
  const good = vals.filter((r) => r.state === 'ok').length;
  const bad = vals.filter((r) => r.state === 'warn' || r.state === 'fail').length;
  const waiting = vals.filter((r) => r.state === 'wait').length;
  const box = $('[data-checks-summary]');
  if (box) {
    box.textContent = waiting ? `Checking… ${good} of ${CHECKS.length} done.`
      : bad ? `${good} of ${CHECKS.length} look good, ${bad} need a look. You can carry on and fix them later.`
        : `All ${CHECKS.length} checks passed. This tablet is ready.`;
    box.className = `checks-summary ${bad ? 'warn' : waiting ? '' : 'ok'}`;
  }
  onChange(results);
}

/** The latest results: { camera: { state: 'ok' | 'warn' | 'fail' | 'wait' | 'info', detail } … }. */
export const checkResults = () => results;

/** Starts (or restarts) every check. */
export async function runChecks({ changed } = {}) {
  const me = ++run;
  onChange = changed || (() => {});
  results = {};
  const list = $('[data-checks]');
  list.innerHTML = CHECKS.map(([key, title]) => `<li data-check="${key}" data-state="wait"><span class="ck-state" aria-hidden="true"></span>
    <div><strong>${esc(title)}</strong><span class="ck-detail">Checking…</span></div></li>`).join('');
  CHECKS.forEach(([key]) => { results[key] = { state: 'wait', detail: '' }; });
  summary();
  checkScreen();
  checkBrowser();
  checkStorage();
  checkInternet(me);
  set('reader', 'wait', 'Tap any card or key fob on the reader now. <em>Skip this if you won\'t use badges.</em>');
  await checkCamera(me);
}

/** Stops the camera when the check is left. */
export function stopChecks() {
  run++;
  face.stopCamera();
}

/** A card was read while the check is open. */
export function readerTapped(tag) {
  set('reader', 'ok', `Works: card …${esc(tag.slice(-6))} read. Tap more cards to try them too.`);
}

function checkScreen() {
  const w = innerWidth, h = innerHeight;
  const size = `${screen.width} × ${screen.height}`;
  if (Math.min(w, h) < 600) set('screen', 'warn', `${size}. This screen is small: a 10-inch tablet is easiest for visitors.`);
  else if (h > w) set('screen', 'warn', `${size}, upright. The kiosk works upright, but sideways (landscape) shows more: turn the tablet.`);
  else set('screen', 'ok', `${size}, sideways. A good size.`);
}

function checkBrowser() {
  const missing = [];
  if (!navigator.mediaDevices?.getUserMedia) missing.push('camera access');
  if (!window.crypto?.subtle) missing.push('secure codes');
  if (!window.indexedDB) missing.push('photo storage');
  if (!window.isSecureContext) missing.push('a secure (HTTPS) address');
  const chrome = Number((/Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent) || [])[1] || 0);
  if (missing.length) {
    set('browser', 'fail', `Missing ${missing.join(', ')}. ${!window.isSecureContext ? 'Open the kiosk at its https:// address. ' : ''}${native ? 'Update Android System WebView in the Play Store.' : 'Use an up-to-date Chrome or Safari.'}`);
  } else if (chrome && chrome < 90) {
    set('browser', 'warn', `${native ? 'Android System WebView' : 'Chrome'} ${chrome} is old and may be slow. Update it in the Play Store.`);
  } else {
    set('browser', 'ok', native ? `Android app${chrome ? `, WebView ${chrome}` : ''}. Up to date.` : `Up to date${chrome ? ` (Chrome ${chrome})` : ''}.`);
  }
}

async function checkStorage() {
  try {
    let kept = native;
    if (!kept && navigator.storage?.persist) kept = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    const est = await navigator.storage?.estimate?.();
    const free = est ? (est.quota - est.usage) / 1e9 : 0;
    const room = est ? ` ${free >= 1 ? `${free.toFixed(1)} GB` : `${Math.round(free * 1000)} MB`} free.` : '';
    if (kept) set('storage', 'ok', `Records saved on this tablet stay there.${room}`);
    else set('storage', 'warn', `The browser may clear saved records if it runs low on space.${room} Add the kiosk to the Home Screen, or use the Android app. (Not a worry with Google Sheets.)`);
  } catch {
    set('storage', 'warn', "Couldn't check the storage. Records on this tablet may not be kept by this browser.");
  }
}

async function checkInternet(me) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown time zone';
  const now = new Date().toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const clockText = `${now}, ${zone.replace(/_/g, ' ')}.`;
  if (!navigator.onLine) {
    set('internet', 'warn', 'Offline. Records kept on this tablet work without internet; Google Sheets, emails and updates need it. Check the Wi-Fi.');
    set('clock', 'info', `${clockText} If this is wrong, set the date, time and time zone in the tablet's settings.`);
    return;
  }
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`manifest.webmanifest?check=${Date.now()}`, { cache: 'no-store' });
  } catch {
    if (me !== run) return;
    set('internet', 'fail', "Can't reach the network. Check the Wi-Fi.");
    set('clock', 'info', `${clockText} If this is wrong, set the date, time and time zone in the tablet's settings.`);
    return;
  }
  const ms = Math.round(performance.now() - t0);
  let google = true;
  try { await fetch('https://script.google.com/favicon.ico', { mode: 'no-cors', cache: 'no-store' }); } catch { google = false; }
  if (me !== run) return;
  set('internet', google ? 'ok' : 'warn', google ? `Online, ${ms < 400 ? 'fast' : 'a little slow'} (${ms} ms). Google can be reached.` : "Online, but Google can't be reached. A firewall may block it: Google Sheets needs script.google.com.");
  const server = Date.parse(res.headers.get('date') || '');
  const off = Number.isNaN(server) ? 0 : Math.round((Date.now() - server) / 60000);
  if (Math.abs(off) >= 5) set('clock', 'warn', `${clockText} The clock is about ${Math.abs(off)} minutes ${off > 0 ? 'fast' : 'slow'}: turn on automatic date and time in the tablet's settings.`);
  else set('clock', 'ok', `${clockText} If the time zone is wrong, change it in the tablet's settings.`);
}

async function checkCamera(me) {
  const video = $('[data-video="check"]');
  const label = $('[data-cam-test-label]');
  label.textContent = 'Starting the camera…';
  try {
    await face.startCamera(video);
  } catch (err) {
    if (me !== run) return;
    const name = err?.name || '';
    const how = native ? "Settings → Apps → Visitor Sign-In → Permissions → Camera → Allow" : 'the camera button in the address bar, or Settings → Safari → Camera → Allow on an iPad';
    const text = name === 'NotAllowedError' ? `The camera is blocked. Allow it: ${how}. Then tap Check again.`
      : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No camera found. Photos and quick entry need a front camera; everything else works without one.'
        : name === 'NotReadableError' ? 'Another app is using the camera. Close it, then tap Check again.'
          : `The camera didn't start (${esc(err?.message || name || 'unknown problem')}). Tap Check again.`;
    set('camera', 'fail', text);
    set('face', 'info', 'Needs the camera.');
    label.textContent = 'No camera';
    return;
  }
  if (me !== run) return;
  label.textContent = 'Camera on';
  set('camera', 'ok', `Works (${video.videoWidth} × ${video.videoHeight}). You should see yourself in the preview.`);
  set('face', 'wait', 'Loading face recognition…');
  try {
    await face.loadModels();
  } catch {
    if (me !== run) return;
    set('face', 'warn', "Face recognition couldn't load, so quick entry won't work. Photos and everything else do. Check the internet and tap Check again.");
    return;
  }
  const until = Date.now() + 20000;
  while (me === run && Date.now() < until) {
    set('face', 'wait', 'Look at the camera…');
    const d = await face.describe(face.snapshot(video, 640).canvas).catch(() => null);
    if (me !== run) return;
    if (d) { set('face', 'ok', 'Works: a face was found. Quick entry can recognize returning visitors.'); return; }
    await new Promise((r) => setTimeout(r, 700));
  }
  if (me === run) set('face', 'warn', 'No face seen yet. Face the camera in good light and tap Check again. (Only quick entry needs this.)');
}
