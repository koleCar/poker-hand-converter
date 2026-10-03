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
import { positionRing, type PhfHand, type Position } from "../../../frontend/src/lib/phf/types.js";
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
    // charts/4: an open limp is an option, played rarely (the 0.5% tremble, and AA's occasional trap).
    expect(rfi.options.map((o) => o.action)).toEqual(["fold", "call", "raise"]);
    expect(rfi.options[1].sizeBb).toBe(1);
    expect(rfi.options[1].freq).toBeLessThan(0.05);
    expect(rfi.options[2].sizeBb).toBe(2.5);
    expect(rfi.options[2].freq).toBeGreaterThan(0.95);
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
    expect(vs3.inRange).toBeGreaterThan(0.9);

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
    expect(r.options[r.chosen as number].action).toBe("raise");
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
    // Heads-up (the small blind is the button) and more seats than the set has.
    expect(reason(lookupPreflop(charts, { positions: ["SB", "BB"], hero: "SB", actions: [] }, "AA"))).toBe("players");
    const nine: Position[] = ["SB", "BB", "UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN"];
    expect(reason(lookupPreflop(charts, { positions: nine, hero: "BTN", actions: [] }, "AA"))).toBe("players");
    // A dead button: six live seats named from a seven-seat ring.
    const dead: Position[] = ["SB", "BB", "UTG", "LJ", "HJ", "CO"];
    expect(reason(lookupPreflop(charts, { positions: dead, hero: "CO", actions: [] }, "AA"))).toBe("players");
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
    expect(r.approximations[0].detail).toBe("5 players dealt in: read as 6-max with UTG folded");
  });

  it("reads 4- and 3-handed tables as 6-max with the earliest seats folded (A2c)", () => {
    const four = ok(
      lookupPreflop(charts, { positions: ["SB", "BB", "CO", "BTN"], hero: "BTN", actions: [act("CO", "fold")] }, "A5s"),
    );
    expect(four.node.line).toBe("fff");
    expect(four.node.actor).toBe("BTN");
    expect(four.approximations[0].detail).toBe("4 players dealt in: read as 6-max with UTG, HJ folded");
    const three = ok(
      lookupPreflop(charts, { positions: ["SB", "BB", "BTN"], hero: "BB", actions: [act("BTN", "raise", 2.5), act("SB", "fold")] }, "K9o"),
    );
    expect(three.node.line).toBe("fffrf");
    expect(three.node.scenario).toBe("vs-open");
    expect(three.approximations.map((a) => a.kind)).toEqual(["short-handed"]);
  });

  it("finds the spots behind limpers (charts/4), and refuses a fourth limper", () => {
    // UTG and HJ fold, the CO limps: the button may fold, over-limp or isolate to 4bb.
    const vsLimp = ok(lookupPreflop(charts, spot("BTN", [act("UTG", "fold"), act("HJ", "fold"), act("CO", "call", 1)]), "AA"));
    expect(vsLimp.node.line).toBe("ffc");
    expect(vsLimp.node.scenario).toBe("vs-limp");
    expect(vsLimp.node.limpers).toEqual(["CO"]);
    expect(vsLimp.node.options.map((o) => [o.action, o.toBb])).toEqual([["fold", 0], ["call", 1], ["raise", 4]]);
    expect(vsLimp.options[2].freq).toBeGreaterThan(0.9);
    // The button isolates to 4.5bb (off the chart's 4bb by half a big blind: a sizing note, not off-tree).
    const iso = ok(
      lookupPreflop(charts, spot("BTN", [act("UTG", "fold"), act("HJ", "fold"), act("CO", "call", 1)]), "AKo", act("BTN", "raise", 4.5)),
    );
    expect(iso.options[iso.chosen as number].action).toBe("raise");
    expect(iso.approximations).toMatchObject([{ kind: "sizing", offTree: false }]);
    // The CO limped and faces the button's isolation: the limper's own answer.
    const limper = ok(
      lookupPreflop(
        charts,
        spot("CO", [act("UTG", "fold"), act("HJ", "fold"), act("CO", "call", 1), act("BTN", "raise", 4), act("SB", "fold"), act("BB", "fold")]),
        "QQ",
        act("CO", "raise", 12),
      ),
    );
    expect(limper.node.scenario).toBe("vs-iso");
    expect(limper.options[limper.chosen as number].action).toBe("raise");
    // The big blind behind a limp checks or isolates.
    const option = ok(
      lookupPreflop(
        charts,
        spot("BB", [act("UTG", "call", 1), act("HJ", "fold"), act("CO", "fold"), act("BTN", "fold"), act("SB", "fold")]),
        "72o",
        act("BB", "check"),
      ),
    );
    expect(option.node.options.map((o) => o.action)).toEqual(["check", "raise"]);
    expect(option.options[option.chosen as number].action).toBe("check");
    // UTG, HJ and CO limp: a fourth limper is past the tree's three.
    const fourth = lookupPreflop(
      charts,
      spot("SB", [act("UTG", "call", 1), act("HJ", "call", 1), act("CO", "call", 1), act("BTN", "call", 1)]),
      "AA",
    );
    expect(reason(fourth)).toBe("multiway");
  });

  it("refuses fourth players, cold calls and rare lines", () => {
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
    // A limped pot was refused before charts/4; it is on the tree now.
    const limp = preflopSpotFromHand(find("HD2735958351"), 0);
    if (!limp.ok) throw new Error(limp.detail);
    const limped = lookupPreflop(charts, limp.spot);
    expect(limped.ok ? "ok" : limped.reason).not.toBe("limp");
    // Four-handed was refused before A2c; it is read as 6-max with UTG and HJ folded.
    const fourHanded = preflopSpotFromHand(find("HD2735958714"), 0);
    if (!fourHanded.ok) throw new Error(fourHanded.detail);
    expect(fourHanded.spot.positions).toHaveLength(4);
    // (This one is deeper than 120bb: the 100bb set alone refuses it by depth.)
    const four = lookupPreflop(charts, fourHanded.spot);
    expect(four.ok ? "ok" : four.reason).toBe("stack-depth");
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
        // A smaller table's seats are the set's last ones (by distance from the button).
        const ring = positionRing(s.spot.positions.length).slice(2);
        const k = ring.indexOf(s.spot.hero);
        const hero = k < 0 ? s.spot.hero : SIX.slice(0, 4)[4 - ring.length + k];
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
