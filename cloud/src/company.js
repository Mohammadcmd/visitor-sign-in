// One company: its records, settings and kiosk key, in a Durable Object of its
// own. Each company's data lives in its own small SQLite database, so one
// company can never see another's.
//
// It answers the same actions, with the same JSON, as the Google Sheets script
// (apps-script/Code.gs) and the on-tablet kiosk, because it runs the same
// engine (web/js/engine.js). So a kiosk talks to it exactly as it talks to a
// sheet: claim it with a kiosk key, then send that key with every call.
import { DurableObject } from 'cloudflare:workers';
import { createEngine, makeClock, READS } from '../../web/js/engine.js';
import { normalize } from '../../web/js/settings.js';
import { RecordStore } from './store.js';
import { r2Files } from './files.js';

/** The actions match version 5 of the Google Sheets script. */
export const BACKEND_VERSION = 5;
const REPLAY_MS = 30 * 60 * 1000;
const MAX_SETTINGS_CHARS = 1500000;
const validZone = (tz) => {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

export class Company extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.records = new RecordStore(ctx.storage.sql);
    this.store = null; // the records in memory, read once
    this.queue = Promise.resolve();
    this.current = normalize(this.records.get('settings'));
    this.files = r2Files(env.FILES, `c/${ctx.id.toString()}`);
    this.engine = this.makeEngine();
  }

  makeEngine() {
    const tz = this.records.get('timeZone', 'UTC');
    return createEngine({
      version: BACKEND_VERSION,
      settings: () => this.current,
      saveSettings: (next) => {
        this.current = normalize(next);
        this.records.set('settings', this.current);
      },
      files: this.files,
      clock: makeClock(validZone(tz) ? tz : 'UTC'),
    });
  }

  /** One request from a kiosk: { key, action, args, rid }. Called by the Worker. */
  handle(req) {
    // One action at a time: tablets never overwrite each other, even while a photo is being saved.
    const run = this.queue.then(() => this.answer(req || {}));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Forgets the records held in memory, so the next request reads them again (tests use this). */
  reload() {
    this.store = null;
  }

  async answer(req) {
    if (req.action === 'claim') return this.claim(req.key, req.tz);
    const key = this.records.get('kioskKey');
    if (!key) return { ok: false, error: 'not_connected' };
    if (req.key !== key) return { ok: false, error: 'kiosk_key' };
    const action = String(req.action || '');
    const args = req.args && typeof req.args === 'object' ? req.args : {};
    if (action === 'adminSaveSettings' && JSON.stringify(args).length > MAX_SETTINGS_CHARS) return { ok: false, error: 'too_big' };

    // A retried write (same request id) gets the first answer instead of writing twice.
    const rid = !READS.has(action) && typeof req.rid === 'string' && /^[A-Za-z0-9-]{6,64}$/.test(req.rid) ? req.rid : '';
    if (rid) {
      const seen = this.records.reply(rid, REPLAY_MS);
      if (seen) return seen;
    }
    if (!this.store) this.store = this.records.load();
    let out;
    try {
      out = await this.engine.act(this.store, action, args);
    } catch (err) {
      this.store = null; // read the saved copy again rather than keep a half-done change
      console.error(err && err.stack || err);
      return { ok: false, error: 'server', message: String(err && err.message || err) };
    }
    if (!READS.has(action)) this.records.save(this.store);
    if (rid && out && out.error !== 'busy') this.records.remember(rid, out, REPLAY_MS);
    if (action === 'getSettings' && out.ok) out = { ...out, settings: withoutPin(out.settings) };
    return out;
  }

  /** The first kiosk to connect sets the company's kiosk key; others must bring the same key. */
  async claim(key, tz) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9-]{24,64}$/.test(key)) return { ok: false, error: 'bad_key' };
    const have = this.records.get('kioskKey');
    if (have && have !== key) return { ok: false, error: 'claimed' };
    if (!have) {
      this.records.set('kioskKey', key);
      // The company's calendar (for "today", end of day and expected visitors) is the first tablet's.
      if (validZone(tz)) {
        this.records.set('timeZone', tz);
        this.engine = this.makeEngine();
      }
    }
    if (!this.store) this.store = this.records.load();
    const status = await this.engine.act(this.store, 'ping', {});
    return { ...status, claimed: !have, timeZone: this.records.get('timeZone', 'UTC') };
  }
}

/** Settings as a kiosk sees them: everything but the admin PIN's hash. */
function withoutPin(s) {
  return { ...s, admin: { ...s.admin, pinHash: '' } };
}
