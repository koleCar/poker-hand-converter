// Writes stats-vectors.json: what the TypeScript stats engine
// (`frontend/src/lib/stats`) derives from golden hands it has never seen
// whole, for `rail_stats` to replay (docs/RAIL-PLAN.md R2.1).
//
//     cd tests && npm ci && npm run golden:emit     (esbuild; testdata/golden-full/)
//     node core/rail-stats/tests/data/stats-vectors.mjs
//
// The stats goldens (`testdata/golden-stats/`) pin every corpus hand as the
// parsers made it. This file adds, by seeded mutation of those hands, the
// shapes the corpus leaves alone: actions dropped, swapped, duplicated or
// retyped (a fold that becomes a raise, a call on the wrong street, a seat
// nobody sits in), every position nulled (so the engine runs
// `assignPositions` itself), players re-seated or removed, the big blind
// zeroed or made odd, another variant, fees and pots and cashouts that do not
// reconcile, runouts cut or doubled, a button-blind verb, chips that bypass
// the pot, an empty hand key.
//
// A case is a corpus hand (`file`, the golden's path below testdata/golden/,
// and `hand`, its position in the golden's `hands`), the first 16 hex of the
// sha-256 of its canonical PHF (`phf`, so a stale vector says so), a list of
// `ops` applied in order to the PHF's JSON, and the first 16 hex of the
// sha-256 of the canonical JSON of `statsRows(handFacts(mutated))` (`rows`;
// `-0` written as 0, as in the goldens). `core/rail-stats/tests/vectors.rs`
// applies the same ops to the same JSON and compares.
//
// Every op keeps the document a PHF the Rust model deserializes (enum values
// from their sets, integers where integers go). A mutation the TypeScript
// throws on would be left out and counted in `meta.thrown`; none does today.
//
// Deterministic (seeded): rerunning it rewrites the same file as long as the
// goldens and the TypeScript are the same. `STATS_STRESS=<seed>` draws many
// more cases from another seed for a local soak run; `STATS_OUT=<path>`
// writes elsewhere, and `STATS_VECTORS=<path>` points `tests/vectors.rs` at
// it.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(join(ROOT, "tests/package.json"));
const esbuild = require("esbuild");

const bundle = await esbuild.build({
  stdin: {
    contents: `
      export { handFacts } from "./frontend/src/lib/stats/derive.ts";
      export { statsRows } from "./frontend/src/lib/stats/mapping.ts";
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
const { handFacts, statsRows, canonicalJson } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const STRESS = process.env.STATS_STRESS ? Number(process.env.STATS_STRESS) : null;
const OUT = process.env.STATS_OUT ?? join(ROOT, "core/rail-stats/tests/data/stats-vectors.json");
const CASES = STRESS === null ? 4000 : 50000;

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
const random = mulberry32(STRESS ?? 0x5ad5e7);
const pick = (list) => list[Math.floor(random() * list.length)];
const below = (n) => Math.floor(random() * n);

const sha16 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/* ------------------------------------------------------------- the corpus - */

const FULL = join(ROOT, "testdata/golden-full");
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (name.endsWith(".json")) {
      out.push(relative(FULL, full).split(sep).join("/"));
    }
  }
  return out;
}
const bases = [];
for (const file of walk(FULL, []).sort()) {
  const doc = JSON.parse(readFileSync(join(FULL, file), "utf8"));
  doc.hands.forEach((hand, i) => {
    bases.push({ file, hand: i, text: canonicalJson(hand.phf) });
  });
}
// The hand-written spot hands and the short-deck tables carry the hard cases;
// they get a quarter of the draws.
const special = bases.filter((base) =>
  /fixtures\/stats\/|shortdeck|6\+Holdem|bomb|straddle/i.test(base.file),
);

/* ---------------------------------------------------------------- the ops - */

const ACTION_TYPES = [
  "ante",
  "small-blind",
  "big-blind",
  "straddle",
  "post",
  "missed-blind",
  "bomb-ante",
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "uncalled",
  "show",
  "muck",
  "collect",
  "cashout-choose",
  "cashout-pay",
];
const DECISIONS = ["fold", "check", "call", "bet", "raise"];
const STREETS = ["preflop", "flop", "turn", "river", "showdown"];
const POSITIONS = ["BTN", "SB", "BB", "UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", null];
const VARIANTS = ["holdem", "omaha", "omaha5", "omaha6", "shortdeck", "stud", "razz", "draw", "other"];
const FEES = ["rake", "jackpot", "bingo", "fortune", "tax", "other"];
const CARDS = ["As", "Kd", "Qh", "Jc", "Ts", "9d", "5c", "2h", "Xx", "ah", " 7s"];

function amountFor(hand) {
  return pick([0, 1, 7, 50, 100, -100, hand.game.bigBlind, hand.game.bigBlind * 3, 1234567]);
}

/** Draws one op valid for `hand` as it stands. */
function drawOp(hand) {
  const actions = hand.actions.length;
  const players = hand.players.length;
  const seats = hand.players.map((player) => player.seat);
  const seatValue = () => pick([...seats, ...seats, null, 99]);
  const kinds = [];
  if (actions > 0) {
    kinds.push("drop", "type", "type", "decision", "seat", "street", "amount", "verb", "dup");
    if (actions > 1) kinds.push("swap", "swap");
  }
  if (players > 0) {
    kinds.push("positions", "position", "playerSeat", "holeCards", "stack");
    if (players > 1) kinds.push("dropPlayer");
  }
  kinds.push("bigBlind", "variant", "fee", "totalPot", "runouts", "cut", "addRunout", "chip");
  kinds.push("handKey", "siteId");
  if (hand.results.players.length > 0) kinds.push("cashoutRisk");

  switch (pick(kinds)) {
    case "drop":
      return { op: "drop", i: below(actions) };
    case "swap": {
      const i = below(actions);
      // Mostly neighbours: that is where order matters.
      const j = random() < 0.7 ? Math.min(actions - 1, i + 1) : below(actions);
      return { op: "swap", i, j };
    }
    case "type":
      return { op: "type", i: below(actions), value: pick(ACTION_TYPES) };
    case "decision":
      return { op: "type", i: below(actions), value: pick(DECISIONS) };
    case "seat":
      return { op: "seat", i: below(actions), value: seatValue() };
    case "street":
      return { op: "street", i: below(actions), value: pick(STREETS) };
    case "amount":
      return { op: "amount", i: below(actions), value: amountFor(hand) };
    case "verb":
      return { op: "verb", i: below(actions), value: pick(["posts button blind", "posts", null]) };
    case "dup":
      return { op: "dup", i: below(actions), j: below(actions + 1) };
    case "positions":
      return { op: "positions" };
    case "position":
      return { op: "position", p: below(players), value: pick(POSITIONS) };
    case "playerSeat":
      return { op: "playerSeat", p: below(players), value: pick([...seats, 0, 10, 99]) };
    case "dropPlayer":
      return { op: "dropPlayer", p: below(players) };
    case "holeCards": {
      const n = pick([0, 1, 2, 2, 2, 4, 5]);
      return { op: "holeCards", p: below(players), value: Array.from({ length: n }, () => pick(CARDS)) };
    }
    case "stack":
      return { op: "stack", p: below(players), value: pick([0, 1, -5, 999, 150000, hand.game.bigBlind * 95 + 3]) };
    case "bigBlind":
      return { op: "bigBlind", value: pick([0, 1, 3, 7, 30, 2000, -10, 2147483648]) };
    case "variant":
      return { op: "variant", value: pick(VARIANTS) };
    case "fee":
      return { op: "fee", key: pick(FEES), value: pick([0, 1, 3, 7, 99, 236, -5, 100000]) };
    case "totalPot":
      return { op: "totalPot", value: pick([0, -1, 1, hand.results.totalPot + 1, hand.results.totalPot * 2]) };
    case "runouts":
      return { op: "runouts", n: below(hand.board.runouts.length + 1) };
    case "cut":
      return hand.board.runouts.length > 0
        ? { op: "cut", k: below(hand.board.runouts.length), field: pick(["flop", "turn", "river"]) }
        : { op: "addRunout" };
    case "addRunout":
      return { op: "addRunout" };
    case "chip":
      return { op: "chip", seat: seatValue(), toPot: random() < 0.5, amount: pick([1, 25, 100, -3]) };
    case "handKey":
      return { op: "handKey", value: pick(["", "X-1", hand.meta.handId]) };
    case "siteId":
      return { op: "siteId", value: pick(["  GG ", "WePlay", "\u00a0\u00c9TOILE\u00a0", ""]) };
    case "cashoutRisk":
      return { op: "cashoutRisk", k: below(hand.results.players.length), value: pick([null, 0, 15, 300]) };
    default:
      throw new Error("unreachable");
  }
}

/** Applies one op to the PHF JSON in place. `tests/vectors.rs` mirrors this. */
function apply(hand, op) {
  switch (op.op) {
    case "drop":
      hand.actions.splice(op.i, 1);
      break;
    case "swap": {
      const a = hand.actions[op.i];
      hand.actions[op.i] = hand.actions[op.j];
      hand.actions[op.j] = a;
      break;
    }
    case "type":
      hand.actions[op.i].type = op.value;
      break;
    case "seat":
      hand.actions[op.i].seat = op.value;
      break;
    case "street":
      hand.actions[op.i].street = op.value;
      break;
    case "amount":
      hand.actions[op.i].amount = op.value;
      break;
    case "verb":
      if (op.value === null) {
        delete hand.actions[op.i].verb;
      } else {
        hand.actions[op.i].verb = op.value;
      }
      break;
    case "dup":
      hand.actions.splice(op.j, 0, structuredClone(hand.actions[op.i]));
      break;
    case "positions":
      for (const player of hand.players) player.position = null;
      break;
    case "position":
      hand.players[op.p].position = op.value;
      break;
    case "playerSeat":
      hand.players[op.p].seat = op.value;
      break;
    case "dropPlayer":
      hand.players.splice(op.p, 1);
      break;
    case "holeCards":
      hand.players[op.p].holeCards = [...op.value];
      break;
    case "stack":
      hand.players[op.p].startingStack = op.value;
      break;
    case "bigBlind":
      hand.game.bigBlind = op.value;
      break;
    case "variant":
      hand.game.variant = op.value;
      break;
    case "fee":
      hand.results.fees[op.key] = op.value;
      break;
    case "totalPot":
      hand.results.totalPot = op.value;
      break;
    case "runouts":
      hand.board.runouts.length = op.n;
      break;
    case "cut":
      hand.board.runouts[op.k][op.field] = null;
      break;
    case "addRunout": {
      const base = hand.board.runouts[0];
      const copy = base
        ? structuredClone(base)
        : {
            index: 0,
            flop: ["2c", "3d", "4h"],
            turn: "5s",
            river: "6c",
            markerLabels: {},
            summaryCards: null,
          };
      copy.index = hand.board.runouts.length;
      hand.board.runouts.push(copy);
      break;
    }
    case "chip":
      hand.chipMovements = [
        ...(hand.chipMovements ?? []),
        {
          kind: "bad-beat-drop",
          fromSeat: op.seat,
          fromPlayer: null,
          toPot: op.toPot,
          amount: op.amount,
          raw: null,
          anchor: "after-hole-cards",
        },
      ];
      break;
    case "handKey":
      hand.meta.handKey = op.value;
      break;
    case "siteId":
      hand.meta.siteId = op.value;
      break;
    case "cashoutRisk":
      hand.results.players[op.k].cashoutRisk = op.value;
      break;
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

/** `statsRows(handFacts(hand))` with `-0` as 0, canonical, hashed. */
function rowsHash(hand) {
  const rows = statsRows(handFacts(hand)).map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Object.is(value, -0) ? 0 : value])),
  );
  return sha16(canonicalJson(rows));
}

/* ------------------------------------------------------------- the cases - */

const cases = [];
let thrown = 0;
while (cases.length < CASES) {
  const base = random() < 0.25 ? pick(special) : pick(bases);
  const hand = JSON.parse(base.text);
  const ops = [];
  const count = 1 + below(4);
  for (let k = 0; k < count; k += 1) {
    const op = drawOp(hand);
    apply(hand, op);
    ops.push(op);
  }
  // Derive from a fresh copy: `handFacts` may write positions into its input.
  let rows;
  try {
    rows = rowsHash(JSON.parse(JSON.stringify(hand)));
  } catch {
    thrown += 1;
    continue;
  }
  cases.push({ file: base.file, hand: base.hand, phf: sha16(base.text), ops, rows });
}

const out = {
  meta: {
    note: "written by stats-vectors.mjs; do not edit",
    seed: STRESS ?? "default",
    cases: cases.length,
    thrown,
  },
  cases,
};
writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(`stats vectors: ${cases.length} cases (${thrown} thrown, left out) -> ${OUT}`);
