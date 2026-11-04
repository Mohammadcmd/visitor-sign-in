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
const { chromium } = require('playwright');
const { loadBackend } = require('./fake-google');

const WEB = path.join(__dirname, '../web');
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

async function open(browser, url, backend) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  if (backend) {
    await ctx.route('https://script.google.com/**', async (route) => {
      const out = backend.handle(JSON.parse(route.request().postData()));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
  }
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

const view = (page) => page.evaluate(() => document.body.dataset.view);
async function waitView(page, name) {
  await page.waitForFunction((n) => document.body.dataset.view === n, name, { timeout: 15000 });
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
async function holdLogo(page) {
  const box = await page.$eval('[data-admin-hold]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.waitForTimeout(2700);
  await page.mouse.up();
}


async function signInNewVisitor(page, { first, last, citizen, country, sick = 'No' }) {
  await page.click('[data-screen="welcome"]');
  await waitView(page, 'choice');
  await page.click('[data-action="new"]');
  await waitView(page, 'form');
  ok(await step(page) === 'intro', 'form starts with the intro');
  await formNext(page);
  await type(page, 'input[name="first"]', first);
  await set(page, 'input[name="last"]', last);
  await formNext(page);
  await set(page, 'input[name="company"]', 'Globex');
  await set(page, 'input[name="visiting"]', 'Pat Kim');
  await page.click('[data-chips="purpose"] .chip >> nth=0');
  await formNext(page);
  ok((await step(page)).startsWith('q:'), 'screening question follows the visit details');
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
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    // ================================================================ 1. on this tablet
    const page = await open(browser, base);
    await waitView(page, 'setup');
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

    await page.click('[data-photos-choice] [data-value="all"]');
    await snap(page, 'setup-touches');
    await next(page);
    await page.waitForFunction(() => document.querySelector('[data-setup-count]').textContent === 'Setup complete');
    await snap(page, 'setup-ready');
    await next(page);
    await waitView(page, 'welcome');
    ok(await page.$eval('[data-org-name]', (e) => e.textContent) === 'Acme Robotics', 'welcome shows the company');
    await snap(page, 'welcome');

    // A normal sign-in with a badge.
    await signInNewVisitor(page, { first: 'Ana', last: 'Lopez', citizen: 'U.S. citizen' });
    await formNext(page);
    ok(await step(page) === 'rules', 'rules after the photo');
    await page.click('[data-agree]');
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
    await page.click('[data-agree]');
    await formNext(page);
    await page.click('[data-quick="no"]');
    await waitView(page, 'badge');
    await tapBadge(page, '04FFEE0011');
    await waitView(page, 'done');
    await page.click('[data-screen="done"] [data-go="welcome"]');
    await waitView(page, 'welcome');

    // A second declined visitor stays declined.
    await signInNewVisitor(page, { first: 'Cara', last: 'Smith', citizen: 'U.S. citizen', sick: 'Yes' });
    await formNext(page);
    await waitView(page, 'declined');
    await page.click('[data-screen="declined"] [data-go="welcome"]');
    await waitView(page, 'welcome');
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
    await page.click('[data-admin-tab="badges"]');
    await page.waitForSelector('[data-badge-list] .admin-row');
    ok(await page.$$eval('[data-badge-list] .admin-row', (l) => l.length) === 2, 'badges from setup listed');
    await page.click('[data-admin-tab="settings"]');
    await page.waitForSelector('[data-settings-rows] .set-row');
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
    ok(!page.errors.length, `no page errors: ${page.errors.join(' | ')}`);
    await page.context().close();

    // ================================================================ 2. Google Sheets, no badges
    const backend = loadBackend();
    const cloud = await open(browser, base, backend);
    await waitView(cloud, 'setup');
    await set(cloud, 'input[name="s-org"]', 'Initech');
    await next(cloud); await cloud.waitForTimeout(600);
    await set(cloud, 'input[name="s-admin"]', 'Sam Ortiz');
    await set(cloud, 'input[name="s-pin"]', PIN);
    await set(cloud, 'input[name="s-pin2"]', PIN);
    await next(cloud); await cloud.waitForTimeout(600);
    await cloud.click('[data-setup-skip]'); await cloud.waitForTimeout(600);
    await cloud.click('[data-badges-choice] .option[data-value="no"]');
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
    await cloud.click('[data-photos-choice] [data-value="off"]');
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
    await set(cloud, 'input[name="visiting"]', 'Bill');
    await set(cloud, 'input[name="purpose"]', 'Meeting');
    await formNext(cloud);
    await cloud.click('[data-screen="form"] .step.active .option[data-value="No"]');
    await formNext(cloud);
    ok(await step(cloud) === 'rules', 'no photo step with photos off');
    await cloud.click('[data-agree]');
    await formNext(cloud);
    await waitView(cloud, 'done');
    await snap(cloud, 'cloud-done');
    const visits = backend.sheets.Visits.rows;
    ok(visits.length === 2 && /Needs induction/.test(visits[1].join('|')), 'flagged visit in the sheet');
    ok(backend.mail.length === 1 && /Milton/.test(backend.mail[0].subject), 'alert email sent');
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
    const [head, row] = backend.sheets.Visits.rows;
    ok(row[head.indexOf('Signed out')] && row[head.indexOf('Signed out by')] === 'Signed out at kiosk', 'sign-out written to the sheet');
    // Third tablet: joins from the wizard with the kiosk key.
    const third = await open(browser, base, backend);
    await waitView(third, 'setup');
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
    ok(!cloud.errors.length && !second.errors.length && !third.errors.length, `no page errors: ${[...cloud.errors, ...second.errors, ...third.errors].join(' | ')}`);

    // ================================================================ 3. the Shock Tech preset
    const preset = await open(browser, base);
    await waitView(preset, 'setup');
    await preset.setInputFiles('[data-setup-import]', path.join(__dirname, '../docs/presets/shock-tech.json'));
    await preset.waitForFunction(() => document.querySelector('input[name="s-org"]').value === 'Shock Tech');
    ok(await preset.$eval('[data-preview-logo]', (e) => e.src.startsWith('data:image/png')), 'preset logo loaded');
    await snap(preset, 'preset');
    ok(!preset.errors.length, `no page errors: ${preset.errors.join(' | ')}`);
    console.log(`kiosk e2e passed (${checks} checks)`);
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((err) => { console.error(err); process.exit(1); });
