// Writes p5-vectors.json: what the TypeScript ACR / WPN and Ignition parsers
// (`web/src/lib/parsers/{acrwpn,ignition}.ts`) and their shared builder
// (`shared/p5-handdraft.ts`) make of texts and drafts the corpus does not
// have, for `rail_core::parsers` to replay (docs/RAIL-PLAN.md R0.10b).
//
//     cd tests && npm ci                 (esbuild)
//     node core/rail-core/tests/data/p5-vectors.mjs
//
// The goldens pin the 132 corpus files of these rooms through the pipeline.
// This file adds, by seeded mutation, the branches the corpus leaves alone:
//
//  - `splits`: per corpus file (all of `testdata/golden/`, decoded with the
//    app's `decodeSource`) the 16-hex sha-256 of `JSON.stringify` of both
//    parsers' `splitHands`, plus hand-written split edge cases (UTF-16LE
//    text read as UTF-8 among them).
//  - `detect`: both parsers' per-mille scores of hand-written probes.
//  - `cases`: a chunk of a corpus file (`file`, the parser whose split cut it,
//    the chunk index) with a list of line edits applied; `wpnDialect` of the
//    result, both parsers' detection score and `parseHand` outcome - the
//    refusal's reason and message, the message of anything else thrown, or
//    the 16-hex sha-256 of the canonical JSON of the hand (`parsedAt`
//    pinned) - and, where it differs, the outcome with `cashOnly`.
//  - `drafts`: seeded random `P5Draft`s (every number written as `String(n)`,
//    the `Map`s as arrays of pairs) through `p5DraftToStandardText` (the
//    text's hash, or the refusal) and `p5BuildHand` (as `cases`) - the
//    builder's branches neither room reaches (`chip-mismatch` against a
//    stated pot, mucks with cards, straddles, dead money on any kind, a turn
//    without a flop, duplicated seats).
//  - `files`: corpus files of these rooms re-encoded (UTF-16 LE with and
//    without a BOM, UTF-16 BE, Windows-1252, CRLF, UTF-8 with a BOM) and run
//    through the converter's own path (`decodeSource`, `convertAny(text, {
//    sourceFilename, validate: true })`): encoding, ranking, every hand's
//    hash and every refusal.
//
// Edits are those of `p6-vectors.mjs` (`delete`, `insert`, `replace`,
// `swap`, `truncate`, `join`, `prefix`; `{P}`/`{Q}`/`{ID}` substituted here)
// plus `misread`: the edited text as UTF-16LE bytes (after a BOM when the op
// says so) read back as UTF-8, the way `p5RecoverEncoding` finds it.
//
// Bundles the TypeScript with esbuild from tests/node_modules. Deterministic
// (seeded), so rerunning it rewrites the same file as long as the corpus and
// the TypeScript are the same. `P5_STRESS=<seed>` draws many more cases from
// another seed for a local soak run (the committed file is the default);
// `P5_OUT=<path>` writes it elsewhere, and `P5_VECTORS=<path>` points
// `tests/p5_vectors.rs` at it.

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
      export { acrwpnParser, ignitionParser, convertAny, detectSite }
        from "./web/src/lib/parsers/index.ts";
      export { wpnDialect } from "./web/src/lib/parsers/acrwpn.ts";
      export { p5BuildHand, p5DraftToStandardText }
        from "./web/src/lib/parsers/shared/p5-handdraft.ts";
      export { ParseSkip } from "./web/src/lib/phf/detect.ts";
      export { USD, EUR, CHIPS } from "./web/src/lib/phf/types.ts";
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
  acrwpnParser,
  ignitionParser,
  convertAny,
  detectSite,
  wpnDialect,
  p5BuildHand,
  p5DraftToStandardText,
  ParseSkip,
  USD,
  EUR,
  CHIPS,
  decodeSource,
  canonicalJson,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const PARSED_AT = "1970-01-01T00:00:00.000Z";
const PARSERS = { acrwpn: acrwpnParser, ignition: ignitionParser };
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

/** UTF-16LE bytes read as UTF-8: what `p5RecoverEncoding` repairs. */
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
const STRESS = process.env.P5_STRESS ? Number(process.env.P5_STRESS) : null;
const random = mulberry32(STRESS ?? 0x5ac0b0);
const pick = (list) => list[Math.floor(random() * list.length)];
const below = (n) => Math.floor(random() * n);

/* --------------------------------------------------------- the edits --- */

const LEGACY_LINES = [
  "Player {P} folds",
  "Player {P} checks",
  "Player {P} calls (0.10)",
  "Player {P} calls (24)",
  "Player {P} bets (0.25)",
  "Player {P} raises (0.40)",
  "Player {P} raises (10)",
  "Player {P} caps (1.00)",
  "Player {P} allin (5.00)",
  "Player {P} allin (124)",
  "Player {P} allin",
  "Player {P} ALLIN",
  "Player {P} straddle (0.20)",
  "Player {P} posts (0.10)",
  "Player {P} posts (0.05) as a dead bet",
  "Player {P} posts ante (0.01)",
  "Player {P} ante (1)",
  "Player {P} bring in (0.05)",
  "Player {P} has small blind (0.05)",
  "Player {P} has big blind (0.10)",
  "Player {P} has big blind (4)",
  "Player {P} HAS SMALL BLIND (2)",
  "Player {P} received a card.",
  "Player {P} received card: [10h]",
  "Player {P} received card: [Ah Kd]",
  "Player {P} received card: [Ah Kd Qs Jc]",
  "Player {P} is timed out.",
  "Player {P} sitting out",
  "Player {P} wait BB",
  "Player {P} is disconnected and ALL IN",
  "Player {P} mucks cards",
  "Player {P} stands up",
  "Player {P} does something odd",
  "Player  folds",
  "Player  calls (0.10)",
  "Player Ghost folds",
  "Player Ghost raises (1)",
  "Uncalled bet (0.25) returned to {P}",
  "Uncalled bet (0.25) returned to Ghost",
  "Uncalled bet (1,000.25) returned to {P}",
  "*** FLOP ***: [9h 10d 7c]",
  "*** FLOP ***: [2c 3d]",
  "*** FLOP ***: []",
  "*** TURN ***: [9h 10d 7c] [Ah]",
  "*** RIVER ***: [9h 10d 7c Ah] [3s]",
  "*** flop *** [Jc Qd Ks]",
  "Game ended at: 2014/3/8 22:0:57",
  "Game ID: 999 1/2 Other (Hold'em)",
  "Seat 5 is the button",
  "Seat 9 is the button",
  "Seat 9: Late (5.00)",
  "Seat 1: {P} (5.00).",
  "Seat 3: Sean LeBlanc (12.34)",
  "Seat 007: Padded (1)",
  "Seat 2: 12345 (5)",
  "Seat 4:  (5)",
  "Seat 99999999999: Far (5)",
  "------ Summary ------",
  "Pot: 0.50. Rake 0.02",
  "Pot: 0.50",
  "Pot: 7.73. Rake 0.41. JP fee 0.25",
  "Pot: 319. Rake 1",
  "Pot: 1,000.50. Rake 0.02",
  "Pot: x",
  "Board: [9h 10d 7c Ah 3s]",
  "Board: [2c 3d 4h]",
  "Board: []",
  "*Player {P} shows: Straight to 10 [3c 6h 7d 8c]. Bets: 160. Collects: 319. Wins: 159.",
  "*Player {P} shows: Two pair [Ah Kd]. Bets: 0.25. Collects: 0.48. Wins: 0.23.",
  "Player {P} shows: One pair of Ks [Qh Kc]. Bets: 0.25. Collects: 0. Loses: 0.25.",
  "Player {P} shows: . Bets: 0.25. Collects: 0.",
  "Player {P} does not show cards.Bets: 0.10. Collects: 0. Loses: 0.10.",
  "Player {P} mucks (does not show cards). Bets: 0.25. Collects: 0. Loses: 0.25.",
  "Player {P} [Ah Kd]. Bets: 0. Collects: 0.",
  "Player {P} Bets: 1,000.50. Collects: 0.",
  "Player {P} Bets: 0. Collects: 0.50. Wins: 0.50.",
  "Player Ghost does not show cards.Bets: 0. Collects: 0.",
  "Player Ghost does not show cards.Bets: 0.10. Collects: 0.",
  "*Player {Q} shows: High card [2c 7d]. Bets: 0.10. Collects: 0.20. Wins: 0.10.",
  "something nobody writes",
  "",
];

const LEGACY_STARTED = [
  "Game started at: 2014/3/9 19:37:22",
  "Game started at: 2014/12/31 23:59:59",
  "Game started at: 2014/13/40 25:61:61",
  "Game started at: 0014/1/1 0:0:0",
  "Game started at: 2014/3/9",
  "Game started at:2014/3/9 1:2:3 ",
];

const LEGACY_IDS = [
  "Game ID: {ID} 0.05/0.10 Magnetite   (JP) - 5 (Hold'em)",
  "Game ID: {ID} 0.05/0.10 PMS_27056799 (Hold'em) 8-max",
  "Game ID: {ID} 2/4 Braunite (Omaha)",
  "Game ID: {ID} 2/4 Braunite (Omaha HiLow)",
  "Game ID: {ID} 0.02/0.05 6+ (PRR) ($5 Max) (Six Plus Hold'em)",
  "Game ID: {ID} 1/2 Table (Seven Card Stud)",
  "Game ID: {ID} 1/2 Table (5 Card Omaha)",
  "Game ID: {ID} 10/20 $5 Regular 9-Max, Table 1 (Hold'em)",
  "Game ID: {ID} 10/20 Turbo (6-max) (Hold'em)",
  "Game ID: {ID} 0.05/0.10 (Hold'em)",
  "Game ID: {ID} 0.05/0.10 Table",
  "Game ID: {ID} 0,05/0,10 T (Hold'em)",
  "Game ID: {ID} 99999999999999999999/1 T (Hold'em)",
  "Game ID: {ID} 0.05/0.10 T (Hold'em) 99999999999-max",
  "Game ID: {ID}",
];

const MODERN_LINES = [
  "{P} folds",
  "{P} checks",
  "{P} calls $0.03",
  "{P} calls $1,000.50",
  "{P} bets $0.10",
  "{P} bets $5.00 and is all-in",
  "{P} raises $0.10 to $0.15",
  "{P} raises $0.20 to $0.25 and is all-in",
  "{P} raises $1 to $0.50",
  "{P} caps $0.40",
  "{P} posts the small blind $0.02",
  "{P} posts the big blind $0.05",
  "{P} posts the big blind $0.05 and is all-in",
  "{P} posts dead $0.07",
  "{P} posts $0.05",
  "{P} posts ante $0.01",
  "{P} collected $0.17 from main pot",
  "{P} collected $0.17 from side pot 1",
  "{P} collected $0.17 from pot",
  "{Q} collected $0.10 from main pot",
  "{P} shows [Ac 6c] (two pair, Eights and Threes [8d 8c 3s 3c Ac])",
  "{P} shows [Ac 6c]",
  "{P} shows [Ac]",
  "{P} shows [] ()",
  "{P} shows [Ah Kd Qs Jc] (high card)",
  "{P} does not show",
  "{P} mucks",
  "{P} mucks hand",
  "{P} is sitting out",
  '{P} said, "hi"',
  "{P} has timed out",
  "{P} does something odd",
  "Dealt to {P} [As 6h]",
  "Dealt to {P} [Ts 9d 8c 7h]",
  "Dealt to Ghost [As 6h]",
  "Uncalled bet ($0.05) returned to {P}",
  "Uncalled bet ($0.05) returned to Ghost",
  "*** HOLE CARDS ***",
  "*** FLOP *** [5s 3s 3c]",
  "*** FLOP *** [5s 3s]",
  "*** TURN *** [5s 3s 3c] [8d]",
  "*** RIVER *** [5s 3s 3c 8d] [8c]",
  "*** SHOW DOWN ***",
  "*** SUMMARY ***",
  "*** RUN IT TWICE ***",
  "Main pot $0.17 | Rake $0.00",
  "Side pot $0.17 | Rake $0.00",
  "Total pot $0.17",
  "Total pot $0.17 | Rake $0.01",
  "Total pot $7.73 | Rake $0.41 | JP Fee $0.25",
  "Total pot $1,000.17 | Rake $0.01",
  "Board [5s 3s 3c 8d 8c]",
  "Seat 1: {P} folded on the Pre-Flop and did not bet",
  "Seat 2: {P} showed [Ac 6c] and won $0.17 with two pair",
  "Seat 2: {P} won $0.17",
  "Seat 2: {P} (button) showed [7d 8h] and lost",
  "Seat 3: Ghost won $1.00",
  "Seat 9: Late ($5.00)",
  "Seat 9: Late ($5.00) is sitting out",
  "Seat 1: {P} ($5.00)",
  "Seat 3: Sean LeBlanc ($12.34)",
  "Seat 007: Padded ($1)",
  "Seat 99999999999: Far ($1)",
  "something nobody writes",
  "",
];

const MODERN_HEADERS = [
  "Hand #{ID} - Holdem(No Limit) - $0.02/$0.05 - 2021/04/20 18:42:26 UTC",
  "Game Hand #{ID} - Holdem(No Limit) - $0.02/$0.05 - 2021/04/20 18:42:26 UTC",
  "Hand #{ID} - Omaha(Pot Limit) - $0.02/$0.05 - 2021/04/20 18:42:26 UTC",
  "Hand #{ID} - Omaha H/L(Fixed Limit) - $0.02/$0.05 - 2021/04/20 18:42:26 UTC",
  "Hand #{ID} - Holdem(Fixed Limit) - $0.02/$0.05 - 2021/04/20 18:42:26 UTC",
  "Hand #{ID} - 6+ Holdem(No Limit) - $0.02/$0.05 - 2021/04/20 18:42:26 UTC",
  "Hand #{ID} - 7Stud(Fixed Limit) - $0.02/$0.05 - 2021/04/20 18:42:26 UTC",
  "Hand #{ID} - Turbo Tournament #123 - Holdem(No Limit) - Level 3 (25/50) - 2021/04/20 18:42:26 UTC",
  "Hand #{ID} - (Daily) Tournament #123 - Holdem(No Limit) - Level 3 (50) - 2021/04/20 18:42:26 UTC",
  "Hand #{ID} - Holdem(No Limit) - $0.02/$0.05 - 2021/13/40 25:61:61 UTC",
  "Hand #{ID} - Holdem(No Limit) - $0.02/$0.05 - 2021/04/20 18:42:26",
  "Hand #{ID} - Holdem(No Limit) - $1,000/$2,000 - 2021/04/20 18:42:26 UTC",
  "Hand #{ID} - garbage",
  "Hand #{ID} - Holdem - $0.02/$0.05 - 2021/04/20 18:42:26 UTC",
];

const MODERN_TABLES = [
  "Fort Lupton 9-max Seat #5 is the button",
  "Table '12' 9-max Seat #1 is the button",
  "Fort Lupton 6-max",
  "Fort Lupton 9-max Seat #99 is the button",
  "X 99999999999-max Seat #99999999999 is the button",
  "Miramar (Cap) 9-max Seat #3 is the button",
  "Table '' 6-max Seat #2 is the button",
  "no table here",
];

const IGNITION_LINES = [
  "{P} : Folds",
  "{P} : Fold",
  "{P} : Checks",
  "{P} : Calls $1.25",
  "{P} : Call 100",
  "{P} : Bets $1.50",
  "{P} : Bet 450",
  "{P} : Raises $9.25 to $9.25",
  "{P} : Raises 200",
  "{P} : Raises $1 to $0.50",
  "{P} : Raises(timeout) $2 to $3",
  "{P} : All-in(raise) $5 to $10",
  "{P} : All-in(raise) 300",
  "{P} : All-in $39",
  "{P} : All-in(timeout) $3",
  "{P} : Small Blind $0.25",
  "{P} : Big Blind $0.50",
  "{P} : Small blind 50",
  "{P} : Ante/Small blind 50",
  "{P} : Big blind/Bring in 100",
  "{P} : Ante chip 10",
  "{P} : Ante chip $0.05",
  "{P} : Posts chip $0.50",
  "{P} : Posts dead chip $0.25",
  "{P} : Posts chip $1.25",
  "{P} : Return uncalled portion of bet $0.50",
  "{P} : Card dealt to a spot [Kc Js]",
  "{P} : Card dealt to a spot [5s 2d 2h Qh]",
  "{P} : Card dealt to a spot [10s 9d]",
  "{P} : Card dealt to a spot [Kc]",
  "{P} : Showdown [Kh Kc 7h 7d Qd]",
  "{P} : Showdown [Kh Kc 7h 7d Qd] (Two pair)",
  "{P} : Showdown",
  "{P} : Showdown ()",
  "{P} : Does not show [8d Ts Kh 7d] (One pair)",
  "{P} : Does not show [8d Ts] (High card)",
  "{P} : Mucks [8d Ts]",
  "{P} : Mucks [8d Ts Kh 7d] ()",
  "{P} : Shows [Ac Kc] (One pair)",
  "{P} : Shows [Ac Kc Qc Jc Tc]",
  "{P} : Hand result $207.27",
  "{P} : Hand Result 450",
  "{P} : Hand result-Side pot $11.94",
  "{Q} : Hand result $1",
  "{P} : Leave(Auto)",
  "{P} : Seat sit out",
  "{P} : Table deposit $10",
  "{P} : Draw for dealer [7s]",
  "{P} : Something odd",
  "{P} [ME] : Folds",
  "Dealer : Set dealer [5]",
  "Dealer : Set dealer [99]",
  "Dealer : Set dealer/Bring in spot [3]",
  "Small Blind : All-in $0.10",
  "Big Blind : All-in $0.20",
  "Ghost : Folds",
  "Ghost : Calls $1",
  "Table enter user",
  "Seating Info: x",
  "Table Info: Version: 1, Type: MVS, Stakes: $0.25-$0.50, Table: 000A031E-0",
  "Table Info: Version: 1, Type: MVS, Stakes: $1-$2, Buyin: $25 + $2.50, TableType: MTT",
  "Player Info: Seat1: P1-d07e9231948e51d3174b777a4673828d, Seat2: P2-44fbd5113ff5581f5a26b0ba89c64fce",
  "*** HOLE CARDS ***",
  "*** FLOP *** [7d Kh 9h]",
  "*** FLOP *** [7d Kh]",
  "*** TURN *** [7d Kh 9h] [Qd]",
  "*** RIVER *** [7d Kh 9h Qd] [7h]",
  "Card dealt to table [5d 5h 9d]",
  "Card dealt to table [Qd]",
  "Card to the table [7h]",
  "*** SUMMARY ***",
  "Total Pot($222.21)",
  "Total Pot($1.60) | Rake ($0.08)",
  "Total Pot(450)",
  "Total Pot($1,000.60) | Rake ($0.08)",
  "Board [7d Kh 9h Qd 7h]",
  "Board [5d 5h 9d  ]",
  "Board [5d 5h]",
  "Board [5d 5h 9d Qd 7h 2c]",
  "Seat+1: Big Blind lost with [Kc Js-Kh Kc 7h 7d Qd]",
  "Seat 2: {P} HI 450 [Does not show]",
  "Seat 2: {P} HI 30 LOW 30 [Ac 2c 3d 4h-Ac 2c 3d 4h 5s]",
  "Seat 3: {P} LOW 640 [Ac 2c]",
  "Seat 3: {P} HI 99999999999999999999",
  "Seat 4: {P} Folded on the POCKET CARDS",
  "Seat 5: Nobody HI 10",
  "Seat 1: {P} ($5.00 in chips)",
  "Seat 9: UTG+5 ($5.00 in chips)",
  "Seat 9: Dealer ($5.00 in chips)",
  "Seat 8: Hero [ME] ($5.00 in chips)",
  "Seat 7: UTG+6 [ME] ($5.00 in chips)",
  "Seat 007: UTG+7 ($1 in chips)",
  "Seat 6: Small Blind (5,890 in chips)",
  "Seat 5:  \t($5 in chips)",
  "something nobody writes",
  "",
];

const IGNITION_HEADERS = [
  "Bovada Hand #{ID} TBL#23799796 HOLDEM No Limit [MVS] - 2021-03-11 22:58:57 UTC",
  "Ignition Hand #{ID}: HOLDEM No Limit - 2016-08-09 12:41:32",
  "Bovada Hand #{ID} TBL#10916521 HOLDEM Pot Limit - 2016-08-09 12:41:32",
  "Bovada Hand #{ID} TBL#10916521 HOLDEM Fixed Limit - 2016-08-09 12:41:32",
  "Bovada Hand #{ID} TBL#10916521 OMAHA Pot Limit - 2012-04-09 12:41:32",
  "Bovada Hand #{ID} TBL#10916521 OMAHA HiLo Pot Limit - 2012-04-09 12:41:32",
  "Bovada Hand #{ID} TBL#10916521 7CARD Fixed Limit - 2012-04-09 12:41:32",
  "Bovada Hand #{ID} TBL#10916521 7CARD HiLo Fixed Limit - 2012-04-09 12:41:32",
  "Bovada Hand #{ID} TBL#10916521 NCARD No Limit - 2012-04-09 12:41:32",
  "Bovada Hand #{ID} Zone Poker ID#1232 HOLDEMZonePoker No Limit - 2021-03-11 22:58:57",
  "Bodog.com Hand #{ID} TBL#1 HOLDEM No Limit - 2021-03-11 22:58:57",
  "Bodog UK Hand #{ID} TBL#1 HOLDEM No Limit - 2012-13-40 25:61:61",
  "Bovada Hand #{ID}: OMAHA HiLo Tournament #1909784 TBL#19, Pot Limit- Level 5 (50/100) - 2012-07-23 20:53:32",
  "Bovada Hand #{ID}: HOLDEM Tournament #1909784 TBL#19, Turbo- Level 5 (50/100) - 2012-07-23 20:53:32",
  "Ignition Hand #{ID}: HOLDEM Tournament #1909784 TBL#19, Normal- Level 5 (50) - 2021-03-11 22:58:57 UTC",
  "Bovada Hand #{ID}: HOLDEM Tournament #1909784 TBL#19, No Limit- Level 5 (1,000/2,000) [MVS] - 2021-03-11 22:58:57 UTC",
  "Bovada Hand #{ID} TBL#10916521 HOLDEM No Limit",
  "Bovada Hand #{ID} garbage",
  "Bovada Hand #{ID} TBL#1 RAZZ - 2012-04-09 12:41:32",
  "Bovada Hand # TBL#1 HOLDEM",
  "Bodag Hand #{ID} TBL#1 HOLDEM No Limit - 2012-04-09 12:41:32",
];

const SEAT_NAME = /^Seat\s+\d+:\s+(.+?)\s*(?:\[ME\])?\s*\(/;

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

function dialectOf(site, firstLine) {
  if (site === "ignition") {
    return { lines: IGNITION_LINES, headers: [[0, IGNITION_HEADERS]] };
  }
  if (/^Game started at:/.test(firstLine.trim())) {
    return { lines: LEGACY_LINES, headers: [[0, LEGACY_STARTED], [1, LEGACY_IDS]] };
  }
  return { lines: MODERN_LINES, headers: [[0, MODERN_HEADERS], [1, MODERN_TABLES]] };
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
    case 8: {
      const [index, choices] = pick(dialect.headers);
      return ["replace", index, fill(pick(choices), names, id)];
    }
    case 9: {
      const summary = lines.findIndex((line) => /^(?:\*+\s*SUMMARY|-+\s*Summary)/i.test(line.trim()));
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
  "Game started at: 2014/3/9 19:37:22",
  "Game started at: x\nGame started at: 2014/3/9 1:2:3\nGame ID: 1 1/2 T (Hold'em)",
  "Hand #1 - x\nGame Hand #2 - y\rHand #3 - z\u2028Game started at: 2014/3/9 1:2:3",
  "  Hand #1 - x\n\nHand #2 -  y\nHand #3 -y",
  "\uFEFFHand #1 - a\n\uFEFFHand #2 - b",
  misread("Hand #1 - Holdem(No Limit) - $0.01/$0.02 - 2019/11/08 04:43:23 UTC\nHand #2 - x", true),
  misread("Game started at: 2014/3/9 19:37:22\nGame ID: 1 1/2 T (Hold'em)\n\nGame started at: 2014/3/9 19:38:22", false),
  "Bovada Hand #1 TBL#1 HOLDEM No Limit - 2016-08-09 12:41:32\nBodog Hand #2: x\rIgnition Hand #3\u2028\uFEFFBovada Hand #4 TBL#1 HOLDEM",
  "\uFEFF\uFEFFBovada Hand #1 TBL#1 HOLDEM\n\uFEFFBovada Hand #2 TBL#1 HOLDEM",
  "Bovada  Hand  #1 TBL#1 X\nBodog88 Hand #2 Y\nBodog Canada Hand #3 Z\nBodogX Hand #4 W",
  "x Bovada Hand #1 TBL#1 HOLDEM\nBovada Hand #2:\nBovada Hand #3: \r\nBovada Hand #4 a\rb",
  "Hand #1 - a\nBovada Hand #2 TBL#1 HOLDEM\nGame started at: 2014/3/9 19:37:22",
];
for (const text of SPLIT_TEXTS) {
  const entry = { text };
  for (const id of IDS) entry[id] = short(JSON.stringify(PARSERS[id].splitHands(text)));
  splits.push(entry);
}

const DETECT_TEXTS = [
  "",
  "hello",
  "Game started at: 2014/3/9 19:37:22",
  "Game started at: 2014/3/9 19:37:22\nGame ID: 1 1/2 T",
  "Game started at: 2014/3/9 19:37:22\nGame ID: 1 1/2",
  "x\rGame started at: 2014/3/9 19:37:22\nGame ID: 1 1/2 T",
  "x\u2028Game started at: 2014/3/9 19:37:22\nGame ID: 1 1/2 T",
  "Game started at: 2014/3/9 19:37:22 x\nGame ID: 1 1/2 T",
  " Game started at: 2014/3/9 19:37:22\nGame ID: 1 1/2 T",
  "Game started at: x\nGame started at: 2014/3/9 19:37:22\nGame ID: 1 1/2 T",
  "Hand #1 - Holdem(No Limit) - $0.01/$0.02 - 2019/11/08 04:43:23 UTC",
  "Game Hand #1 - x 2019/11/08 04:43:23 UTC  ",
  "Hand #1 - x 2019/11/08 04:43:23 UTC x",
  "Hand #1 - x 2019/11/08 04:43:23 UTC\rmore",
  "Hand #1 - x 2019/11/08 04:43:23 UTC \u2028more",
  "Hand #1 - x 2019/11/08 04:43:23 UTC \u00A0\nmore",
  "Hand #1 - x 2019/11/08\n04:43:23 UTC",
  "Hand #1 -\nx 2019/11/08 04:43:23 UTC",
  "Hand #1 - x\r2019/11/08 04:43:23 UTC",
  "Hand #12345 - something else entirely",
  "PokerStars Hand #1: x 2019/11/08 04:43:23 UTC",
  "PokerStars Hand #151588328:  Hold'em No Limit ($0.01/$0.02 USD) - 2019/11/08 4:43:23 ET",
  "Main pot $0.17 | Rake $0.00",
  "Side pot 1 | Rake x",
  "Main pot $0.17 |Rake",
  "Bovada Hand #1",
  "\uFEFFBovada Hand #1",
  "\uFEFF\uFEFFBovada Hand #1",
  "x\u2028Bodog.eu Hand #1",
  "Bodog.eu Hand#1",
  "UTG : Card dealt to a spot [Ac]\nDealer : Set dealer [3]",
  "UTG : Card dealt to a spot [Ac]\nDealer : Set dealer/Bring in spot [3]",
  "UTG : Card dealt to a spot [Ac]",
  " : Card dealt to a spot [\n: Set dealer [",
  misread("Game started at: 2014/3/9 19:37:22\nGame ID: 1 1/2 T (Hold'em)", true),
  misread("Hand #1 - Holdem(No Limit) - $0.01/$0.02 - 2019/11/08 04:43:23 UTC", false),
  misread("Bovada Hand #1 TBL#1", true),
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
  const entry = { ...base, ops, dialect: wpnDialect(text), detect: {}, outcomes: {} };
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
    const id =
      (chunk.match(/(?:Hand #|Game ID: )(\d+)/) ?? [])[1] ?? "1";
    const dialect = dialectOf(site, lines[0]);
    const base = { file: file.input, split: site, chunk: index };
    record(base, [], chunk);
    const key = `${site}:${dialect.lines === LEGACY_LINES ? "legacy" : "other"}`;
    if (!forced.has(key)) {
      // Targeted, once per grammar: no seat at all, and the chunk misread.
      forced.add(key);
      record(base, [["truncate", 2]], apply(chunk, [["truncate", 2]]));
      record(base, [["misread", true]], apply(chunk, [["misread", true]]));
      record(base, [["misread", false]], apply(chunk, [["misread", false]]));
      if (dialect.lines === LEGACY_LINES) {
        // Only one seat left acting: dealt in alone (`too-few-players`).
        const summaryAt = lines.findIndex((line) => /^-+\s*Summary/i.test(line.trim()));
        const solo = [];
        lines.forEach((line, i) => {
          const text = line.trim();
          if (i < summaryAt && /^Player /.test(text) && !text.startsWith(`Player ${names[0]} `)) {
            solo.push(["delete", i]);
          }
        });
        solo.reverse();
        record(base, solo, apply(chunk, solo));
      }
    }
    const count = (site === "ignition" ? 15 : 12) * (STRESS !== null ? 10 : 1);
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
      else if (roll < 0.13) ops.push(["prefix", "\uFEFF"]);
      else if (roll < 0.15) ops.push(["join", " "]);
      else if (roll < 0.17) ops.push(["join", "\u2028"]);
      if (random() < 0.04) ops.push(["misread", random() < 0.5]);
      record(base, ops, apply(chunk, ops));
    }
  });
}

/* ---------------------------------------------------------- the drafts --- */

const DRAFT_NAMES = ["alice", "bob", "Sean LeBlanc", "UTG+1", "Small Blind", "Hero", "12345", "x"];
const KINDS = [
  "ante",
  "small-blind",
  "big-blind",
  "post",
  "straddle",
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "allin",
  "uncalled",
  "show",
  "muck",
];
const STREETS = ["preflop", "flop", "turn", "river"];
const CARDS = ["Ah", "Kd", "Qs", "Jc", "Td", "9h", "8s", "7c", "2d", "3h"];
const DRAFT_AMOUNTS = [0, 1, 7, 25, 50, 75, 100, 150, 200, 250, 1000, -5, 2 ** 53 + 2, 1e21];

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = below(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function cards(n) {
  return shuffled(CARDS).slice(0, n);
}

function randomDraft() {
  const unit = pick([USD, USD, CHIPS, EUR]);
  const n = 2 + below(4);
  const names = shuffled(DRAFT_NAMES).slice(0, n);
  const seats = names.map((name, i) => ({
    seat: random() < 0.95 ? i + 1 + (random() < 0.3 ? 3 : 0) : pick([0, 1, 9, 2 ** 32, 1e21]),
    name: random() < 0.97 ? name : names[0],
    startingStack: random() < 0.95 ? pick([1000, 5000, 250]) : pick(DRAFT_AMOUNTS),
    isHero: random() < 0.3,
    dealtIn: random() < 0.92,
    dealtCards: random() < 0.3 ? cards(pick([2, 2, 4, 1])) : [],
  }));
  const actions = [];
  if (random() < 0.4) actions.push({ street: "preflop", player: names[below(n)], kind: "ante", amount: pick([1, 5, 0]) });
  if (random() < 0.85) actions.push({ street: "preflop", player: names[0], kind: "small-blind", amount: pick([25, 25, 0, 10]) });
  if (random() < 0.9) actions.push({ street: "preflop", player: names[1], kind: "big-blind", amount: pick([50, 50, 0, 20]) });
  let streetIndex = 0;
  const count = below(12);
  for (let k = 0; k < count; k += 1) {
    if (random() < 0.2) streetIndex = Math.min(3, streetIndex + 1);
    else if (random() < 0.03) streetIndex = below(4);
    const kind = pick(KINDS);
    const action = { street: STREETS[streetIndex], player: random() < 0.97 ? pick(names) : "Ghost", kind };
    if (!["fold", "check", "show", "muck"].includes(kind) || random() < 0.1) {
      if (!(kind === "allin" && random() < 0.1)) {
        action.amount = random() < 0.95 ? pick([25, 50, 100, 150, 200, 0]) : pick(DRAFT_AMOUNTS);
      }
    }
    if ((kind === "raise" || kind === "allin" || random() < 0.05) && random() < 0.5) action.toTotal = true;
    if (random() < 0.08) action.dead = pick([25, 0, 10]);
    if (random() < 0.15) action.allIn = true;
    if (kind === "show" || kind === "muck") {
      if (random() < 0.85) action.cards = cards(pick([2, 2, 0, 4]));
      if (random() < 0.5) action.description = pick(["Two pair", "", "high card"]);
    }
    actions.push(action);
  }
  const winners = shuffled(names).slice(0, random() < 0.8 ? 1 : 2);
  const collected =
    random() < 0.08
      ? []
      : winners.map((player) => ({
          player,
          amount: pick([50, 100, 75, 0, 1]),
          ...(random() < 0.6 ? { potName: pick(["pot", "main pot", "side pot", ""]) } : {}),
        }));
  const flop = random() < 0.6 ? (random() < 0.9 ? cards(3) : []) : null;
  const turn = flop !== null && random() < 0.6 ? pick(CARDS) : random() < 0.03 ? pick([...CARDS, ""]) : null;
  const river = turn !== null && random() < 0.6 ? pick(CARDS) : null;
  const tournament =
    random() < 0.2
      ? {
          id: pick(["unknown", String(1 + below(9999))]),
          name: pick([null, "Turbo", ""]),
          buyInToken: pick(["$0", "$25+$2.50"]),
          levelLabel: pick(["1", "5", "XII"]),
        }
      : null;
  const holeCards = new Map();
  if (random() < 0.4) holeCards.set(pick(names), cards(pick([2, 4, 0])));
  if (random() < 0.1) holeCards.set("Ghost", cards(2));
  return {
    siteId: pick(["acrwpn", "ignition"]),
    siteName: pick(["ACR / Winning Poker Network", "Ignition / Bodog / Bovada"]),
    parserId: pick(["acrwpn", "ignition"]),
    parserVersion: pick(["1.1.0", "1.0.0"]),
    handId: String(1 + below(99999)),
    gameLabel: pick(["Hold'em No Limit", "Omaha Pot Limit", "Hold'em Fixed Limit", "Omaha Hi/Lo Pot Limit", "6+ Hold'em No Limit"]),
    unit,
    decimals: pick(["fixed2", "minimal"]),
    smallBlind: pick([25, 10, 0]),
    bigBlind: pick([50, 20, 0]),
    tableName: random() < 0.8 ? pick(["Fort Lupton", "Braunite", "T", ""]) : null,
    maxSeats: pick([2, 6, 9, 10]),
    buttonSeat: random() < 0.85 ? pick(seats).seat : random() < 0.5 ? null : 77,
    playedAt: random() < 0.9 ? "2014-03-09T19:37:22.000Z" : pick([null, ""]),
    tournament,
    seats,
    actions,
    flop,
    turn,
    river,
    collected,
    statedPot: null,
    statedRake: random() < 0.4 ? null : pick([0, 0, 1, 5]),
    statedContributions: null,
    holeCards,
    rawText: "raw text",
    warnings: random() < 0.2 ? [{ code: "unknown-line", message: "x", line: 4 }] : [],
  };
}

const HUGE = 1e300;

/** What the replay put in the pot, read off the `chip-mismatch` message. */
function grossOf(draft) {
  try {
    p5DraftToStandardText({ ...draft, statedPot: HUGE, statedContributions: null });
  } catch (error) {
    const m = error instanceof ParseSkip && error.message.match(/^The action stream puts (\S+) in the pot/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** A player's replayed contribution, read off `contribution-mismatch`. */
function contributionOf(draft, gross, player) {
  try {
    p5DraftToStandardText({
      ...draft,
      statedPot: null,
      statedRake: null,
      collected: [{ player: draft.seats[0]?.name ?? "x", amount: gross }],
      statedContributions: new Map([[player, HUGE]]),
    });
  } catch (error) {
    const m = error instanceof ParseSkip && error.message.match(/replays to (\S+)\.$/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Mostly consistent money: the replay's own pot becomes the collected
 * amounts, the stated pot and (for some players) the stated contributions,
 * and one in five is then knocked out of true.
 */
function balanced(draft) {
  if (draft.collected.length === 0 || random() < 0.15) return draft;
  const gross = grossOf(draft);
  if (gross === null || !Number.isFinite(gross)) return draft;
  const off = () => (random() < 0.2 ? pick([2, -2, 1, 100]) : 0);
  const rake = Math.min(Math.max(0, gross), pick([0, 0, 1, 5, 30]));
  const winners = draft.collected.map((entry) => entry.player);
  const share = Math.floor((gross - rake) / winners.length);
  const collected = draft.collected.map((entry, i) => ({
    ...entry,
    amount: share + (i === 0 ? gross - rake - share * winners.length : 0) + (i === 0 ? off() : 0),
  }));
  let statedContributions = null;
  if (random() < 0.5) {
    statedContributions = new Map();
    for (const seat of draft.seats) {
      if (random() < 0.7) {
        const actual = contributionOf(draft, gross, seat.name);
        if (actual !== null) statedContributions.set(seat.name, actual + off());
      }
    }
    if (random() < 0.05) statedContributions.set("Ghost", 0);
  }
  return {
    ...draft,
    collected,
    statedPot: random() < 0.4 ? gross + off() : null,
    statedRake: random() < 0.6 ? rake + off() : random() < 0.5 ? null : 0,
    statedContributions,
  };
}

/** Every number of a draft as `String(n)`, so Rust reads the same double. */
const stringified = (draft) =>
  JSON.parse(
    JSON.stringify(
      {
        ...draft,
        holeCards: [...draft.holeCards],
        statedContributions: draft.statedContributions ? [...draft.statedContributions] : null,
      },
      (_key, value) => (typeof value === "number" ? String(value) : value),
    ),
  );

const drafts = [];
const DRAFT_COUNT = 700 * (STRESS !== null ? 10 : 1);
for (let k = 0; k < DRAFT_COUNT; k += 1) {
  const draft = balanced(randomDraft());
  const handKey = `${pick(["WPN", "IG"])}${draft.handId}`;
  let text;
  try {
    text = { text: short(p5DraftToStandardText(draft)) };
  } catch (error) {
    text = caught(error);
  }
  const built = outcome(() => p5BuildHand(structuredClone(draft), CTX, handKey));
  // `unit` and `warnings` are structured; the rest of the numbers stringified.
  drafts.push({
    draft: { ...stringified(draft), unit: draft.unit, warnings: draft.warnings },
    handKey,
    text,
    built,
  });
}

/* ------------------------------------------------- re-encoded files --- */

/** Windows-1252 bytes of `text` (`?` for what it cannot hold). */
const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
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
  const text = file.text.replace(/^\uFEFF/, "");
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

const out = { splits, detect, cases, drafts, files: encoded };
const target = process.env.P5_OUT ?? fileURLToPath(new URL("./p5-vectors.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(out, null, 0)}\n`);
const tally = {};
for (const c of cases) {
  for (const id of IDS) {
    const o = c.outcomes[id];
    if (id !== c.split && !o.hand) continue;
    const key = `${id}:${o.hand ? "hand" : o.skip ? o.skip[0] : "error"}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
}
for (const d of drafts) {
  const key = `draft:${d.built.hand ? "hand" : d.built.skip ? d.built.skip[0] : "error"}`;
  tally[key] = (tally[key] ?? 0) + 1;
}
console.log(
  `${target}: ${splits.length} splits, ${detect.length} detections, ${cases.length} cases, ` +
    `${drafts.length} drafts, ${encoded.length} re-encoded files\n${JSON.stringify(tally, null, 1)}`,
);
