// One company: its records, settings and tablets, in a Durable Object of its
// own. Each company's data lives in its own small SQLite database, so one
// company can never see another's.
//
// It answers the same actions, with the same JSON, as the Google Sheets script
// (apps-script/Code.gs) and the on-tablet kiosk, because it runs the same
// engine (web/js/engine.js).
//
// Tablets get in one of two ways:
//   - Locked to the company (companies made by signing up): a manager signs in
//     on the tablet, which makes a key pair it can't export and registers the
//     public half here. To work, the tablet signs a one-time challenge with its
//     private key and gets a device token (good for 7 days, renewed by checking
//     in daily). Retiring the tablet revokes it at once.
//   - With a kiosk key, like a Google Sheet: the first kiosk claims the company
//     and others bring the same key. Only where ALLOW_KIOSK_KEY_COMPANIES is set
//     (local development and tests), never for companies made by signing up.
import { DurableObject } from 'cloudflare:workers';
import { createEngine, makeClock, READS } from '../../web/js/engine.js';
import { normalize } from '../../web/js/settings.js';
import { RecordStore } from './store.js';
import { r2Files } from './files.js';
import { cleanName, randomId, randomToken, sha256, validZone } from './util.js';

/** The actions match version 5 of the Google Sheets script. */
export const BACKEND_VERSION = 5;
const REPLAY_MS = 30 * 60 * 1000;
const MAX_SETTINGS_CHARS = 1500000;
const CHALLENGE_MS = 5 * 60 * 1000;
const DEVICE_TOKEN_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_EVERY_MS = 5 * 60 * 1000;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

/** What a tablet signs to check in. */
export const checkInMessage = (deviceId, nonce) => `vsi-checkin:${deviceId}:${nonce}`;

const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export class Company extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.records = new RecordStore(this.sql);
    for (const q of [
      'CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL, status TEXT NOT NULL, activated INTEGER NOT NULL, activated_by TEXT NOT NULL, last_seen INTEGER NOT NULL, retired INTEGER)',
      'CREATE TABLE IF NOT EXISTS device_tokens (hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS challenges (nonce TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires INTEGER NOT NULL)',
    ]) this.sql.exec(q);
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

  one(q, ...b) { return this.sql.exec(q, ...b).toArray()[0] || null; }

  /** One thing at a time: tablets never overwrite each other, even while a photo is being saved. */
  serial(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** One request from a kiosk: { key, action, args, rid, tz }. Called by the Worker. */
  handle(req) {
    return this.serial(() => this.answer(req || {}));
  }

  /** Forgets the records held in memory, so the next request reads them again (tests use this). */
  reload() {
    this.store = null;
  }

  /** Sets up a company made by signing up (once): its name and calendar. Called by the Worker. */
  init({ name, tz }) {
    return this.serial(() => {
      if (this.records.get('account')) return { ok: true, already: true };
      this.records.set('account', true);
      if (validZone(tz)) this.records.set('timeZone', tz);
      this.current = normalize({ ...this.current, org: { ...this.current.org, name: cleanName(name) || this.current.org.name } });
      this.records.set('settings', this.current);
      this.engine = this.makeEngine();
      return { ok: true };
    });
  }

  async answer(req) {
    if (req.action === 'claim') return this.claim(req.key, req.tz);
    const access = await this.access(req.key);
    if (access.error) return { ok: false, error: access.error };
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
    if (action === 'ping' && out.ok) out = { ...out, account: !!this.records.get('account'), timeZone: this.records.get('timeZone', 'UTC') };
    return out;
  }

  /** Whether this key lets a kiosk in: a device token from a locked tablet, or the company's kiosk key. */
  async access(key) {
    if (typeof key === 'string' && key.startsWith('dt.')) {
      const row = this.one('SELECT t.device_id, t.expires, d.status, d.last_seen FROM device_tokens t JOIN devices d ON d.id = t.device_id WHERE t.hash = ?', await sha256(key));
      if (!row || row.expires < Date.now() || row.status !== 'active') return { error: 'device_token' };
      if (Date.now() - row.last_seen > SEEN_EVERY_MS) this.sql.exec('UPDATE devices SET last_seen = ? WHERE id = ?', Date.now(), row.device_id);
      return { device: row.device_id };
    }
    const kioskKey = this.records.get('kioskKey');
    if (!kioskKey) return { error: 'not_connected' };
    if (key !== kioskKey) return { error: 'kiosk_key' };
    return { kiosk: true };
  }

  /** The first kiosk to connect sets the company's kiosk key; others must bring the same key. */
  async claim(key, tz) {
    if (this.records.get('account')) return { ok: false, error: 'account' };
    if (typeof key !== 'string' || !/^[A-Za-z0-9-]{24,64}$/.test(key)) return { ok: false, error: 'bad_key' };
    const have = this.records.get('kioskKey');
    if (have && have !== key) return { ok: false, error: 'claimed' };
    if (!have) {
      if (!this.env.ALLOW_KIOSK_KEY_COMPANIES) return { ok: false, error: 'sign_up' };
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

  // ---------------------------------------------------------------- tablets

  /** Registers a tablet's public key (a manager is signed in on it; the Worker has checked). */
  activateDevice({ publicKey, name, by }) {
    return this.serial(async () => {
      if (!this.records.get('account')) return { ok: false, error: 'not_found' };
      const jwk = publicKey && typeof publicKey === 'object' ? publicKey : {};
      const key = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
      if (key.kty !== 'EC' || key.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(key.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(key.y || '')) return { ok: false, error: 'public_key' };
      try { await crypto.subtle.importKey('jwk', key, ECDSA, false, ['verify']); } catch { return { ok: false, error: 'public_key' }; }
      const stored = JSON.stringify(key);
      const same = this.one("SELECT id, name FROM devices WHERE public_key = ? AND status = 'active'", stored);
      if (same) return { ok: true, device: same, already: true };
      const max = this.records.get('maxDevices', null);
      const active = this.one("SELECT COUNT(*) AS n FROM devices WHERE status = 'active'").n;
      if (max !== null && active >= max) return { ok: false, error: 'device_limit', max };
      const device = { id: randomId('dev', 16), name: cleanName(name, 60) || `Tablet ${active + 1}` };
      this.sql.exec("INSERT INTO devices (id, name, public_key, status, activated, activated_by, last_seen) VALUES (?, ?, ?, 'active', ?, ?, ?)",
        device.id, device.name, stored, Date.now(), cleanName(by, 254), Date.now());
      return { ok: true, device };
    });
  }

  listDevices() {
    const devices = this.sql.exec('SELECT id, name, status, activated, activated_by, last_seen, retired FROM devices ORDER BY activated').toArray()
      .map((d) => ({ id: d.id, name: d.name, status: d.status, activated: d.activated, activatedBy: d.activated_by, lastSeen: d.last_seen, retired: d.retired || 0 }));
    return { ok: true, devices, max: this.records.get('maxDevices', null) };
  }

  /** Stops a tablet for good: its tokens stop working at once. */
  retireDevice(deviceId) {
    return this.serial(() => {
      const id = String(deviceId ?? '');
      const d = this.one('SELECT status FROM devices WHERE id = ?', id);
      if (!d) return { ok: false, error: 'not_found' };
      this.sql.exec("UPDATE devices SET status = 'retired', retired = ? WHERE id = ?", Date.now(), id);
      this.sql.exec('DELETE FROM device_tokens WHERE device_id = ?', id);
      this.sql.exec('DELETE FROM challenges WHERE device_id = ?', id);
      return { ok: true };
    });
  }

  /** Step 1 of checking in: a one-time challenge for this tablet to sign. */
  deviceChallenge(deviceId) {
    return this.serial(() => {
      const id = String(deviceId ?? '');
      const d = this.one('SELECT status FROM devices WHERE id = ?', id);
      if (!d || d.status !== 'active') return { ok: false, error: 'device' };
      this.sql.exec('DELETE FROM challenges WHERE expires < ?', Date.now());
      const nonce = randomToken();
      this.sql.exec('INSERT INTO challenges (nonce, device_id, expires) VALUES (?, ?, ?)', nonce, id, Date.now() + CHALLENGE_MS);
      return { ok: true, nonce };
    });
  }

  /** Step 2: the signed challenge. Proves it's the tablet that was activated; answers with a device token. */
  deviceCheckIn(deviceId, nonce, signature) {
    return this.serial(async () => {
      const id = String(deviceId ?? '');
      const d = this.one('SELECT public_key, status FROM devices WHERE id = ?', id);
      if (!d || d.status !== 'active') return { ok: false, error: 'device' };
      const c = this.one('SELECT expires FROM challenges WHERE nonce = ? AND device_id = ?', String(nonce ?? ''), id);
      if (!c || c.expires < Date.now()) return { ok: false, error: 'challenge' };
      this.sql.exec('DELETE FROM challenges WHERE nonce = ?', nonce); // one use only
      let good = false;
      try {
        const key = await crypto.subtle.importKey('jwk', JSON.parse(d.public_key), ECDSA, false, ['verify']);
        good = typeof signature === 'string' && signature.length <= 100
          && await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(signature), new TextEncoder().encode(checkInMessage(id, nonce)));
      } catch { good = false; }
      if (!good) return { ok: false, error: 'signature' };
      const token = `dt.${randomToken()}`;
      const expires = Date.now() + DEVICE_TOKEN_MS;
      this.sql.exec('DELETE FROM device_tokens WHERE device_id = ? AND expires < ?', id, Date.now());
      this.sql.exec('INSERT INTO device_tokens (hash, device_id, expires) VALUES (?, ?, ?)', await sha256(token), id, expires);
      this.sql.exec('UPDATE devices SET last_seen = ? WHERE id = ?', Date.now(), id);
      return { ok: true, token, expires, timeZone: this.records.get('timeZone', 'UTC'), name: this.current.org.name };
    });
  }
}

/** Settings as a kiosk sees them: everything but the admin PIN's hash. */
function withoutPin(s) {
  return { ...s, admin: { ...s.admin, pinHash: '' } };
}
