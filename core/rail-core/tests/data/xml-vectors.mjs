// Writes xml-vectors.json: what the TypeScript iPoker and MicroGaming parsers
// (`web/src/lib/parsers/{ipoker,microgaming}.ts`), their XML reader
// (`shared/p2-xml.ts`, the scanner Node runs) and `shared/p4-textroom.ts`
// make of texts the corpus does not have, for `rail_core` to replay
// (docs/RAIL-PLAN.md R0.9).
//
//     cd tests && npm ci                 (esbuild)
//     node core/rail-core/tests/data/xml-vectors.mjs
//
// The goldens pin the 27 corpus files of these rooms through the pipeline.
// This file adds:
//
//  - `scan`: `scanXml` of hand-written documents (the tree with attributes
//    as sorted `[name, value]` pairs, `null`, or the message it throws) and
//    `decode`: `decodeEntities` of hand-written values (`{ text }`, `{ lone }`
//    when the result holds a lone surrogate - written with U+FFFD for each -,
//    or `{ thrown }`).
//  - `base64`: `decodeBase64Utf16` probes; `strict`: `strictAmount` probes
//    (`{ amount }` as `String(n)`, or the refusal's message).
//  - `splits`: per corpus file (all of `testdata/golden/`, decoded with the
//    app's `decodeSource`) the 16-hex sha-256 of `JSON.stringify` of both
//    parsers' `splitHands`, plus hand-written split edge cases.
//  - `detect`: both parsers' per-mille scores of hand-written probes.
//  - `cases`: a chunk of a corpus file (`file`, the parser whose split cut
//    it, the chunk index) with a list of edits applied (`[at, deleteCount,
//    insert]` splices of the chunk, by UTF-16 index); both parsers' detection
//    score of the result and `parseHand` outcome (the refusal's reason and
//    message, the message of anything else thrown, or the 16-hex sha-256 of
//    the canonical JSON of the hand, `parsedAt` pinned), and `lone: true`
//    when the parsed tree (or a Base64 name in it) holds a lone surrogate -
//    which a Rust `String` cannot, so Rust may answer `parser-error` there.
//    Edits: attribute values from catalogues per attribute (amounts, codes,
//    seats, names, currencies, dates, `Object.prototype` names...),
//    attributes deleted or duplicated, elements deleted, duplicated, swapped
//    or inserted from a catalogue, element text replaced, entity and
//    character references, CDATA, comments, declarations, DOCTYPEs, quote
//    and case changes, truncation, CRLF / no line breaks / a BOM.
//  - `files`: the corpus files of these rooms re-encoded (UTF-16 LE with and
//    without a BOM, UTF-16 BE, Windows-1252 with `€`/`£`, CRLF) and run
//    through the converter's own path (`decodeSource`, `convertAny(text,
//    { sourceFilename, validate: true })`).
//
// Bundles the TypeScript with esbuild from tests/node_modules. Deterministic
// (seeded). `XML_STRESS=<seed>` draws ten times the cases from another seed
// for a local soak run (the committed file is the default).

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
      export { ipokerParser, microgamingParser, convertAny, detectSite }
        from "./web/src/lib/parsers/index.ts";
      export { ParseSkip } from "./web/src/lib/phf/detect.ts";
      export { USD, EUR } from "./web/src/lib/phf/types.ts";
      export { scanXml, decodeEntities } from "./web/src/lib/parsers/shared/p2-xml.ts";
      export { decodeBase64Utf16, strictAmount }
        from "./web/src/lib/parsers/shared/p4-textroom.ts";
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
  ipokerParser,
  microgamingParser,
  convertAny,
  detectSite,
  ParseSkip,
  USD,
  EUR,
  scanXml,
  decodeEntities,
  decodeBase64Utf16,
  strictAmount,
  decodeSource,
  canonicalJson,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const PARSED_AT = "1970-01-01T00:00:00.000Z";
const PARSERS = { ipoker: ipokerParser, microgaming: microgamingParser };
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
    // A message with a lone surrogate is written with U+FFFD (JSON readers
    // refuse the escape); such a case is marked `lone` anyway.
    if (error instanceof ParseSkip) {
      return { skip: [error.reason, error.message.toWellFormed()] };
    }
    return { error: String(error?.message ?? error).toWellFormed() };
  }
}

/** `Math.round(score * 1000)`, the Rust per-mille. */
const permille = (parser, text) => Math.round(parser.detect(text) * 1000);

/** A string as Rust holds it: U+FFFD for each lone surrogate. */
const lossy = (text) => text.toWellFormed();

/** Whether a tree the scanner returns (or a Base64 name in it) holds a lone surrogate. */
function treeIsLone(element) {
  if (!element) return false;
  if (!element.text.isWellFormed()) return true;
  for (const [name, value] of Object.entries(element.attrs)) {
    if (!value.isWellFormed()) return true;
    if (/^unicode/.test(name) && !decodeBase64Utf16(value).isWellFormed()) return true;
  }
  return element.children.some(treeIsLone);
}

function loneIn(text) {
  const sources = [text, text.replace(/^﻿/, "").trim()];
  return sources.some((source) => {
    try {
      return treeIsLone(scanXml(source));
    } catch {
      return false;
    }
  });
}

/** The scanner's tree with attributes as sorted pairs (UTF-16 order). */
function treeJson(element) {
  if (!element) return null;
  return {
    tag: element.tag,
    attrs: Object.entries(element.attrs)
      .map(([k, v]) => [k, lossy(v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    children: element.children.map(treeJson),
    text: lossy(element.text),
  };
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
const STRESS = process.env.XML_STRESS ? Number(process.env.XML_STRESS) : null;
const random = mulberry32(STRESS ?? 0x7a1b09);
const pick = (list) => list[Math.floor(random() * list.length)];
const below = (n) => Math.floor(random() * n);

/* ------------------------------------------------- reader probes --- */

const PROTO = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
  "__defineGetter__",
  "__lookupSetter__",
];

const SCAN_TEXTS = [
  "",
  "x",
  "<",
  ">",
  "<>",
  "</>",
  "<a>",
  "</a>",
  "<a/>",
  "<a />",
  "< a/>",
  "<a></a>",
  "<a></b>",
  "<a><b></a></b>",
  "<a><b>x</c></d>",
  "<a>1</a>tail<b>2</b>",
  "<a/><b></b>",
  "﻿<a/>",
  "﻿﻿<a/>",
  "<?xml version='1.0'?><a/>",
  "<?xml version='1.0'<a/>",
  "<!-- c --><a>x<!-- y -->z</a>",
  "<!-- c <a/>",
  "<!DOCTYPE a [<!ENTITY x 'y'>]><a/>",
  "<a><![CDATA[x>y]]></a>",
  "<a><![CDATA[<b>]]></a>",
  '<a b="1" c=\'2\' d = "3" e=4 f="x>y" g=\'"\' h="\'" />',
  '<a b="1" b="2" b=\'3\'/>',
  '<a __proto__="1" constructor="2" toString="3"/>',
  '<a b="&amp;&lt;&gt;&quot;&apos;&#65;&#x42;&nbsp;&toString;"/>',
  '<a b="1/>',
  "<a b='1/>",
  "<a\tb='1'\n/>",
  "<a b='1'/>",
  "<a﻿b='1'/>",
  "<a/b='1'/>",
  "<a b=1/>",
  "<a>  x  <b/>  y  </a>",
  "<a>&#32;x&#32;</a>",
  "<a>&#xD83D;&#xDE00;</a>",
  "<a>&#xD800;</a>",
  "<a b='&#xDFFF;'/>",
  "<a>&#xD800;</a><b/>",
  "<a></a><b>&#xD800;</b>",
  "<a>&#x110000;</a>",
  "<a></a><b>&#x110000;</b>",
  "<a b='&#99999999999999999999;'/>",
  "<a>&#xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;</a>",
  "<GAME><Seats><Seat num='1'/></Seats></GAME>",
  "<session><game></session>",
  "<session",
  "<a> x </a>",
  "<é ü='ö'>ß</é>",
  "<a>x</a >",
  "<a >x</ a>",
];

const scan = SCAN_TEXTS.map((text) => {
  try {
    const tree = scanXml(text);
    return { text, tree: treeJson(tree), lone: treeIsLone(tree) };
  } catch (error) {
    return { text, thrown: String(error?.message ?? error) };
  }
});

const DECODE_TEXTS = [
  "",
  "plain",
  "&amp;&lt;&gt;&quot;&apos;",
  "&amp;amp;",
  "&&amp;;",
  "&nbsp;",
  "&AMP;",
  "&#65;&#x42;",
  "&#X41;",
  "&#x;",
  "&#;",
  "&#a1;",
  "&#1f;",
  "&#00065;",
  "&#0;",
  "&#x1F600;",
  "&#128512;",
  "&#xD83D;&#xDE00;",
  "&#55357;&#56832;",
  "&#xD83D;x&#xDE00;",
  "&#xDE00;&#xD83D;",
  "a&#xD800;b",
  "&#xD800;",
  "&#xDBFF;&#xDBFF;&#xDC00;",
  "&#x10FFFF;",
  "&#x110000;",
  "&#1114111;",
  "&#1114112;",
  "&#99999999999999999999999;",
  `&#x${"f".repeat(300)};`,
  `&#${"9".repeat(400)};`,
  ...PROTO.map((name) => `&${name};`),
  "&toString;&valueOf;",
  "& amp;",
  "&amp",
];
const decode = DECODE_TEXTS.map((text) => {
  try {
    const out = decodeEntities(text);
    return out.isWellFormed() ? { text, out } : { text, lone: lossy(out) };
  } catch (error) {
    return { text, thrown: String(error?.message ?? error) };
  }
});

const B64 = (text) => Buffer.from(text, "utf16le").toString("base64");
const BASE64_TEXTS = [
  "",
  "rCA=",
  "rCA",
  " r C A = ",
  "rC A=\n",
  "rCA==",
  "rCA===",
  "r",
  "rC",
  "rC=A",
  "=rCA",
  "rCA=x",
  "€",
  "QQ==",
  "QQ",
  "QR==",
  "AAA=",
  "Pdgw3g==",
  "Pdg=",
  "MN49",
  B64("DuckGhoul"),
  B64("Ångström £"),
  B64("x\u{1F600}"),
  "RAB1AGMAawBHAGgAbwB1AGwA",
  "RAB1AGMAawBHAGgAbwB1AGw=",
  "RAB1AGMAawBHAGgAbwB1AGwAA",
  "RAB1AGMA-wBHAGgA",
  "RAB1AGMA_wBHAGgA",
  "\tRAB1\fAGMA\rawBH AGgA",
];
const base64 = BASE64_TEXTS.map((text) => {
  const out = decodeBase64Utf16(text);
  return out.isWellFormed() ? { text, out } : { text, lone: lossy(out) };
});

const STRICT_TEXTS = [
  "",
  " ",
  "0",
  "-0",
  "+0",
  "1",
  "0.01",
  "1.5",
  "1.50",
  "1.505",
  "$1.50",
  "+$113.91",
  "-$0.00",
  "€-0.05",
  "--1",
  "+-1",
  "kr 1,050",
  "zł 2,5",
  "R$1",
  "1,050",
  "1.050",
  "0,05",
  "1,234.50",
  "1.234,50",
  "1,234,567",
  "1.234.567,8",
  "1.234,5.6",
  "1,2.3,4",
  "2 950,00",
  "abc",
  "$",
  "1e5",
  "99999999999999999999",
  "9007199254740993",
  "0.1.2",
  " 7.5 ",
];
const strict = [];
for (const [name, unit] of [
  ["USD", USD],
  ["EUR", EUR],
]) {
  for (const text of STRICT_TEXTS) {
    try {
      strict.push({ unit: name, text, amount: String(strictAmount(text, unit, "a probe")) });
    } catch (error) {
      strict.push({ unit: name, text, refused: [error.reason, error.message] });
    }
  }
}

/* ----------------------------------------------------------- splits --- */

const splits = [];
const SPLIT_TEXTS = [
  "",
  " ",
  "<session",
  "<session>",
  "<sessions><game></game></sessions>",
  "<session><game gamecode='1'></game></session>",
  '<session sessioncode="7"><general><gametype>x</gametype></general><game gamecode="1">a</game><game gamecode="2">b</GAME></session>',
  '<SESSION SESSIONCODE="7"><GENERAL>g</GENERAL><GAME>a</GAME></SESSION><session sessioncode=\'8\'><game>b</game>',
  '<session sessioncode="1"><game><general>inner</general></game><general>late</general><game>c</game>',
  '<session x="1" sessioncode="a>b"><general></general><game></game>',
  "x<session><game>1</game></session>y<session><game>2</game><game>3",
  "<session><gamex>1</gamex><game>2</game></session>",
  "<session\n><game\n>1</game\n></session>",
  '<Game hhversion="4" id="1"></Game><Game hhversion="4" id="2"></Game>',
  '﻿<Game hhversion="4" id="1"/>\n  <game  HHVERSION="4"/> x<Gamehhversion=',
  '  <Game\thhversion="4" id="1">\n</Game>\r\n﻿<Game hhversion="4" id="2">',
  "<Game hhversion=",
  "<Game  hhversion><Game hhversion=x",
  "junk <Game hhversion=\"1\">",
];
for (const text of SPLIT_TEXTS) {
  const entry = { text };
  for (const id of IDS) entry[id] = short(JSON.stringify(PARSERS[id].splitHands(text)));
  splits.push(entry);
}
for (const file of files) {
  if (file.text === null) continue;
  const entry = { file: file.input };
  for (const id of IDS) entry[id] = short(JSON.stringify(PARSERS[id].splitHands(file.text)));
  splits.push(entry);
}

const DETECT_TEXTS = [
  "",
  "hello",
  "<session>",
  "<session><gametype>",
  "<SESSION><GAMETYPE>",
  "<sessions><gametype>",
  "<session><gametype><round no=1><action type=3>",
  "<session><gametype><round no=1>",
  "<session><gametype><round>no=<action type=>",
  "<session><gametype><round\nx no=1><action\n type=3>",
  "<session><gametype><round x>no=<action y>type=",
  "<session><gametype><action subtype=3><round no=1>",
  "<gametype><session><round no='1'><action type='0'>",
  '<Game hhversion="4" id="1"',
  '<game HHVERSION="4"\nID="1"',
  '<Game hhversion="4"  id="x"',
  '<Game hhversion="" id="1"',
  "<Game hhversion=4 id=1",
  '<Game id="1" hhversion="4"',
  '<HISTORY><GAME ID="1">',
  "<description",
];
const detect = DETECT_TEXTS.map((text) => {
  const entry = { text };
  for (const id of IDS) entry[id] = permille(PARSERS[id], text);
  return entry;
});

/* ----------------------------------------------------------- the edits --- */

const AMOUNTS = [
  "€0",
  "€0.10",
  "€0.05",
  "€1",
  "€1,000.50",
  "£2.50",
  "$7",
  "0.25",
  "1.234,5",
  "0,05",
  "2 950,00",
  "€0.005",
  "1.505",
  "abc",
  "",
  "-1",
  "-€0.10",
  "99999999999999999999",
  "1e5",
  "€10",
  "€100",
  "€5.75",
];
const NUMBERS = ["0", "1", "2", "3", "5", "9", "10", "11", "-1", "1.5", "abc", "", " 2 ", "1e1", "0x3", "Infinity", "NaN", "007", "99999999999"];
const IPOKER_TYPES = ["0", "1", "2", "3", "4", "5", "7", "8", "15", "23", "99", "", " 3", ...PROTO];
const MG_TYPES = [
  "SmallBlind",
  "BigBlind",
  "Ante",
  "Call",
  "Bet",
  "Raise",
  "AllIn",
  "Fold",
  "Check",
  "ShowCards",
  "MuckCards",
  "MoneyReturned",
  "BadBeatContribution",
  "Disconnect",
  "DealFlop",
  "DealTurn",
  "DealRiver",
  "Win",
  "Chat",
  "",
  "fold",
  ...PROTO,
];
const NAMES = ["Ghost", "a &amp; b", "&#xD800;", "&#xD83D;&#xDE00;", "x y", "", "N/A", "&toString;"];
const ATTRIBUTE_VALUES = {
  sum: AMOUNTS,
  chips: AMOUNTS,
  win: AMOUNTS,
  bet: AMOUNTS,
  balance: AMOUNTS.map((a) => a.replace(/[€£$]/g, "")),
  amount: AMOUNTS.map((a) => a.replace(/[€£$]/g, "")),
  endbalance: AMOUNTS,
  no: NUMBERS,
  seq: NUMBERS,
  seat: NUMBERS,
  num: NUMBERS,
  tablesize: NUMBERS,
  dealer: ["1", "0", "true", "false", ""],
  type: [...IPOKER_TYPES, ...MG_TYPES],
  gamecode: ["1", "", "5383392792", "x"],
  id: ["1", "", "5049092037", "x"],
  sessioncode: ["0", "1", "", 'a"b'],
  gametype: ["Hold'em", "Omaha", "Omaha H/L", "Omaha Hi/Lo", "Stud H/L", "Omaha Hi-Lo", "5 Card Omaha", "Razz", "7 Card Stud", "Hold&apos;em", "", "Short Deck"],
  betlimit: ["NL", "PL", "FL", "L", "pl", "", "Pot Limit"],
  stakes: ["0.01|0.02", "1|2", "0.05", "0,01|0,02", "abc", "", "1|2|3", "0.005|0.01"],
  currencysymbol: ["rCA=", "JAA=", "owA=", "", "!!", "Pdg=", "agByAA==", "QQ=="],
  unicodealias: [B64("Ghost"), B64("x\u{1F600}"), "Pdg=", "", "@@", "QQ=="],
  unicodetablename: [B64("Table €"), "", "Pdg=", "@@"],
  alias: NAMES,
  name: NAMES,
  player: NAMES,
  istournament: ["0", "1", "true"],
  realmoney: ["true", "false", ""],
  date: ["2013-09-23 14:27:55", "2013-02-31 25:61:61", "2013-09-23T1:02:03", "0014-01-01 00:00:00", "9999-99-99 99:99:99", "junk", ""],
  value: ["10", "A", "k", "9", "x", "", "0.10", "30000", "abc"],
  suit: ["c", "D", "h", "s", "x", ""],
};
const GENERIC_VALUES = ["", "0", "1", "x", ...PROTO.slice(0, 3)];

const IPOKER_ELEMENTS = [
  '<action no="{N}" player="{P}" type="3" sum="€0.10" cards="" />',
  '<action no="{N}" player="{P}" type="23" sum="€0.40" cards="" />',
  '<action no="{N}" player="{P}" type="5" sum="€0.20" cards="" />',
  '<action no="{N}" player="{P}" type="7" sum="€9.99" cards="" />',
  '<action no="{N}" player="{P}" type="0" sum="€0" cards="" />',
  '<action no="{N}" player="{P}" type="4" sum="€0" cards="" />',
  '<action no="{N}" player="{P}" type="15" sum="€0.02" cards="" />',
  '<action no="{N}" player="{P}" type="8" sum="€0" cards="" />',
  '<action no="{N}" player="{P}" type="8" sum="€0.10" cards="" />',
  '<action no="{N}" player="{P}" type="toString" sum="€0.10" cards="" />',
  '<action no="{N}" player="Ghost" type="3" sum="€0.10" cards="" />',
  '<action no="abc" player="{P}" type="3" sum="€0.10" cards="" />',
  '<cards type="Pocket" player="{P}">SA HK</cards>',
  '<cards type="Pocket" player="{P}">X X</cards>',
  '<cards type="Pocket" player="Ghost">SA HK</cards>',
  '<cards type="Flop" player="">D7 C4 CJ</cards>',
  '<cards type="Flop" player="">D7 C4</cards>',
  '<cards type="Turn" player="">S8</cards>',
  '<cards type="River" player="">c10</cards>',
  '<cards type="Bogus" player="">S8</cards>',
  '<cards player="">S8</cards>',
  '<player seat="9" name="Late" chips="€5" dealer="0" win="€0" bet="€0" />',
  '<player seat="9" name="{P}" chips="€5" dealer="1" win="€0.50" bet="€0" />',
  '<player seat="0" name="Zero" chips="€5" dealer="0" win="€0" bet="€0" />',
  '<round no="5"></round>',
  '<round no="toString"><action no="{N}" player="{P}" type="0" sum="€0" /></round>',
  '<round no="constructor"><action no="{N}" player="{P}" type="toString" sum="€0" /></round>',
  "<!-- a comment -->",
  "<?pi x?>",
  "<!DOCTYPE x>",
  "<![CDATA[<game>]]>",
  "</round>",
  "<round>",
  "<nickname>{P}</nickname>",
  "<gametype>Holdem NL $0.02/$0.05</gametype>",
  "<gametype>Omaha Hi-Lo PL €0.05/€0.10</gametype>",
  "<gametype>Razz FL $1/$2</gametype>",
  "<gametype>Holdem L $5/$10</gametype>",
  "<tablecurrency>GBP</tablecurrency>",
  "<tablename>Heads-Up Table, 123</tablename>",
  "<startdate>2014-01-06 11:49:59</startdate>",
];
const MG_ELEMENTS = [
  '<Action seq="{N}" type="Call" seat="{S}" value="0.02" />',
  '<Action seq="{N}" type="Bet" seat="{S}" value="0.10" />',
  '<Action seq="{N}" type="Raise" seat="{S}" value="0.06" />',
  '<Action seq="{N}" type="AllIn" seat="{S}" value="9.99" />',
  '<Action seq="{N}" type="Fold" seat="{S}" />',
  '<Action seq="{N}" type="Check" seat="{S}" />',
  '<Action seq="{N}" type="Ante" seat="{S}" value="0.01" />',
  '<Action seq="{N}" type="SmallBlind" seat="{S}" value="0.01" />',
  '<Action seq="{N}" type="BigBlind" seat="{S}" value="0.02" />',
  '<Action seq="{N}" type="MoneyReturned" seat="{S}" value="0.10" />',
  '<Action seq="{N}" type="MoneyReturned" seat="{S}" value="1,5" />',
  '<Action seq="{N}" type="BadBeatContribution" seat="{S}" value="0.02" />',
  '<Action seq="{N}" type="BadBeatContribution" seat="77" value="0.02" />',
  '<Action seq="{N}" type="Disconnect" seat="{S}" value="30000" />',
  '<Action seq="{N}" type="Chat" seat="{S}" />',
  '<Action seq="{N}" type="Call" seat="77" value="0.02" />',
  '<Action seq="{N}" type="ShowCards" seat="{S}"><Card value="A" suit="s" /><Card value="10" suit="h" /></Action>',
  '<Action seq="{N}" type="MuckCards" seat="{S}"><Card value="2" suit="d" /></Action>',
  '<Action seq="{N}" type="DealFlop"><Card value="9" suit="c" /><Card value="10" suit="D" /><Card value="K" suit="h" /></Action>',
  '<Action seq="{N}" type="DealFlop"><Card value="9" suit="c" /></Action>',
  '<Action seq="{N}" type="DealTurn"><Card value="2" suit="s" /></Action>',
  '<Action seq="{N}" type="DealRiver"><Card value="Q" suit="c" /></Action>',
  '<Action seq="{N}" type="toString"><Card value="Q" suit="c" /></Action>',
  '<Action seq="{N}" type="Win"><Seat num="{S}" amount="0.10" lowhandwin="0" /></Action>',
  '<Action seq="{N}" type="Win"><Seat num="77" amount="0.10" /></Action>',
  '<Action seq="{N}" type="Win"><Seat num="{S}" amount="0,105" /></Action>',
  '<Seat num="9" alias="Late" unicodealias="" balance="2.00" />',
  '<Seat num="{S}" alias="Dup" balance="3.00" dealer="true" />',
  '<Seat num="0" alias="Zero" balance="2.00" />',
  '<Seat num="8" alias="" unicodealias="Pdg=" balance="2.00" />',
  "<!-- a comment -->",
  "<?pi x?>",
  "<![CDATA[<Game>]]>",
  "</Action>",
  "<Gameplay>",
];

/** iPoker `<gametype>` texts. */
const GAMETYPES = [
  "Holdem NL $0.02/$0.05",
  "Holdem NL",
  "Omaha PL €0.05/€0.10",
  "Omaha Hi-Lo PL €0.05/€0.10",
  "Omaha H/L PL €0.05/€0.10",
  "Omaha HiLo PL €0.05/€0.10",
  "Omaha-Hi/Lo PL €0.05/€0.10",
  "OmahaH/L PL €0.05/€0.10",
  "Omaha_Hi_Lo PL €0.05/€0.10",
  "Stud-Hi/Lo FL $1/$2",
  "Stud Hi/Lo FL $1/$2",
  "Razz FL $1/$2",
  "7CardStud FL $1/$2",
  "Holdem L $5/$10",
  "Holdem FL £0.10/£0.20",
  "holdem pl €0.05",
  "Holdem XX $1/$2",
  "ShortDeck NL €1/€2",
  "Omaha5 PL €1/€2",
  "5CardOmaha PL €1/€2",
  "Holdem NL €1,000/€2,000",
  "Holdem NL 0.05/0.10",
  "Holdem NL €0.05/",
  "Holdem NL\n€1/€2",
  "Draw NL $1/$2",
  "",
];

/** Element text: game types, tables, dates, nicknames, currencies, cards. */
const ELEMENT_TEXTS = [
  "",
  "x",
  "N/A",
  "&amp;",
  "Holdem NL $0.02/$0.05",
  "Holdem NL",
  "Omaha PL $0.05",
  "Omaha PL €0.05/€0.10",
  "Omaha Hi-Lo PL €0.05/€0.10",
  "Omaha H/L PL €0.05/€0.10",
  "Razz FL $1/$2",
  "Holdem L $5/$10",
  "Holdem FL £0.10/£0.20",
  "Holdem XX $1/$2",
  "Short Deck NL €1/€2",
  "Omaha5 PL €1/€2",
  "Holdem NL €1,000/€2,000",
  "Holdem NL\n€1/€2",
  "EUR",
  "GBP",
  "usd",
  "Heads-up Table, 817748311",
  "Ashil'ta, 817748311",
  "Table , 5",
  "2014-01-06 11:49:59",
  "2014-01-06T1:02:03",
  "2014-02-31 25:61:61",
  "0014-01-06 11:49:59",
  "SA HK",
  "X X X X",
  " D7  C4\tCJ ",
  "D7 C4 CJ C2",
  "h10 c10",
];

const QUIRKS = [
  "&amp;",
  "&#65;",
  "&#x41;",
  "&toString;",
  "&nbsp;",
  "&#xD800;",
  "&#xD83D;&#xDE00;",
  "&#x110000;",
  "<![CDATA[x>y]]>",
  "<!-- c -->",
  "<?x?>",
  "<",
  ">",
  '"',
  "'",
  "&",
  " ",
  "�",
  " ",
  "\t",
];

/** Tags of `text`: `{ start, end, body }` for every `<...>`. */
function tagsOf(text) {
  return [...text.matchAll(/<[^<>]*>/g)].map((m) => ({ start: m.index, end: m.index + m[0].length, body: m[0] }));
}

/** Attributes inside tags: `{ start, end, name, valueStart, valueEnd }`. */
function attributesOf(text) {
  const out = [];
  for (const tag of tagsOf(text)) {
    for (const m of tag.body.matchAll(/([^\s=/<>]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const start = tag.start + m.index;
      const valueStart = start + m[0].length - m[2].length + 1;
      out.push({ start, end: start + m[0].length, name: m[1], valueStart, valueEnd: start + m[0].length - 1 });
    }
  }
  return out;
}

/** Whole elements: a self-closing tag, or an open tag through its close on the same tag name. */
function elementsOf(text) {
  const out = [];
  const tags = tagsOf(text);
  tags.forEach((tag, i) => {
    const name = tag.body.match(/^<([A-Za-z]+)/)?.[1];
    if (!name) return;
    if (tag.body.endsWith("/>")) {
      out.push({ start: tag.start, end: tag.end });
      return;
    }
    const close = tags.slice(i + 1).find((t) => t.body === `</${name}>`);
    if (close) out.push({ start: tag.start, end: close.end });
  });
  return out;
}

function namesOf(text, parser) {
  const names = [];
  const pattern = parser === "ipoker" ? /<player\b[^>]*\bname="([^"]*)"/g : /<Seat\b[^>]*\balias="([^"]*)"/g;
  for (const m of text.matchAll(pattern)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}
function seatsOf(text) {
  return [...text.matchAll(/<Seat\b[^>]*\bnum="([^"]*)"/g)].map((m) => m[1]);
}

function fill(template, text, parser) {
  return template
    .replaceAll("{P}", pick(namesOf(text, parser).concat(["Ghost"])))
    .replaceAll("{S}", pick(seatsOf(text).concat(["1"])))
    .replaceAll("{N}", String(below(40)));
}

/** One random edit of `text`, as a splice `[at, deleteCount, insert]`. */
function randomEdit(text, parser) {
  const attrs = attributesOf(text);
  const elements = elementsOf(text);
  const tags = tagsOf(text);
  const roll = below(18);
  if (roll >= 16) {
    // The header: iPoker's `<gametype>` text, MicroGaming's game attributes.
    if (parser === "ipoker") {
      const m = /<gametype>([^<]*)</i.exec(text);
      if (m) return [m.index + 10, m[1].length, pick(GAMETYPES)];
    } else {
      const headers = attrs.filter((a) =>
        ["gametype", "betlimit", "stakes", "istournament", "realmoney", "currencysymbol", "tablesize", "date"].includes(a.name),
      );
      if (headers.length > 0) {
        const a = pick(headers);
        return [a.valueStart, a.valueEnd - a.valueStart, pick(ATTRIBUTE_VALUES[a.name])];
      }
    }
  }
  if (roll <= 3 && attrs.length > 0) {
    // An attribute value from its catalogue.
    const a = pick(attrs);
    const value = pick(ATTRIBUTE_VALUES[a.name] ?? GENERIC_VALUES);
    return [a.valueStart, a.valueEnd - a.valueStart, value];
  }
  if (roll === 4 && attrs.length > 0) {
    const a = pick(attrs);
    return [a.start, a.end - a.start, ""];
  }
  if (roll === 5 && attrs.length > 0) {
    // A duplicate attribute (the last one wins).
    const a = pick(attrs);
    const value = pick(ATTRIBUTE_VALUES[a.name] ?? GENERIC_VALUES);
    return [a.end, 0, ` ${a.name}="${value}"`];
  }
  if (roll === 6 && elements.length > 0) {
    const e = pick(elements);
    return [e.start, e.end - e.start, ""];
  }
  if (roll === 7 && elements.length > 0) {
    const e = pick(elements);
    return [e.end, 0, text.slice(e.start, e.end)];
  }
  if (roll === 8 && elements.length > 1) {
    // Two elements' text exchanged (the later one moved before the earlier).
    const i = below(elements.length - 1);
    const a = elements[i];
    const b = elements.find((e) => e.start >= a.end);
    if (b) return [a.start, 0, text.slice(b.start, b.end)];
  }
  if (roll <= 10 && tags.length > 0) {
    const t = pick(tags);
    const catalogue = parser === "ipoker" ? IPOKER_ELEMENTS : MG_ELEMENTS;
    return [pick([t.start, t.end]), 0, fill(pick(catalogue), text, parser)];
  }
  if (roll === 11 && tags.length > 1) {
    // Element text replaced: between a tag's end and the next `<`.
    const t = pick(tags);
    const next = text.indexOf("<", t.end);
    if (next > t.end || next === t.end) {
      return [t.end, next - t.end, pick(ELEMENT_TEXTS)];
    }
  }
  if (roll === 12 && attrs.length > 0) {
    // An entity or a quirk inside a value.
    const a = pick(attrs);
    const at = a.valueStart + below(a.valueEnd - a.valueStart + 1);
    return [at, 0, pick(QUIRKS)];
  }
  if (roll === 13 && tags.length > 0) {
    // A tag's case or spacing.
    const t = pick(tags);
    const body = text.slice(t.start, t.end);
    const changed = pick([
      body.toUpperCase(),
      body.toLowerCase(),
      body.replace(/^</, "< "),
      body.replace(/"/g, "'"),
      body.replace(/\/>$/, ">"),
      body.replace(/>$/, "/>"),
      body.replace(/ /g, "\n"),
    ]);
    return [t.start, t.end - t.start, changed];
  }
  if (roll === 14) {
    // Truncation.
    const at = below(text.length + 1);
    return [at, text.length - at, ""];
  }
  const at = below(text.length + 1);
  return [at, 0, pick(QUIRKS)];
}

/** Edits are splices, or whole-text line-ending changes by name. */
function apply(text, edits) {
  let out = text;
  for (const edit of edits) {
    if (edit === "crlf") out = out.replaceAll("\n", "\r\n");
    else if (edit === "oneline") out = out.replaceAll("\n", "");
    else if (edit === "ls") out = out.replaceAll("\n", " ");
    else if (edit === "bom") out = `﻿${out}`;
    else {
      const [at, count, insert] = edit;
      out = out.slice(0, at) + insert + out.slice(at + count);
    }
  }
  return out;
}

/* ----------------------------------------------------------- the cases --- */

const cases = [];
function record(base, edits, text) {
  const entry = { ...base, edits, detect: {}, outcomes: {} };
  for (const id of IDS) {
    entry.detect[id] = permille(PARSERS[id], text);
    entry.outcomes[id] = outcome(PARSERS[id], text);
  }
  if (loneIn(text)) entry.lone = true;
  cases.push(entry);
}

for (const file of files) {
  if (file.text === null || !IDS.includes(file.top)) continue;
  const site = file.top;
  const chunks = PARSERS[site].splitHands(file.text);
  chunks.forEach((chunk, index) => {
    const base = { file: file.input, split: site, chunk: index };
    record(base, [], chunk);
    const count = 80 * (STRESS !== null ? 10 : 1);
    for (let k = 0; k < count; k += 1) {
      const edits = [];
      let current = chunk;
      const n = 1 + below(3);
      for (let e = 0; e < n; e += 1) {
        const edit = randomEdit(current, site);
        edits.push(edit);
        current = apply(current, [edit]);
      }
      const roll = random();
      if (roll < 0.04) edits.push("crlf");
      else if (roll < 0.07) edits.push("oneline");
      else if (roll < 0.09) edits.push("bom");
      else if (roll < 0.11) edits.push("ls");
      record(base, edits, apply(chunk, edits));
    }
  });
}

/* ------------------------------------------------- re-encoded files --- */

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
  "cp1252-pound": (text) => cp1252(text.replaceAll("€", "£").replaceAll("EUR", "GBP")),
  "utf8-crlf": (text) => Buffer.from(text.replaceAll("\n", "\r\n"), "utf8"),
};

const encoded = [];
for (const file of files) {
  if (file.text === null || !IDS.includes(file.top)) continue;
  const text = file.text.replace(/^﻿/, "");
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

const out = { scan, decode, base64, strict, splits, detect, cases, files: encoded };
writeFileSync(
  fileURLToPath(new URL("./xml-vectors.json", import.meta.url)),
  `${JSON.stringify(out, null, 0)}\n`,
);
const tally = {};
for (const c of cases) {
  for (const id of IDS) {
    const o = c.outcomes[id];
    const key = `${c.split}->${id}:${o.hand ? "hand" : o.skip ? o.skip[0] : "error"}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
}
console.log(
  `${scan.length} scans, ${decode.length} decodes, ${base64.length} base64, ${strict.length} strict, ` +
    `${splits.length} splits, ${detect.length} detections, ${cases.length} cases ` +
    `(${cases.filter((c) => c.lone).length} lone), ${encoded.length} re-encoded files\n` +
    JSON.stringify(tally, null, 1),
);
