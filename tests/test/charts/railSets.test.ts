/**
 * Rail's own draft sets (`lib/charts/railSets.ts`, `charts/12-draft`,
 * docs/PREFLOP-PLAN.md §2): the 11 approved specs, the depth bands and the
 * picking rule (pure, not wired in), that nothing that ships changes, the
 * ante as dead money in the generator's tree, and the v0 runner's pieces
 * (`tests/scripts/preflop-v0/`): its working-hours guard and a small solve
 * end to end with its totals.
 */

import { describe, expect, it } from "vitest";

import { CHART_SETS, PLANNED_CHART_SETS } from "../../../web/src/lib/charts/registry.js";
import {
  inBand,
  pickRailSet,
  RAIL_ANTE_BB,
  RAIL_CHARTS_DRAFT_VERSION,
  RAIL_SETS,
  railSet,
  railTableFor,
  type RailSetKind,
} from "../../../web/src/lib/charts/railSets.js";
import { loadCharts } from "../../../web/src/lib/charts/format.js";
import { STANDARD_RAKE } from "../../../web/src/lib/solver/preflopModel.js";
import { preflopEquityTable } from "../../../web/src/lib/solver/preflopEquity.js";
import { buildPreflopTree, potAt, type PreflopTree } from "../../../web/src/lib/solver/preflopTree.js";
import { inWorkingHours, workingHoursConflict } from "../../scripts/preflop-v0/guard.js";
import { solveV0Set, V0_FIT_FROM, v0Fit, v0Tree } from "../../scripts/preflop-v0/solve.js";

const ids = RAIL_SETS.map((s) => s.id);

/** The edge sizes out of an action node, by code. */
function edges(tree: PreflopTree, line: string): Record<string, number> {
  const node = tree.lineIndex.get(line);
  if (node === undefined) throw new Error(`no node ${line}`);
  const out: Record<string, number> = {};
  for (let e = tree.childStart[node]; e < tree.childStart[node] + tree.childCount[node]; e += 1) {
    out[tree.edgeCode[e]] = tree.edgeTo[e];
  }
  return out;
}

describe("Rail draft sets (charts/12-draft)", () => {
  it("are the 11 approved sets, with ids no transcribed set can have", () => {
    expect(ids).toEqual([
      "rail-hu-100bb",
      "rail-hu-150bb",
      "rail-6max-50bb",
      "rail-6max-100bb",
      "rail-6max-150bb",
      "rail-6max-200bb",
      "rail-6max-100bb-ante",
      "rail-9max-100bb",
      "rail-9max-150bb",
      "rail-9max-100bb-ante",
      "rail-6max-100bb-straddle",
    ]);
    expect(new Set(ids).size).toBe(11);
    const shipped = new Set([...PLANNED_CHART_SETS, ...CHART_SETS.map((s) => s.id)]);
    for (const id of ids) expect(shipped.has(id)).toBe(false);
    for (const id of shipped) expect(id.startsWith("rail-")).toBe(false);
    expect(railSet("rail-6max-100bb").stackBb).toBe(100);
    expect(() => railSet("nlhe-cash-6max-100bb")).toThrow(/no Rail set/);
  });

  it("leave what ships alone: the library still lists only transcribed sets", () => {
    expect(CHART_SETS.map((s) => s.id)).toEqual(["nlhe-cash-6max-100bb", "nlhe-cash-6max-100bb-ante"]);
  });

  it("fix rake, sizes and limps per format", () => {
    for (const spec of RAIL_SETS) {
      expect(spec.version).toBe(RAIL_CHARTS_DRAFT_VERSION);
      expect(spec.rake).toEqual({ name: "5%-cap3bb-nfnd", percent: 0.05, capBb: 3, noFlopNoDrop: true });
      expect(spec.rake).toBe(STANDARD_RAKE);
      expect(spec.maxLimpers).toBe(0);
      expect(spec.maxEntrants).toBe(4);
      expect(spec.sizing.allInAbove).toBe(0.4);
      expect([spec.sizing.threeBetIp, spec.sizing.threeBetOop, spec.sizing.fourBetIp, spec.sizing.fourBetOop]).toEqual([3, 4, 2.2, 2.5]);
      expect(spec.seats.length).toBe(spec.table);
      expect(spec.headsUp).toBe(spec.table === 2);
      expect(spec.ante).toBe(spec.kind === "ante" ? RAIL_ANTE_BB : 0);
      expect(spec.straddle).toEqual(spec.kind === "straddle" ? { position: "UTG", bb: 2 } : null);
      const [open, sb] =
        spec.kind === "straddle" ? [5, 6] : spec.table === 2 ? [2.5, 2.5] : [2.5, 3];
      expect([spec.sizing.open, spec.sizing.sbOpen]).toEqual([open, sb]);
      expect(inBand(spec.band, spec.stackBb)).toBe(true);
    }
    const kinds = (k: RailSetKind) => RAIL_SETS.filter((s) => s.kind === k).map((s) => s.id);
    expect(kinds("ante")).toEqual(["rail-6max-100bb-ante", "rail-9max-100bb-ante"]);
    expect(kinds("straddle")).toEqual(["rail-6max-100bb-straddle"]);
  });

  it("have depth bands that tile every stack, per kind and table", () => {
    const groups = new Map<string, typeof RAIL_SETS>();
    for (const s of RAIL_SETS) groups.set(`${s.kind}/${s.table}`, [...(groups.get(`${s.kind}/${s.table}`) ?? []), s]);
    expect([...groups.keys()].sort()).toEqual(["ante/6", "ante/9", "classic/2", "classic/6", "classic/9", "straddle/6"]);
    for (const sets of groups.values()) {
      const sorted = [...sets].sort((a, b) => a.stackBb - b.stackBb);
      expect(sorted[0].band.minBb).toBeNull();
      expect(sorted[sorted.length - 1].band.maxBb).toBeNull();
      for (let k = 1; k < sorted.length; k += 1) expect(sorted[k].band.minBb).toBe(sorted[k - 1].band.maxBb);
    }
  });

  it("build the trees their specs describe", () => {
    const six = v0Tree(railSet("rail-6max-100bb"));
    expect(six.actionNodes).toBe(3825); // the charts/3 6-max tree (docs/CHARTS.md §1.2)
    expect(edges(six, "")).toEqual({ f: 0, r: 2.5 }); // no open limps
    expect(edges(six, "ffff")).toEqual({ f: 0.5, c: 1, r: 3 }); // the small blind completes or raises 3bb
    expect(edges(six, "ffr")).toEqual({ f: 0, c: 2.5, r: 7.5 }); // cold call kept; 3-bet 3x in position
    expect(edges(six, "fffrf")).toEqual({ f: 1, c: 2.5, r: 10 }); // the big blind 3-bets 4x
    expect(edges(six, "fffrfr")).toEqual({ f: 2.5, c: 10, r: 22 }); // the button 4-bets 2.2x in position
    expect(edges(six, "ffrrff")).toEqual({ f: 2.5, c: 7.5, r: 19 }); // the cutoff 4-bets 2.5x out of position
    const fifty = v0Tree(railSet("rail-6max-50bb"));
    expect(edges(fifty, "fffrfr")).toEqual({ f: 2.5, c: 10, a: 50 }); // past 40% of 50bb: all-in
    const hu = v0Tree(railSet("rail-hu-100bb"));
    expect(hu.actionNodes).toBe(10);
    expect(edges(hu, "")).toEqual({ f: 0.5, c: 1, r: 2.5 });
    const straddle = v0Tree(railSet("rail-6max-100bb-straddle"));
    expect(straddle.players).toEqual(["HJ", "CO", "BTN", "SB", "BB", "UTG"]);
    expect(edges(straddle, "")).toEqual({ f: 0, r: 5 });
    const nine = v0Tree(railSet("rail-9max-150bb"));
    expect(nine.actionNodes).toBe(28591);
  });
});

describe("pickRailSet: kind, table, depth band", () => {
  const pick = (kind: RailSetKind, players: number, effectiveBb: number) => {
    const p = pickRailSet({ kind, players, effectiveBb });
    return p.ok ? p.spec.id : `refused:${p.reason}`;
  };

  it("reads the table by players dealt in", () => {
    expect(railTableFor(2)).toBe(2);
    expect([3, 4, 5, 6].map(railTableFor)).toEqual([6, 6, 6, 6]);
    expect([7, 8, 9].map(railTableFor)).toEqual([9, 9, 9]);
    expect([0, 1, 10, 2.5].map(railTableFor)).toEqual([null, null, null, null]);
  });

  it("snaps the effective stack by the bands of §2.2", () => {
    expect([20, 74.99, 75, 100, 124.99, 125, 174.99, 175, 400].map((bb) => pick("classic", 6, bb))).toEqual([
      "rail-6max-50bb",
      "rail-6max-50bb",
      "rail-6max-100bb",
      "rail-6max-100bb",
      "rail-6max-100bb",
      "rail-6max-150bb",
      "rail-6max-150bb",
      "rail-6max-200bb",
      "rail-6max-200bb",
    ]);
    expect([40, 124.99, 125, 300].map((bb) => pick("classic", 2, bb))).toEqual([
      "rail-hu-100bb",
      "rail-hu-100bb",
      "rail-hu-150bb",
      "rail-hu-150bb",
    ]);
    expect([60, 124.99, 125, 220].map((bb) => pick("classic", 8, bb))).toEqual([
      "rail-9max-100bb",
      "rail-9max-100bb",
      "rail-9max-150bb",
      "rail-9max-150bb",
    ]);
  });

  it("never crosses kinds: ante and straddle sets answer every depth of their own kind only", () => {
    expect([30, 100, 250].map((bb) => pick("ante", 5, bb))).toEqual(Array(3).fill("rail-6max-100bb-ante"));
    expect([30, 100, 250].map((bb) => pick("ante", 9, bb))).toEqual(Array(3).fill("rail-9max-100bb-ante"));
    expect([40, 100, 200].map((bb) => pick("straddle", 6, bb))).toEqual(Array(3).fill("rail-6max-100bb-straddle"));
    expect(pick("ante", 2, 100)).toBe("refused:ante");
    expect(pick("straddle", 2, 100)).toBe("refused:straddle");
    expect(pick("straddle", 8, 100)).toBe("refused:straddle");
  });

  it("refuses tables and stacks it cannot read", () => {
    expect(pick("classic", 1, 100)).toBe("refused:players");
    expect(pick("classic", 10, 100)).toBe("refused:players");
    expect(pick("classic", 6, 0)).toBe("refused:stack-depth");
    expect(pick("classic", 6, Number.NaN)).toBe("refused:stack-depth");
    // A spec list without a kind's table refuses rather than reading another table.
    expect(pickRailSet({ kind: "classic", players: 9, effectiveBb: 100 }, RAIL_SETS.slice(0, 7)).ok).toBe(false);
  });
});

describe("the ante in the generator's tree", () => {
  it("is dead money: the same betting, a bigger pot", () => {
    const plain = buildPreflopTree({ players: ["SB", "BB"], stackBb: 100, headsUp: true, sizing: { sbOpen: 2.5, isoOop: 0 } });
    const anted = buildPreflopTree({ players: ["SB", "BB"], stackBb: 100, headsUp: true, sizing: { sbOpen: 2.5, isoOop: 0 }, ante: 0.25 });
    expect(plain.ante).toBe(0);
    expect(anted.ante).toBe(0.25);
    expect(anted.line).toEqual(plain.line);
    expect(Array.from(anted.contrib)).toEqual(Array.from(plain.contrib));
    expect(Array.from(anted.edgeTo)).toEqual(Array.from(plain.edgeTo));
    expect(potAt(anted, 0)).toBe(potAt(plain, 0) + 0.5);
    expect(() => buildPreflopTree({ ante: -1 })).toThrow(/ante/);
  });
});

describe("v0 runner", () => {
  it("guards working hours in Europe/Zagreb, summer time included", () => {
    expect(inWorkingHours(new Date("2026-11-19T13:30:00Z"))).toBe(true); // Thu 14:30 CET
    expect(inWorkingHours(new Date("2026-11-19T06:59:00Z"))).toBe(false); // Thu 07:59 CET
    expect(inWorkingHours(new Date("2026-11-19T07:00:00Z"))).toBe(true); // Thu 08:00 CET
    expect(inWorkingHours(new Date("2026-11-19T15:00:00Z"))).toBe(false); // Thu 16:00 CET
    expect(inWorkingHours(new Date("2026-11-21T09:00:00Z"))).toBe(false); // Sat 10:00
    expect(inWorkingHours(new Date("2026-07-06T05:30:00Z"))).toBe(false); // Mon 07:30 CEST
    expect(inWorkingHours(new Date("2026-07-06T06:00:00Z"))).toBe(true); // Mon 08:00 CEST
    expect(inWorkingHours(new Date("2026-07-06T13:59:00Z"))).toBe(true); // Mon 15:59 CEST
    expect(inWorkingHours(new Date("2026-07-06T14:00:00Z"))).toBe(false); // Mon 16:00 CEST
  });

  it("does not start a set that would run into 08:00 on a weekday", () => {
    const thu22 = new Date("2026-11-19T21:00:00Z"); // Thu 22:00 CET
    expect(workingHoursConflict(thu22, 600)).toBeNull(); // ends Fri 08:00 sharp
    expect(workingHoursConflict(thu22, 601)).toMatch(/Fri 08:00/);
    expect(workingHoursConflict(new Date("2026-11-20T21:00:00Z"), 3000)).toBeNull(); // Fri 22:00 into the weekend
    expect(workingHoursConflict(new Date("2026-11-22T22:00:00Z"), 120)).toBeNull(); // Sun 23:00 to Mon 01:00
    expect(workingHoursConflict(new Date("2026-11-22T22:00:00Z"), 600)).toMatch(/Mon 08:00/);
    expect(workingHoursConflict(new Date("2026-11-19T13:30:00Z"), 1)).toMatch(/working hours/);
  });

  it("starts every set from a fit of an old Rail set", () => {
    expect(Object.keys(V0_FIT_FROM).sort()).toEqual([...ids].sort());
    for (const spec of RAIL_SETS) {
      const fit = v0Fit(spec);
      expect(fit.model.potTypes.srp.ipAgg.bias).toBeTypeOf("number");
    }
  });

  it("solves a heads-up ante set end to end, its EVs net of the ante", async () => {
    const equity = preflopEquityTable({ boards: 400, seed: 7 });
    // The heads-up spec with an ante (no such set ships; it keeps the id, so the fit is heads-up 100bb's).
    const spec = { ...railSet("rail-hu-100bb"), ante: 0.25, kind: "ante" as const };
    const solved = await solveV0Set(spec, { equity, iterations: 300 });
    const charts = loadCharts(JSON.parse(solved.text));
    expect(charts.version).toBe("charts/12-draft");
    expect(charts.game.ante).toBe(0.25);
    expect(charts.game.stackBb).toBe(100.25);
    const root = charts.nodes.get("");
    expect(root?.potBb).toBe(2);
    // The small blind folding loses its blind and its ante.
    const fold = root?.options.findIndex((o) => o.action === "fold") ?? -1;
    expect(fold).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 169; i += 1) expect(root?.ev[fold * 169 + i]).toBeCloseTo(-0.75, 2);
    const t = solved.totals;
    expect(Object.keys(t.rfi)).toEqual(["SB"]);
    expect(t.sb).not.toBeNull();
    expect((t.sb?.fold ?? 0) + (t.sb?.limp ?? 0) + (t.sb?.raise ?? 0)).toBeCloseTo(100, 0);
    expect(t.rfi.SB).toBe(t.sb?.raise);
    expect(Object.keys(t.bbDefence)).toEqual(["SB"]);
    expect(t.bbDefence.SB.defend).toBeCloseTo(t.bbDefence.SB.call + t.bbDefence.SB.threeBet, 0);
    expect(t.threeBet.BB).toBe(t.bbDefence.SB.threeBet);
    expect(t.sb?.raise).toBeGreaterThan(40); // the button opens most hands heads-up
  });
});
