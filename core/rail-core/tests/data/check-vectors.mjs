// Writes check-vectors.json: what the TypeScript `assignPositions`,
// `validateHand` and `assignHiLoHalves` make of hands the corpus does not
// have, for `rail_core::{positions, validate, phf::hilo}` to replay
// (docs/RAIL-PLAN.md R0.5b).
//
//     cd tests && npm ci && npm run golden:emit     (testdata/golden-full/)
//     node core/rail-core/tests/data/check-vectors.mjs
//
// The goldens cover every accepted corpus hand, and accepted hands have no
// validation errors - so on their own they exercise none of the validator's
// error paths. This file does, three ways:
//
//  - `fixtures`: the hands the TypeScript unit tests build their cases from
//    (`phfValidate`, `phfPositions`, `phfCoreGaps`, `phfHiLo`, `shortDeck`),
//    as the TypeScript produced them - the standard-format texts are read out
//    of the test files themselves, the corpus hands converted from their
//    sample files - so the Rust translations of those tests start from the
//    same hand.
//  - `refusals`: every corpus hand the TypeScript refuses at stage
//    `validate`, as it was just before validation (`convertAny` with
//    `validate: false`), with its report.
//  - `cases`: seeded random mutations of a sample of golden hands (`bases`),
//    each a list of JSON-pointer edits, with the positions, validation report
//    and hi/lo halves the TypeScript gives the mutated hand - or the message
//    of the exception it throws.
//
// Bundles the TypeScript with esbuild from tests/node_modules (the sources
// import without extensions, which Node's own type stripping cannot follow).
// Deterministic (seeded), so rerunning it rewrites the same file as long as
// the goldens are the same.

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
      export { convertAny } from "./frontend/src/lib/parsers/index.ts";
      export { parseStandardHand } from "./frontend/src/lib/phf/serialize.ts";
      export { assignPositions } from "./frontend/src/lib/phf/types.ts";
      export { validateHand } from "./frontend/src/lib/phf/validate.ts";
      export { assignHiLoHalves } from "./frontend/src/lib/phf/hilo.ts";
      export { decodeSource } from "./frontend/src/components/converter/inputs.ts";
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
const { convertAny, parseStandardHand, assignPositions, validateHand, assignHiLoHalves, decodeSource } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const PARSED_AT = "1970-01-01T00:00:00.000Z";
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

/* ------------------------------------------------------------ helpers --- */

let seed = 0x0c4ec5b5;
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
const clone = (value) => structuredClone(value);

/** A hand as the vectors store it: `parsedAt` pinned, the raw text dropped. */
function stored(hand) {
  const copy = clone(hand);
  copy.meta.parsedAt = PARSED_AT;
  copy.meta.rawText = "";
  return copy;
}

/** A template literal `const NAME = \`...\`;` out of a TypeScript test file. */
function literal(file, name) {
  const source = readFileSync(join(ROOT, "tests/test", file), "utf8");
  const match = source.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
  if (!match) throw new Error(`${name} not found in ${file}`);
  return match[1];
}

function parse(text) {
  const hand = parseStandardHand(text, CTX);
  if (!hand) throw new Error("fixture did not parse");
  return hand;
}

function sample(relative) {
  return new TextDecoder("utf-8").decode(readFileSync(join(ROOT, "fixtures/samples", relative)));
}

async function converted(relative, options = {}) {
  const result = await convertAny(sample(relative), { sourceFilename: relative, ...options });
  return result.hands;
}

function problems(report) {
  return report.problems.map(({ code, message, severity, context }) => ({ code, message, severity, context }));
}

/** What the three functions under test make of `hand` (which is not touched). */
function outcome(hand) {
  const positioned = clone(hand);
  assignPositions(positioned);
  const out = { positions: positioned.players.map((player) => player.position) };
  try {
    out.problems = problems(validateHand(positioned));
  } catch (error) {
    out.thrown = error.message;
  }
  if (hand.game.hiLo) {
    const halved = clone(hand);
    try {
      const warnings = assignHiLoHalves(halved);
      out.hiLo = {
        warnings,
        halves: halved.actions.map((action) => action.half ?? null),
        winners: halved.results.winners,
      };
    } catch (error) {
      out.hiLo = { thrown: error.message };
    }
  }
  return out;
}

/* ----------------------------------------------------------- fixtures --- */

const fixtures = {};
fixtures.SIMPLE_HAND = parse(literal("phfValidate.test.ts", "SIMPLE_HAND"));
for (const name of ["HEADS_UP", "DEAD_BUTTON", "SEATED_NOT_DEALT_IN", "BOMB_POT"]) {
  fixtures[name] = parse(literal("phfPositions.test.ts", name));
}
// "falls back to geometry heads-up too", built the way the test builds it.
fixtures.BOMB_POT_HEADS_UP = parse(
  literal("phfPositions.test.ts", "BOMB_POT")
    .split("\n")
    .filter((line) => !/(^Seat 3: C |^C: )/.test(line))
    .join("\n")
    .replace("Seat #3 is the button", "Seat #2 is the button")
    .replace("Total pot $18", "Total pot $12")
    .replace("A collected $18", "A collected $12")
    .replace("Seat 1: A collected ($18)", "Seat 1: A collected ($12)"),
);
fixtures.STP = parse(literal("phfCoreGaps.test.ts", "STP"));

const SAMPLE_HANDS = [
  "pokerstars/14-cash-omahahilo-strange-names.txt",
  "pokerstars/15-cash-omahahilo-limit-hi-lo-split.txt",
  "pokerstars/17-cash-omahahilo-nolowqualified.txt",
  "pokerstars/26-cash-nolimit-omahahilo.txt",
  "full-tilt/03-cash-plo-hilo-showdown-hi-lo-split.txt",
  "888poker/05-omaha-hilo-summary-hi-lo-split.txt",
  "888poker/10-omaha-hilo-hi-only-summary.txt",
  "microgaming/04-pot-limit-omaha-hilo.txt",
  "ggpoker/11-fpdb3-cash-nl-shortdeck-5max-usd-0-2-202103.txt",
  "ggpoker/12-fpdb3-cash-nl-shortdeck-5max-usd-100-202104-internal.txt",
];
for (const relative of SAMPLE_HANDS) {
  for (const hand of await converted(relative)) {
    fixtures[`${relative}#${hand.meta.handId}`] = hand;
  }
}
// Refused at validation; the hand as it was before (`phfHiLo`: "refuses a
// payout the shown cards contradict").
for (const hand of await converted("entraction/07-allin-showdown.txt", { validate: false })) {
  fixtures[`entraction/07-allin-showdown.txt#${hand.meta.handId}`] = hand;
}
for (const key of Object.keys(fixtures)) {
  fixtures[key] = stored(fixtures[key]);
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
const corpus = [];
const refusals = [];
for (const file of walk(GOLDEN_FULL)) {
  const golden = JSON.parse(readFileSync(file, "utf8"));
  const path = golden.input.path;
  for (const hand of golden.hands) {
    corpus.push({ path, hand: hand.phf });
  }
  const validateStage = golden.refusals.filter((refusal) => refusal.stage === "validate");
  if (validateStage.length === 0) continue;
  // The hands as they were just before validation: the same conversion with
  // validation switched off keeps every hand the validator would refuse.
  const bytes = readFileSync(join(ROOT, path));
  const decoded = decodeSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  const name = path.split("/").pop();
  const all = await convertAny(decoded.text, { sourceFilename: name, validate: false });
  const refused = all.hands.filter((hand) => !validateHand(hand).ok);
  if (refused.length !== validateStage.length) {
    throw new Error(`${path}: ${validateStage.length} validate refusals, ${refused.length} refused hands`);
  }
  refused.forEach((hand, i) => {
    const report = validateHand(hand);
    if (report.errors[0].code !== validateStage[i].reason) {
      throw new Error(`${path}: refusal ${i} is ${validateStage[i].reason}, not ${report.errors[0].code}`);
    }
    refusals.push({
      path,
      index: validateStage[i].index,
      reason: validateStage[i].reason,
      hand: stored(hand),
      problems: problems(report),
    });
  });
}

/* --------------------------------------------------------------- bases --- */

// Every hi/lo and short-deck hand, every hand with chip movements, a button
// blind, a straddle, a bomb pot or a second runout, and a seeded sample of the
// rest - small hands first, so the file stays small.
const special = (hand) =>
  hand.game.hiLo ||
  hand.game.variant === "shortdeck" ||
  (hand.chipMovements ?? []).length > 0 ||
  hand.actions.some((action) => action.verb === "posts button blind") ||
  hand.game.straddles.length > 0 ||
  hand.game.bombPot !== null ||
  hand.board.runouts.length > 1 ||
  hand.table.buttonSeat === null;
const bySize = (a, b) => JSON.stringify(a.hand).length - JSON.stringify(b.hand).length;
const chosen = [];
const parsers = new Map();
for (const entry of corpus) {
  const id = entry.hand.meta.parserId;
  if (!parsers.has(id)) parsers.set(id, []);
  parsers.get(id).push(entry);
}
for (const [, entries] of [...parsers].sort((a, b) => a[0].localeCompare(b[0]))) {
  const specials = entries.filter((entry) => special(entry.hand)).sort(bySize);
  chosen.push(...specials.slice(0, 8));
  const plain = entries.filter((entry) => !special(entry.hand)).sort(bySize);
  // The smallest third, sampled.
  const pool = plain.slice(0, Math.max(1, Math.ceil(plain.length / 3)));
  for (let i = 0; i < 3 && pool.length > 0; i += 1) {
    chosen.push(pool.splice(int(pool.length), 1)[0]);
  }
}
const bases = chosen.map((entry) => stored(entry.hand));

/* ----------------------------------------------------------- mutations --- */

/** Applies one edit to `hand` and records it. */
function editor(hand, ops) {
  const locate = (pointer) => {
    const parts = pointer.split("/").slice(1);
    const key = parts.pop();
    let parent = hand;
    for (const part of parts) parent = parent[Array.isArray(parent) ? Number(part) : part];
    return [parent, Array.isArray(parent) ? Number(key) : key];
  };
  return {
    set(pointer, value) {
      const [parent, key] = locate(pointer);
      parent[key] = clone(value);
      ops.push(["set", pointer, value]);
    },
    insert(pointer, value) {
      const [parent, key] = locate(pointer);
      parent.splice(key, 0, clone(value));
      ops.push(["insert", pointer, value]);
    },
    remove(pointer) {
      const [parent, key] = locate(pointer);
      if (Array.isArray(parent)) parent.splice(key, 1);
      else delete parent[key];
      ops.push(["remove", pointer]);
    },
  };
}

const RANKS = "23456789TJQKA";
const SUITS = "shdc";
const randomCard = () => `${pick(RANKS)}${pick(SUITS)}`;
const JUNK_CARDS = ["Xx", "10h", " Ah", "ah", "AH", "", "A", "Ahh", "1s", "Ka ", " Qd"];
const ACTION_TYPES = [
  "ante", "small-blind", "big-blind", "straddle", "post", "missed-blind", "bomb-ante", "fold", "check",
  "call", "bet", "raise", "uncalled", "show", "muck", "collect", "cashout-choose", "cashout-pay",
];
const STREETS = ["preflop", "flop", "turn", "river", "showdown"];
const VARIANTS = ["holdem", "omaha", "omaha5", "omaha6", "shortdeck", "stud", "razz", "draw", "other"];

function delta(base) {
  switch (int(5)) {
    case 0:
      return 1;
    case 1:
      return -1;
    case 2:
      return 2 + int(50);
    case 3:
      return -(2 + int(Math.max(2, Math.abs(base))));
    default:
      return int(100000) - 50000;
  }
}

const MUTATIONS = [
  // Amounts.
  (h, e) => {
    if (!h.actions.length) return;
    const i = int(h.actions.length);
    e.set(`/actions/${i}/amount`, h.actions[i].amount + delta(h.actions[i].amount));
  },
  (h, e) => e.set("/results/totalPot", h.results.totalPot + delta(h.results.totalPot)),
  (h, e) => e.set(`/results/fees/${pick(["rake", "jackpot", "tax", "other"])}`, int(3) === 0 ? 0 : int(500)),
  (h, e) => {
    if (!h.results.players.length) return;
    const i = int(h.results.players.length);
    const field = pick(["contributed", "won"]);
    e.set(`/results/players/${i}/${field}`, h.results.players[i][field] + delta(10));
  },
  (h, e) => {
    if (!h.players.length) return;
    e.set(`/players/${int(h.players.length)}/startingStack`, pick([0, 1, 10, int(1000)]));
  },
  (h, e) => {
    const uncalled = h.actions.findIndex((action) => action.type === "uncalled");
    if (uncalled < 0) return;
    e.set(`/actions/${uncalled}/amount`, -(1 + int(100000)));
  },
  // Actors and seats.
  (h, e) => {
    if (!h.actions.length) return;
    const names = [...h.players.map((p) => p.name), "ghost"];
    e.set(`/actions/${int(h.actions.length)}/player`, pick(names));
  },
  (h, e) => {
    if (!h.actions.length) return;
    const seats = [null, ...h.players.map((p) => p.seat), 99];
    e.set(`/actions/${int(h.actions.length)}/seat`, pick(seats));
  },
  (h, e) => {
    if (!h.actions.length) return;
    e.set(`/actions/${int(h.actions.length)}/type`, pick(ACTION_TYPES));
  },
  (h, e) => {
    if (!h.actions.length) return;
    e.remove(`/actions/${int(h.actions.length)}`);
  },
  (h, e) => {
    if (!h.actions.length) return;
    const i = int(h.actions.length);
    e.insert(`/actions/${i}`, h.actions[i]);
  },
  (h, e) => {
    if (h.players.length < 2) return;
    const [a, b] = [int(h.players.length), int(h.players.length)];
    e.set(`/players/${a}/name`, h.players[b].name);
  },
  (h, e) => {
    if (h.players.length < 2) return;
    const [a, b] = [int(h.players.length), int(h.players.length)];
    e.set(`/players/${a}/seat`, h.players[b].seat);
  },
  (h, e) => {
    if (!h.players.length) return;
    e.remove(`/players/${int(h.players.length)}`);
  },
  (h, e) => {
    if (int(10) === 0) e.set("/players", []);
  },
  (h, e) => e.set("/table/buttonSeat", pick([null, 99, 0, ...h.players.map((p) => p.seat)])),
  (h, e) => {
    for (let i = 0; i < h.players.length; i += 1) {
      if (h.players[i].isHero) e.set(`/players/${i}/isHero`, false);
    }
  },
  // Cards.
  (h, e) => {
    if (!h.players.length) return;
    const i = int(h.players.length);
    const cards = [...h.players[i].holeCards];
    const board = h.board.runouts.flatMap((run) => [...(run.flop ?? []), run.turn, run.river]).filter(Boolean);
    const others = h.players.flatMap((p) => p.holeCards);
    const card = pick([randomCard(), pick(JUNK_CARDS), pick(board.length ? board : [randomCard()]),
      pick(others.length ? others : [randomCard()]), `${pick("2345")}${pick(SUITS)}`]);
    switch (int(3)) {
      case 0:
        if (cards.length) cards[int(cards.length)] = card;
        else cards.push(card);
        break;
      case 1:
        cards.push(card);
        break;
      default:
        cards.pop();
    }
    e.set(`/players/${i}/holeCards`, cards);
  },
  (h, e) => {
    if (h.players.length < 2) return;
    const [a, b] = [int(h.players.length), int(h.players.length)];
    const cards = h.players[a].holeCards;
    e.set(`/players/${a}/holeCards`, h.players[b].holeCards);
    e.set(`/players/${b}/holeCards`, cards);
  },
  (h, e) => {
    const r = int(h.board.runouts.length);
    const run = h.board.runouts[r];
    switch (int(6)) {
      case 0:
        e.set(`/board/runouts/${r}/flop`, pick([null, [], [randomCard(), randomCard()], [randomCard(), randomCard(), randomCard()]]));
        break;
      case 1:
        e.set(`/board/runouts/${r}/turn`, pick([null, "", randomCard(), pick(JUNK_CARDS)]));
        break;
      case 2:
        e.set(`/board/runouts/${r}/river`, pick([null, "", randomCard()]));
        break;
      case 3:
        if (run.flop && run.flop.length) e.set(`/board/runouts/${r}/flop/${int(run.flop.length)}`, pick([randomCard(), pick(JUNK_CARDS)]));
        break;
      case 4:
        e.insert(`/board/runouts/${h.board.runouts.length}`, {
          index: h.board.runouts.length,
          flop: pick([null, [], [randomCard(), randomCard(), randomCard()]]),
          turn: pick([null, "", randomCard()]),
          river: pick([null, "", randomCard()]),
          markerLabels: {},
          summaryCards: null,
        });
        break;
      default:
        if (h.board.runouts.length > 1) e.remove(`/board/runouts/${h.board.runouts.length - 1}`);
    }
  },
  (h, e) => e.set("/results/streetReached", pick(STREETS)),
  // Chip movements.
  (h, e) => {
    const list = h.chipMovements ?? [];
    const seat = pick([null, 99, ...h.players.map((p) => p.seat)]);
    const movement = {
      kind: pick(["splash-the-pot", "cash-drop", "bad-beat-drop"]),
      fromSeat: seat,
      fromPlayer: seat === null ? null : pick([null, "", ...h.players.map((p) => p.name)]),
      toPot: int(2) === 0,
      amount: pick([0, -5, 1, 50, int(1000)]),
      raw: null,
      anchor: pick(["before-postings", "after-hole-cards"]),
    };
    e.set("/chipMovements", [...list, movement]);
  },
  (h, e) => {
    if ((h.chipMovements ?? []).length) e.remove("/chipMovements");
  },
  // Hi/lo.
  (h, e) => e.set("/game/hiLo", !h.game.hiLo),
  (h, e) => {
    if (!h.actions.length) return;
    const i = int(h.actions.length);
    if (int(3) === 0 && h.actions[i].half) e.remove(`/actions/${i}/half`);
    else e.set(`/actions/${i}/half`, pick(["hi", "lo"]));
  },
  (h, e) => {
    const collects = h.actions.map((a, i) => [a, i]).filter(([a]) => a.type === "collect");
    if (!collects.length) return;
    const [, i] = pick(collects);
    e.set(`/actions/${i}/half`, pick(["hi", "lo"]));
  },
  (h, e) => {
    if (!h.results.winners.length) return;
    e.set(`/results/winners/${int(h.results.winners.length)}/half`, pick(["hi", "lo"]));
  },
  (h, e) => {
    const collects = h.actions.map((a, i) => [a, i]).filter(([a]) => a.type === "collect");
    if (!collects.length) return;
    const [, i] = pick(collects);
    if (int(4) === 0) e.remove(`/actions/${i}/potName`);
    else e.set(`/actions/${i}/potName`, pick(["main pot", "Main", "the main pot", "side pot-1", "Side Pot 1", "pot", ""]));
  },
  (h, e) => {
    const collects = h.actions.map((a, i) => [a, i]).filter(([a]) => a.type === "collect");
    if (!collects.length) return;
    const [, i] = pick(collects);
    e.set(`/actions/${i}/runoutIndex`, int(3));
  },
  (h, e) => {
    const collects = h.actions.map((a, i) => [a, i]).filter(([a]) => a.type === "collect");
    if (!collects.length || !h.players.length) return;
    const [, i] = pick(collects);
    e.set(`/actions/${i}/player`, pick(h.players).name);
  },
  (h, e) => {
    if (!h.players.length) return;
    const i = int(h.players.length);
    const n = pick([2, 4, 4, 5]);
    const cards = new Set();
    while (cards.size < n) cards.add(randomCard());
    e.set(`/players/${i}/holeCards`, [...cards]);
  },
  (h, e) => {
    if (!h.players.length) return;
    const player = pick(h.players);
    e.insert(`/actions/${h.actions.length}`, {
      index: h.actions.length,
      street: "showdown",
      runoutIndex: 0,
      seat: player.seat,
      player: player.name,
      type: "show",
      amount: 0,
      streetTotal: 0,
      allIn: false,
      cards: player.holeCards,
      label: "",
      sourceLine: null,
      rawLine: `${player.name}: shows`,
    });
  },
  (h, e) => {
    const folds = h.actions.map((a, i) => [a, i]).filter(([a]) => a.type === "fold");
    if (!folds.length) return;
    e.remove(`/actions/${pick(folds)[1]}`);
  },
  // Game.
  (h, e) => e.set("/game/bigBlind", pick([0, -10, 7, 25, h.game.bigBlind * 10])),
  (h, e) => e.set("/game/unit/kind", h.game.unit.kind === "cash" ? "chips" : "cash"),
  (h, e) => e.set("/game/variant", pick(VARIANTS)),
  (h, e) => {
    const warning = { code: pick(["unknown-line", "streets-inferred", "odd"]), message: "A parser note." };
    const line = pick([undefined, 0, 1, 42]);
    if (line !== undefined) warning.line = line;
    e.set("/meta/warnings", [...h.meta.warnings, warning]);
  },
  (h, e) => {
    if (!h.actions.length) return;
    e.set(`/actions/${int(h.actions.length)}/sourceLine`, pick([null, 0, 7]));
  },
  // Blinds, for positions.
  (h, e) => {
    const blinds = h.actions.map((a, i) => [a, i]).filter(([a]) => ["small-blind", "big-blind", "ante"].includes(a.type));
    if (!blinds.length) return;
    const [, i] = pick(blinds);
    switch (int(4)) {
      case 0:
        e.remove(`/actions/${i}`);
        break;
      case 1:
        e.set(`/actions/${i}/type`, pick(["small-blind", "big-blind", "post", "missed-blind"]));
        break;
      case 2:
        e.set(`/actions/${i}/verb`, "posts button blind");
        e.set(`/actions/${i}/type`, "big-blind");
        break;
      default:
        e.set(`/actions/${i}/seat`, pick([null, ...h.players.map((p) => p.seat), 99]));
    }
  },
];

const CASES_PER_BASE = 16;
const cases = [];
bases.forEach((base, b) => {
  cases.push({ base: b, ops: [], ...outcome(base) });
  for (let n = 0; n < CASES_PER_BASE; n += 1) {
    const hand = clone(base);
    const ops = [];
    const e = editor(hand, ops);
    const count = 1 + int(3);
    for (let m = 0; m < count; m += 1) {
      pick(MUTATIONS)(hand, e);
    }
    if (ops.length === 0) continue;
    cases.push({ base: b, ops, ...outcome(hand) });
  }
});

/* -------------------------------------------------------------- output --- */

const line = (value) => JSON.stringify(value);
const object = (entries) => `{\n${entries.map(([k, v]) => `${JSON.stringify(k)}: ${line(v)}`).join(",\n")}\n}`;
writeFileSync(
  new URL("./check-vectors.json", import.meta.url),
  `{"generator": "check-vectors.mjs",\n` +
    `"fixtures": ${object(Object.entries(fixtures))},\n` +
    `"refusals": [\n${refusals.map(line).join(",\n")}\n],\n` +
    `"bases": [\n${bases.map(line).join(",\n")}\n],\n` +
    `"cases": [\n${cases.map(line).join(",\n")}\n]}\n`,
);
const errors = new Set(cases.flatMap((c) => (c.problems ?? []).filter((p) => p.severity === "error").map((p) => p.code)));
const warnings = new Set(cases.flatMap((c) => (c.problems ?? []).filter((p) => p.severity === "warning").map((p) => p.code)));
console.log(
  `${Object.keys(fixtures).length} fixtures, ${refusals.length} refusals, ${bases.length} bases, ${cases.length} cases; ` +
    `${cases.filter((c) => c.thrown).length} throw; error codes: ${[...errors].sort().join(" ")}; ` +
    `warning codes: ${warnings.size}; hi/lo outcomes: ${cases.filter((c) => c.hiLo).length}`,
);
