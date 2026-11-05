// Who's who: staff accounts, sign-in codes, sessions, and which companies each
// person belongs to (and as what). One Durable Object holds it all; each
// company's records stay in that company's own object (src/company.js).
//
// Signing in and signing up are the same: type your email, get a six-digit
// code, type it. No passwords to store, forget or leak. Codes and session
// tokens are kept only as hashes.
import { DurableObject } from 'cloudflare:workers';
import { sendMail } from './mail.js';
import { cleanEmail, cleanName, randomId, randomToken, sha256, sixDigits } from './util.js';

const CODE_MS = 10 * 60 * 1000; // a code works for 10 minutes
const CODE_TRIES = 5; // wrong guesses before a code stops working
const CODES_PER_HOUR = 5; // codes one address can be sent in an hour
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const ROLES = ['owner', 'admin', 'frontdesk'];
/** Roles that can manage tablets and settings. */
export const MANAGERS = new Set(['owner', 'admin']);

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const q of [
      'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL, sent INTEGER NOT NULL, window INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS members (company_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (company_id, user_id))',
      'CREATE TABLE IF NOT EXISTS outbox (at INTEGER NOT NULL, mail TEXT NOT NULL)',
    ]) this.sql.exec(q);
  }

  one(q, ...b) { return this.sql.exec(q, ...b).toArray()[0] || null; }

  /** Sends a sign-in code to this address (signing up if it's new). The answer never says whether the address has an account. */
  async startSignIn(email) {
    const to = cleanEmail(email);
    if (!to) return { ok: false, error: 'email' };
    const now = Date.now();
    const prev = this.one('SELECT sent, window FROM codes WHERE email = ?', to);
    const fresh = !prev || now - prev.window > 60 * 60 * 1000;
    const sent = fresh ? 1 : prev.sent + 1;
    if (sent > CODES_PER_HOUR) return { ok: false, error: 'too_many' };
    const code = sixDigits();
    this.sql.exec('INSERT INTO codes (email, hash, expires, tries, sent, window) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires, tries = 0, sent = excluded.sent, window = excluded.window',
      to, await sha256(`${to}:${code}`), now + CODE_MS, sent, fresh ? now : prev.window);
    const res = await sendMail(this.env, {
      to,
      subject: `${code} is your Visitor Sign-In code`,
      text: `Your sign-in code is ${code}\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.\n`,
    }, (mail) => this.sql.exec('INSERT INTO outbox (at, mail) VALUES (?, ?)', now, JSON.stringify(mail)));
    return res.ok ? { ok: true } : res;
  }

  /** Checks a code. On success: a session token, the person, and their companies. */
  async verifySignIn(email, code) {
    const to = cleanEmail(email);
    const row = to && this.one('SELECT hash, expires, tries FROM codes WHERE email = ?', to);
    if (!row || row.expires < Date.now() || row.tries >= CODE_TRIES) return { ok: false, error: 'code_expired' };
    if (!/^\d{6}$/.test(String(code ?? '')) || (await sha256(`${to}:${code}`)) !== row.hash) {
      this.sql.exec('UPDATE codes SET tries = tries + 1 WHERE email = ?', to);
      return { ok: false, error: row.tries + 1 >= CODE_TRIES ? 'code_expired' : 'code' };
    }
    this.sql.exec('UPDATE codes SET expires = 0 WHERE email = ?', to); // one use only (the hourly count stays)
    let user = this.one('SELECT id, email FROM users WHERE email = ?', to);
    if (!user) {
      user = { id: randomId('u'), email: to };
      this.sql.exec('INSERT INTO users (id, email, created) VALUES (?, ?, ?)', user.id, to, Date.now());
    }
    const token = randomToken();
    this.sql.exec('DELETE FROM sessions WHERE expires < ?', Date.now());
    this.sql.exec('INSERT INTO sessions (hash, user_id, expires) VALUES (?, ?, ?)', await sha256(token), user.id, Date.now() + SESSION_MS);
    return { ok: true, session: token, user, companies: this.companiesOf(user.id) };
  }

  /** The person signed in with this session token, or null. */
  async userOf(session) {
    if (typeof session !== 'string' || session.length < 20 || session.length > 100) return null;
    const row = this.one('SELECT u.id, u.email, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?', await sha256(session));
    return row && row.expires > Date.now() ? { id: row.id, email: row.email } : null;
  }

  companiesOf(userId) {
    return this.sql.exec('SELECT c.id, c.name, m.role FROM members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = ? ORDER BY c.created', userId).toArray();
  }

  async me(session) {
    const user = await this.userOf(session);
    return user ? { ok: true, user, companies: this.companiesOf(user.id) } : { ok: false, error: 'session' };
  }

  async signOut(session) {
    if (typeof session === 'string') this.sql.exec('DELETE FROM sessions WHERE hash = ?', await sha256(session));
    return { ok: true };
  }

  /** A new company, with the person creating it as its owner. */
  async createCompany(session, name) {
    const user = await this.userOf(session);
    if (!user) return { ok: false, error: 'session' };
    const n = cleanName(name);
    if (!n) return { ok: false, error: 'name' };
    if (this.companiesOf(user.id).length >= 20) return { ok: false, error: 'too_many' };
    const id = randomId('co');
    this.sql.exec('INSERT INTO companies (id, name, created) VALUES (?, ?, ?)', id, n, Date.now());
    this.sql.exec('INSERT INTO members (company_id, user_id, role) VALUES (?, ?, ?)', id, user.id, 'owner');
    return { ok: true, company: { id, name: n, role: 'owner' }, user };
  }

  /** What this session's person is at this company ('owner', 'admin', 'frontdesk'), or null. */
  async roleAt(session, companyId) {
    const user = await this.userOf(session);
    if (!user) return { user: null, role: null };
    const row = this.one('SELECT role FROM members WHERE company_id = ? AND user_id = ?', companyId, user.id);
    return { user, role: row ? row.role : null };
  }

  /** Adds a colleague (by email) to a company, or changes their role. Owners and admins only; only an owner makes owners. */
  async addMember(session, companyId, email, role) {
    const { user, role: mine } = await this.roleAt(session, companyId);
    if (!user) return { ok: false, error: 'session' };
    if (!MANAGERS.has(mine)) return { ok: false, error: 'forbidden' };
    const to = cleanEmail(email);
    if (!to) return { ok: false, error: 'email' };
    if (!ROLES.includes(role) || (role === 'owner' && mine !== 'owner')) return { ok: false, error: 'role' };
    let member = this.one('SELECT id FROM users WHERE email = ?', to);
    if (!member) {
      member = { id: randomId('u') };
      this.sql.exec('INSERT INTO users (id, email, created) VALUES (?, ?, ?)', member.id, to, Date.now());
    }
    const current = this.one('SELECT role FROM members WHERE company_id = ? AND user_id = ?', companyId, member.id);
    if (current && current.role === 'owner' && mine !== 'owner') return { ok: false, error: 'forbidden' };
    this.sql.exec('INSERT INTO members (company_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(company_id, user_id) DO UPDATE SET role = excluded.role', companyId, member.id, role);
    return { ok: true };
  }

  /** Emails sent in log mode (MAIL_MODE=log), newest last: for tests and local development only. */
  outbox() {
    return this.sql.exec('SELECT mail FROM outbox ORDER BY at, rowid').toArray().map((r) => JSON.parse(r.mail));
  }
}
