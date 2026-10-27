// Writes p3-vectors.json: what the TypeScript Full Tilt and Run It Once
// parsers (`web/src/lib/parsers/{fulltilt,runitonce}.ts`) make of texts
// the corpus does not have, for `rail_core::parsers` to replay
// (docs/RAIL-PLAN.md R0.10c).
//
//     cd tests && npm ci                 (esbuild)
//     node core/rail-core/tests/data/p3-vectors.mjs
//
// The goldens pin the 17 corpus files of these rooms through the pipeline.
// This file adds, by seeded mutation, the branches the corpus leaves alone:
//
//  - `splits`: per corpus file (all of `testdata/golden/`, decoded with the
//    app's `decodeSource`) the 16-hex sha-256 of `JSON.stringify` of both
//    parsers' `splitHands`, plus hand-written split edge cases (UTF-16LE
//    text read as UTF-8 among them).
//  - `detect`: both parsers' per-mille scores of hand-written probes.
//  - `cases`: a chunk of a corpus file (`file`, the parser whose split cut it,
//    the chunk index) with a list of line edits applied; both parsers'
//    detection score and `parseHand` outcome - the refusal's reason and
//    message, the message of anything else thrown, or the 16-hex sha-256 of
//    the canonical JSON of the hand (`parsedAt` pinned) - and, where it
//    differs, the outcome with `cashOnly`.
//  - `files`: corpus files of these rooms re-encoded (UTF-16 LE with and
//    without a BOM, UTF-16 BE, Windows-1252, CRLF, UTF-8 with a BOM) and run
//    through the converter's own path (`decodeSource`, `convertAny(text, {
//    sourceFilename, validate: true })`): encoding, ranking, every hand's
//    hash and every refusal.
//
// Edits are those of `p5-vectors.mjs` (`delete`, `insert`, `replace`,
// `swap`, `truncate`, `join`, `prefix`, `misread`; `{P}`/`{Q}`/`{ID}`
// substituted here).
//
// One guard: Full Tilt numbers its runout markers, and the draft pushes a
// runout for every index up to the one printed - `*** RIVER 99999999999 ***`
// would exhaust Node's heap. `StarsHandDraft.prototype.marker` is wrapped to
// throw `RUNOUT_CAP <index>` past index 9999 (`MAX_RUNOUT_INDEX` in
// `fulltilt.rs`, where the Rust parser stops with its parser error at the
// same line).
//
// Bundles the TypeScript with esbuild from tests/node_modules. Deterministic
// (seeded), so rerunning it rewrites the same file as long as the corpus and
// the TypeScript are the same. `P3_STRESS=<seed>` draws many more cases from
// another seed for a local soak run (the committed file is the default);
// `P3_OUT=<path>` writes it elsewhere, and `P3_VECTORS=<path>` points
// `tests/p3_vectors.rs` at it.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(join(ROOT, "tests/package.json"));
const esbuild = require("esbuild");

const bundle = await esbuild.build({
  stdin: {
    contents: `
      export { fulltiltParser, runitonceParser, convertAny, detectSite }
        from "./web/src/lib/parsers/index.ts";
      export { StarsHandDraft } from "./web/src/lib/parsers/shared/ps-gg-hand.ts";
      export { ParseSkip } from "./web/src/lib/phf/detect.ts";
      export { decodeSource } from "./web/src/components/converter/inputs.ts";
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
const {
  fulltiltParser,
  runitonceParser,
  convertAny,
  detectSite,
  StarsHandDraft,
  ParseSkip,
  decodeSource,
  canonicalJson,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const RUNOUT_CAP = 9999;
const marker = StarsHandDraft.prototype.marker;
StarsHandDraft.prototype.marker = function guarded(kind, runoutIndex, label, cards) {
  if (runoutIndex > RUNOUT_CAP) {
    throw new Error(`RUNOUT_CAP ${runoutIndex}`);
  }
  return marker.call(this, kind, runoutIndex, label, cards);
};

const PARSED_AT = "1970-01-01T00:00:00.000Z";
const PARSERS = { fulltilt: fulltiltParser, runitonce: runitonceParser };
const IDS = Object.keys(PARSERS);
const CTX = { sourceFilename: null, options: {} };
const CASH_ONLY = { sourceFilename: null, options: { cashOnly: true } };

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const short = (text) => sha(text).slice(0, 16);

/** A built hand as the goldens hash it: through JSON (drops `undefined`, `-0`). */
function handHash(value) {
  return short(canonicalJson(JSON.parse(JSON.stringify(value))));
}

function caught(error) {
  if (error instanceof ParseSkip) {
    return { skip: [error.reason, error.message] };
  }
  return { error: String(error?.message ?? error) };
}

function outcome(parse) {
  try {
    const hand = parse();
    hand.meta.parsedAt = PARSED_AT;
    return { hand: handHash(hand) };
  } catch (error) {
    return caught(error);
  }
}

/** `Math.round(score * 1000)`, the Rust per-mille. */
const permille = (parser, text) => Math.round(parser.detect(text) * 1000);

/** UTF-16LE bytes read as UTF-8. */
const misread = (text, bom) =>
  Buffer.concat([Buffer.from(bom ? [0xff, 0xfe] : []), Buffer.from(text, "utf16le")]).toString(
    "utf8",
  );

/* ---------------------------------------------------------- the corpus --- */

function walk(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : name.endsWith(".json") ? [full] : [];
    });
}

const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);

const GOLDEN = join(ROOT, "testdata/golden");
const files = walk(GOLDEN).map((path) => {
  const input = relative(GOLDEN, path).replace(/\\/g, "/").replace(/\.json$/, "");
  const golden = JSON.parse(readFileSync(path, "utf8"));
  const bytes = readFileSync(join(ROOT, input));
  const decoded = decodeSource(arrayBuffer(bytes));
  return { input, top: golden.detected?.top ?? null, text: decoded.problem ? null : decoded.text };
});

/* ------------------------------------------------------------ the PRNG --- */

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
const STRESS = process.env.P3_STRESS ? Number(process.env.P3_STRESS) : null;
const random = mulberry32(STRESS ?? 0xf7410e);
const pick = (list) => list[Math.floor(random() * list.length)];
const below = (n) => Math.floor(random() * n);

/* --------------------------------------------------------- the edits --- */

const FT_LINES = [
  "{P} folds",
  "{P} checks",
  "{P} calls $1",
  "{P} calls $1,000.50",
  "{P} calls $3, and is capped",
  "{P} calls $3, and is all in",
  "{P} bets $2.50",
  "{P} bets $5, and is all in",
  "{P} bets $5 and is all in",
  "{P} bets $5, and is all in, and is capped",
  "{P} raises to $10",
  "{P} raises to $240, and is capped",
  "{P} raises to $20, and is all in",
  "{P} raises $5 to $10",
  "{P} posts the small blind of $0.50",
  "{P} posts the big blind of $1",
  "{P} posts the small blind of $0.02",
  "{P} posts a dead small blind of $0.50",
  "{P} posts a dead big blind of $1",
  "{P} posts big blind of $1",
  "{P} posts $1",
  "{P} posts $0.50",
  "{P} antes $0.25",
  "{P} antes 25",
  "Ghost posts $1",
  "Ghost posts the big blind of $1",
  "Ghost antes $0.25",
  "Uncalled bet of $5 returned to {P}",
  "Uncalled bet of $0.50 returned to {P}",
  "Uncalled bet of $5 returned to Ghost",
  "Uncalled bet ($5) returned to {P}",
  "Ante of $0.25 returned to {P}",
  "{P} wins the pot ($17.60)",
  "{P} wins the pot ($17.60) with a pair of Jacks",
  "{P} wins the high pot ($5)",
  "{P} wins the low pot ($5)",
  "{P} wins the high pot ($61.55) with a flush",
  "{P} wins pot 1 ($311) with two pair, Aces and Threes",
  "{P} wins pot 2 ($311)",
  "{P} wins pot 0 ($5)",
  "{P} wins pot 3 ($1)",
  "{P} wins pot 99999999999 ($5)",
  "{P} wins pot 4294967296 ($5)",
  "{Q} wins the pot ($1)",
  "Ghost wins the pot ($1)",
  "{P} mucks",
  "{P} mucks hand",
  "{P} shows [Jd Qd]",
  "{P} shows [Ah Kd Qs Jc]",
  "{P} shows [Ah]",
  "{P} shows two pair, Queens and Threes",
  "{P} shows",
  "{P} shows []",
  "{P} shows [Xx Yy]",
  "Ghost shows [Jd Qd]",
  "{P}: idi0t lucker",
  "{P}:no space",
  "Ghost: hello",
  "{P} has 15 seconds left to act",
  "{P} has requested TIME",
  "{P} has been disconnected",
  "{P} has reconnected",
  "{P} has timed out",
  "{P} stands up",
  "{P} sits down",
  "{P} is sitting out",
  "Ghost is sitting out",
  "{P} has returned",
  "{P} joins the table at seat #3",
  "{P} leaves the table",
  "{P} adds $1.95",
  "Players agree to Run It Twice",
  "*** HOLE CARDS ***",
  "Dealt to {P} [5s Ah]",
  "Dealt to {P} [Ah Kd Qs Jc]",
  "Dealt to {P} []",
  "Dealt to Ghost [5s Ah]",
  "  Dealt to {P} [5s Ah]",
  "*** FLOP *** [Td 3d 3h] (Total Pot: $65, 3 Players)",
  "*** FLOP *** [Td 3d]",
  "*** FLOP *** [Td 3d 3h 2c]",
  "*** TURN *** [Td 3d 3h] [Qh] (Total Pot: $145, 2 Players)",
  "*** RIVER *** [Td 3d 3h Qh] [Ac]",
  "*** RIVER 1 *** [Td 3d 3h Qh] [Ac] (Total Pot: $625, 2 Players, 2 All-In)",
  "*** RIVER 2 *** [Td 3d 3h Qh] [2h]",
  "*** TURN 2 *** [Td 3d 3h] [9s]",
  "*** FLOP 3 *** [2c 2d 2h]",
  "*** RIVER 5 *** [Ac]",
  "*** RIVER 0 *** [Ac]",
  "*** FLOP 0 *** [Ac Kd Qs]",
  "*** TURN 0 *** [Ac]",
  "*** RIVER 10000 *** [2h]",
  "*** TURN 10001 *** [2h]",
  "*** RIVER 99999999999 *** [2h]",
  "*** SHOW DOWN ***",
  "*** SHOW DOWN 1 ***",
  "*** SHOW DOWN 2 ***",
  "*** SHOW DOWN 0 ***",
  "*** SHOWDOWN 00 ***",
  "*** show down ***",
  "*** SHOW DOWN 99999999999 ***",
  "*** SUMMARY ***",
  "*** SUMMARY 1 ***",
  "*** SUMMARY 2 ***",
  "*** SUMMARY 0 ***",
  "*** SUMMARY 3 ***",
  "*** SUMMARY 99999999999 ***",
  "Total pot $625 | Rake $3",
  "Total pot $18.50 | Rake $0.90",
  "Total pot $1,000.50",
  "Total pot $1 | Rake $0",
  "Total pot x",
  "Pot 1 $311",
  "Pot 2 $311",
  "Board: [Td 3d 3h Qh Ac]",
  "Board [2c 3d 4h]",
  "Board: []",
  "board: [Td 3d 3h Qh 2h]",
  "Seat 1: {P} (small blind) folded before the Flop",
  "Seat 2: {P} didn't bet (folded)",
  "Seat 3: {P} (button) folded on the Turn",
  "Seat 4: {P} (big blind) showed [Jd Qd] and lost with two pair, Queens and Threes",
  "Seat 4: {P} showed [Jd Qd] and won ($311) with two pair",
  "Seat 4: {P} collected ($17.60), mucked",
  "Seat 5: {P} is sitting out",
  "Seat 6: {P} mucked [Ah Kd]",
  "Seat 7: Ghost showed [Ah Kd] and won ($5)",
  "Seat 99999999999: {P} folded before the Flop",
  "Seat 9: Late ($5)",
  "Seat 9: Late ($5), is sitting out",
  "Seat 1: {P} ($5)",
  "Seat 3: oggie the fox ($10.05)",
  "Seat 007: Padded ($1)",
  "Seat 99999999999: Far ($5)",
  "Seat 99999999999999999999: Farther ($5)",
  "Seat 4294967295: Edge ($5)",
  "Seat 4294967296: Over ($5)",
  "The button is in seat #2",
  "The button is in seat #9",
  "The button is in seat #99999999999",
  "Hand #1 has been canceled",
  "Hand #1 has been cancelled",
  "something nobody writes",
  "",
];

const FT_HEADERS = [
  "Full Tilt Poker Game #{ID}: Table Goldring (heads up) - NL Hold'em - $5/$10 - 21:11:15 ET - 2014/01/05",
  "Full Tilt Poker Game #{ID}: Table Bri (6 max) - $0.25/$0.50 - $15 Cap No Limit Hold'em - 18:46:08 ET - 2011/02/28",
  "Full Tilt Poker Game #{ID}: Table Kid (6 max) - NL Hold'em - $2/$4 - 12:52:55 CET - 2013/01/01 [12:52:55 ET - 2013/01/01]",
  "Full Tilt Poker Game #{ID}: Table Vernon - PL Omaha H/L - $0.50/$1 - 15:45:47 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table Dickson (6 max) - FL Omaha H/L - $0.50/$1 - 20:31:38 ET - 2014/01/05",
  "Full Tilt Poker Game #{ID}: Table X (6 max) - PL Omaha Hi - $0.50/$1 - 20:31:38 ET - 2014/01/05",
  "Full Tilt Poker Game #{ID}: Table X (6 max) - PL Omaha - $0.50/$1 - 20:31:38 ET - 2014/01/05",
  "Full Tilt Poker Game #{ID}: Table Narit (6 max) - FL Hold'em - $0.05/$0.10 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - Limit Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - Pot Limit Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - $1/$2 - Fixed Limit Hold'em - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - PL 5 Card Omaha - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - Razz - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - 7 Card Stud Hi/Lo - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - Stud H/L - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - Short Deck Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - 6+ Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - 25/50 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - \u20ac0.50/\u20ac1 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - \u00a30.50/\u00a31 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - \u20b91/\u20b92 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - \u00a51/\u00a52 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table \u20a9on - NL Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - $1/$2 Ante $0.25 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - $1,000/$2,000 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - $99999999999999999999/$1 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X (9 max) - NL Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X (99999999999 max) - NL Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X (0 max) - NL Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X (6 max, shallow) - NL Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X () - NL Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X (heads up, deep) - NL Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X (deep) - NL Hold'em - $1/$2 - 08:01:08 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - $1/$2 - 1:02:03 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - $1/$2 - 24:00:00 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - $1/$2 - 25:61:61 ET - 2014/13/40",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - $1/$2 - 10:00:00 ET - 2014/02/30",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - $1/$2 - 10:00:00 ET - 2014/01/06 x",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - $1/$2 - 10:00:00 - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X -  - $1/$2 - 10:00:00 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - $1-$2 - 10:00:00 ET - 2014/01/06",
  "Full Tilt Poker Game #{ID}: $10 + $1 Sit & Go (123456), Table 1 - 15/30 - No Limit Hold'em - 20:00:00 ET - 2010/01/01",
  "Full Tilt Poker Game #{ID}: Tournament 1, Table 2 - NL Hold'em - 15/30 - 20:00:00 ET - 2010/01/01",
  "Full Tilt Poker Game #{ID}: Match #5 - NL Hold'em",
  "Full Tilt Poker Game #{ID}: garbage",
  "Full Tilt Poker Game #{ID}:",
  "Full Tilt Poker Game #{ID}: Table X - NL Hold'em - $1/$2 - 10:00:00 ET - 2014/01/06\u2028more",
];

const RIO_LINES = [
  "{P}: folds",
  "{P}: checks",
  "{P}: calls \u20ac0.10",
  "{P}: calls 30",
  "{P}: bets \u20ac0.21",
  "{P}: bets \u20ac5 and is all-in",
  "{P}: raises \u20ac0.20 to \u20ac0.30",
  "{P}: raises 20 to 40 and is all-in",
  "{P}: posts small blind \u20ac0.05",
  "{P}: posts big blind \u20ac0.10",
  "{P}: posts small blind 10",
  "{P}: posts the ante \u20ac0.01",
  "{P}: posts \u20ac0.10",
  "Ghost: posts big blind \u20ac0.10",
  "{P}: mucks hand",
  "{P}: doesn't show hand",
  "{P} shows [Kd 5d] (a pair of Fives)",
  "{P}: shows [Kd 5d]",
  "{P} shows [Kd 5d] for a pair",
  "Ghost: shows [Kd 5d]",
  "STP added: \u20ac0.50",
  "STP added: \u20ac5.00",
  "Uncalled bet (\u20ac0.71) returned to {P}",
  "Uncalled bet (\u20ac0.21) returned to {P}",
  "Uncalled bet (80) returned to {P}",
  "Uncalled bet (\u20ac0.71) returned to Ghost",
  "{P} collected \u20ac0.71 from pot",
  "{P} collected \u20ac0.71 from side pot 1",
  "{P} collected 120 from the main pot",
  "{Q} collected 40 from pot",
  "Ghost collected \u20ac1 from pot",
  "Dealt to {P} [6s 8h]",
  "Dealt to {P}",
  "Dealt to Ghost [6s 8h]",
  "*** HOLE CARDS ***",
  "*** FLOP *** [6h Jd 4c]",
  "*** TURN *** [6h Jd 4c] [9h]",
  "*** RIVER *** [6h Jd 4c 9h] [2c]",
  "*** FIRST FLOP *** [6h Jd 4c]",
  "*** SECOND RIVER *** [6h Jd 4c 9h] [3d]",
  "*** SHOWDOWN ***",
  "*** SHOW DOWN ***",
  "*** SUMMARY ***",
  "Total pot \u20ac0.75 | Main pot \u20ac0.25 | STP \u20ac0.50 | Rake \u20ac0.04",
  "Total pot \u20ac0.75 | Rake \u20ac0.04",
  "Total pot 120 | Rake 0",
  "Total pot \u20ac0.75 | Main pot \u20ac0.25 | Side pot-1 \u20ac0.10 | Rake \u20ac0.04",
  "Total pot \u20ac0.75 | STP \u20ac1.00",
  "Board [6h Jd 4c]",
  "FIRST Board [6h Jd 4c 9h 2c]",
  "Seat 5: {P} folded before Flop",
  "Seat 3: {P} (big blind) mucked hand and won \u20ac0.71",
  "Seat 1: {P} (button) showed [Ah Kd] and lost with high card",
  "Seat 9: Ghost won \u20ac1",
  "Table ID '30263259' 6-Max Seat #1 is the button",
  "Table ID '1' 6-Max Seat #9 is the button",
  "Table '1' 3-max",
  "Table ID '1' 99999999999-Max Seat #99999999999 is the button",
  "Table ID '' 6-Max",
  "Seat 9: Late (\u20ac5 in chips)",
  "Seat 9: Late (\u20ac5 in chips) is sitting out",
  "Seat 3: Doc (500 in chips) [hero]",
  "Seat 2: {P} (\u20ac14.07 in chips) [hero]",
  "Seat 007: Padded (\u20ac1 in chips)",
  "Seat 99999999999: Far (\u20ac1 in chips)",
  '{P} said, "hi"',
  "{P} is sitting out",
  "{P}: sits out",
  "{P} has timed out",
  "{P} is disconnected",
  "{P} joins the table",
  "something nobody writes",
  "",
];

const RIO_HEADERS = [
  "Run It Once Poker Hand #{ID}:  Hold'em No Limit (\u20ac0.05/\u20ac0.10) - 2019/06/25 16:12 UTC [2019/06/25 17:12 CET]",
  "Run It Once Poker Hand #{ID}:  Hold'em No Limit ($0.05/$0.10) - 2019/06/25 16:12 UTC [2019/06/25 17:12 CET]",
  "Run It Once Poker Hand #{ID}:  Omaha Pot Limit (\u20ac0.05/\u20ac0.10) - 2019/06/25 16:12 UTC",
  "Run It Once Poker Hand #{ID}:  Omaha Hi/Lo Pot Limit (\u20ac0.05/\u20ac0.10) - 2019/06/25 16:12 UTC",
  "Run It Once Poker Hand #{ID}:  Hold'em Fixed Limit (\u20ac0.05/\u20ac0.10) - 2019/06/25 16:12 UTC",
  "Run It Once Poker Hand #{ID}:  Hold'em No Limit (0.05/0.10) - 2019/06/25 16:12 UTC",
  "Run It Once Poker Hand #{ID}:  Hold'em No Limit (\u20b91/\u20b92) - 2019/06/25 16:12 UTC",
  "Run It Once Poker Hand #{ID}:  Hold'em No Limit (\u00a51/\u00a52) - 2019/06/25 16:12 UTC",
  "Run It Once Poker Hand #{ID}:  Hold'em No Limit (Rs. 5/Rs. 10) - 2019/06/25 16:12 UTC",
  "Run It Once Poker Hand #{ID}:  Short Deck Hold'em No Limit (\u20ac1/\u20ac2) - 2019/06/25 16:12 UTC",
  "Run It Once Poker Hand #{ID}:  Hold'em No Limit (\u20ac1,000/\u20ac2,000) - 2019/06/25 16:12 UTC",
  "Run It Once Poker Hand #{ID}: Tournament #158168, \u20ac4.69+\u20ac0.31 Cub3d, Hold'em No Limit (10/20) - 2021/04/12 16:01 UTC [2021/04/12 17:01 CET]",
  "Run It Once Poker Hand #{ID}: Tournament #1, \u20ac5 , Hold'em No Limit (10/20) - 2021/04/12 16:01 UTC",
  "Run It Once Poker Hand #{ID}: Tournament #1, $0+$0 Freeroll, Hold'em No Limit (10/20) - 2021/04/12 16:01 UTC",
  "Run It Once Poker Hand #{ID}: Tournament #1, \u20ac4.50+\u20ac4.50+\u20ac1 KO, Hold'em No Limit (10/20) - 2021/04/12 16:01 UTC",
  "Run It Once Poker Hand #{ID}: Tournament #1, \u20ac4.69+\u20ac0.31 Cub3d, Omaha Pot Limit (10/20) - 2021/04/12 16:01 UTC",
  "Run It Once Poker Hand #{ID}: Tournament #1, \u20ac4.69+\u20ac0.31 Cub3d, Hold'em No Limit (\u20ac10/\u20ac20) - 2021/04/12 16:01 UTC",
  "Run It Once Poker Hand #{ID}: Tournament #1, 5 Cub3d, Hold'em No Limit (10/20) - 2021/04/12 16:01 UTC",
  "Run It Once Poker Hand #{ID}: Tournament #1, \u20b95 Cub3d, Hold'em No Limit (\u20b910/\u20b920) - 2021/04/12 16:01 UTC",
  "Run It Once Poker Hand #{ID}: Tournament #1, x, y",
  "Run It Once Poker Hand #{ID}:  Hold'em No Limit (\u20ac0.05/\u20ac0.10) - 2019/06/25 4:12:33 UTC",
  "Run It Once Poker Hand #{ID}:  Hold'em No Limit (\u20ac0.05/\u20ac0.10) - 2019/13/40 25:61 UTC",
  "Run It Once Poker Hand #{ID}:  Hold'em No Limit (\u20ac0.05/\u20ac0.10) - 2019/06/25 16:12 CET",
  "Run It Once Poker Hand #{ID}:  Hold'em No Limit (\u20ac0.05) - 2019/06/25 16:12 UTC",
  "Run It Once Poker Hand #{ID}:  garbage",
  "Run It Once Poker Hand #{ID}:",
  "Run It Once Poker Tournament #{ID}, Cubed SNG",
];

const SEAT_NAME = /^Seat\s+\d+:\s+(.+?)\s+\(/;

function seatNames(lines) {
  const names = [];
  for (const line of lines) {
    const m = line.trim().match(SEAT_NAME);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function fill(template, names, id) {
  return template
    .replaceAll("{P}", names[below(Math.max(1, names.length))] ?? names[0] ?? "Hero")
    .replaceAll("{Q}", names[1] ?? names[0] ?? "Villain")
    .replaceAll("{ID}", id);
}

const AMOUNTS = [
  "0",
  "1",
  "2.5",
  "0.05",
  "10",
  "100.00",
  "0.10",
  "7.5",
  "0.005",
  "2.505",
  "1,000",
  "1,000.50",
  "0,25",
  "1.2.3",
  "2522.50",
  "99999999999999999999",
];

function dialectOf(site) {
  return site === "fulltilt"
    ? { lines: FT_LINES, headers: FT_HEADERS }
    : { lines: RIO_LINES, headers: RIO_HEADERS };
}

/** One random edit of `lines`, as an op (with its text already final). */
function randomOp(lines, names, id, dialect) {
  const at = 1 + below(Math.max(1, lines.length - 1));
  switch (below(14)) {
    case 0:
    case 1:
      return ["delete", at];
    case 2:
      return ["insert", at, lines[at] ?? ""];
    case 3:
      return ["swap", at];
    case 4: {
      const line = lines[at] ?? "";
      const numbers = [...line.matchAll(/\d[\d,]*(?:\.\d+)?/g)];
      if (numbers.length === 0) return ["delete", at];
      const n = pick(numbers);
      const replaced = line.slice(0, n.index) + pick(AMOUNTS) + line.slice(n.index + n[0].length);
      return ["replace", at, replaced];
    }
    case 5:
    case 6:
    case 7:
      return ["insert", at, fill(pick(dialect.lines), names, id)];
    case 8:
      return ["replace", 0, fill(pick(dialect.headers), names, id)];
    case 9: {
      const summary = lines.findIndex((line) => /^\*+\s*SUMMARY/i.test(line.trim()));
      return summary > 0 ? ["truncate", summary + below(3)] : ["truncate", at];
    }
    case 10:
      return ["replace", at, `${lines[at] ?? ""} `];
    case 11:
      return ["replace", at, `  ${lines[at] ?? ""}`];
    case 12: {
      // A seat renamed on one line: a name the stream no longer knows.
      const line = lines[at] ?? "";
      const name = pick(names.length > 0 ? names : ["Hero"]);
      return ["replace", at, line.replaceAll(name, pick(["Ghost", `${name} 2`, name.toUpperCase(), ""]))];
    }
    default:
      return ["replace", at, fill(pick(dialect.lines), names, id)];
  }
}

function apply(chunk, ops) {
  let lines = chunk.split("\n");
  let sep = "\n";
  let prefix = "";
  let misreadBom = null;
  for (const op of ops) {
    const [kind, a, b] = op;
    if (kind === "delete") lines.splice(a, 1);
    else if (kind === "insert") lines.splice(a, 0, b);
    else if (kind === "replace") lines[a] = b;
    else if (kind === "swap") {
      if (a + 1 < lines.length) [lines[a], lines[a + 1]] = [lines[a + 1], lines[a]];
    } else if (kind === "truncate") lines = lines.slice(0, a);
    else if (kind === "join") sep = a;
    else if (kind === "prefix") prefix = a;
    else if (kind === "misread") misreadBom = a;
  }
  const text = prefix + lines.join(sep);
  return misreadBom === null ? text : misread(text, misreadBom);
}

/* ---------------------------------------------------------- the cases --- */

const splits = [];
const SPLIT_TEXTS = [
  "",
  " ",
  "hello",
  "Full Tilt Poker Game #1: x",
  "Full Tilt Poker Game #1: x\nFull Tilt Poker Game #2: y\rFull Tilt Poker Game #3: z\u2028Full Tilt Poker Game #4: w",
  "  Full Tilt Poker Game #1: x\n\n\nFull Tilt Poker Game #2:y\nFull Tilt Poker Game #3 z",
  "\ufeffFull Tilt Poker Game #1: a\n\ufeffFull Tilt Poker Game #2: b",
  "\ufeff\ufeffFull Tilt Poker Game #1: a",
  "x Full Tilt Poker Game #1: a\nFull Tilt Poker Game #: b\nFull Tilt Poker Game #12:",
  misread("Full Tilt Poker Game #1: Table X - NL Hold'em - $1/$2 - 10:00:00 ET - 2014/01/06\nFull Tilt Poker Game #2: x", true),
  "Run It Once Poker Hand #1: x\nRun It Once Poker Hand #2: y\rRun It Once Poker Hand #3: z\u2029Run It Once Poker Tournament #4",
  "Run It Once Poker Tournament #1, Cubed SNG\nBuy-In: \u20ac5.00",
  "\ufeffRun It Once Poker Hand #1: a\n\ufeffRun It Once Poker Hand #2: b",
  "x Run It Once Poker Hand #1: a\nRun It Once Poker Hand #: b\nRun It Once Poker Hand #12:",
  misread("Run It Once Poker Hand #1:  Hold'em No Limit (\u20ac0.05/\u20ac0.10) - 2019/06/25 16:12 UTC\nRun It Once Poker Hand #2: x", false),
  "Full Tilt Poker Game #1: a\nRun It Once Poker Hand #2: b\nPokerStars Hand #3: c",
];
for (const text of SPLIT_TEXTS) {
  const entry = { text };
  for (const id of IDS) entry[id] = short(JSON.stringify(PARSERS[id].splitHands(text)));
  splits.push(entry);
}

const DETECT_TEXTS = [
  "",
  "hello",
  "Full Tilt Poker Game #1:",
  "Full Tilt Poker Game #1",
  " Full Tilt Poker Game #1:",
  "x\nFull Tilt Poker Game #1:",
  "x\rFull Tilt Poker Game #1:",
  "x\u2028Full Tilt Poker Game #1:",
  "\ufeffFull Tilt Poker Game #1:",
  "\ufeff\ufeffFull Tilt Poker Game #1:",
  "posted on Full Tilt Poker in 2011",
  "Full Tilt Pokers",
  "FullTilt Poker",
  "Run It Once Poker Hand #1",
  "Run It Once Poker Tournament #1",
  "Run It Once Poker Hand #",
  "x\u2029Run It Once Poker Hand #1",
  "\ufeffRun It Once Poker Tournament #9",
  " Run It Once Poker Hand #1",
  "Run It Once Poker closed in 2022",
  "Run It Once Pokers",
  "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
  "PokerBros Hand #1: Hold'em No Limit ($0.5/$1 USD)",
  misread("Full Tilt Poker Game #1: Table X", true),
  misread("Run It Once Poker Hand #1: x", false),
];
const detect = DETECT_TEXTS.map((text) => {
  const entry = { text };
  for (const id of IDS) entry[id] = permille(PARSERS[id], text);
  return entry;
});

for (const file of files) {
  if (file.text === null) continue;
  const entry = { file: file.input };
  for (const id of IDS) entry[id] = short(JSON.stringify(PARSERS[id].splitHands(file.text)));
  splits.push(entry);
}

const cases = [];
const forced = new Set();
function record(base, ops, text) {
  const entry = { ...base, ops, detect: {}, outcomes: {} };
  for (const id of IDS) {
    entry.detect[id] = permille(PARSERS[id], text);
    entry.outcomes[id] = outcome(() => PARSERS[id].parseHand(text, CTX));
    const cash = outcome(() => PARSERS[id].parseHand(text, CASH_ONLY));
    if (JSON.stringify(cash) !== JSON.stringify(entry.outcomes[id])) {
      entry.cashOnly ??= {};
      entry.cashOnly[id] = cash;
    }
  }
  cases.push(entry);
}

for (const file of files) {
  if (file.text === null || !IDS.includes(file.top)) continue;
  const site = file.top;
  const chunks = PARSERS[site].splitHands(file.text);
  chunks.forEach((chunk, index) => {
    const lines = chunk.split("\n");
    const names = seatNames(lines);
    const id = (chunk.match(/(?:Game|Hand) #(\d+)/) ?? [])[1] ?? "1";
    const dialect = dialectOf(site);
    const base = { file: file.input, split: site, chunk: index };
    record(base, [], chunk);
    if (!forced.has(site)) {
      // Targeted, once per room: no seat at all, and the chunk misread.
      forced.add(site);
      record(base, [["truncate", 1]], apply(chunk, [["truncate", 1]]));
      record(base, [["misread", true]], apply(chunk, [["misread", true]]));
      record(base, [["misread", false]], apply(chunk, [["misread", false]]));
    }
    const count = (site === "fulltilt" ? 110 : 600) * (STRESS !== null ? 10 : 1);
    for (let k = 0; k < count; k += 1) {
      const ops = [];
      const edits = 1 + below(3);
      let current = lines;
      for (let e = 0; e < edits; e += 1) {
        const op = randomOp(current, names, id, dialect);
        ops.push(op);
        current = apply(current.join("\n"), [op]).split("\n");
      }
      const roll = random();
      if (roll < 0.05) ops.push(["join", "\r"]);
      else if (roll < 0.1) ops.push(["join", "\r\n"]);
      else if (roll < 0.13) ops.push(["prefix", "\ufeff"]);
      else if (roll < 0.15) ops.push(["join", " "]);
      else if (roll < 0.17) ops.push(["join", "\u2028"]);
      if (random() < 0.04) ops.push(["misread", random() < 0.5]);
      record(base, ops, apply(chunk, ops));
    }
  });
}

/* ------------------------------------------------- re-encoded files --- */

/** Windows-1252 bytes of `text` (`?` for what it cannot hold). */
const CP1252_HIGH =
  "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";
function cp1252(text) {
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const high = CP1252_HIGH.indexOf(ch);
    if (high >= 0) out.push(0x80 + high);
    else if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out.push(code);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}
const utf16le = (text) => Buffer.from(text, "utf16le");
const utf16be = (text) => {
  const le = utf16le(text);
  for (let i = 0; i + 1 < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]];
  return le;
};

const TRANSFORMS = {
  "utf16le-bom": (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(text)]),
  "utf16le": (text) => utf16le(text),
  "utf16be-bom": (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(text)]),
  "cp1252": (text) => cp1252(text),
  "utf8-crlf": (text) => Buffer.from(text.replaceAll("\n", "\r\n"), "utf8"),
  "utf8-bom": (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]),
};

const encoded = [];
for (const file of files) {
  if (file.text === null || !IDS.includes(file.top)) continue;
  const text = file.text.replace(/^\ufeff/, "");
  for (const [transform, encode] of Object.entries(TRANSFORMS)) {
    const bytes = encode(text);
    const decoded = decodeSource(arrayBuffer(bytes));
    const entry = { file: file.input, transform, encoding: decoded.encoding, problem: decoded.problem ?? null };
    if (!decoded.problem) {
      entry.detected = detectSite(decoded.text).map((c) => [c.parser.id, Math.round(c.confidence * 1000)]);
      const result = await convertAny(decoded.text, { sourceFilename: basename(file.input), validate: true });
      entry.hands = result.hands.map((hand) => handHash({ ...hand, meta: { ...hand.meta, parsedAt: PARSED_AT } }));
      entry.failures = result.failures.map((f) => [f.reason, f.message]);
    }
    encoded.push(entry);
  }
}

const out = { splits, detect, cases, files: encoded };
const target = process.env.P3_OUT ?? fileURLToPath(new URL("./p3-vectors.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(out, null, 0)}\n`);
const tally = {};
for (const c of cases) {
  for (const id of IDS) {
    const o = c.outcomes[id];
    if (id !== c.split && !o.hand) continue;
    const key = `${id}:${o.hand ? "hand" : o.skip ? o.skip[0] : `error ${o.error.slice(0, 40)}`}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
}
console.log(
  `${target}: ${splits.length} splits, ${detect.length} detections, ${cases.length} cases, ` +
    `${encoded.length} re-encoded files\n${JSON.stringify(tally, null, 1)}`,
);
