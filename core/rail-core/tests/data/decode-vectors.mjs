// Writes decode-vectors.json: what the converter's `decodeSource`
// (web/src/components/converter/inputs.ts) makes of edge-case byte
// strings, for `rail_core::decode` to replay (docs/RAIL-PLAN.md R0.5).
//
//     node core/rail-core/tests/data/decode-vectors.mjs     (Node >= 23.6)
//
// Imports the TypeScript directly (Node strips the types). Deterministic
// (seeded), so rerunning it rewrites the same file. The corpus itself is
// covered by the goldens (`decode.encoding` / `decode.problem` per file); these
// are the cases the corpus does not have: odd UTF-16 lengths, lone surrogates,
// double byte-order marks, the cp1252 plausibility guard at its thresholds,
// whitespace-only text, invalid UTF-8 of every shape.

import { writeFileSync } from "node:fs";

const { decodeSource } = await import(
  new URL("../../../../web/src/components/converter/inputs.ts", import.meta.url)
);

let seed = 0x0dec0de5;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (n) => Math.floor(random() * n);
const bytesOf = (...parts) => Uint8Array.from(parts.flat());
const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const utf8 = (text) => [...new TextEncoder().encode(text)];
const utf16 = (text, le) =>
  [...text].flatMap((c) => {
    const units = [];
    for (let i = 0; i < c.length; i += 1) units.push(c.charCodeAt(i));
    return units.flatMap((u) => (le ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff]));
  });
const units16 = (units, le) => units.flatMap((u) => (le ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff]));
const hand = "PokerStars Hand #1: Hold'em No Limit ($0.01/$0.02)\r\nSeat 1: Ana (€2 in chips)\r\n";

const inputs = [];
const add = (name, bytes) => inputs.push({ name, bytes: Uint8Array.from(bytes) });

add("empty", []);
add("single newline", [10]);
add("whitespace only", ascii(" \t\r\n "));
add("BOM only", [0xef, 0xbb, 0xbf]);
add("BOM + whitespace", [0xef, 0xbb, 0xbf, 0x20, 0x0a]);
add("BOM + NBSP + FEFF", [0xef, 0xbb, 0xbf, ...utf8(" ﻿　")]);
add("NEL only", utf8("\u0085"));
add("double UTF-8 BOM", [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...ascii("x")]);
add("triple UTF-8 BOM", [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...ascii("x")]);
add("plain ascii", ascii(hand));
add("utf-8 hand", utf8(hand));
add("utf-8 BOM hand", [0xef, 0xbb, 0xbf, ...utf8(hand)]);
add("lone CR", ascii("a\rb\r\rc\r\n\nd\r"));
add("cp1252 euro", ascii(hand).map((b) => b).concat([0x80, 0x20, 0x41]));
add("cp1252 undefined bytes", [...ascii("abc "), 0x81, 0x8d, 0x8f, 0x90, 0x9d, ...ascii(" def").concat(Array(200).fill(0x61))]);
add("cp1252 all high", Array.from({ length: 128 }, (_, i) => 0x80 + i).concat(Array(5000).fill(0x61)));
add("cp1252 too many high", Array(100).fill(0xe9).concat(Array(1000).fill(0x61)));
add("cp1252 guard 5% exact", Array(50).fill(0xe9).concat(Array(950).fill(0x61)));
add("cp1252 guard just over 5%", Array(51).fill(0xe9).concat(Array(949).fill(0x61)));
add("cp1252 controls 2%", Array(20).fill(0x01).concat([0xe9], Array(979).fill(0x61)));
add("cp1252 controls over 2%", Array(21).fill(0x01).concat([0xe9], Array(978).fill(0x61)));
add("binary-ish utf-8", Array(60).fill(0x01).concat(Array(940).fill(0x61)));
add("binary at 5%", Array(50).fill(0x01).concat(Array(950).fill(0x61)));
add("binary 5.1%", Array(51).fill(0x02).concat(Array(949).fill(0x61)));
add("control after 4096", Array(4096).fill(0x61).concat(Array(1000).fill(0x01)));
add("invalid utf-8 shapes", [...ascii("a"), 0xc0, 0x80, 0xe0, 0x80, 0x80, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0xf0, 0x9f, 0x98, 0xc3, 0x28, 0xe2, 0x82, 0xff, 0xfe, ...ascii("b")]);
add("truncated utf-8 at end", [...ascii("abc"), 0xe2, 0x82]);
add("utf-16le BOM", [0xff, 0xfe, ...utf16(hand, true)]);
add("utf-16be BOM", [0xfe, 0xff, ...utf16(hand, false)]);
add("utf-16le no BOM", utf16(hand, true));
add("utf-16be no BOM", utf16(hand, false));
add("utf-16le double BOM", [0xff, 0xfe, 0xff, 0xfe, ...utf16("hi", true)]);
add("utf-16le BOM odd length", [0xff, 0xfe, ...utf16("hello", true), 0x41]);
add("utf-16le lone lead at end", [0xff, 0xfe, ...units16([0x61, 0xd83d], true)]);
add("utf-16le lone lead + odd byte", [0xff, 0xfe, ...units16([0x61, 0xd83d], true), 0x41]);
add("utf-16le lone trail", [0xff, 0xfe, ...units16([0x61, 0xde00, 0x62], true)]);
add("utf-16le lead then lead", [0xff, 0xfe, ...units16([0xd83d, 0xd83d, 0xde00, 0x63], true)]);
add("utf-16le emoji", [0xff, 0xfe, ...utf16("a\u{1F600}b€", true)]);
add("utf-16be lone lead + odd", [0xfe, 0xff, ...units16([0x61, 0xd800], false), 0x00]);
add("utf-16 no BOM short", utf16("hi", true));
add("one byte", [0x41]);
add("one high byte", [0xe9]);
add("nul", [0x00]);
add("ff fe only", [0xff, 0xfe]);
add("fe ff only", [0xfe, 0xff]);
add("ef bb only", [0xef, 0xbb]);
add("utf-16le binary noise", [0xff, 0xfe, ...units16(Array.from({ length: 100 }, (_, i) => i % 32), true)]);
add("mixed NUL pattern", Array.from({ length: 1024 }, (_, i) => (i % 3 === 0 ? 0 : 0x61)));
add("utf-16le threshold", Array.from({ length: 1000 }, (_, i) => (i % 2 === 1 && i < 302 ? 0 : 0x61)));
add("utf-16le threshold+", Array.from({ length: 1000 }, (_, i) => (i % 2 === 1 && i < 304 ? 0 : 0x61)));

for (let n = 0; n < 90; n += 1) {
  const kind = int(6);
  const length = 1 + int(kind === 5 ? 1500 : 300);
  let bytes;
  if (kind === 0) {
    bytes = Array.from({ length }, () => (random() < 0.03 ? 0x80 + int(128) : 0x20 + int(95)));
  } else if (kind === 1) {
    bytes = Array.from({ length }, () => int(256));
  } else if (kind === 2) {
    const units = Array.from({ length }, () => (random() < 0.05 ? 0xd800 + int(0x800) : random() < 0.1 ? int(0x10000) : 0x20 + int(95)));
    bytes = [...(random() < 0.5 ? [0xff, 0xfe] : []), ...units16(units, true), ...(random() < 0.3 ? [0x41] : [])];
  } else if (kind === 3) {
    const units = Array.from({ length }, () => (random() < 0.05 ? 0xd800 + int(0x800) : 0x20 + int(95)));
    bytes = [...(random() < 0.5 ? [0xfe, 0xff] : []), ...units16(units, false), ...(random() < 0.3 ? [0x41] : [])];
  } else if (kind === 4) {
    bytes = utf8(Array.from({ length }, () => String.fromCodePoint(random() < 0.9 ? 0x20 + int(95) : int(0x2fff) + 0x80)).join(""));
    const cut = int(bytes.length);
    if (random() < 0.5) bytes.splice(cut, 1);
  } else {
    bytes = Array.from({ length }, () => (random() < 0.01 ? int(32) : random() < 0.04 ? 0x80 + int(128) : 0x20 + int(95)));
  }
  add(`random ${n} kind ${kind}`, bytes);
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const cases = inputs.map(({ name, bytes }) => {
  const decoded = decodeSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  return { name, bytes: hex(bytes), encoding: decoded.encoding, problem: decoded.problem?.kind ?? null, text: decoded.text };
});
writeFileSync(
  new URL("./decode-vectors.json", import.meta.url),
  `{"generator": "decode-vectors.mjs", "cases": [\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`,
);
console.log(`${cases.length} cases`);
