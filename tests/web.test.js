// Checks on the kiosk's own files that don't need a browser.
//   node tests/web.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

// One version everywhere.
const version = JSON.parse(read('package.json')).version;
ok(new RegExp(`APP_VERSION = '${version}'`).test(read('web/config.js')), `web/config.js APP_VERSION should be ${version}`);
ok(new RegExp(`VERSION = '${version}'`).test(read('web/sw.js')), `web/sw.js VERSION should be ${version}`);
ok(/^## \[?\d+\.\d+\.\d+/m.test(read('CHANGELOG.md')) && read('CHANGELOG.md').includes(version), `CHANGELOG.md mentions ${version}`);

// Every file the offline cache lists exists, and every script the app loads is listed.
const sw = read('web/sw.js');
const files = JSON.parse(sw.slice(sw.indexOf('const FILES = [') + 'const FILES = '.length, sw.indexOf('];', sw.indexOf('const FILES = [')) + 1).replace(/'/g, '"').replace(/,\s*\]/, ']'));
for (const f of files) if (f !== './') ok(fs.existsSync(path.join(root, 'web', f)), `web/${f} (listed in sw.js) exists`);
for (const f of fs.readdirSync(path.join(root, 'web/js'))) ok(files.includes(`js/${f}`), `web/js/${f} is listed in sw.js for offline start-up`);

// Translations keep their {placeholders}, and none are empty.
const i18n = read('web/js/i18n.js');
const body = i18n.slice(i18n.indexOf('const ES = {'), i18n.indexOf('\n};', i18n.indexOf('const ES = {')));
const pairs = [...body.matchAll(/^\s*(['"])((?:\\.|(?!\1).)*)\1:\s*\n?\s*(['"])((?:\\.|(?!\3).)*)\3,/gm)];
ok(pairs.length > 150, `the Spanish dictionary was read (${pairs.length} entries)`);
for (const [, , en, , es] of pairs) {
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  ok(es.trim().length > 0, `"${en}" has a translation`);
  ok(vars(en) === vars(es), `"${en}" keeps its placeholders in Spanish`);
}

// The backend copy the setup wizard hands out matches the script.
const { render } = { render: (code) => `export const BACKEND_CODE = ${JSON.stringify(code)};` };
ok(read('web/js/backend-code.js').includes(render(read('apps-script/Code.gs'))), 'web/js/backend-code.js matches apps-script/Code.gs (run node scripts/sync-backend.mjs)');

console.log(`web tests passed (${checks} checks)`);
