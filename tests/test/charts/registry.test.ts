/**
 * The chart library (`lib/charts/registry.ts`, `charts/11`): which set
 * answers a spot - over the owner's whole planned list, by kind (classic,
 * ante, straddle), table and depth - how a smaller table is read on a bigger
 * set, what the lookup records, and real hands from the corpora landing on a
 * set of their own kind or refused by name. Lookups read the transcribed
 * sets and the test fixtures (`support.ts`).
 */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeHand } from "../../../web/src/lib/analysis/index.js";
import { lineSeats } from "../../../web/src/lib/analysis/leaks.js";
import { NINE_TABLE_ORDER, TABLE_ORDER, walkLine } from "../../../web/src/lib/analysis/reports.js";
import {
  CHART_SETS,
  chartLibrary,
  DEFAULT_CHART_SET,
  PLANNED_CHART_SETS,
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
} from "../../../web/src/lib/charts/index.js";
import { convertAny } from "../../../web/src/lib/parsers/index.js";
import { positionRing, type PhfHand, type Position } from "../../../web/src/lib/phf/types.js";
import { weplayFiles } from "../support/corpus.js";
import { ggCorpusFiles } from "../support/psggCorpus.js";
import { chartSet, fileOf, fullLibrary, SIX_MAX_100, TEST_CHART_SETS } from "./support.js";

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

/**
 * Every planned set as a spec (no data: picking a set reads only the
 * registry), so the table and depth rules are tested over the owner's whole
 * list whatever is transcribed so far.
 */
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

const pickId = (spot: PreflopSpot, specs: readonly ChartSetSpec[] = PLANNED) => {
  const pick = pickChartSet(specs, spot);
  return pick.ok ? pick.spec.id : pick.reason;
};
const anted = (spot: PreflopSpot, anteBb = 0.16): PreflopSpot => ({ ...spot, ante: true, anteBb });

function ok(result: ChartLookup) {
  if (!result.ok) throw new Error(`expected a node, got ${result.reason}: ${result.detail}`);
  return result;
}

describe("the registry", () => {
  it("lists only planned sets, each once, its id naming its table, depth and kind", () => {
    const ids = CHART_SETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_CHART_SET);
    for (const spec of CHART_SETS) {
      expect(PLANNED_CHART_SETS).toContain(spec.id);
      const table = spec.players === 2 ? "hu" : `${spec.players}max`;
      const kind = spec.straddle ? "-straddle" : spec.ante ? "-ante" : "";
      expect(spec.id).toBe(`nlhe-cash-${table}-${spec.stackBb}bb${kind}`);
      const set = chartSet(spec.id);
      expect(set.id).toBe(spec.id);
      expect(set.game.positions).toHaveLength(spec.players);
      expect(set.game.stackBb - (set.game.ante ?? 0)).toBeCloseTo(spec.stackBb, 6);
    }
    // The owner's list: no 9-max 60bb without an ante, no 6-max straddle without one.
    expect(PLANNED_CHART_SETS).not.toContain("nlhe-cash-9max-60bb");
    expect(PLANNED.filter((s) => s.players === 6 && !s.ante).map((s) => s.stackBb)).toEqual([40, 60, 100, 150, 200]);
    expect(PLANNED.filter((s) => s.players === 9 && !s.ante).map((s) => s.stackBb)).toEqual([100, 150, 200]);
    expect(PLANNED.filter((s) => s.players === 9 && s.ante).map((s) => s.stackBb)).toEqual([60, 100, 150, 200]);
  });

  it("reads heads-up on the heads-up set, 3-6 players on a 6-max set and 7-9 on a 9-max set; refuses ten", () => {
    expect(pickId(table(6, "CO"))).toBe("nlhe-cash-6max-100bb");
    expect(pickId(table(5, "CO"))).toBe("nlhe-cash-6max-100bb");
    expect(pickId(table(3, "BTN"))).toBe("nlhe-cash-6max-100bb");
    expect(pickId(table(7, "LJ"))).toBe("nlhe-cash-9max-100bb");
    expect(pickId(table(8, "UTG"))).toBe("nlhe-cash-9max-100bb");
    expect(pickId(table(9, "UTG+2"))).toBe("nlhe-cash-9max-100bb");
    expect(pickId(table(2, "SB"))).toBe("nlhe-cash-hu-100bb");
    expect(pickId(table(2, "BB", 119))).toBe("nlhe-cash-hu-100bb");
    expect(pickId(table(2, "SB", 121))).toBe("nlhe-cash-hu-150bb");
    expect(pickId(table(2, "SB", 79))).toBe("stack-depth");
    expect(pickId(table(2, "SB", 181))).toBe("stack-depth");
    expect(pickChartSet(PLANNED.filter((s) => s.players > 2), table(2, "SB"))).toMatchObject({ ok: false, reason: "players" });
    expect(pickId(table(10, "MP"))).toBe("players");
    // Antes: the ante sets, 6-max and 9-max; heads-up has none.
    expect(pickId(anted(table(6, "CO")))).toBe("nlhe-cash-6max-100bb-ante");
    expect(pickId(anted(table(8, "CO")))).toBe("nlhe-cash-9max-100bb-ante");
    expect(pickId(anted(table(2, "SB")))).toBe("players");
  });

  it("picks the nearest depth within 20%, never interpolating, within a kind", () => {
    expect(pickId(table(6, "BTN", 119))).toBe("nlhe-cash-6max-100bb");
    expect(pickId(table(6, "BTN", 121))).toBe("nlhe-cash-6max-150bb");
    expect(pickId(table(6, "BTN", 172))).toBe("nlhe-cash-6max-200bb");
    expect(pickId(table(6, "BTN", 241))).toBe("stack-depth");
    expect(pickId(table(6, "BTN", 47))).toBe("nlhe-cash-6max-40bb");
    expect(pickId(table(6, "BTN", 49))).toBe("nlhe-cash-6max-60bb");
    expect(pickId(table(6, "BTN", 31))).toBe("stack-depth");
    expect(pickId(table(6, "BTN", 75))).toBe("stack-depth");
    // 9-max: no 60bb set without an ante, so a short 9-max hand without one gets no chart; with one, the ante set.
    expect(pickId(table(8, "CO", 60))).toBe("stack-depth");
    expect(pickId(anted(table(8, "CO", 60)))).toBe("nlhe-cash-9max-60bb-ante");
    expect(pickId(table(9, "CO", 80))).toBe("nlhe-cash-9max-100bb");
    expect(pickId(table(8, "CO", 180))).toBe("nlhe-cash-9max-200bb");
    expect(pickId(anted(table(6, "BTN", 150)))).toBe("nlhe-cash-6max-150bb-ante");
    // A straddle reads the straddle set whatever its ante.
    const straddled = (spot: PreflopSpot) => ({ ...spot, straddle: true, straddles: [{ position: "UTG" as const, toBb: 2 }] });
    expect(pickId(straddled(table(6, "BTN")))).toBe("nlhe-cash-6max-100bb-straddle");
    expect(pickId(anted(straddled(table(6, "BTN"))))).toBe("nlhe-cash-6max-100bb-straddle");
  });

  it("judges depth by the effective stack: the hero against the deepest opponent still in", () => {
    const spot = table(6, "BTN", 100, { stacksBb: { BTN: 300, SB: 90, BB: 150, UTG: 400, HJ: 400, CO: 400 } });
    // UTG, HJ and CO folded: the deepest live opponent has 150.
    expect(effectiveStackBb(spot)).toBe(150);
    expect(pickId(spot)).toBe("nlhe-cash-6max-150bb");
  });

  it("gives a hand no chart when its set is not transcribed: never one of another kind", () => {
    const transcribed = (spot: PreflopSpot) => pickId(spot, CHART_SETS);
    for (const spot of [table(6, "CO"), table(8, "CO"), table(2, "SB"), anted(table(6, "CO", 200)), anted(table(6, "CO"), 0.5), table(6, "CO", 100, { ante: true })]) {
      const pick = pickChartSet(CHART_SETS, spot);
      if (!pick.ok) continue;
      expect(Boolean(pick.spec.ante), transcribed(spot)).toBe(Boolean(spot.ante));
    }
    expect(transcribed(table(6, "CO", 100, { ante: true }))).toBe("ante");
  });
});

describe("lookup through the library (the transcribed sets and the test fixtures)", () => {
  const library = fullLibrary();

  it("is a chart set itself: its own fields are its first set's", () => {
    expect(isChartLibrary(library)).toBe(true);
    expect(library.id).toBe(SIX_MAX_100);
    expect(library.nodes.get("")?.actor).toBe("UTG");
    expect(isChartLibrary(chartSet(SIX_MAX_100))).toBe(false);
  });

  it("answers deep stacks from their own depth, and notes the distance", () => {
    const deep = ok(lookupPreflop(library, table(6, "BTN", 150), "A5s"));
    expect(deep.set.id).toBe("nlhe-cash-6max-150bb");
    expect(deep.approximations).toEqual([]);
    const between = ok(lookupPreflop(library, table(6, "BTN", 135), "A5s"));
    expect(between.set.id).toBe("nlhe-cash-6max-150bb");
    expect(between.approximations).toEqual([
      expect.objectContaining({ kind: "stack-depth", set: "nlhe-cash-6max-150bb", realBb: 135, chartBb: 150 }),
    ]);
    expect(lookupPreflop(library, table(6, "CO", 75), "KQo")).toMatchObject({ ok: false, reason: "stack-depth" });
  });

  it("reads an anted hand on the ante set and an unanted one on the classic set", () => {
    expect(ok(lookupPreflop(library, anted(table(6, "CO")), "AKo")).set.id).toBe("nlhe-cash-6max-100bb-ante");
    expect(ok(lookupPreflop(library, table(6, "CO"), "AKo")).set.id).toBe(SIX_MAX_100);
  });

  it("refuses straddles by name, reads heads-up only on the heads-up set, and says when a set is not loaded", () => {
    expect(lookupPreflop(library, table(6, "BTN", 100, { straddle: true }), "AA")).toMatchObject({ ok: false, reason: "straddle" });
    const hu = ok(lookupPreflop(library, table(2, "SB"), "AA"));
    expect(hu.set.id).toBe("nlhe-cash-hu-100bb");
    expect(hu.node).toMatchObject({ line: "", actor: "SB", scenario: "rfi" });
    expect(hu.approximations).toEqual([]);
    expect(lookupPreflop(chartSet(SIX_MAX_100), table(2, "SB"), "AA")).toMatchObject({ ok: false, reason: "players" });
    expect(lookupPreflop(chartSet("nlhe-cash-hu-100bb"), table(3, "BTN"), "AA")).toMatchObject({ ok: false, reason: "players" });
    const partial = chartLibrary([chartSet(SIX_MAX_100)], TEST_CHART_SETS);
    expect(lookupPreflop(partial, table(2, "SB"), "AA")).toMatchObject({ ok: false, reason: "unavailable" });
    expect(lookupPreflop(partial, table(6, "UTG"), "AA").ok).toBe(true);
  });

  it("loads the sets a library lacks on demand", async () => {
    const specs: ChartSetSpec[] = TEST_CHART_SETS.map((spec) => ({
      ...spec,
      load: async () => JSON.parse(readFileSync(fileOf(spec.id), "utf8")),
    }));
    const partial = chartLibrary([chartSet(SIX_MAX_100)], specs);
    expect(partial.sets.size).toBe(1);
    await ensureChartSets(partial, ["nlhe-cash-hu-100bb", "nlhe-cash-hu-100bb"]);
    expect([...partial.sets.keys()].sort()).toEqual(["nlhe-cash-6max-100bb", "nlhe-cash-hu-100bb"]);
    expect(ok(lookupPreflop(partial, table(2, "SB"), "AA")).set.id).toBe("nlhe-cash-hu-100bb");
  });
});

describe("a stored line's table (leaks name a line, not a set)", () => {
  it("walks a line on the table whose next seat the decision's own seat can be", () => {
    // 6-max BTN first in; 9-max LJ first in (UTG+1 on an 8-handed table is two seats earlier).
    expect(lineSeats("fff", "BTN")).toEqual(TABLE_ORDER);
    expect(lineSeats("fff", "LJ")).toEqual(NINE_TABLE_ORDER);
    expect(lineSeats("ff", "UTG")).toEqual(NINE_TABLE_ORDER);
    // 9-max: HJ opens, the button faces it.
    expect(walkLine("ffffrf", lineSeats("ffffrf", "BTN")).next).toBe("BTN");
    expect(lineSeats("fffrf", "BB")).toEqual(TABLE_ORDER);
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

  it("reads every decision on a set of its own kind, or refuses it by name", () => {
    const all = [...decisions(weplay), ...decisions(gg)];
    const reasons = new Map<string, number>();
    for (const { spot, lookup } of all) {
      const key = lookup.ok ? "ok" : lookup.reason;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
      if (!lookup.ok) continue;
      // An anted hand on an ante set (or the straddle set), any other on a classic one.
      expect(Boolean(lookup.set.game.ante), lookup.set.id).toBe(Boolean(spot.ante) || Boolean(lookup.set.game.straddle));
      if (spot.ante && !lookup.set.game.straddle) expect(spot.anteBb).toBeDefined();
      const effective = effectiveStackBb(spot);
      const depth = lookup.set.game.stackBb;
      const shifted = lookup.approximations.some((a) => a.kind === "uncovered-depth" || a.kind === "rare-line-depth");
      if (!shifted) expect(Math.abs(effective - depth) / depth).toBeLessThanOrEqual(0.2 + 1e-9);
    }
    expect(reasons.get("unavailable") ?? 0).toBe(0);
    expect(reasons.get("bad-input") ?? 0).toBeLessThanOrEqual(1);
    // The corpora's hands have no antes: 2-6 handed ones are read on the classic fixtures, 7-9 handed refused.
    expect(reasons.get("ok") ?? 0).toBeGreaterThan(300);
  });
});
