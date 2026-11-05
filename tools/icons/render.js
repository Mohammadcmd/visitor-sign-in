// Renders the app icon and splash screens from the SVG below with Playwright:
// web/assets/icon-512.png and the Android launcher icons and splash screens.
//   node tools/icons/render.js
// To use your own brand on the Android app, change BRAND (and the mark) and run it again.
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '../..');
const res = path.join(root, 'android/app/src/main/res');
const BRAND = { light: '#1a7fd0', main: '#0a5ea8', deep: '#063a6e', navy: '#031d38' };

// A visitor badge with a check mark, on a 512×512 canvas.
const mark = `
  <rect x="146" y="112" width="220" height="296" rx="36" fill="#fff"/>
  <rect x="214" y="92" width="84" height="44" rx="16" fill="${BRAND.light}" stroke="#fff" stroke-width="10"/>
  <circle cx="256" cy="222" r="44" fill="${BRAND.main}" opacity=".18"/>
  <path d="M186 336c10-36 38-58 70-58s60 22 70 58" fill="none" stroke="${BRAND.main}" stroke-opacity=".18" stroke-width="28" stroke-linecap="round"/>
  <circle cx="340" cy="366" r="62" fill="#16a34a" stroke="#fff" stroke-width="14"/>
  <path d="M312 366l20 20 36-38" fill="none" stroke="#fff" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"/>`;
const grad = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BRAND.light}"/><stop offset="1" stop-color="${BRAND.deep}"/></linearGradient></defs>`;

const icon = (shape) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${grad}${
  shape === 'round' ? '<circle cx="256" cy="256" r="256" fill="url(#g)"/>' : shape === 'square' ? '<rect width="512" height="512" fill="url(#g)"/>' : '<rect width="512" height="512" rx="112" fill="url(#g)"/>'}${mark}</svg>`;
// Adaptive icon foreground: 108dp with the mark inside the 66dp safe zone, transparent around it.
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-200 -200 912 912">${mark}</svg>`;

const splash = (w, h) => {
  const s = Math.min(w, h) * 0.28;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><radialGradient id="r" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="${BRAND.deep}"/><stop offset="1" stop-color="${BRAND.navy}"/></radialGradient>${grad.slice(6, -7)}</defs>
    <rect width="${w}" height="${h}" fill="url(#r)"/>
    <svg x="${(w - s) / 2}" y="${h * 0.42 - s / 2}" width="${s}" height="${s}" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="url(#g)"/>${mark}</svg>
    <text x="${w / 2}" y="${h * 0.42 + s / 2 + s * 0.32}" text-anchor="middle" fill="#fff" font-family="Inter, 'Segoe UI', Roboto, Arial, sans-serif" font-weight="700" font-size="${s * 0.2}">Visitor Sign-In</text>
  </svg>`;
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  async function render(svg, w, h, out) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<html><body style="margin:0;background:transparent"><img style="display:block;width:${w}px;height:${h}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`);
    await page.waitForFunction(() => document.images[0].complete);
    await page.screenshot({ path: out, omitBackground: true });
  }
  await render(icon('rounded'), 512, 512, path.join(root, 'web/assets/icon-512.png'));
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    await render(icon('rounded'), 48 * k, 48 * k, path.join(res, `mipmap-${d}/ic_launcher.png`));
    await render(icon('round'), 48 * k, 48 * k, path.join(res, `mipmap-${d}/ic_launcher_round.png`));
    await render(foreground, 108 * k, 108 * k, path.join(res, `mipmap-${d}/ic_launcher_foreground.png`));
  }
  const splashes = {
    'drawable/splash.png': [480, 320],
    'drawable-land-mdpi/splash.png': [480, 320], 'drawable-land-hdpi/splash.png': [800, 480], 'drawable-land-xhdpi/splash.png': [1280, 720],
    'drawable-land-xxhdpi/splash.png': [1600, 960], 'drawable-land-xxxhdpi/splash.png': [1920, 1280],
    'drawable-port-mdpi/splash.png': [320, 480], 'drawable-port-hdpi/splash.png': [480, 800], 'drawable-port-xhdpi/splash.png': [720, 1280],
    'drawable-port-xxhdpi/splash.png': [960, 1600], 'drawable-port-xxxhdpi/splash.png': [1280, 1920],
  };
  for (const [f, [w, h]] of Object.entries(splashes)) await render(splash(w, h), w, h, path.join(res, f));
  await browser.close();
  console.log('Icons and splash screens written.');
})();
