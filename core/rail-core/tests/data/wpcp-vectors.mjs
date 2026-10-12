// Writes wpcp-vectors.json: what the TypeScript WePlay and CoinPoker parsers
// (`frontend/src/lib/parsers/{weplay,coinpoker}.ts`) make of texts the corpus
// does not have, for `rail_core::parsers` to replay (docs/RAIL-PLAN.md R0.7b),
// plus the pre-PHF converter's output the byte-compatibility test measures
// against.
//
//     cd tests && npm ci                 (esbuild)
//     node core/rail-core/tests/data/wpcp-vectors.mjs
//
// The goldens pin every corpus hand through the pipeline with the default
// options. This file adds, by seeded mutation of corpus hands, the branches
// the corpus leaves alone:
//
//  - `splits`: per corpus file (all of `testdata/golden/`, decoded with the
//    app's `decodeSource`), the 16-hex sha-256 of `JSON.stringify` of both
//    parsers' `splitHands`, plus hand-written split edge cases.
//  - `detect`: both parsers' per-mille scores of hand-written probes.
//  - `cases`: a chunk of a corpus file (`file`, the parser whose split cut it,
//    the chunk index) with a list of line edits applied, and that parser's
//    detection score and `parseHand` outcome with the default options and
//    with the strict ones (`cashOnly`, and for WePlay `skipBombPots`): the
//    refusal's reason and message, the message of anything else thrown, or
//    the 16-hex sha-256 of the canonical JSON of the hand (`parsedAt`
//    pinned). WePlay cases also carry `normalizeWeplayChunk`'s answer (the
//    hash of the standard text, or the refusal).
//  - `legacy`: per `weplay-hh/` file, read as `weplayFiles()` reads it (UTF-8,
//    nothing normalized), the hands the frozen pre-PHF converter
//    (`tests/test/legacy/legacyConverter.ts`) emits: id, the 16-hex sha-256
//    of its text, and the text itself where it differs from today's
//    `toStandardText`; with `byteCompat.test.ts`'s totals.
//
// Edits are those of `psgg-vectors.mjs` (`delete`, `insert`, `replace`,
// `swap`, `truncate`, `join`, `prefix`; `{P}`/`{Q}`/`{ID}` substituted here).
//
// Bundles the TypeScript with esbuild from tests/node_modules. Deterministic
// (seeded), so rerunning it rewrites the same file as long as the corpus and
// the TypeScript are the same.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(join(ROOT, "tests/package.json"));
const esbuild = require("esbuild");

const bundle = await esbuild.build({
  stdin: {
    contents: `
      export { weplayParser, normalizeWeplayChunk } from "./frontend/src/lib/parsers/weplay.ts";
      export { coinpokerParser } from "./frontend/src/lib/parsers/coinpoker.ts";
      export { convertAny } from "./frontend/src/lib/parsers/index.ts";
      export { ParseSkip } from "./frontend/src/lib/phf/detect.ts";
      export { splitStandardHands, toStandardText } from "./frontend/src/lib/phf/serialize.ts";
      export { decodeSource } from "./frontend/src/components/converter/inputs.ts";
      export { canonicalJson } from "./tests/scripts/golden/canonical.ts";
      export { convertCashWeplayFile as legacyConvert } from "./tests/test/legacy/legacyConverter.ts";
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
  weplayParser,
  normalizeWeplayChunk,
  coinpokerParser,
  convertAny,
  ParseSkip,
  splitStandardHands,
  toStandardText,
  decodeSource,
  canonicalJson,
  legacyConvert,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const PARSED_AT = "1970-01-01T00:00:00.000Z";
const PARSERS = { weplay: weplayParser, coinpoker: coinpokerParser };
const OPTIONS = {
  weplay: { cashOnly: true, skipBombPots: true },
  coinpoker: { cashOnly: true },
};

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const short = (text) => sha(text).slice(0, 16);

/** A built hand as the goldens hash it: through JSON (drops `undefined`, `-0`). */
function handHash(value) {
  return short(canonicalJson(JSON.parse(JSON.stringify(value))));
}

function outcome(parser, text, options) {
  try {
    const hand = parser.parseHand(text, { sourceFilename: null, options });
    hand.meta.parsedAt = PARSED_AT;
    return { hand: handHash(hand) };
  } catch (error) {
    if (error instanceof ParseSkip) {
      return { skip: [error.reason, error.message] };
    }
    return { error: String(error?.message ?? error) };
  }
}

function normalized(text) {
  const result = normalizeWeplayChunk(text);
  return "skip" in result
    ? { skip: [result.skip.reason, result.skip.message] }
    : { text: short(result.text), id: result.handId };
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

const GOLDEN = join(ROOT, "testdata/golden");
const files = walk(GOLDEN).map((path) => {
  const input = relative(GOLDEN, path).replace(/\\/g, "/").replace(/\.json$/, "");
  const golden = JSON.parse(readFileSync(path, "utf8"));
  const bytes = readFileSync(join(ROOT, input));
  const decoded = decodeSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
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
// `WPCP_STRESS=<seed>` draws many more mutations from another seed, for a
// local soak run (the committed file is the default).
const STRESS = process.env.WPCP_STRESS ? Number(process.env.WPCP_STRESS) : null;
const random = mulberry32(STRESS ?? 0x5eed0b07);
const pick = (list) => list[Math.floor(random() * list.length)];
const below = (n) => Math.floor(random() * n);

/* --------------------------------------------------------- the edits --- */

const WEPLAY_LINES = [
  "{P}: folds",
  "{P}: checks",
  "{P}: calls $1",
  "{P}: calls $0.10 and is all-in",
  "{P}: calls 100 and is all-in",
  "{P}: bets $2",
  "{P}: bets $0.5 and is all-in",
  "{P}: bets 300",
  "{P}: raises $1 to $2",
  "{P}: raises $2.50 to $3",
  "{P}: raises $1.50 to $2.50",
  "{P}: raises $7.40 to $7.90 and is all-in",
  "{P}: raises $100 to $100.50 and is all-in",
  "{P}: raises 200 to 400",
  "{P}: raises 1000 to 1500 and is all-in",
  "{P}: raises €1 to €2",
  "{P}: raises $0.015 to $0.035",
  "{P}: raises $1 to $1",
  "{P}: posts small blind $0.25",
  "{P}: posts small blind $0.10 and is all-in",
  "{P}: posts small blind 25 and is all-in",
  "{P}: posts big blind $0.50",
  "{P}: posts big blind $0.20 and is all-in",
  "{P}: posts big blind 100",
  "{P}: posts straddle $1",
  "{P}: posts straddle 400",
  "{P}: posts the ante $0.10",
  "{P}: posts the ante 25",
  "Ghost: posts the ante $0.10",
  "{P}: posts $1",
  "{P}: posts bomb pot $1",
  "{P}: posts missed blind $0.25",
  "Uncalled bet ($100) returned to {P}",
  "Uncalled bet ($0.5) returned to {Q}",
  "Uncalled bet (50) returned to {P}",
  "Uncalled bet ($1) returned to Ghost",
  "{P}: shows [## ##]",
  "{P}: shows [Ah ##] (a pair)",
  "{P}: shows [Ah Kd] (a pair of Kings)",
  "{P}: mucks hand",
  "{P}: doesn't show hand",
  "{P} collected $1 from pot",
  "{P} collected $1.50 from side pot",
  "{P} collected 300 from main pot",
  "Ghost collected $1 from pot",
  "Ghost: calls $1",
  "Ghost: folds",
  "Ghost: shows [Ah Kd]",
  "*** HOLE CARDS ***",
  "Dealt to {P} [Ah Kd]",
  "Dealt to {Q} [## ##]",
  "*** FLOP *** [2d 7d 6c]",
  "*** TURN *** [2d 7d 6c] [Tc]",
  "*** RIVER *** [2d 7d 6c Tc] [5h]",
  "*** FIRST FLOP *** [2d 7d 6c]",
  "*** FIRST TURN *** [2d 7d 6c] [Tc]",
  "*** FIRST RIVER *** [2d 7d 6c Tc] [5h]",
  "*** SECOND FLOP *** [Jc 4c Td]",
  "*** SECOND TURN *** [Jc 4c Td] [Th]",
  "*** SECOND RIVER *** [Jc 4c Td Th] [6d]",
  "*** SHOW DOWN ***",
  "*** SHOWDOWN ***",
  "*** FIRST SHOW DOWN ***",
  "*** SECOND SHOW DOWN ***",
  "*** BOMB POT ***",
  "*** SUMMARY ***",
  "Board [2d 7d 6c]",
  "Board [2d 7d 6c Tc 5h]",
  "FIRST Board [2d 7d 6c Tc 5h]",
  "SECOND Board [Jc 4c Td Th 6d]",
  "Hand was run two times",
  "Seat 9: Ghost ($0 in chips)",
  "Seat 9: Zero ($0.00 in chips)",
  "Seat 9: Chips (0 in chips)",
  "Seat 9: {P} ($0 in chips)",
  "Seat 8: Late ($25 in chips)",
  "Seat 3: {P} (button) folded before Flop showed [Ah Kd]",
  "Seat 3: {P} folded on the Turn and lost with high card",
  "Seat 3: {P} showed [## ##] and lost with high card",
  "Seat 3: {P} (big blind) showed [Ah #s] and lost",
  "Seat 4: {Q} showed [Ah Kd] and won ($2) with a pair",
  "Seat 4: {Q} (small blind) collected ($1.50)",
  "Seat 5: {P} mucked [Td 7d]",
  "Total pot $11 | Rake $0.55 ",
  "Total pot $3",
  "Total pot 1500 | Rake 0",
  "Total pot €3 | Rake €0.15",
  "Table 'Lisbon #1'(11485806) 6-max (Money 3) Seat #5 is the button",
  "Table 'Manchester  #3'(1) 9-max  Seat #1 is the button",
  "Table 'All-in or Fold'(1) 6-max Seat #1 is the button",
  "Table 'Bomb Pot #1'(11485806) 6-max (Money 3) Seat #2 is the button",
  "{P} has timed out",
  "{P} has timed out while being disconnected",
  "{P} leaves the table",
  "{P} joins the table at seat #3",
  "{P} sits out",
  "{P}: activates time bank",
  "{P} declines straddle",
  "{P} is disconnected",
  "{P} is connected",
  "{P} said, \"nh\"",
  "   ",
  "",
  "something nobody writes",
];

const WEPLAY_HEADERS = [
  "Weplay Hand #{ID}:  Hold'em No Limit ($0.25/$0.50) - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}:  Hold'em No Limit ($1/$2) - 2026/01/03 2:12:42 UTC",
  "Weplay Hand #{ID}:  Hold'em No Limit (€0.25/€0.50) - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}:  Hold'em No Limit (£1/£2) - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}:  Hold'em No Limit ($0.25/$0.50) - 2026/01/03 22:12:42",
  "Weplay Hand #{ID}:  Hold'em No Limit ($0.25/$0.50) - 2026/02/31 22:12:42   UTC",
  "Weplay Hand #{ID}:  Hold'em No Limit - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}:  Omaha 6 Cards Pot Limit ($0.50/$1) - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}:  PLO Pot Limit ($0.50/$1) - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}:  Hold'em No Limit ($0.25/$0.50) All-in or Fold - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}: Tournament (Monday Main)#11264971, $50+$5 Hold'em No Limit - Level XIX (50/100) - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}: Tournament (ILWP series - Red Rose PKO)#11275295, $15+$3 Hold'em No Limit - Level XIII (100/200) - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}: Tournament (Freeroll)#1, $0 Hold'em No Limit - Level I (10/20) - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}: tournament (x)#2, $1+$0.10 Hold'em No Limit - Level 3 (25/50) - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}:  Hold'em No Limit ($0.005/$0.01) - 2026/01/03 22:12:42 UTC",
  "Weplay Hand #{ID}:",
  "Weplay Hand #{ID}: something without stakes",
  "Weplay Hand #x{ID}: Hold'em No Limit ($1/$2) - 2026/01/03 22:12:42 UTC",
];

const COINPOKER_LINES = [
  "{P}: folds",
  "{P}: checks",
  "{P}: calls 0.02",
  "{P}: calls 0.05 and is all-in",
  "{P}: calls 0.015",
  "{P}: bets 0.10",
  "{P}: bets 13.5",
  "{P}: bets 500 and is all-in",
  "{P}: raises 0.16 to 0.18",
  "{P}: raises 0.46 and is all-in",
  "{P}: raises 4887 and is all-in",
  "{P}: raises 100 to 200 and is all-in",
  "{P}: posts small blind 0.01",
  "{P}: posts big blind 0.02",
  "{P}: posts big blind 0.02 and is all-in",
  "{P}: posts small blind (dead) 0.01",
  "{P}: posts big blind (dead) 0.02",
  "{P}: posts straddle 0.04",
  "Ghost: posts straddle 0.04",
  "{P}: posts the ante 13",
  "{P}: posts the ante 13 and is all-in",
  "{P}: posts 0.02",
  "Uncalled bet (0.10) returned to {P}",
  "Uncalled bet (100) returned to {Q}",
  "{P} collected 0.20 from pot",
  "{P} collected 52 from side-pot 1",
  "Ghost collected 1 from pot",
  "Ghost: calls 0.02",
  "Dealt to {P} [Ah Kd]",
  "Dealt to Ghost [2c 3c]",
  "Dealt to {Q} []",
  "*** HOLE CARDS ***",
  "*** FLOP *** [Jd 6c 5h]",
  "*** TURN *** [Jd 6c 5h] [5c]",
  "*** RIVER *** [Jd 6c 5h 5c] [2s]",
  "*** SHOW DOWN ***",
  "*** SHOWDOWN ***",
  "*** HAND CANCELLED ***",
  "All bets returned (1310)",
  "*** SUMMARY ***",
  "Total pot 0.21 | Rake 0.01",
  "Total pot 11 | Rake 1 | Jackpot 0",
  "Total pot 0.215 | Rake 0.01",
  "Board [ Jd 6c 5h 5c ]",
  "Board [ ]",
  "Board [Jd 6c 5h]",
  "Game ended: 2025/06/19 18:53:39 GMT",
  "Seat 3: {P} (straddle) showed [3h Ts]",
  "Seat 3: {P} (button) (straddle) showed [3h Ts] and won (0.20) with a pair",
  "Seat 3: {P} (straddle) folded before Flop (didn't bet)",
  "Seat 3: {P} (straddle) mucked [3h Ts]",
  "Seat 3: {P} (straddle) something",
  "Seat 2: {Q} (button) folded before Flop (didn't bet)",
  "Seat 1: {P} mucked [Ah Kd]",
  "Seat 1: {P} (big blind) collected (5715)",
  "Seat 8: Out (2.00 in chips) out of hand",
  "Seat 8: Sit (2.00 in chips) is sitting out",
  "Seat 8: Odd (2.005 in chips)",
  "Seat 9: {P} (2.00 in chips)",
  "Table 'NL ₮2 I' 7-max Seat #9 is the button",
  "Table '' 6-max Seat #1 is the button",
  "{P}: shows [Ah Kd] (three of kind, Queens)",
  "{P}: shows [Ah Kd]",
  "{P}: mucks hand",
  "{P}: doesn't show hand",
  "{P} has timed out",
  "{P} is disconnected",
  "{P} has reconnected",
  "{P} activated time-bank (20 seconds)",
  "{P}: didn't post big blind",
  "{P} said hello",
  "",
  "something nobody writes",
];

const COINPOKER_HEADERS = [
  "CoinPoker Hand #{ID}: Hold'em No Limit (0.01/0.02 ) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Hold'em No Limit (1/2 ) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Hold'em No Limit (0.01/0.02) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Omaha Pot Limit (0.01/0.02 ) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Omaha Hi/Lo Pot Limit (0.01/0.02 ) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Short Deck No Limit (0.01/0.02 ) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Tournament #1287469, ₮0.10 Mega Sat to ₮1 Mini Dojo PKO, 15 Seats GTD Hold'em No Limit (50/100 ante 13 play) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Tournament #1, Daily Freeroll Hold'em No Limit (10/20) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Tournament #1, Hold'em No Limit (10/20 play) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Tournament #1, Big Omaha Pot Limit (10/20) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Tournament #1, Daily (10/20) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Tournament #1, 7 Card Stud Limit (10/20) 2025/06/19 18:53:04 GMT",
  "CoinPoker Hand #{ID}: Hold'em No Limit (0.01/0.02 ) 2025/02/31 25:53:04 GMT",
  "CoinPoker Hand #{ID}: something",
];

function seatNames(lines) {
  const names = [];
  for (const line of lines) {
    const m = line.match(/^Seat (\d+): (.+?) \(([^)]+) in chips\)/);
    if (m && !names.includes(m[2])) names.push(m[2]);
  }
  return names;
}

function fill(template, names, id) {
  return template
    .replaceAll("{P}", names[0] ?? "Hero")
    .replaceAll("{Q}", names[1] ?? names[0] ?? "Villain")
    .replaceAll("{ID}", id);
}

const AMOUNTS = {
  weplay: ["0", "1", "2.5", "0.05", "10", "100.00", "0.10", "7.5", "0.005", "2.505", "99999999999999999999"],
  coinpoker: ["0", "1", "2.50", "0.05", "10", "0.10", "7.5", "0.005", "13.5", "1,000"],
};

/** One random edit of `lines`, as an op (with its text already final). */
function randomOp(lines, names, id, site) {
  const at = 1 + below(Math.max(1, lines.length - 1));
  const catalogue = site === "weplay" ? WEPLAY_LINES : COINPOKER_LINES;
  switch (below(12)) {
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
      const replaced =
        line.slice(0, n.index) + pick(AMOUNTS[site]) + line.slice(n.index + n[0].length);
      return ["replace", at, replaced];
    }
    case 5:
    case 6:
    case 7:
      return ["insert", at, fill(pick(catalogue), names, id)];
    case 8:
      return [
        "replace",
        0,
        fill(pick(site === "weplay" ? WEPLAY_HEADERS : COINPOKER_HEADERS), names, id),
      ];
    case 9: {
      const summary = lines.findIndex((line) => /^\*\*\*\s*SUMMARY/i.test(line));
      return summary > 0 ? ["truncate", summary] : ["truncate", at];
    }
    case 10:
      return ["replace", at, `${lines[at] ?? ""} `];
    default:
      return ["replace", at, fill(pick(catalogue), names, id)];
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
  "Weplay Hand #1: x",
  "\uFEFFWeplay Hand #1: a\r\nWeplay Hand #2: b\rWeplay Hand #3: c\u2028Weplay Hand #4: d",
  "junk\n\uFEFFWeplay Hand #1: a\n\n",
  "Weplay Hand #x: a\nWeplay Hand #1: b Weplay Hand #2: c",
  "\uFEFF\uFEFFWeplay Hand #1: a\n\uFEFFWeplay Hand #2: b",
  "CoinPoker Hand #1: x",
  "\uFEFFCoinPoker Hand #1: a\r\nCoinPoker Hand #2: b\rCoinPoker Hand #3: c\u2029CoinPoker Hand #4: d",
  "junk\nCoinPoker Hand #1: a\n\nCoinPoker Hand #: b\nCoinPoker Hand #2:c",
  "\uFEFF\uFEFFCoinPoker Hand #1: a\n\uFEFFCoinPoker Hand #2: b",
  " CoinPoker Hand #1: a",
];
for (const text of SPLIT_TEXTS) {
  splits.push({
    text,
    weplay: short(JSON.stringify(weplayParser.splitHands(text))),
    coinpoker: short(JSON.stringify(coinpokerParser.splitHands(text))),
  });
}

const DETECT_TEXTS = [
  "",
  "hello",
  "Weplay Hand #1:",
  "\uFEFFWeplay Hand #1: x",
  "x\n\uFEFFWeplay Hand #1: x",
  "x\rWeplay Hand #1: x",
  "x\u2028Weplay Hand #1: x",
  " Weplay Hand #1: x",
  "Weplay Hand #: x",
  "weplay hand #1: x",
  "a Weplay export",
  "CoinPoker Hand #1:",
  "\uFEFFCoinPoker Hand #1: x",
  "x\rCoinPoker Hand #12: y",
  "x\nCoinPoker Hand #12: y",
  "x\u2028CoinPoker Hand #12: y",
  "x CoinPoker Hand #12: y",
  "exported from CoinPoker",
  "CoinPokerX",
  "Seat 1: alice (2.00 in chips)",
  "Game ended: 2025/06/19 18:53:39 GMT",
  "PokerStars Hand #1: x",
];
const detect = DETECT_TEXTS.map((text) => ({
  text,
  weplay: permille(weplayParser, text),
  coinpoker: permille(coinpokerParser, text),
}));

for (const file of files) {
  if (file.text === null) continue;
  splits.push({
    file: file.input,
    weplay: short(JSON.stringify(weplayParser.splitHands(file.text))),
    coinpoker: short(JSON.stringify(coinpokerParser.splitHands(file.text))),
  });
}

const cases = [];
function record(base, ops, text) {
  const site = base.split;
  const parser = PARSERS[site];
  const entry = {
    ...base,
    ops,
    detect: permille(parser, text),
    outcome: outcome(parser, text, {}),
    strict: outcome(parser, text, OPTIONS[site]),
  };
  if (site === "weplay") entry.normalized = normalized(text);
  cases.push(entry);
}

for (const file of files) {
  if (file.text === null || !["weplay", "coinpoker"].includes(file.top)) continue;
  const site = file.top;
  const chunks = PARSERS[site].splitHands(file.text);
  chunks.forEach((chunk, index) => {
    const lines = chunk.split("\n");
    const names = seatNames(lines);
    const id = (lines[0].match(/#(\w+):/) ?? [])[1] ?? "1";
    const base = { file: file.input, split: site, chunk: index };
    // WePlay has 6 800 corpus chunks, all in the goldens already: one in
    // three is recorded with a mutation, one in fifty as it is (for the
    // strict options). CoinPoker's 22 get forty mutations each.
    let count;
    if (site === "coinpoker") {
      record(base, [], chunk);
      count = STRESS !== null ? 400 : 40;
    } else {
      if (random() < 0.02) record(base, [], chunk);
      count = STRESS !== null ? 3 : random() < 1 / 3 ? 1 : 0;
    }
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

/* ------------------------------------------------------- byte compat --- */

// `weplayFiles()` of `tests/test/support/corpus.ts`: both account folders,
// directories by `localeCompare`, files sorted, read as UTF-8 as they are.
const WEPLAY = join(ROOT, "weplay-hh");
const weplayFiles = readdirSync(WEPLAY, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((entry) =>
    readdirSync(join(WEPLAY, entry.name))
      .filter((name) => name.endsWith(".txt"))
      .sort()
      .map((name) => ({
        name,
        relativePath: `weplay-hh/${entry.name}/${name}`,
        text: readFileSync(join(WEPLAY, entry.name, name), "utf8"),
      })),
  );

function handsById(text) {
  const out = new Map();
  for (const chunk of splitStandardHands(text)) {
    const id = chunk.split("\n")[0].match(/#(\S+):/)?.[1];
    if (id) out.set(id, chunk);
  }
  return out;
}

function classify(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const onlyOld = a.filter((line) => !b.includes(line));
  const onlyNew = b.filter((line) => !a.includes(line));
  if (onlyOld.length === 0 && onlyNew.length === 0) return "duplicate-hole-cards-block";
  if (onlyOld.every((line) => /activates time bank/.test(line)) && onlyNew.length === 0) {
    return "time-bank-line";
  }
  if (
    /: posts straddle /.test(oldText) &&
    onlyOld.every((line) => /: raises /.test(line)) &&
    onlyNew.every((line) => /: raises /.test(line))
  ) {
    return "straddle-raise-amount";
  }
  return null;
}

const legacy = { files: [], totals: { legacyHands: 0, identical: 0, accepted: {}, dropped: 0 } };
for (const file of weplayFiles) {
  const old = legacyConvert(file.name, file.text);
  const expected = old.status === "converted" ? handsById(old.outputText) : new Map();
  const result = await convertAny(file.text, {
    sourceFilename: file.name,
    cashOnly: true,
    skipBombPots: true,
  });
  const actual = new Map(result.hands.map((hand) => [hand.meta.handId, toStandardText(hand)]));
  const hands = [];
  for (const [id, text] of expected) {
    legacy.totals.legacyHands += 1;
    const fresh = actual.get(id);
    const entry = { id, sha: short(text) };
    if (fresh === undefined) {
      if (!result.failures.find((failure) => failure.rawText.includes(id.slice(2)))) {
        throw new Error(`${id}: missing with no failure record`);
      }
      legacy.totals.dropped += 1;
    } else if (fresh === text) {
      legacy.totals.identical += 1;
    } else {
      const kind = classify(text, fresh);
      if (!kind) throw new Error(`${id}: unclassified difference`);
      legacy.totals.accepted[kind] = (legacy.totals.accepted[kind] ?? 0) + 1;
      entry.text = text;
    }
    hands.push(entry);
  }
  legacy.files.push({ path: file.relativePath, hands });
}

const out = { splits, detect, cases, legacy };
writeFileSync(
  fileURLToPath(new URL("./wpcp-vectors.json", import.meta.url)),
  `${JSON.stringify(out, null, 0)}\n`,
);
console.log(
  `${splits.length} splits, ${detect.length} detections, ${cases.length} cases ` +
    `(${cases.filter((c) => c.split === "weplay").length} WePlay), ` +
    `legacy ${JSON.stringify(legacy.totals)}`,
);
