// Writes report-vectors.json: what the web shows for the corpus's hero hands
// - `stats_summary` + the display definitions, `stats_graph`'s buckets,
// `stats_sessions`, `stats_breakdown` - computed the web's way in
// TypeScript, for `tests/report.rs` to compare with the desktop's reports
// over a store of the same corpus (docs/RAIL-PLAN.md R2.7b).
//
//     cd tests && npm ci && npm run golden:emit      (testdata/golden-*-full/)
//     node core/rail-store/tests/data/report-vectors.mjs
//
// The rows are the TypeScript engine's: `golden-stats-full` holds
// `statsRows(handFacts(phf))` of every accepted hand, `golden-ev-full` the
// hero's `handEvRow` (lib/equity) - what the web stores in `hand_stats` and
// `hand_stats_ev`. The hands are the store's: every file in the store tests'
// order (sorted by path, component by component, as Rust sorts paths), the
// first copy of each `hand_key` kept, as the store keeps it.
//
// The web's SQL is restated here over those rows, clause by clause (the
// migration a rule comes from is named beside it):
//
// - the base set (`hand_stats_filter_sql`, 20261005090000): the hero's rows,
//   bomb pots out; an EV cashout's money out of every money sum, its hand
//   still counted; the scope's filters;
// - the summary (`stats_summary`): `aggregate` of the base set, every display
//   definition's `showStat` over it (with the all-in EV result: the money
//   rows' `coalesce(ev_net_bb_milli, net_bb_milli)` summed, as `stats_graph`
//   sums its EV line), money text in the one currency's decimals;
// - the money refusals: tournament chips with cash (`count(distinct
//   (game_format = 'cash')) > 1`), more than one currency;
// - the graph (`stats_graph`, 20261207090000): `ntile(n)` over `played_at`
//   ascending, nulls last, then `hand_key`; per bucket the money sums and
//   their running totals; showdown is the hero's `wtsd = 1`; the desktop's
//   money lines (showdown, non-showdown, EV in money) the same way;
// - sessions (`stats_sessions`, 20261214090000): the hero's dated rows, bomb
//   pots and straddles in, a new session after a gap longer than 30
//   minutes; hands, distinct tables, money and big blinds without EV
//   cashouts; the units of each session (the desktop refuses per session);
// - breakdowns (`stats_breakdown`, 20261221090000): `aggregate` per pot
//   type, stack band, starting hand, players and street reached - and per
//   position, stake, room and format, the desktop's rollup groups.
//
// Numbers are written as `String(x)` (exact for integers, the shortest
// round-trip decimal for a double), which the Rust test compares with
// `JsNumber::to_js_string`. Deterministic.

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
      export { aggregate } from "./frontend/src/lib/stats/rates.ts";
      export { COUNTER_KEYS, MONEY_KEYS, STATS_VERSION } from "./frontend/src/lib/stats/types.ts";
      export { compileStats, showStat } from "./frontend/src/lib/stats/display.ts";
      export { EV_VERSION } from "./frontend/src/lib/equity/index.ts";
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
const { aggregate, COUNTER_KEYS, MONEY_KEYS, STATS_VERSION, compileStats, showStat, EV_VERSION } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const OUT = process.env.REPORT_OUT ?? join(ROOT, "core/rail-store/tests/data/report-vectors.json");
const DEFINITIONS_TEXT = readFileSync(join(ROOT, "config/stats/standard.json"), "utf8");
const STATS = compileStats(JSON.parse(DEFINITIONS_TEXT));
const GAP_MS = 30 * 60_000;

/* ------------------------------------------------------------- the corpus - */

const STATS_FULL = join(ROOT, "testdata/golden-stats-full");
const EV_FULL = join(ROOT, "testdata/golden-ev-full");

function walk(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, base, out);
    } else if (name.endsWith(".json")) {
      out.push(relative(base, full).split(sep).join("/"));
    }
  }
  return out;
}

/** Rust's `PathBuf` order: component by component, each compared by bytes. */
function pathOrder(a, b) {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    if (x[i] !== y[i]) return Buffer.compare(Buffer.from(x[i]), Buffer.from(y[i]));
  }
  return x.length - y.length;
}

const ascii = (text) => /^[\x20-\x7e]*$/.test(text);

const heroes = [];
const seen = new Set();
let duplicates = 0;
for (const file of walk(STATS_FULL, STATS_FULL, []).sort(pathOrder)) {
  const stats = JSON.parse(readFileSync(join(STATS_FULL, file), "utf8"));
  const ev = JSON.parse(readFileSync(join(EV_FULL, file), "utf8"));
  if (stats.statsVersion !== STATS_VERSION) throw new Error(`${file}: stale stats goldens`);
  if (ev.evVersion !== EV_VERSION) throw new Error(`${file}: stale EV goldens`);
  stats.hands.forEach((hand, i) => {
    const rows = hand.rows;
    if (rows.length === 0) throw new Error(`${file}: a hand without rows; its key would still be taken in the store`);
    const key = rows[0].hand_key;
    if (seen.has(key)) {
      duplicates += 1;
      return;
    }
    seen.add(key);
    const hero = rows.find((row) => row.is_hero);
    if (!hero) return;
    if (!ascii(key)) throw new Error(`${key}: a non-ASCII hand key orders differently in SQLite`);
    const evRow = ev.hands[i]?.row ?? null;
    if (evRow && evRow.hand_key !== key) throw new Error(`${file}: EV golden out of step at ${i}`);
    heroes.push({ row: hero, ev: evRow });
  });
}

/* ---------------------------------------------------------------- scopes - */

const siteKey = (row) => row.site_id.trim().toLowerCase();
const stakeKey = (row) => (row.game_format === "cash" ? `${row.currency}:${row.big_blind}` : "chips");
const position = (row) => row.position ?? "";

function count(list, key) {
  const counts = new Map();
  for (const item of list) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

const dated = heroes.filter((h) => h.row.played_at !== null).map((h) => h.row.played_at).sort();
const at = (q) => dated[Math.floor((dated.length * q) / 100)];
const cashStakes = count(
  heroes.filter((h) => h.row.game_format === "cash"),
  (h) => stakeKey(h.row),
);
const sites = count(heroes, (h) => siteKey(h.row));

/** The scopes compared: a report filter (`ReportFilter`'s fields) and its predicate. */
const SCOPES = [
  { name: "everything", filter: {} },
  { name: "cash", filter: { formats: ["cash"] } },
  { name: "the biggest cash stake", filter: { stakes: [cashStakes[0][0]] } },
  { name: "two cash stakes", filter: { formats: ["cash"], stakes: [cashStakes[0][0], cashStakes[1][0]] } },
  { name: "tournament formats", filter: { formats: ["tournament", "sng", "spin"] } },
  { name: "button and big blind", filter: { positions: ["BTN", "BB"] } },
  { name: "the biggest room", filter: { sites: [sites[0][0]] } },
  { name: "the middle half of the dates", filter: { from: at(25), to: at(75) } },
  { name: "from the 90th percentile on", filter: { from: at(90) } },
];

const allows = (list, value) => list === undefined || list.length === 0 || list.includes(value);
function inScope(row, filter) {
  return (
    allows(filter.sites, siteKey(row)) &&
    allows(filter.formats, row.game_format) &&
    allows(filter.stakes, stakeKey(row)) &&
    allows(filter.positions, position(row)) &&
    (filter.from === undefined || (row.played_at !== null && row.played_at >= filter.from)) &&
    (filter.to === undefined || (row.played_at !== null && row.played_at < filter.to))
  );
}

/* --------------------------------------------------------------- outputs - */

const str = (value) => (value === null || value === undefined ? null : String(value));
const counted = (h) => !h.row.is_bomb_pot;
const money = (h) => !h.row.has_cashout;
const evBb = (h) => (h.ev && h.ev.applicable ? h.ev.ev_net_bb_milli : h.row.net_bb_milli);
const evNet = (h) => (h.ev && h.ev.applicable ? h.ev.ev_net : h.row.net);

function units(list) {
  const kinds = new Set(list.map((h) => h.row.game_format === "cash"));
  const currencies = new Map();
  for (const h of list) if (!currencies.has(h.row.currency)) currencies.set(h.row.currency, h.row.currency_minor_units);
  const mixedKind = kinds.size > 1;
  const mixedCurrency = currencies.size > 1;
  const one = !mixedKind && !mixedCurrency && currencies.size === 1 ? [...currencies.entries()][0] : null;
  return { mixedKind, mixedCurrency, currency: one ? one[0] : null, minorUnits: one ? one[1] : null };
}

const totalsArray = (t) => [...COUNTER_KEYS.map((k) => t.counters[k]), ...MONEY_KEYS.map((k) => t.money[k]), t.moneyHands].map(String);

/** `log10(minorUnits)` when it is a power of ten (the decimals of a money text). */
function decimalsOf(minorUnits) {
  if (minorUnits === null) return null;
  let value = minorUnits;
  let exponent = 0;
  while (value > 1) {
    if (value % 10 !== 0) return null;
    value /= 10;
    exponent += 1;
  }
  return value === 1 ? exponent : null;
}

function summary(list, u) {
  const totals = aggregate(list.map((h) => h.row));
  let ev = totals.money.net_bb_milli;
  for (const h of list) if (counted(h) && money(h) && h.ev && h.ev.applicable) ev += h.ev.ev_net_bb_milli - h.row.net_bb_milli;
  const sums = { ...totals, evNetBbMilli: ev };
  const minor = u.mixedKind || u.mixedCurrency ? null : decimalsOf(u.minorUnits);
  return {
    totals: totalsArray(totals),
    evNetBbMilli: String(ev),
    stats: STATS.map((stat) => {
      const shown = showStat(stat, sums, minor);
      return [stat.def.id, str(shown.value), shown.text, str(shown.sample), shown.full];
    }),
  };
}

function order(a, b) {
  const x = a.row.played_at;
  const y = b.row.played_at;
  if (x !== y) {
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -1 : 1;
  }
  return a.row.hand_key < b.row.hand_key ? -1 : a.row.hand_key > b.row.hand_key ? 1 : 0;
}

function graph(list, n) {
  const hands = [...list].sort(order);
  const buckets = Math.min(n, hands.length);
  const base = Math.floor(hands.length / buckets);
  const extra = hands.length % buckets;
  const out = [];
  const cum = { hands: 0, moneyHands: 0, net: 0, sd: 0, nsd: 0, ev: 0, cash: 0, sdCash: 0, nsdCash: 0, evCash: 0 };
  let start = 0;
  for (let b = 0; b < buckets; b += 1) {
    const slice = hands.slice(start, start + base + (b < extra ? 1 : 0));
    start += slice.length;
    let moneyHands = 0;
    for (const h of slice) {
      if (!money(h)) continue;
      moneyHands += 1;
      cum.net += h.row.net_bb_milli;
      cum.cash += h.row.net;
      if (h.row.wtsd === 1) {
        cum.sd += h.row.net_bb_milli;
        cum.sdCash += h.row.net;
      } else {
        cum.nsd += h.row.net_bb_milli;
        cum.nsdCash += h.row.net;
      }
      cum.ev += evBb(h);
      cum.evCash += evNet(h);
    }
    cum.hands += slice.length;
    cum.moneyHands += moneyHands;
    const dates = slice.map((h) => h.row.played_at).filter((d) => d !== null);
    out.push([
      slice.length,
      moneyHands,
      dates[0] ?? null,
      dates.length ? dates[dates.length - 1] : null,
      cum.hands,
      cum.moneyHands,
      cum.net,
      cum.sd,
      cum.nsd,
      cum.ev,
      cum.cash,
      cum.sdCash,
      cum.nsdCash,
      cum.evCash,
    ].map((v) => (v === null ? null : String(v))));
  }
  return out;
}

function sessions(list) {
  const rows = list.filter((h) => h.row.played_at !== null).sort(order);
  const out = [];
  let current = null;
  let last = null;
  for (const h of rows) {
    const ms = Date.parse(h.row.played_at);
    if (current === null || ms - last > GAP_MS) {
      current = { started: h.row.played_at, ended: h.row.played_at, hands: [], };
      out.push(current);
    }
    current.hands.push(h);
    current.ended = h.row.played_at;
    last = ms;
  }
  return out.reverse().map((s) => {
    const kept = s.hands.filter(money);
    const tables = new Set(s.hands.map((h) => h.row.table_name).filter((t) => t !== null));
    const u = units(s.hands);
    return {
      startedAt: s.started,
      endedAt: s.ended,
      hands: s.hands.length,
      tables: tables.size,
      net: String(kept.reduce((sum, h) => sum + h.row.net, 0)),
      netBbMilli: String(kept.reduce((sum, h) => sum + h.row.net_bb_milli, 0)),
      units: u,
    };
  });
}

const STACK_BANDS = [
  ["0-20", 200],
  ["20-40", 400],
  ["40-70", 700],
  ["70-100", 1000],
  ["100-150", 1500],
  ["150-250", 2500],
];
const stackBand = (tenths) => STACK_BANDS.find(([, below]) => tenths < below)?.[0] ?? "250+";

function split(list, key) {
  const groups = new Map();
  for (const h of list.filter(counted)) {
    const k = key(h.row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  return [...groups.keys()].sort().map((k) => {
    const group = groups.get(k);
    const totals = aggregate(group.map((h) => h.row));
    let ev = 0;
    for (const h of group) if (counted(h) && money(h) && h.ev && h.ev.applicable) ev += h.ev.ev_net_bb_milli - h.row.net_bb_milli;
    return { key: k, totals: totalsArray(totals), evAdjustBbMilli: String(ev) };
  });
}

const scopes = SCOPES.map(({ name, filter }) => {
  const list = heroes.filter((h) => inScope(h.row, filter));
  const base = list.filter(counted);
  const u = units(base);
  return {
    name,
    filter,
    hands: base.length,
    moneyHands: base.filter(money).length,
    units: u,
    allInHands: base.filter((h) => h.ev && h.ev.applicable).length,
    summary: summary(list, u),
    graphs: u.mixedKind ? [] : [60, 997].map((n) => ({ points: n, buckets: graph(base, n) })),
    breakdowns: {
      potType: split(list, (row) => row.pot_type),
      stack: split(list, (row) => stackBand(row.starting_stack_bb_tenths)),
      handClass: split(list, (row) => row.hand_class ?? ""),
      players: split(list, (row) => String(row.player_count)),
      street: split(list, (row) => row.street_reached),
      position: split(list, position),
      stake: split(list, stakeKey),
      site: split(list, siteKey),
      format: split(list, (row) => row.game_format),
    },
  };
});

const doc = {
  meta: {
    format: "rail-report-vectors/1",
    statsVersion: STATS_VERSION,
    evVersion: EV_VERSION,
    definitions: createHash("sha256").update(DEFINITIONS_TEXT).digest("hex"),
    heroHands: heroes.length,
    duplicatesSkipped: duplicates,
    columns: [...COUNTER_KEYS, ...MONEY_KEYS, "money_hands"],
  },
  sessions: sessions(heroes),
  scopes,
};
writeFileSync(OUT, `${JSON.stringify(doc)}\n`);
console.log(
  `report vectors: ${heroes.length} hero hands (${duplicates} duplicate copies skipped), ${scopes.length} scopes, ` +
    `${doc.sessions.length} sessions -> ${relative(ROOT, OUT)}`,
);
