/**
 * The chart library (`charts/3`, A2c; `lib/charts/registry.ts`): which set
 * answers a spot, how a smaller table is read on a bigger set, what the
 * lookup records about the choice, and real hands from the corpora - 9-, 8-
 * and 7-handed WePlay tables, deep and short stacks - landing on the right
 * set and node.
 */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeHand } from "../../../frontend/src/lib/analysis/index.js";
import {
  CHART_SETS,
  chartLibrary,
  DEFAULT_CHART_SET,
  effectiveStackBb,
  ensureChartSets,
  isChartLibrary,
  lookupPreflop,
  pickChartSet,
  preflopSpotFromHand,
  requiredChartSets,
  type ChartLookup,
  type ChartSetSpec,
  type PreflopActionInput,
  type PreflopSpot,
} from "../../../frontend/src/lib/charts/index.js";
import { convertAny } from "../../../frontend/src/lib/parsers/index.js";
import { positionRing, type PhfHand, type Position } from "../../../frontend/src/lib/phf/types.js";
import { weplayFiles } from "../support/corpus.js";
import { ggCorpusFiles } from "../support/psggCorpus.js";
import { chartSet, fileOf, fullLibrary } from "./support.js";

const act = (position: Position, type: PreflopActionInput["type"], toBb?: number): PreflopActionInput =>
  toBb === undefined ? { position, type } : { position, type, toBb };

/** A `k`-handed spot, every stack `stack`, folded to `hero` (the preflop action order). */
function table(k: number, hero: Position, stack = 100, extra: Partial<PreflopSpot> = {}): PreflopSpot {
  const ring = positionRing(k);
  const order = [...ring.slice(2), "SB", "BB"] as Position[];
  const actions = order.slice(0, order.indexOf(hero)).map((p) => act(p, "fold"));
  const stacksBb = Object.fromEntries(ring.map((p) => [p, stack]));
  return { positions: ring, hero, actions, stacksBb, ...extra };
}

const pickId = (spot: PreflopSpot) => {
  const pick = pickChartSet(CHART_SETS, spot);
  return pick.ok ? pick.spec.id : pick.reason;
};

function ok(result: ChartLookup) {
  if (!result.ok) throw new Error(`expected a node, got ${result.reason}: ${result.detail}`);
  return result;
}

describe("the registry", () => {
  it("lists every committed set once, 6-max and 9-max, with the default 6-max 100bb", () => {
    const ids = CHART_SETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_CHART_SET);
    for (const spec of CHART_SETS) {
      expect(spec.id).toBe(`nlhe-cash-${spec.players}max-${spec.stackBb}bb`);
      const set = chartSet(spec.id);
      expect(set.id).toBe(spec.id);
      expect(set.game.positions).toHaveLength(spec.players);
      expect(set.game.stackBb).toBe(spec.stackBb);
    }
    expect(CHART_SETS.filter((s) => s.players === 6).map((s) => s.stackBb)).toEqual([40, 60, 100, 150, 200]);
    expect(CHART_SETS.filter((s) => s.players === 9).map((s) => s.stackBb)).toEqual([100, 150, 200]);
  });

  it("reads 3-6 players on a 6-max set and 7-9 on a 9-max set; refuses heads-up and ten", () => {
    expect(pickId(table(6, "CO"))).toBe("nlhe-cash-6max-100bb");
    expect(pickId(table(5, "CO"))).toBe("nlhe-cash-6max-100bb");
    expect(pickId(table(3, "BTN"))).toBe("nlhe-cash-6max-100bb");
    expect(pickId(table(7, "LJ"))).toBe("nlhe-cash-9max-100bb");
    expect(pickId(table(8, "UTG"))).toBe("nlhe-cash-9max-100bb");
    expect(pickId(table(9, "UTG+2"))).toBe("nlhe-cash-9max-100bb");
    expect(pickId(table(2, "SB"))).toBe("players");
    expect(pickId(table(10, "MP"))).toBe("players");
  });

  it("picks the nearest depth within 20%, never interpolating", () => {
    expect(pickId(table(6, "BTN", 119))).toBe("nlhe-cash-6max-100bb");
    expect(pickId(table(6, "BTN", 121))).toBe("nlhe-cash-6max-150bb");
    expect(pickId(table(6, "BTN", 171))).toBe("nlhe-cash-6max-150bb");
    expect(pickId(table(6, "BTN", 172))).toBe("nlhe-cash-6max-200bb");
    expect(pickId(table(6, "BTN", 240))).toBe("nlhe-cash-6max-200bb");
    expect(pickId(table(6, "BTN", 241))).toBe("stack-depth");
    expect(pickId(table(6, "BTN", 47))).toBe("nlhe-cash-6max-40bb");
    expect(pickId(table(6, "BTN", 49))).toBe("nlhe-cash-6max-60bb");
    expect(pickId(table(6, "BTN", 32))).toBe("nlhe-cash-6max-40bb");
    expect(pickId(table(6, "BTN", 31))).toBe("stack-depth");
    // Between 60 and 100 nothing is within 20% of 75.
    expect(pickId(table(6, "BTN", 75))).toBe("stack-depth");
    // 9-max has no short sets.
    expect(pickId(table(8, "CO", 60))).toBe("stack-depth");
    expect(pickId(table(8, "CO", 180))).toBe("nlhe-cash-9max-200bb");
  });

  it("judges depth by the effective stack: the hero against the deepest opponent still in", () => {
    const spot = table(6, "BTN", 100, { stacksBb: { BTN: 300, SB: 90, BB: 150, UTG: 400, HJ: 400, CO: 400 } });
    // UTG, HJ and CO folded: the deepest live opponent has 150.
    expect(effectiveStackBb(spot)).toBe(150);
    expect(pickId(spot)).toBe("nlhe-cash-6max-150bb");
  });
});

describe("lookup through the library", () => {
  const library = fullLibrary();

  it("is a chart set itself: its own fields are the default set's", () => {
    expect(isChartLibrary(library)).toBe(true);
    expect(library.id).toBe(DEFAULT_CHART_SET);
    expect(library.nodes.get("")?.actor).toBe("UTG");
    expect(isChartLibrary(chartSet(DEFAULT_CHART_SET))).toBe(false);
  });

  it("answers a 9-handed spot from the 9-max set, exactly", () => {
    const r = ok(lookupPreflop(library, table(9, "UTG"), "AA"));
    expect(r.set.id).toBe("nlhe-cash-9max-100bb");
    expect(r.node.line).toBe("");
    expect(r.node.actor).toBe("UTG");
    expect(r.approximations).toEqual([]);
    expect(r.options.find((o) => o.action === "raise")?.freq).toBe(1);
  });

  it("reads 8- and 7-handed as 9-max with the earliest seats folded", () => {
    const eight = ok(lookupPreflop(library, table(8, "UTG"), "AKo"));
    expect(eight.set.id).toBe("nlhe-cash-9max-100bb");
    expect(eight.node.line).toBe("f");
    expect(eight.node.actor).toBe("UTG+1");
    expect(eight.approximations).toEqual([
      { kind: "short-handed", detail: "8 players dealt in: read as 9-max with UTG folded" },
    ]);
    const seven = ok(lookupPreflop(library, table(7, "LJ"), "AKo"));
    expect(seven.node.line).toBe("fff");
    expect(seven.node.actor).toBe("LJ");
    expect(seven.approximations[0].detail).toBe("7 players dealt in: read as 9-max with UTG, UTG+1 folded");
  });

  it("answers deep and short stacks from their own depth, and notes the distance", () => {
    const deep = ok(lookupPreflop(library, table(6, "BTN", 150), "A5s"));
    expect(deep.set.id).toBe("nlhe-cash-6max-150bb");
    expect(deep.approximations).toEqual([]);
    const between = ok(lookupPreflop(library, table(6, "BTN", 135), "A5s"));
    expect(between.set.id).toBe("nlhe-cash-6max-150bb");
    expect(between.approximations).toEqual([
      expect.objectContaining({ kind: "stack-depth", set: "nlhe-cash-6max-150bb", realBb: 135, chartBb: 150 }),
    ]);
    const short = ok(lookupPreflop(library, table(6, "CO", 40), "KQo"));
    expect(short.set.id).toBe("nlhe-cash-6max-40bb");
    expect(short.options.find((o) => o.action === "raise")?.sizeBb).toBe(2.2);
    expect(lookupPreflop(library, table(6, "CO", 75), "KQo")).toMatchObject({ ok: false, reason: "stack-depth" });
  });

  it("refuses straddles and heads-up by name, and says when a set is not loaded", () => {
    expect(lookupPreflop(library, table(6, "BTN", 100, { straddle: true }), "AA")).toMatchObject({ ok: false, reason: "straddle" });
    expect(lookupPreflop(library, table(2, "SB"), "AA")).toMatchObject({ ok: false, reason: "players" });
    const partial = chartLibrary([chartSet(DEFAULT_CHART_SET)]);
    expect(lookupPreflop(partial, table(9, "UTG"), "AA")).toMatchObject({ ok: false, reason: "unavailable" });
    expect(lookupPreflop(partial, table(6, "UTG"), "AA").ok).toBe(true);
  });

  it("loads the sets a library lacks on demand", async () => {
    // The app's loaders are dynamic imports of the JSON; these read the same files.
    const specs: ChartSetSpec[] = CHART_SETS.map((spec) => ({
      ...spec,
      load: async () => JSON.parse(readFileSync(fileOf(spec.id), "utf8")),
    }));
    const partial = chartLibrary([chartSet(DEFAULT_CHART_SET)], specs);
    expect(partial.sets.size).toBe(1);
    await ensureChartSets(partial, ["nlhe-cash-9max-100bb", "nlhe-cash-9max-100bb"]);
    expect([...partial.sets.keys()].sort()).toEqual(["nlhe-cash-6max-100bb", "nlhe-cash-9max-100bb"]);
    expect(ok(lookupPreflop(partial, table(9, "UTG"), "AA")).set.id).toBe("nlhe-cash-9max-100bb");
  });
});

describe("real hands from the corpora", () => {
  const library = fullLibrary();
  let weplay: PhfHand[] = [];
  let gg: PhfHand[] = [];
  const parse = async (files: { name: string; text: string }[]) =>
    (
      await Promise.all(
        files.map(async (f) => {
          try {
            return (await convertAny(f.text, { sourceFilename: f.name })).hands;
          } catch {
            return [];
          }
        }),
      )
    ).flat();
  beforeAll(async () => {
    weplay = await parse(weplayFiles());
    gg = await parse(ggCorpusFiles());
  });

  /** Every hero preflop decision: its spot, and the lookup through the library. */
  function decisions(hands: PhfHand[]) {
    const out: { hand: PhfHand; spot: PreflopSpot; lookup: ChartLookup }[] = [];
    for (const hand of hands) {
      for (let nth = 0; nth < 4; nth += 1) {
        const s = preflopSpotFromHand(hand, nth);
        if (!s.ok) break;
        out.push({ hand, spot: s.spot, lookup: lookupPreflop(library, s.spot, s.heroCards, s.heroAction) });
      }
    }
    return out;
  }

  it("puts 8- and 7-handed WePlay decisions on the 9-max sets, at the seat their distance from the button names", () => {
    const all = decisions(weplay);
    const fullRing = all.filter((d) => d.spot.positions.length >= 7 && d.lookup.ok);
    expect(fullRing.length).toBeGreaterThan(500);
    for (const { spot, lookup } of fullRing) {
      if (!lookup.ok) continue;
      expect(lookup.set.game.positions).toHaveLength(9);
      const ring = positionRing(spot.positions.length).slice(2);
      const nine = lookup.set.game.positions.filter((p) => p !== "SB" && p !== "BB");
      const k = ring.indexOf(spot.hero);
      expect(lookup.node.actor).toBe(k < 0 ? spot.hero : nine[nine.length - ring.length + k]);
      if (spot.positions.length < 9) expect(lookup.approximations.map((a) => a.kind)).toContain("short-handed");
    }
  });

  it("covers deep WePlay and GG decisions from the 150 and 200bb sets", () => {
    const deep = [...decisions(weplay), ...decisions(gg)].filter((d) => d.lookup.ok && d.lookup.set.game.stackBb >= 150);
    expect(deep.length).toBeGreaterThan(300);
    for (const { spot, lookup } of deep) {
      if (!lookup.ok) continue;
      const effective = effectiveStackBb(spot);
      expect(Math.abs(effective - lookup.set.game.stackBb) / lookup.set.game.stackBb).toBeLessThanOrEqual(0.2 + 1e-9);
    }
  });

  it("refuses only what no set covers", () => {
    const reasons = new Map<string, number>();
    const all = [...decisions(weplay), ...decisions(gg)];
    for (const { lookup } of all) {
      const key = lookup.ok ? "ok" : lookup.reason;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    expect(reasons.get("unavailable") ?? 0).toBe(0);
    expect(reasons.get("bad-input") ?? 0).toBeLessThanOrEqual(2);
    // Coverage on the corpora (docs/ANALYSIS-PLAN.md §10, A2c): most decisions get a node.
    expect((reasons.get("ok") ?? 0) / all.length).toBeGreaterThan(0.6);
  });

  it("names every set a hand needs, and grades an 8-handed hand from the 9-max set", () => {
    const eightHanded = weplay.find((hand) => {
      const s = preflopSpotFromHand(hand, 0);
      return s.ok && s.spot.positions.length === 8 && !s.spot.straddle && effectiveStackBb(s.spot) > 90 && effectiveStackBb(s.spot) < 110;
    });
    if (!eightHanded) throw new Error("no 8-handed 100bb hand in the WePlay corpus");
    expect(requiredChartSets(eightHanded)).toContain("nlhe-cash-9max-100bb");
    const analysis = analyzeHand(structuredClone(eightHanded), { charts: library });
    const graded = analysis.decisions.filter((d) => d.street === "preflop" && d.source === "chart");
    expect(graded.length).toBeGreaterThan(0);
    for (const d of graded) expect(d.facts.chart?.set).toBe("nlhe-cash-9max-100bb");
  });
});
