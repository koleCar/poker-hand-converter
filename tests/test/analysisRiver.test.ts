/**
 * River grading with our solver (phase A4, `docs/ANALYSIS-PLAN.md` §3.2–§3.5).
 *
 * Three layers, each on spots small enough to reason about:
 *
 * - **Narrowing** (`narrowing.ts`, `rangeWalk.ts`): properties that hold
 *   whatever the constants — weights only go down, card removal is exact,
 *   a bet makes a range stronger and a call cuts its bottom, a river bet's
 *   bluff share is the one that makes a bluff-catcher indifferent.
 * - **Grades with known answers**: the nuts never folds, air does not call,
 *   a hand the solver bets is graded for checking back, a bluff-catcher
 *   against a polar range is indifferent and defends the MDF (the
 *   clairvoyance game's closed form).
 * - **The line onto the tree** (translation, off-tree caps), determinism,
 *   and the study view equal to the stored row.
 *
 * No chart frequency is pinned: the chart set is regenerated (`charts/2`)
 * independently of this suite.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BLUFF_ZONE,
  FLOOR,
  RIVER_MENU,
  analyzeHand,
  bluffShare,
  comboRange,
  followLine,
  gradeRank,
  gradeRiver,
  handStrength,
  heuristicModel,
  hitChance,
  narrow,
  optionsAt,
  percentiles,
  rangeWeight,
  removeCards,
  riverActs,
  riverCategory,
  riverStudy,
  solveRiverSpot,
  streetStrength,
  walkRanges,
  type DecisionAnalysis,
  type HandAnalysis,
  type RiverAct,
  type RiverSolve,
} from "../../frontend/src/lib/analysis/index.js";
import { GRID_CELLS } from "../../frontend/src/components/analysis/chartSpots.js";
import { loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { evaluate } from "../../frontend/src/lib/equity/index.js";
import { parseRange as parseClassRange } from "../../frontend/src/lib/equity/range.js";
import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr } from "../../frontend/src/lib/i18n/hr.js";
import { conceptsForDecision } from "../../frontend/src/lib/learn/links.js";
import { parseStandardHand } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import {
  comboHi,
  comboIndex,
  comboLo,
  HAND_CLASSES,
  NUM_COMBOS,
  parseCards,
  parseRange,
} from "../../frontend/src/lib/solver/index.js";
import { buildContext } from "../../frontend/src/lib/stats/context.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const FEES = "| Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0";
const analyse = (h: PhfHand) => analyzeHand(structuredClone(h), { charts: CHARTS });

/* --------------------------------------------------------------- hands - */

let serial = 0;

/**
 * A six-handed $0.5/$1 hand, 100bb deep: everyone folds to the button, which
 * opens to 2.5; the small blind folds and the big blind calls. Then the given
 * postflop streets. `hero` is "Btn" or "Bb".
 */
function headsUp(opts: {
  hero: "Btn" | "Bb";
  cards: string;
  board: [string, string, string, string, string];
  flop: string[];
  turn: string[];
  river: string[];
  stack?: number;
}): PhfHand {
  serial += 1;
  const [f1, f2, f3, t, r] = opts.board;
  const stack = opts.stack ?? 100;
  const text = [
    `Poker Hand #RV${serial}: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00`,
    "Table 'Rv' 6-max Seat #1 is the button",
    ...["Btn", "Sb", "Bb", "Utg", "Hj", "Co"].map((name, i) => `Seat ${i + 1}: ${name} ($${stack} in chips)`),
    "Sb: posts small blind $0.5",
    "Bb: posts big blind $1",
    "*** HOLE CARDS ***",
    `Dealt to ${opts.hero} [${opts.cards}]`,
    "Utg: folds",
    "Hj: folds",
    "Co: folds",
    "Btn: raises $1.5 to $2.5",
    "Sb: folds",
    "Bb: calls $1.5",
    `*** FLOP *** [${f1} ${f2} ${f3}]`,
    ...opts.flop,
    `*** TURN *** [${f1} ${f2} ${f3}] [${t}]`,
    ...opts.turn,
    `*** RIVER *** [${f1} ${f2} ${f3} ${t}] [${r}]`,
    ...opts.river,
    "*** SHOWDOWN ***",
    "Btn collected $10 from pot",
    "*** SUMMARY ***",
    `Total pot $10 ${FEES}`,
  ].join("\n");
  const parsed = parseStandardHand(text, CTX);
  if (!parsed) throw new Error(`fixture did not parse:\n${text}`);
  return parsed;
}

const river = (analysis: HandAnalysis, action: string): DecisionAnalysis => {
  const found = analysis.decisions.find((d) => d.street === "river" && d.action === action);
  if (!found) throw new Error(`no river ${action}`);
  return found;
};

const freqOf = (d: DecisionAnalysis, action: string) =>
  d.options.filter((o) => o.action === action).reduce((sum, o) => sum + o.freq, 0);

/* -------------------------------------------------------- narrowing - */

const BOARD = parseCards(["Kd", "7c", "2s", "9h", "3d"]);
const FLOP = BOARD.slice(0, 3);
const BTN = comboRange(parseClassRange("22+, A2s+, K5s+, Q7s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, A5o+, K9o+, QTo+, JTo"));
const BB = comboRange(parseClassRange("22-JJ, A2s+, K2s+, Q4s+, J6s+, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K7o+, Q9o+, J9o+, T9o"));

const narrowed = (street: "flop" | "turn" | "river", kind: "check" | "bet" | "call" | "raise", sizePot: number | null) => {
  const board = street === "flop" ? FLOP : street === "turn" ? BOARD.slice(0, 4) : BOARD;
  const actor = removeCards(Float64Array.from(BTN), board);
  const opponent = removeCards(Float64Array.from(BB), board);
  const after = narrow({ street, board, actor, opponent, action: { kind, sizePot, allIn: false } });
  return { board, actor, opponent, after };
};

describe("narrowing (heuristic/1)", () => {
  it("only ever lowers a weight, never below the floor of a live combo, and keeps zeros zero", () => {
    for (const street of ["flop", "turn", "river"] as const) {
      for (const [kind, size] of [
        ["check", null],
        ["bet", 0.33],
        ["bet", 1.5],
        ["call", 0.75],
        ["raise", 0.75],
      ] as const) {
        const { actor, after } = narrowed(street, kind, size);
        for (let c = 0; c < NUM_COMBOS; c += 1) {
          expect(after[c]).toBeLessThanOrEqual(actor[c] + 1e-12);
          if (actor[c] === 0) expect(after[c]).toBe(0);
          else expect(after[c]).toBeGreaterThanOrEqual(actor[c] * FLOOR - 1e-12);
        }
        expect(rangeWeight(after)).toBeLessThanOrEqual(rangeWeight(actor));
        expect(rangeWeight(after)).toBeGreaterThan(0);
      }
    }
  });

  it("removes the board's cards exactly, and measures strength with card removal", () => {
    const range = removeCards(Float64Array.from(BTN), BOARD);
    for (let c = 0; c < NUM_COMBOS; c += 1) {
      const blocked = BOARD.includes(comboHi(c)) || BOARD.includes(comboLo(c));
      if (blocked) expect(range[c]).toBe(0);
      else expect(range[c]).toBe(BTN[c]);
    }
    // Hand strength against a small range, against a brute-force count.
    const opponent = removeCards(parseRange("KK, 99, AKs, KQo:0.5, 87s, 54s"), BOARD);
    const hs = handStrength(streetStrength(BOARD), opponent);
    for (const code of ["AhKh", "QsQh", "9c9d", "8s6s", "AcQc"]) {
      const combo = comboIndex(parseCards([code.slice(0, 2)])[0], parseCards([code.slice(2)])[0]);
      const mine = evaluate([comboHi(combo), comboLo(combo), ...BOARD]);
      let beats = 0;
      let total = 0;
      for (let o = 0; o < NUM_COMBOS; o += 1) {
        const w = opponent[o];
        if (!(w > 0)) continue;
        const cards = [comboHi(o), comboLo(o)];
        if (cards.includes(comboHi(combo)) || cards.includes(comboLo(combo))) continue;
        const theirs = evaluate([...cards, ...BOARD]);
        beats += w * (mine > theirs ? 1 : mine === theirs ? 0.5 : 0);
        total += w;
      }
      expect(hs[combo]).toBeCloseTo(beats / total, 12);
    }
  });

  it("makes a betting range stronger and cuts the bottom of a calling range", () => {
    const strength = streetStrength(BOARD);
    const opponent = removeCards(Float64Array.from(BB), BOARD);
    const mean = (range: Float64Array) => {
      const hs = handStrength(strength, opponent);
      let sum = 0;
      let weight = 0;
      for (let c = 0; c < NUM_COMBOS; c += 1) {
        if (range[c] > 0 && !Number.isNaN(hs[c])) {
          sum += range[c] * hs[c];
          weight += range[c];
        }
      }
      return sum / weight;
    };
    const { actor: before, after: bet } = narrowed("river", "bet", 0.75);
    const { after: check } = narrowed("river", "check", null);
    const { after: call } = narrowed("river", "call", 0.75);
    expect(mean(bet)).toBeGreaterThan(mean(before));
    expect(mean(check)).toBeLessThan(mean(bet));
    // A call: the share of the range in the bottom quarter drops.
    const q = percentiles(handStrength(strength, opponent), before);
    const bottom = (range: Float64Array) => {
      let low = 0;
      for (let c = 0; c < NUM_COMBOS; c += 1) if (q[c] < 0.25) low += range[c];
      return low / rangeWeight(range);
    };
    expect(bottom(call)).toBeLessThan(bottom(before) / 3);
  });

  it("calls monotonically in strength on the river, below the very top", () => {
    const { actor, after } = narrowed("river", "call", 0.5);
    const strength = streetStrength(BOARD);
    const opponent = removeCards(Float64Array.from(BB), BOARD);
    const q = percentiles(handStrength(strength, opponent), actor);
    const live = [...Array(NUM_COMBOS).keys()].filter((c) => actor[c] > 0 && q[c] < 0.95).sort((a, b) => q[a] - q[b]);
    let last = 0;
    for (const c of live) {
      const likelihood = after[c] / actor[c];
      expect(likelihood).toBeGreaterThanOrEqual(last - 1e-9);
      last = likelihood;
    }
  });

  it("bluffs on the river in the share that makes a bluff-catcher indifferent", () => {
    for (const size of [0.33, 0.75, 1.5]) {
      const { actor, after } = narrowed("river", "bet", size);
      const q = percentiles(handStrength(streetStrength(BOARD), removeCards(Float64Array.from(BB), BOARD)), actor);
      let bluffs = 0;
      for (let c = 0; c < NUM_COMBOS; c += 1) if (actor[c] > 0 && q[c] < BLUFF_ZONE) bluffs += after[c];
      // Middle hands still take the floor, so the share lands at T(x) give or take that.
      expect(bluffs / rangeWeight(after)).toBeGreaterThan(bluffShare(size) - 0.03);
      expect(bluffs / rangeWeight(after)).toBeLessThan(bluffShare(size) + 0.03);
    }
  });

  it("turns outs into the chance of hitting", () => {
    expect(hitChance(9, 3)).toBeCloseTo(1 - (38 / 47) * (37 / 46), 10);
    expect(hitChance(9, 4)).toBeCloseTo(9 / 46, 10);
    expect(hitChance(9, 5)).toBe(0);
    expect(hitChance(0, 3)).toBe(0);
  });

  it("is a model behind an interface: likelihoods in [0, 1] for every combo of the range", () => {
    const { actor, board } = narrowed("turn", "bet", 0.75);
    const likelihood = heuristicModel.likelihood({
      street: "turn",
      board,
      actor,
      opponent: removeCards(Float64Array.from(BB), board),
      action: { kind: "bet", sizePot: 0.75, allIn: false },
    });
    expect(heuristicModel.id).toBe("heuristic/1");
    for (let c = 0; c < NUM_COMBOS; c += 1) {
      if (actor[c] > 0) {
        expect(likelihood[c]).toBeGreaterThanOrEqual(FLOOR);
        expect(likelihood[c]).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("the range walk", () => {
  const h = headsUp({
    hero: "Bb",
    cards: "Kh Qh",
    board: ["Kd", "7c", "2s", "9h", "3d"],
    flop: ["Bb: checks", "Btn: bets $2", "Bb: calls $2"],
    turn: ["Bb: checks", "Btn: checks"],
    river: ["Bb: checks", "Btn: bets $6", "Bb: calls $6"],
  });
  const context = buildContext(structuredClone(h));
  const hero = h.players.find((p) => p.name === "Bb")!.seat;
  const villain = h.players.find((p) => p.name === "Btn")!.seat;
  const walk = walkRanges(h, context, hero, villain, CHARTS);

  it("starts both ranges from the charts and labels them by line", () => {
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.sources).toEqual({ hero: "chart", villain: "chart" });
    expect(walk.labels.villain).toBe("open:BTN");
    expect(walk.labels.hero).toBe("call:BB");
  });

  it("reaches the river with the board removed and both ranges narrowed", () => {
    if (!walk.ok) throw new Error("no walk");
    const start = walk.riverStart!;
    for (let c = 0; c < NUM_COMBOS; c += 1) {
      if (BOARD.includes(comboHi(c)) || BOARD.includes(comboLo(c))) {
        expect(start.hero[c]).toBe(0);
        expect(start.villain[c]).toBe(0);
      }
    }
    const flopIndex = h.actions.find((a) => a.street === "flop")!.index;
    const atFlop = walk.before(flopIndex)!;
    expect(rangeWeight(start.villain)).toBeLessThan(rangeWeight(atFlop.villain));
    expect(rangeWeight(start.hero)).toBeLessThan(rangeWeight(atFlop.hero));
  });

  it("refuses a pot three players saw the flop of", () => {
    const text = [
      "Poker Hand #RVM: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00",
      "Table 'Rv' 6-max Seat #1 is the button",
      ...["Btn", "Sb", "Bb", "Utg", "Hj", "Co"].map((name, i) => `Seat ${i + 1}: ${name} ($100 in chips)`),
      "Sb: posts small blind $0.5",
      "Bb: posts big blind $1",
      "*** HOLE CARDS ***",
      "Dealt to Bb [Kh Qh]",
      "Utg: folds",
      "Hj: folds",
      "Co: raises $1.5 to $2.5",
      "Btn: calls $2.5",
      "Sb: folds",
      "Bb: calls $1.5",
      "*** FLOP *** [Kd 7c 2s]",
      "Bb: checks",
      "Co: bets $3",
      "Btn: folds",
      "Bb: calls $3",
      "*** TURN *** [Kd 7c 2s] [9h]",
      "Bb: checks",
      "Co: checks",
      "*** RIVER *** [Kd 7c 2s 9h] [3d]",
      "Bb: checks",
      "Co: bets $6",
      "Bb: calls $6",
      "*** SHOWDOWN ***",
      "Co collected $20 from pot",
      "*** SUMMARY ***",
      `Total pot $20 ${FEES}`,
    ].join("\n");
    const analysis = analyse(parseStandardHand(text, CTX)!);
    const call = river(analysis, "call");
    expect(call.status).toBe("not-analysed");
    expect(call.reason).toBe("river-multiway-flop");
    expect(en.analysis.explain(call)[0]).toContain("three or more players saw the flop");
    expect(hr.analysis.explain(call)[0]).toContain("Bez ocjene");
  });
});

/* ------------------------------------------------ grades, known answers - */

describe("river grades with known answers", () => {
  it("never folds the nuts: folding a royal flush to a bet is a Blunder", () => {
    const analysis = analyse(
      headsUp({
        hero: "Bb",
        cards: "Js Ts",
        board: ["As", "Ks", "Qs", "7d", "2c"],
        flop: ["Bb: checks", "Btn: bets $2", "Bb: calls $2"],
        turn: ["Bb: checks", "Btn: checks"],
        river: ["Bb: checks", "Btn: bets $7", "Bb: folds"],
      }),
    );
    const fold = river(analysis, "fold");
    expect(fold.source).toBe("solver");
    expect(fold.grade).toBe("blunder");
    expect(freqOf(fold, "fold")).toBe(0);
    expect(fold.evLossPot!).toBeGreaterThan(0.5);
    expect(fold.flags.map((f) => f.code)).toContain("fold-nuts");
    expect(analysis.grade).toBe("blunder");
  });

  it("does not call with air that beats nothing, and folds it at no cost", () => {
    const build = (last: string) =>
      analyse(
        headsUp({
          hero: "Bb",
          cards: "4s 3s",
          board: ["Ah", "Kd", "9c", "6c", "Jh"],
          flop: ["Bb: checks", "Btn: bets $2", "Bb: calls $2"],
          turn: ["Bb: checks", "Btn: checks"],
          river: ["Bb: checks", "Btn: bets $7", last],
        }),
      );
    const call = river(build("Bb: calls $7"), "call");
    expect(call.source).toBe("solver");
    expect(call.facts.river!.heroBeats).toBeLessThan(0.05);
    expect(freqOf(call, "call")).toBeLessThan(0.035);
    expect(gradeRank(call.grade!)).toBeGreaterThanOrEqual(gradeRank("inaccurate"));
    const fold = river(build("Bb: folds"), "fold");
    expect(fold.options.find((o) => o.action === "fold")!.ev).toBe(0);
    expect(fold.options.find((o) => o.action === "call")!.ev).toBeLessThan(0);
    expect(fold.evLoss!).toBeLessThanOrEqual(call.evLoss!);
  });

  it("grades checking back the nuts when the solver bets them", () => {
    const analysis = analyse(
      headsUp({
        hero: "Btn",
        cards: "Qh Jh",
        board: ["Ah", "Kh", "7h", "4c", "2d"],
        flop: ["Bb: checks", "Btn: bets $2", "Bb: calls $2"],
        turn: ["Bb: checks", "Btn: checks"],
        river: ["Bb: checks", "Btn: checks"],
      }),
    );
    const check = river(analysis, "check");
    expect(check.source).toBe("solver");
    expect(check.facts.made?.nuts).toBe(true);
    expect(freqOf(check, "check")).toBeLessThan(0.05);
    expect(gradeRank(check.grade!)).toBeGreaterThanOrEqual(gradeRank("inaccurate"));
    expect(check.flags.map((f) => f.code)).toContain("check-back-nuts");
    // The better option is a bet, named under the chip.
    expect(en.analysis.explain(check).join(" ")).toMatch(/the solver (plays|mixes) bet/);
  });

  it("makes a bluff-catcher against a polar range indifferent, defending the MDF (clairvoyance)", () => {
    // Out of position: tens, nothing else. In position: sets (the nuts here)
    // and missed air. The closed form: the bettor bluffs x/(1+2x) of its bets,
    // the bluff-catcher calls 1/(1+x), and calling and folding are worth the same.
    const solve = solveRiverSpot({
      hand: {} as PhfHand,
      heroSeat: 1,
      villainSeat: 2,
      heroFirst: true,
      heroCards: [parseCards(["Th"])[0], parseCards(["Td"])[0]],
      board: parseCards(["Ks", "Qd", "7h", "4c", "2s"]),
      potBb: 10,
      stackBb: 50,
      ranges: { hero: parseRange("TT"), villain: parseRange("KK, QQ, 65s, J9s, 98s") },
      charts: CHARTS,
      model: "test",
      key: { players: 6, stackBucket: "100bb", preflopLine: "srp", positions: ["BB", "BTN"] },
    }) as RiverSolve;
    expect(solve.ok).toBe(true);
    const { result } = solve;
    const afterCheck = result.nodes[result.nodes[0].children[0]];
    expect(afterCheck.player).toBe(1);
    // The bettor's most used size.
    let edge = -1;
    afterCheck.actions.forEach((action, a) => {
      if (action.kind !== "check" && (edge < 0 || afterCheck.frequency[a] > afterCheck.frequency[edge])) edge = a;
    });
    const node = result.nodes[afterCheck.children[edge]];
    const x = afterCheck.actions[edge].sizePot;
    const call = node.actions.findIndex((action) => action.kind === "call");
    expect(node.frequency[call]).toBeCloseTo(1 / (1 + x), 1);
    // Indifference: the tens' call and fold EVs within 1% of the pot.
    const options = optionsAt(result, node, solve.heroHand);
    const fold = options.find((o) => o.action === "fold")!;
    const callOption = options.find((o) => o.action === "call")!;
    expect(Math.abs(callOption.ev - fold.ev)).toBeLessThan(0.01 * node.pot);
    // Either move grades Perfect.
    const sizePot = afterCheck.actions[edge].sizePot;
    const acts: RiverAct[] = [
      { index: 1, seat: 1, type: "check", to: 0, allIn: false, pot: 10, toCall: 0, sizePot: null },
      { index: 2, seat: 2, type: "bet", to: sizePot * 10, allIn: false, pot: 10, toCall: 0, sizePot },
    ];
    const line = followLine(solve, acts);
    expect(line.ok).toBe(true);
    if (!line.ok) return;
    const toCall = sizePot * 10;
    for (const type of ["call", "fold"] as const) {
      const graded = gradeRiver(solve, line, {
        index: 3,
        seat: 1,
        type,
        to: type === "call" ? toCall : 0,
        allIn: false,
        pot: 10 + toCall,
        toCall,
        sizePot: null,
      });
      expect(graded.ok).toBe(true);
      if (graded.ok) expect(graded.grade).toBe("perfect");
    }
  });
});

/* ------------------------------------------------ the line onto the tree - */

describe("the real line onto the solver's tree (§3.3)", () => {
  const line = (bet: string, size: number) =>
    headsUp({
      hero: "Bb",
      cards: "Kh Qh",
      board: ["Kd", "7c", "2s", "9h", "3d"],
      flop: ["Bb: checks", "Btn: bets $2", "Bb: calls $2"],
      turn: ["Bb: checks", "Btn: checks"],
      river: ["Bb: checks", `Btn: bets $${bet}`, `Bb: calls $${size}`],
    });

  it("reads the river's money in big blinds", () => {
    const acts = riverActs(line("4.75", 4.75));
    expect(acts.map((a) => a.type)).toEqual(["check", "bet", "call"]);
    expect(acts[0].pot).toBe(9.5);
    expect(acts[1].sizePot).toBeCloseTo(0.5, 10);
    expect(acts[2].toCall).toBe(4.75);
  });

  it("maps a half-pot bet onto a solved size and says so, without a cap", () => {
    const call = river(analyse(line("4.75", 4.75)), "call");
    expect(call.source).toBe("solver");
    expect(call.approximations).toContain("size-translated");
    expect(call.approximations).not.toContain("off-tree-size");
    // 50% sits between 33% and 75%: mapped to one of them, a sixth of the pot or so away.
    expect(call.facts.river!.translated).toBeGreaterThan(0.15);
    expect(call.facts.river!.translated).toBeLessThan(0.26);
    expect(call.facts.river!.path).toMatch(/^X-B(3\.14|7\.13)$/);
  });

  it("does not translate a size the tree has", () => {
    const call = river(analyse(line("7.13", 7.13)), "call");
    expect(call.approximations).not.toContain("size-translated");
    expect(call.facts.river!.translated).toBeNull();
  });

  it("caps the grade at Inaccurate when a size is far off the tree", () => {
    // 40 into 9.5 is 4.2x the pot: 2.7 pots from the 150% bet, and not all-in.
    const call = river(analyse(line("40", 40)), "call");
    expect(call.source).toBe("solver");
    expect(call.approximations).toContain("off-tree-size");
    expect(gradeRank(call.grade!)).toBeLessThanOrEqual(gradeRank("inaccurate"));
  });
});

/* ------------------------------------------------- determinism, study - */

describe("determinism and the study view", () => {
  const h = headsUp({
    hero: "Bb",
    cards: "Kh Qh",
    board: ["Kd", "7c", "2s", "9h", "3d"],
    flop: ["Bb: checks", "Btn: bets $2", "Bb: calls $2"],
    turn: ["Bb: checks", "Btn: checks"],
    river: ["Bb: checks", "Btn: bets $7.13", "Bb: calls $7.13"],
  });
  const analysis = analyse(h);

  it("solves the same hand to the same bits", () => {
    expect(analyse(h)).toEqual(analysis);
    for (const d of analysis.decisions.filter((x) => x.source === "solver")) {
      expect(d.facts.river!.converged).toBe(true);
      expect(d.facts.river!.exploitabilityPct).toBeLessThanOrEqual(0.5);
      expect(d.facts.river!.iterations).toBeGreaterThan(0);
    }
  });

  it("re-solves for the study and finds the stored row's numbers for the hero", () => {
    for (const d of analysis.decisions.filter((x) => x.source === "solver")) {
      const study = riverStudy(structuredClone(h), d.actionIndex, { charts: CHARTS });
      if (!study || !("options" in study)) throw new Error("no study");
      expect(study.hero.freq).toEqual(d.options.map((o) => o.freq));
      expect(study.hero.ev).toEqual(d.options.map((o) => o.ev));
      expect(study.path).toBe(d.facts.river!.path);
      expect(study.heroClass).toBe(d.facts.handClass);
      // The range's totals and every row's mix sum to one; the categories cover the range.
      expect(study.options.reduce((sum, o) => sum + o.share, 0)).toBeCloseTo(1, 3);
      const all = study.cells.reduce((sum, row) => sum + row.combos, 0);
      expect(study.categories.reduce((sum, row) => sum + row.combos, 0)).toBeCloseTo(all, 0);
      expect(study.strength.reduce((sum, row) => sum + row.combos, 0)).toBeCloseTo(all, 0);
      for (const row of [...study.cells, ...study.categories, ...study.strength]) {
        if (row.combos > 0.01) expect(row.freq.reduce((s, f) => s + f, 0)).toBeCloseTo(1, 2);
      }
      expect(study.villain.categories.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 2);
    }
  });

  it("lays its cells out in the chart grid's order", () => {
    expect(HAND_CLASSES.map((c) => c.name)).toEqual(GRID_CELLS.map((c) => c.name));
  });

  it("files every combo of a river board under one category", () => {
    const board = parseCards(["Kd", "7c", "2s", "9h", "3d"]);
    expect(riverCategory(parseCards(["Kh", "Ks"]) as [number, number], board)).toBe("set-trips");
    expect(riverCategory(parseCards(["Ah", "Kc"]) as [number, number], board)).toBe("top-pair");
    expect(riverCategory(parseCards(["8h", "6h"]) as [number, number], board)).toBe("missed-straight-draw");
    expect(riverCategory(parseCards(["Ac", "Qc"]) as [number, number], board)).toBe("ace-high");
  });

  it("explains a solver grade in both languages, with its role, and links what it says", () => {
    const call = river(analysis, "call");
    for (const dict of [en, hr]) {
      const text = dict.analysis.explain(call).join(" ");
      expect(text).toContain(dict.analysis.grades[call.grade!]);
      expect(text).not.toMatch(/undefined|NaN|null|\[object/);
    }
    expect(en.analysis.explain(call).join(" ")).toMatch(/the solver/);
    expect(en.analysis.explain(call).join(" ")).toContain("heuristic model");
    const concepts = conceptsForDecision(call);
    expect(concepts).toContain("ev-and-grading");
    expect(concepts.length).toBeLessThanOrEqual(4);
  });

  it("uses the bet menu of §3.2", () => {
    expect(RIVER_MENU).toEqual({ bet: [0.33, 0.75, 1.5], raise: [0.75], allIn: true });
  });
});
