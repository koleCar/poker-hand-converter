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

import { readFileSync } from "node:fs";
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
} from "../../frontend/src/lib/analysis/index.js";
import {
  GRID_CELLS,
  SPOT_CATEGORIES,
  actionTotals,
  categoriesOf,
  lineSteps,
  nodesIn,
} from "../../frontend/src/components/analysis/chartSpots.js";
import { handClassOf, loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr } from "../../frontend/src/lib/i18n/hr.js";
import { conceptsForDecision } from "../../frontend/src/lib/learn/links.js";
import { parseStandardHand } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);
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

  it("carries the model note on every chart grade while charts/1 has its known weakness", () => {
    const fold = pre(analyse(rfi("Utg", "Ah Ad", "fold")));
    if (CHARTS.version === "charts/1") expect(fold.approximations).toContain("model");
    expect(fold.approximations).not.toContain("heuristic");
  });

  it("is deterministic", () => {
    const h = rfi("Co", "Kh Qd", "raise");
    expect(analyse(structuredClone(h))).toEqual(analyse(structuredClone(h)));
  });
});

/* ---------------------------------------------------------- refusals - */

describe("what the charts refuse, by name", () => {
  it("refuses a three-handed table", () => {
    const h = hand({
      hero: "Btn",
      cards: "Ah Kd",
      seats: ["Btn", "Sb", "Bb"],
      lines: ["Btn: raises $1.5 to $2.5", "Sb: folds", "Bb: folds"],
      winner: "Btn",
      pot: 2.5,
      returned: 1.5,
    });
    const analysis = analyse(h);
    expect(pre(analysis)).toMatchObject({ status: "not-analysed", reason: "chart-players", grade: null });
    expect(analysis).toMatchObject({ status: "not-analysed", reason: "chart-players", grade: null, evLoss: null });
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

  it("refuses a line behind an open limp", () => {
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
    expect(decision.reason).toBe("chart-limp");
  });

  it("explains a refusal in both languages, and links to nothing it did not say", () => {
    for (const reason of CHART_SKIP_REASONS) {
      expect(en.analysis.reasons[reason]).toBeTruthy();
      expect(hr.analysis.reasons[reason]).toBeTruthy();
    }
    const decision = pre(
      analyse(
        hand({
          hero: "Btn",
          cards: "Ah Kd",
          seats: ["Btn", "Sb", "Bb"],
          lines: ["Btn: raises $1.5 to $2.5", "Sb: folds", "Bb: folds"],
          winner: "Btn",
          pot: 2.5,
          returned: 1.5,
        }),
      ),
    );
    expect(en.analysis.explain(decision)[0]).toMatch(/^Not graded: the charts are for six-handed tables/);
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

  it("uses that range for the equity facts, labelled as the charts' and not narrowed", () => {
    const analysis = analyse(defend("Kh Qh"));
    const river = analysis.decisions.find((d) => d.street === "river" && d.action === "call")!;
    expect(river.facts.equity).toMatchObject({ range: "open:BTN", source: "chart" });
    expect(river.approximations).toContain("preflop-range");
    expect(river.approximations).not.toContain("placeholder-range");
    expect(en.analysis.explain(river).join(" ")).toContain("as the charts play it");
  });

  it("falls back to the labelled placeholder where the charts have no node", () => {
    const h = defend("Kh Qh");
    const button = h.players.find((p) => p.name === "Btn")!.seat;
    expect(chartRange(h, button, h.actions.find((a) => a.street === "flop")!.index, null)).toBeNull();
    const analysis = analyzeHand(h, { charts: null });
    const river = analysis.decisions.find((d) => d.street === "river" && d.action === "call")!;
    expect(river.facts.equity?.source).toBe("placeholder");
    expect(river.approximations).toContain("placeholder-range");
    expect(pre(analysis).reason).toBe("chart-unavailable");
  });
});

/* ----------------------------------------------------- explanations - */

describe("explanation templates (§4)", () => {
  it("says the grade, the reference's play and what the move cost, in both languages", () => {
    const fold = pre(analyse(rfi("Utg", "Ah Ad", "fold")));
    const english = en.analysis.explain(fold).join(" ");
    expect(english).toContain("Blunder: the reference plays raise to 2.5 bb");
    expect(english).toMatch(/Fold costs \d+(\.\d)? bb \(\d+% of the pot\) against raise to 2\.5 bb\./);
    const croatian = hr.analysis.explain(fold).join(" ");
    expect(croatian).toContain("Gruba greška: referenca igra raise na 2,5 bb");
    expect(croatian).toContain("u odnosu na raise na 2,5 bb");
  });

  it("names a Perfect move as the reference's play", () => {
    const open = pre(analyse(rfi("Utg", "Ah Ad", "raise")));
    expect(en.analysis.explain(open).join(" ")).toContain("Perfect: you played raise to 2.5 bb; the reference plays raise to 2.5 bb 100% here.");
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

describe("the charts/1 model caveat", () => {
  it("knows which hands win through implied odds", () => {
    for (const name of ["22", "77", "99", "54s", "76s", "T9s", "J8s", "97s"]) expect(impliedOddsClass(name)).toBe(true);
    for (const name of ["TT", "AA", "AKs", "KQs", "72o", "54o", "Q9s", "A5s", null]) expect(impliedOddsClass(name)).toBe(false);
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

  it("files every node under at least one scenario, and every scenario has nodes", () => {
    for (const node of CHARTS.nodes.values()) expect(categoriesOf(node).length).toBeGreaterThan(0);
    for (const category of SPOT_CATEGORIES) expect(nodesIn(CHARTS, category).length).toBeGreaterThan(0);
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
