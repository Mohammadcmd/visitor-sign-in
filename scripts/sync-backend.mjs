// Copies the Google Sheets backend (apps-script/Code.gs) into the web app as
// web/js/backend-code.js, so the setup wizard can hand it to whoever sets up
// the kiosk ("Copy the script" / "Download Code.gs") with nothing to fetch.
//
//   node scripts/sync-backend.mjs          rewrite web/js/backend-code.js
//   node scripts/sync-backend.mjs --check  fail if it is out of date (used by the tests)
//
// Run it after every change to apps-script/Code.gs. The Android build runs it too.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'apps-script/Code.gs');
const target = join(root, 'web/js/backend-code.js');

export function render(code) {
  return '// Generated from apps-script/Code.gs by scripts/sync-backend.mjs. Do not edit by hand.\n'
    + '// The setup wizard offers this to copy into Google Apps Script.\n'
    + `export const BACKEND_CODE = ${JSON.stringify(code)};\n`;
}

const wanted = render(readFileSync(source, 'utf8'));

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(target, 'utf8'); } catch { /* missing */ }
  if (current !== wanted) {
    console.error('web/js/backend-code.js is out of date. Run: node scripts/sync-backend.mjs');
    process.exit(1);
  }
  console.log('web/js/backend-code.js matches apps-script/Code.gs');
} else {
  writeFileSync(target, wanted);
  console.log('Wrote web/js/backend-code.js');
}
