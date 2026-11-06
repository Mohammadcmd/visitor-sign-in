// Small helpers shared by the Worker and its Durable Objects.

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A random, unguessable token: 32 bytes, base64url. */
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

/** A random id with a prefix, such as co-7K2M9X4QZP1R8T6V3B5N. Letters and digits only, easy to read aloud. */
export function randomId(prefix, length = 20) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return `${prefix}-${[...bytes].map((b) => alphabet[b % 32]).join('')}`;
}

/** A six-digit sign-in code, evenly spread over 000000–999999. */
export function sixDigits() {
  const buf = new Uint32Array(1);
  let n;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= 4294000000); // drop the uneven tail
  return String(n % 1000000).padStart(6, '0');
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** An email address in one form (trimmed, lowercase), or '' if it doesn't look like one. */
export function cleanEmail(v) {
  const e = String(v ?? '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[a-z]{2,}$/.test(e) ? e : '';
}

/** A business or tablet name: one line, at most max characters. */
export const cleanName = (v, max = 80) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A valid IANA time zone, such as America/Chicago. */
export function validZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
