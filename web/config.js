// Kiosk settings.
//
// Connecting to the Raspberry Pi (http://<pi address>/api, see pi/README.md):
//  - Built into the Android app at build time (kiosk-connection.js, see
//    android/README.md), so the tablet needs no setup, or
//  - entered once on the tablet in admin Settings, section 5. The tablet
//    remembers it. (Opening the kiosk with ?api=<address>&key=<key> does the same.)
//
// With no connection the kiosk runs in demo mode: everything is stored on this
// tablet only and a "Simulate badge tap" panel appears.

const STORAGE_KEY = 'shocktech-kiosk-connection';

function connection() {
  // Built into the Android app at build time; always wins.
  const built = window.KIOSK_CONNECTION;
  if (built && built.api && built.key) return built;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { /* private mode */ }
  const q = new URLSearchParams(location.search);
  if (q.get('api') && q.get('key')) {
    saved = { api: q.get('api'), key: q.get('key') };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch { /* kept for this session only */ }
    history.replaceState(null, '', location.pathname);
  } else if (q.has('disconnect')) {
    saved = {};
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing stored */ }
    history.replaceState(null, '', location.pathname);
  }
  return saved;
}

const saved = connection();

export const CONFIG = {
  // The Pi's address: http://<pi address>/api
  API_URL: saved.api || '',
  // Must equal the KIOSK_KEY script property
  KIOSK_KEY: saved.key || '',

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
