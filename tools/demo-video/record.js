// Drives the kiosk inside stage.html and records the screen as JPEG frames.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'frames');
// Recorded in slow motion (R) and sped back up when encoding, so the result is smooth.
const R = 0.4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / R));

const now = () => new Date();
const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();
const SEED = {
  visitors: [
    { id: 'P1', first: 'Priya', last: 'Nair', company: 'Delta Calibration', visiting: 'Tom Alvarez', purpose: 'Equipment service', citizenship: 'U.S. citizen', country: 'United States', agreed: true, quickEntry: false, registered: iso(4000), visits: 3 },
    { id: 'P2', first: 'Marcus', last: 'Webb', company: 'Apex Machining', visiting: 'Lisa Chen', purpose: 'Supplier visit', citizenship: 'Lawful permanent resident (green card holder)', country: 'Canada', agreed: true, quickEntry: false, registered: iso(9000), visits: 5 },
  ],
  visits: [
    { id: 'S1', visitorId: 'P1', first: 'Priya', last: 'Nair', company: 'Delta Calibration', visiting: 'Tom Alvarez', kind: 'Visitor', badge: 'V2', method: 'kiosk', signedIn: iso(95) },
    { id: 'S2', visitorId: 'P2', first: 'Marcus', last: 'Webb', company: 'Apex Machining', visiting: 'Lisa Chen', kind: 'Visitor', badge: 'V3', method: 'kiosk', signedIn: iso(40) },
  ],
  faces: [], photos: {},
  badges: [
    { badge: 'V1', tag: 'DEMO0001', status: 'available' },
    { badge: 'V2', tag: 'DEMO0002', status: 'in use', holder: 'Priya Nair', visitorId: 'P1', visitId: 'S1', since: iso(95) },
    { badge: 'V3', tag: 'DEMO0003', status: 'in use', holder: 'Marcus Webb', visitorId: 'P2', visitId: 'S2', since: iso(40) },
    { badge: 'V4', tag: 'DEMO0004', status: 'available' },
    { badge: 'V5', tag: 'DEMO0005', status: 'available' },
  ],
};

// Illustrated stand-in for the camera: no real face appears in the video.
const AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a7fd0"/><stop offset="1" stop-color="#063a6e"/></linearGradient></defs>
<rect width="400" height="300" fill="url(#g)"/>
<circle cx="200" cy="118" r="54" fill="#cfe5f8"/>
<path d="M92 300c8-70 56-106 108-106s100 36 108 106z" fill="#cfe5f8"/>
<circle cx="200" cy="118" r="54" fill="none" stroke="#ffffff" stroke-opacity=".5" stroke-width="3"/>
</svg>`)}`;
const STAND_IN_CSS = `
.demo-panel { display: none !important; }
.camera, .camera-shot, .cam-video { opacity: 0 !important; }
.camera-frame { background: url("${AVATAR}") center / cover no-repeat !important; }
.cam-ring::after { content: ""; position: absolute; left: 3px; top: 3px; width: 48px; height: 48px; border-radius: 50%; border: 2px solid #fff; box-sizing: border-box; background: url("${AVATAR}") center / cover no-repeat; }
`;

// Blur filters are very slow in a GPU-less browser; the gradients are already soft without them.
const LITE_CSS = '.aurora{filter:none!important;opacity:.4!important} *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT);
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions: ['camera'] });
  await context.route('**/web/js/face.js', (route) => route.fulfill({
    contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, 'face-demo.js'), 'utf8'),
  }));
  await context.addInitScript((R) => {
    const oT = window.setTimeout.bind(window), oI = window.setInterval.bind(window);
    const oP = performance.now.bind(performance), oRAF = window.requestAnimationFrame.bind(window);
    const p0 = oP();
    performance.now = () => p0 + (oP() - p0) * R;
    window.setTimeout = (fn, d = 0, ...a) => oT(fn, d / R, ...a);
    window.setInterval = (fn, d = 0, ...a) => oI(fn, d / R, ...a);
    window.requestAnimationFrame = (cb) => oRAF((t) => cb(p0 + (t - p0) * R));
  }, R);
  await context.addInitScript((seed) => {
    if (location.pathname.endsWith('/web/index.html')) {
      localStorage.setItem('shocktech-kiosk-demo-v1', JSON.stringify(seed));
    }
  }, SEED);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));

  await page.goto('http://localhost:8766/tools/demo-video/stage.html');
  const frame = await (await page.waitForSelector('#kiosk')).contentFrame();
  await frame.waitForLoadState('load');
  await frame.addStyleTag({ content: STAND_IN_CSS + LITE_CSS });
  await page.addStyleTag({ content: LITE_CSS });
  frame.on('pageerror', (e) => console.error('kiosk error:', e.message));

  const S = (fn, ...args) => page.evaluate(([fn, args]) => window.stage[fn](...args), [fn, args]);
  const k = async (sel) => {
    try { await frame.click(sel, { timeout: 8000 }); } catch (err) {
      console.log('click failed', sel, JSON.stringify(await frame.evaluate((sel) => {
        const el = document.querySelector(sel); if (!el) return 'missing';
        const out = []; for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); out.push([e.className, cs.opacity, cs.visibility, cs.display, e.style.cssText, e.getAnimations().length]); }
        const rules = []; for (const sh of document.styleSheets) { try { for (const r of sh.cssRules) { if (r.selectorText && el.matches(r.selectorText) && /visibility/.test(r.cssText)) rules.push(r.cssText.slice(0, 200)); } } catch (e) { rules.push('x' + e); } }
        return { active: document.querySelector('.screen.active')?.dataset.screen, chain: out, html: el.outerHTML, rules, anims: document.getAnimations().map(a => (a.effect.target?.className || '') + ':' + a.playState).slice(0, 30) };
      }, sel)));
      throw err;
    }
  };
  const tap = async (index, badge) => {
    await S('tap', badge);
    await sleep(850);
    await frame.evaluate((i) => document.querySelector(`[data-demo-tap="${i}"]`).click(), index);
  };
  async function typeKeys(text) {
    for (const ch of text) {
      const sel = `[data-keyboard] [data-key="${ch === '"' ? '\\"' : ch}"]`;
      if (!(await frame.$(sel))) await k('[data-keyboard] [data-key="shift"]');
      await k(sel);
      await sleep(55);
    }
  }
  const field = async (name, text) => { await k(`input[name="${name}"]`); await sleep(350); await typeKeys(text); await sleep(250); };

  // ---------------------------------------------------------------- record
  let n = 0;
  const times = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    const file = path.join(OUT, `f${String(n).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    times.push(f.metadata.timestamp);
    n++;
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: R });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

  // Intro
  await S('card', `<div class="logo"><img src="../../web/assets/shocktech-logo.png"></div>
    <h1>Visitor Sign-In, <span>reimagined</span></h1>
    <p>A self-service lobby kiosk for Shock Tech, Inc.</p>`);
  await sleep(5200);
  await S('hideCard');

  // 1. Welcome
  await S('chapter', 1, 'Always ready in the lobby', 'A tablet at the front desk greets every visitor in Shock Tech colors. One tap anywhere to begin.');
  await sleep(5200);

  // 2. New visitor
  await S('chapter', 2, 'New visitors sign in themselves', 'A guided, one-question-at-a-time sign-in. It takes about two minutes.');
  await k('[data-screen="welcome"] .welcome-sub');
  await sleep(2200);
  await k('[data-action="new"]');
  await sleep(2400);
  await k('[data-form-next]');
  await sleep(1000);
  await S('sub', 'Typed on a built-in keyboard');
  await field('first', 'Jordan');
  await field('last', 'Rivera');
  await k('[data-key="done"]');
  await sleep(500);
  await k('[data-form-next]');
  await sleep(1100);
  await S('sub', "Who they're seeing and why");
  await field('company', 'Northwind Aerospace');
  await field('visiting', 'Lisa Chen');
  await k('[data-key="done"]');
  await sleep(300);
  await k('[data-chips="purpose"] .chip:nth-child(2)');
  await sleep(1300);
  await k('[data-form-next]');
  await sleep(1100);
  await S('sub', 'Export-control (ITAR / EAR) citizenship check built in');
  await sleep(1200);
  await k('[data-options="citizenship"] .option:nth-child(1)');
  await sleep(1500);
  await k('[data-form-next]');
  await sleep(1300);
  await S('sub', 'A photo for the visit record');
  await S('note', 'An illustration stands in for the live camera in this demo.');
  await sleep(1200);
  await k('[data-capture]');
  await sleep(3400);
  await k('[data-form-next]');
  await sleep(1200);
  await S('note', '');
  await S('sub', 'Visitor rules signed electronically');
  await sleep(2200);
  await k('[data-agree]');
  await sleep(1200);
  await k('[data-form-next]');
  await sleep(1300);
  await S('sub', 'Optional quick entry by face for next time. Opt-in only.');
  await sleep(3200);
  await k('[data-quick="yes"]');

  // 3. Badge
  await sleep(600);
  await S('chapter', 3, 'Tap any badge to finish', 'Visitors pick up any badge from the tray and tap it on the reader. That badge is now theirs for the visit.');
  await S('reader', true);
  await sleep(3200);
  await tap(0, 'V1');
  await sleep(4600);
  await S('reader', false);

  // 4. Records stay on the Raspberry Pi
  await S('chapter', 4, 'Every visit stays in the building', 'Names, answers and photos are kept on a Raspberry Pi at Shock Tech. Office computers see them in its dashboard, or download them for Excel.');
  const store = await frame.evaluate(() => JSON.parse(localStorage.getItem('shocktech-kiosk-demo-v1')));
  const date = (s) => new Date(s).toLocaleDateString('en-US');
  const rows = store.visitors.map((v) => ({
    isNew: v.first === 'Jordan',
    cells: [v.first, v.last, v.company, v.visiting, v.purpose, v.citizenship, v.country || 'United States', v.quickEntry ? 'Yes' : 'No', date(v.registered), 'On the Pi'],
  }));
  await S('ipad', 'away');
  await sleep(500);
  await S('sheet', rows);
  await S('sub', 'Jordan\'s sign-in, downloaded from the Pi');
  await sleep(6500);
  await S('hideSheet');
  await S('ipad', '');
  await sleep(900);
  if (await frame.$('[data-screen="done"].active')) await k('[data-screen="done"] .btn-secondary');

  // 5. Sign out
  await S('chapter', 5, 'Leaving takes one tap', 'On the way out, visitors tap their badge on the reader. They\'re signed out and the badge is free for the next guest.');
  await S('reader', true);
  await sleep(3000);
  await tap(0, 'V1');
  await sleep(4200);
  await S('reader', false);

  // Interlude
  await S('card', `<p class="kicker">One week later</p><h1>Jordan comes back.</h1>`);
  await sleep(3600);
  await S('hideCard');
  await sleep(600);

  // 6. Returning visitor
  await S('chapter', 6, 'Returning visitors in seconds', 'Returning visitors start typing their name, while the camera quietly looks for them in the background.');
  await S('note', 'An illustration stands in for the live camera in this demo.');
  await sleep(1400);
  await k('[data-screen="welcome"] .welcome-sub');
  await sleep(2200);
  await k('[data-action="returning"]');
  await S('sub', 'Face recognition runs right on the tablet');
  await frame.waitForSelector('[data-face-match]:not([hidden])', { timeout: 30000 });
  await S('sub', 'Recognized: one tap on "That\'s me" and they\'re through');
  await sleep(2600);
  await k('[data-face-yes]');
  await S('note', '');
  await S('sub', 'Not opted in, or not sure? Their name finds them. It never guesses.');
  await S('reader', true);
  await sleep(2400);
  await tap(3, 'V4');
  await sleep(4400);
  await S('reader', false);
  await k('[data-screen="done"] .btn-secondary');
  await sleep(2200);

  // 7. Admin
  await S('chapter', 7, 'The admin side', 'Front desk staff hold the logo and enter a PIN to see who\'s in the building and manage badges.');
  await sleep(1500);
  await S('sub', 'Hold the logo, then enter the admin PIN');
  const box = await frame.locator('[data-admin-hold]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(2700);
  await page.mouse.up();
  await sleep(700);
  for (const d of '123456') { await k(`[data-pin-pad] button:text-is("${d}")`); await sleep(160); }
  await sleep(400);
  await k('[data-pin="go"]');
  await sleep(1800);
  await S('sub', 'Everyone inside right now, with their badge and host');
  await sleep(4000);
  await S('sub', 'Sign anyone out from here');
  const webb = frame.locator('.admin-row', { hasText: 'Marcus Webb' }).locator('[data-signout]');
  await webb.click();
  await sleep(900);
  await webb.click();
  await sleep(2600);
  await k('[data-admin-tab="badges"]');
  await S('sub', 'Every badge, its NFC tag and who holds it');
  await sleep(3600);
  await k('[data-add-badge]');
  await S('sub', 'New badges are added by tapping them on the reader');
  await S('reader', true);
  await sleep(1800);
  await tap(5, 'V6');
  await sleep(3800);
  await S('reader', false);
  await k('[data-admin-exit]');
  await sleep(2600);

  // Closing
  await S('card', `<div class="logo"><img src="../../web/assets/shocktech-logo.png"></div>
    <ul>
      <li><b>✓</b>Visitors sign themselves in</li>
      <li><b>✓</b>ITAR / EAR citizenship check built in</li>
      <li><b>✓</b>Every record kept on site</li>
      <li><b>✓</b>Badges tracked in and out</li>
    </ul>
    <div class="cta">Ready for the Shock Tech lobby</div>`);
  await sleep(7000);

  await cdp.send('Page.stopScreencast');
  await sleep(300);
  fs.writeFileSync(path.join(__dirname, 'times.json'), JSON.stringify({ R, times }));
  const span = times[times.length - 1] - times[0];
  console.log('frames:', n, 'real seconds:', span.toFixed(1), 'video seconds:', (span * R).toFixed(1), 'fps:', (n / (span * R)).toFixed(1));
  await browser.close();
})();
