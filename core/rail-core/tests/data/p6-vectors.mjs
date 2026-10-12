// Writes p6-vectors.json: what the TypeScript Winamax and Chico parsers
// (`frontend/src/lib/parsers/{winamax,chico}.ts`) and their shared builder
// (`shared/p6-handbuilder.ts`) make of texts and drafts the corpus does not
// have, for `rail_core::parsers` to replay (docs/RAIL-PLAN.md R0.10a).
//
//     cd tests && npm ci                 (esbuild)
//     node core/rail-core/tests/data/p6-vectors.mjs
//
// The goldens pin the 42 corpus files of these rooms through the pipeline.
// This file adds, by seeded mutation, the branches the corpus leaves alone:
//
//  - `splits`: per corpus file (all of `testdata/golden/`, decoded with the
//    app's `decodeSource`) the 16-hex sha-256 of `JSON.stringify` of both
//    parsers' `splitHands`, plus hand-written split edge cases.
//  - `detect`: both parsers' per-mille scores of hand-written probes.
//  - `cases`: a chunk of a corpus file (`file`, the parser whose split cut it,
//    the chunk index) with a list of line edits applied; both parsers'
//    detection score of the result and `parseHand` outcome: the refusal's
//    reason and message, the message of anything else thrown, or the 16-hex
//    sha-256 of the canonical JSON of the hand (`parsedAt` pinned).
//  - `drafts`: seeded random `P6Draft`s (every number written as `String(n)`)
//    through `p6ToStandardText` (the text's hash, or the refusal) and
//    `buildP6Hand` (as `cases`) - the builder's branches neither room reaches
//    (`payout-mismatch`, mucks, dead money on any kind, a turn without a
//    flop, a duplicated seat number).
//  - `files`: corpus files of these rooms re-encoded (UTF-16 LE with and
//    without a BOM, UTF-16 BE, Windows-1252 as is and with `£`, CRLF, and
//    UTF-8 with U+FFFD for every euro sign) and run through the converter's
//    own path (`decodeSource`, `convertAny(text, { sourceFilename, validate:
//    true })`): encoding, ranking, every hand's hash and every refusal.
//
// Edits are those of `p2pb-vectors.mjs` (`delete`, `insert`, `replace`,
// `swap`, `truncate`, `join`, `prefix`; `{P}`/`{Q}`/`{ID}` substituted here).
//
// Bundles the TypeScript with esbuild from tests/node_modules. Deterministic
// (seeded), so rerunning it rewrites the same file as long as the corpus and
// the TypeScript are the same. `P6_STRESS=<seed>` draws many more cases from
// another seed for a local soak run (the committed file is the default);
// `P6_OUT=<path>` writes it elsewhere, and `P6_VECTORS=<path>` points
// `tests/p6_vectors.rs` at it.

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
      export { winamaxParser, chicoParser, convertAny, detectSite }
        from "./frontend/src/lib/parsers/index.ts";
      export { buildP6Hand, p6ToStandardText }
        from "./frontend/src/lib/parsers/shared/p6-handbuilder.ts";
      export { ParseSkip } from "./frontend/src/lib/phf/detect.ts";
      export { USD, EUR, CHIPS, parseAmount } from "./frontend/src/lib/phf/types.ts";
      export { decodeSource } from "./frontend/src/components/converter/inputs.ts";
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
  winamaxParser,
  chicoParser,
  convertAny,
  detectSite,
  buildP6Hand,
  p6ToStandardText,
  ParseSkip,
  USD,
  EUR,
  CHIPS,
  parseAmount,
  decodeSource,
  canonicalJson,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const PARSED_AT = "1970-01-01T00:00:00.000Z";
const PARSERS = { winamax: winamaxParser, chico: chicoParser };
const IDS = Object.keys(PARSERS);
const CTX = { sourceFilename: null, options: {} };

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
const STRESS = process.env.P6_STRESS ? Number(process.env.P6_STRESS) : null;
const random = mulberry32(STRESS ?? 0x6a11c0);
const pick = (list) => list[Math.floor(random() * list.length)];
const below = (n) => Math.floor(random() * n);

/* --------------------------------------------------------- the edits --- */

const WINAMAX_LINES = [
  "{P} folds",
  "{P} checks",
  "{P} calls 0.50€",
  "{P} calls 20.35€ and is all-in",
  "{P} bets 1.25€",
  "{P} bets 2€ and is all-in",
  "{P} raises 1€ to 1.50€",
  "{P} raises 0.50€ to 0.50€",
  "{P} raises 2€ to 2.50€ and is all-in",
  "{P} raises 1€ to 0.25€",
  "{P} posts small blind 0.25€",
  "{P} posts big blind 0.50€",
  "{P} posts big blind 0.50€ out of position",
  "{P} posts big blind 0.50€ dead",
  "{P} posts small blind 0.25€ and is all-in",
  "{P} posts ante 0.05€",
  "{P} posts ante 0.05€ and is all-in",
  "{P} posts small blind 0.25$",
  "{P} calls 0.505€",
  "{P} calls 1,000€",
  "{P} calls 0,50 €",
  "{P} shows [Ah Kd] (One pair : Aces)",
  "{P} shows [Ah Kd]",
  "{P} shows [Ah Kd Qs Jc] (high card : Ace)",
  "{P} shows [Ah]",
  "{P} shows [3c 7c] (One pair : Sevens)",
  "{P} shows [] ()",
  "{P} mucks [Ah Kd]",
  "{P} collected 6.01€ from pot",
  "{P} collected 1.20€ from side pot 1",
  "{P} collected 43.45€ from main pot",
  "{P} collected 0€ from pot",
  "{Q} collected 0.75€ from pot",
  "Ghost collected 1€ from pot",
  "Dealt to {P} [4c 5s]",
  "Dealt to {P} []",
  "Dealt to {P} [4c 5s 6d 7h]",
  "Dealt to {P} [4c 5s 6d 7h 8h]",
  "Dealt to Ghost [4c 5s]",
  "*** ANTE/BLINDS ***",
  "*** PRE-FLOP *** ",
  "*** FLOP *** [4d Kc 9c]",
  "*** FLOP *** [3c 7c Jd]",
  "*** FLOP *** []",
  "*** FLOP ***",
  "*** FLOP *** [4d Kc]",
  "*** TURN *** [4d Kc 9c] [Jh]",
  "*** TURN *** [4d Kc 9c][Jh]",
  "*** TURN *** [6c]",
  "*** RIVER *** [4d Kc 9c Jh] [2s]",
  "*** RIVER *** [3c 7c Jd 6c] [5s]",
  "*** SHOW DOWN ***",
  "*** SHOWDOWN ***",
  "*** SUMMARY ***",
  "Total pot 6.01€ | Rake 0.24€",
  "Total pot 43.45€ | Rake 3€",
  "Total pot 0.75€ | No rake",
  "Total pot 6,01€ | No rake",
  "Total pot 6.01 | No rake",
  "Board: [4d Kc 9c]",
  "Board: [3c 7c Jd 6c 5s]",
  "Board: [4d Kc 9c Jh 2s]",
  "Board: [7h Qs 3c]",
  "Board: []",
  "Seat 4: {P} won 6.01€",
  "Seat 2: {P} showed [Qh Qc] and won 43.45€ with One pair : Queens",
  "Seat 4: {Q} (button) mucked",
  "Seat 7: Late (10€)",
  "Seat 7: {P} (10€)",
  "Seat 1: Dup (5€)",
  "Seat 8:   (5€)",
  "Seat 9: Rich (1 234,50€)",
  "Seat 9: Rich (99999999999999999999€)",
  "Seat 9: Poor (0€)",
  "Seat 007: Padded (1€)",
  "Seat 99999999999: Far (1€)",
  "Seat 5: Kool Shen (25€)",
  "Seat 6: 7 7 7 (25€)",
  "{P} said hi",
  "{P} sits out",
  "0,25 €",
  "\uFFFD",
  "something nobody writes",
  "",
];

const WINAMAX_HEADERS = [
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25€/0.50€) - 2013/11/07 3:53:58",
  "Winamax Poker - CashGame - HandId: #{ID} - Omaha pot limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Omaha5 pot limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - 5 Card Omaha pot limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem fixed limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Omaha Hi/Lo pot limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Short deck no limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - 7-Card Stud limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25$/0.50$) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25£/0.50£) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25 kr/0.50 kr) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25/0.50) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25/0.50€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0,25€/0,50€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25€/0.50€/1€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (x€/0.50€) - 2013/11/07 03:53:58 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25€/0.50€) - 2013/02/31 25:61:61 UTC",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25€/0.50€) - 0014/00/00 00:00:00",
  "Winamax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25€/0.50€) - 2013/11/07 03:53:58 CET extra",
  'Winamax Poker - Tournament "PPT Freeroll" buyIn: Free level: 0 - HandId: #{ID} - Holdem no limit (10/20) - 2013/11/07 03:53:58 UTC',
  "Winamax Poker - CashGame - garbage",
  "Winaax Poker - CashGame - HandId: #{ID} - Holdem no limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC",
];

const WINAMAX_TABLES = [
  "Table: 'Milwaukee 02' 5-max (real money) Seat #5 is the button",
  "Table: 'Athens 11' 5-max (real money) Seat #4 is the button",
  "Table: '' 6-max (real money) Seat #1 is the button",
  "Table: 'X' 9-max (play money) Seat #2 is the button",
  "Table: 'X' 2-max (real money)",
  "Table: 'X' 6-max (real money) Seat #9 is the button",
  "Table: 'X' 99999999999-max (real money) Seat #99999999999 is the button",
  "Table: 'X' 006-max (real money) Seat #01 is the button",
  "Table X",
];

const CHICO_LINES = [
  "{P}: folds",
  "{P}: Folds.",
  "{P}: checks",
  "{P}: Checks.",
  "{P}: calls 0.50",
  "{P}: Calls 2.00.",
  "{P}: calls 1.00 and is all in",
  "{P}: bets 1.25",
  "{P}: Bets 2.00.",
  "{P}: raises 1.00 to 1.50",
  "{P}: raises 120.00 to 120.00",
  "{P}: raises 0.50 to 0.25",
  "{P}: Raises 1000.00 and is All In.",
  "{P}: raises 2.00 to 3.50 and is all-in",
  "{P}: raises 2.00 to 3.50 and is allin",
  "{P}: posts small blind 0.25",
  "{P}: posts big blind 0.50",
  "{P}: Posts small blind 1.00.",
  "{P}: post big blind 0.50",
  "{P}: post dead 0.50",
  "{P}: post dead 0.00",
  "{P}: post now 0.50",
  "{P}: posts now 0.50 and is all in",
  "{P}: ante processed 0.10",
  "{P}: ante processed 0.00",
  "{P}: ante processed 2522.50",
  "{P}: calls 2522.50",
  "{P}: calls 1,000.00",
  "{P}: calls 1.000,00",
  "{P}: calls 0.505",
  "{P}: something else",
  "{P} shows Jc Jd",
  "{P} shows 10s 10d",
  "{P} shows 10s 10d 2c 3c",
  "{P} shows Ah",
  "{P} shows 6c 7s",
  "Unknown player: raises 15.75 to 18.75 and is all in",
  "Ghost: folds",
  "Ghost: posts small blind 0.25",
  "Dealt to {P} [Ah Kd]",
  "Dealt To {P} [10S 9S]",
  "Dealt to {P} [2c 3c 4c 5c]",
  "Dealt to {P} [2c 3c 4c 5c 6c]",
  "Dealt to {P} []",
  "Dealt to Ghost [Ah Kd]",
  "Uncalled bet (0.50) returned to {P}",
  "Uncalled bet (0.50) returned to {Q}",
  "Uncalled bet (11.12) returned to {P}",
  "Uncalled bet (0.50) returned to Ghost",
  "*** HOLE CARDS ***",
  "*** FLOP *** [6c 7s Qc]",
  "*** Flop *** [6c 7s]",
  "*** FLOP *** []",
  "*** TURN *** [6c 7s Qc][10d]",
  "*** turn *** [6c 7s Qc] [10D]",
  "*** RIVER *** [6c 7s Qc 10d] [2s]",
  "*** SHOW DOWN ***",
  "*** SUMMARY ***",
  "Total pot 1.50 | Rake 0.05",
  "Total Pot 13.30 | Rake 0.70",
  "Total pot 1.50.",
  "Total pot 1,500.00 | Rake 0.00",
  "Total pot 1.505 | Rake 0.05",
  "Total pot 1.50 | Rake 0.78",
  "Board [6c 7s Qc 10d 2s]",
  "Board [6c 7s Qc]",
  "Board [2h 3h 4h]",
  "Board [6c 7s]",
  "Board [6c 7s Qc 10d 2s 3s]",
  "Seat 1: {P} (small blind) folded before Flop",
  "Seat 2: {Q} (big blind) collected (1.45)",
  "Seat 3: {P} showed [Ah Kd] and won (1.45) with a pair",
  "Seat 3: {P} showed [10S 6D 6C 10C KC ] and won (1.45)",
  "Seat 3: {P} showed [2c 3c 4c 5c] and lost",
  "Seat 3: {P} won (0.00)",
  "Seat 9: Nobody won (0.10)",
  "Seat 99999999999: Far won (0.10)",
  "Seat 0: {P} (5.00 in chips)",
  "Seat 7: Late (10.00 in chips)",
  "Seat 7: Late (10.00 in Chips) - Sitting out",
  "Seat 8:  (100.00 in chips)",
  "Seat 9: Rich (1,234.50 in chips)",
  "Seat 9: Euro (1.234,50 in chips)",
  "Seat 009: Padded (1.00 in chips)",
  "Seat 5: {P} (3.00 in chips) - The button",
  "{P} said \"hi there\"",
  "{P} joins the table at seat #4",
  "{P} has left the table",
  "Joined table during game.",
  "Tournament will start in a moment.",
  "Hand cancelled",
  "something nobody writes",
  "",
];

const CHICO_HEADERS = [
  "BetOnline Poker Game #{ID}: Hold'em No Limit ($0.25/0.50) - 2012/04/10 23:14:10 GMT Daylight Time",
  "BetOnline Poker Game #{ID}: Hold'em Pot Limit ($0.05/0.10) - 2012/09/30 21:25:46 EDT",
  "BetOnline Poker Game #{ID}: Hold'em Fixed Limit ($0.05/0.10) - 2012/09/30 21:25:46 EDT",
  "BetOnline Poker Game #{ID}: Omaha Pot Limit ($0.05/0.10) - 2012/09/30 21:25:46 EDT",
  "BetOnline Poker Game #{ID}: Hold'em Hi/Lo Pot Limit ($0.05/0.10) - 2012/09/30 21:25:46 EDT",
  "BetOnline Poker Game #{ID}: Hold'em No Limit (0.25/0.50) - 2012/04/10 23:14:10",
  "BetOnline Poker Game #{ID}: Hold'em No Limit (€0.25/0.50) - 2012/04/10 23:14:10",
  "BetOnline Poker Game #{ID}: Hold'em No Limit ($0,25/0,50) - 2012/04/10 23:14:10",
  "BetOnline Poker Game #{ID}: Tournament #4157956: Hold'em $10.00/$20.00 - 2012/10/13 20:13:28 Eastern Daylight Time",
  "BetOnline Poker Game #{ID}: Tournament #4157956: Hold'em $10.50/$20.00 - 2012/10/13 20:13:28",
  "BetOnline Poker Game #{ID}: Tournament #4157956: Hold'em 10,00/20,00 - 2012/10/13 20:13:28",
  "BetOnline Poker Game #{ID}: Hold'em - 2012/02/31 25:61",
  "BetOnline Poker Game #{ID}: Hold'em - 2012-04-03 02:10:06",
  "BetOnline Poker Game #{ID}: Hold'em - 2012-04-03 x",
  "PayNoRake Game #{ID}: Hold'em No Limit ($0.25/0.50) - 2012/06/07 08:58 GMT Standard Time",
  "ActionPoker.com Game #{ID}: Hold'em - 2012-04-03 02:10:06",
  "Gear Poker Game #{ID}: Hold'em - 2012-04-09 12:14:36",
  "Tiger Gaming Game #{ID}: Hold'em No Limit ($0.25/0.50) - 2012/04/10 23:14:10",
  "SportsBetting.ag Poker Game #{ID}: Hold'em No Limit ($0.25/0.50) - 2012/04/10 23:14:10",
  "BetOnline Poker Game #{ID}: garbage",
];

const CHICO_TABLES = [
  "Table 'Blade Runner' 10-Max, Seat #5 is the button",
  "Table 'Weeds (Hi)' 10-Max, Seat #7 is the button",
  "Table 'Weeds (Hi/Lo)' 10-Max, Seat #7 is the button",
  "Table '' 10-Max, Seat #1 is the button",
  "Table The Green Mile (Real Money) Seat #2 is the button",
  "Table 3875596-33 (Play Money) Seat #9 is the button",
  "Table 'X' 6-max, Seat #3 is the button",
  "Table 'X' 10-Max, Seat #99 is the button",
  "Table 'X' 99999999999-Max, Seat #99999999999 is the button",
  "Table 'X' 10-Max",
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
  "1 234,50",
  "0,25",
  "2522.50",
  "99999999999999999999",
];

function dialectOf(site) {
  return site === "winamax"
    ? { lines: WINAMAX_LINES, headers: [[0, WINAMAX_HEADERS], [1, WINAMAX_TABLES]] }
    : { lines: CHICO_LINES, headers: [[0, CHICO_HEADERS], [1, CHICO_TABLES]] };
}

/** One random edit of `lines`, as an op (with its text already final). */
function randomOp(lines, names, id, site) {
  const at = 1 + below(Math.max(1, lines.length - 1));
  const dialect = dialectOf(site);
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
      const summary = lines.findIndex((line) => /^\*+\s*SUMMARY/i.test(line));
      return summary > 0 ? ["truncate", summary + below(3)] : ["truncate", at];
    }
    case 10:
      return ["replace", at, `${lines[at] ?? ""} `];
    case 11:
      return ["replace", at, `  ${lines[at] ?? ""}`];
    case 12: {
      // A currency glyph swapped on one line.
      const line = lines[at] ?? "";
      return ["replace", at, line.replaceAll("€", pick(["$", "£", "\uFFFD", " €", ""]))];
    }
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
  "hello",
  "Winamax Poker - x",
  "Winamax Poker -x",
  "\uFEFFWinamax Poker - a\n\n\n\n\nWinamax Poker - b\n",
  "x\rWinamax Poker - a\u2028Winamax Poker - b\u2029\uFEFFWinamax Poker - c",
  "  Winamax Poker - a\n  Winamax Poker - b",
  "\uFEFF\uFEFFWinamax Poker - a\n\uFEFFWinamax Poker - b\r\nWinamax Poker - c",
  "*** ANTE/BLINDS ***\nWinamax Poker - a",
  "BetOnline Poker Game #1: a\nBetOnline Poker Game #2: b",
  "Tournament will start in a moment.\nBetOnline Poker Game #1: a\n\nBetOnline Poker Game #2: b",
  "\uFEFFBetOnline Poker Game #1: a\r\nPayNoRake Game #2: b\rGear Poker Game #3: c\u2028ActionPoker.com Game #4: d",
  "x\r\uFEFFBetOnline Poker Game #1: y\nTiger Gaming Game #2: z",
  "Tiger Gaming Game #1: a\nSportsBetting.ag Poker Game #2: b\nSportsBettingXag Poker Game #3: c",
  "BetOnline Poker Game #: a\nBetOnline Poker Game #1 b\nBetOnline Poker Game #1:c",
  "ActionPokerXcom Game #1: a\n BetOnline Poker Game #2: b",
  "Winamax Poker - a\nBetOnline Poker Game #1: b",
];
for (const text of SPLIT_TEXTS) {
  const entry = { text };
  for (const id of IDS) entry[id] = short(JSON.stringify(PARSERS[id].splitHands(text)));
  splits.push(entry);
}

const DETECT_TEXTS = [
  "",
  "hello",
  "Winamax Poker - CashGame",
  "Winamax Poker - Tournament",
  "Winamax Poker - CashGameX",
  "Winamax Poker - Tournament_",
  "Winamax Poker - Sit&Go",
  "\uFEFFWinamax Poker - CashGame",
  "x\rWinamax Poker - CashGame",
  "x\u2028Winamax Poker - x",
  "x Winamax Poker - CashGame",
  "*** ANTE/BLINDS ***",
  "x\n*** ANTE/BLINDS ***",
  " *** ANTE/BLINDS ***",
  "*** ANTE BLINDS ***",
  "BetOnline Poker Game #1:",
  "BetOnline Poker Game #:",
  "x\rPayNoRake Game #12: y",
  "ActionPoker.com Game #1: x",
  "ActionPokerXcom Game #1: x",
  "Gear Poker Game #1:",
  "Tiger Gaming Game #1:",
  "SportsBetting.ag Poker Game #1:",
  "Tiger Gaming Game #1:\nBetOnline Poker Game #2:",
  " BetOnline Poker Game #1:",
  "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
  "PokerStars Game #123456789: Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
  "Poker Hand #HD123: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01",
  "Game Hand #1234567 - Hold'em No Limit ($0.01/$0.02)\nTable 'Bilbao' 6-max Seat #1",
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
    const id = (chunk.match(/(?:HandId: #|Game #)(\S+?)[: ]/) ?? [])[1] ?? "1";
    const base = { file: file.input, split: site, chunk: index };
    record(base, [], chunk);
    if (!forced.has(site)) {
      // Targeted, once per room: no seat at all, and one seat that wins.
      forced.add(site);
      record(base, [["truncate", 2]], apply(chunk, [["truncate", 2]]));
      const seat = lines[2].match(/^Seat (\d+): (.+?) \(/);
      const won = site === "winamax" ? `${seat[2]} collected 0.50€ from pot` : `Seat ${seat[1]}: ${seat[2]} collected (0.50)`;
      const pot = site === "winamax" ? "Total pot 0.50€ | No rake" : "Total pot 0.50 | Rake 0.00";
      const ops = [["truncate", 3], ["insert", 3, "*** SUMMARY ***"], ["insert", 4, pot], ["insert", site === "winamax" ? 3 : 5, won]];
      record(base, ops, apply(chunk, ops));
    }
    const count = (site === "winamax" ? 40 : 22) * (STRESS !== null ? 10 : 1);
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

/* ---------------------------------------------------------- the drafts --- */

const DRAFT_NAMES = ["alice", "bob", "Kool Shen", "7 7 7", "Incognito 1", "Incognito 10", "Hero", "x"];
const KINDS = ["ante", "small-blind", "big-blind", "post", "fold", "check", "call", "bet", "raise", "show", "muck"];
const STREETS = ["preflop", "flop", "turn", "river"];
const CARDS = ["Ah", "Kd", "Qs", "Jc", "Td", "9h", "8s", "7c", "2d", "3h"];
const DRAFT_AMOUNTS = [0, 1, 7, 25, 50, 75, 100, 150, 200, 250, 1000, 2 ** 53 + 2, 1e21];

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
  const unit = pick([EUR, USD, CHIPS]);
  const n = 2 + below(4);
  const names = shuffled(DRAFT_NAMES).slice(0, n);
  const seats = names.map((name, i) => ({
    seat: random() < 0.9 ? i + 1 + (random() < 0.3 ? 3 : 0) : pick([0, 1, 9, 2 ** 32, 1e21]),
    name,
    startingStack: random() < 0.9 ? pick([1000, 5000, 250]) : pick(DRAFT_AMOUNTS),
    dealtIn: random() < 0.9,
    isHero: random() < 0.3,
    dealtCards: random() < 0.3 ? cards(pick([2, 2, 4])) : [],
  }));
  const actions = [];
  let gross = 0;
  const add = (action) => {
    actions.push(action);
    if (action.amount !== undefined && action.kind !== "show" && action.kind !== "muck") gross += action.amount;
    if (action.dead !== undefined) gross += action.dead;
  };
  if (random() < 0.85) add({ street: "preflop", player: names[0], kind: "small-blind", amount: pick([25, 25, 0, 10]) });
  if (random() < 0.9) add({ street: "preflop", player: names[1], kind: "big-blind", amount: pick([50, 50, 0, 20]) });
  let streetIndex = 0;
  const count = below(12);
  for (let k = 0; k < count; k += 1) {
    if (random() < 0.2) streetIndex = Math.min(3, streetIndex + 1);
    else if (random() < 0.03) streetIndex = below(4);
    const kind = pick(KINDS);
    const action = { street: STREETS[streetIndex], player: random() < 0.97 ? pick(names) : "Ghost", kind };
    if (!["fold", "check", "show", "muck"].includes(kind) || random() < 0.1) {
      action.amount = random() < 0.9 ? pick([25, 50, 100, 150, 200, 0]) : pick(DRAFT_AMOUNTS);
    }
    if (kind === "raise" && random() < 0.6) action.toTotal = true;
    if (random() < 0.08) action.dead = pick([25, 0, 10]);
    if (random() < 0.15) action.allIn = true;
    if (kind === "show" || kind === "muck") {
      if (random() < 0.85) action.cards = cards(pick([2, 2, 0, 4]));
      if (kind === "show" && random() < 0.5) action.description = pick(["One pair : Aces", "", "high card"]);
    }
    if (random() < 0.5) action.line = 3 + k;
    add(action);
  }
  const winners = shuffled(names).slice(0, random() < 0.8 ? 1 : 2);
  const rake = pick([0, 0, 1, 5]);
  const collected =
    random() < 0.05
      ? []
      : winners.map((player, i) => ({
          player,
          amount: random() < 0.8 ? Math.max(0, Math.floor((gross - rake) / winners.length) + (i === 0 ? (gross - rake) % winners.length : 0)) : pick(DRAFT_AMOUNTS),
          ...(random() < 0.7 ? { potName: pick(["pot", "main pot", "side pot"]) } : {}),
        }));
  const flop = random() < 0.6 ? (random() < 0.9 ? cards(3) : []) : null;
  const turn = flop !== null && random() < 0.6 ? pick(CARDS) : random() < 0.03 ? pick(CARDS) : null;
  const river = turn !== null && random() < 0.6 ? pick(CARDS) : null;
  const tournament = random() < 0.2 ? { id: String(1 + below(9999)), levelSmallBlind: pick([25, 10]), levelBigBlind: pick([50, 20]) } : null;
  return {
    siteId: pick(["winamax", "chico"]),
    siteName: pick(["Winamax", "Chico Network"]),
    parserId: pick(["winamax", "chico"]),
    parserVersion: "1.0.0",
    handPrefix: pick(["WMX-", "CHC-"]),
    handId: String(1 + below(99999)),
    gameLabel: pick(["Hold'em No Limit", "Omaha Pot Limit", "Hold'em Limit"]),
    unit,
    decimals: pick(["fixed2", "minimal"]),
    headerSmallBlind: pick([25, 10, 0]),
    headerBigBlind: pick([50, 20, 0]),
    tableName: random() < 0.8 ? pick(["Milwaukee 02", "Weeds (Hi)", "T"]) : null,
    maxSeats: pick([2, 5, 6, 9, 10]),
    buttonSeat: random() < 0.85 ? pick(seats).seat : random() < 0.5 ? null : 77,
    tournament,
    playedAt: random() < 0.9 ? "2013-11-07T03:53:58.000Z" : pick([null, ""]),
    seats,
    actions,
    flop,
    turn,
    river,
    collected,
    collectedIncludesUncalled: random() < 0.5,
    printedUncalled: random() < 0.15 ? [{ player: pick(names), amount: pick([25, 50, 0, 100]) }] : [],
    reportedGross: random() < 0.6 ? null : random() < 0.6 ? gross : pick(DRAFT_AMOUNTS),
    reportedPayout: random() < 0.8 ? null : random() < 0.5 ? gross - rake : pick(DRAFT_AMOUNTS),
    reportedRake: random() < 0.4 ? null : random() < 0.7 ? rake : pick([0, 3, 100]),
    rawText: "raw text",
    warnings: random() < 0.2 ? [{ code: "unknown-line", message: "x", line: 4 }] : [],
  };
}

/** Every number of a draft as `String(n)`, so Rust reads the same double. */
const stringified = (draft) =>
  JSON.parse(JSON.stringify(draft, (_key, value) => (typeof value === "number" ? String(value) : value)));

/**
 * Mostly consistent money: the pot and the uncalled return the builder
 * derives (read off a probe's text) become the collected amounts and the
 * reported figures, and one in five is then knocked out of true.
 */
function balanced(draft) {
  const winners = draft.collected.map((entry) => entry.player);
  if (winners.length === 0 || random() < 0.15) return draft;
  let text;
  try {
    text = p6ToStandardText({
      ...draft,
      collected: [{ player: winners[0], amount: 0 }],
      collectedIncludesUncalled: false,
      printedUncalled: [],
      reportedGross: null,
      reportedPayout: null,
      reportedRake: null,
    });
  } catch {
    return draft;
  }
  const pot = parseAmount(text.match(/^Total pot (\S+) \|/m)?.[1], draft.unit);
  const returned = text.match(/^Uncalled bet \((\S+)\) returned to (.+)$/m);
  const uncalled = returned ? { player: returned[2], amount: parseAmount(returned[1], draft.unit) } : null;
  const rake = Math.min(pot, pick([0, 0, 1, 5]));
  const share = Math.floor((pot - rake) / winners.length);
  const collected = winners.map((player, i) => ({
    ...draft.collected[i],
    player,
    amount: share + (i === 0 ? pot - rake - share * winners.length : 0),
  }));
  if (draft.collectedIncludesUncalled && uncalled) {
    const own = collected.find((entry) => entry.player === uncalled.player);
    if (own) own.amount += uncalled.amount;
    else collected.push({ player: uncalled.player, amount: uncalled.amount });
  }
  const off = () => (random() < 0.2 ? pick([2, -2, 1, 100]) : 0);
  return {
    ...draft,
    collected,
    printedUncalled: uncalled && random() < 0.5 ? [{ ...uncalled, amount: uncalled.amount + off() }] : [],
    reportedGross: random() < 0.5 ? pot + (uncalled?.amount ?? 0) + off() : null,
    reportedPayout: random() < 0.3 ? pot - rake + off() : null,
    reportedRake: random() < 0.7 ? rake + off() : null,
  };
}

const drafts = [];
const DRAFT_COUNT = 600 * (STRESS !== null ? 10 : 1);
for (let k = 0; k < DRAFT_COUNT; k += 1) {
  const draft = balanced(randomDraft());
  let text;
  try {
    text = { text: short(p6ToStandardText(draft)) };
  } catch (error) {
    text = caught(error);
  }
  const built = outcome(() => buildP6Hand(structuredClone(draft), CTX));
  // `unit` and `warnings` are structured; the rest of the numbers stringified.
  drafts.push({ draft: { ...stringified(draft), unit: draft.unit, warnings: draft.warnings }, text, built });
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
  "cp1252-pound": (text) => cp1252(text.replaceAll("€", "£").replaceAll("$", "£")),
  "utf8-crlf": (text) => Buffer.from(text.replaceAll("\n", "\r\n"), "utf8"),
  "utf8-fffd": (text) => Buffer.from(text.replaceAll("€", "\uFFFD").replaceAll("$", "\uFFFD"), "utf8"),
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
const target = process.env.P6_OUT ?? fileURLToPath(new URL("./p6-vectors.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(out, null, 0)}\n`);
const tally = {};
for (const c of cases) {
  const o = c.outcomes[c.split];
  const key = `${c.split}:${o.hand ? "hand" : o.skip ? o.skip[0] : "error"}`;
  tally[key] = (tally[key] ?? 0) + 1;
}
for (const d of drafts) {
  const key = `draft:${d.built.hand ? "hand" : d.built.skip ? d.built.skip[0] : "error"}`;
  tally[key] = (tally[key] ?? 0) + 1;
}
console.log(
  `${target}: ${splits.length} splits, ${detect.length} detections, ${cases.length} cases, ` +
    `${drafts.length} drafts, ${encoded.length} re-encoded files\n${JSON.stringify(tally, null, 1)}`,
);
