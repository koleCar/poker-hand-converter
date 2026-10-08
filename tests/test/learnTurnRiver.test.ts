/**
 * Learn L3: the turn and river practice, and mastery from the learner's own
 * hands.
 *
 * 1. **River setup**: the river spot's first half, shared by the spot, the
 *    split and the paint, draws from the seed exactly as the spot always did.
 * 2. **The river split**: the hero's range at a river node by `riverCategory`,
 *    recomputed here from the solve; an overbet is its own group; a raise of
 *    the hero's bet is reached through the hero's bet.
 * 3. **The turn's flop filter**: a turn after the flop checked through, or
 *    after a flop bet was called.
 * 4. **The range paint**: the grader's tolerance and weights by hand, the
 *    chart's first-in range recomputed from the chart, a river node's cells
 *    recomputed from the solve, and Rail's own painting passing.
 * 5. **Mastery**: before and after the pass date, from the leak finder's
 *    rows, with "not enough hands yet" below the minimum.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { riverCategory } from "../../frontend/src/lib/analysis/index.js";
import type { SpotRow } from "../../frontend/src/lib/analysis/leaks.js";
import { loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { cardIndex } from "../../frontend/src/lib/equity/evaluator.js";
import { LESSONS } from "../../frontend/src/lib/learn/course.js";
import { lessonPotType, lessonSpots, MASTERY_MIN_DECISIONS, masteryFrom, masterySide, passDay } from "../../frontend/src/lib/learn/mastery.js";
import { CLASS_COMBOS, COMBO_CLASS, comboHi, comboLo, rangesAt } from "../../frontend/src/lib/solver/index.js";
import { heroNode } from "../../frontend/src/lib/training/flop.js";
import { runTrainingJob, trainingChartSets } from "../../frontend/src/lib/training/jobs.js";
import {
  cellTarget,
  chartCells,
  firstInNode,
  generatePaint,
  gradePaint,
  nodeCells,
  PAINT_IN,
  PAINT_OUT,
  PAINT_PASS,
  paintable,
  railPainting,
  type PaintCell,
} from "../../frontend/src/lib/training/paint.js";
import { generateRiverSpot, riverSetup } from "../../frontend/src/lib/training/river.js";
import { seeded } from "../../frontend/src/lib/training/rng.js";
import { generateSplit, gradeSplit, OVERBET_MIN, SMALL_MAX } from "../../frontend/src/lib/training/split.js";
import { turnSetup } from "../../frontend/src/lib/training/turn.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);

/* ---------------------------------------------------------- river setup - */

describe("the river setup (L3)", () => {
  it("draws from the seed as the river spot does: the spot is dealt on the setup's board and line", () => {
    for (const seed of [3, 77, 1234]) {
      const spot = generateRiverSpot(CHARTS, { pot: "srp" }, seed);
      const setup = riverSetup(CHARTS, { pot: "srp" }, seeded(seed), seed);
      expect(spot).not.toBeNull();
      expect(setup).not.toBeNull();
      // The spot's first attempt is the setup's (a seed whose first attempt fails retries on the same stream).
      if (spot && setup && spot.board.join() === setup.board.join()) {
        expect(spot.lineId).toBe(setup.line.id);
        expect(spot.hero).toBe(setup.hero);
        expect(spot.potBb).toBeGreaterThan(0);
      }
    }
  }, 60_000);
});

/* --------------------------------------------------------- river split - */

describe("the range split on the river (L3)", () => {
  it("reads the river node by riverCategory, recomputed from the solve, with the overbet as its own group", () => {
    const options = { street: "river" as const, pot: "srp" as const, seat: "ip" as const, role: "any" as const, facing: "check" as const };
    const item = generateSplit(CHARTS, null, options, 41);
    expect(item).not.toBeNull();
    if (!item) return;
    expect(generateSplit(CHARTS, null, options, 41)).toEqual(item);
    expect(item.street).toBe("river");
    expect(item.source).toBe("river-solve");
    expect(item.board).toHaveLength(5);
    expect(item.groups[0]).toBe("check");
    expect(item.groups).toEqual(expect.arrayContaining(["small", "big"]));
    expect(item.before.map((b) => [b.who, b.kind])).toEqual([["villain", "check"]]);
    for (const row of item.rows) expect(row.freq.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);

    // Recomputed: the same setup and walk, every combo by its river category.
    const rng = seeded(41);
    const setup = riverSetup(CHARTS, { pot: "srp", seat: "ip", role: "any" }, rng, 41)!;
    const walked = heroNode(setup.solve.result, setup.solve.hero, "check", rng, "river")!;
    const result = setup.solve.result;
    const at = result.nodes[walked.node];
    const reach = rangesAt(result, walked.node)[1];
    const n = result.hands[1].length;
    const board = setup.board.map(cardIndex);
    const groupOf = (a: number) => {
      const action = at.actions[a];
      if (action.kind === "check") return "check";
      if (action.kind === "bet" && action.sizePot <= SMALL_MAX + 1e-9) return "small";
      return action.sizePot > OVERBET_MIN + 1e-9 ? "overbet" : "big";
    };
    expect([...new Set(at.actions.map((_, a) => groupOf(a)))].sort()).toEqual([...item.groups].sort());
    for (const row of item.rows) {
      let w = 0;
      let checks = 0;
      for (let i = 0; i < n; i += 1) {
        const combo = result.hands[1][i];
        if (!(reach[i] > 0) || riverCategory([comboHi(combo), comboLo(combo)], board) !== row.key) continue;
        w += reach[i];
        checks += reach[i] * at.strategy[at.actions.findIndex((x) => x.kind === "check") * n + i];
      }
      expect(row.combos).toBeCloseTo(w, 1);
      expect(row.freq[item.groups.indexOf("check")]).toBeCloseTo(checks / w, 3);
    }
    const best = item.rows.map((row) => row.freq.indexOf(Math.max(...row.freq)));
    expect(gradeSplit(item, best).passed).toBe(true);
  }, 60_000);

  it("splits fold / call / raise against a bet from either seat, and reaches a raise through the hero's own bet", () => {
    const vsBet = generateSplit(CHARTS, null, { street: "river", pot: "srp", seat: "oop", role: "any", facing: "bet" }, 8);
    expect(vsBet?.groups).toEqual(["fold", "call", "raise"]);
    expect(vsBet?.before.map((b) => b.who)).toEqual(["hero", "villain"]);
    const vsRaise = generateSplit(CHARTS, null, { street: "river", pot: "srp", role: "any", seat: "any", facing: "raise" }, 9);
    expect(vsRaise).not.toBeNull();
    expect(vsRaise!.toCallBb).toBeGreaterThan(0);
    const [mine, theirs] = vsRaise!.before.slice(-2);
    expect(mine.who).toBe("hero");
    expect(["bet", "allin"]).toContain(mine.kind);
    expect(theirs.who).toBe("villain");
    expect(["raise", "allin"]).toContain(theirs.kind);
  }, 60_000);
});

/* ------------------------------------------------------ the flop filter - */

describe("turns after a checked flop or a called bet (L3)", () => {
  it("plays the flop line the filter asks for", () => {
    const checked = turnSetup(CHARTS, { pot: "srp", seat: "ip", role: "pfr", flop: "checked" }, seeded(5), 5);
    expect(checked).not.toBeNull();
    expect(checked!.toTurn.flop!.map((a) => a.type)).toEqual(["check", "check"]);
    const bet = turnSetup(CHARTS, { pot: "srp", seat: "ip", role: "pfr", flop: "bet" }, seeded(6), 6);
    expect(bet).not.toBeNull();
    expect(bet!.toTurn.flop!.map((a) => a.type)).toContain("bet");
    expect(bet!.toTurn.flop!.at(-1)!.type).toBe("call");
  }, 60_000);
});

/* ---------------------------------------------------------- the paint - */

describe("the range paint's grader (L3)", () => {
  const cell = (f: number, w = 4): PaintCell => ({ f, w });

  it("asks for a cell by the tolerance: at least 75% painted, at most 25% empty, anything between either way", () => {
    expect([PAINT_IN, PAINT_OUT, PAINT_PASS]).toEqual([0.75, 0.25, 0.8]);
    expect(cellTarget(0.75)).toBe("in");
    expect(cellTarget(0.7499)).toBe("mixed");
    expect(cellTarget(0.25)).toBe("out");
    expect(cellTarget(0.2501)).toBe("mixed");
  });

  it("scores the weight that matters: cells to paint, and cells painted", () => {
    const cells: PaintCell[] = [cell(1, 6), cell(0.9, 4), cell(0.5, 12), cell(0, 12), cell(0.1, 4), null];
    // Rail's own painting: everything at or above a half.
    expect(railPainting(cells)).toEqual([true, true, true, false, false, false]);
    expect(gradePaint(cells, railPainting(cells))).toMatchObject({ right: 22, considered: 22, score: 1, passed: true, missed: 0, extra: 0 });
    // Nothing painted: both "in" cells missed, the mixed and "out" ones do not matter.
    expect(gradePaint(cells, [])).toMatchObject({ right: 0, considered: 10, score: 0, passed: false, missed: 2, extra: 0 });
    // The pair missed (6 of 10), one extra 12-combo cell painted.
    const g = gradePaint(cells, [false, true, false, true, false, true]);
    expect(g.cells).toEqual(["missed", "right", null, "extra", null, null]);
    expect(g).toMatchObject({ right: 4, considered: 22, missed: 1, extra: 1, passed: false });
    expect(g.score).toBeCloseTo(4 / 22, 4);
    // A mixed cell painted counts as right; at 80% of the weight the item passes.
    const h = gradePaint([cell(1, 8), cell(0.5, 4), cell(1, 2)], [true, true, false]);
    expect(h.score).toBeCloseTo(12 / 14, 4);
    expect(h.passed).toBe(true);
  });

  it("deals only items that ask for something on both sides", () => {
    expect(paintable([cell(1, 10), cell(0, 10)])).toBe(true);
    expect(paintable([cell(1, 10), cell(0.5, 10)])).toBe(false);
    expect(paintable([null, null])).toBe(false);
  });
});

describe("the range paint's items (L3)", () => {
  it("paints a seat's first-in range from the chart: the share it plays, by class combos", () => {
    const item = generatePaint(CHARTS, { source: "chart", seat: "CO" }, 7);
    expect(item).not.toBeNull();
    if (!item) return;
    expect(generatePaint(CHARTS, { source: "chart", seat: "CO" }, 7)).toEqual(item);
    expect(item).toMatchObject({ source: "chart", ask: "open", hero: "CO", set: CHARTS.id });
    const node = firstInNode(CHARTS, "CO")!;
    expect(node.actor).toBe("CO");
    expect(node.line).toMatch(/^f*$/);
    const fold = node.options.findIndex((o) => o.action === "fold");
    item.cells.forEach((c, k) => {
      expect(c!.w).toBe(CLASS_COMBOS[k]);
      expect(c!.f).toBeCloseTo(1 - node.freq[fold * 169 + k], 3);
    });
    expect(chartCells(node)).toEqual(item.cells);
    // Aces are opened from every seat; seven-deuce offsuit from none of these.
    expect(cellTarget(item.cells[0]!.f)).toBe("in");
    expect(cellTarget(item.cells[12 * 13 + 7]!.f)).toBe("out");
    expect(gradePaint(item.cells, railPainting(item.cells)).passed).toBe(true);
    // The whole job, through the worker's runner, and the set it loads.
    const job = runTrainingJob({ type: "paint", jobId: 1, options: { source: "chart", seat: "CO" }, seed: 7 }, CHARTS);
    expect(job).toEqual({ type: "paint", jobId: 1, item });
    expect(trainingChartSets({ type: "paint", jobId: 1, options: { source: "chart", set: "nlhe-cash-9max-100bb" }, seed: 1 })).toEqual(["nlhe-cash-9max-100bb"]);
  });

  it("paints the hands that bet at a river node, recomputed from the solve", () => {
    const item = generatePaint(CHARTS, { source: "river", pot: "srp", seat: "ip", role: "any", facing: "check" }, 21);
    expect(item).not.toBeNull();
    if (!item) return;
    expect(item).toMatchObject({ source: "river", ask: "bet", seat: "ip" });
    expect(item.facing?.kind).toBe("check");
    const rng = seeded(21);
    const setup = riverSetup(CHARTS, { pot: "srp", seat: "ip", role: "any" }, rng, 21)!;
    const walked = heroNode(setup.solve.result, setup.solve.hero, "check", rng, "river")!;
    expect(nodeCells(setup.solve.result, walked.node)).toEqual(item.cells);
    // By hand: one class's bet share over its reach-weighted combos.
    const result = setup.solve.result;
    const at = result.nodes[walked.node];
    const reach = rangesAt(result, walked.node)[1];
    const n = result.hands[1].length;
    const k = item.cells.findIndex((c) => c !== null && c.w > 1);
    let w = 0;
    let bets = 0;
    for (let i = 0; i < n; i += 1) {
      if (COMBO_CLASS[result.hands[1][i]] !== k || !(reach[i] > 0)) continue;
      w += reach[i];
      for (let a = 0; a < at.actions.length; a += 1) if (at.actions[a].kind !== "check") bets += reach[i] * at.strategy[a * n + i];
    }
    expect(item.cells[k]!.w).toBeCloseTo(w, 1);
    expect(item.cells[k]!.f).toBeCloseTo(bets / w, 3);
    expect(gradePaint(item.cells, railPainting(item.cells)).passed).toBe(true);
    expect(gradePaint(item.cells, []).passed).toBe(false);
  }, 60_000);

  it("paints the hands that continue against a river bet", () => {
    const item = generatePaint(CHARTS, { source: "river", pot: "srp", seat: "any", role: "any", facing: "bet" }, 22);
    expect(item?.ask).toBe("continue");
    expect(item?.facing?.kind === "bet" || item?.facing?.kind === "allin").toBe(true);
  }, 60_000);
});

/* ------------------------------------------------------------- mastery - */

describe("mastery from real-hand improvement (L3)", () => {
  const row = (scenario: string, decisions: number, evLossBb: number, mistakes: number, mean: number, street = "river"): SpotRow => ({
    key: `${street}:${scenario}:${decisions}:${mean}`,
    street,
    scenario,
    line: "",
    position: "BTN",
    taken: "call",
    best: "call",
    decisions,
    hands: decisions,
    nonPerfect: mistakes,
    mistakes,
    evLossBb,
    evLossPot: evLossBb / 20,
    scoreSum: mean * decisions,
    // A spread of 10 points around the mean.
    scoreSq: decisions * (mean * mean + 100),
  });
  const meta = LESSONS["bluff-catching"];

  it("measures a lesson by its leak spots and its own-hands spots, without repeats", () => {
    const spots = lessonSpots(meta);
    expect(spots.length).toBeGreaterThan(0);
    expect(new Set(spots.map((s) => JSON.stringify(s))).size).toBe(spots.length);
    expect(lessonPotType(LESSONS["3bp-river"])).toBe("3bet");
    expect(lessonSpots(LESSONS["3bp-river"]).length).toBeGreaterThan(0);
    expect(passDay("2026-10-08T15:30:00Z")).toBe("2026-10-08");
    expect(passDay("not a date")).toBeNull();
  });

  it("sums only the rows in the lesson's spots", () => {
    const side = masterySide([row("caller-ip-vs-bet", 10, 5, 4, 80), row("pfr-ip-first", 50, 30, 20, 50, "flop")], lessonSpots(meta));
    expect(side).toMatchObject({ decisions: 10, evLossBb: 5, perDecisionBb: 0.5, mistakes: 4, mistakeRate: 0.4, score: 80 });
    expect(side.perDecisionPot).toBeCloseTo(0.025, 5);
    expect(masterySide([], lessonSpots(meta))).toMatchObject({ decisions: 0, perDecisionBb: null, score: null });
  });

  it("says better when the mean score rose by more than the noise, and not enough hands below the minimum", () => {
    const before = [row("caller-ip-vs-bet", 40, 20, 16, 70)];
    const after = [row("caller-ip-vs-bet", 40, 6, 4, 80)];
    const m = masteryFrom(meta, before, after, "2026-10-08");
    expect(m.enough).toBe(true);
    expect(m.trend).toBe("better");
    expect(m.z!).toBeGreaterThan(1.96);
    expect(m.before.perDecisionBb).toBe(0.5);
    expect(m.after.perDecisionBb).toBe(0.15);
    expect(masteryFrom(meta, after, before, "2026-10-08").trend).toBe("worse");
    expect(masteryFrom(meta, before, before, "2026-10-08").trend).toBe("steady");
    const thin = masteryFrom(meta, before, [row("caller-ip-vs-bet", MASTERY_MIN_DECISIONS - 1, 1, 0, 95)], "2026-10-08");
    expect(thin.enough).toBe(false);
    expect(thin.trend).toBe("too-few");
  });
});
