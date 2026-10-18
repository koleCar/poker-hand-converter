/**
 * The flop library on the heads-up sets (`charts/8`, `charts/9`): the lines
 * the runner solves (`FLOP_LINES_HU`), their spots, and the analysis reading
 * a heads-up chunk. Heads-up the small blind is the button: it acts first
 * preflop and last after the flop, so the big blind is player 0 (out of
 * position) of every heads-up chunk.
 *
 * The chunk here is solved in the test on the 4-bet pot (the narrowest
 * ranges) with the small tree of `flopLibrary.test.ts`, so it takes seconds.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  analyzeHand,
  chartLineOf,
  chunkFor,
  FLOP_LINES_HU,
  FLOP_PROFILE,
  flopLinesFor,
  flopPlayersOf,
  libraryEntry,
  lineSeats,
  memoryLibrary,
  postflopFirst,
  sameLine,
  type FlopEntry,
  type FlopProfile,
} from "../../frontend/src/lib/analysis/index.js";
import { loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { cardCode } from "../../frontend/src/lib/equity/evaluator.js";
import { comboHi, comboLo, decodeChunk, parseCombo, type FlopChunk } from "../../frontend/src/lib/solver/index.js";
import { buildContext } from "../../frontend/src/lib/stats/context.js";
import { HEADS_UP_SCRIPT_POSITIONS, scriptHand, seatOf, type ScriptAct } from "../../frontend/src/lib/training/handText.js";
import { lineActs } from "../../frontend/src/lib/training/preflop.js";
import { solveJob, type Job } from "../scripts/flop-library/job.js";
import { lineSpot } from "../scripts/flop-library/spots.js";
import { fullLibrary } from "./charts/support.js";

const load = (id: string): ChartSet =>
  loadCharts(JSON.parse(readFileSync(join(import.meta.dirname, `../../frontend/src/lib/charts/data/${id}.json`), "utf8")));
const HU100 = load("nlhe-cash-hu-100bb");
const HU150 = load("nlhe-cash-hu-150bb");
const SEATS = HEADS_UP_SCRIPT_POSITIONS;

/** The pot at the flop and the stack behind, bb, on each line at 100bb (the heads-up tree's sizes: 2.5 / 10 / 22 opens and raises, 4 over a limp). */
const MONEY: Record<string, [number, number]> = {
  "sb-bb": [5, 97.5],
  "sb-limp": [2, 99],
  "sb-bb-3bet": [20, 90],
  "sb-limp-raise": [8, 96],
  "sb-bb-4bet": [44, 78],
};

describe("the heads-up lines", () => {
  it("are the heads-up sets' lines, with the big blind out of position on every one", () => {
    expect(flopLinesFor(2)).toBe(FLOP_LINES_HU);
    expect(new Set(FLOP_LINES_HU.map((l) => l.id)).size).toBe(FLOP_LINES_HU.length);
    for (const line of FLOP_LINES_HU) {
      expect(line.players).toBe(2);
      expect(lineSeats(line)).toEqual(["SB", "BB"]);
      expect(flopPlayersOf(line.key, lineSeats(line))).toEqual(["BB", "SB"]);
    }
  });

  it("play on both heads-up sets: chart ranges both sides, the line's pot and stack", () => {
    for (const charts of [HU100, HU150]) {
      for (const line of FLOP_LINES_HU) {
        const spot = lineSpot(charts, line);
        expect(spot.players).toEqual(["BB", "SB"]);
        const [pot, stack] = MONEY[line.id];
        expect(spot.pot).toBeCloseTo(pot, 6);
        expect(spot.stack).toBeCloseTo(stack + charts.game.stackBb - 100, 6);
        for (const range of spot.ranges) {
          const combos = range.reduce((s, w) => s + w, 0);
          expect(combos).toBeGreaterThan(20);
          expect(combos).toBeLessThan(1326);
        }
      }
    }
    // The small blind opens 2.5bb and the big blind calls with ~40% of hands: both ranges wide.
    const srp = lineSpot(HU100, FLOP_LINES_HU[0]);
    expect(srp.ranges[0].reduce((s, w) => s + w, 0)).toBeGreaterThan(400);
    expect(srp.ranges[1].reduce((s, w) => s + w, 0)).toBeGreaterThan(600);
  });

  it("are not the 6-max or full-ring lines (no folds before the flop players)", () => {
    expect(flopLinesFor(6).some((l) => l.players === 2)).toBe(false);
    expect(flopLinesFor(9).some((l) => l.players === 2)).toBe(false);
    expect(sameLine("rc", "rc")).toBe(true);
    expect(sameLine("rrc", "rc")).toBe(false);
  });
});

/* ------------------------------------------------------------ a chunk - */

const SMALL: FlopProfile = {
  ...FLOP_PROFILE,
  tree: "flop-test",
  flopMenu: { bet: [0.33, 0.75], raise: [], allIn: false },
  flopRaiseCap: 0,
  turnMenu: { bet: [], raise: [], allIn: false },
  riverMenu: { bet: [], raise: [], allIn: false },
  targetPct: 2,
  maxIterations: 40,
  checkFrom: 40,
  checkEvery: 40,
};

const LINE = FLOP_LINES_HU.find((l) => l.id === "sb-bb-4bet")!;
const FLOP = "Ts7h4d";
let chunk: FlopChunk;

beforeAll(() => {
  const spot = lineSpot(HU100, LINE);
  const job: Job = {
    id: `${LINE.id}/${FLOP}`,
    line: LINE.id,
    lineKey: LINE.key,
    flop: FLOP,
    players: spot.players,
    ranges: [Array.from(spot.ranges[0]), Array.from(spot.ranges[1])],
    pot: spot.pot,
    stack: spot.stack,
    charts: { id: HU100.id, version: HU100.version, hash: HU100.model.hash },
    rake: { name: "test", percent: 0.05, cap: 3 },
    profile: SMALL,
  };
  chunk = decodeChunk(solveJob(job).bytes);
}, 120_000);

/** Player `p`'s heaviest combo in the chunk: a hand the line surely holds. */
function cardsOf(p: 0 | 1): [string, string] {
  const weights = chunk.result.weights[p];
  let best = 0;
  for (let i = 1; i < weights.length; i += 1) if (weights[i] > weights[best]) best = i;
  const combo = chunk.result.hands[p][best];
  return [cardCode(comboHi(combo)), cardCode(comboLo(combo))];
}

/** The big blind's most frequent lead at the root. */
function lead(): { to: number; path: string } {
  const root = chunk.result.nodes[0];
  let best = -1;
  root.actions.forEach((action, a) => {
    if (action.kind === "bet" && (best < 0 || root.frequency[a] > root.frequency[best])) best = a;
  });
  return { to: root.actions[best].to, path: root.labels[best] };
}

function handOn(hero: "SB" | "BB", flop: ScriptAct[], stackBb = 100, charts: ChartSet = HU100) {
  return scriptHand({
    id: "FLHU",
    seats: SEATS,
    hero,
    heroCards: cardsOf(hero === "BB" ? 0 : 1),
    stackBb,
    preflop: lineActs(charts, LINE.key),
    board: ["Ts", "7h", "4d"],
    flop,
  });
}

const flopDecision = (hand: ReturnType<typeof handOn>, charts: Parameters<typeof analyzeHand>[1]["charts"] = HU100) =>
  analyzeHand(hand, { charts, turn: false, flopLibrary: memoryLibrary([chunk]) }).decisions.find((d) => d.street === "flop");

describe("a heads-up hand reading the library", () => {
  it("places the hand on its heads-up line and chunk", () => {
    const hand = handOn("SB", [{ position: "BB", type: "check" }]);
    const context = buildContext(hand);
    // The small blind is the button: it seats first and posts the small blind.
    expect(context.position.get(seatOf("SB", SEATS))).toBe("SB");
    expect(context.position.get(seatOf("BB", SEATS))).toBe("BB");
    expect(chartLineOf(hand, [seatOf("SB", SEATS), seatOf("BB", SEATS)], HU100)?.line).toBe("rrrc");
    const found = chunkFor(hand, context, HU100, { has: () => true });
    expect(found).toMatchObject({ set: "nlhe-cash-hu-100bb", flop: FLOP, exact: true });
    expect(found?.line).toBe(LINE);
  });

  it("puts the big blind first after the flop heads-up, the small blind first on a bigger table", () => {
    const hu = buildContext(handOn("SB", [{ position: "BB", type: "check" }]));
    expect(postflopFirst(hu, "BB", "SB")).toBe(true);
    expect(postflopFirst(hu, "SB", "BB")).toBe(false);
    const ring = { dealtInSeats: [1, 2, 3, 4, 5, 6] };
    expect(postflopFirst(ring, "SB", "BB")).toBe(true);
    expect(postflopFirst(ring, "BB", "BTN")).toBe(true);
  });

  it("grades the small blind (in position) facing the big blind's lead, combo for combo", () => {
    const hand = handOn("SB", [{ position: "BB", type: "bet", to: lead().to }, { position: "SB", type: "call" }]);
    const entry = libraryEntry(hand, buildContext(hand), seatOf("SB", SEATS), HU100, memoryLibrary([chunk])) as FlopEntry;
    expect(entry.heroFirst).toBe(false);
    const decision = flopDecision(hand);
    expect(decision?.source).toBe("solver");
    expect(decision?.facts.flop).toMatchObject({ source: "library", line: LINE.id, flop: FLOP, mapped: false, path: lead().path, bucket: null });
    const node = chunk.result.nodes.find((n) => n.path === lead().path)!;
    const n = chunk.result.hands[1].length;
    const i = chunk.result.hands[1].indexOf(parseCombo(cardsOf(1).join("")));
    expect(i).toBeGreaterThanOrEqual(0);
    decision!.options.forEach((option, a) => {
      expect(option.freq).toBeCloseTo(node.strategy[a * n + i], 3);
      expect(option.ev).toBeCloseTo(node.ev[a * n + i], 2);
    });
  });

  it("grades the big blind (out of position) at the root", () => {
    const hand = handOn("BB", [{ position: "BB", type: "check" }, { position: "SB", type: "check" }]);
    const entry = libraryEntry(hand, buildContext(hand), seatOf("BB", SEATS), HU100, memoryLibrary([chunk])) as FlopEntry;
    expect(entry.heroFirst).toBe(true);
    const decision = flopDecision(hand);
    expect(decision?.source).toBe("solver");
    const root = chunk.result.nodes[0];
    const n = chunk.result.hands[0].length;
    const i = chunk.result.hands[0].indexOf(parseCombo(cardsOf(0).join("")));
    decision!.options.forEach((option, a) => expect(option.freq).toBeCloseTo(root.strategy[a * n + i], 3));
  });

  it("reads the set the hand's depth was answered from (a chart library)", () => {
    const library = fullLibrary();
    const lead100 = { position: "BB" as const, type: "bet" as const, to: lead().to };
    expect(flopDecision(handOn("SB", [lead100, { position: "SB", type: "call" }]), library)?.source).toBe("solver");
    // 150bb: the 150bb heads-up set answers; this library has nothing solved from it.
    const deep = handOn("SB", [lead100, { position: "SB", type: "call" }], 150, HU150);
    expect(chunkFor(deep, buildContext(deep), library, { has: () => true })?.set).toBe("nlhe-cash-hu-150bb");
    expect(flopDecision(deep, library)?.source).toBe("heuristic");
  });
});
