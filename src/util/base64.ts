const B64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Pure-JS base64 encoder for Uint8Array. RN doesn't reliably ship `btoa` for
// binary input across engines, and pulling in `Buffer`/polyfills isn't worth it.
// For our audio chunks (16-32 KB) this runs in a few ms.
export function base64FromUint8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64_CHARS[a >> 2];
    out += B64_CHARS[((a & 0x03) << 4) | (b >> 4)];
    out += B64_CHARS[((b & 0x0f) << 2) | (c >> 6)];
    out += B64_CHARS[c & 0x3f];
  }
  if (i < bytes.length) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    out += B64_CHARS[a >> 2];
    out += B64_CHARS[((a & 0x03) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) {
      out += B64_CHARS[(b & 0x0f) << 2];
      out += '=';
    } else {
      out += '==';
    }
  }
  return out;
}
