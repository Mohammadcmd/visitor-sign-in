// Photos, signatures and logos in R2, one folder per company. The engine hands
// over and asks for data URLs (what the kiosk sends and shows); R2 keeps the
// image itself with its type, so it can be served and counted as an image.

const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** bucket: an R2 binding; folder: this company's prefix. */
export function r2Files(bucket, folder) {
  const path = (key) => `${folder}/${String(key).replace(/[^A-Za-z0-9:._-]/g, '_')}`;
  return {
    async put(key, dataUrl) {
      const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl || '');
      if (!m) return;
      await bucket.put(path(key), fromBase64(m[2]), { httpMetadata: { contentType: m[1] } });
    },
    async get(key) {
      const obj = await bucket.get(path(key));
      if (!obj) return '';
      const type = obj.httpMetadata?.contentType || 'application/octet-stream';
      return `data:${type};base64,${toBase64(new Uint8Array(await obj.arrayBuffer()))}`;
    },
    async del(key) {
      await bucket.delete(path(key));
    },
  };
}
