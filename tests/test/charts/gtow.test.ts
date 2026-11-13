/**
 * The chart sets since `charts/11`: GTO Wizard preflop solutions,
 * transcribed (`tests/scripts/preflop-charts/gtow.test.ts`), the only sets
 * `CHART_SETS` lists. Each loads, says where it comes from, has frequencies
 * summing to one and its blinds, ante and straddle in the pot; the registry
 * holds only planned ids, one kind per set. A hand reads a set of its own
 * kind - an ante from every seat an ante set of that ante, none a classic
 * set, a big-blind ante nothing - and the lookup walks the set's own nodes
 * (no Rail tree), mapping a real raise onto the nearest size. The Solver's
 * bar lays the line out a card per decision.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { preflopState } from "../../../web/src/components/solver/preflop.js";
import { analyzeHand, FLOP_LIBRARY_SETS, flopLinesFor, PUBLISHED_FLOP_LIBRARY } from "../../../web/src/lib/analysis/index.js";
import {
  anteMismatch,
  anteOf,
  CHART_SETS,
  chartLibrary,
  chartSetKind,
  DEFAULT_CHART_SET,
  GTOW_CHARTS_VERSION,
  hasRailTree,
  lookupPreflop,
  pickChartSet,
  PLANNED_CHART_SETS,
  preflopSpotFromHand,
  requiredChartSets,
  type PreflopSpot,
} from "../../../web/src/lib/charts/index.js";
import { convertAny } from "../../../web/src/lib/parsers/index.js";
import { chartSet } from "./support";

const ANTE_SET = "nlhe-cash-6max-100bb-ante";
const SIX = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;

/** A 6-handed spot: the hero first in after `actions`, 100bb deep, the ante as given. */
const spot = (hero: (typeof SIX)[number], extra: Partial<PreflopSpot> = {}): PreflopSpot => ({
  positions: SIX,
  hero,
  actions: SIX.slice(0, SIX.indexOf(hero)).map((position) => ({ position, type: "fold" as const })),
  ...extra,
});
const anted = (hero: (typeof SIX)[number], anteBb = 0.16, extra: Partial<PreflopSpot> = {}) => spot(hero, { ante: true, anteBb, ...extra });

describe.each(CHART_SETS.map((s) => s.id))("the transcribed set %s", (id) => {
  const set = chartSet(id);
  const spec = CHART_SETS.find((s) => s.id === id)!;

  it("is a GTO Wizard transcription of a planned set, without a Rail tree", () => {
    expect(PLANNED_CHART_SETS).toContain(id);
    expect(set.version).toBe(GTOW_CHARTS_VERSION);
    expect(String(set.model.source)).toMatch(/GTO Wizard/);
    expect(set.model.gametype).toEqual(expect.any(String));
    expect(hasRailTree(set)).toBe(false);
    expect(set.game.ante ?? 0).toBeCloseTo(spec.ante ?? 0, 6);
    expect(Boolean(set.game.straddle)).toBe(Boolean(spec.straddle));
    expect(set.game.players).toBe(spec.players);
    // The registry's depth is before the ante, the set's the stack at the start of the hand.
    expect(set.game.stackBb - (set.game.ante ?? 0)).toBeCloseTo(spec.stackBb, 6);
  });

  it("starts with the blinds, the ante and the straddle in", () => {
    const root = preflopState(set, "", flopLinesFor(set.game.players));
    const ante = set.game.ante ?? 0;
    const blinds = set.game.straddle ? 1.5 + set.game.straddle.bb : 1.5;
    expect(root.potBb).toBeCloseTo(blinds + ante * set.game.players, 3);
    expect(root.node?.potBb).toBeCloseTo(root.potBb, 2);
    expect(root.node?.actor).toBe(set.game.positions[0]);
  });

  it("has frequencies summing to one at every node", () => {
    for (const node of set.nodes.values()) {
      const k = node.options.length;
      for (let c = 0; c < 169; c += 1) {
        let sum = 0;
        for (let a = 0; a < k; a += 1) sum += node.freq[a * 169 + c];
        expect(sum).toBeCloseTo(1, 6);
      }
    }
  });
});

describe("the registry since charts/11", () => {
  it("lists only transcribed sets, each a planned id of one kind, and opens on one of them", () => {
    const ids = CHART_SETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of CHART_SETS) {
      expect(PLANNED_CHART_SETS).toContain(spec.id);
      const kind = chartSetKind(spec);
      expect(spec.id.endsWith("-straddle")).toBe(kind === "straddle");
      expect(spec.id.endsWith("-ante")).toBe(kind === "ante");
    }
    expect(ids).toContain(DEFAULT_CHART_SET);
    expect(PLANNED_CHART_SETS).toHaveLength(20);
  });

  it("reads no flop library: none is solved on these ranges yet", () => {
    expect(PUBLISHED_FLOP_LIBRARY).toEqual([]);
    expect(FLOP_LIBRARY_SETS).toEqual([]);
  });
});

describe("which kind of set a hand reads", () => {
  it("reads an ante from every seat on the ante set of that ante, within 25%", () => {
    for (const ante of [0.16, 0.166, 0.18, 0.13, 0.2]) {
      expect(pickChartSet(CHART_SETS, anted("CO", ante)), String(ante)).toMatchObject({ ok: true, spec: { id: ANTE_SET } });
    }
    expect(pickChartSet(CHART_SETS, anted("CO", 0.33))).toMatchObject({ ok: false, reason: "ante" });
    expect(pickChartSet(CHART_SETS, anted("CO", 0.1))).toMatchObject({ ok: false, reason: "ante" });
  });

  it("never reads a hand on a set of another kind", () => {
    // A big-blind ante (or uneven antes): no every-seat ante to match.
    expect(pickChartSet(CHART_SETS, spot("CO", { ante: true }))).toMatchObject({ ok: false, reason: "ante" });
    // No ante: a classic set, or none - never the ante set.
    const plain = pickChartSet(CHART_SETS, spot("CO"));
    if (plain.ok) expect(plain.spec.ante ?? 0).toBe(0);
    expect(anteMismatch(0.166, spot("CO"))).toMatch(/has none/);
    expect(anteMismatch(null, anted("CO"))).toMatch(/this set has none/);
    // The ante set read alone refuses an unanted hand, and a classic reading the other way round.
    expect(lookupPreflop(chartSet(ANTE_SET), spot("CO"), "AA")).toMatchObject({ ok: false, reason: "ante" });
    const library = chartLibrary([chartSet(ANTE_SET)]);
    expect(lookupPreflop(library, spot("CO", { ante: true }), "AA")).toMatchObject({ ok: false, reason: "ante" });
  });

  it("gives a stack no ante set covers no chart", () => {
    const deep = anted("CO", 0.16, { stacksBb: Object.fromEntries(SIX.map((p) => [p, 300])) });
    expect(pickChartSet(CHART_SETS, deep)).toMatchObject({ ok: false, reason: "stack-depth" });
  });
});

describe("a WePlay hand with antes", () => {
  it("posts its ante from every seat dealt in, and reads the ante set", async () => {
    // `ghost-ante.txt` without its ghost: an ante from a player not seated is refused by the parser.
    const text = readFileSync(join(import.meta.dirname, "../fixtures/weplay/ghost-ante.txt"), "utf8")
      .replace(/^Georg14: posts the ante .*\n/m, "")
      .replaceAll("$9.80", "$9.64");
    const { hands } = await convertAny(text, { sourceFilename: "ante.txt", cashOnly: true, skipBombPots: true });
    expect(hands).toHaveLength(1);
    const hand = hands[0];
    const found = preflopSpotFromHand(hand, 0);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // $0.16 at $1: about a sixth of a blind.
    expect(found.spot.ante).toBe(true);
    expect(found.spot.anteBb).toBeCloseTo(0.16, 6);
    expect(requiredChartSets(hand)).toEqual([ANTE_SET]);
    const position = new Map(hand.players.filter((p) => p.position).map((p) => [p.seat, p.position!] as const));
    expect(anteOf(hand, position, hand.game.bigBlind).anteBb).toBeCloseTo(0.16, 6);
    // Graded on the ante set, without the hand-level antes approximation.
    const analysis = analyzeHand(structuredClone(hand), { charts: chartLibrary([chartSet(ANTE_SET)]) });
    const graded = analysis.decisions.filter((d) => d.street === "preflop" && d.source === "chart");
    expect(graded.length).toBeGreaterThan(0);
    for (const d of graded) expect(d.facts.chart?.set).toBe(ANTE_SET);
    expect(analysis.approximations).not.toContain("antes");
    // Only one seat's ante: a big-blind ante.
    const one = { ...hand, actions: hand.actions.filter((a) => a.type !== "ante" || a.seat === hand.players[0].seat) };
    expect(anteOf(one, position, hand.game.bigBlind)).toEqual({ ante: true });
  });
});

describe("the lookup on a transcribed set", () => {
  const library = chartLibrary([chartSet(ANTE_SET)]);

  it("answers an open from the set's own root, and a 3-bet spot after a real open", () => {
    const open = lookupPreflop(library, anted("UTG"), "AA", { position: "UTG", type: "raise", toBb: 2.5 });
    expect(open).toMatchObject({ ok: true, chosen: 1, approximations: [] });
    if (!open.ok) return;
    expect(open.node.line).toBe("");
    expect(open.options.find((o) => o.action === "raise")?.freq).toBeGreaterThan(0.9);
    // A real 3bb open is the set's 2.5bb, with a sizing note; the HJ answers at "r".
    const vs = lookupPreflop(library, anted("HJ", 0.16, { actions: [{ position: "UTG", type: "raise", toBb: 3 }] }), "KK");
    expect(vs).toMatchObject({ ok: true, node: { line: "r", actor: "HJ", scenario: "vs-open" } });
    if (!vs.ok) return;
    expect(vs.approximations).toEqual([expect.objectContaining({ kind: "sizing", realBb: 3, chartBb: 2.5, offTree: false })]);
  });

  it("reads short-handed tables with the earliest seats folded", () => {
    const four = { positions: ["CO", "BTN", "SB", "BB"] as const, hero: "CO" as const, actions: [], ante: true, anteBb: 0.16 };
    const found = lookupPreflop(library, four, "AKs");
    expect(found).toMatchObject({ ok: true, node: { line: "ff", actor: "CO" } });
  });

  it("refuses a cold call the set has no call for, and a limp", () => {
    const set = chartSet(ANTE_SET);
    // The ante set has no cold calls: the HJ facing an open has no call.
    expect(set.nodes.get("r")!.options.some((o) => o.action === "call")).toBe(false);
    const coldCall = lookupPreflop(
      library,
      anted("CO", 0.16, { actions: [{ position: "UTG", type: "raise", toBb: 2.5 }, { position: "HJ", type: "call", toBb: 2.5 }] }),
      "AA",
    );
    expect(coldCall.ok).toBe(false);
    const limp = lookupPreflop(library, anted("HJ", 0.16, { actions: [{ position: "UTG", type: "call", toBb: 1 }] }), "AA");
    expect(limp).toMatchObject({ ok: false, reason: "limp" });
    // The hero's own limp is not modelled; the node says a limp was cut.
    const own = lookupPreflop(library, anted("UTG"), "AA", { position: "UTG", type: "call", toBb: 1 });
    expect(own).toMatchObject({ ok: false, reason: "action-not-modelled" });
    const root = lookupPreflop(library, anted("UTG"), "AA");
    expect(root).toMatchObject({ ok: true, unmodelled: ["limp"] });
  });
});

describe("the Solver's bar on the ante set", () => {
  const set = chartSet(ANTE_SET);
  const lines = flopLinesFor(6);

  it("posts the ante as dead money", () => {
    const root = preflopState(set, "", lines);
    expect(root.potBb).toBeCloseTo(2.496, 3);
    expect(root.seats.find((s) => s.position === "UTG")?.stackBb).toBeCloseTo(100, 6);
    expect(root.seats.find((s) => s.position === "BB")?.stackBb).toBeCloseTo(99, 6);
  });

  it("lays the bar out a card per decision, a seat acting twice getting two", () => {
    const state = preflopState(set, "fffrfr", lines);
    expect(state.cards.map((c) => `${c.kind}:${c.node.actor}`)).toEqual([
      "past:UTG",
      "past:HJ",
      "past:CO",
      "past:BTN",
      "past:SB",
      "past:BB",
      "current:BTN",
    ]);
    expect(state.cards.filter((c) => c.kind === "past").map((c) => c.chosen).join("")).toBe("fffrfr");
    expect(state.cards[6].stackBb).toBeCloseTo(97.5, 6);
    // At the start, the later seats' decisions if everyone before them folds.
    const root = preflopState(set, "", lines);
    expect(root.cards.map((c) => `${c.kind}:${c.node.actor}:${c.line}`)).toEqual([
      "current:UTG:",
      "ahead:HJ:f",
      "ahead:CO:ff",
      "ahead:BTN:fff",
      "ahead:SB:ffff",
    ]);
  });
});
