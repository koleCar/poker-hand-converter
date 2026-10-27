// Writes serialize-vectors.json: what the TypeScript standard-text reader
// and writer (`web/src/lib/phf/serialize.ts`) make of every golden hand
// and of hands the corpus does not have, for `rail_core::phf::serialize` to
// replay (docs/RAIL-PLAN.md R0.6).
//
//     cd tests && npm ci && npm run golden:emit     (testdata/golden-full/)
//     node core/rail-core/tests/data/serialize-vectors.mjs
//
// The goldens pin `toStandardText(hand)` for every accepted corpus hand (the
// `standardText` hashes). This file adds what they do not:
//
//  - `corpus`, per golden file, per hand: the sha-256 (first 16 hex digits)
//    of the canonical JSON of `parseStandardHand(toStandardText(hand))` with
//    `parsedAt` pinned - the standard parser on 8 422 texts it did not see in
//    the corpus - and of `toStandardText(hand, { regenerateSummary: true })`,
//    the summary generator the corpus reaches only for hands without a `raw`
//    line. Plus the hands on which the TypeScript round trip is *not* exact,
//    by index: `semantic` (`semantics(parse(text)) != semantics(hand)`, the
//    projection of `tests/test/phfRoundTrip.test.ts`) and `bytes`
//    (`toStandardText(parse(text)) != text`).
//  - `cases`: seeded mutations of a sample of golden hands that reach the
//    style and header paths the corpus leaves alone (pinned style fields,
//    dates, levels, buy-ins, runouts, labels, fee columns, ...), each a list
//    of JSON-pointer edits with the hash of the text the TypeScript writes and
//    of what its parser reads back - or the message it throws.
//  - `texts`: hand-written standard-format texts (the unit tests' fixtures and
//    edge cases of the reader) with the canonical JSON hash of what
//    `parseStandardHand` returns (`null` when it returns null), and the
//    chunks `splitStandardHands` cuts from them.
//
// Bundles the TypeScript with esbuild from tests/node_modules (the sources
// import without extensions, which Node's own type stripping cannot follow).
// Deterministic (seeded), so rerunning it rewrites the same file as long as
// the goldens and the TypeScript are the same.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(join(ROOT, "tests/package.json"));
const esbuild = require("esbuild");

const bundle = await esbuild.build({
  stdin: {
    contents: `
      export {
        parseStandardHand,
        splitStandardHands,
        toStandardText,
        toStandardTextFile,
      } from "./web/src/lib/phf/serialize.ts";
      export { canonicalJson } from "./tests/scripts/golden/canonical.ts";
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
const { parseStandardHand, splitStandardHands, toStandardText, canonicalJson } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const PARSED_AT = "1970-01-01T00:00:00.000Z";
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const short = (text) => sha(text).slice(0, 16);

/**
 * `parseStandardHand` with the clock pinned, or null. Through JSON, because
 * the reader can write `-0` (`amount: -amount` for an uncalled bet of 0),
 * which canonical JSON refuses and `JSON.stringify` - what the app stores -
 * writes as `0`; a Rust amount has no `-0` to begin with.
 */
function reparsed(text) {
  const hand = parseStandardHand(text, CTX);
  if (!hand) return null;
  hand.meta.parsedAt = PARSED_AT;
  return JSON.parse(JSON.stringify(hand));
}

/** `semantics()` of tests/test/phfRoundTrip.test.ts, verbatim. */
function semantics(hand) {
  return {
    schema: hand.schema,
    handId: hand.meta.handId,
    playedAt: hand.playedAt,
    game: hand.game,
    table: hand.table,
    tournament: hand.tournament,
    players: hand.players,
    board: hand.board,
    results: hand.results,
    textStyle: hand.meta.textStyle,
    actions: hand.actions.map((action) => ({
      street: action.street,
      runoutIndex: action.runoutIndex,
      player: action.player,
      type: action.type,
      amount: action.amount,
      streetTotal: action.streetTotal,
      allIn: action.allIn,
      cards: action.cards ?? null,
      description: action.description ?? null,
      potName: action.potName ?? null,
    })),
  };
}

/** Vitest's `toEqual`: deep equality that ignores `undefined` properties. */
function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  }
  const keys = (o) => Object.keys(o).filter((k) => o[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
}

/* ---------------------------------------------------------- the corpus --- */

function walk(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : name.endsWith(".json") ? [full] : [];
    });
}

const GOLDEN_FULL = join(ROOT, "testdata/golden-full");
const corpus = {};
const bases = [];
let hands = 0;
for (const file of walk(GOLDEN_FULL)) {
  const golden = JSON.parse(readFileSync(file, "utf8"));
  if (golden.hands.length === 0) continue;
  const entry = { reparsed: [], regenerated: [], semantic: [], bytes: [] };
  golden.hands.forEach((record, index) => {
    const hand = record.phf;
    const text = toStandardText(hand);
    if (sha(text) !== record.standardText) {
      throw new Error(`${golden.input.path} hand ${index}: standardText is stale; rerun golden:emit`);
    }
    const back = reparsed(text);
    entry.reparsed.push(back ? short(canonicalJson(back)) : null);
    entry.regenerated.push(short(toStandardText(hand, { regenerateSummary: true })));
    if (!back || !equal(semantics(back), semantics(hand))) entry.semantic.push(index);
    if (!back || toStandardText(back) !== text) entry.bytes.push(index);
    hands += 1;
    bases.push(hand);
  });
  corpus[golden.input.path] = entry;
}

/* ------------------------------------------------------------ helpers --- */

let seed = 0x5e71a11e;
function random() {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (n) => Math.floor(random() * n);
const pick = (items) => items[int(items.length)];

/** Applies one `{ path, value }` edit (JSON pointer; `value` absent = delete). */
function apply(hand, edit) {
  const parts = edit.path.split("/").slice(1);
  let target = hand;
  for (const part of parts.slice(0, -1)) target = target[part];
  const last = parts[parts.length - 1];
  if (!("value" in edit)) {
    if (Array.isArray(target)) target.splice(Number(last), 1);
    else delete target[last];
  } else {
    target[last] = structuredClone(edit.value);
  }
}

/* ------------------------------------------------------ the mutations --- */

const STRINGS = ["", "FIRST", "SECOND", "first", "X", "Main", "Side pot-1"];
const DATES = [
  null,
  "",
  "2026-02-17T05:56:01.000Z",
  "2026-02-17T15:06:01.000Z",
  "0999-01-02T03:04:05.000Z",
  "2026-02-17T05:56:01Z",
  "2026-02-17T05:56Z",
  "2026-02-17",
  "2026-02-31T05:56:01.000Z",
  "2026-02-17T24:00:00.000Z",
  "2026-02-17T05:56:01.123456Z",
  "2026-02-17T05:56:01+02:00",
  "2026-02-17T01:56:01-03:30",
  "+010000-01-01T00:00:00.000Z",
  "-000001-12-31T23:59:59.000Z",
  "not a date",
];

/** Edits for one random mutation of `hand`. */
function mutation(hand) {
  const edits = [];
  const n = 1 + int(3);
  for (let i = 0; i < n; i += 1) {
    switch (int(22)) {
      case 0:
        edits.push({ path: "/meta/textStyle/decimals", value: pick(["minimal", "fixed2"]) });
        break;
      case 1:
        edits.push({ path: "/meta/textStyle/groupThousands", value: random() < 0.5 });
        break;
      case 2:
        edits.push({ path: "/meta/textStyle/dealtLineTrailingSpace", value: random() < 0.5 });
        break;
      case 3:
        edits.push({
          path: "/meta/textStyle/summaryFeeColumns",
          value: pick([[], ["Rake"], ["Rake", "Jackpot", "Bingo"], ["Tax", "Other", "Rake"], ["toString"]]),
        });
        break;
      case 4:
        edits.push({ path: "/meta/textStyle/headerPayload", value: pick(["", "custom payload  x"]) });
        break;
      case 5:
        edits.push({ path: "/meta/rawText", value: pick(["", "Poker Hand #X: y", hand.meta.rawText.replace(/\d/, "7")]) });
        break;
      case 6:
        edits.push({ path: "/playedAt", value: pick(DATES) });
        edits.push({ path: "/meta/textStyle/padHour", value: random() < 0.5 });
        break;
      case 7:
        edits.push({ path: "/meta/textStyle/showdownLabels", value: pick([[], [""], ["FIRST", "SECOND"], ["X"]]) });
        break;
      case 8:
        edits.push({ path: "/meta/textStyle/showdownSection", value: random() < 0.5 });
        edits.push({ path: "/meta/textStyle/holeCardsSection", value: random() < 0.5 });
        break;
      case 9:
        edits.push({ path: "/meta/textStyle/runItTwiceNote", value: random() < 0.5 });
        break;
      case 10:
        if (hand.tournament) {
          edits.push({ path: "/tournament/levelLabel", value: pick([null, "14", "XI", "", "iv"]) });
          edits.push({ path: "/tournament/levelNumber", value: pick([null, 0, 1, 4, 9, 14, 40, 1994, 3999]) });
        } else {
          edits.push({ path: "/game/variant", value: pick(["shortdeck", "holdem"]) });
          edits.push({ path: "/game/smallBlind", value: pick([0, 1, 25]) });
        }
        break;
      case 11:
        if (hand.tournament) {
          edits.push({ path: "/tournament/name", value: pick([null, "", "Daily $5 (x)"]) });
          edits.push({ path: "/tournament/bounty", value: pick([0, 450, 12345]) });
          edits.push({ path: "/tournament/fee", value: pick([0, 100, 1050]) });
        } else {
          edits.push({ path: "/game/label", value: pick(["Hold'em No Limit", "Omaha Hi/Lo Pot Limit", ""]) });
        }
        break;
      case 12: {
        const p = int(hand.players.length);
        edits.push({ path: `/players/${p}/startingStack`, value: pick([0, 5, 50, 1234567, 100000005, 99]) });
        break;
      }
      case 13: {
        if (hand.actions.length === 0) break;
        const a = int(hand.actions.length);
        edits.push({ path: `/actions/${a}/amount`, value: pick([0, 1, 10, 105, 123456, -50]) });
        break;
      }
      case 14: {
        if (hand.actions.length === 0) break;
        const a = int(hand.actions.length);
        edits.push({ path: `/actions/${a}/verb`, value: pick(["straddle", "posts straddle", "posts button blind", "posts"]) });
        break;
      }
      case 15: {
        if (hand.actions.length === 0) break;
        const a = int(hand.actions.length);
        edits.push({ path: `/actions/${a}/description`, value: pick(["", "a pair of Aces", "mucks hand"]) });
        edits.push({ path: `/actions/${a}/potName`, value: pick(["", "side pot-1", "main pot"]) });
        break;
      }
      case 16: {
        const r = int(hand.board.runouts.length);
        edits.push({ path: `/board/runouts/${r}/markerLabels`, value: pick([{}, { flop: "" }, { flop: "FIRST", turn: "SECOND", river: "X" }]) });
        edits.push({ path: `/board/runouts/${r}/summaryCards`, value: pick([null, [], ["Ah", "Kd", "2c"], ["2c", "Ah", "Kd", "5s", "6s"]]) });
        break;
      }
      case 17:
        edits.push({
          path: `/board/runouts/${hand.board.runouts.length}`,
          value: pick([
            { index: 1, flop: null, turn: "7h", river: "8h", markerLabels: {}, summaryCards: null },
            { index: 1, flop: [], turn: "", river: null, markerLabels: {}, summaryCards: null },
            { index: 1, flop: ["2s", "3s", "4s"], turn: "5s", river: "6s", markerLabels: {}, summaryCards: null },
          ]),
        });
        break;
      case 18: {
        const p = int(hand.results.players.length);
        if (p >= hand.results.players.length) break;
        edits.push({ path: `/results/players/${p}/raw`, value: null });
        edits.push({ path: `/results/players/${p}/outcome`, value: pick(["folded", "mucked", "collected", "won", "lost", "showed", "unknown"]) });
        edits.push({ path: `/results/players/${p}/foldedStreet`, value: pick([null, "preflop", "turn"]) });
        edits.push({ path: `/results/players/${p}/won`, value: pick([0, 150]) });
        break;
      }
      case 19:
        edits.push({ path: "/table/name", value: pick([null, "", "Table 'x'"]) });
        edits.push({ path: "/table/buttonSeat", value: pick([null, 0, 3]) });
        break;
      case 20:
        edits.push({ path: "/game/unit", value: pick([
          { code: "USD", symbol: "$", minorUnits: 100, kind: "cash" },
          { code: "EUR", symbol: "€", minorUnits: 100, kind: "cash" },
          { code: "CHIPS", symbol: "", minorUnits: 1, kind: "chips" },
          { code: "CHIPS", symbol: "", minorUnits: 100, kind: "chips" },
          { code: "JPY", symbol: "¥", minorUnits: 1, kind: "cash" },
          { code: "USDT", symbol: "₮", minorUnits: 100, kind: "cash" },
        ]) });
        break;
      default: {
        if (hand.actions.length === 0) break;
        const a = int(hand.actions.length);
        edits.push({ path: `/actions/${a}/street`, value: pick(["preflop", "flop", "turn", "river", "showdown"]) });
        edits.push({ path: `/actions/${a}/runoutIndex`, value: pick([0, 1, 3]) });
        break;
      }
    }
  }
  return edits;
}

const sample = [];
for (let i = 0; i < 160; i += 1) sample.push(bases[int(bases.length)]);
// Make sure every dialect is in the sample: one of each parser and format.
const seen = new Set(sample.map((h) => `${h.meta.parserId}/${h.game.format}/${h.game.hiLo}/${h.game.variant}`));
for (const hand of bases) {
  const key = `${hand.meta.parserId}/${hand.game.format}/${hand.game.hiLo}/${hand.game.variant}`;
  if (!seen.has(key)) {
    seen.add(key);
    sample.push(hand);
  }
}

const cases = [];
sample.forEach((base, b) => {
  for (let k = 0; k < 12; k += 1) {
    const hand = structuredClone(base);
    const edits = mutation(hand);
    for (const edit of edits) apply(hand, edit);
    let outcome;
    try {
      const text = toStandardText(hand);
      const back = reparsed(text);
      outcome = { text: short(text), reparsed: back ? short(canonicalJson(back)) : null };
    } catch (error) {
      outcome = { thrown: String(error.message) };
    }
    cases.push({ base: b, edits, ...outcome });
  }
});

/* ----------------------------------------------------------- the texts --- */

/** Every template literal in a test file that starts like a standard hand. */
function fixturesOf(file) {
  const source = readFileSync(join(ROOT, "tests/test", file), "utf8");
  return [...source.matchAll(/`((?:Poker|PokerStars|GG|Weplay) Hand #[^`]*)`/g)]
    .map((m) => m[1])
    .filter((text) => !text.includes("${"));
}

const texts = [];
for (const file of [
  "phfSerializeStyle.test.ts",
  "phfCoreGaps.test.ts",
  "phfMoney.test.ts",
  "phfValidate.test.ts",
  "phfPositions.test.ts",
  "phfHiLo.test.ts",
  "phfOmaha.test.ts",
  "shortDeck.test.ts",
  "statsSpots.test.ts",
]) {
  for (const text of fixturesOf(file)) texts.push(text);
}
// The reader's edge cases, beyond what any fixture prints.
const EDGE = [
  "",
  "hello",
  "Poker Hand #1: x",
  "Poker Hand #1: Hold'em No Limit ($1/$2) - 2026/02/17 5:06:07\nTable 'T' 6-max\nSeat 1: a ($10 in chips)",
  "﻿Poker Hand #2: Hold'em No Limit ($1/$2) - 2026/02/31 24:00:00\r\nSeat 1: a ($10 in chips)\r\nSeat 2: b ($10 in chips)\r\na: posts small blind $1\r\nb: posts big blind $2\r\na: raises $2 to $4\r\nb: calls $2\r\n*** FLOP *** [Ah Kd 2c]\r\na: bets $3 and is all-in\r\nb: folds\r\nUncalled bet ($3) returned to a\r\na collected $8 from the pot\r\n*** SUMMARY ***\r\nTotal pot $8 | Rake $0\r\nBoard [Ah Kd 2c]\r\nSeat 1: a showed [Qs Qh] and won ($8) with a pair\r\nSeat 2: b (big blind) folded on the Flop\r\nsomething else",
  "GG Hand #3: Tournament #9, $5+$0.50 Hold'em No Limit - Level IV (50/100/10) - 2026-02-17 05:06:07\nTable '1' 9-max Seat #2 is the button\nSeat 2: a (1,000 in chips)\nSeat 5: b (1,000.50 in chips)\na: posts the ante 10\nb: posts the ante 10\na: posts small blind 50\nb: posts big blind 100\nb: posts 300\na: Chooses to EV Cashout\nb: Pays Cashout Risk ($1.5)\na: shows [Ah Ad] (two pair)\nb: mucks hand\nb: doesn't show hand\nb: said, \"hi\"\na collected 200 from side pot-1\nNo low hand qualified\n*** SHOW DOWN ***\n*** SUMMARY ***\nTotal pot 220 Main pot 100. Side pot 120. | Rake 0 | Jackpot 1 | Bingo 2 | Fortune 3 | Tax 4\nHand was run two times\nFIRST\nBoard [Ah Kd 2c 3s 4s]\nSECOND Board [5h 6h]\nSeat 2: a (button) (small blind) showed [Ah Ad] and won (200) with two pair, and lost\nSeat 5: b mucked [Kh Kc]\nSeat 9: ghost collected (5)",
  "Poker Hand #4: Tournament (Name (with) parens)#77, Freeroll Omaha Hi/Lo Pot Limit - Level 0 (10/20) - 2026/02/17 05:06:07\nTable '' 6-max Seat #0 is the button\nSeat 1: a (100 in chips)\nSeat 2: b (100 in chips)\na: posts small blind 10\nb: posts big blind 20\n*** FIRST FLOP *** [Ah Kd 2c]\n*** SECOND FLOP *** [3h 4d 5c]\n*** FIRST TURN *** [Ah Kd 2c] [7s]\n*** SECOND RIVER *** [3h 4d 5c 7s] [8s]\n*** FIRST SHOWDOWN ***\na collected 15 from pot\n*** SECOND SHOWDOWN ***\nb collected 15 from pot\n*** SUMMARY ***\nTotal pot 30\nSeat 1: a (small blind) collected (15)\nSeat 2: b (big blind) collected (15)",
  "PokerStars Hand #5: Razz Limit ($1/$2) - 2026/02/17 05:06:07\nSeat 1: a ($10 in chips)\nSeat 1: a2 ($10 in chips)\nSeat 3: Hero ($10 in chips)\nDealt to Hero [2c 3d]\nDealt to a\nDealt to nobody [4h]\na: posts straddle $4\nHero: straddle $8\na2: posts $1\nghost: straddle $16\nCash Drop to Pot : total $0.2\n*** SUMMARY ***\nBoard [Ah Kd 2c 3s]\nSeat 1: a2 folded before Flop (didn't bet)\nSeat 01: a mucked\nSeat 3: Hero Cashout Risk ($1.25), won ($2)",
  "Weplay Hand #6: ShortDeck No Limit ($0.02) - 2026/02/17 05:06:07\nSeat 1: a ($1 in chips)\nSeat 2: b ($1 in chips)\na: posts button blind $0.02\nb: posts missed blind $0.01\nb: straddle $0.04\na: straddle $0.08\n*** HOLE CARDS ***\nSTP added: €0.5\n*** SUMMARY ***\nBoard [6h 7h 8h]",
  "Poker Hand #7: Hold'em No Limit (€0.50/€1) - 2026/02/17 05:06:07\nSeat 1: a (€10 in chips)\nSeat 2: b (€10 in chips)\na: posts the ante €0.10\nb: posts the ante €0.10 and is all-in\n*** FLOP *** [Ah Kd 2c]\n*** SECOND FLOP *** [3h 4d 5c]\n*** SUMMARY ***\nFIRST Board [Ah Kd 2c]\nSECOND Board [3h 4d 5c]",
  "Poker Hand #8: Hold'em No Limit ($0.01/$0.02) - 2026/02/17 05:06:07\nTable 'T' 6-max Seat #1 is the button\nSeat 1: a ($2 in chips)\nSeat 2: b ($2 in chips)\nb: posts small blind $0.01\na: posts big blind $0.02\n*** HOLE CARDS ***\nb: calls $0.01\na: checks\n*** SUMMARY ***\nBoard [Ah Kd 2c 3s 4s]",
  "Poker Hand #9: Tournament #1, $1 Hold'em No Limit - Level99999999999 (1/2) - 2026/02/17 05:06:07\nSeat 1: a (5 in chips)",
  "Poker Hand #10: Hold'em No Limit (1/2) - 2026/02/17 05:06:07\nTable 'T' 99999999999-max\nSeat 1: a (5 in chips)",
];
for (const text of EDGE) texts.push(text);
const splitInputs = [
  ...EDGE,
  EDGE.join("\n\n"),
  `﻿${EDGE[4]}\n\n\n${EDGE[6]}`,
  "x\rPoker Hand #1: y GG  Hand  #2: z\nweplay hand #3: q\nPokerStars Hand #bad id: z",
];

/**
 * Whether a PHF seat (a Rust `u32`) can hold every seat-like number of the
 * hand: the reader writes `seat: -1` for a straddler without a seat line,
 * and keeps any `\d+` it reads as a JavaScript number.
 */
function fitsU32Seats(hand) {
  const ok = (n) => n === null || (Number.isInteger(n) && n >= 0 && n <= 0xffffffff);
  return (
    ok(hand.table.maxSeats) &&
    ok(hand.table.buttonSeat) &&
    hand.players.every((p) => ok(p.seat)) &&
    hand.game.straddles.every((s) => ok(s.seat)) &&
    (hand.tournament === null || ok(hand.tournament.levelNumber))
  );
}

const textOut = texts.map((text) => {
  let outcome;
  try {
    const hand = reparsed(text);
    outcome = !hand
      ? { phf: null }
      : fitsU32Seats(hand)
        ? { phf: short(canonicalJson(hand)), standardText: short(toStandardText(hand)) }
        : { phf: null, unrepresentable: true };
  } catch (error) {
    outcome = { thrown: String(error.message) };
  }
  return { text, ...outcome };
});
const splits = splitInputs.map((text) => ({ text, chunks: splitStandardHands(text) }));

const out = {
  generatedBy: "core/rail-core/tests/data/serialize-vectors.mjs",
  hands,
  bases: sample.length,
  corpus,
  baseHands: sample.map((hand) => ({ handId: hand.meta.handId, phf: sha(canonicalJson(hand)) })),
  cases,
  texts: textOut,
  splits,
};
writeFileSync(
  join(ROOT, "core/rail-core/tests/data/serialize-vectors.json"),
  `${JSON.stringify(out)}\n`,
);
const semantic = Object.values(corpus).reduce((n, e) => n + e.semantic.length, 0);
const bytes = Object.values(corpus).reduce((n, e) => n + e.bytes.length, 0);
console.log(
  `${hands} corpus hands (${semantic} not semantically equal after a round trip, ${bytes} not byte-stable), ` +
    `${cases.length} cases from ${sample.length} bases, ${textOut.length} texts, ${splits.length} splits`,
);
