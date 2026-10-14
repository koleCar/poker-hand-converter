// Writes reliability-vectors.json: the web's sample reliability
// (`frontend/src/lib/stats/reliability.ts`, applied by `display.ts`'s
// `statReliability`) for `rail_stats::reliability` to replay
// (docs/RAIL-PLAN.md R2.5, `tests/reliability.rs`).
//
//     cd tests && npm ci
//     node core/rail-stats/tests/data/reliability-vectors.mjs
//
// It needs no goldens: the totals are display-vectors.json's (R2.4) - the
// corpus summed as reports sum it (558 groups, which `tests/display.rs`
// re-derives from the Rust rows) and 600 synthetic totals - so regenerate
// this file whenever that one is regenerated (`meta.inputs` is the sha-256
// of those totals; the Rust test says when it is stale).
//
// - `stats`: per display-vectors case, every shipped statistic's level,
//   opacity, Wilson bounds and their text.
// - `wilson`: `made` and `n` at the edges (n = 0, made = 0, made = n, made
//   outside 0..n, fractions, 2^53, 1e308) and seeded random ones.
// - `samples`: `sampleReliability(sample, min)` at the edges and at random.
// - `sqrt`: `Math.sqrt` of seeded random doubles (every exponent range,
//   subnormals included), perfect squares and the special values - the one
//   operation R2.5 adds to `JsNumber`.
//
// Checked before writing: every interval is within 1e-9 percentage points
// of `lib/analysis/reports.ts`'s `wilsonInterval` (an independent
// implementation of the textbook form), and the level is `ok` exactly when
// R2.4's `full` says so.
//
// Deterministic: rerunning it rewrites the same file as long as the inputs,
// the definitions and the TypeScript are the same.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(join(ROOT, "tests/package.json"));
const esbuild = require("esbuild");

const bundle = await esbuild.build({
  stdin: {
    contents: `
      export { COUNTER_KEYS, MONEY_KEYS } from "./frontend/src/lib/stats/types.ts";
      export { compileStats, showStat, statRate } from "./frontend/src/lib/stats/display.ts";
      export { OPACITY_FLOOR, WILSON_Z, sampleReliability, wilson } from "./frontend/src/lib/stats/reliability.ts";
      export { wilsonInterval } from "./frontend/src/lib/analysis/reports.ts";
    `,
    resolveDir: ROOT,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "error",
  loader: { ".json": "json" },
});
const {
  COUNTER_KEYS,
  MONEY_KEYS,
  compileStats,
  showStat,
  statRate,
  OPACITY_FLOOR,
  WILSON_Z,
  sampleReliability,
  wilson,
  wilsonInterval,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const OUT = process.env.RELIABILITY_OUT ?? join(ROOT, "core/rail-stats/tests/data/reliability-vectors.json");
const DEFINITIONS_TEXT = readFileSync(join(ROOT, "config/stats/standard.json"), "utf8");
const STATS = compileStats(JSON.parse(DEFINITIONS_TEXT));
const DISPLAY = JSON.parse(readFileSync(join(ROOT, "core/rail-stats/tests/data/display-vectors.json"), "utf8"));

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
const random = mulberry32(0x5a3b1e);
const below = (n) => Math.floor(random() * n);

const str = (x) => (x === null ? "" : Object.is(x, -0) ? "-0" : String(x));

/** Within 1e-9 percentage points of the textbook form in `reports.ts` (fractions). */
function checkAgainstReports(where, made, n, interval) {
  const theirs = wilsonInterval(made, n, WILSON_Z);
  if (interval === null || theirs === null) {
    if ((interval === null) !== (theirs === null) && made >= 0 && made <= n && Number.isFinite(n) && n < 1e300) {
      throw new Error(`${where}: interval ${JSON.stringify(interval)}, reports.ts ${JSON.stringify(theirs)}`);
    }
    return;
  }
  const tolerance = 1e-9;
  if (Math.abs(interval.low - theirs.low * 100) > tolerance || Math.abs(interval.high - theirs.high * 100) > tolerance) {
    throw new Error(`${where}: ${interval.low}-${interval.high}, reports.ts ${theirs.low * 100}-${theirs.high * 100}`);
  }
}

/* ----------------------------------------------------------------- stats - */

const sumsOf = (totals) => ({
  counters: Object.fromEntries(COUNTER_KEYS.map((k, i) => [k, totals[i]])),
  money: Object.fromEntries(MONEY_KEYS.map((k, i) => [k, totals[COUNTER_KEYS.length + i]])),
  moneyHands: totals[COUNTER_KEYS.length + MONEY_KEYS.length],
  evNetBbMilli: totals[COUNTER_KEYS.length + MONEY_KEYS.length + 1],
});

const cases = [...DISPLAY.groups, ...DISPLAY.synthetic];
let intervals = 0;
const levels = { insufficient: 0, low: 0, ok: 0 };
const stats = cases.map(({ key, totals }) => {
  const sums = sumsOf(totals);
  return {
    key,
    out: STATS.map((stat) => {
      const shown = showStat(stat, sums, 2);
      const r = shown.reliability;
      if ((r.level === "ok") !== shown.full) throw new Error(`${key} ${stat.def.id}: level ${r.level}, full ${shown.full}`);
      levels[r.level] += 1;
      const rate = statRate(stat, sums);
      if (rate !== null) checkAgainstReports(`${key} ${stat.def.id}`, rate.made, rate.opportunities, r.interval);
      if (r.interval !== null) intervals += 1;
      return [
        r.level,
        str(r.opacity),
        str(r.interval?.low ?? null),
        str(r.interval?.high ?? null),
        r.intervalText?.low ?? "",
        r.intervalText?.high ?? "",
      ].join("|");
    }),
  };
});

/* ---------------------------------------------------------------- wilson - */

const WILSON_EDGES = [
  [0, 0], [1, 0], [0, -1], [-1, 3], [4, 3], [-0, 3], [3, -0], [Number.NaN, 3], [3, Infinity], [Infinity, Infinity],
  [0, 1], [1, 1], [0, 2], [1, 2], [2, 2], [0, 3], [1, 3], [3, 3], [23, 80], [12, 40], [400, 1000],
  [0, 1_000_000], [1, 1_000_000], [999_999, 1_000_000], [1_000_000, 1_000_000],
  [0, 2 ** 53], [1, 2 ** 53], [2 ** 52, 2 ** 53], [2 ** 53 - 1, 2 ** 53], [2 ** 53, 2 ** 53],
  [1e15, 1e15 + 1], [2 ** 60, 2 ** 61], [5, 1e300], [1e308, 1e308], [1e300, 1e308],
  [0.5, 1], [0.25, 0.5], [1e-300, 1e-300], [1e-300, 2e-300], [5e-324, 5e-324], [0.1, 0.3],
];
const wilsonCases = [...WILSON_EDGES];
for (let i = 0; i < 3000; i += 1) {
  const scale = [3, 20, 100, 1000, 30_000, 2_000_000, 2 ** 40][below(7)];
  const n = 1 + below(scale);
  const r = random();
  const made = r < 0.1 ? 0 : r < 0.2 ? n : below(n + 1);
  wilsonCases.push([made, n]);
}
const wilsonOut = wilsonCases.map(([made, n]) => {
  const interval = wilson(made, n);
  checkAgainstReports(`wilson(${made}, ${n})`, made, n, interval);
  return [str(made), str(n), str(interval?.low ?? null), str(interval?.high ?? null)];
});

/* --------------------------------------------------------------- samples - */

const SAMPLE_EDGES = [null, -1, -0, 0, 0.5, 1, 2, 5, 24, 25, 26, 99, 100, 101, 2499, 2500, 9999, 10000, 1e15, 2 ** 53 + 2, 1e300];
const MIN_EDGES = [0, 1, 3, 20, 30, 100, 10000, 1_000_000_000];
const sampleCases = [];
for (const min of MIN_EDGES) for (const sample of SAMPLE_EDGES) sampleCases.push([sample, min]);
for (let i = 0; i < 2000; i += 1) {
  const min = 1 + below([50, 1000, 20000, 1_000_000_000][below(4)]);
  const sample = random() < 0.1 ? below(3) : random() < 0.5 ? below(min * 2) : below(min) + random();
  sampleCases.push([sample, min]);
}
const samplesOut = sampleCases.map(([sample, min]) => {
  const { level, opacity } = sampleReliability(sample, min);
  return [sample === null ? null : str(sample), min, level, str(opacity)];
});

/* ------------------------------------------------------------------ sqrt - */

const view = new DataView(new ArrayBuffer(8));
const SQRT_EDGES = [0, -0, -1, -5e-324, Infinity, -Infinity, Number.NaN, 1, 2, 3, 4, 0.25, 0.01, 1e-320, 5e-324,
  2.2250738585072014e-308, 2.225073858507201e-308, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, 2 ** 53 + 2,
  1.959964 * 1.959964 / 4, 0.0625, 1 - 2 ** -53, 1 + 2 ** -52];
const sqrtCases = [...SQRT_EDGES];
for (let i = 1; i < 300; i += 1) sqrtCases.push(i * i, i * i + 1, i * i - 1);
for (let i = 0; i < 3000; i += 1) {
  // Positive doubles from random bits: every exponent, subnormals included.
  view.setUint32(0, (random() * 0x7ff00000) >>> 0);
  view.setUint32(4, (random() * 4294967296) >>> 0);
  sqrtCases.push(view.getFloat64(0));
}
const sqrtOut = sqrtCases.map((x) => [str(x), str(Math.sqrt(x))]);

/* ------------------------------------------------------------------ file - */

const inputs = createHash("sha256")
  .update(JSON.stringify(cases.map((c) => [c.key, c.totals])))
  .digest("hex");
const out = {
  meta: {
    note: "written by reliability-vectors.mjs; do not edit",
    definitions: createHash("sha256").update(DEFINITIONS_TEXT).digest("hex"),
    inputs,
    stats: STATS.map((stat) => stat.def.id),
    z: String(WILSON_Z),
    opacityFloor: String(OPACITY_FLOOR),
    output: "level | opacity (String) | low | high (String, percentage points) | low text | high text; empty for none",
    cases: stats.length,
    intervals,
    levels,
    wilson: wilsonOut.length,
    samples: samplesOut.length,
    sqrt: sqrtOut.length,
  },
  stats,
  wilson: wilsonOut,
  samples: samplesOut,
  sqrt: sqrtOut,
};
writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(
  `reliability vectors: ${stats.length} cases x ${STATS.length} statistics (${intervals} intervals; ` +
    `levels ${JSON.stringify(levels)}), ${wilsonOut.length} wilson, ${samplesOut.length} samples, ` +
    `${sqrtOut.length} sqrt -> ${OUT}`,
);
