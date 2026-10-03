/**
 * Reports: your frequencies against the reference (phase A3,
 * `docs/ANALYSIS-PLAN.md` §6.3, `frontend/src/lib/analysis/reports.ts`).
 *
 * Like the preflop grading suite, **no chart number is pinned**: the chart
 * set is regenerated independently (`charts/2`). What is asserted holds for
 * any chart set — frequencies sum to one, a reference for one hand class is
 * that class's own mix, the line walk agrees with the set's own actors, a
 * rolled-up stat is the decision-weighted sum of its nodes — plus the
 * statistics of the comparison itself (the Wilson interval is the stats
 * screen's, the verdict follows it).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHART_ACTIONS,
  MIN_PRACTICAL_DIFF,
  MIN_SAMPLE,
  REPORT_STATS,
  STAT_SPECS,
  aggregate,
  buildReports,
  compare,
  compatibility,
  defenceTable,
  handAdjustedReference,
  inPositionAgainst,
  nodeKey,
  nodeReport,
  nodeSamples,
  openerOf,
  opponentRanges,
  postflopRoles,
  rangeReference,
  removalFactors,
  sampleSets,
  statParts,
  statReport,
  walkLine,
  wilsonInterval,
  type NodeActionCount,
  type NodeClassCount,
  type NodeSample,
} from "../../frontend/src/lib/analysis/index.js";
import { actionTotals, GRID_CELLS } from "../../frontend/src/components/analysis/chartSpots.js";
import { wilson } from "../../frontend/src/components/stats/uncertainty.js";
import { chartLibrary, handClassOf, loadCharts, type ChartNode, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr } from "../../frontend/src/lib/i18n/hr.js";

const FILE = join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json");
const charts: ChartSet = loadCharts(JSON.parse(readFileSync(FILE, "utf8")));
const nodes = [...charts.nodes.values()];
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const byScenario = (scenario: string) => nodes.filter((node) => node.scenario === scenario);
const rfi = (actor: string) => nodes.find((node) => node.scenario === "rfi" && node.actor === actor)!;

/** A sample at one node, as `nodeSamples` would build it from the RPC's rows. */
function sampleAt(node: ChartNode, hands: Array<[string, string, number]>): NodeSample {
  const actions: NodeActionCount[] = [];
  const classes: NodeClassCount[] = [];
  const byAction = new Map<string, number>();
  for (const [handClass, action, n] of hands) {
    byAction.set(action, (byAction.get(action) ?? 0) + n);
    classes.push({ set: charts.id, line: node.line, handClass, action, decisions: n });
  }
  for (const [action, n] of byAction) {
    actions.push({ set: charts.id, line: node.line, scenario: node.scenario, action, decisions: n, deviations: 0, evLossBb: 0 });
  }
  return nodeSamples(actions, classes)[0];
}

/** The chart's most frequent action for a class at a node. */
function pureAction(node: ChartNode, name: string): { action: string; freq: number } {
  const k = handClassOf(name);
  let best = { action: node.options[0].action as string, freq: -1 };
  node.options.forEach((option, a) => {
    const freq = node.freq[a * 169 + k];
    if (freq > best.freq) best = { action: option.action, freq };
  });
  return best;
}

describe("the line walk", () => {
  it("names the next actor of every node in the set as the node's own actor", () => {
    for (const node of nodes) {
      expect(walkLine(node.line).next, node.line).toBe(node.actor);
    }
  });

  it("finds the opener of every node past an open", () => {
    for (const node of nodes.filter((n) => n.scenario === "vs-3bet" || n.scenario === "vs-4bet")) {
      const opener = openerOf(node.line);
      expect(opener).not.toBeNull();
      // The opener's own node is on the line, unless the opener was the actor itself.
      const steps = walkLine(node.line).steps;
      const k = steps.findIndex((step) => step.code === "r" || step.code === "a");
      expect(steps[k].position).toBe(opener);
    }
    expect(openerOf("")).toBeNull();
    expect(openerOf("ffr")).toBe("CO");
    expect(openerOf("fffrr")).toBe("BTN");
  });

  it("puts the later postflop seat in position", () => {
    expect(inPositionAgainst("BTN", "CO")).toBe(true);
    expect(inPositionAgainst("CO", "BTN")).toBe(false);
    expect(inPositionAgainst("BTN", "SB")).toBe(true);
    expect(inPositionAgainst("BB", "SB")).toBe(true);
    expect(inPositionAgainst("SB", "UTG")).toBe(false);
  });
});

describe("card removal", () => {
  const compat = compatibility();
  it("counts the combos one hand leaves of another exactly", () => {
    const at = (a: string, b: string) => compat[handClassOf(a) * 169 + handClassOf(b)];
    expect(at("AA", "AA")).toBe(1);
    expect(at("AA", "KK")).toBe(6);
    expect(at("AKs", "AA")).toBe(3);
    expect(at("AKo", "AKs")).toBe(2);
    expect(at("72o", "AKo")).toBe(12);
    // Every row leaves 1225 combos in all.
    for (let i = 0; i < 169; i += 1) {
      expect(sum(Array.from(compat.subarray(i * 169, (i + 1) * 169)))).toBe(1225);
    }
  });

  it("has no opponents and no effect first in under the gun", () => {
    expect(opponentRanges(charts, "")).toEqual([]);
    expect([...removalFactors([])].every((f) => f === 1)).toBe(true);
  });

  it("reads each earlier actor's range at its last node on the line", () => {
    const node = byScenario("vs-3bet").find((n) => !n.cold && n.facing)!;
    const opponents = opponentRanges(charts, node.line);
    expect(opponents.some((o) => o.position === node.facing!.position)).toBe(true);
    expect(opponents.some((o) => o.position === node.actor)).toBe(false);
    for (const opponent of opponents) expect(Math.max(...opponent.weights)).toBeLessThanOrEqual(1);
  });

  it("makes blockers of an opener's range less likely (a raise holds more aces)", () => {
    const node = byScenario("vs-open").find((n) => n.facing?.position === "UTG")!;
    const factors = removalFactors(opponentRanges(charts, node.line));
    expect(factors[handClassOf("AKo")]).toBeLessThan(factors[handClassOf("76s")]);
    for (const f of factors) expect(Number.isFinite(f) && f >= 0).toBe(true);
  });
});

describe("the range reference", () => {
  it("sums to 1 over every node's actions, with and without card removal", () => {
    for (const node of nodes) {
      for (const cardRemoval of [true, false]) {
        const { freq } = rangeReference(charts, node, { cardRemoval });
        expect(sum(CHART_ACTIONS.map((a) => freq[a])), node.line).toBeCloseTo(1, 9);
        const offered = new Set(node.options.map((o) => o.action));
        for (const action of CHART_ACTIONS) if (!offered.has(action)) expect(freq[action]).toBe(0);
      }
    }
  });

  it("is the chart browser's whole-range totals without card removal", () => {
    for (const node of nodes) {
      const { freq } = rangeReference(charts, node, { cardRemoval: false });
      const totals = actionTotals(node);
      node.options.forEach((option, a) => expect(freq[option.action]).toBeCloseTo(totals[a].share, 9));
    }
  });

  it("changes little with card removal (a correction, not a new answer)", () => {
    // Most where the opponents' ranges are narrowest: deep 4-bet and all-in lines.
    for (const node of nodes) {
      const plain = rangeReference(charts, node, { cardRemoval: false }).freq;
      const removed = rangeReference(charts, node).freq;
      const bound = node.scenario === "rfi" || node.scenario === "vs-open" ? 0.03 : 0.15;
      for (const action of CHART_ACTIONS) expect(Math.abs(plain[action] - removed[action]), node.line).toBeLessThan(bound);
    }
  });

  it("first in under the gun, needs no correction", () => {
    const node = rfi("UTG");
    const plain = rangeReference(charts, node, { cardRemoval: false }).freq;
    const removed = rangeReference(charts, node).freq;
    for (const action of CHART_ACTIONS) expect(removed[action]).toBeCloseTo(plain[action], 12);
  });
});

describe("the hand-adjusted reference", () => {
  it("is the chart's own mix for a single class", () => {
    for (const node of nodes.slice(0, 40)) {
      for (const cell of GRID_CELLS.filter((_, i) => i % 17 === 0)) {
        const adjusted = handAdjustedReference(node, new Map([[cell.name, 3]]))!;
        node.options.forEach((option, a) => expect(adjusted[option.action]).toBeCloseTo(node.freq[a * 169 + cell.index], 12));
      }
    }
  });

  it("is the decision-weighted mean over classes, and sums to 1", () => {
    const node = rfi("BTN");
    const counts = new Map([
      ["AA", 2],
      ["72o", 3],
      ["T9s", 1],
    ]);
    const adjusted = handAdjustedReference(node, counts)!;
    expect(sum(CHART_ACTIONS.map((a) => adjusted[a]))).toBeCloseTo(1, 12);
    const raise = node.options.findIndex((o) => o.action === "raise");
    const expected =
      (2 * node.freq[raise * 169 + handClassOf("AA")] +
        3 * node.freq[raise * 169 + handClassOf("72o")] +
        node.freq[raise * 169 + handClassOf("T9s")]) /
      6;
    expect(adjusted.raise).toBeCloseTo(expected, 12);
  });

  it("is null without a readable class", () => {
    expect(handAdjustedReference(rfi("CO"), new Map())).toBeNull();
    expect(handAdjustedReference(rfi("CO"), new Map([["XYz", 4]]))).toBeNull();
  });

  it("matches a player who plays the chart's pure answer exactly", () => {
    const node = rfi("CO");
    const classes = ["AA", "KQs", "72o", "J4o", "55", "A5s", "T8o", "Q9s"];
    const hands = classes.map((name) => [name, pureAction(node, name).action, 2] as [string, string, number]);
    const pure = classes.every((name) => pureAction(node, name).freq === 1);
    const report = nodeReport(charts, sampleAt(node, hands))!;
    if (pure) {
      for (const row of report.rows) expect(row.comparison.adjustedDiff).toBeCloseTo(0, 12);
    }
    expect(report.sample.decisions).toBe(16);
  });
});

describe("uncertainty", () => {
  it("is the statistics screen's Wilson interval, in fractions", () => {
    for (const [made, n] of [
      [0, 3],
      [3, 3],
      [12, 40],
      [400, 1000],
      [1, 1],
    ]) {
      const ours = wilsonInterval(made, n)!;
      const theirs = wilson(made, n)!;
      expect(ours.low * 100).toBeCloseTo(theirs.low, 9);
      expect(ours.high * 100).toBeCloseTo(theirs.high, 9);
    }
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it("calls a gap a deviation only outside the interval, above the practical floor, over enough hands", () => {
    expect(compare(5, MIN_SAMPLE - 1, 0.1, null).verdict).toBe("too-few");
    expect(compare(50, 100, 0.48, null).verdict).toBe("in-line");
    expect(compare(80, 100, 0.48, null).verdict).toBe("deviates");
    expect(compare(10, 100, 0.48, null).verdict).toBe("deviates");
    // Outside the interval but under the floor: a huge sample, a 1.5-point gap.
    const tiny = compare(51_500, 100_000, 0.5, null);
    expect(Math.abs(tiny.diff!)).toBeLessThan(MIN_PRACTICAL_DIFF);
    expect(tiny.verdict).toBe("in-line");
    expect(compare(0, 0, 0.3, null)).toMatchObject({ yours: null, diff: null, verdict: "too-few" });
  });

  it("states the signed differences against both references", () => {
    const c = compare(30, 100, 0.2, 0.25);
    expect(c.yours).toBeCloseTo(0.3);
    expect(c.diff).toBeCloseTo(0.1);
    expect(c.adjustedDiff).toBeCloseTo(0.05);
  });
});

describe("samples and nodes", () => {
  it("groups the RPC's rows by node and keeps unknown actions out", () => {
    const samples = nodeSamples(
      [
        { set: charts.id, line: "", scenario: "rfi", action: "fold", decisions: 7, deviations: 1, evLossBb: 0.2 },
        { set: charts.id, line: "", scenario: "rfi", action: "raise", decisions: 3, deviations: 0, evLossBb: 0 },
        { set: charts.id, line: "", scenario: "rfi", action: "dance", decisions: 9, deviations: 9, evLossBb: 9 },
      ],
      [
        { set: charts.id, line: "", handClass: "AA", action: "raise", decisions: 3 },
        { set: charts.id, line: "", handClass: "72o", action: "fold", decisions: 7 },
        { set: charts.id, line: "zz", handClass: "72o", action: "fold", decisions: 7 },
      ],
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ key: nodeKey(charts.id, ""), decisions: 10, deviations: 1 });
    expect(samples[0].actions.raise).toBe(3);
    expect(samples[0].classes.get("AA")).toBe(3);
  });

  it("refuses a node from another chart set or not in this one", () => {
    const node = rfi("UTG");
    const sample = sampleAt(node, [["AA", "raise", 1]]);
    expect(nodeReport(charts, { ...sample, set: "another-set" })).toBeNull();
    expect(nodeReport(charts, { ...sample, line: "rrrrrrrrrr" })).toBeNull();
  });

  it("lists a fold the tree lacks, with a zero reference", () => {
    const node = byScenario("vs-limp")[0];
    expect(node.options.some((o) => o.action === "fold")).toBe(false);
    const report = nodeReport(charts, sampleAt(node, [["72o", "fold", 2], ["AA", "raise", 1]]))!;
    const fold = report.rows.find((row) => row.action === "fold")!;
    expect(fold.comparison.reference).toBe(0);
    expect(fold.comparison.yours).toBeCloseTo(2 / 3);
  });
});

describe("familiar stats, rolled up from nodes", () => {
  it("has one RFI node per position, UTG to SB", () => {
    const parts = statParts(charts, new Map(), STAT_SPECS.rfi.applies, STAT_SPECS.rfi.made);
    expect(parts.map((p) => p.split.position).sort()).toEqual(["BTN", "CO", "HJ", "SB", "UTG"]);
  });

  it("weights each node's reference by the player's decisions there", () => {
    const utg = rfi("UTG");
    const btn = rfi("BTN");
    const samples = new Map<string, NodeSample>([
      [nodeKey(charts.id, utg.line), sampleAt(utg, [["AA", "raise", 3], ["72o", "fold", 27]])],
      [nodeKey(charts.id, btn.line), sampleAt(btn, [["AA", "raise", 10], ["72o", "fold", 0], ["K9o", "raise", 0]])],
    ]);
    const report = statReport(charts, samples, "rfi");
    const refUtg = rangeReference(charts, utg).freq;
    const refBtn = rangeReference(charts, btn).freq;
    const expected = (30 * (refUtg.raise + refUtg.allin) + 10 * (refBtn.raise + refBtn.allin)) / 40;
    expect(report.total.decisions).toBe(40);
    expect(report.total.made).toBe(13);
    expect(report.total.reference).toBeCloseTo(expected, 12);
    expect(report.nodes.sort()).toEqual([nodeKey(charts.id, utg.line), nodeKey(charts.id, btn.line)].sort());
    const utgSplit = report.splits.find((s) => s.key.position === "UTG")!;
    expect(utgSplit.comparison.yours).toBeCloseTo(0.1);
    expect(utgSplit.comparison.reference).toBeCloseTo(refUtg.raise + refUtg.allin, 12);
    // The hand-adjusted reference of the whole row: AA opens, 72o folds (each
    // but for the 0.5% limp tremble of charts/4).
    const opens = (node: ChartNode, name: string) => {
      const k = handClassOf(name);
      return node.options.reduce((sum, o, a) => sum + (o.action === "raise" || o.action === "allin" ? node.freq[a * 169 + k] : 0), 0);
    };
    const adjusted = (3 * opens(utg, "AA") + 27 * opens(utg, "72o") + 10 * opens(btn, "AA")) / 40;
    expect(report.total.adjusted).toBeCloseTo(adjusted, 9);
    expect(report.total.adjusted).toBeCloseTo(13 / 40, 1);
  });

  it("falls back to the reference's own reach weighting with no decisions", () => {
    const parts = statParts(charts, new Map(), STAT_SPECS.rfi.applies, STAT_SPECS.rfi.made);
    const expected = sum(parts.map((p) => p.node.reach * p.reference)) / sum(parts.map((p) => p.node.reach));
    const total = aggregate(parts);
    expect(total.decisions).toBe(0);
    expect(total.reference).toBeCloseTo(expected, 12);
    expect(total.verdict).toBe("too-few");
  });

  it("defines every stat on nodes the set has, and steals as late-position opens", () => {
    for (const id of REPORT_STATS) {
      const parts = statParts(charts, new Map(), STAT_SPECS[id].applies, STAT_SPECS[id].made);
      expect(parts.length, id).toBeGreaterThan(0);
    }
    const steals = statParts(charts, new Map(), STAT_SPECS.steal.applies, STAT_SPECS.steal.made);
    expect(steals.map((p) => p.split.position).sort()).toEqual(["BTN", "CO", "SB"]);
  });

  it("splits fold to a 3-bet into in and out of position against the 3-bettor", () => {
    const ip = statParts(charts, new Map(), STAT_SPECS["fold-to-three-bet-ip"].applies, ["fold"]);
    const oop = statParts(charts, new Map(), STAT_SPECS["fold-to-three-bet-oop"].applies, ["fold"]);
    for (const part of ip) expect(inPositionAgainst(part.split.position, part.split.versus!)).toBe(true);
    for (const part of oop) expect(inPositionAgainst(part.split.position, part.split.versus!)).toBe(false);
    for (const part of [...ip, ...oop]) {
      expect(part.node.cold).toBe(false);
      expect(openerOf(part.node.line)).toBe(part.node.actor);
    }
    expect(ip.length + oop.length).toBeGreaterThan(0);
  });

  it("gives the blinds' defence as fold, call and 3-bet that add up to the whole", () => {
    const rows = defenceTable(charts, new Map());
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(["SB", "BB"]).toContain(row.key.position);
      expect(row.fold.reference! + row.call.reference! + row.threeBet.reference!).toBeCloseTo(1, 9);
    }
  });
});

describe("postflop roles", () => {
  it("reads the stored role scenarios and leaves limped pots and raises out", () => {
    const roles = postflopRoles(
      [
        { street: "flop", scenario: "pfr-ip-first", action: "bet", decisions: 6 },
        { street: "flop", scenario: "pfr-ip-first", action: "check", decisions: 4 },
        { street: "flop", scenario: "caller-oop-vs-bet", action: "fold", decisions: 3 },
        { street: "flop", scenario: "caller-oop-vs-bet", action: "call", decisions: 2 },
        { street: "flop", scenario: "caller-oop-vs-raise", action: "call", decisions: 9 },
        { street: "flop", scenario: "limped-oop-first", action: "bet", decisions: 9 },
        { street: "turn", scenario: "pfr-ip-first", action: "bet", decisions: 9 },
      ],
      "flop",
    );
    const pfrIp = roles.find((r) => r.role === "pfr-ip")!;
    expect(pfrIp.first).toEqual({ decisions: 10, bet: 6 });
    const callerOop = roles.find((r) => r.role === "caller-oop")!;
    expect(callerOop.vsBet).toEqual({ decisions: 5, fold: 3, call: 2, raise: 0 });
    expect(roles.find((r) => r.role === "caller-ip")!.first.decisions).toBe(0);
  });
});

describe("the words", () => {
  it("names, defines and gives a tip for every stat and verdict in both languages", () => {
    for (const dict of [en, hr]) {
      const t = dict.analysis.reports;
      for (const id of REPORT_STATS) {
        expect(t.stats.names[id], id).toBeTruthy();
        expect(t.stats.definitions[id], id).toBeTruthy();
        expect(t.stats.tips[id], id).toBeTruthy();
      }
      for (const verdict of ["in-line", "deviates", "too-few"]) expect(t.verdicts[verdict]).toBeTruthy();
      for (const action of CHART_ACTIONS) expect(t.actions[action]).toBeTruthy();
    }
  });

  it("formats shares and signed gaps the way each language writes them", () => {
    expect(en.analysis.reports.pct(0.2345)).toBe("23%");
    expect(en.analysis.reports.pct(0.061)).toBe("6.1%");
    expect(en.analysis.reports.points(0.041)).toBe("+4.1 pts");
    expect(en.analysis.reports.points(-0.17)).toBe("−17 pts");
    expect(hr.analysis.reports.pct(0.061)).toBe("6,1 %");
    expect(hr.analysis.reports.points(-0.053)).toBe("−5,3 p. b.");
    expect(hr.analysis.reports.sample(1274, 1232)).toBe("Ocijenjenih odluka: 1.274, u 1.232 ruke");
    expect(hr.analysis.reports.sample(5, 1)).toBe("Ocijenjenih odluka: 5, u 1 ruci");
  });
});

describe("several chart sets (A2d)", () => {
  const nine: ChartSet = loadCharts(
    JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-9max-100bb.json"), "utf8")),
  );
  const library = chartLibrary([charts, nine]);
  const firstIn = (set: ChartSet, actor: string) =>
    [...set.nodes.values()].find((node) => node.scenario === "rfi" && node.actor === actor)!;
  /** `sampleAt` on any set. */
  function sampleOn(set: ChartSet, node: ChartNode, hands: Array<[string, string, number]>): NodeSample {
    const actions: NodeActionCount[] = [];
    const classes: NodeClassCount[] = [];
    const byAction = new Map<string, number>();
    for (const [handClass, action, n] of hands) {
      byAction.set(action, (byAction.get(action) ?? 0) + n);
      classes.push({ set: set.id, line: node.line, handClass, action, decisions: n });
    }
    for (const [action, n] of byAction) {
      actions.push({ set: set.id, line: node.line, scenario: node.scenario, action, decisions: n, deviations: 0, evLossBb: 0 });
    }
    return nodeSamples(actions, classes)[0];
  }
  const sixUtg = firstIn(charts, "UTG");
  const nineUtg = firstIn(nine, "UTG");
  const sixBtn = firstIn(charts, "BTN");
  // The same line ("", UTG first in) on both tables: two different seats.
  const samples = [
    sampleOn(charts, sixUtg, [["AA", "raise", 4], ["72o", "fold", 16]]),
    sampleOn(nine, nineUtg, [["AA", "raise", 2], ["72o", "fold", 58]]),
    sampleOn(charts, sixBtn, [["K9o", "raise", 5], ["72o", "fold", 5]]),
  ];
  const byKey = new Map(samples.map((sample) => [sample.key, sample]));
  const made = (set: ChartSet, node: ChartNode) => {
    const ref = rangeReference(set, node).freq;
    return ref.raise + ref.allin;
  };

  it("keys a node by its set, so one line on two tables is two samples", () => {
    expect(nodeKey(charts.id, "")).not.toBe(nodeKey(nine.id, ""));
    expect(sampleSets(samples)).toEqual([
      { set: nine.id, decisions: 60 },
      { set: charts.id, decisions: 30 },
    ]);
  });

  it("pools a stat over sets, each node's reference weighted by the player's decisions there", () => {
    const report = statReport([charts, nine], byKey, "rfi");
    const expected = (20 * made(charts, sixUtg) + 60 * made(nine, nineUtg) + 10 * made(charts, sixBtn)) / 90;
    expect(report.total.decisions).toBe(90);
    expect(report.total.made).toBe(11);
    expect(report.total.reference).toBeCloseTo(expected, 12);
    // One set alone is that set's part of it.
    const six = statReport(charts, byKey, "rfi");
    expect(six.total.decisions).toBe(30);
    expect(six.total.reference).toBeCloseTo((20 * made(charts, sixUtg) + 10 * made(charts, sixBtn)) / 30, 12);
  });

  it("keeps each table's seats apart in the splits, 6-max first", () => {
    const report = statReport([charts, nine], byKey, "rfi");
    const utg = report.splits.filter((split) => split.key.position === "UTG");
    expect(utg.map((split) => split.key.table)).toEqual([6, 9]);
    expect(utg.map((split) => split.comparison.decisions)).toEqual([20, 60]);
    expect(utg[1].comparison.reference).toBeCloseTo(made(nine, nineUtg), 12);
    // 9-max's own seats are there, after 6-max's.
    const tables = report.splits.map((split) => split.key.table ?? 6);
    expect(tables).toEqual([...tables].sort((a, b) => a - b));
    expect(report.splits.some((split) => split.key.position === "UTG+1" && split.key.table === 9)).toBe(true);
  });

  it("builds the whole screen over every set with decisions, or one", () => {
    const all = buildReports(library, samples);
    expect(all.sets).toEqual([nine.id, charts.id]);
    expect(all.unmatched).toBe(0);
    expect(all.nodes.map((n) => n.sample.decisions)).toEqual([60, 20, 10]);
    expect(all.nodes[0].node).toBe(nineUtg);
    expect(all.stats.find((stat) => stat.id === "rfi")!.total.decisions).toBe(90);
    const one = buildReports(library, samples, charts.id);
    expect(one.sets).toEqual([charts.id]);
    expect(one.nodes.every((n) => n.sample.set === charts.id)).toBe(true);
    expect(one.stats.find((stat) => stat.id === "rfi")!.total.decisions).toBe(30);
  });

  it("counts decisions on a set the library has not loaded as unmatched", () => {
    const built = buildReports(chartLibrary([charts]), samples);
    expect(built.unmatched).toBe(60);
    expect(built.sets).toEqual([charts.id]);
    expect(built.stats.find((stat) => stat.id === "rfi")!.total.decisions).toBe(30);
  });

  it("finds a 9-max opener on its own table", () => {
    const ip = statParts(nine, new Map(), STAT_SPECS["fold-to-three-bet-ip"].applies, ["fold"]);
    const oop = statParts(nine, new Map(), STAT_SPECS["fold-to-three-bet-oop"].applies, ["fold"]);
    expect(ip.length + oop.length).toBeGreaterThan(0);
    for (const part of [...ip, ...oop]) {
      expect(openerOf(part.node.line, nine.game.positions)).toBe(part.node.actor);
      expect(part.split.table).toBe(9);
    }
  });
});
