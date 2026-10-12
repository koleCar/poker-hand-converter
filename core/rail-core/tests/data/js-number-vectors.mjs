// Writes js-number-vectors.json: JavaScript number operations as Node computes
// them, for `rail_core::js::number` to replay (docs/RAIL-PLAN.md R0.5).
//
//     node core/rail-core/tests/data/js-number-vectors.mjs
//
// Deterministic (seeded), so rerunning it rewrites the same file. Inputs are
// decimal strings - amounts as rooms print them, plus edge cases around
// rounding ties, 2^53, subnormals and overflow - and every output is written
// with `String(x)` (or `toFixed`), which is itself under test.

import { writeFileSync } from "node:fs";

let seed = 0x5eed1234;
function random() {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (items) => items[Math.floor(random() * items.length)];
const digits = (n) => Array.from({ length: n }, () => Math.floor(random() * 10)).join("");

function amount() {
  switch (Math.floor(random() * 8)) {
    case 0:
      return `${digits(1 + Math.floor(random() * 4))}.${digits(1 + Math.floor(random() * 3))}`;
    case 1:
      return `0.${digits(1 + Math.floor(random() * 6))}`;
    case 2:
      return digits(1 + Math.floor(random() * 18));
    case 3:
      return `-${digits(1 + Math.floor(random() * 3))}.${digits(2)}`;
    case 4:
      return `${digits(1 + Math.floor(random() * 3))}.${digits(1)}5`;
    case 5:
      return `${digits(1 + Math.floor(random() * 17))}.${digits(1 + Math.floor(random() * 17))}`;
    case 6:
      return `${digits(1)}.${digits(1 + Math.floor(random() * 3))}e${pick(["", "-", "+"])}${Math.floor(random() * 330)}`;
    default:
      return pick(["0", "-0", "0.5", "1.5", "2.5", "-0.5", "-1.5", "-2.5", "1.005", "0.29", "4.35",
        "9007199254740991", "9007199254740993", "4503599627370495.5", "4503599627370496.5",
        "5e-324", "2.4703282292062327e-324", "2.2250738585072014e-308", "1.7976931348623157e308",
        "1e21", "999999999999999999999", "0.000001", "0.0000001", "123456789012345678901234",
        "0x1F", "0b1011", "0o777", " 12 ", ".5", "5.", "-.25", "1e400", "-1e400", "Infinity"]);
  }
}

const cases = [];
const seen = new Set();
function add(op, a, b, out) {
  const key = `${op}|${a}|${b ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  cases.push(b === undefined ? { op, a, out } : { op, a, b, out });
}

const multipliers = ["100", "1", "10", "1000", "0.01", "3", "-100"];
for (let i = 0; i < 250; i += 1) {
  const a = amount();
  const x = Number(a);
  add("parse", a, undefined, String(x));
  add("round", a, undefined, String(Math.round(x)));
  if (Math.abs(x) < 1e21 && Number.isFinite(x)) {
    add("toFixed2", a, undefined, x.toFixed(2));
    add("toFixed0", a, undefined, x.toFixed(0));
  }
  const m = pick(multipliers);
  add("mul", a, m, String(x * Number(m)));
  const prod = String(x * 100);
  add("round", prod, undefined, String(Math.round(Number(prod))));
  const b = amount();
  add("add", a, b, String(x + Number(b)));
  add("sub", a, b, String(x - Number(b)));
  add("div", a, pick(["100", "3", "7", "0.1", "1e-300", "0", "-2"]), "");
  const last = cases[cases.length - 1];
  if (last.op === "div" && last.out === "") {
    last.out = String(x / Number(last.b));
  }
  add("div", a, b, String(x / Number(b)));
}

writeFileSync(
  new URL("./js-number-vectors.json", import.meta.url),
  `{"generator": "js-number-vectors.mjs", "node": ${JSON.stringify(process.version)}, "cases": [\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`,
);
console.log(`${cases.length} cases`);
