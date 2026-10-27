// Writes display-vectors.json: what the web's display definitions
// (`web/src/lib/stats/display.ts` over `config/stats/standard.json`)
// print for summed counters, for `rail_stats::display` to replay
// (docs/RAIL-PLAN.md R2.4, `tests/display.rs`).
//
//     cd tests && npm ci && npm run golden:emit     (esbuild; testdata/golden-full/)
//     node core/rail-stats/tests/data/display-vectors.mjs
//
// Three kinds of case:
//
// - `groups`: the corpus summed the way a report sums it - every golden
//   file's seats, every corpus directory's seats and its hero's, every
//   position's, every game format's, the whole corpus's - with `aggregate`'s
//   defaults (`rates.ts`). `tests/display.rs` sums the same rows from
//   `rail_stats` and checks it gets these totals before evaluating.
// - `synthetic`: seeded random totals (zeros, small samples, huge ones,
//   negative money, denominators that put a percentage on a rounding tie),
//   with an all-in EV result.
// - `formulas`: formula texts, the parse (printed fully parenthesised) or
//   the error, and the value over the first synthetic totals.
// - `formats`: doubles and decimals with `formatFixed`'s text, each equal to
//   `Intl.NumberFormat`'s (and counted where `toFixed` would differ).
//
// Every case's output is checked here against `rates.ts` before it is
// written: where `rates()` has the same statistic, the definition's value is
// the same double (`Object.is`), and its text is what the web's
// `Intl.NumberFormat` prints at the definition's decimals. A definition that
// drifts from the web fails this script, not just the Rust test.
//
// Deterministic: rerunning it rewrites the same file as long as the goldens,
// the definitions and the TypeScript are the same.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(join(ROOT, "tests/package.json"));
const esbuild = require("esbuild");

const bundle = await esbuild.build({
  stdin: {
    contents: `
      export { handFacts } from "./web/src/lib/stats/derive.ts";
      export { statsRows } from "./web/src/lib/stats/mapping.ts";
      export { aggregate, rates } from "./web/src/lib/stats/rates.ts";
      export { COUNTER_KEYS, MONEY_KEYS } from "./web/src/lib/stats/types.ts";
      export {
        compileStats, evaluate, formatFixed, parseFormula, printFormula, showStat, statRate,
      } from "./web/src/lib/stats/display.ts";
    `,
    resolveDir: ROOT,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "error",
});
const {
  handFacts,
  statsRows,
  aggregate,
  rates,
  COUNTER_KEYS,
  MONEY_KEYS,
  compileStats,
  evaluate,
  formatFixed,
  parseFormula,
  printFormula,
  showStat,
  statRate,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const OUT = process.env.DISPLAY_OUT ?? join(ROOT, "core/rail-stats/tests/data/display-vectors.json");
const DEFINITIONS_TEXT = readFileSync(join(ROOT, "config/stats/standard.json"), "utf8");
const STATS = compileStats(JSON.parse(DEFINITIONS_TEXT));
const SYNTHETIC = 600;

/** The statistics `rates()` also computes, by definition id. */
const RATES_KEYS = {
  hands: "hands",
  bb_per_100: "bb100",
  net_bb: "netBb",
  vpip: "vpip",
  pfr: "pfr",
  rfi: "rfi",
  limp: "limp",
  iso: "iso",
  cold_call: "coldCall",
  three_bet: "threeBet",
  fold_to_three_bet: "foldToThreeBet",
  four_bet: "fourBet",
  fold_to_four_bet: "foldToFourBet",
  squeeze: "squeeze",
  steal: "steal",
  fold_to_steal: "foldToSteal",
  saw_flop: "sawFlop",
  cbet_flop: "cbetFlop",
  cbet_turn: "cbetTurn",
  cbet_river: "cbetRiver",
  fold_to_cbet_flop: "foldToCbetFlop",
  fold_to_cbet_turn: "foldToCbetTurn",
  donk_flop: "donkFlop",
  check_raise_flop: "checkRaiseFlop",
  aggression_factor: "aggressionFactor",
  aggression_frequency: "aggressionFrequency",
  wwsf: "wwsf",
  wtsd: "wtsd",
  wsd: "wsd",
};

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
const random = mulberry32(0xd15b1a7);
const below = (n) => Math.floor(random() * n);
const pick = (list) => list[below(list.length)];

/* ------------------------------------------------------------- the corpus - */

const FULL = join(ROOT, "testdata/golden-full");
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (name.endsWith(".json")) {
      out.push(relative(FULL, full).split(sep).join("/"));
    }
  }
  return out;
}

/** `fixtures/samples/pokerstars/x.txt.json` -> `fixtures/samples/pokerstars`. */
const directoryOf = (file) => file.split("/").slice(0, -1).join("/");

const groupRows = new Map();
const add = (key, row) => {
  let rows = groupRows.get(key);
  if (!rows) {
    rows = [];
    groupRows.set(key, rows);
  }
  rows.push(row);
};
for (const file of walk(FULL, []).sort()) {
  const doc = JSON.parse(readFileSync(join(FULL, file), "utf8"));
  for (const hand of doc.hands) {
    for (const row of statsRows(handFacts(hand.phf))) {
      add(`file:${file}`, row);
      add(`dir:${directoryOf(file)}`, row);
      add("all", row);
      add(`position:${row.position ?? ""}`, row);
      add(`format:${row.game_format}`, row);
      if (row.is_hero) {
        add(`hero-dir:${directoryOf(file)}`, row);
        add("hero", row);
        add(`hero-position:${row.position ?? ""}`, row);
      }
    }
  }
}

/* ---------------------------------------------------------------- output - */

const totalsArray = (t) => [
  ...COUNTER_KEYS.map((k) => t.counters[k]),
  ...MONEY_KEYS.map((k) => t.money[k]),
  t.moneyHands,
  t.evNetBbMilli ?? null,
];

const intl = new Map();
function webText(value, decimals) {
  let format = intl.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat("en-GB", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: false,
    });
    intl.set(decimals, format);
  }
  return format.format(value);
}

let comparedRates = 0;
let comparedText = 0;
function outputs(key, totals) {
  const web = rates(totals);
  return STATS.map((stat) => {
    const shown = showStat(stat, totals, 2);
    const id = stat.def.id;
    const ratesKey = RATES_KEYS[id];
    if (ratesKey !== undefined) {
      const theirs = web[ratesKey];
      if (!Object.is(theirs, shown.value) && !(theirs === null && shown.value === null)) {
        throw new Error(`${key}: ${id} is ${shown.value}, rates() says ${theirs}`);
      }
      comparedRates += 1;
      if (shown.value !== null) {
        const text = webText(shown.value, stat.def.format.decimals);
        if (text !== shown.text) {
          throw new Error(`${key}: ${id} prints ${shown.text}, the web ${text}`);
        }
        comparedText += 1;
      }
    }
    const rate = statRate(stat, totals);
    if (rate && shown.value !== null) {
      const again = rate.opportunities > 0 ? (rate.made * 100) / rate.opportunities : null;
      if (!Object.is(again, shown.value)) throw new Error(`${key}: ${id} rate parts disagree`);
    }
    return [
      shown.value === null ? "" : String(shown.value),
      shown.text ?? "",
      shown.tone ?? "",
      shown.sample === null ? "" : String(shown.sample),
      shown.full ? "1" : "0",
    ].join("|");
  });
}

const groups = [...groupRows.keys()].sort().map((key) => {
  const totals = aggregate(groupRows.get(key));
  return { key, totals: totalsArray(totals), out: outputs(key, totals) };
});

/* ------------------------------------------------------------- synthetic - */

const TIE_DENOMINATORS = [2, 4, 8, 16, 20, 40, 80, 125, 200, 400, 625, 2000, 8000, 20000, 200000];
function count() {
  const r = random();
  if (r < 0.25) return 0;
  if (r < 0.55) return below(25);
  if (r < 0.85) return below(5000);
  if (r < 0.97) return below(2_000_000);
  return below(2 ** 30) * 2 ** below(13);
}
function signed(scale) {
  const magnitude = below(scale);
  return random() < 0.5 ? -magnitude : magnitude;
}
const synthetic = [];
for (let i = 0; i < SYNTHETIC; i += 1) {
  const counters = Object.fromEntries(COUNTER_KEYS.map((k) => [k, count()]));
  if (random() < 0.5) {
    // Put a pair on a rounding tie: opp from the list, made anything up to it.
    for (const stat of STATS) {
      if (stat.formula.kind === "pct" && stat.formula.opp.kind === "name" && stat.formula.made.kind === "name") {
        const opp = pick(TIE_DENOMINATORS);
        counters[stat.formula.opp.name] = opp;
        counters[stat.formula.made.name] = below(opp + 1);
      }
    }
  }
  const moneyHands = random() < 0.1 ? 0 : random() < 0.5 ? pick(TIE_DENOMINATORS) : below(3_000_000);
  const money = Object.fromEntries(MONEY_KEYS.map((k) => [k, signed(random() < 0.5 ? 1000 : 2 ** 40)]));
  money.rake_paid = Math.abs(money.rake_paid);
  const evNetBbMilli = random() < 0.2 ? null : money.net_bb_milli + signed(100000);
  const totals = { counters, money, moneyHands, evNetBbMilli };
  synthetic.push({ key: `synthetic:${i}`, totals: totalsArray(totals), out: outputs(`synthetic:${i}`, totals) });
}

/* -------------------------------------------------------------- formulas - */

const FORMULA_TEXTS = [
  "-net_bb_milli / 3",
  "--hands",
  "0.1 * hands + 0.2",
  "0.1 + 0.2 - 0.3",
  "pct(vpip - pfr, vpip_opp)",
  "sum(won, -contributed) / 7",
  "(won - contributed) / net",
  "net / 3 * 3 - net",
  "pct(1, 0) + 1",
  "hands / 0",
  "ev_net_bb_milli - net_bb_milli",
  "sum(bet_flop) * 1.5 / (call_flop + 0.25)",
  "100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * 100000000000 * hands",
  "0.30000000000000004 * 3",
  "pct(wsd, wtsd) / pct(wtsd, flop_seen)",
  "",
  "a +",
  "(a",
  "1.",
  ".5",
  "2x",
  "Vpip",
  "a % b",
  "pct(a)",
  "sum()",
  "max(a, b)",
  "a, b",
  "1e3",
  "vpip;drop",
  "vpip \u00e9",
  `${"(".repeat(33)}a${")".repeat(33)}`,
  `${"-".repeat(33)}a`,
  Array(600).fill("a").join("+"),
];
const FORMULA_SAMPLES = 200;
const sampleTotals = synthetic.slice(0, FORMULA_SAMPLES).map((c) => {
  const t = c.totals;
  return {
    counters: Object.fromEntries(COUNTER_KEYS.map((k, i) => [k, t[i]])),
    money: Object.fromEntries(MONEY_KEYS.map((k, i) => [k, t[COUNTER_KEYS.length + i]])),
    moneyHands: t[COUNTER_KEYS.length + MONEY_KEYS.length],
    evNetBbMilli: t[COUNTER_KEYS.length + MONEY_KEYS.length + 1],
  };
});
const formulas = FORMULA_TEXTS.map((text) => {
  try {
    const expr = parseFormula(text);
    return {
      text,
      parsed: printFormula(expr),
      values: sampleTotals.map((totals) => {
        const value = evaluate(expr, totals);
        return value === null ? null : String(value);
      }),
    };
  } catch (error) {
    return { text, error: error.message };
  }
});

/* --------------------------------------------------------------- formats - */

const FORMAT_VALUES = [
  0, -0, 0.05, -0.15, 0.15, 1.005, 2.675, 28.75, 28.749999999999996, 1e21, 1.5e21, 123456789012345680000,
  5e-324, -1e-7, 1.5e-7, 0.000001, 0.0000095, 9.995, 99.95, 999.9999, -999.95, 0.5, 1.5, 2.5, -2.5, 1e300,
  Number.MAX_SAFE_INTEGER, 1 / 3, 2 / 3, -4.938, 44.44444444444444,
];
while (FORMAT_VALUES.length < 1000) {
  const r = random();
  const decimalsOfValue = below(7);
  const base = r < 0.5 ? below(100000) / 10 ** decimalsOfValue : (below(2 ** 30) * 2 ** (below(80) - 40)) / 7;
  FORMAT_VALUES.push(random() < 0.3 ? -base : base);
}
let toFixedDiffers = 0;
const formats = [];
for (const value of FORMAT_VALUES) {
  for (const decimals of [0, 1, 2, 3, 6]) {
    const text = formatFixed(value, decimals);
    const web = webText(value, decimals);
    if (text !== web) throw new Error(`formatFixed(${value}, ${decimals}) is ${text}, Intl ${web}`);
    if (Math.abs(value) < 1e21 && value.toFixed(decimals) !== text) toFixedDiffers += 1;
    formats.push([Object.is(value, -0) ? "-0" : String(value), decimals, text]);
  }
}

/* ------------------------------------------------------------------ file - */

const out = {
  meta: {
    note: "written by display-vectors.mjs; do not edit",
    definitions: createHash("sha256").update(DEFINITIONS_TEXT).digest("hex"),
    stats: STATS.map((stat) => stat.def.id),
    totals: [...COUNTER_KEYS, ...MONEY_KEYS, "money_hands", "ev_net_bb_milli"],
    output: "value (String) | text (formatFixed; money with 2 minor digits) | tone | sample (String) | full (1/0); empty for none",
    groups: groups.length,
    synthetic: synthetic.length,
    comparedWithRates: comparedRates,
    textComparedWithIntl: comparedText,
    formats: formats.length,
    toFixedWouldDiffer: toFixedDiffers,
  },
  groups,
  synthetic,
  formulas,
  formats,
};
writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(
  `display vectors: ${groups.length} corpus groups, ${synthetic.length} synthetic, ${formulas.length} formulas; ` +
    `${comparedRates} values equal to rates(), ${comparedText} texts equal to Intl; ` +
    `${formats.length} formats equal to Intl (toFixed would differ on ${toFixedDiffers}) -> ${OUT}`,
);
