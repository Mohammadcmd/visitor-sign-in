// Builds the Android app (APK) for the kiosk tablet.
//
//   node scripts/build-android.mjs
//
// Optional environment variables:
//   KIOSK_API_URL, KIOSK_KEY   Apps Script /exec URL and KIOSK_KEY. Built into the
//                              app so the tablet reports to the Google Sheet with no
//                              setup. Without them the app runs in demo mode.
//   KIOSK_KEYSTORE_BASE64      Base64 of a release keystore (.jks), plus
//   KIOSK_KEYSTORE_PASSWORD    its password,
//   KIOSK_KEY_ALIAS            key alias, and
//   KIOSK_KEY_PASSWORD         key password. With these the APK is release-signed
//                              with your own key, so later versions install as
//                              updates. Without them it is debug-signed.
//
// Output: dist/shocktech-visitor-kiosk.apk
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(root, 'android');
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });

// 1. Copy web/ into the Android project.
run('npx cap sync android');

// 2. Build in the backend connection (only the copy inside the app; web/ is untouched).
const api = process.env.KIOSK_API_URL || '';
const key = process.env.KIOSK_KEY || '';
if ((api && !key) || (!api && key)) throw new Error('Set both KIOSK_API_URL and KIOSK_KEY, or neither.');
if (api && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(api)) {
  throw new Error('KIOSK_API_URL should look like https://script.google.com/macros/s/.../exec');
}
writeFileSync(
  join(android, 'app/src/main/assets/public/kiosk-connection.js'),
  `// Written by scripts/build-android.mjs\nwindow.KIOSK_CONNECTION = ${api ? JSON.stringify({ api, key }) : 'null'};\n`,
);
console.log(api ? 'Connection to the Google Sheet built in.' : 'No connection given: the app will run in demo mode.');

// 3. Signing.
// android/app/build.gradle reads the passwords from the environment; only the
// keystore file itself has to be written out (and is deleted afterwards).
const signed = Boolean(process.env.KIOSK_KEYSTORE_BASE64);
const ks = join(android, 'release.keystore');
const env = { ...process.env };
if (signed) {
  writeFileSync(ks, Buffer.from(process.env.KIOSK_KEYSTORE_BASE64, 'base64'), { mode: 0o600 });
  env.KIOSK_KEYSTORE_FILE = ks;
}

// 4. Build.
const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
try {
  execSync(`${gradlew} --no-daemon ${signed ? 'assembleRelease' : 'assembleDebug'}`, { cwd: android, stdio: 'inherit', env });
} finally {
  if (signed) rmSync(ks, { force: true });
}

const apk = signed
  ? join(android, 'app/build/outputs/apk/release/app-release.apk')
  : join(android, 'app/build/outputs/apk/debug/app-debug.apk');
if (!existsSync(apk)) throw new Error(`Build finished but ${apk} is missing`);
mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist/shocktech-visitor-kiosk.apk');
copyFileSync(apk, out);
console.log(`\nAPK ready (${signed ? 'release-signed' : 'debug-signed'}): ${out}`);
