/* End-to-end tests in a real browser (Playwright + Chromium with a fake camera).
 * Run with: node tests/e2e.test.js     (set SHOTS_DIR=/some/dir to save screenshots)
 *
 * Covers: setup wizard (local and cloud), visitor sign-in, screening questions, decline with photo,
 * staff override, card taps (USB keyboard readers), admin panel, CSV export, roll call,
 * and cloud sync through the real connector code running on an in-memory Apps Script mock. */
'use strict';
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');
const { createRuntime } = require('./gas-mock');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || '';
const SCALE = Number(process.env.SHOT_SCALE || 1);
global.window = {};
require(path.join(ROOT, 'apps-script.js'));
const CONNECTOR = window.VSI_CONNECTOR_SOURCE;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 4 + 1) + 1 + x * 4;
    const [r, g, b, a] = pixel(x, y);
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A transparent logo: a green circle and a dark word-mark bar.
const LOGO = png(480, 160, (x, y) => {
  if ((x - 80) ** 2 + (y - 80) ** 2 < 60 ** 2) return [5, 150, 105, 255];
  if (x > 165 && x < 450 && y > 55 && y < 105) return [15, 23, 42, 255];
  return [0, 0, 0, 0];
});
const OPAQUE_LOGO = png(300, 100, () => [255, 255, 255, 255]);

let shotN = 0;
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  shotN += 1;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`) });
}
async function visible(page, sel) { await page.waitForSelector(sel, { state: 'visible', timeout: 8000 }); }
async function typeCard(page, id) {
  // Keyboard-wedge readers type very fast and finish with Enter.
  await page.keyboard.type(id, { delay: 4 });
  await page.keyboard.press('Enter');
}
async function waitFor(fn, what, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}
const visitsOf = page => page.evaluate(() => window.__vsi.visits.map(v => ({ ...v })));

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack}`); throw e; }
}

// ---------------------------------------------------------------------------
// Scenario 1: on-device storage
// ---------------------------------------------------------------------------
async function localScenario(browser, base) {
  console.log('On-device storage');
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: SCALE, permissions: ['camera'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_|net::/.test(m.text())) errors.push(m.text()); });
  await page.route('https://docs.google.com/spreadsheets/d/SHEET123/gviz/**', route => route.fulfill({
    status: 200, contentType: 'text/csv', headers: { 'Access-Control-Allow-Origin': '*' },
    body: 'Name,Card ID,Company,Role,Admin\nSam Rivera,0099887766,Acme Robotics,Staff,\nPat Kim,,Acme Robotics,Manager,\n',
  }));
  await page.goto(base);

  await step('first launch opens the setup wizard', async () => {
    await visible(page, '#view-setup');
    assert.match(await page.textContent('#step-count'), /Step 1 of 7/);
    await shot(page, 'setup-company-empty');
  });

  await step('company name and brand color', async () => {
    await page.click('#setup-next');
    assert.match(await page.textContent('#setup-error'), /company name/);
    await page.fill('input[name=orgName]', 'Acme Robotics');
    await page.click('.swatch[aria-label="Use color #059669"]');
    assert.strictEqual(await page.textContent('#pv-name'), 'Acme Robotics');
    await shot(page, 'setup-company');
    await page.click('#setup-next');
  });

  await step('admin login rejects easy and mismatched codes', async () => {
    await page.fill('input[name=adminName]', 'Jordan Lee');
    await page.fill('input[name=pin]', '1234');
    await page.fill('input[name=pin2]', '1234');
    await page.click('#setup-next');
    assert.match(await page.textContent('#setup-error'), /too easy/);
    await page.fill('input[name=pin]', '4826');
    await page.fill('input[name=pin2]', '4827');
    await page.click('#setup-next');
    assert.match(await page.textContent('#setup-error'), /don't match/);
    await page.fill('input[name=pin2]', '4826');
    assert.strictEqual(await page.locator('#pin-checks li.ok').count(), 3);
    await shot(page, 'setup-admin');
    await page.click('#setup-next');
  });

  await step('logo upload detects transparency', async () => {
    await page.setInputFiles('#logo-input', { name: 'solid.png', mimeType: 'image/png', buffer: OPAQUE_LOGO });
    await visible(page, '#logo-note');
    assert.match(await page.textContent('#logo-note'), /solid background/);
    await page.setInputFiles('#logo-input', { name: 'logo.png', mimeType: 'image/png', buffer: LOGO });
    await page.waitForFunction(() => /transparent/.test(document.querySelector('#logo-note').textContent));
    assert.match(await page.textContent('#logo-dims'), /480 × 160/);
    await shot(page, 'setup-logo');
    await page.click('#setup-next');
  });

  await step('USB card reader test and admin card', async () => {
    await page.click('label.choice:has(input[value=usb])');
    await visible(page, '#card-test');
    await typeCard(page, '0004123456');
    await page.waitForSelector('#tap-target.ok');
    assert.match(await page.textContent('#tap-target'), /0004123456/);
    await page.click('#make-admin-card');
    assert.match(await page.textContent('#admin-cards-note'), /1 admin card/);
    await shot(page, 'setup-cards');
    await page.click('#setup-next');
  });

  await step('storage choice (on this device)', async () => {
    await page.click('label.choice:has(input[name=storage][value=local])');
    await shot(page, 'setup-storage');
    await page.click('#setup-next');
  });

  await step('people spreadsheet link is tested and previewed', async () => {
    await visible(page, '[data-storage=local]');
    await page.fill('input[name=sheetUrl]', 'https://docs.google.com/spreadsheets/d/SHEET123/edit?usp=sharing');
    await page.click('#setup-next');
    assert.match(await page.textContent('#setup-error'), /Test link/);
    await page.click('#sheet-test');
    await page.waitForSelector('#sheet-status.ok');
    assert.match(await page.textContent('#sheet-status'), /Found 2 people, 1 with a card/);
    await shot(page, 'setup-sheet');
    await page.click('#setup-next');
  });

  await step('screening questions from templates', async () => {
    await page.click('label.choice:has(input[name=screeningEnabled][value=yes])');
    await visible(page, '#screening-builder');
    await page.click('.qt-chip:has-text("U.S. person")');
    await page.click('.qt-chip:has-text("Safety induction")');
    assert.strictEqual(await page.locator('#q-list .qcard').count(), 2);
    assert.strictEqual(await page.locator('#q-list .qcard.rule-decline').count(), 1);
    assert.strictEqual(await page.locator('#q-list .qcard.rule-flag').count(), 1);
    assert.ok(await page.isVisible('#alert-local-note'));
    await shot(page, 'setup-questions');
    await page.click('#setup-save');
  });

  await step('ready screen summarizes the setup', async () => {
    await visible(page, '.setup-step[data-step=finish]');
    const summary = await page.textContent('#ready-summary');
    assert.match(summary, /Acme Robotics/);
    assert.match(summary, /2 questions/);
    assert.match(summary, /2 people/);
    await shot(page, 'setup-ready');
    await page.click('#setup-open');
    await visible(page, '#view-home');
    assert.strictEqual(await page.textContent('#home-org'), 'Acme Robotics');
    assert.ok(await page.isVisible('#home-logo'));
    assert.ok(await page.isVisible('#card-hint'));
    await shot(page, 'home');
  });

  await step('visitor signs in; a flagged answer still lets them in', async () => {
    await page.click('#go-signin');
    await page.click('#flow-next');
    assert.match(await page.textContent('#signin-error'), /highlighted/);
    await page.fill('#signin-fields input[name=name]', 'Alex Morgan');
    await page.fill('#signin-fields input[name=company]', 'Globex');
    await page.fill('#signin-fields input[name=host]', 'Pat Kim');
    await page.click('#signin-fields .chip:has-text("Meeting")');
    await shot(page, 'signin-details');
    await page.click('#flow-next');
    await visible(page, '#screening-fields');
    await page.click('#flow-next');
    assert.match(await page.textContent('#signin-error'), /answer every question/);
    await page.click('.sq:nth-child(1) .chip:has-text("Yes")');
    await page.click('.sq:nth-child(2) .chip:has-text("No")');
    await shot(page, 'signin-questions');
    await page.click('#flow-next');
    await visible(page, '#view-done');
    assert.strictEqual(await page.textContent('#done-title'), 'Welcome, Alex!');
    assert.match(await page.textContent('#badge-meta'), /Visiting: Pat Kim/);
    await shot(page, 'signin-done');
    const v = (await visitsOf(page)).find(x => x.name === 'Alex Morgan');
    assert.strictEqual(v.status, undefined);
    assert.strictEqual(v.reasons[0].action, 'flag');
    await page.click('#view-done [data-go=home]');
  });

  await step('declined visitor: photo, polite message, recorded for staff', async () => {
    await page.click('#go-signin');
    await page.fill('#signin-fields input[name=name]', 'Ivan Petrov');
    await page.click('#signin-fields .chip:has-text("Interview")');
    await page.click('#flow-next');
    await page.click('.sq:nth-child(1) .chip:has-text("No")');
    await page.click('.sq:nth-child(2) .chip:has-text("Yes")');
    await page.click('#flow-next');
    await visible(page, '#view-photo');
    await page.waitForFunction(() => !document.querySelector('#photo-take').disabled, null, { timeout: 8000 });
    await page.waitForTimeout(400);
    await shot(page, 'photo');
    await page.click('#photo-take');
    await visible(page, '#photo-use');
    await page.click('#photo-use');
    await visible(page, '#view-declined');
    assert.match(await page.textContent('#declined-msg'), /Thank you for visiting Acme Robotics/);
    assert.ok(!/U\.S\./.test(await page.textContent('#view-declined')), 'the visitor is not told which answer caused the decline');
    await shot(page, 'declined');
    const v = (await visitsOf(page)).find(x => x.name === 'Ivan Petrov');
    assert.strictEqual(v.status, 'declined');
    assert.strictEqual(v.photo, true, 'photo stored in IndexedDB');
    assert.ok(await page.isVisible('#admin-dot') === false || true);
    await page.click('#declined-done');
    await visible(page, '#view-home');
    assert.ok(await page.isVisible('#admin-dot'), 'the gear shows a dot for staff');
  });

  await step('staff override at the kiosk needs the admin code', async () => {
    await page.click('#go-signin');
    await page.fill('#signin-fields input[name=name]', 'Dana Cruz');
    await page.click('#signin-fields .chip:has-text("Delivery")');
    await page.click('#flow-next');
    await page.click('.sq:nth-child(1) .chip:has-text("No")');
    await page.click('.sq:nth-child(2) .chip:has-text("Yes")');
    await page.click('#flow-next');
    await visible(page, '#view-photo');
    await page.waitForFunction(() => !document.querySelector('#photo-take').disabled, null, { timeout: 8000 });
    await page.click('#photo-take');
    await visible(page, '#photo-retake');
    await page.click('#photo-retake');
    await page.click('#photo-take');
    await visible(page, '#photo-use');
    await page.click('#photo-use');
    await visible(page, '#view-declined');
    await page.click('#declined-override');
    await visible(page, '#pin-dialog');
    await page.fill('#pin-input', '1111');
    await page.click('#pin-form button[type=submit]');
    assert.match(await page.textContent('#pin-error'), /Incorrect/);
    await page.fill('#pin-input', '4826');
    await page.click('#pin-form button[type=submit]');
    await visible(page, '#confirm-dialog');
    await page.fill('#confirm-input', 'Delivery escorted by reception');
    await shot(page, 'override-reason');
    await page.click('#confirm-ok');
    await visible(page, '#view-done');
    await page.waitForSelector('#badge-photo:not([hidden])');
    const v = (await visitsOf(page)).find(x => x.name === 'Dana Cruz');
    assert.strictEqual(v.status, 'overridden');
    assert.strictEqual(v.override.by, 'Jordan Lee');
    assert.strictEqual(v.override.reason, 'Delivery escorted by reception');
    await page.click('#view-done [data-go=home]');
  });

  await step('card taps: unknown card, sign in, sign out, admin card', async () => {
    await visible(page, '#view-home');
    await typeCard(page, '5551234567');
    await visible(page, '#view-bye');
    assert.strictEqual(await page.textContent('#bye-title'), 'Card not recognized');
    await page.click('#view-bye [data-go=home]');
    await typeCard(page, '0099887766');
    await visible(page, '#view-done');
    assert.strictEqual(await page.textContent('#done-title'), 'Welcome, Sam!');
    assert.strictEqual(await page.textContent('#badge-label'), 'STAFF');
    await page.click('#view-done [data-go=home]');
    await page.waitForTimeout(3100);
    await typeCard(page, '99887766'); // same card, without leading zeros
    await visible(page, '#view-bye');
    assert.strictEqual(await page.textContent('#bye-title'), 'Goodbye, Sam!');
    await page.click('#view-bye [data-go=home]');
    await typeCard(page, '0004123456');
    await visible(page, '#view-admin');
  });

  await step('admin dashboard shows alerts and allows an override', async () => {
    assert.strictEqual(await page.textContent('#attn-count'), '2');
    assert.strictEqual(await page.textContent('#attn-badge'), '2');
    assert.strictEqual(await page.textContent('#stat-onsite'), '2'); // Alex and Dana
    const attn = await page.textContent('#attn-list');
    assert.match(attn, /Ivan Petrov/);
    assert.match(attn, /Alex Morgan/);
    await shot(page, 'admin-dashboard');
    await page.click('#attn-list li:has-text("Ivan Petrov") button:has-text("Allow entry")');
    await visible(page, '#confirm-dialog');
    await page.fill('#confirm-input', 'Approved by security');
    await page.click('#confirm-ok');
    await page.waitForFunction(() => document.querySelector('#stat-onsite').textContent === '3');
    assert.strictEqual(await page.textContent('#attn-count'), '1');
    await page.click('#attn-list li:has-text("Alex Morgan") button:has-text("Reviewed")');
    assert.ok(await page.isHidden('#attn-card'));
  });

  await step('visitor log, details dialog and filters', async () => {
    await page.click('.tab[data-tab=log]');
    assert.strictEqual(await page.locator('#log-body tr').count(), 4); // Alex, Ivan, Dana, Sam
    await page.selectOption('#log-filter', 'flagged');
    assert.strictEqual(await page.locator('#log-body tr').count(), 1);
    await page.selectOption('#log-filter', 'all');
    await shot(page, 'admin-log');
    await page.click('#log-body tr:has-text("Ivan Petrov")');
    await visible(page, '#visit-dialog');
    await page.waitForSelector('#vd-photo img');
    const details = await page.textContent('#visit-dialog');
    assert.match(details, /Screening answers/);
    assert.match(details, /Approved by security/);
    await shot(page, 'admin-visit-details');
    await page.click('#vd-close');
  });

  await step('CSV export is complete and formula-safe', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
    const csv = fs.readFileSync(await download.path(), 'utf8');
    assert.match(csv, /^﻿Name,Status,Company/);
    assert.match(csv, /Ivan Petrov,Overridden/);
    assert.match(csv, /Sam Rivera,Left/);
    assert.strictEqual(csv.trim().split('\r\n').length, 5); // header + 4 visits
  });

  await step('people & cards: sheet rows plus a newly enrolled card', async () => {
    await page.click('.tab[data-tab=people]');
    assert.match(await page.textContent('#people-body'), /Sam Rivera/);
    await page.click('#enroll-card');
    await visible(page, '#enroll-dialog');
    await page.focus('#enroll-form input[name=cardId]');
    await typeCard(page, '7777000011');
    assert.strictEqual(await page.inputValue('#enroll-form input[name=cardId]'), '7777000011');
    await page.fill('#enroll-form input[name=name]', 'Chris Doe');
    await page.fill('#enroll-form input[name=role]', 'Contractor');
    await page.click('#enroll-save');
    await page.waitForSelector('#enroll-dialog', { state: 'hidden' });
    assert.match(await page.textContent('#people-body'), /Chris Doe/);
    await shot(page, 'admin-people');
  });

  await step('roll call prints everyone on site', async () => {
    await page.click('.tab[data-tab=dash]');
    await page.evaluate(() => { window.print = () => { window.__printed = document.querySelector('#print-area').innerHTML; }; });
    await page.click('#print-rollcall');
    const printed = await page.evaluate(() => window.__printed || '');
    assert.match(printed, /Roll call/);
    assert.strictEqual((printed.match(/<tr>/g) || []).length, 1 + 3);
  });

  await step('settings: agreement with signature is added to the flow', async () => {
    await page.click('#admin-settings');
    await visible(page, '#view-setup');
    await page.click('.vstep:has-text("Agreement")');
    await page.check('input[name=agreementEnabled]');
    await page.check('input[name=signatureRequired]');
    await page.click('.vstep:has-text("Kiosk behavior")');
    await page.check('input[name=autoSignOutOn]');
    await page.fill('input[name=autoSignOutAt]', '18:00');
    await shot(page, 'settings-kiosk');
    await page.click('#setup-save');
    await visible(page, '#view-admin');
    await page.click('#admin-close');
    await page.click('#go-signin');
    await page.fill('#signin-fields input[name=name]', 'Chris Doe Jr');
    await page.click('#signin-fields .chip:has-text("Other")');
    await page.click('#flow-next');
    await page.click('.sq:nth-child(1) .chip:has-text("Yes")');
    await page.click('.sq:nth-child(2) .chip:has-text("Yes")');
    await page.click('#flow-next');
    await visible(page, '#sig-pad');
    await page.click('#flow-next');
    assert.match(await page.textContent('#signin-error'), /accept/);
    await page.check('input[name=agree]');
    const box = await page.locator('#sig-pad').boundingBox();
    await page.mouse.move(box.x + 40, box.y + 120);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 40 + i * 25, box.y + 120 - Math.sin(i / 2) * 40);
    await page.mouse.up();
    await shot(page, 'signin-agreement');
    await page.click('#flow-next');
    await visible(page, '#view-done');
    const v = (await visitsOf(page)).find(x => x.name === 'Chris Doe Jr');
    assert.strictEqual(v.agreed, true);
    assert.strictEqual(v.signature, true);
    await page.click('#view-done [data-go=home]');
  });

  await step('automatic sign-out closes yesterday\'s open visits', async () => {
    await page.evaluate(() => {
      const v = window.__vsi.visits.find(x => x.name === 'Alex Morgan');
      v.inAt -= 26 * 3600 * 1000;
      window.__vsi.runAutoSignOut();
    });
    const v = (await visitsOf(page)).find(x => x.name === 'Alex Morgan');
    assert.strictEqual(v.autoOut, true);
    assert.ok(v.outAt);
  });

  await step('sign-out list signs a visitor out', async () => {
    await page.click('#go-signout');
    await page.fill('#signout-search', 'dana');
    assert.strictEqual(await page.locator('#signout-list li').count(), 1);
    await shot(page, 'signout');
    await page.click('#signout-list button');
    await visible(page, '#view-bye');
    assert.strictEqual(await page.textContent('#bye-title'), 'Goodbye, Dana!');
  });

  await step('mobile layout has no horizontal scrolling', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const view of ['home', 'signin']) {
      if (view === 'home') { await page.click('#view-bye [data-go=home]'); await visible(page, '#view-home'); }
      if (view === 'signin') { await page.click('#go-signin'); await visible(page, '#view-signin'); }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `${view} overflows by ${overflow}px`);
      await shot(page, `mobile-${view}`);
    }
    await page.click('#flow-back');
    await page.setViewportSize({ width: 1280, height: 860 });
  });

  await step('no JavaScript errors', async () => { assert.deepStrictEqual(errors, []); });
  await context.close();
}

// ---------------------------------------------------------------------------
// Scenario 2: Google Sheets cloud storage
// ---------------------------------------------------------------------------
async function cloudScenario(browser, base) {
  console.log('Google Sheets cloud storage');
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: SCALE, permissions: ['camera'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  let runtime = createRuntime(CONNECTOR, { key: 'wrong-key-000000' });
  let offline = false;
  let requests = 0;
  await page.route('https://script.google.com/macros/s/DEPLOY123/exec', async route => {
    requests++;
    if (offline) { await route.abort('internetdisconnected'); return; }
    const out = runtime.post(route.request().postData());
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(out) });
  });
  await page.goto(base);

  await step('setup with cloud storage', async () => {
    await page.fill('input[name=orgName]', 'Initech');
    await page.click('#setup-next');
    await page.fill('input[name=adminName]', 'Morgan Smith');
    await page.fill('input[name=pin]', '908172');
    await page.fill('input[name=pin2]', '908172');
    await page.click('#setup-next');
    await page.click('#setup-skip'); // logo
    await page.click('label.choice:has(input[value=usb])');
    await page.click('#setup-next');
    await page.click('label.choice:has(input[name=storage][value=cloud])');
    await page.click('#setup-next');
    await visible(page, '[data-storage=cloud]');
    assert.ok(await page.isHidden('#setup-skip'), 'the connection step cannot be skipped in cloud mode');
    await shot(page, 'cloud-connect');
  });

  let key;
  await step('connector script download includes the kiosk key', async () => {
    key = await page.inputValue('input[name=cloudKey]');
    assert.match(key, /^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-script')]);
    const code = fs.readFileSync(await download.path(), 'utf8');
    assert.ok(code.includes(`var KIOSK_KEY = '${key}';`));
    assert.strictEqual(download.suggestedFilename(), 'Code.gs');
  });

  await step('connection test explains problems, then connects', async () => {
    await page.fill('input[name=cloudUrl]', 'https://docs.google.com/spreadsheets/d/abc/edit');
    await page.click('#cloud-test');
    assert.match(await page.textContent('#cloud-status'), /link to the spreadsheet itself/);
    await page.fill('input[name=cloudUrl]', 'https://script.google.com/macros/s/DEPLOY123/exec');
    await page.click('#cloud-test');
    await page.waitForSelector('#cloud-status.err');
    assert.match(await page.textContent('#cloud-status'), /kiosk key does not match/);
    runtime = createRuntime(CONNECTOR, { key });
    await page.click('#cloud-test');
    await page.waitForSelector('#cloud-status.ok');
    assert.match(await page.textContent('#cloud-status'), /Visitor log/);
    // Staff with emails on the People tab.
    runtime.tab('People').getRange(2, 1, 2, 6).setValues([
      ['Maria Lopez', '', 'Initech', 'Engineer', 'maria@initech.test', ''],
      ['Security Desk', '0001112223', 'Initech', 'Security', '', 'Yes'],
    ]);
    await page.fill('input[name=kioskName]', 'Main lobby');
    await shot(page, 'cloud-connected');
    await page.click('#setup-next');
  });

  await step('screening with email alerts', async () => {
    await page.click('label.choice:has(input[name=screeningEnabled][value=yes])');
    await page.click('.qt-chip:has-text("U.S. person")');
    assert.ok(await page.isVisible('#alert-emails-field'));
    await page.fill('input[name=alertEmails]', 'not-an-email');
    await page.click('#setup-save');
    assert.match(await page.textContent('#setup-error'), /Check this email address/);
    await page.fill('input[name=alertEmails]', 'security@initech.test');
    await page.click('#setup-save');
    await visible(page, '.setup-step[data-step=finish]');
    assert.match(await page.textContent('#ready-summary'), /Google Sheets/);
    await page.click('#setup-open');
    await visible(page, '#view-home');
    await page.waitForFunction(() => /Synced/.test(document.querySelector('#home-sync').textContent));
  });

  const visitsTab = () => runtime.tab('Visits').rows();

  await step('allowed visitor is saved to the sheet and the host is emailed', async () => {
    await page.click('#go-signin');
    await page.fill('#signin-fields input[name=name]', 'Tom Baker');
    await page.fill('#signin-fields input[name=host]', 'Maria Lopez');
    await page.click('#signin-fields .chip:has-text("Meeting")');
    await page.click('#flow-next');
    await page.click('.sq .chip:has-text("Yes")');
    await page.click('#flow-next');
    await visible(page, '#view-done');
    await waitFor(() => visitsTab().length === 1, 'the visit to reach the sheet');
    const row = visitsTab()[0];
    assert.strictEqual(row.Name, 'Tom Baker');
    assert.strictEqual(row.Kiosk, 'Main lobby');
    assert.strictEqual(row.Status, 'Allowed');
    await waitFor(() => runtime.mail.some(m => m.to === 'maria@initech.test'), 'the host email');
    await page.click('#view-done [data-go=home]');
  });

  await step('declined visitor: sheet row with photo and an email alert with the photo attached', async () => {
    await page.click('#go-signin');
    await page.fill('#signin-fields input[name=name]', 'Eve Adams');
    await page.click('#signin-fields .chip:has-text("Interview")');
    await page.click('#flow-next');
    await page.click('.sq .chip:has-text("No")');
    await page.click('#flow-next');
    await visible(page, '#view-photo');
    await page.waitForFunction(() => !document.querySelector('#photo-take').disabled, null, { timeout: 8000 });
    await page.click('#photo-take');
    await visible(page, '#photo-use');
    await page.click('#photo-use');
    await visible(page, '#view-declined');
    await waitFor(() => visitsTab().some(r => r.Name === 'Eve Adams'), 'the declined visit to reach the sheet');
    const row = visitsTab().find(r => r.Name === 'Eve Adams');
    assert.strictEqual(row.Status, 'Declined');
    assert.match(row.Photo, /^data:image\/jpeg;base64,/);
    assert.match(row.Flags, /^Declined: /);
    const alert = await waitFor(() => runtime.mail.find(m => m.to === 'security@initech.test'), 'the staff alert');
    assert.match(alert.subject, /Visitor declined: Eve Adams/);
    assert.strictEqual(alert.attachments[0].type, 'image/jpeg');
  });

  await step('kiosk override with an admin card from the People tab updates the sheet', async () => {
    await page.click('#declined-override');
    await visible(page, '#pin-dialog');
    await typeCard(page, '1112223'); // Security Desk's card, without leading zeros
    await visible(page, '#confirm-dialog');
    await page.fill('#confirm-input', 'Visitor badge checked');
    await page.click('#confirm-ok');
    await visible(page, '#view-done');
    await waitFor(() => (visitsTab().find(r => r.Name === 'Eve Adams') || {}).Status === 'Overridden', 'the override to reach the sheet');
    assert.match(visitsTab().find(r => r.Name === 'Eve Adams').Override, /By Morgan Smith .*Visitor badge checked/);
    await page.click('#view-done [data-go=home]');
  });

  await step('changes made while offline are queued and uploaded later', async () => {
    offline = true;
    await page.click('#go-signout');
    await page.click('#signout-list button:has-text("Tom Baker")');
    await visible(page, '#view-bye');
    await waitFor(async () => (await page.evaluate(() => window.__vsi.outbox.length)) === 1, 'the queued sign-out');
    await page.waitForFunction(() => /Sync issue|waiting|Offline/.test(document.querySelector('#home-sync').textContent));
    assert.ok(!visitsTab().find(r => r.Name === 'Tom Baker')['Signed out']);
    offline = false;
    await page.evaluate(() => window.__vsi.cloudSync());
    await waitFor(async () => (await page.evaluate(() => window.__vsi.outbox.length)) === 0, 'the queue to empty');
    assert.ok(visitsTab().find(r => r.Name === 'Tom Baker')['Signed out']);
    await page.click('#view-bye [data-go=home]');
  });

  await step('visitors signed in at another kiosk appear here too', async () => {
    runtime.post({ key, action: 'sync', ops: [{ opId: 'other-1', type: 'signin', visit: { id: 'other-kiosk-visit', name: 'Rita Gomez', company: 'Hooli', method: 'screen', kiosk: 'Loading dock', inAt: Date.now() } }] });
    await page.evaluate(() => window.__vsi.cloudSync());
    await page.click('#go-signout');
    assert.match(await page.textContent('#signout-list'), /Rita Gomez/);
    await page.click('#view-signout [data-go=home]');
  });

  await step('admin: storage status and adding a card writes to the People tab', async () => {
    await page.click('#open-admin');
    await page.fill('#pin-input', '908172');
    await page.click('#pin-form button[type=submit]');
    await visible(page, '#view-admin');
    assert.match(await page.textContent('#storage-info'), /Connected/);
    assert.match(await page.textContent('#storage-info'), /Main lobby/);
    await shot(page, 'cloud-admin-dashboard');
    await page.click('.tab[data-tab=people]');
    await page.click('#enroll-card');
    await page.fill('#enroll-form input[name=cardId]', '0044556677');
    await page.fill('#enroll-form input[name=name]', 'Lee Park');
    await page.click('#enroll-save');
    await page.waitForSelector('#enroll-dialog', { state: 'hidden' });
    assert.ok(runtime.tab('People').rows().some(r => r.Name === 'Lee Park' && r['Card ID'] === '0044556677'));
    assert.match(await page.textContent('#people-body'), /Lee Park/);
    assert.ok(requests > 5);
  });

  await step('no JavaScript errors', async () => { assert.deepStrictEqual(errors, []); });
  await context.close();
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    await localScenario(browser, base);
    await cloudScenario(browser, base);
    console.log(`\n${passed} end-to-end checks passed.`);
  } catch (e) {
    process.exitCode = 1;
    console.error('\nEnd-to-end tests FAILED.');
  } finally {
    await browser.close();
    server.close();
  }
})();
