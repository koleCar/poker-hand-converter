/**
 * Preflop grades from the charts (phase A2b, `docs/ANALYSIS-PLAN.md` §3.1).
 *
 * Six-handed, 100bb hands written out in standard text, each one a spot whose
 * answer does not depend on the exact chart numbers: AA does not fold, 72o
 * does not open under the gun, a hand the reference mixes is fine either way.
 * **No chart frequency is pinned here** — the chart set is regenerated
 * (`charts/2`) independently of this suite, so it asserts structure and the
 * clear-cut cases, and finds a mixed class by searching the charts rather
 * than naming one.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHART_SKIP_REASONS,
  analyzeHand,
  betterAlternative,
  chartRange,
  gradeRank,
  impliedOddsClass,
  modelCaveat,
  referenceMix,
  type DecisionAnalysis,
  type HandAnalysis,
} from "../../web/src/lib/analysis/index.js";
import {
  GRID_CELLS,
  SPOT_CATEGORIES,
  actionTotals,
  categoriesOf,
  lineSteps,
  nodesIn,
} from "../../web/src/components/analysis/chartSpots.js";
import {
  chartLibrary,
  handClassOf,
  PLANNED_CHART_SETS,
  lookupPreflop,
  preflopSpotFromHand,
  rareLineChartSets,
  rareLineDepthSets,
  type ChartSet,
  type ChartSetSpec,
} from "../../web/src/lib/charts/index.js";
import { en } from "../../web/src/lib/i18n/en.js";
import { hr } from "../../web/src/lib/i18n/hr.js";
import { conceptsForDecision } from "../../web/src/lib/learn/links.js";
import { parseStandardHand } from "../../web/src/lib/phf/serialize.js";
import { fixtureLibrary, fixtureSet, SIX_MAX_100 } from "./charts/support.js";
import type { PhfHand } from "../../web/src/lib/phf/types.js";
// The NL500 6-max 100bb fixture (`charts/support.ts`): the clear-cut cases here are pinned to its sizes (UTG opens
// to 2bb), its blind vs blind and its rare lines; the shipped NL100 set opens 2.5x and has not captured blind vs blind yet.
const CHARTS: ChartSet = fixtureSet(SIX_MAX_100);
const FIXTURES = fixtureLibrary();
const fullLibrary = () => FIXTURES;
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const FEES = "| Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0";

/* --------------------------------------------------------------- hands - */

type Seat = "Btn" | "Sb" | "Bb" | "Utg" | "Hj" | "Co";
const SEATS: Seat[] = ["Btn", "Sb", "Bb", "Utg", "Hj", "Co"];
const ORDER: Seat[] = ["Utg", "Hj", "Co", "Btn", "Sb", "Bb"];
const POSITION: Record<Seat, string> = { Utg: "UTG", Hj: "HJ", Co: "CO", Btn: "BTN", Sb: "SB", Bb: "BB" };

/**
 * A six-handed hand at $0.5/$1 with the given preflop lines (and optionally
 * more streets), every stack `stack` dollars. The winner and the pot close
 * the text so the parser has a complete hand; nothing here reads them except
 * the final pot.
 */
function hand(opts: {
  hero: Seat;
  cards: string;
  lines: string[];
  stack?: number;
  winner: Seat;
  pot: number;
  returned?: number;
  more?: string[];
  seats?: Seat[];
}): PhfHand {
  const stack = opts.stack ?? 100;
  const seats = opts.seats ?? SEATS;
  const text = [
    `Poker Hand #PF${Math.abs(hash(opts.lines.join("|") + opts.cards))}: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00`,
    `Table 'Pf' 6-max Seat #1 is the button`,
    ...seats.map((name) => `Seat ${SEATS.indexOf(name) + 1}: ${name} ($${stack} in chips)`),
    "Sb: posts small blind $0.5",
    "Bb: posts big blind $1",
    "*** HOLE CARDS ***",
    `Dealt to ${opts.hero} [${opts.cards}]`,
    ...opts.lines,
    ...(opts.more ?? []),
    ...(opts.returned ? [`Uncalled bet ($${opts.returned}) returned to ${opts.winner}`] : []),
    `${opts.winner} collected $${opts.pot} from pot`,
    "*** SUMMARY ***",
    `Total pot $${opts.pot} ${FEES}`,
  ].join("\n");
  const parsed = parseStandardHand(text, CTX);
  if (!parsed) throw new Error(`fixture did not parse:\n${text}`);
  return parsed;
}

function hash(text: string): number {
  let h = 7;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

/** Everyone before `opener` folds, `opener` acts, everyone after folds — the last raiser wins the blinds. */
function rfi(hero: Seat, cards: string, action: "raise" | "fold", to = 2.5): PhfHand {
  const at = ORDER.indexOf(hero);
  const lines = ORDER.slice(0, at).map((seat) => `${seat}: folds`);
  if (action === "raise") {
    lines.push(`${hero}: raises $${to - (hero === "Sb" ? 0.5 : 0)} to $${to}`);
    for (const seat of ORDER.slice(at + 1)) lines.push(`${seat}: folds`);
    return hand({ hero, cards, lines, winner: hero, pot: to + 1 + (hero === "Sb" ? 0 : 0.5) - (to - 1), returned: to - 1 });
  }
  // Hero folds; the next seat opens and takes the blinds.
  lines.push(`${hero}: folds`);
  const next = ORDER[at + 1];
  lines.push(`${next}: raises $${next === "Sb" ? 2.5 : 2.5} to ${next === "Sb" ? "$3" : "$2.5"}`);
  for (const seat of ORDER.slice(at + 2)) lines.push(`${seat}: folds`);
  const open = next === "Sb" ? 3 : 2.5;
  return hand({ hero, cards, lines, winner: next, pot: next === "Sb" ? 2 : 2.5, returned: open - 1 });
}

/** Heads-up: the small blind (the button) opens, the big blind folds. */
function headsUp(): PhfHand {
  return hand({
    hero: "Sb",
    cards: "Ah Kd",
    seats: ["Sb", "Bb"],
    lines: ["Sb: raises $2 to $2.5", "Bb: folds"],
    winner: "Sb",
    pot: 2,
    returned: 1.5,
  });
}

const pre = (analysis: HandAnalysis, n = 0): DecisionAnalysis =>
  analysis.decisions.filter((d) => d.street === "preflop")[n];

const analyse = (h: PhfHand) => analyzeHand(h, { charts: CHARTS });

/** Two cards of a class name: `AKs` → `Ah Kh`, `AKo` → `Ah Kd`, `77` → `7h 7d`. */
function cardsOf(name: string): string {
  if (name.length === 2) return `${name[0]}h ${name[1]}d`;
  return name[2] === "s" ? `${name[0]}h ${name[1]}h` : `${name[0]}h ${name[1]}d`;
}

/* --------------------------------------------------------- clear cuts - */

describe("clear-cut preflop grades", () => {
  it("calls folding AA under the gun a Blunder, against a raise", () => {
    const analysis = analyse(rfi("Utg", "Ah Ad", "fold"));
    const fold = pre(analysis);
    expect(fold).toMatchObject({ status: "analysed", source: "chart", action: "fold", grade: "blunder" });
    expect(fold.options.map((o) => o.action)).toContain("raise");
    expect(fold.options[fold.chosen as number].action).toBe("fold");
    expect(fold.evLoss).toBeGreaterThan(0);
    expect(fold.evLossPot).toBeGreaterThan(0.08);
    expect(betterAlternative(fold)?.action).toBe("raise");
    expect(fold.facts.chart).toMatchObject({ set: CHARTS.id, line: "", scenario: "rfi" });
    expect(analysis).toMatchObject({ status: "full", grade: "blunder" });
  });

  it("calls opening 72o under the gun a Mistake or a Blunder, by EV", () => {
    const open = pre(analyse(rfi("Utg", "7c 2d", "raise")));
    expect(open.source).toBe("chart");
    expect(["mistake", "blunder"]).toContain(open.grade);
    expect(open.evLoss).toBeGreaterThan(0);
    expect(referenceMix(open)[0].option.action).toBe("fold");
  });

  it("calls opening AA and folding 72o under the gun Perfect", () => {
    expect(pre(analyse(rfi("Utg", "Ah Ad", "raise"))).grade).toBe("perfect");
    expect(pre(analyse(rfi("Utg", "7c 2d", "fold"))).grade).toBe("perfect");
  });

  it("grades either side of a mixed strategy Perfect or Good", () => {
    // Search the charts for an RFI class played both ways, at least 15% each.
    let found: { seat: Seat; name: string } | null = null;
    const rfiSeats: Array<[Seat, string]> = [["Utg", ""], ["Hj", "f"], ["Co", "ff"], ["Btn", "fff"]];
    for (const [seat, line] of rfiSeats) {
      const node = CHARTS.nodes.get(line);
      if (!node) continue;
      const raise = node.options.findIndex((o) => o.action === "raise");
      for (const name of ["A5s", "KTs", "QJo", "ATo", "K9s", "66", "55", "A9o", "Q9s", "J9s", "T9s", "KJo", "A4s", "K8s", "QTo", "J8s", "98s", "44", "A8o", "K7s"]) {
        const k = handClassOf(name);
        const freq = node.freq[raise * node.range.length + k];
        if (node.range[k] > 0.5 && freq >= 0.15 && freq <= 0.85) {
          found = { seat, name };
          break;
        }
      }
      if (found) break;
    }
    expect(found, "the charts mix at least one RFI class").not.toBeNull();
    const { seat, name } = found!;
    for (const action of ["raise", "fold"] as const) {
      const decision = pre(analyse(rfi(seat, cardsOf(name), action)));
      expect(decision.source).toBe("chart");
      expect(["perfect", "good"]).toContain(decision.grade);
      expect(referenceMix(decision).length).toBe(2);
    }
  });

  it("grades a big-blind fold when the check was free, at exactly the blind it gives up", () => {
    // Everyone folds to the small blind, who completes; the big blind folds AA.
    const h = hand({
      hero: "Bb",
      cards: "Ah Ad",
      lines: ["Utg: folds", "Hj: folds", "Co: folds", "Btn: folds", "Sb: calls $0.5", "Bb: folds"],
      winner: "Sb",
      pot: 2,
    });
    const fold = pre(analyse(h));
    if (fold.status === "not-analysed") {
      // A chart set without the small blind's limp says so by name.
      expect(CHART_SKIP_REASONS).toContain(fold.reason);
      return;
    }
    const chosen = fold.options[fold.chosen as number];
    expect(chosen).toMatchObject({ action: "fold", freq: 0, ev: -1 });
    expect(fold.grade).toBe("blunder");
    expect(fold.flags.map((f) => f.code)).toContain("free-fold");
  });

  it("caps a grade at Inaccurate when the raise is far off the charts' size (§3.3)", () => {
    const open = pre(analyse(rfi("Utg", "7c 2d", "raise", 12)));
    expect(open.approximations).toContain("off-tree-size");
    expect(gradeRank(open.grade!)).toBeLessThanOrEqual(gradeRank("inaccurate"));
  });
});

/* ------------------------------------------------------- the hand view - */

describe("the hand's grade, EV loss and score", () => {
  it("sums EV loss over graded decisions and quotes it against the final pot", () => {
    const analysis = analyse(rfi("Utg", "Ah Ad", "fold"));
    const fold = pre(analysis);
    expect(analysis.evLoss).toBeCloseTo(fold.evLoss!, 3);
    // HJ opened to 2.5, everyone folded: 2.5 - 1.5 returned + blinds = 2.5.
    expect(analysis.evLossPot).toBeCloseTo(fold.evLoss! / 2.5, 3);
    expect(analysis.score).toBe(fold.score);
    expect(analysis.approximations).toEqual(fold.approximations);
  });

  it("carries the model note on every chart grade while the charts have a known weakness", () => {
    const fold = pre(analyse(rfi("Utg", "Ah Ad", "fold")));
    if (CHARTS.version === "charts/1" || CHARTS.version === "charts/2") expect(fold.approximations).toContain("model");
    expect(fold.approximations).not.toContain("heuristic");
  });

  it("is deterministic", () => {
    const h = rfi("Co", "Kh Qd", "raise");
    expect(analyse(structuredClone(h))).toEqual(analyse(structuredClone(h)));
  });
});

/* ---------------------------------------------------------- refusals - */

describe("what the charts refuse, by name", () => {
  it("refuses a heads-up table", () => {
    const analysis = analyse(headsUp());
    expect(pre(analysis)).toMatchObject({ status: "not-analysed", reason: "chart-players", grade: null });
    expect(analysis).toMatchObject({ status: "not-analysed", reason: "chart-players", grade: null, evLoss: null });
  });

  it("grades a three-handed table as 6-max with three seats folded (A2c)", () => {
    const h = hand({
      hero: "Btn",
      cards: "Ah Kd",
      seats: ["Btn", "Sb", "Bb"],
      lines: ["Btn: raises $1.5 to $2.5", "Sb: folds", "Bb: folds"],
      winner: "Btn",
      pot: 2.5,
      returned: 1.5,
    });
    const decision = pre(analyse(h));
    expect(decision).toMatchObject({ status: "analysed", source: "chart", grade: "perfect" });
    expect(decision.approximations).toContain("short-handed");
    expect(decision.facts.chart?.line).toBe("fff");
  });

  it("refuses a 200bb stack", () => {
    const decision = pre(
      analyse(
        hand({
          hero: "Co",
          cards: "Ah Kd",
          stack: 200,
          lines: ["Utg: folds", "Hj: folds", "Co: raises $1.5 to $2.5", "Btn: folds", "Sb: folds", "Bb: folds"],
          winner: "Co",
          pot: 2.5,
          returned: 1.5,
        }),
      ),
    );
    expect(decision.reason).toBe("chart-stack-depth");
  });

  it("refuses a line behind an open limp: the GTO Wizard sets limp only from the small blind", () => {
    const decision = pre(
      analyse(
        hand({
          hero: "Co",
          cards: "Ah Kd",
          lines: ["Utg: calls $1", "Hj: folds", "Co: raises $4 to $5", "Btn: folds", "Sb: folds", "Bb: folds", "Utg: folds"],
          winner: "Co",
          pot: 3.5,
          returned: 4,
        }),
      ),
    );
    expect(decision).toMatchObject({ status: "not-analysed", reason: "chart-limp" });
  });

  it("grades the big blind behind the small blind's completion, without the limp tremble", () => {
    const decision = pre(
      analyse(
        hand({
          hero: "Bb",
          cards: "Ah Kd",
          lines: ["Utg: folds", "Hj: folds", "Co: folds", "Btn: folds", "Sb: calls $0.5", "Bb: raises $2 to $3", "Sb: folds"],
          winner: "Bb",
          pot: 2,
          returned: 2,
        }),
      ),
    );
    expect(decision).toMatchObject({ status: "analysed", source: "chart", action: "raise" });
    expect(decision.facts.chart).toMatchObject({ line: "ffffc", scenario: "vs-limp" });
    expect(decision.approximations).not.toContain("limp-tremble");
    expect(referenceMix(decision)[0].option.action).toBe("raise");
  });

  it("explains a refusal in both languages, and links to nothing it did not say", () => {
    for (const reason of CHART_SKIP_REASONS) {
      expect(en.analysis.reasons[reason]).toBeTruthy();
      expect(hr.analysis.reasons[reason]).toBeTruthy();
    }
    const decision = pre(analyse(headsUp()));
    expect(en.analysis.explain(decision)[0]).toMatch(/^Not graded: the charts cover two to nine players/);
    expect(hr.analysis.explain(decision)[0]).toMatch(/^Bez ocjene:/);
    expect(conceptsForDecision(decision)).toEqual([]);
  });
});

/* ------------------------------------------------------ chart ranges - */

/** BTN opens, the hero calls in the big blind, the button bets the flop and the hero calls; river shove, hero calls. */
function defend(cards: string): PhfHand {
  return hand({
    hero: "Bb",
    cards,
    lines: ["Utg: folds", "Hj: folds", "Co: folds", "Btn: raises $1.5 to $2.5", "Sb: folds", "Bb: calls $1.5"],
    more: [
      "*** FLOP *** [Kd 7c 2s]",
      "Bb: checks",
      "Btn: bets $2",
      "Bb: calls $2",
      "*** TURN *** [Kd 7c 2s] [9h]",
      "Bb: checks",
      "Btn: checks",
      "*** RIVER *** [Kd 7c 2s 9h] [3d]",
      "Bb: checks",
      "Btn: bets $6",
      "Bb: calls $6",
      "*** SHOWDOWN ***",
      "Btn: shows [Ah Kc] (a pair of Kings)",
    ],
    winner: "Btn",
    pot: 21.5,
  });
}

describe("opponents' ranges from the charts", () => {
  it("reads the button's opening range off the charts: aces in, seven-deuce out", () => {
    const h = defend("Kh Qh");
    const button = h.players.find((p) => p.name === "Btn")!.seat;
    const flop = h.actions.find((a) => a.street === "flop")!.index;
    const range = chartRange(h, button, flop, CHARTS);
    expect(range).not.toBeNull();
    expect(range!.line).toBe("fff");
    expect(range!.range.get("AA") ?? 0).toBeGreaterThan(0.5);
    expect(range!.range.get("72o") ?? 0).toBeLessThan(0.05);
    // A button open is a sizeable share of 1,326 combos, not all of them.
    expect(range!.combos).toBeGreaterThan(100);
    expect(range!.combos).toBeLessThan(1326 * 0.8);
  });

  it("narrows that range through the hand for the postflop equity facts (A4)", () => {
    const analysis = analyse(defend("Kh Qh"));
    const flop = analysis.decisions.find((d) => d.street === "flop" && d.action === "call")!;
    expect(flop.facts.equity).toMatchObject({ range: "open:BTN", source: "narrowed" });
    expect(flop.approximations).toContain("narrowing-heuristic");
    expect(flop.approximations).not.toContain("placeholder-range");
    expect(en.analysis.explain(flop).join(" ")).toContain("narrowed by the betting");
    // The river is the solver's: the equity is against its range at the node.
    const river = analysis.decisions.find((d) => d.street === "river" && d.action === "call")!;
    expect(river.source).toBe("solver");
    expect(river.facts.equity).toMatchObject({ range: "open:BTN", source: "solver" });
  });

  it("falls back to the labelled placeholder where the charts have no node", () => {
    const h = defend("Kh Qh");
    const button = h.players.find((p) => p.name === "Btn")!.seat;
    expect(chartRange(h, button, h.actions.find((a) => a.street === "flop")!.index, null)).toBeNull();
    const analysis = analyzeHand(h, { charts: null });
    const flop = analysis.decisions.find((d) => d.street === "flop" && d.action === "call")!;
    expect(flop.facts.equity?.source).toBe("narrowed");
    expect(flop.approximations).toContain("placeholder-range");
    const river = analysis.decisions.find((d) => d.street === "river" && d.action === "call")!;
    expect(river.source).toBe("solver");
    expect(river.approximations).toContain("placeholder-range");
    expect(pre(analysis).reason).toBe("chart-unavailable");
  });
});

/* ----------------------------------------------------- explanations - */

describe("explanation templates (§4)", () => {
  it("says the grade, the reference's play and what the move cost, in both languages", () => {
    const fold = pre(analyse(rfi("Utg", "Ah Ad", "fold")));
    const english = en.analysis.explain(fold).join(" ");
    expect(english).toContain("Blunder: the reference plays raise to 2 bb");
    expect(english).toMatch(/Fold costs \d+(\.\d)? bb \(\d+% of the pot\) against raise to 2 bb\./);
    const croatian = hr.analysis.explain(fold).join(" ");
    expect(croatian).toContain("Gruba greška: referenca igra raise na 2 bb");
    expect(croatian).toContain("u odnosu na raise na 2 bb");
  });

  it("names a Perfect move as the reference's play", () => {
    const open = pre(analyse(rfi("Utg", "Ah Ad", "raise", 2)));
    // AA opens to 2bb (the solution's UTG size) nearly always; the rest is its all-in.
    expect(en.analysis.explain(open).join(" ")).toMatch(/Perfect: you played raise to 2 bb; the reference plays raise to 2 bb (9\d|100)% here\./);
  });

  it("says when the hand is outside the reference range at the node", () => {
    // 72o opens under the gun, the button 3-bets: no 72o ever gets here.
    const h = hand({
      hero: "Utg",
      cards: "7c 2d",
      lines: ["Utg: raises $1.5 to $2.5", "Hj: folds", "Co: folds", "Btn: raises $5 to $7.5", "Sb: folds", "Bb: folds", "Utg: folds"],
      winner: "Btn",
      pot: 11,
      returned: 5,
    });
    const facing = pre(analyse(h), 1);
    if (facing.status === "not-analysed") {
      expect(facing.reason).toBe("chart-rare-line");
      return;
    }
    expect(facing.approximations).toContain("out-of-range");
    expect(en.analysis.explain(facing)[1]).toMatch(/^Your hand is outside the reference range at this node; the reference plays it as /);
    expect(hr.analysis.explain(facing)[1]).toMatch(/^Tvoja ruka je izvan referentnog raspona/);
    expect(conceptsForDecision(facing)).toContain("ranges");
  });

  it("never quotes MDF preflop, and never links it", () => {
    const call = pre(analyse(defend("Kh Qh")));
    expect(call.facts.potOdds).not.toBeNull();
    // An older row might carry a preflop MDF; the template must not say it.
    const legacy: DecisionAnalysis = { ...call, facts: { ...call.facts, mdf: 0.6 } };
    for (const decision of [call, legacy]) {
      expect(en.analysis.explain(decision).join(" ")).not.toMatch(/minimum defence/);
      expect(hr.analysis.explain(decision).join(" ")).not.toMatch(/Minimalna obrana/);
      expect(conceptsForDecision(decision)).not.toContain("mdf-alpha");
    }
  });

  it("links a chart grade to the grading page and the preflop concept", () => {
    const fold = pre(analyse(rfi("Utg", "Ah Ad", "fold")));
    const concepts = conceptsForDecision(fold);
    expect(concepts[0]).toBe("rfi");
    expect(concepts).toContain("ev-and-grading");
  });
});

/* ------------------------------------------------- the model caveat - */

describe("the charts/2 model caveat", () => {
  it("knows which implied-odds hands charts/2 still under-rates (docs/CHARTS.md §9)", () => {
    for (const name of ["22", "44", "55", "54s", "65s", "76s", "87s", "A5s"]) expect(impliedOddsClass(name)).toBe(true);
    for (const name of ["66", "99", "TT", "AA", "AKs", "KQs", "72o", "54o", "98s", "T9s", "97s", "A4s", null]) {
      expect(impliedOddsClass(name)).toBe(false);
    }
  });

  it("adds its sentence and link only under a bad grade for playing such a hand", () => {
    const open = pre(analyse(rfi("Utg", "5h 4h", "raise")));
    const fold = pre(analyse(rfi("Utg", "Ah Ad", "fold")));
    expect(modelCaveat(fold)).toBe(false);
    expect(en.analysis.explain(fold).join(" ")).not.toContain("implied odds");
    if (modelCaveat(open)) {
      expect(en.analysis.explain(open).join(" ")).toContain("implied odds");
      expect(hr.analysis.explain(open).join(" ")).toContain("implied odds");
      expect(conceptsForDecision(open)).toContain("equity-realisation");
    } else {
      expect(en.analysis.explain(open).join(" ")).not.toContain("implied odds");
    }
  });
});

/* ------------------------------------------------- the chart viewer - */

describe("the chart viewer's reading of a chart set", () => {
  it("names the line that led to a node", () => {
    expect(lineSteps("")).toEqual([]);
    expect(lineSteps("fffrf")).toEqual([{ position: "BTN", verb: "open" }]);
    expect(lineSteps("rffrff")).toEqual([
      { position: "UTG", verb: "open" },
      { position: "BTN", verb: "3bet" },
    ]);
    expect(lineSteps("ffffc")).toEqual([{ position: "SB", verb: "limp" }]);
    expect(lineSteps("ffffcr")).toEqual([
      { position: "SB", verb: "limp" },
      { position: "BB", verb: "iso" },
    ]);
    expect(lineSteps("ffrcf")).toEqual([
      { position: "CO", verb: "open" },
      { position: "BTN", verb: "call" },
    ]);
  });

  it("reads every node's line onto real players, the actor next", () => {
    for (const node of CHARTS.nodes.values()) {
      const steps = lineSteps(node.line);
      for (const step of steps) expect(["UTG", "HJ", "CO", "BTN", "SB", "BB"]).toContain(step.position);
      if (node.facing) expect(steps.some((step) => step.position === node.facing!.position)).toBe(true);
    }
  });

  it("files every node under at least one scenario, and every scenario but vs-limp has nodes", () => {
    for (const node of CHARTS.nodes.values()) expect(categoriesOf(node).length).toBeGreaterThan(0);
    // Every scenario but play behind an open limp: the GTO Wizard sets limp only from the small blind (blind versus blind).
    expect(SPOT_CATEGORIES.filter((category) => nodesIn(CHARTS, category).length === 0)).toEqual(["vs-limp"]);
    expect(nodesIn(CHARTS, "rfi").map((node) => node.actor)).toEqual(["UTG", "HJ", "CO", "BTN", "SB"]);
  });

  it("lays out 169 distinct classes on the grid, pairs on the diagonal", () => {
    expect(new Set(GRID_CELLS.map((cell) => cell.index)).size).toBe(169);
    expect(GRID_CELLS.every((cell) => cell.index >= 0 && cell.index < 169)).toBe(true);
    expect(GRID_CELLS[0].name).toBe("AA");
    expect(GRID_CELLS[1].name).toBe("AKs");
    expect(GRID_CELLS[13].name).toBe("AKo");
    expect(GRID_CELLS[168].name).toBe("22");
  });

  it("totals a node's actions over its whole range to one", () => {
    for (const node of [...CHARTS.nodes.values()].slice(0, 40)) {
      const totals = actionTotals(node);
      expect(totals.reduce((sum, total) => sum + total.share, 0)).toBeCloseTo(1, 6);
    }
  });
});

/** Every planned set as a spec, no data (which sets neighbour a set reads only the specs). */
const PLANNED: ChartSetSpec[] = PLANNED_CHART_SETS.map((id) => {
  const m = /^nlhe-cash-(hu|\d)(?:max)?-(\d+)bb(-ante|-straddle)?$/.exec(id)!;
  return {
    id,
    players: m[1] === "hu" ? 2 : Number(m[1]),
    stackBb: Number(m[2]),
    ...(m[3] === "-ante" ? { ante: 0.166 } : {}),
    ...(m[3] === "-straddle" ? { straddle: { position: "UTG" as const, bb: 2 }, ante: 0.166 } : {}),
    load: () => Promise.reject(new Error("not loaded")),
  };
});

/* ------------------------------------------- rare lines (analysis/13) - */

describe("a line too rare for its set, read on a neighbouring depth (analysis/13)", () => {
  /** UTG moves all in, the hero folds 72o in the hijack: the 100bb solution stops at the jam, the 150bb one charts the answer. */
  const jammed = () =>
    hand({
      hero: "Hj",
      cards: "7c 2d",
      lines: ["Utg: raises $99 to $100 and is all-in", "Hj: folds", "Co: folds", "Btn: folds", "Sb: folds", "Bb: folds"],
      winner: "Utg",
      pot: 2.5,
      returned: 99,
    });

  it("grades it from the nearest depth that charts it, flagged and capped", () => {
    const decision = pre(analyzeHand(jammed(), { charts: fullLibrary(), turn: false }));
    expect(decision).toMatchObject({ status: "analysed", source: "chart", action: "fold" });
    // At 100bb the solution has no answer to an UTG jam; the 150bb set charts it.
    expect(decision.facts.chart?.set).toBe("nlhe-cash-6max-150bb");
    expect(decision.approximations).toContain("rare-line-depth");
    expect(gradeRank(decision.grade!)).toBeLessThanOrEqual(gradeRank("inaccurate"));
  });

  it("stays refused while the neighbouring sets are not loaded, and names them", () => {
    const only = chartLibrary([fixtureSet(SIX_MAX_100)], FIXTURES.specs);
    const h = jammed();
    expect(pre(analyzeHand(structuredClone(h), { charts: only, turn: false })).reason).toBe("chart-rare-line");
    expect(rareLineChartSets(h, only)).toEqual(["nlhe-cash-6max-150bb"]);
    // The lookup alone (opponents' ranges, the flop library) never reads another depth.
    const found = preflopSpotFromHand(h, 0);
    expect(found.ok && lookupPreflop(fullLibrary(), found.spot, null, null)).toMatchObject({ ok: false, reason: "rare-line" });
  });

  it("reads only the adjacent depths of the same table and kind, nearest first", () => {
    // Over the owner's planned list (which sets neighbour reads only the specs).
    const spec = (id: string) => PLANNED.find((s) => s.id === id)!;
    const depths = (id: string, bb?: number) => rareLineDepthSets(PLANNED, spec(id), bb).map((s) => s.stackBb);
    expect(depths("nlhe-cash-6max-100bb")).toEqual([150, 60]);
    expect(depths("nlhe-cash-6max-100bb", 85)).toEqual([60, 150]);
    // 9-max has no 60bb set without an ante.
    expect(depths("nlhe-cash-9max-100bb")).toEqual([150]);
    expect(depths("nlhe-cash-9max-200bb")).toEqual([150]);
    expect(depths("nlhe-cash-6max-40bb")).toEqual([60]);
    expect(depths("nlhe-cash-6max-100bb-straddle")).toEqual([]);
    // An ante set reads only the ante sets.
    expect(rareLineDepthSets(PLANNED, spec("nlhe-cash-6max-100bb-ante")).map((s) => s.id)).toEqual([
      "nlhe-cash-6max-150bb-ante",
      "nlhe-cash-6max-60bb-ante",
    ]);
    expect(depths("nlhe-cash-9max-100bb-ante")).toEqual([150, 60]);
    // Heads-up reads only heads-up: the other heads-up depth, never a 6-max set.
    expect(depths("nlhe-cash-hu-100bb")).toEqual([150]);
    expect(depths("nlhe-cash-hu-150bb")).toEqual([100]);
  });
});

/* ------------------------------------- uncovered depths (analysis/39) - */

describe("a depth no set of the table covers, graded on the nearest charted one (analysis/39)", () => {
  /** Everyone `stack` deep; UTG and HJ fold, the cutoff (hero) acts, the rest fold. */
  const cutoff = (cards: string, action: "raise" | "fold", stack: number) =>
    action === "raise"
      ? hand({
          hero: "Co",
          cards,
          stack,
          lines: ["Utg: folds", "Hj: folds", "Co: raises $1.5 to $2.5", "Btn: folds", "Sb: folds", "Bb: folds"],
          winner: "Co",
          pot: 2.5,
          returned: 1.5,
        })
      : hand({
          hero: "Co",
          cards,
          stack,
          lines: ["Utg: folds", "Hj: folds", "Co: folds", "Btn: raises $1.5 to $2.5", "Sb: folds", "Bb: folds"],
          winner: "Btn",
          pot: 2.5,
          returned: 1.5,
        });

  // The test sets have 100 and 150bb at 6-max (no 60bb yet): 76bb reads 100bb, the nearest charted depth above.
  it("grades a 6-max 76bb open on the 100bb set, flagged", () => {
    const decision = pre(analyzeHand(cutoff("Ah Kd", "raise", 76), { charts: fullLibrary(), turn: false }));
    expect(decision).toMatchObject({ status: "analysed", source: "chart", action: "raise", grade: "perfect" });
    // 76bb is not within 20% of 100.
    expect(decision.facts.chart?.set).toBe("nlhe-cash-6max-100bb");
    expect(decision.approximations).toContain("uncovered-depth");
    expect(decision.approximations).not.toContain("rare-line-depth");
  });

  it("caps a bad play there at Inaccurate", () => {
    const decision = pre(analyzeHand(cutoff("Ah Ad", "fold", 76), { charts: fullLibrary(), turn: false }));
    expect(decision).toMatchObject({ status: "analysed", source: "chart", action: "fold", grade: "inaccurate" });
    expect(decision.approximations).toContain("uncovered-depth");
    // The same fold at a charted depth is a Blunder.
    expect(pre(analyzeHand(cutoff("Ah Ad", "fold", 100), { charts: fullLibrary(), turn: false })).grade).toBe("blunder");
  });

  it("reads at most 5/3 of a depth away: 62bb on the 100bb set, 58bb refused", () => {
    const near = pre(analyzeHand(cutoff("Ah Kd", "raise", 62), { charts: fullLibrary(), turn: false }));
    expect(near).toMatchObject({ status: "analysed", source: "chart" });
    expect(near.facts.chart?.set).toBe("nlhe-cash-6max-100bb");
    expect(near.approximations).toContain("uncovered-depth");
    const far = pre(analyzeHand(cutoff("Ah Kd", "raise", 58), { charts: fullLibrary(), turn: false }));
    expect(far).toMatchObject({ status: "not-analysed", reason: "chart-stack-depth" });
  });

  it("stays refused while the neighbouring sets are not loaded, and names them", () => {
    // Only the 150bb set: 76bb's neighbour (100bb; no 60bb among the test sets) is not loaded.
    const only = chartLibrary([fixtureSet("nlhe-cash-6max-150bb")], FIXTURES.specs);
    const h = cutoff("Ah Kd", "raise", 76);
    expect(pre(analyzeHand(structuredClone(h), { charts: only, turn: false })).reason).toBe("chart-stack-depth");
    expect([...rareLineChartSets(h, only)].sort()).toEqual(["nlhe-cash-6max-100bb"]);
    // The lookup alone (the flop library's placement) still refuses the depth.
    const found = preflopSpotFromHand(h, 0);
    expect(found.ok && lookupPreflop(fullLibrary(), found.spot, null, null)).toMatchObject({ ok: false, reason: "stack-depth" });
  });

  it("explains the flag in both languages", () => {
    for (const dict of [en, hr]) expect(dict.analysis.approximations["uncovered-depth"]).toMatch(/Inaccurate|Netočno/);
  });
});
