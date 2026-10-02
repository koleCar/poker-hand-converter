/**
 * Chart lookup: real preflop lines onto chart nodes.
 *
 *  - synthetic lines for every scenario, and the reasons a line is refused;
 *  - action translation of real raise sizes (pseudo-harmonic distance, the
 *    off-tree flag beyond 25% of the pot);
 *  - real hands from the GG fixture corpus, parsed by the production parsers,
 *    pinned to the node they must land on, plus properties over every hero
 *    preflop decision in the corpus.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  handClassOf,
  loadCharts,
  lookupPreflop,
  preflopSpotFromHand,
  type ChartLookup,
  type PreflopActionInput,
  type PreflopSpot,
} from "../../../frontend/src/lib/charts/index.js";
import { convertAny } from "../../../frontend/src/lib/parsers/index.js";
import type { PhfHand, Position } from "../../../frontend/src/lib/phf/types.js";
import { HAND_CLASSES } from "../../../frontend/src/lib/solver/index.js";
import { ggFiles } from "../support/corpus.js";

const FILE = join(import.meta.dirname, "../../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json");
const charts = loadCharts(JSON.parse(readFileSync(FILE, "utf8")));
const SIX: Position[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

const act = (position: Position, type: PreflopActionInput["type"], toBb?: number): PreflopActionInput =>
  toBb === undefined ? { position, type } : { position, type, toBb };

function spot(hero: Position, actions: PreflopActionInput[], extra: Partial<PreflopSpot> = {}): PreflopSpot {
  return { positions: SIX, hero, actions, ...extra };
}

function ok(result: ChartLookup) {
  if (!result.ok) throw new Error(`expected a node, got ${result.reason}: ${result.detail}`);
  return result;
}

describe("synthetic lines", () => {
  it("finds RFI, vs-open, squeeze, vs-3bet and vs-4bet nodes", () => {
    const rfi = ok(lookupPreflop(charts, spot("UTG", []), ["Ah", "Ad"]));
    expect(rfi.node.line).toBe("");
    expect(rfi.handClass).toBe("AA");
    expect(rfi.options.map((o) => o.action)).toEqual(["fold", "raise"]);
    expect(rfi.options[1].sizeBb).toBe(2.5);
    expect(rfi.options[1].freq).toBe(1);
    expect(rfi.options[0].ev).toBe(0);
    expect(rfi.approximations).toEqual([]);

    const bb = ok(
      lookupPreflop(
        charts,
        spot("BB", [act("UTG", "fold"), act("HJ", "fold"), act("CO", "fold"), act("BTN", "raise", 2.5), act("SB", "fold")]),
        "T9s",
      ),
    );
    expect(bb.node.line).toBe("fffrf");
    expect(bb.node.scenario).toBe("vs-open");
    expect(bb.node.vsSteal).toBe(true);
    expect(bb.options.map((o) => [o.action, o.sizeBb])).toEqual([
      ["fold", 1],
      ["call", 2.5],
      ["raise", 10],
    ]);
    expect(bb.options[0].ev).toBe(-1);

    const squeeze = ok(
      lookupPreflop(charts, spot("BB", [act("UTG", "raise", 2.5), act("HJ", "fold"), act("CO", "fold"), act("BTN", "fold"), act("SB", "call", 2.5)]), "KQo"),
    );
    expect(squeeze.node.scenario).toBe("squeeze");
    expect(squeeze.node.line).toBe("rfffc");

    const vs3 = ok(
      lookupPreflop(
        charts,
        spot("UTG", [act("UTG", "raise", 2.5), act("HJ", "fold"), act("CO", "fold"), act("BTN", "raise", 7.5), act("SB", "fold"), act("BB", "fold")]),
        "QQ",
      ),
    );
    expect(vs3.node.scenario).toBe("vs-3bet");
    expect(vs3.options.map((o) => o.sizeBb)).toEqual([2.5, 7.5, 19]);
    expect(vs3.inRange).toBe(1);

    const vs4 = ok(
      lookupPreflop(
        charts,
        spot("BTN", [
          act("UTG", "raise", 2.5),
          act("HJ", "fold"),
          act("CO", "fold"),
          act("BTN", "raise", 7.5),
          act("SB", "fold"),
          act("BB", "fold"),
          act("UTG", "raise", 19),
        ]),
        "AKs",
      ),
    );
    expect(vs4.node.scenario).toBe("vs-4bet");
    expect(vs4.options.map((o) => o.action)).toEqual(["fold", "call", "allin"]);
  });

  it("maps the hero's own action and its size", () => {
    const r = ok(lookupPreflop(charts, spot("CO", [act("UTG", "fold"), act("HJ", "fold")]), "A5s", act("CO", "raise", 3)));
    expect(r.chosen).toBe(1);
    const sizing = r.approximations.find((a) => a.kind === "sizing");
    expect(sizing).toMatchObject({ position: "CO", realBb: 3, chartBb: 2.5, offTree: false });
    const fold = ok(lookupPreflop(charts, spot("CO", [act("UTG", "fold"), act("HJ", "fold")]), "72o", act("CO", "fold")));
    expect(fold.chosen).toBe(0);
  });

  it("reads hands as cards, combo text or class names", () => {
    expect(HAND_CLASSES[handClassOf(["Kd", "Ah"])].name).toBe("AKo");
    expect(HAND_CLASSES[handClassOf("7c2c")].name).toBe("72s");
    expect(HAND_CLASSES[handClassOf("T9s")].name).toBe("T9s");
    expect(handClassOf(["Ah", "Ah"])).toBe(-1);
  });
});

describe("action translation", () => {
  const open = (to: number) =>
    ok(lookupPreflop(charts, spot("HJ", [act("UTG", "raise", to)]), "AKo")).approximations.find((a) => a.kind === "sizing");

  it("measures the distance in pot fractions", () => {
    // Chart: UTG to 2.5 = 1.5 into a 2.5 pot after calling = 0.6 pot.
    expect(open(2.5)).toBeUndefined();
    // 2.2: 1.2 / 2.5 = 0.48 pot, 0.12 from the chart's 0.6.
    expect(open(2.2)?.distance).toBeCloseTo(0.12, 3);
    expect(open(2.2)?.offTree).toBe(false);
    // 3.0: 0.8 pot.
    expect(open(3)?.distance).toBeCloseTo(0.2, 3);
    expect(open(3)?.offTree).toBe(false);
  });

  it("flags sizes far from the chart's as off-tree but still finds the node", () => {
    const big = open(4);
    expect(big?.offTree).toBe(true);
    expect(big?.distance).toBeCloseTo(0.6, 3);
    // The 3-bet over a 4bb open is measured against the real pot.
    const r = ok(
      lookupPreflop(charts, spot("CO", [act("UTG", "raise", 4), act("HJ", "fold")]), "AKo", act("CO", "raise", 12)),
    );
    const threeBet = r.approximations.filter((a) => a.kind === "sizing" && a.position === "CO");
    // Real: 8 more into 1.5 + 4 + 4 = 9.5 -> 0.84 pot. Chart: 5 into 6.5 -> 0.77 pot.
    expect(threeBet[0].distance).toBeCloseTo(0.073, 2);
    expect(threeBet[0].offTree).toBe(false);
  });
});

describe("refusals", () => {
  const folds = [act("UTG", "fold"), act("HJ", "fold"), act("CO", "fold")];
  const reason = (r: ChartLookup) => (r.ok ? "ok" : r.reason);

  it("refuses straddles, antes, wrong table sizes and stack depths", () => {
    expect(reason(lookupPreflop(charts, spot("BTN", folds, { straddle: true }), "AA"))).toBe("straddle");
    expect(reason(lookupPreflop(charts, spot("BTN", folds, { ante: true }), "AA"))).toBe("ante");
    expect(reason(lookupPreflop(charts, { positions: ["SB", "BB", "CO", "BTN"], hero: "BTN", actions: [act("CO", "fold")] }, "AA"))).toBe("players");
    expect(reason(lookupPreflop(charts, spot("BTN", folds, { stacksBb: { BTN: 150, SB: 150, BB: 150 } }), "AA"))).toBe("stack-depth");
    expect(reason(lookupPreflop(charts, spot("BTN", folds, { stacksBb: { BTN: 60 } }), "AA"))).toBe("stack-depth");
    // 110bb is inside the band, with a note.
    const deep = ok(lookupPreflop(charts, spot("BTN", folds, { stacksBb: { BTN: 110, SB: 110, BB: 110 } }), "AA"));
    expect(deep.approximations.map((a) => a.kind)).toEqual(["stack-depth"]);
  });

  it("reads a 5-handed table as 6-max with UTG folded", () => {
    const r = ok(
      lookupPreflop(charts, { positions: ["SB", "BB", "UTG", "CO", "BTN"], hero: "UTG", actions: [] }, "AJo"),
    );
    expect(r.node.line).toBe("f");
    expect(r.node.actor).toBe("HJ");
    expect(r.approximations.map((a) => a.kind)).toEqual(["short-handed"]);
  });

  it("refuses limps, fourth players, cold calls and rare lines", () => {
    expect(reason(lookupPreflop(charts, spot("BTN", [act("UTG", "fold"), act("HJ", "fold"), act("CO", "call", 1)]), "AA"))).toBe("limp");
    // UTG opens, HJ and CO call: the BTN may not make it four-way. The charts
    // never flat an UTG open twice, so the node is too rare to keep; a call
    // from the BTN would be refused either way.
    const fourth = lookupPreflop(
      charts,
      spot("BTN", [act("UTG", "raise", 2.5), act("HJ", "call", 2.5), act("CO", "call", 2.5)]),
      "99",
      act("BTN", "call", 2.5),
    );
    expect(["rare-line", "action-not-modelled"]).toContain(reason(fourth));
    // The BB facing an UTG open and a CO 3-bet has no cold call.
    const cold = [act("UTG", "raise", 2.5), act("HJ", "fold"), act("CO", "raise", 7.5), act("BTN", "fold"), act("SB", "fold")];
    const node = ok(lookupPreflop(charts, spot("BB", cold), "QQ"));
    expect(node.unmodelled).toEqual(["call"]);
    expect(node.node.cold).toBe(true);
    expect(reason(lookupPreflop(charts, spot("BB", cold), "QQ", act("BB", "call", 7.5)))).toBe("action-not-modelled");
    // The BB cold-calls a 3-bet.
    expect(
      reason(
        lookupPreflop(
          charts,
          spot("UTG", [
            act("UTG", "raise", 2.5),
            act("HJ", "fold"),
            act("CO", "raise", 7.5),
            act("BTN", "fold"),
            act("SB", "fold"),
            act("BB", "call", 7.5),
          ]),
          "AA",
        ),
      ),
    ).toBe("cold-call");
    // UTG open, HJ cold 4-bet... a line the charts never take.
    const rare = lookupPreflop(
      charts,
      spot("CO", [act("UTG", "raise", 2.5), act("HJ", "raise", 7.5), act("CO", "raise", 19), act("BTN", "fold"), act("SB", "fold"), act("BB", "fold"), act("UTG", "raise", 100), act("HJ", "fold")]),
      "AA",
    );
    expect(["rare-line", "ok"]).toContain(reason(rare));
  });
});

describe("real hands from the GG corpus", () => {
  let hands: PhfHand[] = [];
  beforeAll(async () => {
    for (const file of ggFiles()) {
      hands = hands.concat((await convertAny(file.text, { sourceFilename: file.name })).hands);
    }
  });
  const find = (id: string) => {
    const hand = hands.find((h) => h.meta.handId === id);
    if (!hand) throw new Error(`no hand ${id}`);
    return hand;
  };

  const pinned: { id: string; nth: number; line: string; scenario: string; hand: string; chosen: string }[] = [
    // BB facing an UTG 3bb open and an SB call: a squeeze spot; the hero called.
    { id: "HD2735958236", nth: 0, line: "rfffc", scenario: "squeeze", hand: "KQo", chosen: "call" },
    // 5-handed: BTN folds 82o after UTG (read as HJ) and CO fold.
    { id: "HD2735958068", nth: 0, line: "fff", scenario: "rfi", hand: "82o", chosen: "fold" },
    // UTG opened 2bb, SB 3-bet to 9; the hero (UTG) called with 54s.
    { id: "HD2735956117", nth: 1, line: "rfffrf", scenario: "vs-3bet", hand: "54s", chosen: "call" },
    // BTN facing UTG open, HJ 3-bet, CO 4-bet: folds T7o.
    { id: "HD2736007221", nth: 0, line: "rrr", scenario: "vs-4bet", hand: "T7o", chosen: "fold" },
    // CO opened, SB 3-bet, CO 4-bet, SB shoved: the hero folds KQo.
    { id: "HD2735954790", nth: 2, line: "ffrfrfra", scenario: "vs-allin", hand: "KQo", chosen: "fold" },
  ];

  for (const p of pinned) {
    it(`${p.id} lands on ${JSON.stringify(p.line)} (${p.scenario})`, () => {
      const s = preflopSpotFromHand(find(p.id), p.nth);
      if (!s.ok) throw new Error(s.detail);
      const r = ok(lookupPreflop(charts, s.spot, s.heroCards, s.heroAction));
      expect(r.node.line).toBe(p.line);
      expect(r.node.scenario).toBe(p.scenario);
      expect(r.handClass).toBe(p.hand);
      expect(r.chosen).not.toBeNull();
      expect(r.options[r.chosen as number].action).toBe(p.chosen);
      const total = r.options.reduce((sum, o) => sum + o.freq, 0);
      expect(total).toBeCloseTo(1, 9);
    });
  }

  it("refuses what the charts do not cover, with the reason", () => {
    const deep = preflopSpotFromHand(find("HD2735958902"), 0);
    expect(deep.ok && lookupPreflop(charts, deep.spot)).toMatchObject({ ok: false, reason: "stack-depth" });
    const limp = preflopSpotFromHand(find("HD2735958351"), 0);
    expect(limp.ok && lookupPreflop(charts, limp.spot)).toMatchObject({ ok: false, reason: "limp" });
    const fourHanded = preflopSpotFromHand(find("HD2735958714"), 0);
    expect(fourHanded.ok && lookupPreflop(charts, fourHanded.spot)).toMatchObject({ ok: false, reason: "players" });
  });

  it("puts every covered hero decision on a node where the hero acts", () => {
    let covered = 0;
    let total = 0;
    for (const hand of hands) {
      for (let nth = 0; nth < 4; nth += 1) {
        const s = preflopSpotFromHand(hand, nth);
        if (!s.ok) break;
        total += 1;
        const r = lookupPreflop(charts, s.spot, s.heroCards, s.heroAction);
        if (!r.ok) {
          expect(r.detail.length).toBeGreaterThan(0);
          continue;
        }
        covered += 1;
        const hero = s.spot.positions.length === 5 && s.spot.hero === "UTG" ? "HJ" : s.spot.hero;
        expect(r.node.actor).toBe(hero);
        expect(r.chosen).not.toBeNull();
        expect(r.options.length).toBe(r.node.options.length);
      }
    }
    expect(total).toBeGreaterThan(400);
    // Most of the corpus is 100bb-ish 6-max; a third is deeper or limped.
    expect(covered / total).toBeGreaterThan(0.45);
  });
});
