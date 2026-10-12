// Writes js-sort-vectors.json: how V8's `Array.prototype.sort` orders arrays
// under `(a, b) => a - b` and `(a, b) => b - a` when some values are `NaN`
// (an inconsistent comparator: `NaN` reads as "equal") or `±Infinity`, for
// `rail_core::js::sort` to replay (docs/RAIL-PLAN.md R0.9: iPoker sorts its
// actions by `Number(no)`).
//
//     node core/rail-core/tests/data/js-sort-vectors.mjs
//
// Each case is `{ values, descending, order }`: the values (numbers, or the
// strings "NaN", "Infinity", "-Infinity"), whether the comparator is `b - a`,
// and the resulting order as indices into `values`. Sizes run past 64, where
// TimSort starts merging runs and galloping. Deterministic (seeded).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(0x50e7);
const below = (n) => Math.floor(random() * n);

const encode = (v) => (Number.isNaN(v) ? "NaN" : Number.isFinite(v) ? v : String(v));

function values(size, shape) {
  const nanRate = [0, 0.02, 0.1, 0.4, 1][below(5)];
  const infRate = below(4) === 0 ? 0.05 : 0;
  const range = [2, 5, 20, 1000][below(4)];
  const out = [];
  for (let i = 0; i < size; i += 1) {
    let v;
    if (shape === "ascending") v = i + below(3);
    else if (shape === "descending") v = size - i + below(3);
    else if (shape === "sawtooth") v = (i % (5 + below(40))) + below(2);
    else if (shape === "runs") v = Math.floor(i / 9) % 2 === 0 ? i : size - i;
    else v = below(range);
    const roll = random();
    if (roll < nanRate) v = NaN;
    else if (roll < nanRate + infRate) v = random() < 0.5 ? Infinity : -Infinity;
    out.push(v);
  }
  return out;
}

const SHAPES = ["random", "ascending", "descending", "sawtooth", "runs"];
const SIZES = [0, 1, 2, 3, 5, 8, 13, 31, 32, 33, 63, 64, 65, 100, 127, 128, 200, 257, 400, 1000];
const cases = [];
for (const size of SIZES) {
  for (const shape of SHAPES) {
    for (let k = 0; k < (size > 300 ? 4 : 12); k += 1) {
      const vals = values(size, shape);
      const descending = random() < 0.3;
      const tagged = vals.map((v, i) => ({ v, i }));
      tagged.sort(descending ? (a, b) => b.v - a.v : (a, b) => a.v - b.v);
      cases.push({ values: vals.map(encode), descending, order: tagged.map((t) => t.i) });
    }
  }
}

writeFileSync(
  fileURLToPath(new URL("./js-sort-vectors.json", import.meta.url)),
  `${JSON.stringify({ cases })}\n`,
);
console.log(`${cases.length} cases`);
