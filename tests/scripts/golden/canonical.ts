/**
 * Canonical JSON for the golden oracle (`testdata/golden/README.md`).
 *
 * The Rust core has to produce these bytes exactly, so the form is chosen to be
 * what `serde_json::to_string_pretty` writes for a `serde_json::Value` built
 * without the `preserve_order` feature:
 *
 * - object keys sorted by their UTF-8 bytes (`BTreeMap<String, _>` order), not
 *   by UTF-16 code units, which is what a plain JS `sort()` would do and which
 *   differs once a key holds a character above U+FFFF;
 * - two-space indentation, `": "` after a key, `[]` and `{}` for empty
 *   containers, one trailing LF after the document;
 * - strings escaped the way both `JSON.stringify` and serde_json escape them:
 *   `\"`, `\\`, `\b \f \n \r \t`, other C0 controls as lowercase `\u00xx`,
 *   everything else (including non-ASCII and `/`) written as is;
 * - numbers are integers only (safe integers, no `-0`, no exponent).
 *
 * Anything that does not fit is an error rather than something to paper over:
 * a float inside a PHF document breaks PHF's first design rule (PHF-SPEC §1),
 * and a lone surrogate cannot exist in a Rust `String` at all.
 */

export class CanonicalJsonError extends Error {}

const utf8 = new TextEncoder();

/** Byte-order comparison of two strings' UTF-8 encodings. */
export function compareUtf8(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    if (x[i] !== y[i]) {
      return x[i] - y[i];
    }
  }
  return x.length - y.length;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function encodeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new CanonicalJsonError(`${path}: string holds a lone UTF-16 surrogate`);
  }
  // JSON.stringify's escaping for well-formed strings is exactly serde_json's.
  return JSON.stringify(value);
}

function encode(value: unknown, path: string, indent: string): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return encodeString(value, path);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(`${path}: ${value} is not a safe integer (floats are not allowed)`);
      }
      if (Object.is(value, -0)) {
        throw new CanonicalJsonError(`${path}: -0`);
      }
      return String(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`${path}: unsupported ${typeof value}`);
  }

  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const items = value.map((item, i) => {
      if (item === undefined) {
        throw new CanonicalJsonError(`${path}[${i}]: undefined inside an array`);
      }
      return `${inner}${encode(item, `${path}[${i}]`, inner)}`;
    });
    return `[\n${items.join(",\n")}\n${indent}]`;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError(`${path}: not a plain object (${proto?.constructor?.name})`);
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // An absent optional field and one set to `undefined` are the same thing.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareUtf8(a, b));
  if (entries.length === 0) {
    return "{}";
  }
  const fields = entries.map(
    ([key, v]) => `${inner}${encodeString(key, path)}: ${encode(v, `${path}.${key}`, inner)}`,
  );
  return `{\n${fields.join(",\n")}\n${indent}}`;
}

/** The canonical text of `value`, LF-terminated. Throws `CanonicalJsonError`. */
export function canonicalJson(value: unknown): string {
  return `${encode(value, "$", "")}\n`;
}
