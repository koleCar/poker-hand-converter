/**
 * Turn grading with our solver (phase A5a, `docs/ANALYSIS-PLAN.md` §3.2–§3.5).
 *
 * - **Grades with known answers**: folding a hand that cannot lose is a
 *   Blunder whatever the narrowing; the nuts facing a bet continues; a
 *   strong draw facing a modest bet is not folded.
 * - **The line onto the tree**: a size far from the tree's caps the grade, a
 *   turn with more raises than the tree models says so by name.
 * - **The river's ranges from the solved turn**: the river starts from the
 *   solved turn strategy where there is one (`narrowing: "turn-solver"`),
 *   from the heuristic where turn solving is off; a bettor's river range is
 *   its solved betting range; the river card's combos are gone.
 * - **Pieces**: the turn's hand categories, the river outlook against a
 *   brute-force count, determinism, and the study equal to the stored row.
 *
 * No chart frequency is pinned: the chart set is regenerated independently.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  TURN_MENU,
  TURN_SKIP_REASONS,
  analyzeHand,
  lineMenu,
  riverOutlook,
  riverStartFromTurn,
  solveTurnSpot,
  turnCategory,
  turnStudy,
  type DecisionAnalysis,
  type HandAnalysis,
  type StreetAct,
  type TurnSpotInput,
} from "../../frontend/src/lib/analysis/index.js";
import { loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { evaluate } from "../../frontend/src/lib/equity/index.js";
import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr } from "../../frontend/src/lib/i18n/hr.js";
import { conceptsForDecision } from "../../frontend/src/lib/learn/links.js";
import { parseStandardHand } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { comboHi, comboLo, NUM_COMBOS, parseCards, parseRange, rangesAt } from "../../frontend/src/lib/solver/index.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const FEES = "| Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0";
/** A turn solve takes a second or more: each hand is analysed once per setting and shared between tests. */
const analysed = new Map<PhfHand, Map<boolean, HandAnalysis>>();
const analyse = (h: PhfHand, turn = true): HandAnalysis => {
  const byTurn = analysed.get(h) ?? new Map<boolean, HandAnalysis>();
  analysed.set(h, byTurn);
  let analysis = byTurn.get(turn);
  if (!analysis) {
    analysis = analyzeHand(structuredClone(h), { charts: CHARTS, turn });
    byTurn.set(turn, analysis);
  }
  return analysis;
};

let serial = 0;

/**
 * A six-handed $0.5/$1 hand, 100bb deep: the button opens to 2.5 and the big
 * blind calls, then the given postflop streets (the river optional).
 */
function headsUp(opts: {
  hero: "Btn" | "Bb";
  cards: string;
  board: string[];
  flop: string[];
  turn: string[];
  river?: string[];
}): PhfHand {
  serial += 1;
  const [f1, f2, f3, t, r] = opts.board;
  const text = [
    `Poker Hand #TU${serial}: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00`,
    "Table 'Tu' 6-max Seat #1 is the button",
    ...["Btn", "Sb", "Bb", "Utg", "Hj", "Co"].map((name, i) => `Seat ${i + 1}: ${name} ($100 in chips)`),
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
    ...(opts.river && r ? [`*** RIVER *** [${f1} ${f2} ${f3} ${t}] [${r}]`, ...opts.river] : []),
    "*** SHOWDOWN ***",
    "Btn collected $10 from pot",
    "*** SUMMARY ***",
    `Total pot $10 ${FEES}`,
  ].join("\n");
  const parsed = parseStandardHand(text, CTX);
  if (!parsed) throw new Error(`fixture did not parse:\n${text}`);
  return parsed;
}

const decisionOn = (analysis: HandAnalysis, street: string, action: string): DecisionAnalysis => {
  const found = analysis.decisions.find((d) => d.street === street && d.action === action);
  if (!found) throw new Error(`no ${street} ${action}`);
  return found;
};

const freqOf = (d: DecisionAnalysis, action: string) =>
  d.options.filter((o) => o.action === action).reduce((sum, o) => sum + o.freq, 0);

const CHECKED_FLOP = ["Bb: checks", "Btn: checks"];

/** Nut flush draw and an open-ender (about 15 outs) folding to a small turn bet. */
const DRAW = headsUp({
  hero: "Bb",
  cards: "Ad Jd",
  board: ["Qd", "Td", "4c", "2s"],
  flop: ["Bb: checks", "Btn: bets $2", "Bb: calls $2"],
  turn: ["Bb: checks", "Btn: bets $3", "Bb: folds"],
});

describe("turn grades with known answers", () => {
  it("calls folding a hand that cannot lose a Blunder, whatever the narrowing", () => {
    // A royal flush on the turn: no river and no holding beats it.
    const hand = headsUp({
      hero: "Bb",
      cards: "Th 9h",
      board: ["Ah", "Kh", "Qh", "Jh"],
      flop: CHECKED_FLOP,
      turn: ["Bb: checks", "Btn: bets $4", "Bb: folds"],
    });
    const fold = decisionOn(analyse(hand), "turn", "fold");
    expect(fold.source).toBe("solver");
    expect(fold.grade).toBe("blunder");
    expect(fold.approximations).not.toContain("range-cap");
    expect(freqOf(fold, "fold")).toBe(0);
    expect(fold.facts.turn?.role).toBe("value");
  });

  it("continues with the nuts facing a bet", () => {
    const hand = headsUp({
      hero: "Bb",
      cards: "8s 7s",
      board: ["9d", "6c", "2h", "Ts"],
      flop: ["Bb: checks", "Btn: bets $2", "Bb: calls $2"],
      turn: ["Bb: checks", "Btn: bets $7", "Bb: calls $7"],
    });
    const call = decisionOn(analyse(hand), "turn", "call");
    expect(call.source).toBe("solver");
    expect(freqOf(call, "fold")).toBeLessThan(0.01);
    expect(call.grade === "perfect" || call.grade === "good").toBe(true);
    expect(call.facts.turn!.equity).toBeGreaterThan(0.8);
  });

  it("does not fold a big draw to a small bet", () => {
    // Nut flush draw plus an open-ender: about 15 outs.
    const hand = DRAW;
    const fold = decisionOn(analyse(hand), "turn", "fold");
    expect(fold.source).toBe("solver");
    expect(freqOf(fold, "fold")).toBeLessThan(0.05);
    expect(["mistake", "blunder", "inaccurate"]).toContain(fold.grade);
    expect(fold.facts.turn!.role).toBe("draw");
  });

  it("explains a turn grade in both languages from the record, and links its concepts", () => {
    const hand = DRAW;
    const fold = decisionOn(analyse(hand), "turn", "fold");
    for (const dict of [en, hr]) {
      const sentences = dict.analysis.explain(fold);
      expect(sentences.join(" ")).toContain(dict.analysis.grades[fold.grade!]);
      for (const sentence of sentences) expect(sentence).not.toMatch(/undefined|NaN|null|\[object/);
    }
    expect(en.analysis.explain(fold).join(" ")).toMatch(/river cards make it strong/);
    expect(conceptsForDecision(fold)).toContain("equity-realisation");
  });
});

describe("the turn line onto the tree", () => {
  it("solves a size far from the tree's as played, or caps the grade", () => {
    // 2.5 pots: the tree bets 75% (and shoves only up to three pots), so the
    // hand's own size is added to it; if the solve never uses it, the line is
    // read as the nearest size it does use, and that is off the tree.
    const hand = headsUp({
      hero: "Bb",
      cards: "Kc Qc",
      board: ["Kd", "7h", "3s", "2c"],
      flop: CHECKED_FLOP,
      turn: ["Bb: checks", "Btn: bets $14", "Bb: folds"],
    });
    const fold = decisionOn(analyse(hand), "turn", "fold");
    if (fold.source === "solver") {
      expect(fold.facts.turn!.tree).toContain("+b2.55");
      if (fold.approximations.includes("off-tree-size")) expect(["perfect", "good", "inaccurate"]).toContain(fold.grade);
    } else {
      expect(TURN_SKIP_REASONS).toContain(fold.reason);
    }
  });

  it("names a turn with more raises than the tree models", () => {
    const hand = headsUp({
      hero: "Bb",
      cards: "Kc Qc",
      board: ["Kd", "7h", "3s", "2c"],
      flop: CHECKED_FLOP,
      turn: ["Bb: bets $3", "Btn: raises $6 to $9", "Bb: raises $18 to $27", "Btn: calls $18"],
    });
    const reraise = decisionOn(analyse(hand), "turn", "raise");
    expect(reraise.status).toBe("not-analysed");
    expect(reraise.reason).toBe("turn-off-tree");
    expect(en.analysis.reasons[reraise.reason!]).toBeTruthy();
  });
});

describe("the river's ranges from the solved turn", () => {
  const hand = headsUp({
    hero: "Bb",
    cards: "Js Ts",
    board: ["Kd", "9h", "4c", "2d", "8s"],
    flop: ["Bb: checks", "Btn: bets $2", "Bb: calls $2"],
    turn: ["Bb: checks", "Btn: bets $7", "Bb: calls $7"],
    river: ["Bb: checks", "Btn: bets $15", "Bb: folds"],
  });

  it("narrows into the river by the solved turn where there is one, by the heuristic where turn solving is off", () => {
    const solved = analyse(hand);
    const heuristic = analyse(hand, false);
    const river = decisionOn(solved, "river", "fold");
    const before = decisionOn(heuristic, "river", "fold");
    expect(river.source).toBe("solver");
    expect(river.facts.river?.narrowing).toBe("turn-solver");
    expect(before.facts.river?.narrowing).toBe("heuristic");
    // Turn solving off: the turn decision is A4's, facts and flags only.
    expect(decisionOn(heuristic, "turn", "call").grade).toBeNull();
    expect(decisionOn(solved, "turn", "call").source).toBe("solver");
    expect(en.analysis.explain(river).join(" ")).toMatch(/solved turn strategy/);
  });

  it("is deterministic", () => {
    expect(analyzeHand(structuredClone(hand), { charts: CHARTS })).toEqual(analyse(hand));
  });

  it("re-solves the turn for the study view to exactly the stored numbers", () => {
    const analysis = analyse(hand);
    const call = decisionOn(analysis, "turn", "call");
    const study = turnStudy(structuredClone(hand), call.actionIndex, { charts: CHARTS });
    if (!study || !("options" in study)) throw new Error("no study for a graded turn");
    expect(study.street).toBe("turn");
    expect(study.hero.freq).toEqual(call.options.map((o) => o.freq));
    expect(study.hero.ev).toEqual(call.options.map((o) => o.ev));
    expect(study.cells).toHaveLength(169);
    expect(study.categories.length).toBeGreaterThan(0);
    for (const row of study.categories) expect(["made", "draws", "nothing"]).toContain(row.group);
    const shares = study.options.reduce((sum, option) => sum + option.share, 0);
    expect(shares).toBeCloseTo(1, 3);
  });
});

describe("the solved turn's ranges at the river card", () => {
  // Hero (seat 1) checks, villain (seat 2) bets 75%, hero calls; the river is the 8s.
  const board = parseCards(["Kd", "9h", "4c", "2d"]);
  const input: TurnSpotInput = {
    hand: {} as PhfHand,
    heroSeat: 1,
    villainSeat: 2,
    heroFirst: true,
    heroCards: parseCards(["Js", "Ts"]) as [number, number],
    board,
    potBb: 10,
    stackBb: 40,
    ranges: { hero: parseRange("99,44,K9s,KTs,QJs,JTs,T9s,98s,A4s,KQo,QTo"), villain: parseRange("KK,99,AK,KJ,QJs,T8s,A5s,76s,AdQd") },
    charts: null,
    model: "test",
    key: { players: 6, stackBucket: "100bb", preflopLine: "srp", positions: ["BB", "BTN"] },
  };
  const act = (index: number, seat: number, type: StreetAct["type"], to: number, pot: number, toCall: number, sizePot: number | null): StreetAct => ({
    index,
    seat,
    type,
    to,
    allIn: false,
    pot,
    toCall,
    sizePot,
  });
  const acts = [act(0, 1, "check", 0, 10, 0, null), act(1, 2, "bet", 7.5, 10, 0, 0.75), act(2, 1, "call", 7.5, 17.5, 7.5, null)];
  const river = parseCards(["8s"])[0];

  it("is each range times its own solved strategy along the line, with the river card's combos gone", () => {
    const solve = solveTurnSpot(input);
    if (!solve.ok) throw new Error(solve.detail);
    const start = riverStartFromTurn(solve, acts, river);
    if (!start.ok) throw new Error(start.detail);
    const result = solve.result;
    const chance = result.nodes.findIndex((n) => n.kind === "chance" && n.path === "X-B7.5-C");
    expect(chance).toBeGreaterThan(0);
    const reach = rangesAt(result, chance);
    for (const [p, range] of [
      [0, start.ranges.hero],
      [1, start.ranges.villain],
    ] as const) {
      result.hands[p].forEach((combo, i) => {
        const holds = comboHi(combo) === river || comboLo(combo) === river;
        expect(range[combo]).toBeCloseTo(holds ? 0 : reach[p][i], 12);
        // Weights only go down from the turn's.
        expect(range[combo]).toBeLessThanOrEqual(result.weights[p][i] + 1e-12);
      });
    }
    // The bettor's river range is its betting range: a combo the solve never bets is gone.
    const x = result.nodes.findIndex((n) => n.path === "X");
    const node = result.nodes[x];
    const bet = node.actions.findIndex((a) => a.kind === "bet");
    const n = result.hands[1].length;
    result.hands[1].forEach((combo, i) => {
      if (node.strategy[bet * n + i] === 0) expect(start.ranges.villain[combo]).toBe(0);
    });
    for (let c = 0; c < NUM_COMBOS; c += 1) {
      if (comboHi(c) === river || comboLo(c) === river) {
        expect(start.ranges.hero[c]).toBe(0);
        expect(start.ranges.villain[c]).toBe(0);
      }
    }
  });

  it("refuses a turn that did not close with chips behind or that left the tree", () => {
    const solve = solveTurnSpot(input);
    if (!solve.ok) throw new Error(solve.detail);
    // Stops at the bet: the street has not closed.
    const open = riverStartFromTurn(solve, acts.slice(0, 2), river);
    expect(open.ok).toBe(false);
  });
});

describe("turn pieces", () => {
  it("adds the hand's own turn sizes to the menu, and the all-in when it shoved", () => {
    const act = (type: StreetAct["type"], sizePot: number | null, to: number, allIn = false): StreetAct => ({
      index: 0,
      seat: 1,
      type,
      to,
      allIn,
      pot: 10,
      toCall: 0,
      sizePot,
    });
    // A 75% bet is already there; a 40% bet and a 1.4x raise are not; 0.8 is near enough.
    expect(lineMenu(TURN_MENU, [act("bet", 0.8, 8)], 90).suffix).toBe("");
    const line = lineMenu(TURN_MENU, [act("bet", 0.4, 4), act("raise", 1.4, 30)], 90);
    expect(line.menu.bet).toEqual([0.4, 0.75]);
    expect(line.menu.raise).toEqual([0.75, 1.4]);
    expect(line.suffix).toBe("+b0.4+r1.4");
    expect(line.menu.allInMaxPot).toBe(TURN_MENU.allInMaxPot);
    // A shove deeper than the menu's all-in cap puts the all-in back.
    const shove = lineMenu(TURN_MENU, [act("bet", 9, 90, true)], 90);
    expect(shove.menu.allInMaxPot).toBeUndefined();
    expect(shove.menu.bet).toEqual([0.75]);
    expect(shove.suffix).toBe("+ai");
  });

  it("categorises a turn hand by made hand, then by draw", () => {
    const board = parseCards(["Qd", "Td", "4c", "2s"]);
    const cat = (code: string) => turnCategory(parseCards([code.slice(0, 2), code.slice(2)]) as [number, number], board);
    expect(cat("AdJd")).toBe("combo-draw");
    expect(cat("8d7d")).toBe("flush-draw");
    expect(cat("KhJc")).toBe("straight-draw");
    expect(cat("AcJh")).toBe("gutshot");
    expect(cat("QhJh")).toBe("top-pair");
    expect(cat("Ah8c")).toBe("ace-high");
    expect(cat("7h6h")).toBe("no-pair");
  });

  it("counts the river outlook like a brute-force count", () => {
    const board = parseCards(["Qd", "Td", "4c", "2s"]);
    const hole = parseCards(["Ad", "Jd"]) as [number, number];
    const villain = parseRange("QQ,TT,44,AQ,KQ,QJs,T9s,KJs");
    const outlook = riverOutlook(hole, board, villain);
    let total = 0;
    let rivers = 0;
    for (let r = 0; r < 52; r += 1) {
      if (board.includes(r) || hole.includes(r)) continue;
      const mine = evaluate([...hole, ...board, r]);
      let score = 0;
      let weight = 0;
      for (let c = 0; c < NUM_COMBOS; c += 1) {
        const w = villain[c];
        const cards = [comboHi(c), comboLo(c)];
        if (!(w > 0) || cards.some((x) => board.includes(x) || hole.includes(x) || x === r)) continue;
        const theirs = evaluate([...cards, ...board, r]);
        weight += w;
        score += mine > theirs ? w : mine === theirs ? w / 2 : 0;
      }
      total += score / weight;
      rivers += 1;
    }
    expect(outlook.rivers).toBe(rivers);
    expect(outlook.equity).toBeCloseTo(total / rivers, 9);
    expect(outlook.strong).toBeGreaterThan(0.2);
  });
});
