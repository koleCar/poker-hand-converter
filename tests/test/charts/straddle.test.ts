/**
 * Straddles: Rail's generator tree with a 2bb straddle from UTG (docs/CHARTS.md
 * §1.4), which straddled spots the library reads on the straddle set (GTO
 * Wizard's 6-max "Straddle + Ante" since `charts/11`, read with or without an
 * ante) and which it refuses, by name. Reading the set's own nodes waits for
 * its transcription (skipped below).
 */

import { describe, expect, it } from "vitest";

import { analyzeHand, ANALYSIS_VERSION } from "../../../web/src/lib/analysis/index.js";
import {
  chartLibrary,
  lookupPreflop,
  pickChartSet,
  requiredChartSets,
  type ChartLookup,
  type ChartSetSpec,
  type PreflopActionInput,
  type PreflopSpot,
} from "../../../web/src/lib/charts/index.js";
import { positionRing, type Position } from "../../../web/src/lib/phf/types.js";
import { buildPreflopTree, SIX_MAX } from "../../../web/src/lib/solver/preflopTree.js";
import { dealPreflop, preflopAnswer } from "../../../web/src/lib/training/preflop.js";
import { gradeAnswer } from "../../../web/src/lib/training/grade.js";
import { scriptHand } from "../../../web/src/lib/training/handText.js";
import { chartSet, SIX_MAX_100, TEST_CHART_SETS } from "./support.js";

const ID = "nlhe-cash-6max-100bb-straddle";
const STRADDLE_SIZING = { open: 5, sbOpen: 6, isoVsLimp: 8, isoPerLimper: 2, isoOop: 2, allInAbove: 0.4 };

const act = (position: Position, type: PreflopActionInput["type"], toBb?: number): PreflopActionInput =>
  toBb === undefined ? { position, type } : { position, type, toBb };

/**
 * A `k`-handed straddled spot, every stack `stack`: the first seat left of
 * the big blind straddles `size`, the action starts left of it, and
 * `before` are the decisions before the hero's (folds to the hero by default).
 */
function straddled(
  k: number,
  hero: Position,
  options: { stack?: number; size?: number; before?: PreflopActionInput[]; straddler?: Position; extra?: Partial<PreflopSpot> } = {},
): PreflopSpot {
  const ring = positionRing(k);
  const straddler = options.straddler ?? ring[2];
  const order = [...ring.slice(3), "SB", "BB", ring[2]] as Position[];
  const actions = options.before ?? order.slice(0, order.indexOf(hero)).map((p) => act(p, "fold"));
  const stacksBb = Object.fromEntries(ring.map((p) => [p, options.stack ?? 100]));
  return {
    positions: ring,
    hero,
    actions,
    stacksBb,
    straddle: true,
    straddles: [{ position: straddler, toBb: options.size ?? 2 }],
    ...options.extra,
  };
}

/**
 * The test library's specs and the planned straddle set (not transcribed yet,
 * so not loadable): which set a straddled spot picks reads only the specs.
 */
const SPECS: readonly ChartSetSpec[] = [
  ...TEST_CHART_SETS,
  { id: ID, players: 6, stackBb: 100, straddle: { position: "UTG", bb: 2 }, ante: 0.166, load: () => Promise.reject(new Error("not transcribed")) },
];

const pickId = (spot: PreflopSpot) => {
  const pick = pickChartSet(SPECS, spot);
  return pick.ok ? pick.spec.id : `${pick.reason}: ${pick.detail}`;
};

function ok(result: ChartLookup) {
  if (!result.ok) throw new Error(`expected a node, got ${result.reason}: ${result.detail}`);
  return result;
}

describe("the straddled tree", () => {
  const tree = buildPreflopTree({ players: SIX_MAX, stackBb: 100, sizing: STRADDLE_SIZING, maxLimpers: 3, straddle: { position: "UTG", bb: 2 } });
  const options = (line: string) => {
    const node = tree.lineIndex.get(line) as number;
    const start = tree.childStart[node];
    return {
      actor: tree.players[tree.actor[node]],
      edges: Array.from({ length: tree.childCount[node] }, (_, a) => `${tree.edgeCode[start + a]}${tree.edgeTo[start + a]}`),
    };
  };

  it("starts left of the straddler and gives it the option last", () => {
    expect(tree.players).toEqual(["HJ", "CO", "BTN", "SB", "BB", "UTG"]);
    expect(tree.straddle).toEqual({ position: "UTG", bb: 2 });
    // Unopened at 2bb to match: fold, limp 2, open to 5 (2.5 straddles).
    expect(options("")).toEqual({ actor: "HJ", edges: ["f0", "c2", "r5"] });
    // The blinds face the straddle: either completes or raises 6bb (3 straddles).
    expect(options("fff")).toEqual({ actor: "SB", edges: ["f0.5", "c2", "r6"] });
    expect(options("ffff")).toEqual({ actor: "BB", edges: ["f1", "c2", "r6"] });
    // Folded to the straddler: a walk, no node. Behind a limp it checks or isolates.
    expect(tree.lineIndex.has("fffff")).toBe(false);
    expect(options("ffffc")).toEqual({ actor: "UTG", edges: ["k2", "r8"] });
    expect(options("cffff")).toEqual({ actor: "UTG", edges: ["k2", "r10"] });
    // Facing an open the straddler calls or 3-bets 4x out of position; the 4-bet over it is all-in (past 40bb).
    expect(options("ffrff")).toEqual({ actor: "UTG", edges: ["f2", "c5", "r20"] });
    expect(options("ffrffr")).toEqual({ actor: "BTN", edges: ["f5", "c20", "a100"] });
  });

  it("leaves trees without a straddle exactly as they were", () => {
    expect(buildPreflopTree({ players: SIX_MAX, stackBb: 100 }).actionNodes).toBe(3825);
    expect(buildPreflopTree({ players: SIX_MAX, stackBb: 100, maxLimpers: 3 }).actionNodes).toBe(10361);
    expect(buildPreflopTree({ players: SIX_MAX, stackBb: 100 }).straddle).toBeNull();
  });

  it("takes a straddle only from the first seat left of the big blind", () => {
    expect(() => buildPreflopTree({ players: SIX_MAX, straddle: { position: "BTN", bb: 2 } })).toThrow(/first seat left/);
    expect(() => buildPreflopTree({ players: ["SB", "BB"], straddle: { position: "SB", bb: 2 } })).toThrow();
    expect(() => buildPreflopTree({ players: SIX_MAX, straddle: { position: "UTG", bb: 1 } })).toThrow(/more than the big blind/);
  });
});

describe("straddled spots in the library", () => {
  const library = chartLibrary([chartSet(SIX_MAX_100)], SPECS);

  it("reads a single 2bb straddle from the seat left of the big blind, 4-6 handed, near 100bb, on the straddle set", () => {
    expect(pickId(straddled(6, "HJ"))).toBe(ID);
    expect(pickId(straddled(5, "CO"))).toBe(ID);
    expect(pickId(straddled(4, "BTN"))).toBe(ID);
    expect(pickId(straddled(6, "BTN", { stack: 115 }))).toBe(ID);
    // An unstraddled spot never lands on it.
    expect(pickChartSet(SPECS, { ...straddled(6, "BTN"), straddle: false, straddles: undefined })).toMatchObject({
      ok: true,
      spec: { id: SIX_MAX_100 },
    });
    // The straddle set is GTO Wizard's "Straddle + Ante": a straddled hand reads it with or without an ante.
    expect(pickId(straddled(6, "BTN", { extra: { ante: true, anteBb: 0.16 } }))).toBe(ID);
    expect(pickId(straddled(6, "BTN", { extra: { ante: true } }))).toBe(ID);
  });

  it("refuses every other straddle by name, with what it was", () => {
    const refused = (spot: PreflopSpot) => {
      const result = lookupPreflop(library, spot, "AA");
      expect(result.ok).toBe(false);
      return result.ok ? null : result;
    };
    expect(refused(straddled(6, "BTN", { stack: 150 }))).toMatchObject({ reason: "straddle", detail: expect.stringMatching(/150bb effective/) });
    expect(refused(straddled(6, "BTN", { size: 3 }))).toMatchObject({ reason: "straddle", detail: expect.stringMatching(/3bb straddle/) });
    expect(refused(straddled(6, "SB", { straddler: "BTN" }))).toMatchObject({ reason: "straddle", detail: expect.stringMatching(/BTN straddled/) });
    expect(refused(straddled(3, "SB"))).toMatchObject({ reason: "straddle", detail: expect.stringMatching(/3-handed/) });
    expect(refused(straddled(8, "BTN"))).toMatchObject({ reason: "straddle", detail: expect.stringMatching(/8-handed/) });
    const twice = straddled(6, "BTN");
    expect(refused({ ...twice, straddles: [{ position: "UTG", toBb: 2 }, { position: "HJ", toBb: 4 }] })).toMatchObject({
      reason: "straddle",
      detail: expect.stringMatching(/re-straddle/),
    });
  });

  it("refuses across kinds when given one set: no straddle on a plain set, none missing on the straddle set", () => {
    expect(lookupPreflop(chartSet(SIX_MAX_100), straddled(6, "BTN"), "AA")).toMatchObject({ ok: false, reason: "straddle" });
    // The straddle set's own side needs its data: below, skipped until it is transcribed.
  });

  // Needs the straddle set's data; none transcribed yet (and its sizes will be GTO Wizard's, not these).
  it.skip("walks a straddled line onto the set: the first seat, the blinds, the straddler's option", () => {
    const first = ok(lookupPreflop(library, straddled(6, "HJ"), "AKs", act("HJ", "raise", 5)));
    expect(first.set.id).toBe(ID);
    expect(first.node.line).toBe("");
    expect(first.options.map((o) => o.action)).toEqual(["fold", "call", "raise"]);
    expect(first.approximations).toEqual([]);
    expect(first.chosen).toBe(2);

    // The button opens to 5bb, the blinds fold: the straddler calls, 3-bets or folds.
    const before = [act("HJ", "fold"), act("CO", "fold"), act("BTN", "raise", 5), act("SB", "fold"), act("BB", "fold")];
    const option = ok(lookupPreflop(library, straddled(6, "UTG", { before }), "QQ", act("UTG", "raise", 20)));
    expect(option.node.line).toBe("ffrff");
    expect(option.node.actor).toBe("UTG");
    expect(option.chosen).toBe(2);
    expect(option.approximations).toEqual([]);

    // Limped to the straddler: check or isolate.
    const limped = [act("HJ", "call", 2), act("CO", "fold"), act("BTN", "fold"), act("SB", "fold"), act("BB", "fold")];
    const check = ok(lookupPreflop(library, straddled(6, "UTG", { before: limped }), "72o", act("UTG", "check")));
    expect(check.node.line).toBe("cffff");
    expect(check.node.options.map((o) => o.action)).toEqual(["check", "raise"]);
    expect(check.chosen).toBe(0);
  });

  // Needs the straddle set's data; none transcribed yet.
  it.skip("reads a smaller table with the seats left of the straddler folded", () => {
    // Five-handed: UTG straddles, the CO acts first - the set's HJ folded.
    const five = ok(lookupPreflop(library, straddled(5, "CO"), "AA"));
    expect(five.node.line).toBe("f");
    expect(five.node.actor).toBe("CO");
    expect(five.approximations.map((a) => a.kind)).toEqual(["short-handed"]);
    // Four-handed: the CO is the first seat left of the big blind and straddles; the button acts first.
    const four = ok(lookupPreflop(library, straddled(4, "BTN"), "AA"));
    expect(four.node.line).toBe("ff");
    expect(four.node.actor).toBe("BTN");
    const fourStraddler = ok(
      lookupPreflop(
        library,
        straddled(4, "CO", { before: [act("BTN", "raise", 5), act("SB", "fold"), act("BB", "fold")] }),
        "AA",
        act("CO", "raise", 20),
      ),
    );
    expect(fourStraddler.node.line).toBe("ffrff");
    expect(fourStraddler.node.actor).toBe("UTG");
  });
});

describe("a straddled hand, end to end", () => {
  const library = chartLibrary([chartSet(SIX_MAX_100)], SPECS);
  // A 6-max $0.5/$1 hand: UTG straddles $2, the hero opens the button to $5,
  // the straddler calls; a flop is checked through.
  const hand = scriptHand({
    id: "STRADDLE1",
    hero: "BTN",
    heroCards: ["Ah", "Kh"],
    stackBb: 100,
    straddle: { position: "UTG", bb: 2 },
    preflop: [
      { position: "HJ", type: "fold" },
      { position: "CO", type: "fold" },
      { position: "BTN", type: "raise", to: 5 },
      { position: "SB", type: "fold" },
      { position: "BB", type: "fold" },
      { position: "UTG", type: "call" },
    ],
    board: ["7c", "4d", "2s"],
    flop: [
      { position: "UTG", type: "check" },
      { position: "BTN", type: "check" },
    ],
  });

  it("knows the set it needs", () => {
    expect(requiredChartSets(hand, library.specs)).toEqual([ID]);
  });

  // Needs the straddle set's data; none transcribed yet.
  it.skip("grades the straddled open from the straddle set, and counts the straddle in the pot", () => {
    const analysis = analyzeHand(structuredClone(hand), { charts: library, turn: false });
    expect(analysis.version).toBe(ANALYSIS_VERSION);
    const preflop = analysis.decisions.find((d) => d.street === "preflop");
    expect(preflop?.source).toBe("chart");
    expect(preflop?.facts.chart).toMatchObject({ set: ID, line: "ff", scenario: "rfi" });
    // Before the open: 0.5 + 1 + 2 in the pot.
    expect(preflop?.facts.potBb).toBe(3.5);
    expect(preflop?.approximations).not.toContain("straddle");
    // The flop: 5 + 5 + 0.5 + 1, 95 behind; the villain's range is the straddle set's call.
    const flop = analysis.decisions.find((d) => d.street === "flop");
    expect(flop?.facts.potBb).toBe(11.5);
    expect(flop?.facts.effStackBb).toBe(95);
    expect(flop?.facts.equity?.source).not.toBe("placeholder");
    expect(flop?.approximations).not.toContain("placeholder-range");
  });

  it("keeps the straddle approximation on a straddle the charts do not model", () => {
    const deep = scriptHand({
      id: "STRADDLE2",
      hero: "BTN",
      heroCards: ["Ah", "Kh"],
      stackBb: 200,
      straddle: { position: "UTG", bb: 2 },
      preflop: [
        { position: "HJ", type: "fold" },
        { position: "CO", type: "fold" },
        { position: "BTN", type: "raise", to: 5 },
      ],
    });
    const analysis = analyzeHand(structuredClone(deep), { charts: library, turn: false });
    const preflop = analysis.decisions.find((d) => d.street === "preflop");
    expect(preflop?.source).not.toBe("chart");
    expect(preflop?.reason).toBe("chart-straddle");
    expect(preflop?.approximations).toContain("straddle");
  });

  // Needs the straddle set's data; none transcribed yet.
  it.skip("deals and grades a trainer spot from the straddle set", () => {
    const spot = dealPreflop(library, { family: "rfi", set: ID, seat: "BTN" }, 7);
    expect(spot?.set).toBe(ID);
    expect(spot?.hand.actions.some((a) => a.type === "straddle")).toBe(true);
    const answer = preflopAnswer(spot as NonNullable<typeof spot>, 0);
    const graded = gradeAnswer(answer.hand, answer.actionIndex, library);
    expect(graded?.source).toBe("chart");
    expect(graded?.facts.chart?.set).toBe(ID);
  });
});
