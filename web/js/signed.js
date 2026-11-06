// Signed text: license keys (VSI1.…) and license status files (VSS1.…), made
// by the seller's tools (tools/license/) with their private key. Checked by the
// kiosk (web/js/plans.js) and by the website before it accepts a status file
// (site/worker.js), with the public half of the key. Browser and Worker alike.

export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/**
 * Checks prefix.<payload>.<signature> against an ECDSA P-256 public key (JWK).
 * Resolves with { data } (the payload) or { error: 'format' | 'no_key' | 'signature' }.
 */
export async function verifySigned(prefix, text, publicKey) {
  const m = new RegExp(`^${prefix}\\.([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)$`).exec(String(text || '').trim().replace(/\s+/g, ''));
  if (!m) return { error: 'format' };
  if (!publicKey || !globalThis.crypto?.subtle) return { error: 'no_key' };
  let good = false;
  try {
    const pub = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(m[2]), new TextEncoder().encode(`${prefix}.${m[1]}`));
  } catch { return { error: 'signature' }; }
  if (!good) return { error: 'signature' };
  try { return { data: JSON.parse(new TextDecoder().decode(unb64url(m[1]))) }; } catch { return { error: 'signature' }; }
}
