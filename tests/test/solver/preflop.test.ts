/**
 * The preflop solver (phase A2a): hand classes and card removal, the equity
 * table, the realisation model, the 6-max tree, and the multi-player DCFR
 * engine.
 *
 * The engine has no closed-form answer to compare against, so it is checked
 * by properties that must hold for any correct implementation:
 *
 *  - heads-up (SB vs BB) it converges: NashConv goes to ~0, as DCFR must in a
 *    two-player game;
 *  - best responses are never worth less than the profile;
 *  - with every other player frozen, CFR for the remaining one converges to
 *    its best response (so regrets and best responses agree);
 *  - chips are conserved without rake;
 *  - a terminal's counterfactual value matches a brute-force sum over the
 *    opponent's classes.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  buildPreflopTree,
  CHARTS1_REALISATION,
  CLASS_COMBOS,
  classByName,
  classOfCards,
  COMBO_CLASS,
  comboCards,
  COMPAT,
  flopRake,
  HAND_CLASSES,
  massVector,
  NO_RAKE,
  NUM_CLASSES,
  NUM_COMBOS,
  PF_ACTION,
  PF_ALLIN,
  PF_FLOP,
  potAt,
  preflopEquityTable,
  PreflopSolver,
  roleWeights,
  shareMatrix,
  STANDARD_RAKE,
  type PotType,
  type PreflopEquityTable,
  type RealisationRole,

} from "../../../frontend/src/lib/solver/index.js";

const H = NUM_CLASSES;

let table: PreflopEquityTable;

/** The charts/1 share matrix of a hero in `hero` role against `opp`. */
function share1(potType: PotType, hero: RealisationRole, opp: RealisationRole): Float64Array {
  return shareMatrix(
    table.equity,
    roleWeights(CHARTS1_REALISATION, potType, hero),
    roleWeights(CHARTS1_REALISATION, potType, opp),
  );
}
beforeAll(() => {
  table = preflopEquityTable({ boards: 3000, seed: 7 });
});

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("hand classes", () => {
  it("are the 13x13 grid with 1326 combos", () => {
    expect(HAND_CLASSES).toHaveLength(169);
    expect(CLASS_COMBOS.reduce((a, b) => a + b, 0)).toBe(1326);
    expect(HAND_CLASSES[0].name).toBe("AA");
    expect(HAND_CLASSES[1].name).toBe("AKs");
    expect(HAND_CLASSES[13].name).toBe("AKo");
    expect(HAND_CLASSES[168].name).toBe("22");
    expect(HAND_CLASSES[classByName("72o")].combos).toBe(12);
    const counts = new Array(169).fill(0);
    for (let k = 0; k < NUM_COMBOS; k += 1) counts[COMBO_CLASS[k]] += 1;
    expect(counts).toEqual(Array.from(CLASS_COMBOS));
  });

  it("count compatible opponent combos exactly (brute force)", () => {
    for (let i = 0; i < H; i += 1) {
      const [a, b] = HAND_CLASSES[i].rep;
      expect(classOfCards(a, b)).toBe(i);
      const counts = new Array(H).fill(0);
      for (let k = 0; k < NUM_COMBOS; k += 1) {
        const [c, d] = comboCards(k);
        if (c === a || c === b || d === a || d === b) continue;
        counts[COMBO_CLASS[k]] += 1;
      }
      for (let j = 0; j < H; j += 1) {
        expect(COMPAT[i * H + j], `${HAND_CLASSES[i].name} vs ${HAND_CLASSES[j].name}`).toBe(counts[j]);
      }
    }
  });

  it("massVector is m · x / 1225", () => {
    const random = lcg(3);
    const x = Float64Array.from({ length: H }, () => (random() < 0.3 ? 0 : random()));
    const out = new Float64Array(H);
    massVector(x, out, new Float64Array(13));
    for (let i = 0; i < H; i += 1) {
      let sum = 0;
      for (let j = 0; j < H; j += 1) sum += COMPAT[i * H + j] * x[j];
      expect(out[i]).toBeCloseTo(sum / 1225, 12);
    }
    massVector(new Float64Array(H).fill(1), out, new Float64Array(13));
    for (let i = 0; i < H; i += 1) expect(out[i]).toBeCloseTo(1, 12);
  });
});

describe("preflop equity table", () => {
  it("is complementary and plausible", () => {
    const e = (a: string, b: string) => table.equity[classByName(a) * H + classByName(b)];
    for (let i = 0; i < H; i += 7) {
      for (let j = 0; j < H; j += 5) {
        expect(table.equity[i * H + j] + table.equity[j * H + i]).toBeCloseTo(1, 12);
      }
    }
    // Well-known all-in equities, to the sampling error of 3,000 boards.
    expect(e("AA", "KK")).toBeGreaterThan(0.78);
    expect(e("AA", "KK")).toBeLessThan(0.86);
    expect(e("AKs", "QQ")).toBeGreaterThan(0.42);
    expect(e("AKs", "QQ")).toBeLessThan(0.5);
    expect(e("72o", "AA")).toBeLessThan(0.16);
    expect(e("AKs", "AKo")).toBeGreaterThan(0.5);
    expect(e("AA", "AA")).toBe(0.5);
  });

  it("is deterministic for a seed", () => {
    const again = preflopEquityTable({ boards: 300, seed: 11 });
    const once = preflopEquityTable({ boards: 300, seed: 11 });
    expect(Array.from(again.equity)).toEqual(Array.from(once.equity));
  });
});

describe("realisation model", () => {
  it("conserves the pot between two players", () => {
    const oop = share1("srp", "oopCaller", "ipAgg");
    const ip = share1("srp", "ipAgg", "oopCaller");
    for (let i = 0; i < H; i += 3) {
      for (let j = 0; j < H; j += 4) {
        const w = COMPAT[i * H + j] / 1225;
        if (w === 0) continue;
        // share(i OOP vs j IP) + share(j IP vs i OOP) = 1, both weighted by m / 1225.
        const a = oop[i * H + j] / w;
        const b = ip[j * H + i] / (COMPAT[j * H + i] / 1225);
        expect(a + b).toBeCloseTo(1, 12);
      }
    }
  });

  it("gives the in-position raiser the edge, and nothing all-in", () => {
    const k = (n: string) => classByName(n);
    const ip = share1("srp", "ipAgg", "oopCaller");
    const allin = share1("allin", "ipAgg", "oopCaller");
    const i = k("KQo");
    const j = k("JTs");
    const w = COMPAT[i * H + j] / 1225;
    expect(ip[i * H + j] / w).toBeGreaterThan(table.equity[i * H + j]);
    expect(allin[i * H + j] / w).toBeCloseTo(table.equity[i * H + j], 12);
  });

  it("expresses charts/1's hand-set constants exactly", () => {
    const k = (n: string) => classByName(n);
    const ipAgg = roleWeights(CHARTS1_REALISATION, "srp", "ipAgg");
    const oopCaller = roleWeights(CHARTS1_REALISATION, "srp", "oopCaller");
    const ipCaller = roleWeights(CHARTS1_REALISATION, "srp", "ipCaller");
    // Position x initiative for the raiser in position, position alone between two callers.
    expect(ipAgg[k("K4o")] / oopCaller[k("K4o")]).toBeCloseTo(1.3 * 1.1, 12);
    expect(ipCaller[k("K4o")] / oopCaller[k("K4o")]).toBeCloseTo(1.3, 12);
    // Playability: suited connector, pair, offsuit gapper.
    expect(ipAgg[k("T9s")] / ipAgg[k("A2s")]).toBeCloseTo(1.06, 12);
    expect(ipAgg[k("55")] / ipAgg[k("A2s")]).toBeCloseTo(1.12 / 1.15, 12);
    expect(ipAgg[k("K4o")] / ipAgg[k("KQo")]).toBeCloseTo(0.9 / 1.06, 12);
    // Faded in 3-bet pots, gone all-in.
    const three = roleWeights(CHARTS1_REALISATION, "3bet", "ipAgg");
    expect(three[k("T9s")] / three[k("K4o")]).toBeCloseTo(Math.pow((1.15 * 1.06) / 0.9, 0.6), 12);
    const allin = roleWeights(CHARTS1_REALISATION, "allin", "oopCaller");
    expect(Array.from(allin).every((w) => w === 1)).toBe(true);
  });

  it("caps the rake and takes none all-in beyond the cap", () => {
    expect(flopRake(5.5, "srp", STANDARD_RAKE)).toBeCloseTo(5.5 * 1.75 * 0.05, 12);
    expect(flopRake(45, "4bet", STANDARD_RAKE)).toBe(2.5875);
    expect(flopRake(200, "allin", STANDARD_RAKE)).toBe(3);
    expect(flopRake(200, "allin", NO_RAKE)).toBe(0);
  });
});

describe("6-max tree", () => {
  const tree = buildPreflopTree();
  const at = (line: string) => {
    const node = tree.lineIndex.get(line);
    expect(node, line).toBeDefined();
    return node as number;
  };
  const edges = (node: number) =>
    Array.from({ length: tree.childCount[node] }, (_, a) => ({
      code: tree.edgeCode[tree.childStart[node] + a],
      to: tree.edgeTo[tree.childStart[node] + a],
    }));

  it("has the documented sizes", () => {
    expect(edges(at(""))).toEqual([{ code: "f", to: 0 }, { code: "r", to: 2.5 }]);
    expect(edges(at("ffff")).map((e) => e.code)).toEqual(["f", "c", "r"]);
    expect(edges(at("ffff"))[2].to).toBe(3);
    // BTN 3-bets UTG in position: 3x. SB 3-bets UTG out of position: 4x.
    expect(edges(at("rff"))[2].to).toBe(7.5);
    expect(edges(at("rfff"))[2].to).toBe(10);
    // Squeeze: BTN over UTG open + HJ call, 3x + 1x.
    expect(edges(at("rcf"))[2].to).toBe(10);
    // UTG 4-bets the BTN out of position: 2.5 x 7.5 = 18.75 -> 19.
    expect(edges(at("rffrff"))[2].to).toBe(19);
    // BTN 4-bets the BB in position: 2.2 x 10 = 22.
    expect(edges(at("fffrfr"))[2].to).toBe(22);
    // 5-bet is all-in.
    expect(edges(at("fffrfrr")).map((e) => e.code)).toEqual(["f", "c", "a"]);
    // BB after an SB limp: check or raise to 4; SB re-raises 3x to 12.
    expect(edges(at("ffffc"))).toEqual([{ code: "k", to: 1 }, { code: "r", to: 4 }]);
    expect(edges(at("ffffcr"))[2].to).toBe(12);
  });

  it("flags the cuts", () => {
    // UTG open, HJ, CO and BTN call: four players are in, the blinds can
    // only fold and get no node.
    expect(edges(at("rcc")).map((e) => e.code)).toEqual(["f", "c", "r"]);
    expect(tree.lineIndex.has("rccc")).toBe(false);
    const fourWay = tree.children[tree.childStart[at("rcc")] + 1];
    expect(tree.type[fourWay]).toBe(PF_FLOP);
    expect(tree.line[fourWay]).toBe("rcccff");
    // BB facing BTN open and SB 3-bet has not put money in voluntarily: no cold call.
    expect(edges(at("fffrr")).map((e) => e.code)).toEqual(["f", "r"]);
    expect(tree.flags[at("fffrr")]).toBeGreaterThan(0);
    // Open limps are not in the tree.
    expect(edges(at("")).map((e) => e.code)).not.toContain("c");
  });

  it("never puts five players in a pot and closes all-ins at the stack", () => {
    for (let node = 0; node < tree.size; node += 1) {
      if (tree.type[node] === PF_ACTION) continue;
      let live = 0;
      for (let p = 0; p < 6; p += 1) if (tree.live[node] & (1 << p)) live += 1;
      expect(live).toBeLessThanOrEqual(4);
      if (tree.type[node] === PF_ALLIN) {
        expect(tree.toMatch[node]).toBe(100);
        expect(potAt(tree, node)).toBeGreaterThanOrEqual(200);
      }
      if (tree.type[node] === PF_FLOP) expect(live).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("multi-player DCFR", () => {
  it("converges heads-up (SB vs BB) without rake, and conserves chips", () => {
    const tree = buildPreflopTree({ players: ["SB", "BB"] });
    const solver = new PreflopSolver({ tree, equity: table.equity, rake: NO_RAKE });
    solver.iterate(50);
    const early = solver.exploitability();
    solver.iterate(450);
    const late = solver.exploitability();
    expect(late.nashConvMbb).toBeLessThan(early.nashConvMbb);
    expect(late.nashConvMbb).toBeLessThan(1);
    expect(late.valueSum).toBeCloseTo(0, 9);
    for (let p = 0; p < 2; p += 1) {
      expect(late.bestResponse[p]).toBeGreaterThanOrEqual(late.value[p] - 1e-12);
    }
  });

  it("is deterministic", () => {
    const tree = buildPreflopTree({ players: ["BTN", "SB", "BB"] });
    const a = new PreflopSolver({ tree, equity: table.equity, rake: STANDARD_RAKE });
    const b = new PreflopSolver({ tree, equity: table.equity, rake: STANDARD_RAKE });
    a.iterate(25);
    b.iterate(25);
    expect(Array.from(a.regrets)).toEqual(Array.from(b.regrets));
    expect(Array.from(a.strategySum)).toEqual(Array.from(b.strategySum));
  });

  it("agrees with its own best response when the others are frozen", () => {
    const tree = buildPreflopTree({ players: ["BTN", "SB", "BB"] });
    const solver = new PreflopSolver({ tree, equity: table.equity, rake: STANDARD_RAKE });
    solver.iterate(30);
    // Freeze BTN and SB at their current average: regret matching on
    // positive "regrets" equal to the average strategy plays exactly it.
    for (let node = 0; node < tree.size; node += 1) {
      if (tree.type[node] !== PF_ACTION || tree.actor[node] === 2) continue;
      const avg = solver.averageStrategy(node);
      solver.regrets.set(avg, solver.offset[node]);
    }
    const before = solver.exploitability().gainMbb[2];
    solver.iterate(400, [2]);
    const after = solver.exploitability().gainMbb[2];
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(5);
  });

  it("values a heads-up flop terminal as the brute-force sum over the opponent", () => {
    // BTN opens, SB folds, BB calls: a single-raised pot, BTN in position.
    const tree = buildPreflopTree({ players: ["BTN", "SB", "BB"] });
    const solver = new PreflopSolver({ tree, equity: table.equity, rake: STANDARD_RAKE });
    solver.iterate(20);
    solver.evaluate();
    const node = tree.lineIndex.get("rf") as number;
    const call = tree.children[tree.childStart[node] + 1];
    expect(tree.type[call]).toBe(PF_FLOP);
    // BB's EV of calling, per class, against the BTN's opening range.
    const btnOpen = solver.averageStrategy(0).subarray(H, 2 * H);
    const sbFold = solver.averageStrategy(tree.lineIndex.get("r") as number).subarray(0, H);
    const share = share1("srp", "oopCaller", "ipAgg");
    const pot = potAt(tree, call);
    const net = pot - flopRake(pot, "srp", STANDARD_RAKE);
    const off = solver.offset[node];
    for (const name of ["AA", "T9s", "K4o", "22"]) {
      const i = classByName(name);
      // m[i][j]/1225 weights for the BTN and (folded) SB.
      let btnMass = 0;
      let value = 0;
      for (let j = 0; j < H; j += 1) {
        const w = (COMPAT[i * H + j] / 1225) * btnOpen[j];
        btnMass += w;
        value += net * share[i * H + j] * btnOpen[j] - 2.5 * w;
      }
      let sbMass = 0;
      for (let j = 0; j < H; j += 1) sbMass += (COMPAT[i * H + j] / 1225) * sbFold[j];
      // EV = counterfactual value / opponents' mass at the node.
      expect(solver.ev?.[off + H + i]).toBeCloseTo((value * sbMass) / (btnMass * sbMass), 9);
    }
  });
});
