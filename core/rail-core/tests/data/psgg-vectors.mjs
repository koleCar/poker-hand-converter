// Writes psgg-vectors.json: what the TypeScript PokerStars and GGPoker parsers
// (`frontend/src/lib/parsers/{pokerstars,ggpoker}.ts`) and the shared
// PokerStars-clone dispatcher (`shared/p3-stars-dialect.ts`) make of texts the
// corpus does not have, for `rail_core::parsers` to replay
// (docs/RAIL-PLAN.md R0.7a).
//
//     cd tests && npm ci                 (esbuild)
//     node core/rail-core/tests/data/psgg-vectors.mjs
//
// The goldens pin every corpus hand. This file adds the branches the corpus
// leaves alone, by seeded mutation of corpus hands:
//
//  - `splits`: per corpus file (all of `testdata/golden/`, decoded with the
//    app's `decodeSource`), the 16-hex sha-256 of `JSON.stringify` of both
//    parsers' `splitHands`, plus hand-written split edge cases.
//  - `cases`: a chunk of a corpus file (`file`, the parser whose split cut it,
//    the chunk index) with a list of line edits applied; for each, both
//    parsers' detection score (per-mille) and `parseHand` outcome: the
//    refusal's reason and message, the message of anything else thrown, or the
//    16-hex sha-256 of the canonical JSON of the hand (`parsedAt` pinned).
//  - `dialect`: Run It Once and PokerBros chunks (and mutations) through
//    `parseStarsFamilyBody` into a fixed `StarsHandDraft`, with the hash of
//    the canonical JSON of `{ body, hand }` (or what `build` threw).
//
// Edits are applied to the chunk's lines (`chunk.split("\n")`, the chunks are
// LF-only): `["delete", i]`, `["insert", i, text]`, `["replace", i, text]`,
// `["swap", i]` (lines i and i+1), `["truncate", i]` (keep lines before i),
// then `["join", sep]` re-joins with `sep` instead of `\n` and
// `["prefix", text]` prepends text to the whole chunk. In an inserted or
// replacing text, `{P}`/`{Q}` are the first/second seat names of the chunk
// and `{ID}` its hand id - substituted here, so the JSON holds the final text.
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
      export { pokerstarsParser } from "./frontend/src/lib/parsers/pokerstars.ts";
      export { ggpokerParser } from "./frontend/src/lib/parsers/ggpoker.ts";
      export { StarsHandDraft } from "./frontend/src/lib/parsers/shared/ps-gg-hand.ts";
      export { parseStarsFamilyBody } from "./frontend/src/lib/parsers/shared/p3-stars-dialect.ts";
      export { ParseSkip } from "./frontend/src/lib/phf/detect.ts";
      export { DEFAULT_TEXT_STYLE, EUR, USD } from "./frontend/src/lib/phf/types.ts";
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
  pokerstarsParser,
  ggpokerParser,
  StarsHandDraft,
  parseStarsFamilyBody,
  ParseSkip,
  DEFAULT_TEXT_STYLE,
  EUR,
  USD,
  decodeSource,
  canonicalJson,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const PARSED_AT = "1970-01-01T00:00:00.000Z";
const CTX = { sourceFilename: null, options: {} };
const PARSERS = { pokerstars: pokerstarsParser, ggpoker: ggpokerParser };

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const short = (text) => sha(text).slice(0, 16);

/** A built hand as the goldens hash it: through JSON (drops `undefined`, `-0`). */
function handHash(value) {
  return short(canonicalJson(JSON.parse(JSON.stringify(value))));
}

function outcome(parser, text) {
  try {
    const hand = parser.parseHand(text, CTX);
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
// `PSGG_STRESS=<seed>` draws many more mutations from another seed, for a
// local soak run (the committed file is the default).
const STRESS = process.env.PSGG_STRESS ? Number(process.env.PSGG_STRESS) : null;
const random = mulberry32(STRESS ?? 0x5eed0007);
const pick = (list) => list[Math.floor(random() * list.length)];
const below = (n) => Math.floor(random() * n);

/* --------------------------------------------------------- the edits --- */

const COMMON_LINES = [
  "{P}: folds",
  "{P}: checks",
  "{P}: folds [Ks]",
  "{P}: checks [Ah 2c]",
  "{P}: calls $1",
  "{P}: calls 100",
  "{P}: bets $1 and is all-in",
  "{P}: raises $1 to $2",
  "{P}: raises 100 to 200 and is all-in",
  "{P}: raises $1 to $2 and has reached the $2 cap",
  "{P}: posts small blind $0.05",
  "{P}: posts big blind 100 and is all-in",
  "{P}: posts the ante $0.02",
  "{P}: posts the ante 25",
  "{P}: posts small & big blinds $0.15",
  "{P}: posts small and big blind 150",
  "{P}: posts $0.05",
  "{P}: posts 500",
  "{P}: shows [Ah Kd] (a pair of Kings)",
  "{P}: shows [Qc]",
  "{P}: mucks hand",
  "{P}: doesn't show hand",
  "{P} collected $1 from pot",
  "{P} collected 200 from side pot-1",
  "{P} collected $1.50 from main pot",
  "Uncalled bet ($1) returned to {P}",
  "Uncalled bet (100) returned to {Q}",
  "Dealt to {P} [Ah Kd]",
  "Dealt to {Q} ",
  "Dealt to Ghost [2c 3c]",
  "Dealt to {P} [Ah Kd Qs Jc]",
  "Ghost: calls $1",
  "Ghost: folds",
  "Seat 9: Ghost ($10 in chips)",
  "Seat 9: {P} ($10 in chips)",
  "Seat 8: Sleeper (1500 in chips) is sitting out",
  "Seat 7: Out ($5 in chips) sitting out",
  "*** HOLE CARDS ***",
  "*** FLOP *** [2d 7d 6c]",
  "*** TURN *** [2d 7d 6c] [Tc]",
  "*** RIVER *** [2d 7d 6c Tc] [5h]",
  "*** FIRST FLOP *** [2d 7d 6c]",
  "*** SECOND FLOP *** [Jc 4c Td]",
  "*** SECOND TURN *** [Jc 4c Td] [Th]",
  "*** SECOND RIVER *** [Jc 4c Td Th] [6d]",
  "*** THIRD RIVER *** [9s]",
  "*** SHOW DOWN ***",
  "*** SHOWDOWN ***",
  "*** FIRST SHOW DOWN ***",
  "*** SECOND SHOWDOWN ***",
  "*** SUMMARY ***",
  "Total pot $170 Main pot $60. Side pot-1 $60. Side pot-2 $2. | Rake $48",
  "Total pot $3 | Rake $0.15 | Jackpot $0.05 | Bingo $0 | Fortune $0.01 | Tax $0",
  "Total pot 1234",
  "Total pot $0 | Rake $0",
  "Hand was run twice",
  "Hand was run two times",
  "Hand was run three times",
  "FIRST",
  "SECOND",
  "FIRST Board [2d 7d 6c Tc 5h]",
  "SECOND Board [Jc 4c Td Th 6d]",
  "Board [2d 7d 6c Tc]",
  "Board [2d 7d 6c]",
  "Seat 1: {P} (button) mucked [Td 7d]",
  "Seat 2: {Q} (small blind) folded on the Turn",
  "Seat 2: {Q} (big blind) folded before Flop (didn't bet)",
  "Seat 3: {P} showed [Ah Kd] and won ($1) with a pair, and lost with high card",
  "Seat 3: {P} (button) (small blind) showed [Ah Kd] and lost with a pair of Kings",
  "Seat 4: {Q} collected ($2.50)",
  "Seat 4: {Q} won (250)",
  "Seat 5: {P} showed [Ah Kd] and won ($1) with a pair, Cashout Risk ($19)",
  "Seat 6: {P} mucked",
  "No low hand qualified",
  "Hand cancelled",
  "{P} is sitting out",
  "{P}: sits out",
  "{P}: is sitting out",
  "{P} has timed out",
  "{P} has returned",
  "{P} said, \"nh\"",
  "{P} joins the table at seat #4",
  "{P} leaves the table",
  "{P} is disconnected",
  "{P} finished the tournament in 9th place",
  "{P} wins the $2.50 bounty for eliminating {Q}",
  "{P} wins $1.25 for splitting the elimination of {Q}",
  "{P} wins the 500 bounty for eliminating {Q}",
  "Ghost wins the $2.50 bounty for eliminating {Q}",
  "{P} re-buys and receives 3000 chips for $5.00",
  "Level changed",
  "{P}: straddle $0.4",
  "{P}: straddle 400 and is all-in",
  "{P}: posts straddle $1",
  "{P}: posts button blind $0.02",
  "{P}: posts missed blind $0.1",
  "{P}: Chooses to EV Cashout",
  "{P}: Pays Cashout Risk ($19)",
  "{P}: get an all-in insurance (premium ($0/$4/$0) for ($0/$10.8/$0) - (Mandatory/Main/Sub))",
  "{P}: pay premium of all-in insurance ($4)",
  "Ghost: pay premium of all-in insurance ($4)",
  "Cash Drop to Pot : total $0.2",
  "cash drop to pot: total 20",
  "*** BOMB POT ***",
  "*** PREFLOP ***",
  "{P} enters the table",
  "{P} received a reward",
  "{P} declines straddle",
  "something nobody writes",
  "  Dealt to {P} [Ah Kd]",
];

const PS_HEADERS = [
  "PokerStars Hand #{ID}:  Hold'em No Limit ($0.25/$0.50 USD) - 2012/09/11 8:39:12 ET",
  "PokerStars Hand #{ID}:  Hold'em No Limit ($0.25/$0.50 - $10 Cap -  USD) - 2012/09/11 18:39:12 ET",
  "PokerStars Hand #{ID}:  Omaha Hi/Lo Pot Limit ($0.25/$0.50 USD) - 2012/09/11 8:39:12 ET",
  "PokerStars Hand #{ID}:  Omaha Pot Limit ($0.25/$0.50 CAD) - 2012/09/11 8:39:12 ET",
  "PokerStars Hand #{ID}:  Razz Limit ($0.25/$0.50 USD) - 2012/09/11 8:39:12 ET",
  "PokerStars Hand #{ID}:  7 Card Stud Hi/Lo Limit ($0.25/$0.50 USD) - 2012/09/11 8:39:12 ET",
  "PokerStars Hand #{ID}:  5 Card Omaha Pot Limit (€0.25/€0.50 EUR) - 2012/09/11 8:39:12 ET",
  "PokerStars Hand #{ID}:  6+ Hold'em No Limit ($0.05 ante/$0.10) - 2019/01/01 10:00:00 ET",
  "PokerStars Hand #{ID}:  Hold'em No Limit (¥100/¥200 CNY) - 2019/01/01 10:00:00 ET",
  "PokerStars Hand #{ID}:  Hold'em No Limit (Rs. 10/Rs. 20) - 2019/01/01 10:00:00",
  "PokerStars Hand #{ID}:  Fusion No Limit ($0.01/$0.02 USD) - 2019/01/01 10:00:00 ET",
  "PokerStars Hand #{ID}:  Split Holdem No Limit ($0.01/$0.02 USD) - 2019/01/01 10:00:00 ET",
  "PokerStars Hand #{ID}:  Hold'em Pot Limit Pre-Flop, No Limit Post-Flop ($0.25/$0.50 USD) - 2012/09/11 8:39:12 ET",
  "PokerStars Hand #{ID}: Tournament #3000000001, $10+$1 USD Hold'em No Limit - Level V (75/150) - 2019/05/05 12:00:00 ET",
  "PokerStars Hand #{ID}: Tournament #3, $1.00+$0.25+$0.15 USD Hold'em No Limit - Level IX (10/20/5) - 2019/05/05 2:00:00 ET",
  "PokerStars Hand #{ID}: Tournament #3, 2000+110 Hold'em No Limit - Match Round I, Level IV (50/100) - 2019/05/05 12:00:00 CET [2019/05/05 6:00:00 ET]",
  "PokerStars Hand #{ID}: Tournament #3, Freeroll  Hold'em No Limit - Level XIV (1,000/2,000) - 2019/02/31 25:00:00 ET",
  "PokerStars Hand #{ID}: Tournament #3, £5.00+£0.50 GBP Hold'em No Limit - Level ıv (75/150) - 2019/02/31 23:00:00 ET",
  "PokerStars Hand #{ID}: Tournament #3, $4+$4+$1+$1 Omaha Pot Limit - Level 12 (75/150) - 2019/05/05 12:00:00 ET",
  "PokerStars Hand #{ID}: Tournament #3, $10+$1 Hold'em No Limit - Level V (¥75/¥150) - 2019/05/05 12:00:00 ET",
  "PokerStars Zoom Hand #{ID}:  Hold'em No Limit ($0.01/$0.02) - 2017/06/10 17:17:14 UTC [2017/06/10 13:17:14 ET]",
  "PokerStars Home Game Hand #{ID}: {Club #3225207} Hold'em No Limit (50/100) - 2019/01/01 10:00:00 ET",
  "PokerStars Home Game Zoom Hand #{ID}: {} Hold'em No Limit (50/100) - 2019/01/01 10:00:00 ET",
  "PokerStars Game #{ID}: Hold'em Limit ($0.10/$0.20) - 2008/01/01 10:00:00 ET",
  "PokerStars Hand #{ID}: Mixed Hold'em (Hold'em Limit) ($1/$2) - 2019/01/01 10:00:00 ET",
  "PokerStars Hand #{ID}: Hold'em No Limit (50) - 2019-01-01T10:00:00",
  "PokerStars Hand #{ID}: something without stakes",
  "PokerStars Hand #{ID}: Hold'em No Limit ($1/$2) - 2019/13/01 10:00:00 ET",
];

const GG_HEADERS = [
  "Poker Hand #{ID}: Hold'em No Limit ($0.05/$0.1) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: Hold'em No Limit ($0.05/$0.1) - 2026/03/01 9:00:00",
  "Poker Hand #{ID}: Hold'em No Limit (€0.05 / €0.1) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: Hold'em No Limit (5/10 CAD) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: PLO-6 ($0.25/$0.5) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: PLO-5 ($0.25/$0.5) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: PLO ($0.25/$0.5) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: NLO ($0.25/$0.5) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: Omaha Hi/Lo Pot Limit ($0.25/$0.5) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: ShortDeck No Limit ($0.02) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: 6+ Hold'em No Limit ($0.25/$0.5) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: Razz Limit ($1/$2) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: Tournament #8205074, Daily Special $55 Hold'em No Limit - Level7 (150/300) - 2020/08/13 16:29:44",
  "Poker Hand #{ID}: Tournament #8205074, Freeroll Hold'em No Limit - Level7(150/300/25) - 2020/08/13 16:29:44",
  "Poker Hand #{ID}: Tournament #9364957, WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD Hold'em No Limit - Level10 (1,000/2,000) - 2020/08/13 16:29:44",
  "Poker Hand #{ID}: Tournament (Bounty Hunters $25) #1, $12.5+$12.5+$2 Hold'em No Limit - Level3 (20/40) - 2020/08/13 6:29:44",
  "Poker Hand #{ID}: Tournament () #1, $12.5+$12.5+$2 Hold'em No Limit - Level3 (20/40) - 2020/08/13 6:29:44",
  "Poker Hand #{ID}: Tournament #2, 2000+110 Omaha Pot Limit - Level XII (20/40) - 2020/08/13 16:29:44",
  "Poker Hand #{ID}: Tournament #2, $1,050 Hold'em - Level2 (20/40) - 2020/08/13 16:29:44",
  "Poker Hand #{ID}: Tournament #2, $55abc Hold'em No Limit - Level2 (20/40) - 2020/08/13 16:29:44",
  "Poker Hand #{ID}: Tournament #2, Big $10 + $1 Hold'em (6-max) No Limit - Level2 (20/40) - 2020/08/13 16:29:44",
  "Poker Hand #{ID}: Tournament #2, 10+1 Hold'em No Limit (ante) - Level 2 (20/40) - 2020/08/13 16:29:44",
  "Poker Hand #{ID}: Tournament #2, Mystery € 5,50+€0,50 PLO-5 Pot Limit - Level2 (20/40) - 2020/08/13 16:29:44",
  "GG Poker Hand #{ID}: Hold'em No Limit (₩100/₩200) - 2026/03/01 10:00:00",
  "GGPoker Hand #{ID}: Hold'em No Limit ($1/$2) - 2026/03/01 10:00:00",
  "Poker Hand #{ID}: Hold'em No Limit - 2026/03/01 10:00:00",
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

const AMOUNTS = ["0", "1", "2.5", "0.05", "10", "1,000", "100.00", "0.10", "7.5", "15.35"];

/** One random edit of `lines`, as an op (with its text already final). */
function randomOp(lines, names, id, site) {
  const at = 1 + below(Math.max(1, lines.length - 1));
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
      const replaced = line.slice(0, n.index) + pick(AMOUNTS) + line.slice(n.index + n[0].length);
      return ["replace", at, replaced];
    }
    case 5:
    case 6:
    case 7:
      return ["insert", at, fill(pick(COMMON_LINES), names, id)];
    case 8:
      return ["replace", 0, fill(pick(site === "pokerstars" ? PS_HEADERS : GG_HEADERS), names, id)];
    case 9: {
      const summary = lines.findIndex((line) => /^\*\*\*\s*SUMMARY/i.test(line));
      return summary > 0 ? ["truncate", summary] : ["truncate", at];
    }
    case 10:
      return ["replace", at, `${lines[at] ?? ""} `];
    default:
      return ["replace", at, fill(pick(COMMON_LINES), names, id)];
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
const cases = [];
const SPLIT_TEXTS = [
  "",
  "PokerStars Hand #1: x",
  "﻿PokerStars Hand #1: x\r\rPokerStars Hand #2: y\r",
  "junk\nPokerStars Zoom Hand #1: a\nb\n\n\nPokerStars Game #2: c",
  "PokerStars Hand #1: a PokerStars Hand #2: b",
  " PokerStars Hand #1: a\nPokerStars  Hand #2: b",
  "Poker Hand #1: a\nGG Poker Hand #2: b\nGGPoker Hand #3: c\nGG\nPoker Hand #4: d",
  "Poker Hand #RC1: a\r\nPoker Hand #: b\r\nPoker Hand #2:c Poker Hand #3: d",
  "﻿﻿Poker Hand #1: a\n﻿Poker Hand #2: b",
];
for (const text of SPLIT_TEXTS) {
  splits.push({
    text,
    pokerstars: short(JSON.stringify(pokerstarsParser.splitHands(text))),
    ggpoker: short(JSON.stringify(ggpokerParser.splitHands(text))),
  });
}

const DETECT_TEXTS = [
  "",
  "hello",
  "PokerStars",
  "PokerStars Hand #1:",
  "﻿PokerStars Hand #1: x",
  "x\rPokerStars Zoom Hand #12: y",
  "x\nPokerStars, the 40 characters and more go here, and then #1: y",
  "x\nPokerStars 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀#1:",
  "x\nPokerStars 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀#1:",
  "x\nPokerStars #1:",
  "a PokerStars tournament summary",
  "PokerStarsX",
  "Poker Hand #",
  "Poker Hand #HD1: Hold'em No Limit ($1/$2) - 2026/03/01 10:00:00\nTotal pot $3 | Rake $0",
  "Poker Hand #HD1: x\nTotal pot $3\n| Rake $0",
  "Poker Hand #HD1: x\nTotal pot $3\r| Rake $0",
  "Poker Hand #HD1: x\nA: Chooses to EV Cashout",
  "Poker Hand #1: x\nB: get an all-in insurance (x)",
  "Poker Hand #1: x - Level7 (1/2)",
  "Poker Hand #1: x\nNatural8",
  "Poker Hand #1: x\nRush & Cash\nPokerStars",
  "Poker Hand #1: x\nWPT global",
  "x\rGG Poker Hand #sd1: y",
  "x\nPoker Hand #77: PLO-5 ($1)\nTotal pot $1 | Rake $0",
  "x Poker Hand #77: ShortDeck ($1)",
  "GG",
];
const detect = DETECT_TEXTS.map((text) => ({
  text,
  pokerstars: permille(pokerstarsParser, text),
  ggpoker: permille(ggpokerParser, text),
}));

for (const file of files) {
  if (file.text === null) continue;
  splits.push({
    file: file.input,
    pokerstars: short(JSON.stringify(pokerstarsParser.splitHands(file.text))),
    ggpoker: short(JSON.stringify(ggpokerParser.splitHands(file.text))),
  });
}

function record(base, ops, text) {
  cases.push({
    ...base,
    ops,
    detect: [permille(pokerstarsParser, text), permille(ggpokerParser, text)],
    pokerstars: outcome(pokerstarsParser, text),
    ggpoker: outcome(ggpokerParser, text),
  });
}

for (const file of files) {
  if (file.text === null || !["pokerstars", "ggpoker", "standard"].includes(file.top)) continue;
  const site = file.top === "pokerstars" ? "pokerstars" : "ggpoker";
  const chunks = PARSERS[site].splitHands(file.text);
  chunks.forEach((chunk, index) => {
    const lines = chunk.split("\n");
    const names = seatNames(lines);
    const id = (lines[0].match(/#(\w+):/) ?? [])[1] ?? "1";
    const base = { file: file.input, split: site, chunk: index };
    // The files `standard` wins are near-identical GG cash hands (gg-hh/ and
    // its copies): the unmutated hand and one mutation in four. The files
    // the two parsers win get six mutations each.
    const reference = file.top === "standard";
    record(base, [], chunk);
    const count = STRESS !== null ? (reference ? 3 : 40) : reference ? (random() < 0.25 ? 1 : 0) : 6;
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
      else if (roll < 0.13) ops.push(["prefix", "﻿"]);
      else if (roll < 0.15) ops.push(["join", " "]);
      record(base, ops, apply(chunk, ops));
    }
  });
}

/* --------------------------------------------------------- the dialect --- */

function dialectOutcome(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const unit = text.includes("€") ? EUR : USD;
  const draft = new StarsHandDraft({
    siteId: "dialect",
    siteName: "Dialect",
    parserId: "dialect",
    parserVersion: "0.0.0",
    handId: "1",
    handKey: "D1",
    rawText: text,
    originalFilename: null,
    game: {
      variant: "holdem",
      limit: "nl",
      format: "cash",
      label: "Hold'em No Limit",
      unit,
      smallBlind: 5,
      bigBlind: 10,
    },
    tournament: null,
    playedAt: null,
    textStyle: { ...DEFAULT_TEXT_STYLE },
  });
  let body;
  try {
    body = parseStarsFamilyBody(lines, draft, unit);
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
  try {
    const hand = draft.build();
    hand.meta.parsedAt = PARSED_AT;
    if (body.chipMovements.length > 0) hand.chipMovements = body.chipMovements;
    return { hash: handHash({ body, hand }) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

const DIALECT_LINES = [
  ...COMMON_LINES,
  "STP added: €0.50",
  "STP added: $2",
  "Total pot €0.75 | Main pot €0.25 | STP €0.50 | Rake €0.04",
  "Total pot €10 | Main pot €6 | Side pot-1 €4 | Rake €0.50",
  "Total pot €10 | Side pot €4 | Bonus €1",
  "Uncalled bet (€0.71) returned to {P}",
  "{P} shows [Ac Jd 5h 4d] for Two Pairs [Ad Ac Kd 5h 5c]",
  "{P}: shows [8h 9h]",
  "{P} shows [8h 9h] (a flush)",
  "Ghost shows [8h 9h]",
  "Seat 1: {P} ($10 in chips) [hero]",
  "Table ID '30263259' 6-Max Seat #1 is the button",
  "Table 'Myanmar' 6-max Seat #9 is the button",
  "Table 'X' 9-MAX",
];

const dialect = [];
for (const file of files) {
  if (file.text === null) continue;
  if (!/^fixtures\/samples\/(?:run-it-once|pokerbros)\//.test(file.input)) continue;
  const chunks = file.text
    .split(/(?=^(?:Run It Once Poker|PokerBros) Hand #)/m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => /^(?:Run It Once Poker|PokerBros) Hand #/.test(chunk));
  chunks.forEach((chunk, index) => {
    const lines = chunk.split("\n");
    const names = seatNames(lines);
    const base = { file: file.input, chunk: index };
    dialect.push({ ...base, ops: [], ...dialectOutcome(chunk) });
    for (let k = 0; k < (STRESS !== null ? 400 : 40); k += 1) {
      const ops = [];
      const edits = 1 + below(3);
      for (let e = 0; e < edits; e += 1) {
        const at = 1 + below(Math.max(1, lines.length - 1));
        const kind = below(4);
        if (kind === 0) ops.push(["delete", at]);
        else if (kind === 1) ops.push(["swap", at]);
        else ops.push(["insert", at, fill(pick(DIALECT_LINES), names, "1")]);
      }
      dialect.push({ ...base, ops, ...dialectOutcome(apply(chunk, ops)) });
    }
  });
}

const out = { splits, detect, cases, dialect };
writeFileSync(
  fileURLToPath(new URL("./psgg-vectors.json", import.meta.url)),
  `${JSON.stringify(out, null, 0)}\n`,
);
console.log(
  `${splits.length} splits, ${detect.length} detections, ${cases.length} cases, ${dialect.length} dialect cases`,
);
