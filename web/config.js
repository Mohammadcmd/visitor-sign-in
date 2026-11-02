// Kiosk settings.
//
// Connecting to the Apps Script backend:
//  - Android app: the build writes the connection into kiosk-connection.js
//    (see android/README.md), so the tablet needs no setup.
//  - Browser: open the kiosk once on the tablet with
//   https://<kiosk address>/?api=<Apps Script /exec URL>&key=<KIOSK_KEY>
// The tablet remembers both and removes them from the address bar, so the key
// never has to live in this publicly hosted file. (You can also paste them
// into API_URL / KIOSK_KEY below if the kiosk is hosted privately.)
//
// With no connection the kiosk runs in demo mode: everything is stored in this
// browser only and a "Simulate badge tap" panel appears.

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
  // Apps Script web app URL ending in /exec
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
