// Makes the signing key for license keys. Run once:
//   node tools/license/keygen.mjs [path]      (default: license-private.pem)
//
// Keep the private key file secret and backed up: anyone with it can make
// license keys, and without it you can't make new ones. It is listed in
// .gitignore so it isn't committed by accident. Paste the public key it
// prints into PAYWALL.publicKey in web/js/plans.js.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const file = process.argv[2] || 'license-private.pem';
if (existsSync(file)) {
  console.error(`${file} already exists. Keep using it, or move it away first: licenses made with the old key would stop working.`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const jwk = publicKey.export({ format: 'jwk' });
console.log(`Private key saved to ${file}. Keep it secret and backed up.\n`);
console.log('Paste this into PAYWALL.publicKey in web/js/plans.js:\n');
console.log(`  publicKey: ${JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })},`);
