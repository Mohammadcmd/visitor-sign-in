// Visitor Sign-In on a Raspberry Pi or a PC: the records for screenless
// sign-in (a QR code by the door, visitors use their own phones) and for any
// kiosk or admin screen connected to it. Everything stays in one folder on
// this computer. See server/README.md.
//
// It answers the same requests as the Google Sheets script (apps-script/Code.gs),
// with the kiosk's own record engine (web/js/engine.js), so the kiosk, the
// admin screen and phones work with it unchanged:
//   { key, action, args, rid }   the kiosk and admin screen (the kiosk key)
//   { phone, action, args }      visitors' phones (the phone key on the QR code:
//                                only PHONE_ACTIONS, and a limited number)
//
// Phones and the admin screen reach it through the website (site/worker.js),
// which this computer keeps a connection open to: see relay.mjs.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine, emptyStore, makeClock, READS, PHONE_ACTIONS, randomCode } from '../web/js/engine.js';
import { normalize } from '../web/js/settings.js';

/** The request format version (BACKEND_VERSION in web/js/api.js and apps-script/Code.gs; the tests check they match). */
export const BACKEND_VERSION = 7;
export const PHONE_RATE = { seconds: 10 * 60, max: 60 }; // at most 60 phone sign-ins, sign-outs and declines in 10 minutes
const REPLAY_MS = 10 * 60 * 1000;
const BACKUPS_KEPT = 30;

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
/** Writes a file so a power cut never leaves half of it: a new file, then a rename. */
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

/** Photos and signatures, as image files in files/ (visitor-P1A2B3.jpg…). */
function fileStore(dir) {
  mkdirSync(dir, { recursive: true });
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
  const base = (key) => {
    const name = String(key).replace(':', '-');
    if (!/^[a-z]+-[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error(`bad file key ${key}`);
    return name;
  };
  const find = (key) => Object.keys(MIME).map((e) => join(dir, `${base(key)}.${e}`)).find((f) => existsSync(f));
  return {
    async put(key, dataUrl) {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
      if (!m) return;
      const old = find(key);
      if (old) rmSync(old);
      writeFileSync(join(dir, `${base(key)}.${EXT[m[1]]}`), Buffer.from(m[2], 'base64'));
    },
    async get(key) {
      const f = find(key);
      if (!f) return '';
      return `data:${MIME[f.split('.').pop()]};base64,${readFileSync(f).toString('base64')}`;
    },
    async del(key) { const f = find(key); if (f) rmSync(f); },
  };
}

/**
 * Opens (or makes, the first time) the records in dataDir.
 *   name         what this computer is called in the kiosk ("Front desk Pi")
 *   defaultName  the name the first time, when none is given (this computer's name)
 *   timeZone  the calendar for expected visitors and the end of day ('' = this computer's)
 */
export function openBox({ dataDir, name = '', defaultName = '', timeZone = '' }) {
  mkdirSync(dataDir, { recursive: true });
  const configFile = join(dataDir, 'config.json');
  let config = readJson(configFile, null);
  if (!config) {
    // The box's address on the website, its secret for connecting there, and the kiosk key.
    config = {
      boxId: randomCode(20).toLowerCase(), boxSecret: randomBytes(32).toString('base64url'),
      kioskKey: `k-${randomCode(30)}`, name: name || defaultName || 'Visitor Sign-In box', created: new Date().toISOString(),
    };
    writeJson(configFile, config);
  } else if (name && name !== config.name) {
    config.name = name;
    writeJson(configFile, config);
  }

  const storeFile = join(dataDir, 'records.json');
  const settingsFile = join(dataDir, 'settings.json');
  const store = { ...emptyStore(), ...readJson(storeFile, {}) };
  let current = normalize(readJson(settingsFile, null));
  const engine = createEngine({
    version: BACKEND_VERSION,
    settings: () => current,
    saveSettings: (next) => { current = normalize(next); writeJson(settingsFile, current); },
    files: fileStore(join(dataDir, 'files')),
    clock: makeClock(timeZone),
  });

  /** A copy of the records each day, the last 30 kept (backups/records-2026-11-10.json). */
  function backup() {
    const dir = join(dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `records-${new Date().toISOString().slice(0, 10)}.json`);
    if (!existsSync(file)) writeJson(file, store);
    const old = readdirSync(dir).filter((f) => /^records-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -BACKUPS_KEPT);
    for (const f of old) rmSync(join(dir, f));
  }
  const save = () => { writeJson(storeFile, store); backup(); };

  const replays = new Map(); // rid → { at, out }: a retried write gets the first answer instead of writing twice
  let phoneWindow = { start: 0, n: 0 };
  let queue = Promise.resolve();
  /** One request at a time, so two sign-ins never trip over each other. */
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  let localBase = '';
  async function status(extra = {}) {
    const p = await engine.act(store, 'ping', {});
    // Where phones find it on the local Wi-Fi, for the poster's QR code (local.mjs).
    const local = localBase ? { web: `${localBase}web/`, api: `${localBase}box/${config.boxId}` } : {};
    return { ...p, sheetName: config.name, backend: 'box', ...local, ...extra };
  }

  /**
   * Answers one request from a kiosk, the admin screen or a visitor's phone.
   * secure: false for the local Wi-Fi page (http), where phones can't use the camera.
   */
  async function handle(req, { secure = true } = {}) {
    if (!req || typeof req !== 'object' || typeof req.action !== 'string') return { ok: false, error: 'bad_request' };
    if (req.action === 'claim') {
      if (typeof req.key !== 'string' || !/^[A-Za-z0-9-]{24,64}$/.test(req.key)) return { ok: false, error: 'bad_key' };
      // The kiosk key is made here: a kiosk connects with the setup link, which carries it.
      if (req.key !== config.kioskKey) return { ok: false, error: 'claimed' };
      return status({ claimed: false });
    }
    let args = req.args && typeof req.args === 'object' ? req.args : {};
    if (typeof req.phone === 'string') {
      if (!store.phoneKey || req.phone !== store.phoneKey) return { ok: false, error: 'phone_link' };
      if (!PHONE_ACTIONS.includes(req.action)) return { ok: false, error: 'not_allowed' };
      if (req.action !== 'phoneStart') {
        // Anyone could photograph the poster, so phones get a limited number of writes.
        const win = Math.floor(Date.now() / (PHONE_RATE.seconds * 1000));
        if (phoneWindow.start !== win) phoneWindow = { start: win, n: 0 };
        if (++phoneWindow.n > PHONE_RATE.max) return { ok: false, error: 'too_many' };
      }
      if (!secure) args = { ...args, noCamera: true };
    } else if (req.key !== config.kioskKey) {
      return { ok: false, error: 'kiosk_key' };
    }
    if (req.action === 'ping') return status();
    if (req.action === 'phoneStart' && !secure) {
      // No camera on a page that isn't https: the phone skips the photo.
      const out = await engine.act(store, 'phoneStart', {});
      return out.ok ? { ...out, settings: { ...out.settings, photos: 'off', quickEntry: false } } : out;
    }

    const write = !READS.has(req.action);
    const rid = write && typeof req.rid === 'string' && /^[A-Za-z0-9-]{6,64}$/.test(req.rid) ? req.rid : '';
    return serial(async () => {
      const now = Date.now();
      for (const [k, v] of replays) if (now - v.at > REPLAY_MS) replays.delete(k);
      if (rid && replays.has(rid)) return replays.get(rid).out;
      const out = await engine.act(store, req.action, args);
      if (write && out && out.ok !== false) save();
      if (rid) replays.set(rid, { at: now, out });
      return out;
    });
  }

  /**
   * What a kiosk does by itself, done here since there may be no kiosk: sign
   * everyone still inside out at the end of the day (Finishing touches → End of
   * day), and delete records older than the retention period. Run it every minute.
   */
  function chores(now = new Date()) {
    return serial(async () => {
      const st = current;
      if (!st.setupComplete) return { endOfDay: 0, purged: false };
      let signedOut = 0;
      let purged = false;
      if (st.endOfDay) {
        const [h, m] = st.endOfDay.split(':').map(Number);
        const cutoff = new Date(now);
        cutoff.setHours(h, m, 0, 0);
        if (cutoff > now) cutoff.setDate(cutoff.getDate() - 1);
        if (!store.lastEndOfDay || new Date(store.lastEndOfDay) < cutoff) {
          signedOut = (await engine.act(store, 'endOfDay', { before: cutoff.toISOString() })).signedOut || 0;
          store.lastEndOfDay = cutoff.toISOString();
          save();
        }
      }
      const today = now.toISOString().slice(0, 10);
      if (st.retentionDays && store.lastPurge !== today) {
        await engine.act(store, 'purgeOld', {});
        store.lastPurge = today;
        purged = true;
        save();
      }
      return { endOfDay: signedOut, purged };
    });
  }

  return {
    config,
    handle,
    chores,
    /** Where it's served on the local network (serveLocal), so the admin screen's QR code points there. */
    setLocal(base) { localBase = base ? base.replace(/\/?$/, '/') : ''; },
    /** For the README and the console: where to open the kiosk connected to this box. */
    links(siteUrl) {
      const site = siteUrl.replace(/\/?$/, '/');
      const api = `${site}box/${config.boxId}`;
      return { api, setup: `${site}web/?api=${encodeURIComponent(api)}&key=${encodeURIComponent(config.kioskKey)}` };
    },
  };
}
