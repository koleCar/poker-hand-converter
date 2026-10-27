// Writes p2pb-vectors.json: what the TypeScript partypoker, 888poker and
// PokerBros parsers (`web/src/lib/parsers/{partypoker,pokerstars888,
// pokerbros}.ts`) make of texts the corpus does not have, for
// `rail_core::parsers` to replay (docs/RAIL-PLAN.md R0.8).
//
//     cd tests && npm ci                 (esbuild)
//     node core/rail-core/tests/data/p2pb-vectors.mjs
//
// The goldens pin the 31 corpus files of these rooms through the pipeline.
// This file adds, by seeded mutation of their chunks, the branches the corpus
// leaves alone:
//
//  - `splits`: per corpus file (all of `testdata/golden/`, decoded with the
//    app's `decodeSource`) the 16-hex sha-256 of `JSON.stringify` of the
//    three parsers' `splitHands`, plus hand-written split edge cases.
//  - `detect`: the three parsers' per-mille scores of hand-written probes.
//  - `cases`: a chunk of a corpus file (`file`, the parser whose split cut it,
//    the chunk index) with a list of line edits applied; every parser's
//    detection score of the result and its `parseHand` outcome: the refusal's
//    reason and message, the message of anything else thrown, or the 16-hex
//    sha-256 of the canonical JSON of the hand (`parsedAt` pinned).
//  - `files`: corpus files of these rooms re-encoded (UTF-16 LE with and
//    without a BOM, UTF-16 BE, Windows-1252 with `€`/`£` amounts, CRLF) and
//    run through the converter's own path (`decodeSource`, `convertAny(text,
//    { sourceFilename, validate: true })`): encoding, ranking, every hand's
//    hash and every refusal.
//
// Edits are those of `wpcp-vectors.mjs` (`delete`, `insert`, `replace`,
// `swap`, `truncate`, `join`, `prefix`; `{P}`/`{Q}`/`{ID}` substituted here).
//
// Bundles the TypeScript with esbuild from tests/node_modules. Deterministic
// (seeded), so rerunning it rewrites the same file as long as the corpus and
// the TypeScript are the same. `P2PB_STRESS=<seed>` draws many more cases from
// another seed for a local soak run (the committed file is the default).

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
      export { partypokerParser, poker888Parser, pokerbrosParser, convertAny, detectSite }
        from "./web/src/lib/parsers/index.ts";
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
  partypokerParser,
  poker888Parser,
  pokerbrosParser,
  convertAny,
  detectSite,
  ParseSkip,
  decodeSource,
  canonicalJson,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const PARSED_AT = "1970-01-01T00:00:00.000Z";
const PARSERS = {
  partypoker: partypokerParser,
  "888poker": poker888Parser,
  pokerbros: pokerbrosParser,
};
const IDS = Object.keys(PARSERS);

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const short = (text) => sha(text).slice(0, 16);

/** A built hand as the goldens hash it: through JSON (drops `undefined`, `-0`). */
function handHash(value) {
  return short(canonicalJson(JSON.parse(JSON.stringify(value))));
}

function outcome(parser, text) {
  try {
    const hand = parser.parseHand(text, { sourceFilename: null, options: {} });
    hand.meta.parsedAt = PARSED_AT;
    return { hand: handHash(hand) };
  } catch (error) {
    if (error instanceof ParseSkip) {
      return { skip: [error.reason, error.message] };
    }
    return { error: String(error?.message ?? error) };
  }
}

/** `Math.round(score * 1000)`, the Rust per-mille. */
const permille = (parser, text) => Math.round(parser.detect(text) * 1000);

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
const STRESS = process.env.P2PB_STRESS ? Number(process.env.P2PB_STRESS) : null;
const random = mulberry32(STRESS ?? 0x9a27b05);
const pick = (list) => list[Math.floor(random() * list.length)];
const below = (n) => Math.floor(random() * n);

/* --------------------------------------------------------- the edits --- */

const PARTY_LINES = [
  "{P} folds",
  "{P} checks",
  "{P} calls [$0.10 USD]",
  "{P} calls [$0.25 USD]",
  "{P} bets [$1.10 USD]",
  "{P} bets [$1,100 USD]",
  "{P} raises [$0.30 USD]",
  "{P} raises [$0.70 USD]",
  "{P} is all-In  [$4.90 USD]",
  "{P} is all-in [$3.03 USD]",
  "{P} posts small blind [$0.05 USD].",
  "{P} posts big blind [$0.10 USD].",
  "{P} posts big blind + dead [$0.15 USD].",
  "{P} posts dead blind [$0.05 USD].",
  "{P} posts ante [$0.01 USD].",
  "{P} posts Small Blind [€0.05 EUR]",
  "Ghost posts big blind [$0.10 USD].",
  "{P} shows [ 8c, 8d ]three of a kind, Eights.",
  "{P} shows [ Ah, Kd ]",
  "{P} doesn't show [ Jc, Jd ]a pair of Jacks.",
  "{P} does not show cards.",
  "{P} wins $1.87 USD from the side pot 1 with three of a kind, Eights.",
  "{P} wins $20.66 USD from the main pot with three of a kind, Eights.",
  "{P} wins $0.25 USD",
  "{P} wins $1,000.50 USD from the main pot",
  "{Q} wins $0.10 USD",
  "{P} wins Lo ($28.75 USD) from the main pot with 7,5,4,2,A.",
  "{P} wins Hi ($28.75 USD) from the main pot with two pairs.",
  "{Q} wins lo ($1 USD)",
  "{P} shows7,5,4,2,A  for low.",
  "Ghost wins $1 USD",
  "Dealt to {P} [  Ah Kd ]",
  "Dealt to Ghost [  Ah Kd ]",
  "** Dealing down cards **",
  "** Dealing Flop ** [ 8s, 5c, 6h ]",
  "** Dealing Flop ** [ 8s, 5c ]",
  "** Dealing Flop ** [ 8s, 5c, 6h, 2d ]",
  "** Dealing Turn ** [ Ac ]",
  "** Dealing River ** [ Tc ]",
  "** Dealing River **",
  "** Dealing Turn ** [ ]",
  "Seat 5 is the button",
  "Seat 9 is the button",
  "Total number of players : 6/6",
  "Total number of players : 2/9",
  "Total number of players : 3",
  "Seat 7: Late ( $10 USD )",
  "Seat 7: {P} ( $15.02 USD )",
  "Seat 8: Rich ( $1,234.56 USD )",
  "Seat 007: Padded ( $1 USD )",
  "Table Aksay (Real Money)",
  "Table Practice (Play Money)",
  "{P} has joined the table.",
  "{P} has left the table.",
  "{P} is sitting out",
  "{P}: always play ur opponent",
  "{P} will be using his time bank for this hand.",
  "{P} did not respond in time",
  "Your time bank will be activated in 6 secs.",
  "Game #123 starts.",
  "#Game No : 1",
  "Ghost folds",
  "something nobody writes",
  "",
];

const PARTY_STAKES = [
  "$0.05/$0.10 USD NL Texas Hold'em - Sunday, January 05, 19:24:07 EST 2014",
  "$100 USD PL Omaha - Monday, January 06, 08:54:23 EDT 2014",
  "$1,000 USD NL Texas Hold'em - Monday, January 06, 08:54:23 EDT 2014",
  "€0.05/€0.10 EUR NL Texas Hold'em - Sunday, January 05, 19:24:07 CET 2014",
  "£1/£2 GBP FL Texas Hold'em - Sunday, January 05, 19:24:07 BST 2014",
  "$0.05/$0.10 USD Fixed Limit Texas Hold'em - Sunday, January 05, 19:24:07 PST 2014",
  "$0.05/$0.10 USD NL Texas Hold'em - Sunday, January 05, 19:24:07 XYZ 2014",
  "$0.05/$0.10 USD NL Texas Hold'em - Sunday, January 05, 19:24:07 et 2014",
  "$0.05/$0.10 USD PL Omaha Hi-Lo - Sunday, January 05, 19:24:07 EST 2014",
  "$0.05/$0.10 USD FL Seven Card Stud - Sunday, January 05, 19:24:07 EST 2014",
  "$0.05/$0.10 USD FL Seven Card Stud Hi-Lo - Sunday, January 05, 19:24:07 EST 2014",
  "$0.05/$0.10 USD PL 5 Card Omaha - Sunday, January 05, 19:24:07 EST 2014",
  "$0.05/$0.10 USD NL Texas Hold'em - Sunday, Smarch 05, 19:24:07 EST 2014",
  "$0.05/$0.10 USD NL Texas Hold'em - Sunday, February 31, 25:61:61 EST 0014",
  "$0.05/$0.10 USD NL Texas Hold'em - Sunday, December 99, 99:99:99 PDT 9999",
  "$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "$0.05/$0.10 USD NL Texas Hold'em - Sunday, January 05, 19:24:07 EST 2014 extra",
  "junk",
];

const P888_LINES = [
  "{P} folds",
  "{P} checks",
  "{P} calls [$0.10]",
  "{P} bets [$0.35]",
  "{P} bets [$1,035]",
  "{P} raises [$0.30]",
  "{P} is all-In  [$4.90]",
  "{P} posts small blind [$0.05]",
  "{P} posts big blind [$0.10]",
  "{P} posts dead blind [$0.05 + $0.10]",
  "{P} posts dead blind [$0.10]",
  "{P} posts dead blind []",
  "{P} posts ante [$0.01]",
  "{P} posts Big Blind [€0.10]",
  "Ghost posts big blind [$0.10]",
  "{P} shows [ 5c, 7s ]",
  "{P} shows [ 5c, 7s, 2d, 3d ]",
  "{P} mucks [ 5c, 7s ]",
  "{P} did not show his hand",
  "{P} did not show their hand",
  "{P} collected [ $5.70 ]",
  "{P} collected [ $1,005.70 ]",
  "{Q} collected [ $0.95 ]",
  "{P} collected [ $1 + $2 ]",
  "Ghost collected [ $1 ]",
  "(Hi: two pair, Aces and Kings)",
  "(Lo: 7,5,4,2,A)",
  "** Summary **",
  "** Dealing down cards **",
  "** Dealing flop ** [ Ks, Jc, Ac ]",
  "** Dealing flop ** [ Ks, Jc ]",
  "** Dealing turn ** [ 2s ]",
  "** Dealing river ** [ 4d ]",
  "** Dealing river ** [ ]",
  "Dealt to {P} [ 7h, 8h ]",
  "Dealt to Ghost [ 7h, 8h ]",
  "Seat 6 is the button",
  "Seat 2 is the button",
  "Seat 1: {P} ( $284.58 )",
  "Seat 8: Late ( $10 )",
  "Seat 8: Euro ( 3 023,50 $ )",
  "Seat 10: Ten ( $1,000 )",
  "Table Arezzo 6 Max (Real Money)",
  "Table Arezzo (Real Money)",
  "Table Arezzo 10 Max (Play Money)",
  "Total number of players : 6",
  "#Game No : 1",
  "Ghost folds",
  "{P}: nice hand",
  "{P} has joined the table.",
  "{P} finished the tournament",
  "something nobody writes",
  "",
];

const P888_STAKES = [
  "$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "$1/$2 Blinds Fix Limit Holdem - *** 14 04 2015 03:11:08",
  "$0.05/$0.10 Blinds Pot Limit OmahaHL - *** 06 01 2014 22:40:28",
  "$0.05/$0.10 Blinds No Limit Omaha - *** 06 01 2014 22:40:28",
  "$0.05/$0.10 Blinds Pot Limit Omaha Hi-Lo - *** 06 01 2014 22:40:28",
  "€0.05/€0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "£1/£2 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "0.05/0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "25 $/50 $ Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "$1,000/$2,000 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "$0.05/$0.10 Blinds Fix Limit 7 Card Stud - *** 06 01 2014 22:40:28",
  "$0.05/$0.10 Blinds Fix Limit 7 Card Stud HL - *** 06 01 2014 22:40:28",
  "$0.05/$0.10 Blinds Pot Limit 5 Card Omaha - *** 06 01 2014 22:40:28",
  "$0.05/$0.10 Blinds No Limit Holdem - *** 31 02 2014 25:61:61",
  "$0.05/$0.10 Blinds No Limit Holdem - *** 00 00 0000 99:99:99",
  "$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 2:40:28",
  "$0.05/$0.10 USD NL Texas Hold'em - Sunday, January 05, 19:24:07 EST 2014",
  "junk",
];

const BANNERS = [
  "***** Hand History for Game {ID} *****",
  "***** partypoker Hand History for Game {ID} *****",
  "***** Party Poker Hand History for Game {ID} *****",
  "***** 888poker Hand History for Game {ID} *****",
  "***** Pacific Poker Hand History for Game {ID} *****",
  "***** Cassava Hand History for Game {ID} *****",
  "***** 888.com Hand History for Game {ID} *****",
  "***** Hand History for Game {ID} ***** (PokerBros)",
  "*** Hand History for Game {ID} ***",
  "Hand History for Game {ID}",
];

const PB_PARTY_LINES = [
  "{P} folds",
  "{P} Checks",
  "{P} calls [$2.00 USD]",
  "{P} bets [$4.00 USD]",
  "{P} raises [$2.50 USD]",
  "{P} raises [$0.50 USD]",
  "{P} raises [$500.00 USD]",
  "{P} posts small blind [$0.50 USD].",
  "{P} posts big blind [$1.00 USD].",
  "Ghost posts big blind [$1.00 USD].",
  "Dealt to {P} [ 8h 9h ]",
  "Dealt to Ghost [ 8h 9h ]",
  "** Dealing down cards **",
  "** Dealing Flop ** [ 4d, Jd, Tc ]",
  "** Dealing Flop ** [ 4d ]",
  "** Dealing Flop **",
  "** Dealing Turn ** [ Qs ]",
  "** Dealing River ** [ 4s ]",
  "** Dealing River ** [ 4s, 5s ]",
  "{P} wins $241.55 USD",
  "{P} wins $100 USD from the main pot",
  "{Q} wins $5 from side pot",
  "{P} wins $0.25",
  "Ghost wins $1 USD",
  "Seat 1 is the button",
  "Seat 2 is the button",
  "Total number of players : 6",
  "Seat 7: Late ( $10.00 USD ) - (1 / 2 / 3 / 4)",
  "Seat 7: Bare ( $10.00 USD )",
  "Seat 1: Hero ( $122.40 USD ) - (21.60 / 16.35 / 5.71 / 18k)",
  "Table Foo (Real Money)",
  "{P} has joined the table.",
  "something nobody writes",
  "",
];

const PB_PARTY_STAKES = [
  "$100.00 USD NL Holdem - Friday, March 19, 07:51:54 ET 2021",
  "$100.00 USD NL Holdem - Friday, March 19, 07:51:54 EST 2021",
  "$0.50/$1.00 USD NL Texas Hold'em - Friday, March 19, 07:51:54 ET 2021",
  "€100.00 EUR NL Holdem - Friday, March 19, 07:51:54 CET 2021",
  "$100.00 USD PL Omaha - Friday, March 19, 07:51:54 ET 2021",
  "$100.00 USD NL Holdem - Friday, Maerz 19, 07:51:54 ET 2021",
  "junk",
];

const PB_STARS_LINES = [
  "{P}: folds",
  "{P}: checks",
  "{P}: calls $2.0",
  "{P}: bets $4.0",
  "{P}: raises $1.5 to $2.5",
  "{P}: bets $79.58 and is all-in",
  "{P}: posts small blind $0.5",
  "{P}: posts big blind $1",
  "{P}: posts straddle $2",
  "Ghost: posts straddle $2",
  "Ghost: calls $1",
  "{P}: shows [Th Ts]",
  "{P}: mucks hand",
  "{P} collected $241.55 from pot",
  "Uncalled bet ($5) returned to {P}",
  "*** HOLE CARDS ***",
  "Dealt to {P} [8h 9h]",
  "*** FLOP *** [4d Jd Tc]",
  "*** TURN *** [4d Jd Tc] [Qs]",
  "*** RIVER *** [4d Jd Tc Qs] [4s]",
  "*** SHOW DOWN ***",
  "*** SUMMARY ***",
  "Total pot $245.80 | Rake $4.25",
  "Board [4d Jd Tc Qs 4s]",
  "Seat 1: {P} showed [8h 9h] and lost",
  "Seat 3: {Q} (small blind) showed [Th Ts] and won ($241.55)",
  "Table 'Myanmar' 6-max Seat #2 is the button",
  "Table 'Myanmar' 6-max Seat #1 is the button",
  "Table 'Myanmar' 6-max Seat #9 is the button",
  "Table 'Myanmar' 6-max",
  "Seat 2: Late ($10 in chips)",
  "{P} said, \"hi\"",
  "something nobody writes",
  "",
];

const PB_STARS_HEADERS = [
  "PokerBros Hand #{ID}: Hold'em No Limit ($0.5/$1 USD) - 2021/03/19 19:51:54 UTC",
  "PokerBros Hand #{ID}: Hold'em No Limit ($0.5/$1 USD) - 2021/03/19 7:51:54 UTC",
  "PokerBros Hand #{ID}: Hold'em No Limit (¥0.5/¥1) - 2021/03/19 19:51:54 UTC",
  "PokerBros Hand #{ID}: Omaha Pot Limit ($0.5/$1 USD) - 2021/03/19 19:51:54 UTC",
  "PokerBros Hand #{ID}: Hold'em No Limit (0.5/1) - 2021/03/19 19:51:54 UTC",
  "PokerBros Hand #{ID}: Hold'em No Limit (€0.5/€1 EUR) - 2021/02/31 19:51:54 UTC",
  "PokerBros Hand #{ID}: Hold'em No Limit ($1) - 2021/03/19 19:51:54 UTC",
  "PokerBros Hand #{ID}: something",
];

function seatNames(lines) {
  const names = [];
  for (const line of lines) {
    const m = line.match(/^Seat\s+\d+:\s+(.+?)\s*\(/);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function fill(template, names, id) {
  return template
    .replaceAll("{P}", names[0] ?? "Hero")
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
  "99999999999999999999",
];

/** The catalogue and the header edits of a chunk's dialect. */
function dialectOf(site, lines) {
  if (site === "pokerbros") {
    return /^PokerBros Hand #/.test(lines[0] ?? "")
      ? { lines: PB_STARS_LINES, headers: [[0, PB_STARS_HEADERS]] }
      : { lines: PB_PARTY_LINES, headers: [[0, BANNERS], [1, PB_PARTY_STAKES]] };
  }
  const banner = lines.findIndex((line) => /Hand History for Game/.test(line));
  const at = Math.max(0, banner);
  return site === "888poker"
    ? { lines: P888_LINES, headers: [[at, BANNERS], [at + 1, P888_STAKES]] }
    : { lines: PARTY_LINES, headers: [[at, BANNERS], [at + 1, PARTY_STAKES]] };
}

/** One random edit of `lines`, as an op (with its text already final). */
function randomOp(lines, names, id, site) {
  const at = 1 + below(Math.max(1, lines.length - 1));
  const dialect = dialectOf(site, lines);
  switch (below(13)) {
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
      const summary = lines.findIndex((line) => /^\*+\s*SUMMARY/i.test(line));
      return summary > 0 ? ["truncate", summary + below(2)] : ["truncate", at];
    }
    case 10:
      return ["replace", at, `${lines[at] ?? ""} `];
    case 11:
      return ["replace", at, `  ${lines[at] ?? ""}`];
    default:
      return ["replace", at, fill(pick(dialect.lines), names, id)];
  }
}

function apply(chunk, ops) {
  let lines = chunk.split("\n");
  let sep = "\n";
  let prefix = "";
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
  }
  return prefix + lines.join(sep);
}

/* ---------------------------------------------------------- the cases --- */

const splits = [];
const SPLIT_TEXTS = [
  "",
  " ",
  "*****",
  "hello",
  "***** Hand History for Game 1 *****\nx",
  "\uFEFF#Game No : 1\r\n***** 888poker Hand History for Game 1 *****\r\nx\n#Game No : 2\n***** Hand History for Game 2 *****\ny",
  "\uFEFF\uFEFF***** Hand History for Game 1 *****\n\uFEFF***** Hand History for Game 2 *****",
  "#Game No : 1\n#Game No : 1\n***** Hand History for Game 1 *****\n\n\n***** Hand History for Game 2 *****\n  ",
  "***** Hand History for Game 1 *****\r***** Hand History for Game 2 *****\u2028***** Hand History for Game 3 *****",
  "   ***** Hand History for Game 1 *****   \n a \n",
  "PokerBros Hand #1: a\nPokerBros Hand #2: b",
  "\uFEFFPokerBros Hand #1: a\r\nPokerBros Hand #2: b\rPokerBros Hand #3: c\u2028PokerBros Hand #4: d",
  "junk\nPokerBros Hand #: b\nPokerBros Hand #2:c",
  "***** Hand History for Game 1 ***** (PokerBros)\na\n***** Hand History for Game 2 ***** (PokerBros)\nb",
  "***** Hand History for Game 1 ***** (pokerbros)\na\n***** Hand History for Game 2 ***** (PokerBros) x\nb",
  "x ***** Hand History for Game 1 ***** (PokerBros)\r\n***** Hand History for Game 2 ***** (PokerBros)\u2029y",
];
for (const text of SPLIT_TEXTS) {
  const entry = { text };
  for (const id of IDS) entry[id] = short(JSON.stringify(PARSERS[id].splitHands(text)));
  splits.push(entry);
}

const DETECT_TEXTS = [
  "",
  "hello",
  "*****",
  "***** Hand History for Game 1 *****",
  "***** Hand History for Game 1 *****\n$0.05/$0.10 USD NL Texas Hold'em - Sunday, January 05, 19:24:07 EST 2014",
  "***** partypoker Hand History for Game 1 *****\n$0.05/$0.10 USD NL Texas Hold'em - Sunday, January 05, 19:24:07 EST 2014",
  "***** PARTY POKER Hand History for Game 1 *****\n$0.05/$0.10 USD NL Texas Hold'em - Sunday, January 05, 19:24:07 EST 2014",
  "***** Hand History for Game 1 *****\r\n  $0.05/$0.10 USD NL Texas Hold'em - Sunday, January 05, 19:24:07 EST 2014  ",
  "\uFEFF***** Hand History for Game 1 *****\n\uFEFF$100 USD PL Omaha - Monday, January 06, 08:54:23 EST 2014",
  "***** Hand History for Game 1 *****\n$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "#Game No : 1\n***** 888poker Hand History for Game 1 *****\n$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "***** Pacific Poker Hand History for Game 1 *****\n25 $/50 $ Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "***** luckyacepoker Hand History for Game 1 *****\n$1/$2 Blinds Fix Limit Holdem - *** 06 01 2014 22:40:28",
  "***** 888poker Hand History for Game 1 *****\n\n$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "***** Hand History for Game 1 *****\r$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
  "***** Hand History for Game 1 ***** (PokerBros)\n$100.00 USD NL Holdem - Friday, March 19, 07:51:54 ET 2021",
  "x\u2028***** Hand History for Game 1 ***** (PokerBros)",
  "PokerBros Hand #1: x",
  "\uFEFFPokerBros Hand #1: x",
  "x\rPokerBros Hand #1: x",
  "x PokerBros Hand #1: x",
  "a PokerBros club game",
  "PokerBrosX",
  "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
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
function record(base, ops, text) {
  const entry = { ...base, ops, detect: {}, outcomes: {} };
  for (const id of IDS) {
    entry.detect[id] = permille(PARSERS[id], text);
    entry.outcomes[id] = outcome(PARSERS[id], text);
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
    const id = (chunk.match(/(?:Game|#)\s*(\d+)/) ?? [])[1] ?? "1";
    const base = { file: file.input, split: site, chunk: index };
    record(base, [], chunk);
    const count = (site === "pokerbros" ? 400 : 70) * (STRESS !== null ? 10 : 1);
    for (let k = 0; k < count; k += 1) {
      const ops = [];
      const edits = 1 + below(3);
      let current = lines;
      for (let e = 0; e < edits; e += 1) {
        const op = randomOp(current, names, id, site);
        ops.push(op);
        current = apply(current.join("\n"), [op]).split("\n");
      }
      const roll = random();
      if (roll < 0.05) ops.push(["join", "\r"]);
      else if (roll < 0.1) ops.push(["join", "\r\n"]);
      else if (roll < 0.13) ops.push(["prefix", "\uFEFF"]);
      else if (roll < 0.15) ops.push(["join", " "]);
      else if (roll < 0.17) ops.push(["join", "\u2028"]);
      record(base, ops, apply(chunk, ops));
    }
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
  "cp1252-euro": (text) => cp1252(text.replaceAll("$", "€").replaceAll("USD", "EUR")),
  "cp1252-pound": (text) => cp1252(text.replaceAll("$", "£").replaceAll("USD", "GBP")),
  "utf8-crlf": (text) => Buffer.from(text.replaceAll("\n", "\r\n"), "utf8"),
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

const out = { splits, detect, cases, files: encoded };
writeFileSync(
  fileURLToPath(new URL("./p2pb-vectors.json", import.meta.url)),
  `${JSON.stringify(out, null, 0)}\n`,
);
const tally = {};
for (const c of cases) {
  const o = c.outcomes[c.split];
  const key = `${c.split}:${o.hand ? "hand" : o.skip ? o.skip[0] : "error"}`;
  tally[key] = (tally[key] ?? 0) + 1;
}
console.log(
  `${splits.length} splits, ${detect.length} detections, ${cases.length} cases, ` +
    `${encoded.length} re-encoded files\n${JSON.stringify(tally, null, 1)}`,
);
