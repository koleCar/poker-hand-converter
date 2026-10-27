/**
 * Base64 for the chart blobs, written out so the module depends on neither
 * `Buffer` (Node only) nor `atob` (string-typed, and absent from some worker
 * shims). The chart set is JSON with its per-class arrays as base64 strings:
 * importable by the bundler and by Vitest alike, and a third of the size of
 * the same numbers written as JSON arrays.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const out = new Int16Array(128).fill(-1);
  for (let k = 0; k < ALPHABET.length; k += 1) {
    out[ALPHABET.charCodeAt(k)] = k;
  }
  return out;
})();

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  let k = 0;
  for (; k + 2 < bytes.length; k += 3) {
    const v = (bytes[k] << 16) | (bytes[k + 1] << 8) | bytes[k + 2];
    out += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + ALPHABET[v & 63];
  }
  const rest = bytes.length - k;
  if (rest === 1) {
    const v = bytes[k] << 16;
    out += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + "==";
  } else if (rest === 2) {
    const v = (bytes[k] << 16) | (bytes[k + 1] << 8);
    out += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + "=";
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (let k = 0; k < clean.length; k += 1) {
    const code = clean.charCodeAt(k);
    const d = code < 128 ? LOOKUP[code] : -1;
    if (d < 0) {
      throw new Error(`not base64 at ${k}`);
    }
    value = ((value << 6) | d) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (value >> bits) & 255;
      o += 1;
    }
  }
  return out;
}
