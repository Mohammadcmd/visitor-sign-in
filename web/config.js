// Kiosk settings that aren't chosen in the setup wizard, and the connection to
// the Google Sheets backend.
//
// Where records are kept is chosen during setup:
//  - On this tablet: no connection; everything stays in this browser.
//  - Google Sheets: the setup wizard connects to the Apps Script web app and
//    remembers the connection on this tablet.
// The connection can also come from:
//  - the Android app: the build writes it into kiosk-connection.js
//    (see android/README.md), so the tablet needs no setup at all;
//  - a setup link opened once on the tablet:
//    https://<kiosk address>/?api=<Apps Script /exec URL>&key=<kiosk key>
//    The tablet remembers both and removes them from the address bar.
//    Open ?disconnect to forget them.
// Open ?demo to try the kiosk with sample data (nothing is saved, admin PIN 123456).

const STORAGE_KEY = 'kiosk-connection';
const LEGACY_KEY = 'shocktech-kiosk-connection';

const query = new URLSearchParams(location.search);

function readSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.api && saved.key) return saved;
    // Tablets set up before the kiosk became configurable kept it under an older name.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (legacy && legacy.api && legacy.key) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
      localStorage.removeItem(LEGACY_KEY);
      return legacy;
    }
  } catch { /* private mode */ }
  return {};
}

function connection() {
  // Built into the Android app at build time; always wins.
  const built = window.KIOSK_CONNECTION;
  if (built && built.api && built.key) return { ...built, builtIn: true };
  let saved = readSaved();
  if (query.get('api') && query.get('key')) {
    saved = { api: query.get('api'), key: query.get('key') };
    saveConnection(saved.api, saved.key);
    history.replaceState(null, '', location.pathname);
  } else if (query.has('disconnect')) {
    saved = {};
    forgetConnection();
    history.replaceState(null, '', location.pathname);
  }
  return saved;
}

export function saveConnection(api, key) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ api, key })); return true; } catch { return false; }
}

export function forgetConnection() {
  try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(LEGACY_KEY); } catch { /* nothing stored */ }
}

const saved = connection();

/** The kiosk's version. Keep it in step with package.json and sw.js (the tests check). */
export const APP_VERSION = '1.0.0';

export const CONFIG = {
  // Apps Script web app URL ending in /exec, and the key this kiosk connected with
  API_URL: saved.api || '',
  KIOSK_KEY: saved.key || '',
  // The connection came with the Android app, so it can't be changed on the tablet
  BUILT_IN: !!saved.builtIn,
  // ?demo: sample company and data, a panel that simulates badge taps, admin PIN 123456
  DEMO: query.has('demo') && !saved.api,

  // Return to the welcome screen after this long without a touch (ms)
  IDLE_MS: 90 * 1000,
  // Badge-tap screen waits a little longer
  BADGE_IDLE_MS: 150 * 1000,

  // Face matching (face-api.js descriptors, Euclidean distance)
  FACE_MODEL_URL: 'vendor/face-api/model/',
  // A match is "sure" only when the best distance is under this...
  FACE_MATCH_MAX: 0.45,
  // ...and the next-closest different person is at least this much farther away
  FACE_MATCH_MARGIN: 0.08,
  // Frames captured per returning-visitor attempt; most must agree
  FACE_FRAMES: 3,

  // Reload the page once a night (hour, local time) so the kiosk picks up updates
  NIGHTLY_RELOAD_HOUR: 3,
};
