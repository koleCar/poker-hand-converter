// Writes ev-vectors.json: what the TypeScript equity engine
// (`web/src/lib/equity`) answers for requests and hands it has never
// seen, for `rail_equity` to replay (docs/RAIL-PLAN.md R2.2).
//
//     cd tests && npm ci && npm run golden:emit     (esbuild; testdata/golden-full/)
//     node core/rail-equity/tests/data/ev-vectors.mjs
//
// Three sections, all drawn from one seeded `mulberry32`:
//
// - `hands`: seeded mutations of golden hands (mostly the ones with an
//   all-in, the rest from anywhere) through `analyzeAllIn` - dropped,
//   swapped, duplicated and retyped actions, all-in flags and amounts, hole
//   and shown cards (impossible ones included: duplicates, `Xx`, a deuce in
//   short deck), other variants, hi/lo, a second flop, bomb pots, the site
//   (GG's short-deck rule), fees and pots that do not reconcile, house money
//   into the pot. Each case has its own options: the defaults (and then also
//   the stored row, `handEvRow` of the first hero row of `handStatsRows`),
//   or a small exhaustive limit, a few Monte Carlo trials and a random seed.
//   A case is a corpus hand (`file`, `hand` as in the stats vectors, `phf`
//   the first 16 hex of the sha-256 of its canonical PHF), `ops` (generic
//   JSON edits, applied in order; `tests/vectors.rs` mirrors `apply`), the
//   options, the analysis (`analysisDoc` of tests/scripts/golden/ev.ts:
//   equities as `String(x)`) and the row (or null, or absent when the
//   options are not the defaults).
// - `equity`: random `equity()` requests - every game, 1-13 players, boards
//   of 0-6 cards, dead cards, side pots (bad indices included), auto,
//   exhaustive and Monte Carlo with random trials, limits and seeds, both
//   short-deck rules, unreadable and duplicated cards - with `plan()` and
//   the result (pots as `String(x)`) or the `EquityInputError` message.
// - `ranges`: `parseRange` over random token soup (the weights a person
//   might write, and junk), `rangeShare`, `equityVsRange`, `equityVsRanges`
//   and `strongestOfRange` with class ranges and combo lists, card removal,
//   all three methods; doubles as `String(x)`, errors as their kind and
//   message (`TypeError` where `parseRange` reads past a token).
//
// Deterministic: rerunning it rewrites the same file as long as the goldens
// and the TypeScript are the same. `EV_STRESS=<seed>` draws ten times as
// many cases from another seed for a local soak; `EV_OUT=<path>` writes
// elsewhere and `EV_VECTORS=<path>` points `tests/vectors.rs` at it.

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
      export {
        analyzeAllIn, equity, plan, EquityInputError, equityVsRange, equityVsRanges,
        parseRange, rangeShare, strongestOfRange,
      } from "./web/src/lib/equity/index.ts";
      export { handEvRow, handStatsRows } from "./web/src/lib/db/statsRows.ts";
      export { canonicalJson } from "./tests/scripts/golden/canonical.ts";
      export { analysisDoc } from "./tests/scripts/golden/ev.ts";
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
const E = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const STRESS = process.env.EV_STRESS ? Number(process.env.EV_STRESS) : null;
const OUT = process.env.EV_OUT ?? join(ROOT, "core/rail-equity/tests/data/ev-vectors.json");
const SCALE = STRESS === null ? 1 : 10;
const HAND_CASES = 1500 * SCALE;
const EQUITY_CASES = 1500 * SCALE;
const RANGE_CASES = 1500 * SCALE;

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
const random = mulberry32(STRESS ?? 0xe0e0e0);
const pick = (list) => list[Math.floor(random() * list.length)];
const below = (n) => Math.floor(random() * n);
const chance = (p) => random() < p;
const seed32 = () => Math.floor(random() * 4294967296);

const sha16 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Doubles as the shortest string that reads back as the same double. */
const num = (value) => String(value);

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
const bases = [];
for (const file of walk(FULL, []).sort()) {
  const doc = JSON.parse(readFileSync(join(FULL, file), "utf8"));
  doc.hands.forEach((hand, i) => {
    bases.push({ file, hand: i, text: E.canonicalJson(hand.phf) });
  });
}
// The hands the engine has something to say about: an all-in (applicable),
// or one that is nearly there.
const NEAR = new Set(["no-street-to-come", "unknown-hole-cards", "hi-lo", "double-board", "invalid-cards"]);
const interesting = bases.filter((base) => {
  const outcome = E.analyzeAllIn(JSON.parse(base.text), { exhaustiveLimit: 0, trials: 1 });
  return outcome.applicable || NEAR.has(outcome.reason);
});

/* ------------------------------------------------------------ the cards - */

const RANKS = "23456789TJQKA";
const SUITS = "shdc";
const DECK = [...RANKS].flatMap((rank) => [...SUITS].map((suit) => rank + suit));
const ODD_CARDS = ["Xx", "ah", " 7s", "5d", "2c", "10h", "As"];
/** A random card; now and then one that is not, or that repeats. */
const someCard = () => (chance(0.06) ? pick(ODD_CARDS) : pick(DECK));
/** `n` distinct cards of the deck, mostly; `odd` lets junk in. */
function someCards(n, odd = 0.05) {
  const out = [];
  while (out.length < n) {
    const card = chance(odd) ? pick(ODD_CARDS) : pick(DECK);
    if (!out.includes(card) || chance(odd)) out.push(card);
  }
  return out;
}

/* ------------------------------------------------------- hand mutations - */

const ACTION_TYPES = [
  "ante", "small-blind", "big-blind", "straddle", "post", "missed-blind", "bomb-ante",
  "fold", "check", "call", "bet", "raise", "uncalled", "show", "muck", "collect",
  "cashout-choose", "cashout-pay",
];
const STREETS = ["preflop", "flop", "turn", "river", "showdown"];
const VARIANTS = ["holdem", "holdem", "omaha", "omaha5", "omaha6", "shortdeck", "shortdeck", "stud", "razz", "draw", "other"];
const FEES = ["rake", "jackpot", "bingo", "fortune", "tax", "other"];

/** Draws one generic edit valid for `hand` as it stands. */
function drawOp(hand) {
  const actions = hand.actions.length;
  const players = hand.players.length;
  const seats = hand.players.map((player) => player.seat);
  const kinds = ["variant", "hiLo", "site", "fee", "totalPot", "chip", "board", "bomb"];
  if (actions > 0) kinds.push("drop", "swap", "type", "seat", "street", "amount", "allIn", "dup", "allIn", "amount");
  if (players > 0) kinds.push("holeCards", "holeCards", "stack", "playerSeat");
  if (hand.results.players.length > 0) kinds.push("shown");
  if (hand.board.runouts.length > 0) kinds.push("secondFlop", "cut", "runouts");
  const at = () => below(actions);
  switch (pick(kinds)) {
    case "drop":
      return { op: "drop", path: ["actions"], i: at() };
    case "swap": {
      const i = at();
      return { op: "swap", path: ["actions"], i, j: chance(0.7) ? Math.min(actions - 1, i + 1) : at() };
    }
    case "dup":
      return { op: "copy", path: ["actions"], i: at(), j: below(actions + 1) };
    case "type":
      return { op: "set", path: ["actions", at(), "type"], value: pick(ACTION_TYPES) };
    case "seat":
      return { op: "set", path: ["actions", at(), "seat"], value: pick([...seats, ...seats, null, 99]) };
    case "street":
      return { op: "set", path: ["actions", at(), "street"], value: pick(STREETS) };
    case "amount": {
      const bb = hand.game.bigBlind;
      return { op: "set", path: ["actions", at(), "amount"], value: pick([0, 1, 7, bb, bb * 3, 100000, -50, 1234567]) };
    }
    case "allIn":
      return { op: "set", path: ["actions", at(), "allIn"], value: chance(0.6) };
    case "holeCards": {
      const n = pick([0, 2, 2, 2, 4, 4, 5, 6, 3]);
      return { op: "set", path: ["players", below(players), "holeCards"], value: someCards(n) };
    }
    case "stack":
      return { op: "set", path: ["players", below(players), "startingStack"], value: pick([0, 1, 100, 999, 150000, hand.game.bigBlind * 20]) };
    case "playerSeat":
      return { op: "set", path: ["players", below(players), "seat"], value: pick([...seats, 0, 99]) };
    case "shown": {
      const n = pick([0, 2, 4, 5]);
      return { op: "set", path: ["results", "players", below(hand.results.players.length), "shownCards"], value: someCards(n) };
    }
    case "variant":
      return { op: "set", path: ["game", "variant"], value: pick(VARIANTS) };
    case "hiLo":
      return { op: "set", path: ["game", "hiLo"], value: chance(0.5) };
    case "site":
      return { op: "set", path: ["meta", "siteId"], value: pick(["ggpoker", " GGPoker ", "acrwpn", "standard", "weplay", ""]) };
    case "fee":
      return { op: "set", path: ["results", "fees", pick(FEES)], value: pick([0, 1, 3, 7, 99, 236, -5, 100000]) };
    case "totalPot":
      return { op: "set", path: ["results", "totalPot"], value: pick([0, -1, 1, hand.results.totalPot + 1, hand.results.totalPot * 2]) };
    case "chip":
      return {
        op: "push",
        path: ["chipMovements"],
        value: {
          kind: "bad-beat-drop",
          fromSeat: pick([null, null, ...seats]),
          fromPlayer: null,
          toPot: chance(0.6),
          amount: pick([1, 25, 100, 5000, -3]),
          raw: null,
          anchor: "after-hole-cards",
        },
      };
    case "board":
      // The first runout's cards replaced: a different board, or impossible ones.
      return {
        op: "set",
        path: ["board", "runouts", 0],
        value: { index: 0, flop: someCards(pick([3, 3, 3, 2, 0])), turn: pick([someCard(), null, ""]), river: pick([someCard(), null]), markerLabels: {}, summaryCards: null },
      };
    case "secondFlop": {
      const base = hand.board.runouts[0];
      return {
        op: "push",
        path: ["board", "runouts"],
        value: {
          index: hand.board.runouts.length,
          flop: chance(0.5) ? (base.flop ?? null) : someCards(3),
          turn: someCard(),
          river: someCard(),
          markerLabels: {},
          summaryCards: null,
        },
      };
    }
    case "cut":
      return { op: "set", path: ["board", "runouts", below(hand.board.runouts.length), pick(["flop", "turn", "river"])], value: null };
    case "runouts":
      return { op: "truncate", path: ["board", "runouts"], n: below(hand.board.runouts.length + 1) };
    case "bomb":
      return {
        op: "set",
        path: ["game", "bombPot"],
        value: chance(0.3) ? null : { ante: hand.game.bigBlind, dealtToStreet: "flop", doubleBoard: chance(0.5) },
      };
    default:
      throw new Error("unreachable");
  }
}

/** The container `path` (all but the last step) leads to, creating `chipMovements`. */
function at(doc, path) {
  let node = doc;
  for (const key of path) {
    if (node[key] === undefined || node[key] === null) node[key] = [];
    node = node[key];
  }
  return node;
}

/** Applies one edit to the PHF JSON in place. `tests/vectors.rs` mirrors this. */
function apply(doc, op) {
  switch (op.op) {
    case "set": {
      const parent = at(doc, op.path.slice(0, -1));
      parent[op.path[op.path.length - 1]] = structuredClone(op.value);
      break;
    }
    case "drop":
      at(doc, op.path).splice(op.i, 1);
      break;
    case "swap": {
      const list = at(doc, op.path);
      const a = list[op.i];
      list[op.i] = list[op.j];
      list[op.j] = a;
      break;
    }
    case "copy": {
      const list = at(doc, op.path);
      list.splice(op.j, 0, structuredClone(list[op.i]));
      break;
    }
    case "push":
      at(doc, op.path).push(structuredClone(op.value));
      break;
    case "truncate":
      at(doc, op.path).length = op.n;
      break;
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

function drawOptions() {
  if (chance(0.4)) return null;
  const out = {};
  if (chance(0.8)) out.exhaustiveLimit = pick([0, 1000, 50000, 200000, 5000000]);
  if (chance(0.8)) out.trials = pick([1, 7, 50, 200, 1000]);
  if (chance(0.8)) out.seed = seed32();
  if (chance(0.2)) out.method = "monte-carlo";
  return out;
}

const handCases = [];
let thrown = 0;
while (handCases.length < HAND_CASES) {
  const base = chance(0.8) ? pick(interesting) : pick(bases);
  const doc = JSON.parse(base.text);
  const ops = [];
  const count = 1 + below(3);
  for (let k = 0; k < count; k += 1) {
    const op = drawOp(doc);
    apply(doc, op);
    ops.push(op);
  }
  const options = drawOptions();
  const text = JSON.stringify(doc);
  let analysis;
  let row;
  try {
    analysis = E.analysisDoc(E.analyzeAllIn(JSON.parse(text), options ?? {}));
    if (options === null) {
      const phf = JSON.parse(text);
      const hero = E.handStatsRows(phf, { includeVillains: false }).find((r) => r.is_hero);
      row = hero ? { ...E.handEvRow(phf, hero) } : null;
      if (row && Object.is(row.ev_net_bb_milli, -0)) row.ev_net_bb_milli = 0;
    }
  } catch {
    thrown += 1;
    continue;
  }
  const entry = { file: base.file, hand: base.hand, phf: sha16(base.text), ops, options, analysis };
  if (options === null) entry.row = row;
  handCases.push(entry);
}

/* ----------------------------------------------------- equity() requests - */

const GAMES = ["holdem", "holdem", "holdem", "shortdeck", "omaha", "omaha5", "omaha6"];
const HOLE = { holdem: 2, shortdeck: 2, omaha: 4, omaha5: 5, omaha6: 6 };
const SHORT_DECK = DECK.filter((card) => "6789TJQKA".includes(card[0]));

function equityRequest() {
  const game = pick(GAMES);
  // One request in four carries exactly one fault, so most of them compute.
  const fault = chance(0.25) ? pick(["card", "count", "players", "board", "pot", "deck"]) : null;
  const deck = game === "shortdeck" && fault !== "deck" ? SHORT_DECK : DECK;
  const pool = [...deck];
  const deal = () => pool.splice(below(pool.length), 1)[0];
  const players = fault === "players" ? pick([0, 13]) : game === "holdem" || game === "shortdeck" ? 2 + below(5) : 2 + below(3);
  const boardSize = fault === "board" ? pick([1, 2, 6]) : pick([0, 3, 3, 4, 4, 5]);
  const hands = [];
  for (let i = 0; i < players; i += 1) {
    hands.push(Array.from({ length: HOLE[game] }, deal));
  }
  if (fault === "count" && players > 0) {
    const hand = hands[below(players)];
    if (chance(0.5)) hand.pop();
    else hand.push(deal());
  }
  const request = { game, hands, board: Array.from({ length: boardSize }, deal) };
  if (chance(0.3)) request.dead = Array.from({ length: 1 + below(3) }, deal);
  if (fault === "card") {
    const lists = [...hands, request.board, request.dead ?? []].filter((list) => list.length > 0);
    const list = pick(lists);
    list[below(list.length)] = chance(0.5) ? pick(ODD_CARDS) : pick(lists.flat());
  }
  if (game === "shortdeck" && chance(0.7)) request.shortDeckRule = pick(["trips-over-straight", "straight-over-trips"]);
  if (players > 1 && (chance(0.4) || fault === "pot")) {
    const pots = [];
    for (let p = 0, n = 1 + below(3); p < n; p += 1) {
      const pot = [];
      for (let k = 0, m = 1 + below(players); k < m; k += 1) pot.push(below(players));
      pots.push(pot);
    }
    if (fault === "pot") {
      const pot = pick(pots);
      if (chance(0.2)) pot.length = 0;
      else pot[below(pot.length)] = pick([-1, players, 99]);
    }
    request.pots = pots;
  }
  // Keep the work small: a preflop Hold'em enumeration now and then, every
  // flop and turn spot, Omaha preflop sampled.
  const preflopOmaha = boardSize === 0 && HOLE[game] > 2;
  const methods = preflopOmaha ? ["auto", "monte-carlo"] : boardSize === 0 ? ["auto", "monte-carlo", "monte-carlo"] : ["auto", "exhaustive", "monte-carlo"];
  const method = pick(methods);
  if (method !== "auto" || chance(0.5)) request.method = method;
  if (boardSize === 0 && !preflopOmaha && method === "auto") {
    request.exhaustiveLimit = chance(0.15) ? 5000000 : pick([0, 100000]);
  } else if (chance(0.4)) {
    request.exhaustiveLimit = pick([0, 100, 5000, 100000]);
  }
  if (chance(0.7)) request.trials = pick([1, 10, 100, 500, 2000]);
  else if (method !== "exhaustive") request.trials = 300;
  if (chance(0.7)) request.seed = seed32();
  return request;
}

const equityCases = [];
while (equityCases.length < EQUITY_CASES) {
  const request = equityRequest();
  let out;
  try {
    const planned = E.plan(request);
    const result = E.equity(request);
    out = {
      plan: planned,
      result: { pots: result.pots.map((row) => row.map(num)), method: result.method, boards: result.boards },
    };
  } catch (error) {
    if (!(error instanceof E.EquityInputError)) throw error;
    out = { error: error.message };
  }
  equityCases.push({ request, ...out });
}

/* ---------------------------------------------------------------- ranges - */

const WEIGHTS = ["", "", "", ":0.5", ":0.25", ":1", ":0.3", ":0.7", ":0.333", ":0.1", ":2", ":0", ":-1", ":abc", ": 0.75 ", ":1e-1", ":0x1", ":", ":0.5:3"];
const TOKENS = [
  "AA", "KK", "QQ+", "77+", "22+", "ATs+", "A2s+", "KTs+", "ATo+", "KJo+", "KQ", "AK", "AKs", "AKo", "T9s-65s",
  "65s-T9s", "A5s-A2s", "KTo-K8o", "22-JJ", "JJ-22", "99-QQ", "QJs", "T8", "72o", "*", "any", "ANY", "akS",
  "kq", "AX", "KAs", "T9s-75s", "22-A2s", "A5s-A2o", "A", "+", "", " ", "AKx", "AA+", "AKs+", "K2s+", "-AK",
  "AK-", "A5s-A2s-A3s", "QQ-", "Q", "\u00c4K", "\u{1F600}A", "AQs:0.5", "Ts9s",
];
function rangeText() {
  const n = 1 + below(5);
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    parts.push(pick(TOKENS) + (chance(0.4) ? pick(WEIGHTS) : ""));
  }
  return parts.join(pick([",", ", ", " ,", ",,"]));
}
/** A range text that parses. */
function goodRangeText() {
  for (;;) {
    const text = rangeText();
    try {
      if (E.parseRange(text).size > 0) return text;
    } catch {
      // draw again
    }
  }
}
const asClasses = (map) => [...map].map(([name, weight]) => [name, num(weight)]);
const COMBO_WEIGHTS = [1, 1, 0.5, 0.25, 0.3, 0.7, 0.125, 0, -1, 2, 1 / 3];
function someRange(seen) {
  if (chance(0.7)) {
    return { classes: asClasses(E.parseRange(goodRangeText())) };
  }
  const combos = [];
  for (let i = 0, n = 1 + below(12); i < n; i += 1) {
    const a = below(52);
    let b = below(52);
    if (b === a && chance(0.9)) b = (a + 1 + below(51)) % 52;
    combos.push([[a, b], num(pick(COMBO_WEIGHTS))]);
  }
  return { combos };
}
/** The range as the TypeScript takes it. */
function toTs(range) {
  if (range.classes) return new Map(range.classes.map(([name, weight]) => [name, Number(weight)]));
  return range.combos.map(([cards, weight]) => ({ cards, weight: Number(weight) }));
}
function rangeOptions(multi) {
  const out = {};
  const m = pick(["auto", "auto", "monte-carlo", "exhaustive"]);
  if (m !== "auto") out.method = m;
  if (chance(0.5)) out.exhaustiveLimit = pick(multi ? [0, 1000, 50000, 500000] : [0, 1000, 20000, 120000]);
  out.trials = pick([1, 10, 100, 400, 1500]);
  if (chance(0.7)) out.seed = seed32();
  return out;
}
const result = (r) => ({ equity: num(r.equity), win: num(r.win), tie: num(r.tie), combos: r.combos, method: r.method, samples: r.samples });

function rangeCase() {
  const kind = pick(["parse", "parse", "share", "vsRange", "vsRange", "vsRange", "vsRanges", "vsRanges", "strongest"]);
  const failure = (error) => {
    if (error instanceof E.EquityInputError) return { error: "input", message: error.message };
    if (error instanceof TypeError) return { error: "type" };
    throw error;
  };
  if (kind === "parse") {
    const text = rangeText();
    try {
      return { kind, text, classes: asClasses(E.parseRange(text)) };
    } catch (error) {
      return { kind, text, ...failure(error) };
    }
  }
  if (kind === "share") {
    const classes = asClasses(E.parseRange(goodRangeText()));
    if (chance(0.1)) classes.push([pick(["AX", "A", "AKx", "KAs", ""]), "1"]);
    try {
      return { kind, classes, share: num(E.rangeShare(toTs({ classes }))) };
    } catch (error) {
      return { kind, classes, ...failure(error) };
    }
  }
  const boardSize = kind === "strongest" ? pick([3, 4, 5, 5, 2]) : pick([0, 3, 4, 4, 5, 5, 1]);
  const cards = someCards(2 + boardSize + 3, 0.02);
  const hero = cards.slice(0, chance(0.03) ? 1 : 2);
  const board = cards.slice(2, 2 + boardSize);
  const dead = chance(0.3) ? cards.slice(2 + boardSize, 2 + boardSize + 1 + below(2)) : [];
  // The samplers deal from the full deck with rejection; keep the board
  // light enough that a deal always exists. Preflop spots enumerate only
  // when the request is small, so exhaustive is not forced there.
  if (kind === "strongest") {
    const range = someRange();
    const share = num(pick([0.05, 0.1, 0.25, 0.5, 1, 0, 1.5]));
    try {
      const out = E.strongestOfRange(toTs(range), board, Number(share), dead);
      return { kind, range, board, dead, share, combos: out.map((c) => [c.cards, num(c.weight)]) };
    } catch (error) {
      return { kind, range, board, dead, share, ...failure(error) };
    }
  }
  if (kind === "vsRange") {
    const range = someRange();
    const options = rangeOptions(false);
    if (board.length < 4 && options.method === "exhaustive") delete options.method;
    const request = { hero, range: toTs(range), board, dead, ...options };
    try {
      return { kind, hero, range, board, dead, options, result: result(E.equityVsRange(request)) };
    } catch (error) {
      return { kind, hero, range, board, dead, options, ...failure(error) };
    }
  }
  const ranges = Array.from({ length: chance(0.03) ? 0 : 1 + below(3) }, () => someRange());
  const options = rangeOptions(true);
  // Forced enumeration only for one range on the river; two or more
  // enumerate through "auto" when the tuples fit the limit.
  if ((board.length < 5 || ranges.length !== 1) && options.method === "exhaustive") delete options.method;
  const request = { hero, ranges: ranges.map(toTs), board, dead, ...options };
  try {
    const r = E.equityVsRanges(request);
    return { kind, hero, ranges, board, dead, options, result: { ...result(r), combos: r.combos } };
  } catch (error) {
    return { kind, hero, ranges, board, dead, options, ...failure(error) };
  }
}

const rangeCases = [];
while (rangeCases.length < RANGE_CASES) rangeCases.push(rangeCase());

/* ------------------------------------------------------------------ out - */

const count = (list, test) => list.filter(test).length;
const out = {
  meta: {
    note: "written by ev-vectors.mjs; do not edit",
    seed: STRESS ?? "default",
    hands: handCases.length,
    handsApplicable: count(handCases, (c) => c.analysis.applicable),
    handsMonteCarlo: count(handCases, (c) => c.analysis.method === "monte-carlo"),
    handsThrown: thrown,
    equity: equityCases.length,
    equityErrors: count(equityCases, (c) => c.error !== undefined),
    equityMonteCarlo: count(equityCases, (c) => c.result?.method === "monte-carlo"),
    ranges: rangeCases.length,
    rangeErrors: count(rangeCases, (c) => c.error !== undefined),
  },
  hands: handCases,
  equity: equityCases,
  ranges: rangeCases,
};
writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(`ev vectors: ${JSON.stringify(out.meta)} -> ${OUT}`);
