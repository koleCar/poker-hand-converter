// Writes p4-vectors.json: what the TypeScript Ongame, Entraction and Unibet
// parsers (`frontend/src/lib/parsers/{ongame,entraction,unibet}.ts`) and the
// text-room helpers they share (`shared/p4-textroom.ts`) make of texts the
// corpus does not have, for `rail_core::parsers` to replay
// (docs/RAIL-PLAN.md R0.10d).
//
//     cd tests && npm ci                 (esbuild)
//     node core/rail-core/tests/data/p4-vectors.mjs
//
// The goldens pin the 31 corpus files of these rooms through the pipeline.
// This file adds, by seeded mutation, the branches the corpus leaves alone:
//
//  - `textroom`: `expandMonth`, `namesByLength`, `leadingName` (over
//    `namesByLength`), `refuseLossyText` and `currencySymbolOf` probes.
//  - `splits`: per corpus file (all of `testdata/golden/`, decoded with the
//    app's `decodeSource`) the 16-hex sha-256 of `JSON.stringify` of each
//    parser's `splitHands` - or of `{ error }` when it throws (Unibet's
//    `readHeader` throws `Invalid time value` on a header whose date V8
//    rejects) - plus hand-written split edge cases.
//  - `detect`: the three parsers' per-mille scores of hand-written probes.
//  - `cases`: a chunk of a corpus file (`file`, the parser whose split cut it,
//    the chunk index) with a list of line edits applied; each parser's
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
// Edits are those of `p3-vectors.mjs` (`delete`, `insert`, `replace`,
// `swap`, `truncate`, `join`, `prefix`, `misread`; `{P}`/`{Q}`/`{ID}`
// substituted here). No guard is needed: nothing these parsers read sizes an
// allocation.
//
// Bundles the TypeScript with esbuild from tests/node_modules. Deterministic
// (seeded), so rerunning it rewrites the same file as long as the corpus and
// the TypeScript are the same. `P4_STRESS=<seed>` draws many more cases from
// another seed for a local soak run (the committed file is the default);
// `P4_OUT=<path>` writes it elsewhere, and `P4_VECTORS=<path>` points
// `tests/p4_vectors.rs` at it.

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
      export { ongameParser, entractionParser, unibetParser, convertAny, detectSite }
        from "./frontend/src/lib/parsers/index.ts";
      export {
        currencySymbolOf, expandMonth, leadingName, namesByLength, refuseLossyText,
      } from "./frontend/src/lib/parsers/shared/p4-textroom.ts";
      export { ParseSkip } from "./frontend/src/lib/phf/detect.ts";
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
  ongameParser,
  entractionParser,
  unibetParser,
  convertAny,
  detectSite,
  currencySymbolOf,
  expandMonth,
  leadingName,
  namesByLength,
  refuseLossyText,
  ParseSkip,
  decodeSource,
  canonicalJson,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const PARSED_AT = "1970-01-01T00:00:00.000Z";
const PARSERS = { ongame: ongameParser, entraction: entractionParser, unibet: unibetParser };
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

/** `splitHands`, or what it throws. */
function splitHash(parser, text) {
  try {
    return short(JSON.stringify(parser.splitHands(text)));
  } catch (error) {
    return short(JSON.stringify({ error: String(error?.message ?? error) }));
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
const STRESS = process.env.P4_STRESS ? Number(process.env.P4_STRESS) : null;
const random = mulberry32(STRESS ?? 0x4e7b3d);
const pick = (list) => list[Math.floor(random() * list.length)];
const below = (n) => Math.floor(random() * n);

/* --------------------------------------------------------- the edits --- */

const OG_LINES = [
  "{P} folds",
  "{P} checks",
  "{P} calls $1.00",
  "{P} calls $50.91 [all in] ",
  "{P} calls \u20ac0.50",
  "{P} bets $2.50",
  "{P} bets $18.00 [ALL IN]",
  "{P} raises $1.50 to $2.00",
  "{P} raises $10.00 to $10.50",
  "{P} raises $192.15 to $210.15 [all in] ",
  "{P} raises to $3",
  "{P} posts small blind ($0.50)",
  "{P} posts big blind ($1)",
  "{P} posts big blind ($1) [all in]",
  "{P} posts ante ($0.10)",
  "{P} posts small blind $0.50",
  "{P} shows [Kc, Kh]",
  "{P} shows [Ac, Kd, Qs, Jh]",
  "{P} shows",
  "{P} mucks",
  "{P} mucks [2c, 3d]",
  "{P} doesn't show",
  "{P} sits out",
  "{Q} folds",
  "Ghost folds",
  "Ghost calls $1.00",
  "--- Dealing flop [Ad, 8c, 3s]",
  "--- Dealing flop [Ad, 8c]",
  "--- Dealing flop []",
  "--- Dealing flop [Ad, 8c, 3s, 2h]",
  "--- Dealing turn [Js]",
  "--- Dealing turn []",
  "--- Dealing river [4h]",
  "--- DEALING RIVER [4h]",
  "---Dealing river[4h]",
  "---",
  "Dealing pocket cards",
  "Summary:",
  "summary:",
  "Main pot: $229.82 won by {P} ($226.82)",
  "Main pot: $4.00 won by {P} ($3.80)",
  "Side pot 1: $10.00 won by {P} ($9.50)",
  "Side pot: $10.00 won by {Q} ($10.00)",
  "Main pot: $4.00 won by Ghost ($3.80)",
  "Main pot: \u20ac4.00 won by {P} (\u20ac3.80)",
  "MAIN POT: $4 won by {P} ($4)",
  "Main pot: $4.00 won by {P}",
  "Rake taken: $3",
  "Rake taken: $0.20",
  "Rake taken: x",
  "Seat 1: {P} ($103.75), net: -$0.00",
  "Seat 8: {P} ($350.06), net: +$113.91, [Kc, Kh]",
  "Seat 9: {P} ($0.00), net: -$112.91, [6s, 8s]",
  "Seat 2: {P} ($96.99)",
  "Seat 2: {P} ($96.99), [Ah, Ad]",
  "Seat 3: Ghost ($5.00), net: +$1.00",
  "Seat 11: Late ($50.00)",
  "Seat 007: Padded ($1)",
  "Seat 99999999999: Far ($5)",
  "Seat 4294967296: Over ($5)",
  "Seat 4: {P} ($1,000.50)",
  "Button: seat 2",
  "Button: seat 99",
  "Button: seat 99999999999",
  "BUTTON: SEAT 7",
  "Players in round: 6",
  "Players in round: 99999999999",
  "Players in round: 0",
  "Players in round: 12",
  "Start hand: Mon Jan 06 01:06:00 CET 2014",
  "Start hand: Mon Jan 06 01:06:00 XYZ 2014",
  "Start hand: Tue Sep 30 23:59:59 EEST 2014",
  "Start hand: Sat Jun 07 12:00:00 BST 2014",
  "Start hand: Mon Xyz 06 01:06:00 CET 2014",
  "Start hand: Mon Feb 31 25:61:61 GMT 2014",
  "Start hand: Mon jan 6 1:06:00 cet 0050",
  "Start hand: Mon Dec 31 23:59:59 EST 9999",
  "Start hand: Mon Ma1 06 01:06:00 CET 2014",
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM $0.50/$1, Real money)",
  "***** End of hand R5-1 *****",
  "***** History for hand R5-2 *****",
  "something nobody writes",
  "",
];

const OG_HEADERS = [
  "***** History for hand {ID} *****",
  "*****History for hand {ID}*****",
  "***** History for hand  *****",
  "***** History for hand {ID} ***** trailing",
  "***** history for hand {ID} *****",
];

const OG_TABLES = [
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM $0.50/$1, Real money)",
  "Table: Bonn [361850810] (POT_LIMIT OMAHA_HI \u20ac0.50/\u20ac1, Real money)",
  "Table: Bonn [361850810] (POT_LIMIT OMAHA \u00a30.50/\u00a31, Real money)",
  "Table: Bonn [361850810] (LIMIT TEXAS_HOLDEM $1/$2, Real money)",
  "Table: Bonn [361850810] (FIXED_LIMIT TEXAS_HOLDEM $1/$2, Real money)",
  "Table: Bonn [361850810] (POT_LIMIT OMAHA_HI_LO $1/$2, Real money)",
  "Table: Bonn [361850810] (POT_LIMIT OMAHA_HL $1/$2, Real money)",
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM $0.50/$1, Play money)",
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM $0.50/$1, Realmoney)",
  "Table: Bonn [361850810] (POT_LIMIT FIVE_CARD_OMAHA $1/$2, Real money)",
  "Table: Bonn [361850810] (POT_LIMIT 5_CARD_OMAHA $1/$2, Real money)",
  "Table: Bonn [361850810] (NO_LIMIT SEVEN_CARD_STUD $1/$2, Real money)",
  "Table: Bonn [361850810] (NO_LIMIT SHORT_DECK $1/$2, Real money)",
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM 50/100, Real money)",
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM kr50/kr100, Real money)",
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM 0.50/$1, Real money)",
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM $0,50/$1, Real money)",
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM $1,000/$2,000, Real money)",
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM $0.005/$0.01, Real money)",
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM $99999999999999999999/$1, Real money)",
  "Table:  [1] (NO_LIMIT TEXAS_HOLDEM $0.50/$1, Real money)",
  "Table: X [1] (NO_LIMIT TEXAS_HOLDEM $0.50/$1)",
  "Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM $0.50/$1, Real money) extra",
  "Table: Alessandria [118630507] (NO_LIMIT TEXAS_HOLDEM \u20ac0.50/\u20ac1, Real money)",
];

const ENT_LINES = [
  "{P}                    Call        (0.25)",
  "{P}                    Bet         (2.50)",
  "{P}                    Raise       (7.75)",
  "{P}                    All-In      (50.25)",
  "{P}                    ALL-IN      (1.00)",
  "{P}                    Fold",
  "{P}                    Check",
  "{P}                    Payback     (15.00)",
  "{P}                    Payback     (1,000.00)",
  "{P} Call (1,000.50)",
  "{P} Call (0,25)",
  "{P} Call 0.25",
  "{P} shows:             As - Qs",
  "{P} shows:             As - Qs - Ah - Kd",
  "{P} shows:             As Qs",
  "{P} didn't show hand",
  "{P} didn't show hand (Jd - Qh - 6s - Ac)",
  "{P} wins:            EUR 27.25",
  "{P} wins:            EUR 1,000.00",
  "{P} wins:            SEK 5",
  "{Q} wins:            EUR 1.00",
  "Ghost wins:          EUR 1.00",
  "Ghost                Call        (1.00)",
  "Dealer:                     {P}",
  "Dealer:                     Ghost",
  "Small Blind:                {P}    (0.25)",
  "Big Blind:                  {P}      (0.50)",
  "Big Blind:                  Ghost      (0.50)",
  "small blind:                {P}    (0.25)",
  "Flop                        Ah - 6c - Jd",
  "Flop                        Ah - 6c",
  "Flop                        Ah - 6c - Jd - 3c",
  "Turn                        Ah - 6c - Jd - 3c",
  "Turn                        Ah - 6c - Jd",
  "River                       Ah - 6c - Jd - 3c - 9s",
  "River                       Ah",
  "Rake:                       EUR 0.75",
  "Rake:                       EUR 0,75",
  "Rake:                       EUR 0.00",
  "Game ended 2012-05-31 08:56:27 GMT+01:00",
  "Game ended 2012-05-31 08:56:27",
  "Game ended 2012-05-31 08:56:27 GMT-0530",
  "Game ended 2012-13-40 25:61:61 GMT-05:30",
  "Game ended 0050-01-01 00:00:00 GMT+99:99",
  "Players(max 6):",
  "Players(max 99999999999):",
  "Players(max 0):",
  "Players(max 12):",
  "Late                        (EUR 5.00 in seat 9)",
  "Far                         (EUR 5.00 in seat 99999999999)",
  "Padded                      (EUR 1.00 in seat 007)",
  "{P}                    (EUR 50.25 in seat 3)",
  "Spaced Name                 (EUR 5.00 in seat 8)",
  "something nobody writes",
  "",
];

const ENT_HEADERS = [
  'Game # {ID} - Texas Hold\'em No Limit EUR 0.25/0.50 - Table "Burguillos"',
  'Game # {ID} - Texas Hold\'em Fixed Limit EUR 15.00/30.00 - Table "Tiagba"',
  'Game # {ID} - Texas Hold\'em Pot Limit EUR 0.50/1.00 - Table "X"',
  'Game # {ID} - Omaha High Pot Limit EUR 0.50/1.00 - Table "X"',
  'Game # {ID} - 5-Card Omaha High Pot Limit EUR 0.50/1.00 - Table "X"',
  'Game # {ID} - Omaha Hi/Lo Pot Limit EUR 0.50/1.00 - Table "X"',
  'Game # {ID} - Omaha Hi/Lo Fixed Limit EUR 100.00/200.00 - Table "Portland"',
  'Game # {ID} - 5-Card Omaha Hi/Lo Pot Limit EUR 0.50/1.00 - Table "X"',
  'Game # {ID} - 7 Card Stud Fixed Limit EUR 0.50/1.00 - Table "X"',
  'Game # {ID} - 7 Card Stud Hi/Lo Fixed Limit EUR 0.50/1.00 - Table "X"',
  'Game # {ID} - Razz Fixed Limit EUR 0.50/1.00 - Table "X"',
  'Game # {ID} - Short Deck Hold\'em No Limit EUR 0.50/1.00 - Table "X"',
  'Game # {ID} - Texas Hold\'em No Limit SEK 1/2 - Table "X"',
  'Game # {ID} - Texas Hold\'em No Limit USD 0.25/0.50 - Table "X"',
  'Game # {ID} - Texas Hold\'em No Limit XYZ 0.25/0.50 - Table "X"',
  'Game # {ID} - Texas Hold\'em No Limit GBP 1,000/2,000 - Table "X"',
  'Game # {ID} - Texas Hold\'em No Limit EUR 0,25/0,50 - Table "X"',
  'Game # {ID} - Texas Hold\'em No Limit EUR 0.005/0.01 - Table "X"',
  'Game # {ID} - Texas Hold\'em No Limit EUR 0.25/0.50 - Table ""',
  'Game #{ID} - Texas Hold\'em No Limit EUR 0.25/0.50 - Table "X"',
  'Game # {ID} - Texas Hold\'em No Limit EUR 0.25/0.50 - Table "X" extra',
  'Game # {ID} - Texas Hold\'em Limit EUR 0.25/0.50 - Table "X"',
  "Game #{ID}: Table \u20ac1 NL - 0.05/0.10 - No Limit Hold'Em - 13:22:50 2021/04/04",
];

const UB_LINES = [
  "{P} folds",
  "{P} folds  (timed out)",
  "{P} folds (disconnect)",
  "{P} checks (time out)",
  "{P} checks",
  "{P} calls \u20ac0.10",
  "{P} calls 25",
  "{P} calls \u20ac0.95, and is all-in",
  "{P} bets \u20ac0.20",
  "{P} bets 50",
  "{P} raises \u20ac0.95 to \u20ac0.95, and is all-in",
  "{P} raises 50 to 100",
  "{P} raises to 100",
  "{P} posts small blind \u20ac0.05",
  "{P} posts big blind \u20ac0.10",
  "{P} posts small blind 25",
  "{P} posts big blind 50",
  "{P} posts big blind 50, and is all-in",
  "{P} posts the ante 5",
  "{P} posts the ant 5",
  "{P} posts small & big blinds \u20ac0.15",
  "{P} posts small & big blinds 75",
  "{P} posts button blind \u20ac0.10",
  "{P} posts straddle \u20ac0.20",
  "{P} posts dead blind \u20ac0.05",
  "{P} has the button",
  "{Q} has the button",
  "Ghost has the button",
  "{P} is sitting out",
  "{P} sits out",
  "{P} sitting out",
  "{P} shows [Qc Kh], High card",
  "{P} shows [8c Jc]",
  "{P} shows [], x",
  "{P} shows [Ts Kd 4c Td], A Pair of Tens",
  "{P} mucks",
  "{P} mucks [2c 3d]",
  "{P} does not show cards",
  "{P} doesn't show hand",
  "{P} wins \u20ac1.10",
  "{P} wins 300",
  "{P} wins \u20ac0.14",
  "{P} wins side pot #1, \u20ac0.50",
  "{P} wins main pot, \u20ac0.50",
  "{P} wins \u20ac0.50 from main pot",
  "{P} wins \u20ac0.50 from side pot #2",
  "{P} cashed out the hand for \u20ac5",
  "{P} wins the \u20ac2 bounty for eliminating x",
  "{P} wins the tournament and receives \u20ac4",
  "{P} finished the tournament in 2nd place",
  "{Q} wins \u20ac0.05",
  "Ghost wins \u20ac1",
  "Dealt to {P} [8c Jc]",
  "Dealt to {P} [Qc Kh Ad 2s]",
  "Dealt to {Q} [Ah Kd]",
  "Dealt to Ghost [8c Jc]",
  "Dealt in {P}",
  "Dealt in {Q}",
  "Dealt to {P} []",
  "Uncalled bet returned to {P}: \u20ac0.85",
  "Uncalled bet returned to {P}: 50",
  "Uncalled bet returned to Ghost: \u20ac0.85",
  "*** Seated players ***",
  "*** Blinds and button ***",
  "*** Hole cards ***",
  "*** Preflop ***",
  "*** Flop *** [4s Tc 8d]",
  "*** Flop *** [4s Tc]",
  "*** Flop ***",
  "*** Turn *** [4s Tc 8d] [Ac]",
  "*** River *** [4s Tc 8d] [Ac] [9d]",
  "*** River *** [4s Tc 8d] [Ac] []",
  "*** Showdown ***",
  "*** Summary ***",
  "*** SUMMARY ***",
  "Total pot 300",
  "Total pot \u20ac1.10 Rake \u20ac0.05",
  "Total pot \u20ac0.15 Rake \u20ac0.01",
  "Total pot \u20ac1,10",
  "Total pot x Rake y",
  "Seat 1: {P}: bet 150 and won 0, net result: -150",
  "Seat 5: {P}: bet \u20ac0.10 and won \u20ac0.25, net result: \u20ac0.15",
  "Seat 5: {P}: bet \u20ac0.10 and won \u20ac0.25, net result: \u20ac-0.05",
  "Seat 6: Ghost: bet \u20ac0.10 and won \u20ac0, net result: \u20ac-0.10",
  'Table "86116111" 3-max',
  'Table "" 9-max',
  'Table "x" 0-max',
  'Table "x" 99999999999-max',
  "Seat 9: Late (\u20ac5.00)",
  "Seat 9: Late (\u20ac5.00) (sitting out)",
  "Seat 9: Late (500)",
  "Seat 2: hero[Unibet_abc123] (500)",
  "Seat 99999999999: Far (\u20ac5)",
  "Seat 007: Padded (\u20ac1)",
  "Seat 8: Pounds (\u00a31)",
  "=== HAND HISTORIES ===",
  "=== TOURNAMENT SUMMARIES ===",
  "something nobody writes",
  "",
];

const UB_HEADERS = [
  "Game #{ID}: Table \u20ac1 NL - 0.05/0.10 - No Limit Hold'Em Banzai - 13:22:50 2021/04/04",
  "Game #{ID}: Table \u20ac1 PL - 0.05/0.10 - Pot Limit Omaha - 13:22:50 2021/04/04",
  "Game #{ID}: Table \u20ac1 FL - 0.05/0.10 - Fixed Limit Hold'Em - 13:22:50 2021/04/04",
  "Game #{ID}: Table $2 NL - 0.05/0.10 - No Limit Hold'Em - 3:22:50 2021/04/04",
  "Game #{ID}: Table 1 NL - 0.05/0.10 - No Limit Hold'Em - 13:22:50 2021/04/04",
  "Game #{ID}: Table \u20ac1 NL - 0,05/0,10 - No Limit Hold'Em - 13:22:50 2021/04/04",
  "Game #{ID}: Table \u20ac1 NL - 0.05/0.10 - No Limit Hold'Em - 25:00:00 2021/13/40",
  "Game #{ID}: Table \u20ac1 NL - 0.05/0.10 - No Limit Hold'Em - 24:00:00 2021/02/31",
  "Game #{ID}: Table \u20ac1 NL - 0.05/0.10 - No Limit Hold'Em - 9:05:07 2021/02/29",
  "Game #{ID}: Table \u20ac1 NL - 0.05/0.10 - No Limit Hold'Em - 00:00:00 0000/01/01",
  "Game #{ID}: Table \u20ac1 NL - 0.05/0.10 - No Limit Hold'Em - 12:60:00 2021/04/04",
  "Game #{ID}: Table \u20ac1 NL - 0.05/0.10 - No Limit Hold'Em - 12:00:00 2021/00/04",
  "Unibet Hand #{ID} - 0.03/0.05 - Pot Limit Omaha - UTC 21:59:40 2026/06/05",
  "Unibet Hand #{ID} - 0.03/0.05 - No Limit Hold'Em - 21:59:40 2026/06/05",
  "Unibet Hand #{ID} - 0.03/0.05 - Fixed Limit Hold'Em - UTC 21:59:40 2026/06/05",
  "Unibet Hand #{ID} - 0.03/0.05 - Limit Hold'Em - UTC 21:59:40 2026/06/05",
  "Unibet Hand #{ID} - 0.03/0.05 - Pot Limit 5 Card Omaha - UTC 21:59:40 2026/06/05",
  "Unibet Hand #{ID} - 0.03/0.05 - Pot Limit Omaha Hi/Lo - UTC 21:59:40 2026/06/05",
  "Unibet Hand #{ID} - 0.03/0.05 - Six Plus Hold'Em - UTC 21:59:40 2026/06/05",
  "Unibet Hand #{ID} - 0.03/0.05 - Seven Card Stud - UTC 21:59:40 2026/06/05",
  "Unibet Hand #{ID} - 0.03/0.05 - No Limit Hold'Em Banzai - UTC 21:59:40 2026/06/05",
  "Unibet Hand #{ID} - 0.03/0.05 - Pot Limit Omaha - UTC 24:00:00 2026/12/31",
  "Unibet Hand #{ID} - 0.03/0.05 - Pot Limit Omaha - UTC 21:59:40 2026/02/30",
  "Unibet Hand #{ID} - 0.03/0.05 - Pot Limit Omaha - UTC 21:59:40 2026/02/32",
  "Unibet Hand #{ID}, Tournament #85614762, \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - No Limit Hold'Em - Total prize \u20ac4 - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #85614762, \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #85614762, \u20ac0.93 + \u20ac0.07 - 25.50/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #85614762, \u20ac0.93 + \u20ac0.07 - 25/50 - Pot Limit Omaha - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #1, $1 + $0.10 - 25.00/50.00 - No Limit Hold'Em - Total prize $3 - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #1, \u20ac1 + \u20ac1 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #1, Freeroll + \u20ac0 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #1, \u20ac4.50+\u20ac4.50 + \u20ac1 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #1, \u20ac1+\u20ac2+\u20ac3 + \u20ac1 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #1, 5 + 1 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #1, \u20ac99999999999999999999 + \u20ac1 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #$&, \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #$1x, \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #$', \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #$`, \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #$$$<a>$10$00, \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #85614762, \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - No Limit Hold'Em - Total prize \u20ac4.555 - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #85614762, \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - No Limit Hold'Em - Total prize \u20ac99999999999999999999 - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #85614762, \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - No Limit Hold'Em - Total prize x - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #85614762, \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - Pot Limit Omaha Hi/Lo - UTC 21:59:56 2026/06/05",
  "Unibet Hand #{ID}, Tournament #85614762, \u20ac0.93 + \u20ac0.07 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/13/05",
  "Unibet Tournament #85614762, No Limit Holdem",
  "Unibet Hand #{ID} - x",
  "Unibet Hand #{ID}",
];

function dialectOf(site) {
  if (site === "ongame") return { lines: OG_LINES, headers: OG_HEADERS, tables: OG_TABLES };
  if (site === "entraction") return { lines: ENT_LINES, headers: ENT_HEADERS, tables: [] };
  return { lines: UB_LINES, headers: UB_HEADERS, tables: [] };
}

const NAME_OF = {
  ongame: /^Seat\s+\d+:\s+(.+?)\s+\(\S+\)\s*$/,
  entraction: /^(.*?)\s+\([A-Z]{3}\s+[\d.,]+\s+in seat\s+\d+\)\s*$/,
  unibet: /^Seat\s+\d+:\s+([^:]+?)\s+\(\S+\)(?:\s+\(sitting out\))?$/,
};

function seatNames(site, lines) {
  const names = [];
  for (const line of lines) {
    const m = line.trim().match(NAME_OF[site]);
    if (m && m[1].trim() && !names.includes(m[1].trim())) names.push(m[1].trim());
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
  "1 000",
  "2522.50",
  "99999999999999999999",
  "4294967296",
];

/** One random edit of `lines`, as an op (with its text already final). */
function randomOp(lines, names, id, dialect) {
  const at = 1 + below(Math.max(1, lines.length - 1));
  switch (below(15)) {
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
      // Ongame's game and stakes live on its `Table:` line, not the banner.
      const table = lines.findIndex((line) => /^Table:/.test(line.trim()));
      if (dialect.tables.length > 0 && table > 0 && random() < 0.7) {
        return ["replace", table, pick(dialect.tables)];
      }
      return ["replace", 0, fill(pick(dialect.headers), names, id)];
    }
    case 9: {
      const summary = lines.findIndex((line) => /^(?:\*+\s*)?Summary/i.test(line.trim()));
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
      return [
        "replace",
        at,
        line.replaceAll(name, pick(["Ghost", `${name} 2`, name.toUpperCase(), "", `${name}[Unibet_ab12]`])),
      ];
    }
    case 13: {
      // A line Windows-1252 text read as UTF-8 would leave.
      const line = lines[at] ?? "";
      return ["replace", at, line.replace(/[\u20ac$\u00a3]/, "\ufffd")];
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

/* ------------------------------------------------------- the helpers --- */

const MONTHS = [
  "Jan", "jan", "JANUARY", "Feb", "Mar", "Ma", "M", "", "Apr", "May", "Mayo", "Jun", "Ju", "J",
  "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec", "DEC", "Xyz", "d\u00e9c", "\u00c5ug",
  "J\ud83d\ude00", "\ud83d\ude00", "Ja\u0301", "ma1", "jun ", " Jun", "\u0130an",
];
const NAME_LISTS = [
  ["Bob", "Bobby", "Al"],
  ["a", "bb", "cc", "d", "ee"],
  ["Jim folds often", "Jim", "Jim folds"],
  ["\ud83d\ude00\ud83d\ude00", "abc", "abcd", "\u00e9\u00e9\u00e9"],
  ["", "x", "xy"],
  ["BONUS 1OOO", "BONUS", "---Cockatrice---", "Tiresias."],
  ["same", "same", "SAME"],
];
const LEADING = [
  ["Bobby folds", 0],
  ["Bob folds", 0],
  ["Bobbyx folds", 0],
  ["Bob", 0],
  ["Bob\tfolds", 0],
  ["Bob  folds  ", 0],
  ["Al\u00a0folds", 0],
  ["Jim folds often folds", 2],
  ["Jim folds", 2],
  ["Jim folds  ", 2],
  ["\ud83d\ude00\ud83d\ude00 bets", 3],
  ["\u00e9\u00e9\u00e9 calls", 3],
  [" x folds", 4],
  ["x folds", 4],
  ["anything", 4],
  ["BONUS 1OOO raises $1 to $2", 5],
  ["BONUS 1OOOO folds", 5],
  ["---Cockatrice--- folds", 5],
  ["SAME folds", 6],
];
const LOSSY = ["", "a", "a\ufffd", "\ufffd", "\u20ac1", "x\ufffd\ufffdy"];
const SYMBOLS = ["$1", "\u20ac0.50", "kr 1,050", "z\u01421", "R$5", "1", "", " $1", "+$1", "-\u20ac1", ".5", "\u00a3", "abc1", "\ufffd1"];

const textroom = {
  expandMonth: MONTHS.map((m) => [m, expandMonth(m)]),
  namesByLength: NAME_LISTS.map((names) => [names, namesByLength(names)]),
  leadingName: LEADING.map(([line, list]) => [line, list, leadingName(line, namesByLength(NAME_LISTS[list]))]),
  refuseLossyText: LOSSY.map((text) => {
    try {
      refuseLossyText(text, "Ongame");
      return [text, null];
    } catch (error) {
      return [text, caught(error)];
    }
  }),
  currencySymbolOf: SYMBOLS.map((token) => [token, currencySymbolOf(token)]),
};

/* ---------------------------------------------------------- the cases --- */

const splits = [];
const SPLIT_TEXTS = [
  "",
  " ",
  "hello",
  "***** History for hand R5-1 *****",
  "***** History for hand R5-1 *****\nx\n***** History for hand R5-2 *****\ry\r***** History for hand R5-3 *****\u2028z",
  "  ***** History for hand R5-1 *****\n\n***** History for hand  *****\n***** History for hand R5-3 ***** x",
  "\ufeff***** History for hand A *****\n\ufeff***** History for hand B *****",
  "x ***** History for hand R5-1 *****\n*****History for hand R5-2\n*****",
  misread("***** History for hand R5-1 *****\nStart hand: x", true),
  'Game # 1 - Texas Hold\'em No Limit EUR 0.25/0.50 - Table "B"\nx\nGame # 2 - Texas Hold\'em No Limit EUR 0.25/0.50 - Table "C"',
  'Game # 1 - a - Table "B"\rGame #2 - Omaha High Pot Limit EUR 1/2 - Table ""\u2029Game # 3 - x',
  '\ufeffGame # 1 - Texas Hold\'em No Limit EUR 0.25/0.50 - Table "B"  \n\ufeffGame # 2 -',
  "Game #1463192545: Table \u20ac1 NL - 0.05/0.10 - No Limit Hold'Em Banzai - 13:22:50 2021/04/04\nGame #2: Table \u20ac1 NL - 0.05/0.10 - x - 25:00:00 2021/04/04",
  "Game #1: Table \u20ac1 NL - 0.05/0.10 - No Limit Hold'Em - 25:00:00 2021/04/04",
  "Unibet Hand #1 - 0.03/0.05 - Pot Limit Omaha - UTC 21:59:40 2026/02/30\nUnibet Hand #2 - 0.03/0.05 - Pot Limit Omaha - UTC 21:59:40 2026/02/32",
  "=== HAND HISTORIES ===\n\nUnibet Hand #1 - 0.03/0.05 - Pot Limit Omaha - UTC 21:59:40 2026/06/05\n\n=== TOURNAMENT SUMMARIES ===\n\nUnibet Tournament #9, No Limit Holdem\nUnibet Tournament #x",
  "Unibet Hand #1, Tournament #2, \u20ac1 + \u20ac0 - 25.00/50.00 - No Limit Hold'Em - UTC 21:59:56 2026/06/05\rUnibet Hand #3 - x\u2028Game #4: Table x",
  "\ufeff\ufeffUnibet Hand #1 - 0.03/0.05 - Pot Limit Omaha - UTC 21:59:40 2026/06/05",
  misread("Unibet Hand #1 - 0.03/0.05 - Pot Limit Omaha - UTC 21:59:40 2026/06/05\nx", false),
];
for (const text of SPLIT_TEXTS) {
  const entry = { text };
  for (const id of IDS) entry[id] = splitHash(PARSERS[id], text);
  splits.push(entry);
}

const DETECT_TEXTS = [
  "",
  "hello",
  "***** History for hand R5-1 *****",
  "x\n***** History for hand R5-1 *****\ny",
  "x\r***** History for hand R5-1 *****",
  "x\u2028***** History for hand R5-1 *****\u2029",
  "***** History for hand R5-1 ***** x",
  "***** History for hand\nR5-1\n*****\n\n",
  " ***** History for hand R5-1 *****",
  "***** History for hand  *****",
  "\ufeff***** History for hand R5-1 *****",
  'Game # 2646539198 - Texas Hold\'em No Limit EUR 0.25/0.50 - Table "Burguillos"',
  'Game # 2646539198 - Texas Hold\'em No Limit EUR 0.25/0.50 - Table "Burguillos"\n\n',
  'Game # 2646539198 - Texas Hold\'em No Limit EUR 0.25/0.50 - Table "Burguillos"\nx',
  'x\rGame # 1 - a - Table "',
  'x\u2028Game #1 - a - Table "',
  ' Game # 1 - a - Table "',
  'Game # 1 - Table "',
  "Game #1463192545: Table \u20ac1 NL - 0.05/0.10 - No Limit Hold'Em Banzai - 13:22:50 2021/04/04",
  "Game #1463192545: Table \u20ac1 NL - 0.05/0.10 - ",
  "Game #1: Table \u20ac1 nl - 0.05/0.10 - x",
  "Unibet Hand #1558006027 - 0.03/0.05 - Pot Limit Omaha",
  "Unibet Hand #1, Tournament #2",
  "Unibet Hand #1 -x",
  "x\rUnibet Hand #1 - y",
  "Unibet Tournament #85614762, No Limit Holdem",
  "Unibet Tournament #85614762 No Limit Holdem",
  "<session>Unibet Hand #1 - x",
  "< game >\nUnibet Hand #1 - x",
  "<descriptions>\nUnibet Hand #1 - x",
  "<Game hhversion=\"4\" id=\"1\">\nUnibet Hand #1 - x",
  "Unibet Poker, 51069081",
  'Game # 1 - a - Table "\nUnibet Hand #1 - b\n***** History for hand R5-1 *****',
  misread("***** History for hand R5-1 *****", true),
  misread("Unibet Hand #1 - x", false),
];
const detect = DETECT_TEXTS.map((text) => {
  const entry = { text };
  for (const id of IDS) entry[id] = permille(PARSERS[id], text);
  return entry;
});

for (const file of files) {
  if (file.text === null) continue;
  const entry = { file: file.input };
  for (const id of IDS) entry[id] = splitHash(PARSERS[id], file.text);
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

const PER_CHUNK = { ongame: 70, entraction: 70, unibet: 260 };
for (const file of files) {
  if (file.text === null || !IDS.includes(file.top)) continue;
  const site = file.top;
  const chunks = PARSERS[site].splitHands(file.text);
  chunks.forEach((chunk, index) => {
    const lines = chunk.split("\n");
    const names = seatNames(site, lines);
    const id = (chunk.match(/(?:hand|Game #|Hand #)\s*(\S+?)[\s:,]/) ?? [])[1] ?? "1";
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
    // Targeted, every chunk: each catalogued header (Unibet, Entraction) or
    // `Table:` line (Ongame) on its own - the tournament rewrite with `$`
    // patterns in its id and buy-in, dates V8 rolls over or rejects, every
    // variant and currency against this chunk's body.
    if (site === "ongame") {
      const table = lines.findIndex((line) => /^Table:/.test(line.trim()));
      for (const line of OG_TABLES) record(base, [["replace", table, line]], apply(chunk, [["replace", table, line]]));
    } else {
      for (const header of dialect.headers) {
        const op = ["replace", 0, fill(header, names, id)];
        record(base, [op], apply(chunk, [op]));
      }
    }
    if (site === "unibet") {
      // Targeted, every chunk: no `Dealt` line at all, so only a collector
      // is dealt in (the 2021 hand's walk is then `too-few-players`).
      const ops = lines
        .map((line, at) => (/^Dealt\s/.test(line.trim()) ? ["delete", at] : null))
        .filter(Boolean)
        .reverse();
      if (ops.length > 0) record(base, ops, apply(chunk, ops));
    }
    const count = PER_CHUNK[site] * (STRESS !== null ? 10 : 1);
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

const out = { textroom, splits, detect, cases, files: encoded };
const target = process.env.P4_OUT ?? fileURLToPath(new URL("./p4-vectors.json", import.meta.url));
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
