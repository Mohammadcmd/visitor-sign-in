// End-to-end test of the kiosk in web/: runs it in Chromium with a fake camera.
//   node tests/kiosk.e2e.js            (SHOTS=dir to save screenshots)
// 1. Setup on this tablet, with badges and screening questions, then a normal
//    sign-in, a declined visitor, a staff override, the admin screen and a sign-out.
// 2. Setup with Google Sheets (the real apps-script/Code.gs, running on the fakes
//    in tests/fake-google.js) and no badges, then a second tablet joining by link.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium, devices } = require('playwright');
const { loadBackend } = require('./fake-google');
const { execFileSync } = require('child_process');
const os = require('os');

// The whole repository is served, like GitHub Pages: the install page at /, the kiosk at /web/.
const WEB = path.join(__dirname, '..');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(WEB, 'package.json'), 'utf8')).version;
const SHOTS = process.env.SHOTS || '';
const PIN = '482916';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const EXEC = 'https://script.google.com/macros/s/TEST-deployment_1/exec';
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(WEB, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html')));
      if (!p.startsWith(WEB) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(0, () => resolve(srv));
  });
}

async function open(browser, url, backend, { offline = false, device = null } = {}) {
  // The offline cache stays out of the way except in the test made for it.
  const ctx = await browser.newContext({ ...(device || { viewport: { width: 1280, height: 800 } }), permissions: ['camera', 'clipboard-read', 'clipboard-write'], serviceWorkers: offline ? 'allow' : 'block' });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  await ctx.route('https://api.github.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      tag_name: 'v9.9.9', html_url: 'https://github.com/example/visitor-sign-in/releases/tag/v9.9.9',
      assets: [{ name: 'visitor-sign-in-9.9.9.apk', size: 12e6, browser_download_url: 'https://github.com/example/visitor-sign-in/releases/download/v9.9.9/visitor-sign-in-9.9.9.apk' }],
    }),
  }));
  // Only the backend address is faked: the tablet check's reachability test goes to the real network
  // (an intercepted reply can't answer a no-cors request).
  await ctx.route('https://script.google.com/macros/**', async (route) => {
    if (route.request().method() !== 'POST' || !backend) { await route.continue(); return; }
    const out = backend.handle(JSON.parse(route.request().postData()));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  await page.goto(url);
  return page;
}

let shot = 0;
async function snap(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, '0')}-${name}.png`) });
}

const view = (page) => page.evaluate(() => document.body?.dataset.view);
async function waitView(page, name) {
  await page.waitForFunction((n) => document.body?.dataset.view === n, name, { timeout: 15000 });
  await page.waitForTimeout(500);
}
/** Types into a kiosk field with the on-screen keyboard's hardware-key path (slow enough not to look like a badge tap). */
async function type(page, sel, text) {
  await page.click(sel);
  await page.keyboard.type(text, { delay: 55 });
  await page.waitForTimeout(150);
}
/** Faster: sets the value like the keyboard does. */
async function set(page, sel, text) {
  await page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, text);
}
async function tapBadge(page, tag) {
  await page.keyboard.type(tag, { delay: 4 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}
const next = (page) => page.click('[data-setup-next]');
const formNext = async (page) => { await page.click('[data-form-next]'); await page.waitForTimeout(700); };
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const step = (page) => page.$eval('[data-screen="form"] .step.active', (el) => el.dataset.step);
async function enterPin(page, pin) {
  for (const d of pin) await page.click(`[data-pin-pad] button:text-is("${d}")`);
  await page.click('[data-pin="go"]');
}
/** Signs the signature pad with a mouse "finger": a looping scribble. */
async function sign(page) {
  await page.$eval('[data-sign-pad]', (el) => el.scrollIntoView({ block: 'center' }));
  const box = await page.$eval('[data-sign-pad]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + 40, box.y + box.h * 0.6);
  await page.mouse.down();
  for (let i = 0; i <= 24; i++) await page.mouse.move(box.x + 40 + i * 12, box.y + box.h * (0.6 + 0.22 * Math.sin(i / 2)), { steps: 2 });
  await page.mouse.up();
}

async function holdLogo(page) {
  const box = await page.$eval('[data-admin-hold]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.waitForTimeout(2700);
  await page.mouse.up();
}


async function signInNewVisitor(page, { first, last, citizen, country, sick = 'No', expected = false, lang = '' }) {
  if (lang) await page.click(`[data-lang-pick] [data-lang="${lang}"]`);
  else await page.click('[data-screen="welcome"]');
  await waitView(page, 'choice');
  if (lang === 'es') {
    ok(/¿Ha visitado Acme Robotics antes\?/.test(await text(page, '[data-screen="choice"] h2')), 'choice screen in Spanish');
    ok(await text(page, '[data-lang-switch]') === 'English', 'a switch back to English');
    await snap(page, 'es-choice');
  }
  await page.click('[data-action="new"]');
  await waitView(page, 'form');
  ok(await step(page) === 'intro', 'form starts with the intro');
  if (lang === 'es') {
    ok(/Regístrese antes de su visita/.test(await text(page, '[data-intro]')) && /Algunos de los productos/.test(await text(page, '[data-intro]')), 'intro in Spanish, with the question\'s note');
    ok(await text(page, '[data-form-next]') === 'Empecemos', 'buttons in Spanish');
  }
  await formNext(page);
  await type(page, 'input[name="first"]', first);
  if (lang === 'es') {
    ok(await page.$eval('[data-step="name"] h2', (e) => e.textContent) === '¿Cómo se llama?', 'name step in Spanish');
    await page.dispatchEvent('[data-key="accents"]', 'pointerdown');
    ok(await page.$('[data-keyboard] [data-key="ñ"]') !== null, 'accents on the keyboard');
    await page.dispatchEvent('[data-key="abc"]', 'pointerdown');
    ok(await text(page, '[data-keyboard] .kb-space') === 'espacio', 'keyboard labels in Spanish');
  }
  await set(page, 'input[name="last"]', last);
  await formNext(page);
  if (expected) {
    await page.waitForSelector('[data-expected-note]:not([hidden])');
    ok(/We're expecting you\. Pat Kim will be told/.test(await text(page, '[data-expected-note]')), 'expected visitor greeted');
    ok(await page.$eval('input[name="company"]', (e) => e.value) === 'Globex' && await page.$eval('input[name="purpose"]', (e) => e.value) === 'Quarterly review', 'visit details filled in from the expected list');
    await snap(page, 'expected-greeting');
  }
  await set(page, 'input[name="company"]', 'Globex');
  if (!expected) {
    await type(page, 'input[name="visiting"]', 'pa');
    await page.waitForSelector('[data-host-suggest] .chip');
    await page.click('[data-host-suggest] .chip:has-text("Pat Kim")');
  }
  ok(await page.$eval('input[name="visiting"]', (e) => e.value) === 'Pat Kim', expected ? 'host filled in for the expected visitor' : 'host picked from the suggestions');
  if (!expected) await page.click('[data-chips="purpose"] .chip >> nth=0');
  await formNext(page);
  ok((await step(page)).startsWith('q:'), 'screening question follows the visit details');
  if (lang === 'es') {
    ok(/Ciudadano\/a de EE\. UU\./.test(await text(page, '[data-screen="form"] .step.active .options')), 'answers shown in Spanish');
    await snap(page, 'es-question');
  }
  await page.click(`[data-screen="form"] .step.active .option[data-value="${citizen}"]`);
  if (country) await set(page, '[data-screen="form"] .step.active [data-followup] input', country);
  await formNext(page);
  await page.click(`[data-screen="form"] .step.active .option[data-value="${sick}"]`);
  await formNext(page);
  ok(await step(page) === 'photo', 'photo step after the questions');
  await page.waitForFunction(() => document.querySelector('[data-video="photo"]').videoWidth > 0);
  await page.click('[data-capture]');
  await page.waitForFunction(() => !document.querySelector('[data-shot]').hidden, null, { timeout: 8000 });
}

(async () => {
  const srv = await serve();
  const site = `http://localhost:${srv.address().port}/`;
  const base = `${site}web/`;
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    // ================================================================ 1. on this tablet
    const page = await open(browser, base);
    await waitView(page, 'setup');
    ok(await page.$eval('[data-sstep="device"]', (e) => e.classList.contains('active')), 'setup starts by checking the tablet');
    await page.waitForSelector('[data-check="camera"][data-state="ok"]', { timeout: 10000 });
    await page.waitForSelector('[data-check="internet"]:not([data-state="wait"])');
    ok(/Tap any card/.test(await text(page, '[data-check="reader"]')), 'asks for a card');
    await tapBadge(page, '04CC778899');
    ok(await page.$eval('[data-check="reader"]', (e) => e.dataset.state === 'ok' && /…778899/.test(e.textContent)), 'the card read shows up');
    ok(await page.$eval('[data-check="clock"]', (e) => /\d/.test(e.textContent)), 'shows the date and time');
    await snap(page, 'setup-device');
    await next(page);
    await page.waitForTimeout(600);
    ok(await page.evaluate(() => !document.querySelector('[data-video="check"]').srcObject || document.querySelector('[data-video="check"]').srcObject.getTracks().every((tr) => tr.readyState === 'ended')), 'the camera stops after the check');
    await snap(page, 'setup-company');
    await next(page);
    ok(/company name/.test(await text(page, '[data-setup-error]')), 'company name is required');
    await type(page, 'input[name="s-org"]', 'Acme Robotics');
    await set(page, 'input[name="s-tagline"]', 'Automation since 1999');
    await page.click('[data-swatch="#047857"]');
    ok(await page.$eval('[data-preview-name]', (e) => e.textContent) === 'Acme Robotics', 'preview shows the name');
    await next(page);
    await page.waitForTimeout(600);

    await set(page, 'input[name="s-admin"]', 'Jordan Lee');
    await type(page, 'input[name="s-pin"]', '123456');
    await set(page, 'input[name="s-pin2"]', '123456');
    await next(page);
    ok(/too easy/.test(await text(page, '[data-setup-error]')), 'easy PIN refused');
    await set(page, 'input[name="s-pin"]', PIN);
    await set(page, 'input[name="s-pin2"]', '482917');
    await next(page);
    ok(/match/.test(await text(page, '[data-setup-error]')), 'mismatched PINs refused');
    await set(page, 'input[name="s-pin2"]', PIN);
    await snap(page, 'setup-admin');
    await next(page);
    await page.waitForTimeout(600);

    // A PNG with a transparent background and a bar in the middle.
    const logo = Buffer.from((await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 400; c.height = 160;
      const g = c.getContext('2d');
      g.fillStyle = '#0b6e4f'; g.fillRect(40, 50, 320, 60);
      return c.toDataURL('image/png');
    })).split(',')[1], 'base64');
    await page.setInputFiles('[data-logo-input]', { name: 'logo.png', mimeType: 'image/png', buffer: logo });
    await page.waitForSelector('[data-logo-note]:not([hidden])');
    ok(/transparent/.test(await text(page, '[data-logo-note]')), 'transparent logo recognized');
    await snap(page, 'setup-logo');
    await next(page);
    await page.waitForTimeout(600);

    // Badges: yes, tap two cards.
    await tapBadge(page, '04A1B2C3D4');
    await tapBadge(page, '04FFEE0011');
    ok(/2 badges/.test(await text(page, '[data-badge-panel-title]')), 'two badges registered during setup');
    await snap(page, 'setup-badges');
    await next(page);
    await page.waitForTimeout(600);

    await snap(page, 'setup-storage');
    await page.click('[data-storage-choice] .option[data-value="local"]');
    await next(page);
    await page.waitForTimeout(600);

    // Screening: U.S. person (decline) and illness (decline).
    await page.click('[data-screening-choice] .option[data-value="yes"]');
    await page.click('[data-template="us-person"]');
    await page.click('[data-template="illness"]');
    ok(await page.$$eval('[data-qlist] .qcard', (l) => l.length) === 2, 'two questions added');
    await snap(page, 'setup-screening');
    await next(page);
    await page.waitForTimeout(600);

    // Hosts: names only on this tablet (no emails without Google Sheets).
    ok(await page.$eval('[data-sstep="hosts"]', (e) => e.classList.contains('active')), 'hosts step after screening');
    ok(await page.$eval('[data-notify-toggle]', (e) => e.hidden) && await page.$eval('[data-notify-local]', (e) => !e.hidden), 'host emails need Google Sheets');
    await set(page, 'input[name="s-host-name"]', 'Pat Kim');
    await page.click('[data-add-host]');
    await set(page, 'input[name="s-host-name"]', 'Lee Chen');
    await set(page, 'input[name="s-host-email"]', 'not-an-email');
    await next(page);
    ok(/Check this email/.test(await text(page, '[data-setup-error]')), 'bad host email refused');
    await set(page, 'input[name="s-host-email"]', 'lee@acme.example');
    await next(page);
    await page.waitForTimeout(600);
    ok(await page.$eval('[data-sstep="touches"]', (e) => e.classList.contains('active')), 'a host typed but not added is added on Continue');

    await page.click('[data-photos-choice] [data-value="all"]');
    await page.click('[data-eod-choice] [data-value="23:59"]');
    await page.click('[data-retention-choice] [data-value="90"]');
    await page.click('[data-sign-choice] [data-value="new"]');
    ok(await page.$eval('[data-sign-email-toggle]', (e) => e.hidden), 'emailing a copy needs Google Sheets');
    await page.click('[data-lang-toggle="es"]');
    ok(/still shown in English/.test(await text(page, '[data-translations-title]')), 'the tagline needs a translation');
    ok(await page.$eval('[data-tr-list] li[data-state="built"] input', (e) => e.value.length > 0), 'built-in translations filled in');
    await set(page, '[data-tr-list] li[data-state="missing"] input', 'Automatización desde 1999');
    ok(/^All \d+ translated$/.test(await text(page, '[data-translations-title]')), 'everything translated');
    await snap(page, 'setup-languages');
    await snap(page, 'setup-touches');
    await next(page);
    await page.waitForFunction(() => document.querySelector('[data-setup-count]').textContent === 'Setup complete');
    await snap(page, 'setup-ready');
    const summary = await text(page, '[data-summary]');
    ok(/2 people/.test(summary) && /11:59/.test(summary) && /English, Español/.test(summary) && /90 days, then deleted/.test(summary), 'summary lists hosts, end of day, retention and languages');
    await next(page);
    await waitView(page, 'welcome');
    ok(await page.$eval('[data-org-name]', (e) => e.textContent) === 'Acme Robotics', 'welcome shows the company');
    ok(await page.$$eval('[data-lang-pick] button', (l) => l.map((b) => b.textContent).join('|')) === 'English|Español', 'language buttons on the welcome screen');
    await snap(page, 'welcome');

    // The front desk adds an expected visitor.
    await holdLogo(page);
    await page.waitForSelector('[data-overlay="pin"]:not([hidden])');
    await enterPin(page, PIN);
    await waitView(page, 'admin');
    await page.click('[data-admin-tab="expected"]');
    await page.waitForSelector('[data-expected-list] .empty');
    await page.click('[data-expected-new]');
    await page.click('[data-expected-save]');
    ok(/first and last name/.test(await text(page, '[data-expected-error]')), 'expected visitor needs a name');
    await set(page, 'input[name="e-first"]', 'Ana');
    await set(page, 'input[name="e-last"]', 'Lopez');
    await set(page, 'input[name="e-company"]', 'Globex');
    await type(page, 'input[name="e-host"]', 'pa');
    await page.click('[data-expected-hosts] [data-host="Pat Kim"]');
    await set(page, 'input[name="e-purpose"]', 'Quarterly review');
    await set(page, 'input[name="e-note"]', 'Bring the NDA');
    await snap(page, 'expected-form');
    await page.click('[data-expected-save]');
    await page.waitForSelector('[data-expected-list] .exp-row');
    ok(/Ana Lopez/.test(await text(page, '[data-expected-list]')) && /Expected/.test(await text(page, '[data-expected-list] .pill')), 'expected visitor listed');
    ok(await text(page, '[data-expected-count]') === '1', 'tab shows one expected today');
    await page.click('[data-admin-exit]');
    await waitView(page, 'welcome');

    // A normal sign-in with a badge.
    await signInNewVisitor(page, { first: 'Ana', last: 'Lopez', citizen: 'U.S. citizen', expected: true });
    await formNext(page);
    ok(await step(page) === 'rules', 'rules after the photo');
    ok(await page.$eval('[data-agree]', (e) => e.hidden) && await page.$eval('[data-sign-box]', (e) => !e.hidden), 'a signature instead of the tick box');
    await formNext(page);
    ok(/Please sign in the box/.test(await text(page, '[data-form-error]')), 'signing is required');
    await page.mouse.click(...(await page.$eval('[data-sign-pad]', (el) => { const r = el.getBoundingClientRect(); return [r.x + 50, r.y + 50]; })));
    await formNext(page);
    ok(await step(page) === 'rules', 'a single tap is not a signature');
    await sign(page);
    ok(await page.$eval('[data-sign-pad]', (c) => { const r = c.getBoundingClientRect(); return r.bottom <= innerHeight - 90; }), 'the signature pad fits on the screen above the buttons');
    ok(await page.$eval('.sign-area', (e) => e.classList.contains('signed')), 'the pad shows it is signed');
    await page.click('[data-sign-clear]');
    ok(!(await page.$eval('.sign-area', (e) => e.classList.contains('signed'))), 'Clear starts over');
    await sign(page);
    await snap(page, 'signature');
    await formNext(page);
    ok(await step(page) === 'quick', 'quick entry question last');
    await page.click('[data-quick="no"]');
    await waitView(page, 'badge');
    await page.waitForTimeout(800);
    await tapBadge(page, '04A1B2C3D4');
    await page.waitForTimeout(1500);
    await waitView(page, 'done');
    await page.waitForTimeout(1200);
    ok(/V1/.test(await text(page, '[data-done-badge]')), 'badge V1 handed out');
    await snap(page, 'done');
    await page.click('[data-screen="done"] [data-go="welcome"]');
    await waitView(page, 'welcome');

    // A declined visitor: photo, then the polite message.
    await signInNewVisitor(page, { first: 'Boris', last: 'Ivanov', citizen: 'Not a U.S. citizen or permanent resident', country: 'Canada' });
    await snap(page, 'decline-photo');
    await formNext(page);
    await waitView(page, 'declined');
    ok(/unable to sign you in/.test(await text(page, '[data-declined-text]')), 'polite decline message');
    await snap(page, 'declined');

    // Staff override on the spot.
    await page.click('[data-staff-override]');
    await enterPin(page, PIN);
    await page.waitForSelector('[data-overlay="reason"]:not([hidden])');
    await page.click('[data-reason-chips] .chip >> nth=0');
    await snap(page, 'override-reason');
    await page.click('[data-reason-ok]');
    await waitView(page, 'form');
    ok(await step(page) === 'rules', 'override continues at the rules');
    await sign(page);
    await formNext(page);
    await page.click('[data-quick="no"]');
    await waitView(page, 'badge');
    await tapBadge(page, '04FFEE0011');
    await waitView(page, 'done');
    await page.click('[data-screen="done"] [data-go="welcome"]');
    await waitView(page, 'welcome');

    // A second declined visitor stays declined.
    await signInNewVisitor(page, { first: 'Cara', last: 'Smith', citizen: 'U.S. citizen', sick: 'Yes', lang: 'es' });
    await formNext(page);
    await waitView(page, 'declined');
    ok(/Lamentablemente, hoy no podemos registrar su entrada/.test(await text(page, '[data-declined-text]')) && await text(page, '[data-declined-title]') === 'Gracias, Cara', 'decline message in Spanish');
    await snap(page, 'es-declined');
    await page.click('[data-screen="declined"] [data-go="welcome"]');
    await waitView(page, 'welcome');
    ok(/Tap anywhere to get started/.test(await text(page, '.tap-cta')) && await page.$eval('html', (e) => e.lang) === 'en', 'back to English for the next visitor');
    await page.waitForFunction(() => !document.querySelector('[data-attn-dot]').hidden, null, { timeout: 8000 });
    ok(true, 'attention dot on the welcome screen');

    // Admin screen.
    await holdLogo(page);
    await page.waitForSelector('[data-overlay="pin"]:not([hidden])');
    await enterPin(page, PIN);
    await waitView(page, 'admin');
    await page.waitForSelector('[data-inside-list] .admin-row');
    const inside = await page.$$eval('[data-inside-list] .admin-row', (l) => l.map((r) => r.textContent.replace(/\s+/g, ' ')));
    ok(inside.length === 2, 'two visitors inside');
    ok(inside.some((r) => /Boris Ivanov/.test(r) && /override/i.test(r)), 'override shown on the visit');
    await snap(page, 'admin-inside');
    await page.click('[data-admin-tab="attention"]');
    await page.waitForSelector('[data-attn-list] .attn-row');
    const attn = await page.$$eval('[data-attn-list] .attn-row', (l) => l.map((r) => r.textContent.replace(/\s+/g, ' ')));
    ok(attn.some((r) => /Cara Smith/.test(r) && /Illness/.test(r)), 'declined visitor needs attention');
    ok(await page.$$eval('[data-attn-list] .attn-photo', (l) => l.length) >= 1, 'declined visitor photo shown');
    await snap(page, 'admin-attention');
    await page.click('[data-admin-tab="expected"]');
    await page.waitForSelector('[data-expected-list] .pill.arrived');
    ok(/Arrived/.test(await text(page, '[data-expected-list] .pill')), 'expected visitor marked arrived');

    // History and the CSV export.
    await page.click('[data-admin-tab="history"]');
    await page.waitForSelector('[data-history-list] .history-row');
    ok(await page.$$eval('[data-history-list] .history-row', (l) => l.length) === 4, 'history shows every visit and decline');
    await snap(page, 'admin-history');
    ok(await page.$$eval('[data-history-list] [data-signed]', (l) => l.length) === 2, 'the two visitors who signed have a signed copy');
    await page.click('[data-history-list] .history-row:has-text("Ana Lopez") [data-signed]');
    await page.waitForSelector('[data-overlay="signed"]:not([hidden])');
    ok(await text(page, '[data-signed-title]') === 'Ana Lopez' && /I will stay with my host/.test(await text(page, '[data-signed-rules]')), 'the signed copy shows the rules she signed');
    ok(await page.$eval('[data-signed-image]', (img) => img.src.startsWith('data:image/png') && img.naturalWidth > 50), 'and her signature');
    await snap(page, 'signed-copy');
    await page.click('[data-signed-close]');
    const [csv] = await Promise.all([page.waitForEvent('download'), page.click('[data-export-visits]')]);
    const csvText = fs.readFileSync(await csv.path(), 'utf8');
    ok(/^\ufeffSigned in,Signed out,First name/.test(csvText) && /Cara,Smith/.test(csvText) && csvText.trim().split('\r\n').length === 5, 'visits CSV');
    ok(/Signed copy/.test(csvText.split('\r\n')[0]) && /Ana,Lopez.*,Yes\r?$/m.test(csvText), 'the CSV says who signed');
    ok(/Cara,Smith,Globex,Pat Kim,Meeting,/.test(csvText), 'a reason picked in Spanish is recorded in English');
    const [people] = await Promise.all([page.waitForEvent('download'), page.click('[data-export-visitors]')]);
    const peopleText = fs.readFileSync(await people.path(), 'utf8');
    ok(/Citizenship status/.test(peopleText.split('\r\n')[0]) && /Ana,Lopez/.test(peopleText), 'visitors CSV with the screening answers');
    await type(page, 'input[name="h-search"]', 'ivanov');
    await page.waitForFunction(() => document.querySelectorAll('[data-history-list] .history-row').length === 2);
    ok(true, 'history search finds both of his records (the decline and the visit)');

    // Roll call.
    await page.click('[data-admin-tab="inside"]');
    await page.waitForSelector('[data-inside-list] .admin-row');
    await page.click('[data-rollcall-open]');
    await page.waitForSelector('[data-overlay="rollcall"]:not([hidden]) .roll-card');
    await page.waitForFunction(() => document.querySelectorAll('.roll-card img.roll-face').length === 2, null, { timeout: 8000 });
    ok(true, 'roll call shows each visitor with their photo');
    await page.click('.roll-card >> nth=0');
    ok(await text(page, '[data-rollcall-done]') === '1', 'one accounted for');
    await snap(page, 'rollcall');
    await page.click('[data-rollcall-close]');
    ok(/not accounted for/.test(await text(page, '[data-rollcall-close]')), 'closing early asks again');
    await page.click('.roll-card:not(.seen)');
    ok(await page.$eval('[data-overlay="rollcall"]', (e) => e.classList.contains('all-done')), 'everyone accounted for');
    await page.click('[data-rollcall-close]');
    ok(await page.$eval('[data-overlay="rollcall"]', (e) => e.hidden), 'roll call closed');

    await page.click('[data-admin-tab="badges"]');
    await page.waitForSelector('[data-badge-list] .admin-row');
    ok(await page.$$eval('[data-badge-list] .admin-row', (l) => l.length) === 2, 'badges from setup listed');
    await page.click('[data-admin-tab="settings"]');
    await page.waitForSelector('[data-settings-rows] .set-row');
    await page.waitForFunction(() => /App version/.test(document.querySelector('[data-diagnostics]').textContent));
    const diag = await text(page, '[data-diagnostics]');
    ok(diag.includes(APP_VERSION) && /On this tablet/.test(diag) && /Last card read/.test(diag), `diagnostics: ${diag.slice(0, 120)}`);
    await page.waitForSelector('[data-update-box]:not([hidden])');
    ok(/Version 9\.9\.9 is available/.test(await text(page, '[data-update-box]')) && await page.$('[data-update-box] svg.qr'), 'a newer release is offered, with a QR code');
    await page.click('[data-run-checks]');
    await waitView(page, 'setup');
    await page.waitForSelector('[data-check="camera"][data-state="ok"]', { timeout: 10000 });
    ok(await text(page, '[data-setup-next]') === 'Done', 'the tablet check from the admin screen');
    await next(page);
    await waitView(page, 'admin');
    const purge = await page.evaluate(async () => (await import('./js/api.js')).call('purgeOld'));
    ok(purge.ok && purge.removed && purge.removed.visits === 0, 'nothing recent is deleted');
    await snap(page, 'admin-settings');
    // Edit the company name from settings.
    await page.click('[data-edit="company"]');
    await waitView(page, 'setup');
    await set(page, 'input[name="s-org"]', 'Acme Robotics Inc');
    await next(page);
    await waitView(page, 'admin');
    await page.click('[data-admin-exit]');
    await waitView(page, 'welcome');
    ok(await page.$eval('[data-org-name]', (e) => e.textContent) === 'Acme Robotics Inc', 'edited name on the welcome screen');

    // Sign out with the badge.
    await tapBadge(page, '04A1B2C3D4');
    await page.waitForSelector('[data-overlay="signout"]:not([hidden])');
    ok(/Goodbye, Ana/.test(await text(page, '[data-signout-title]')), 'signed out by badge');
    await snap(page, 'signout');
    // End of day signs out whoever is left (Boris) and frees his badge.
    const eod = await page.evaluate(async () => (await import('./js/api.js')).call('endOfDay', { before: new Date().toISOString() }));
    ok(eod.ok && eod.signedOut === 1, `end of day: ${JSON.stringify(eod)}`);
    const v2 = await page.evaluate(async () => (await (await import('./js/api.js')).call('adminLogin', { pin: '482916' })).token)
      .then((t) => page.evaluate(async (tok) => (await (await import('./js/api.js')).call('adminBadges', { token: tok })).badges.find((b) => b.badge === 'V2'), t));
    ok(v2.status === 'not returned' && /Boris Ivanov/.test(v2.note), 'badge left with the visitor is marked not returned');
    await page.waitForTimeout(3200); // the reader ignores the same card again within 3 seconds
    await tapBadge(page, '04FFEE0011');
    await page.waitForFunction(() => /Thanks for bringing back badge V2/.test(document.querySelector('[data-toast]').textContent));
    ok(true, 'returned badge thanked at the welcome screen');
    ok(!page.errors.length, `no page errors: ${page.errors.join(' | ')}`);
    await page.context().close();

    // ================================================================ 2. Google Sheets, no badges
    const backend = loadBackend();
    const cloud = await open(browser, base, backend);
    await waitView(cloud, 'setup');
    await next(cloud); await cloud.waitForTimeout(600);
    await set(cloud, 'input[name="s-org"]', 'Initech');
    await next(cloud); await cloud.waitForTimeout(600);
    await set(cloud, 'input[name="s-admin"]', 'Sam Ortiz');
    await set(cloud, 'input[name="s-pin"]', PIN);
    await set(cloud, 'input[name="s-pin2"]', PIN);
    await next(cloud); await cloud.waitForTimeout(600);
    await cloud.click('[data-setup-skip]'); await cloud.waitForTimeout(600);
    // Numbered visitor passes, no reader: the kiosk says which one to take.
    await cloud.click('[data-badges-choice] .option[data-value="passes"]');
    ok(await cloud.$eval('[data-pass-panel]', (e) => !e.hidden), 'numbered passes ask how many');
    await set(cloud, 'input[name="s-passes"]', '500');
    await next(cloud); await cloud.waitForTimeout(600);
    ok(/from 1 to 200/.test(await text(cloud, '[data-setup-error]')), 'a sensible number of passes');
    await set(cloud, 'input[name="s-passes"]', '3');
    await snap(cloud, 'setup-passes');
    await next(cloud); await cloud.waitForTimeout(600);
    await cloud.click('[data-storage-choice] .option[data-value="cloud"]');
    await snap(cloud, 'cloud-storage');
    await next(cloud); await cloud.waitForTimeout(600);
    ok(await cloud.$eval('[data-sstep="connect"]', (e) => e.classList.contains('active')), 'connect step shown');
    await next(cloud);
    ok(/Connect to your Google Sheet first/.test(await text(cloud, '[data-setup-error]')), 'connect is required');
    await set(cloud, 'input[name="s-url"]', 'https://docs.google.com/spreadsheets/d/abc/edit');
    await cloud.click('[data-connect]');
    ok(/spreadsheet itself/.test(await text(cloud, '[data-setup-error]')), 'sheet link explained');
    await set(cloud, 'input[name="s-url"]', EXEC);
    await cloud.click('[data-connect]');
    await cloud.waitForSelector('[data-connect-status].ok');
    await snap(cloud, 'cloud-connected');
    await next(cloud); await cloud.waitForTimeout(600);
    await cloud.click('[data-screening-choice] .option[data-value="yes"]');
    await cloud.click('[data-template="induction"]');
    await set(cloud, 'input[name="s-alerts"]', 'security@initech.example');
    await next(cloud); await cloud.waitForTimeout(600);
    ok(await cloud.$eval('[data-notify-toggle]', (e) => !e.hidden && e.getAttribute('aria-checked') === 'true'), 'host emails on with Google Sheets');
    await set(cloud, 'input[name="s-host-name"]', 'Bill Lumbergh');
    await set(cloud, 'input[name="s-host-email"]', 'bill@initech.example');
    await cloud.click('[data-add-host]');
    await snap(cloud, 'cloud-hosts');
    await next(cloud); await cloud.waitForTimeout(600);
    await cloud.click('[data-photos-choice] [data-value="off"]');
    await cloud.click('[data-sign-choice] [data-value="new"]');
    await cloud.click('[data-sign-email-toggle]');
    ok(await cloud.$eval('[data-sign-email-toggle]', (e) => e.getAttribute('aria-checked') === 'true'), 'offer an emailed copy');
    await cloud.$eval('[data-sign-choice]', (e) => e.scrollIntoView({ block: 'center' }));
    await snap(cloud, 'setup-signature');
    ok(await cloud.$eval('[data-summary-box]', (e) => e.hidden), 'summary option waits for an end-of-day time');
    await cloud.click('[data-eod-choice] [data-value="23:59"]');
    await cloud.click('[data-summary-toggle]');
    ok(await cloud.$eval('input[name="s-summary-to"]', (e) => e.value) === 'security@initech.example', 'summary goes to the alert addresses');
    await snap(cloud, 'cloud-summary');
    await next(cloud);
    await cloud.waitForFunction(() => document.querySelector('[data-setup-count]').textContent === 'Setup complete');
    ok(backend.props.KIOSK_KEY && backend.props.ADMIN_PIN_HASH, 'sheet claimed and PIN set');
    await next(cloud);
    await waitView(cloud, 'welcome');
    ok(await cloud.$eval('[data-org-name]', (e) => e.textContent) === 'Initech', 'cloud settings applied after reload');
    ok(await cloud.$eval('[data-leave-open]', (e) => !e.hidden), 'Leaving button without badges');

    // Sign in without a badge; the induction question flags them.
    await cloud.click('[data-screen="welcome"]');
    await waitView(cloud, 'choice');
    await cloud.click('[data-action="new"]');
    await waitView(cloud, 'form');
    await formNext(cloud);
    await set(cloud, 'input[name="first"]', 'Milton');
    await set(cloud, 'input[name="last"]', 'Waddams');
    await formNext(cloud);
    await set(cloud, 'input[name="company"]', 'Initech');
    await type(cloud, 'input[name="visiting"]', 'Bi');
    await cloud.click('[data-host-suggest] .chip');
    await set(cloud, 'input[name="purpose"]', 'Meeting');
    await formNext(cloud);
    await cloud.click('[data-screen="form"] .step.active .option[data-value="No"]');
    await formNext(cloud);
    ok(await step(cloud) === 'rules', 'no photo step with photos off');
    await sign(cloud);
    ok(await cloud.$eval('[data-sign-email]', (e) => !e.hidden), 'the visitor can ask for a copy');
    await set(cloud, 'input[name="email"]', 'milton@initech');
    await formNext(cloud);
    ok(/check the email address/.test(await text(cloud, '[data-form-error]')), 'a mistyped email is caught');
    await set(cloud, 'input[name="email"]', 'milton@initech.example');
    await formNext(cloud);
    await waitView(cloud, 'done');
    ok(await text(cloud, '[data-done-pass]') === 'Please take visitor pass V1.' && await text(cloud, '[data-done-badge]') === 'Pass V1', 'the visitor is told which pass to take');
    ok(/give your pass back/.test(await text(cloud, '[data-done-leave]')), 'and to give it back');
    ok(backend.sheets.Badges.objects().map((b) => `${b.Badge}:${b.Status}`).join(' ') === 'V1:in use V2:available V3:available', 'the setup made passes V1 to V3, and V1 is out');
    await snap(cloud, 'cloud-done');
    const visits = backend.sheets.Visits.rows;
    ok(visits.length === 2 && /Needs induction/.test(visits[1].join('|')), 'flagged visit in the sheet');
    ok(backend.mail.some((m) => m.to === 'security@initech.example' && /Visitor alert: Milton/.test(m.subject)), 'alert email sent');
    ok(backend.mail.some((m) => m.to === 'bill@initech.example' && /Your visitor has arrived: Milton Waddams/.test(m.subject)), 'host emailed');
    ok(/let Bill Lumbergh know/.test(await text(cloud, '[data-done-host]')), 'visitor told their host knows');
    const copyMail = backend.mail.find((m) => m.to === 'milton@initech.example');
    ok(copyMail && /Your signed visitor rules for Initech/.test(copyMail.subject) && copyMail.attachments.length === 1, 'the signed copy is emailed to the visitor');
    const milton = backend.sheets.Visitors.objects().find((r) => r['First Name'] === 'Milton');
    ok(milton['Signed copy'] && milton.Email === 'milton@initech.example' && backend.sheets.Visits.objects().at(-1)['Signed copy'] === milton['Signed copy'], 'the sheet links the signed copy on the visitor and the visit');
    await cloud.click('[data-screen="done"] [data-go="welcome"]');
    await waitView(cloud, 'welcome');

    // Second tablet: the private link connects it to the same sheet and settings.
    const key = backend.props.KIOSK_KEY;
    const second = await open(browser, `${base}?api=${encodeURIComponent(EXEC)}&key=${encodeURIComponent(key)}`, backend);
    await waitView(second, 'welcome');
    ok(await second.$eval('[data-org-name]', (e) => e.textContent) === 'Initech', 'second tablet uses the sheet settings');
    await second.click('[data-leave-open]');
    await waitView(second, 'leave');
    await set(second, 'input[name="lfirst"]', 'Milton');
    await set(second, 'input[name="llast"]', 'Waddams');
    await second.click('[data-leave-go]');
    await second.waitForSelector('[data-leave-match]');
    await snap(second, 'leave');
    await second.click('[data-leave-match]');
    await second.waitForSelector('[data-overlay="signout"]:not([hidden])');
    ok(/Goodbye, Milton/.test(await text(second, '[data-signout-title]')), 'signed out on screen');
    ok(/give visitor pass V1 back/.test(await text(second, '[data-signout-text]')), 'and asked for the pass back');
    const [head, row] = backend.sheets.Visits.rows;
    ok(row[head.indexOf('Signed out')] && row[head.indexOf('Signed out by')] === 'Signed out at kiosk', 'sign-out written to the sheet');
    // Third tablet: joins from the wizard with the kiosk key.
    const third = await open(browser, base, backend);
    await waitView(third, 'setup');
    await next(third); await third.waitForTimeout(600);
    await third.click('[data-setup-join]');
    await third.waitForTimeout(700);
    await set(third, 'input[name="s-url"]', EXEC);
    await third.click('[data-connect]');
    await third.waitForSelector('[data-key-field]:not([hidden])');
    ok(/already connected to another tablet/.test(await text(third, '[data-connect-status]')), 'claimed sheet asks for the key');
    await set(third, 'input[name="s-key"]', key);
    await third.click('[data-connect]');
    await third.waitForSelector('[data-connect-status].ok');
    await snap(third, 'join');
    await next(third);
    await waitView(third, 'welcome');
    ok(await third.$eval('[data-org-name]', (e) => e.textContent) === 'Initech', 'joined tablet uses the sheet settings');
    ok(!backend.mail.some((m) => /^Visitor summary/.test(m.subject)), 'no summary for the day before setup');
    const daily = await third.evaluate(async () => (await import('./js/api.js')).call('endOfDay', { before: new Date().toISOString() }));
    const sent = backend.mail.find((m) => /^Visitor summary/.test(m.subject));
    ok(daily.summary === true && sent && sent.to === 'security@initech.example' && /Milton Waddams/.test(sent.body), `daily summary: ${JSON.stringify(daily)}`);
    ok(!cloud.errors.length && !second.errors.length && !third.errors.length, `no page errors: ${[...cloud.errors, ...second.errors, ...third.errors].join(' | ')}`);

    // A sheet still on an older script (version 4) can't keep signatures: visitors tick the box until it's updated.
    const oldScript = { handle: (req) => { const out = backend.handle(req); return req.action === 'ping' ? { ...out, version: 4 } : out; } };
    const stale = await open(browser, `${base}?api=${encodeURIComponent(EXEC)}&key=${encodeURIComponent(key)}`, oldScript);
    await waitView(stale, 'welcome');
    await stale.waitForTimeout(800);
    await stale.click('[data-screen="welcome"]');
    await waitView(stale, 'choice');
    await stale.click('[data-action="new"]');
    await waitView(stale, 'form');
    await formNext(stale);
    await set(stale, 'input[name="first"]', 'Samir');
    await set(stale, 'input[name="last"]', 'Nagheenanajar');
    await formNext(stale);
    await set(stale, 'input[name="company"]', 'Initech');
    await set(stale, 'input[name="visiting"]', 'Bill Lumbergh');
    await set(stale, 'input[name="purpose"]', 'Meeting');
    await formNext(stale);
    await stale.click('[data-screen="form"] .step.active .option[data-value="No"]');
    await formNext(stale);
    ok(await step(stale) === 'rules' && await stale.$eval('[data-agree]', (e) => !e.hidden) && await stale.$eval('[data-sign-box]', (e) => e.hidden), 'an outdated script gets the tick box, not a signature that would be lost');
    ok(!stale.errors.length, `no page errors: ${stale.errors.join(' | ')}`);
    await stale.context().close();

    // ================================================================ phone sign-in: a QR code by the door
    await holdLogo(cloud);
    await cloud.waitForSelector('[data-overlay="pin"]:not([hidden])');
    await enterPin(cloud, PIN);
    await waitView(cloud, 'admin');
    await cloud.click('[data-admin-tab="settings"]');
    await cloud.waitForSelector('[data-phone-card]:not([hidden]) [data-phone-on]');
    ok(/sign in on their own phone/.test(await text(cloud, '[data-phone-text]')), 'the admin can put up a QR code instead of a tablet');
    await cloud.click('[data-phone-on]');
    await cloud.waitForSelector('[data-phone-qr]:not([hidden]) svg.qr');
    const phoneUrl = await text(cloud, '[data-phone-qr] code');
    ok(/\/web\/\?visit=ph[A-Z0-9]{30}&api=https%3A%2F%2Fscript\.google\.com/.test(phoneUrl) && backend.props.PHONE_KEY, `a phone link: ${phoneUrl}`);
    await cloud.$eval('[data-phone-card]', (e) => e.scrollIntoView({ block: 'center' }));
    await snap(cloud, 'phone-admin');
    await cloud.click('[data-phone-poster]');
    await cloud.waitForSelector('[data-overlay="poster"]:not([hidden]) [data-poster-qr] svg.qr');
    ok(/Visitor sign-in/.test(await text(cloud, '[data-poster]')) && /Initech/.test(await text(cloud, '[data-poster]')), 'a poster with the company and the code');
    await snap(cloud, 'phone-poster');
    await cloud.click('[data-poster-close]');
    await cloud.click('[data-admin-exit]');
    await waitView(cloud, 'welcome');

    // A visitor scans it: the visitor screens on their own phone.
    const iphone = await open(browser, phoneUrl, backend, { device: devices['iPhone 13'] });
    await waitView(iphone, 'welcome');
    ok(await iphone.$eval('[data-org-name]', (e) => e.textContent) === 'Initech', 'the phone shows the company');
    ok(await iphone.$eval('[data-leave-open]', (e) => e.hidden) && await iphone.$eval('[data-foot-badge]', (e) => e.hidden), 'no badge or sign-out prompt before signing in');
    ok(await iphone.evaluate(() => innerWidth === screen.width && document.documentElement.scrollWidth <= innerWidth + 1), 'laid out at the phone\'s own width, nothing wider');
    await snap(iphone, 'phone-welcome');
    await iphone.tap('[data-screen="welcome"] .welcome-title');
    await waitView(iphone, 'form');
    ok(true, 'a new phone goes straight to the questions');
    await formNext(iphone);
    await iphone.tap('input[name="first"]');
    ok(await iphone.$eval('input[name="first"]', (e) => !e.readOnly && !e.hasAttribute('inputmode')), "the phone's own keyboard is used");
    ok(await iphone.$eval('[data-keyboard]', (e) => getComputedStyle(e).display === 'none'), 'not the on-screen one');
    await iphone.fill('input[name="first"]', 'Peter');
    await iphone.fill('input[name="last"]', 'Gibbons');
    await snap(iphone, 'phone-name');
    await formNext(iphone);
    for (const [name, value] of [['company', 'Initech'], ['visiting', 'Bill Lumbergh'], ['purpose', 'TPS reports']]) {
      await iphone.tap(`input[name="${name}"]`);
      await iphone.fill(`input[name="${name}"]`, value);
    }
    ok(!(await iphone.$$('[data-host-suggest] .chip')).length, "staff names aren't suggested on a visitor's phone");
    await formNext(iphone);
    await iphone.tap('[data-screen="form"] .step.active .option[data-value="Yes"]');
    await formNext(iphone);
    ok(await step(iphone) === 'rules', 'the rules, to sign');
    await sign(iphone);
    await snap(iphone, 'phone-signature');
    await formNext(iphone);
    await waitView(iphone, 'done');
    ok(/You're all set, Peter/.test(await text(iphone, '[data-done-title]')) && /let Bill Lumbergh know/.test(await text(iphone, '[data-done-host]')), 'signed in, and the host is told');
    ok(await text(iphone, '[data-done-pass]') === 'Please take visitor pass V1.', 'the phone says which pass to take');
    ok(/open this page again and tap "Leaving\?"/.test(await text(iphone, '[data-done-leave]')), 'the visitor is told how to sign out');
    await snap(iphone, 'phone-done');
    const peter = backend.sheets.Visitors.objects().find((r) => r['First Name'] === 'Peter');
    const peterVisit = backend.sheets.Visits.objects().find((v) => v['First Name'] === 'Peter');
    ok(peter && peter['Phone key'] && peter['Signed copy'] && peterVisit['How they signed in'] === 'phone' && !peterVisit['Signed out'], 'the sheet has the visitor, the signed copy and a phone visit');
    ok(backend.mail.some((m) => m.to === 'bill@initech.example' && /Peter Gibbons/.test(m.subject)), 'the host is emailed');

    // Leaving: the same phone signs them out.
    await iphone.tap('[data-screen="done"] [data-go="welcome"]');
    await waitView(iphone, 'welcome');
    ok(await iphone.$eval('[data-leave-open]', (e) => !e.hidden), '"Leaving?" is there while they are inside');
    await iphone.tap('[data-leave-open]');
    await iphone.waitForSelector('[data-overlay="signout"]:not([hidden])');
    ok(/Goodbye, Peter/.test(await text(iphone, '[data-signout-title]')) && await iphone.$eval('[data-undo]', (e) => e.hidden), 'signed out on the phone');
    ok(/give visitor pass V1 back/.test(await text(iphone, '[data-signout-text]')), 'and asked for the pass back');
    ok(backend.sheets.Visits.objects().find((v) => v['Visit ID'] === peterVisit['Visit ID'])['Signed out by'] === 'Signed out on their phone', 'the sheet says so');
    await iphone.tap('[data-overlay="signout"]');
    ok(await iphone.$eval('[data-leave-open]', (e) => e.hidden), '"Leaving?" goes away');

    // Next time, the phone remembers them.
    await iphone.tap('[data-screen="welcome"] .welcome-title');
    await waitView(iphone, 'choice');
    ok(/Sign in as Peter Gibbons/.test(await text(iphone, '[data-action="returning"]')) && /Someone else/.test(await text(iphone, '[data-action="new"]')), 'a returning visitor on the same phone');
    await snap(iphone, 'phone-returning');
    await iphone.tap('[data-action="returning"]');
    await waitView(iphone, 'done');
    ok(/Welcome back, Peter/.test(await text(iphone, '[data-done-title]')), 'signed in again with one tap');
    ok(backend.sheets.Visits.objects().filter((v) => v['First Name'] === 'Peter' && !v['Signed out']).length === 1, 'one open visit');
    ok(!iphone.errors.length, `no page errors on the phone: ${iphone.errors.join(' | ')}`);
    await iphone.context().close();

    // The phone link can't look anyone up.
    const peek = backend.handle({ phone: backend.props.PHONE_KEY, action: 'findVisitor', args: { first: 'Peter', last: 'Gibbons' } });
    ok(peek.error === 'not_allowed', 'the phone link only signs in and out');

    // ================================================================ offline start-up
    const off = await open(browser, `${base}?demo`, null, { offline: true });
    await waitView(off, 'welcome');
    await off.evaluate(() => navigator.serviceWorker.ready);
    await off.reload();
    await waitView(off, 'welcome');
    ok(await off.evaluate(() => !!navigator.serviceWorker.controller), 'offline cache in control');
    await off.context().setOffline(true);
    await off.reload();
    await waitView(off, 'welcome');
    ok(await off.$eval('[data-org-name]', (e) => e.textContent) === 'Northwind Labs', 'the kiosk opens with no network');
    await off.context().close();

    // ================================================================ licensing switched on: a kiosk sold per tablet
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsi-e2e-key-'));
    const tool = (script, args) => execFileSync(process.execPath, [path.join(__dirname, '../tools/license', script), ...args], { cwd: keyDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const publicKey = JSON.parse(/publicKey: (\{.*\}),/.exec(tool('keygen.mjs', []))[1]);
    const paid = await open(browser, `${base}?demo`);
    await waitView(paid, 'welcome');
    // The seller's website with the license status files (tools/license writes them into license-status/).
    await paid.context().route('https://licenses.example.com/**', (route) => {
      const file = path.join(keyDir, 'license-status', path.basename(new URL(route.request().url()).pathname));
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Date', Date: new Date().toUTCString() };
      return fs.existsSync(file) ? route.fulfill({ status: 200, contentType: 'text/plain', headers, body: fs.readFileSync(file, 'utf8') }) : route.fulfill({ status: 404, headers, body: '' });
    });
    const tabletCode = await paid.evaluate(async () => (await import('./js/plans.js')).tabletCode());
    ok(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(tabletCode), `this tablet's code: ${tabletCode}`);
    const elsewhere = tool('issue.mjs', ['--customer', 'Northwind Labs', '--tablet', 'ZZZZ-ZZZZ']).trim();
    const licenseKey = tool('issue.mjs', ['--customer', 'Northwind Labs', '--tablet', tabletCode, '--paid', 'check', '--amount', '499', '--ref', '1001']).trim();
    const licenseId = JSON.parse(fs.readFileSync(path.join(keyDir, 'licenses.json'), 'utf8')).licenses.at(-1).id;
    const recheck = () => paid.evaluate(() => document.dispatchEvent(new Event('kiosk-license-changed')));

    // Someone is inside with badge V1 when the trial runs out.
    await paid.evaluate(async () => {
      const { call } = await import('./js/api.js');
      const photo = 'data:image/jpeg;base64,' + btoa('photo');
      const reg = await call('register', { first: 'Pia', last: 'Hart', company: 'Globex', visiting: 'Pat Kim', purpose: 'Meeting', agreed: true, photo });
      await call('assignBadge', { visitorId: reg.visitor.id, tag: 'DEMO0001' });
    });
    await paid.evaluate(async (pub) => {
      const plans = await import('./js/plans.js');
      const { settings, useSettings } = await import('./js/settings.js');
      Object.assign(plans.PAYWALL, {
        enabled: true, publicKey: pub, buyUrl: 'https://buy.example.com/visitor-sign-in', statusUrl: 'https://licenses.example.com/',
        seller: 'Shock Tech', supportEmail: 'sales@shocktech.example', price: '$499 per kiosk, then $149 a year',
      });
      useSettings({ ...settings(), trialStarted: new Date(Date.now() - 45 * 86400000).toISOString() });
    }, publicKey);
    await recheck();
    await paid.waitForSelector('[data-paused]:not([hidden])');
    ok(/Sign-ins are paused/.test(await text(paid, '[data-paused]')) && /Please see the front desk/.test(await text(paid, '[data-paused]')), 'after the trial, visitors are asked to see the front desk');
    const staffLine = await text(paid, '[data-paused-staff]');
    ok(staffLine.includes(`Tablet ${tabletCode}`) && /Shock Tech/.test(staffLine) && /sales@shocktech\.example/.test(staffLine), `staff see the tablet code and who to call: ${staffLine}`);
    ok(await paid.$eval('.tap-cta', (e) => getComputedStyle(e).display === 'none'), 'no "tap to get started"');
    await snap(paid, 'paused');
    await paid.click('[data-screen="welcome"] .welcome-title');
    await paid.waitForTimeout(700);
    ok(await view(paid) === 'welcome', 'a tap does not start a sign-in');
    await paid.click('[data-demo-tap="0"]');
    await paid.waitForSelector('[data-overlay="signout"]:not([hidden])');
    ok(/Goodbye, Pia/.test(await text(paid, '[data-signout-title]')), 'signing out with a badge still works while paused');
    await paid.waitForSelector('[data-overlay="signout"][hidden]', { state: 'attached', timeout: 15000 });

    // The admin screen still opens: the license screen, with the tablet code.
    await holdLogo(paid);
    await paid.waitForSelector('[data-overlay="pin"]:not([hidden])');
    await enterPin(paid, '123456');
    await waitView(paid, 'admin');
    await paid.waitForFunction(() => /trial has ended: new sign-ins are paused/.test(document.querySelector('[data-toast]').textContent), null, { timeout: 5000 });
    ok(true, 'the admin is told why');
    await paid.click('[data-admin-tab="history"]');
    await paid.waitForSelector('[data-history-list] .admin-row');
    ok(/Pia/.test(await text(paid, '[data-history-list]')), 'records are all still there');
    await paid.click('[data-admin-tab="settings"]');
    await paid.waitForSelector('[data-plan-card]:not([hidden])');
    ok((await text(paid, '[data-plan-text]')).includes(tabletCode), 'the License card shows the tablet code');
    await paid.click('[data-plan-open]');
    await paid.waitForSelector('[data-overlay="upgrade"]:not([hidden])');
    ok(await text(paid, '[data-tablet-code]') === tabletCode && /Shock Tech/.test(await text(paid, '[data-upgrade-seller]')), 'the license screen shows the tablet code and the seller');
    ok(/\$499 per kiosk, then \$149 a year/.test(await text(paid, '[data-upgrade-text]')), 'and the price');
    ok(await paid.$('[data-upgrade-qr] svg.qr') && /buy\.example\.com/.test(await text(paid, '[data-upgrade-url]')) && /check/.test(await text(paid, '[data-upgrade-buy]')), 'a buy link, a QR code, and checks welcome');
    await snap(paid, 'license');
    await set(paid, 'input[name="license"]', elsewhere);
    await paid.click('[data-upgrade-apply]');
    await paid.waitForFunction(() => /is for tablet ZZZZ-ZZZZ/.test(document.querySelector('[data-upgrade-error]').textContent));
    ok(true, "another tablet's key is refused");
    await set(paid, 'input[name="license"]', licenseKey.slice(0, -3) + 'AAA');
    await paid.click('[data-upgrade-apply]');
    await paid.waitForFunction(() => /isn't valid/.test(document.querySelector('[data-upgrade-error]').textContent));
    ok(true, 'a damaged key is refused');
    await set(paid, 'input[name="license"]', licenseKey);
    await paid.click('[data-upgrade-apply]');
    await paid.waitForSelector('[data-overlay="upgrade"][hidden]', { state: 'attached' });
    ok(/License added: Northwind Labs, paid until \d{4}-/.test(await text(paid, '[data-toast]')), 'the key is added');
    await paid.waitForFunction(() => /Licensed to Northwind Labs, paid until/.test(document.querySelector('[data-plan-text]').textContent));
    ok(true, 'the License card shows it');
    // The license agreement: not accepted on this kiosk yet, so the admin reads and accepts it.
    ok(/hasn't been accepted on this kiosk yet/.test(await text(paid, '[data-plan-text]')), 'the License card says the agreement is not accepted yet');
    await paid.click('[data-agreement-open]');
    await paid.waitForSelector('[data-overlay="agreement"]:not([hidden])');
    const agText = await text(paid, '[data-ag-text]');
    ok(/Shock Tech/.test(agText) && /Northwind Labs/.test(agText) && /14-day grace/.test(agText) && /sales@shocktech\.example/.test(agText), "the agreement names the seller and the business, with the kiosk's real grace period");
    ok(!/\{\w+\}/.test(agText), 'no blanks left in braces');
    ok(/state where Shock Tech is based/.test(agText), 'with no governing law set, it says where the seller is based');
    await snap(paid, 'agreement-admin');
    await paid.click('[data-ag-agree]');
    ok(/Type your name/.test(await text(paid, '[data-ag-error]')), 'accepting needs a name');
    await set(paid, 'input[name="ag-name"]', 'Jordan Lee');
    await paid.click('[data-ag-agree]');
    await paid.waitForSelector('[data-overlay="agreement"][hidden]', { state: 'attached' });
    await paid.waitForFunction(() => /accepted by Jordan Lee/.test(document.querySelector('[data-plan-text]').textContent));
    ok(true, 'the License card shows who accepted it');
    ok(await paid.evaluate(async () => (await import('./js/settings.js')).settings().agreement.by) === 'Jordan Lee', 'and it is kept with the settings');
    await paid.click('[data-agreement-open]');
    await paid.waitForSelector('[data-overlay="agreement"]:not([hidden])');
    ok(await paid.$eval('[data-ag-agree]', (e) => e.hidden) && /accepted by Jordan Lee/.test(await text(paid, '[data-ag-status]')), 'opened again, it is just to read');
    await paid.click('[data-ag-close]');
    await paid.waitForSelector('[data-overlay="agreement"][hidden]', { state: 'attached' });
    await paid.click('[data-admin-exit]');
    await waitView(paid, 'welcome');
    ok(await paid.$eval('[data-paused]', (e) => e.hidden), 'the kiosk is back on');
    await paid.click('[data-screen="welcome"] .welcome-title');
    await waitView(paid, 'choice');
    ok(true, 'visitors can sign in again');
    await paid.click('[data-screen="choice"] [data-go="welcome"]');
    await waitView(paid, 'welcome');

    // A bounced check: switched off from the seller's side, then back on.
    tool('switch.mjs', ['off', '--id', licenseId, '--note', 'check 1001 bounced']);
    await recheck();
    await paid.waitForSelector('[data-paused]:not([hidden])');
    ok(/Switched off by the seller/.test(await text(paid, '[data-paused-staff]')), 'switching the license off pauses the kiosk');
    tool('switch.mjs', ['on', '--id', licenseId]);
    await recheck();
    await paid.waitForSelector('[data-paused][hidden]', { state: 'attached' });
    ok(true, 'and switching it on again restarts it');
    fs.rmSync(keyDir, { recursive: true, force: true });
    ok(!paid.errors.length, `no page errors: ${paid.errors.join(' | ')}`);
    await paid.context().close();

    // ================================================================ the install page
    const home = await open(browser, site);
    await home.waitForSelector('[data-for="desktop"]:not([hidden]) [data-page-qr] svg.qr');
    ok(await home.$eval('[data-page-url]', (e) => e.textContent) === site, 'a computer sees a QR code of the page for the tablet');
    await snap(home, 'install-desktop');
    await home.goto(`${site}?demo`);
    await waitView(home, 'welcome');
    ok(new URL(home.url()).pathname === '/web/', 'a demo link goes straight to the kiosk');
    ok(!home.errors.length, `no page errors: ${home.errors.join(' | ')}`);
    await home.context().close();
    const droid = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' });
    await droid.route('https://api.github.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v9.9.9', assets: [{ name: 'visitor-sign-in-9.9.9.apk', size: 12e6, browser_download_url: 'https://example.com/visitor-sign-in-9.9.9.apk' }] }) }));
    const dpage = await droid.newPage();
    await dpage.goto(site);
    await dpage.waitForFunction(() => /Version 9\.9\.9, 12 MB/.test(document.querySelector('[data-apk-note]').textContent));
    ok(await dpage.$eval('[data-for="android"] [data-apk]', (a) => a.href) === 'https://example.com/visitor-sign-in-9.9.9.apk', 'an Android tablet gets the latest app to download');
    await snap(dpage, 'install-android');
    await droid.close();

    // ================================================================ 3. the Shock Tech preset
    const preset = await open(browser, base);
    await waitView(preset, 'setup');
    await next(preset); await preset.waitForTimeout(600);
    await preset.setInputFiles('[data-setup-import]', path.join(__dirname, '../docs/presets/shock-tech.json'));
    await preset.waitForFunction(() => document.querySelector('input[name="s-org"]').value === 'Shock Tech');
    ok(await preset.$eval('[data-preview-logo]', (e) => e.src.startsWith('data:image/png')), 'preset logo loaded');
    await snap(preset, 'preset');
    // With licensing on, setup asks the business to accept the license agreement after its name.
    await preset.evaluate(async () => {
      const plans = await import('./js/plans.js');
      Object.assign(plans.PAYWALL, { enabled: true, seller: 'Shock Tech', supportEmail: 'sales@shocktech.example', law: 'Michigan' });
      document.dispatchEvent(new Event('kiosk-license-changed'));
    });
    await preset.waitForTimeout(400);
    await next(preset); await preset.waitForTimeout(600);
    await preset.waitForSelector('[data-sstep="agreement"].active');
    const setupAg = await text(preset, '[data-agreement-text]');
    ok(/Shock Tech/.test(setupAg) && /laws of Michigan/.test(setupAg), 'setup shows the agreement with the seller and the governing law');
    ok(/Shock Tech/.test(await text(preset, '[data-sstep="agreement"] .hint')), 'for the business being set up');
    await next(preset); await preset.waitForTimeout(300);
    ok(/Type your name/.test(await text(preset, '[data-setup-error]')), 'it needs a name');
    await set(preset, 'input[name="s-agree-name"]', 'Jordan Lee');
    await next(preset); await preset.waitForTimeout(300);
    ok(/Tick "I agree"/.test(await text(preset, '[data-setup-error]')), 'and "I agree"');
    await preset.click('[data-agree-toggle]');
    await snap(preset, 'setup-agreement');
    await next(preset); await preset.waitForTimeout(600);
    await preset.waitForSelector('[data-sstep="admin"].active');
    ok(true, 'then on to the admin login');
    ok(!preset.errors.length, `no page errors: ${preset.errors.join(' | ')}`);
    console.log(`kiosk e2e passed (${checks} checks)`);
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((err) => { console.error(err); process.exit(1); });
