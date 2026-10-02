/**
 * The charts/2 realisation pipeline (docs/CHARTS.md §4): measuring realised
 * shares with the turn+river solver, and fitting the preflop model to them.
 *
 *  - a measurement conserves the pot: without rake the two players' realised
 *    shares add up to the pot, and so do their check-down equities, with all
 *    rivers or a sample of dead ones;
 *  - a strong hand realises more than its equity in position, a weak one less;
 *  - the fit recovers a model from shares that model produced (synthetic data),
 *    and beats charts/1 on them;
 *  - the whole pipeline is deterministic on a tiny configuration.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  fitRealisation,
  generateRealisedChartSet,
  measurementJobs,
  prepareSpots,
  sampleDeals,
  type PreparedSpot,
} from "../../../frontend/src/lib/charts/realisation.js";
import { serializeCharts } from "../../../frontend/src/lib/charts/index.js";
import {
  CHARTS1_REALISATION,
  classByName,
  combosOfClass,
  COMPAT,
  measureRealisation,
  NUM_CLASSES,
  NUM_COMBOS,
  parseCards,
  preflopEquityTable,
  REALISATION_MENU,
  roleBiases,
  roleWeights,
  type PreflopEquityTable,
  type RealisationModel,
  type RealisationSample,
} from "../../../frontend/src/lib/solver/index.js";

const H = NUM_CLASSES;

let table: PreflopEquityTable;
beforeAll(() => {
  table = preflopEquityTable({ boards: 2000, seed: 5 });
});

function classRange(names: string[]): Float64Array {
  const out = new Float64Array(H);
  for (const n of names) out[classByName(n)] = 1;
  return out;
}

function comboRange(classes: Float64Array): Float64Array {
  const out = new Float64Array(NUM_COMBOS);
  for (let i = 0; i < H; i += 1) for (const c of combosOfClass(i)) out[c] = classes[i];
  return out;
}

const OOP = classRange(["AA", "KQs", "QJs", "JTs", "T9s", "98s", "77", "66", "55", "AJo", "KJo", "QTo", "K8o", "J7o"]);
const IP = classRange(["KK", "QQ", "AKs", "AQs", "AKo", "AQo", "KQo", "TT", "99", "A5s", "K9s", "76s"]);

function sums(sample: RealisationSample, p: 0 | 1) {
  let w = 0;
  let s = 0;
  let e = 0;
  for (let i = 0; i < H; i += 1) {
    w += sample.weight[p][i];
    s += sample.share[p][i];
    e += sample.equity[p][i];
  }
  return { w, s, e };
}

describe("measureRealisation", () => {
  const spot = {
    board: parseCards(["Qs", "8h", "5d", "2c"]),
    ranges: [comboRange(OOP), comboRange(IP)] as const,
    pot: 5.5,
    stack: 97.5,
    firstToAct: 0 as const,
    menu: REALISATION_MENU,
    raiseCap: 2,
    iterations: 40,
  };

  it("conserves the pot with every river", () => {
    const sample = measureRealisation(spot);
    const a = sums(sample, 0);
    const b = sums(sample, 1);
    expect(a.w).toBeCloseTo(b.w, 6);
    expect(a.s / a.w + b.s / b.w).toBeCloseTo(1, 6);
    expect(a.e / a.w + b.e / b.w).toBeCloseTo(1, 6);
    // The strongest hands win more than their equity; offsuit gappers less.
    const r = (p: 0 | 1, name: string) => sample.share[p][classByName(name)] / sample.equity[p][classByName(name)];
    expect(r(1, "QQ")).toBeGreaterThan(1);
    expect(r(0, "J7o")).toBeLessThan(1);
  });

  it("conserves the pot with a sample of dead rivers", () => {
    const sample = measureRealisation({ ...spot, rivers: parseCards(["Ah", "7c", "3s", "Td"]) });
    const a = sums(sample, 0);
    const b = sums(sample, 1);
    expect(a.s / a.w + b.s / b.w).toBeCloseTo(1, 6);
    expect(a.e / a.w + b.e / b.w).toBeCloseTo(1, 6);
  });
});

describe("fitRealisation", () => {
  // A known model: charts/1's form with different edges and playability.
  const truth: RealisationModel = {
    ...CHARTS1_REALISATION,
    name: "synthetic",
    potTypes: {
      ...CHARTS1_REALISATION.potTypes,
      srp: Object.fromEntries(
        Object.entries(roleBiases(1.25, 1.05)).map(([role, bias]) => [
          role,
          { bias, coef: { pair: 0.2, pairLow: 0.1, suited: 0.15, gap0: 0.1, offGap3: -0.2, high: -0.15, offAce: -0.1 } },
        ]),
      ) as RealisationModel["potTypes"]["srp"],
    },
  };

  /** Samples whose realised shares are exactly `truth`'s, for two spots that cover all four roles. */
  function synthetic(): { spots: PreparedSpot[]; samples: RealisationSample[] } {
    const wide = new Float64Array(H).fill(0.6);
    const narrow = new Float64Array(H);
    for (let i = 0; i < H; i += 1) narrow[i] = (i * 7) % 3 === 0 ? 1 : 0.2;
    const spots: PreparedSpot[] = [
      { line: "a", potType: "srp", roles: ["oopCaller", "ipAgg"], positions: ["BB", "BTN"], ranges: [wide, narrow], pot: 5.5, stack: 97.5, combos: [500, 500] },
      { line: "b", potType: "srp", roles: ["oopAgg", "ipCaller"], positions: ["CO", "BTN"], ranges: [narrow, wide], pot: 5.5, stack: 97.5, combos: [500, 500] },
    ];
    const samples = spots.map((spot) => {
      const out: RealisationSample = {
        weight: [new Float64Array(H), new Float64Array(H)],
        share: [new Float64Array(H), new Float64Array(H)],
        equity: [new Float64Array(H), new Float64Array(H)],
      };
      for (const p of [0, 1] as const) {
        const own = roleWeights(truth, "srp", spot.roles[p]);
        const opp = roleWeights(truth, "srp", spot.roles[1 - p]);
        const q = spot.ranges[1 - p];
        for (let i = 0; i < H; i += 1) {
          let mass = 0;
          let s = 0;
          let e = 0;
          for (let j = 0; j < H; j += 1) {
            const m = COMPAT[i * H + j] * q[j];
            const eq = table.equity[i * H + j];
            mass += m;
            e += m * eq;
            s += m * ((eq * own[i]) / (eq * own[i] + (1 - eq) * opp[j]));
          }
          const w = spot.ranges[p][i] * combosOfClass(i).length * mass;
          out.weight[p][i] = w;
          out.share[p][i] = (w * s) / mass;
          out.equity[p][i] = (w * e) / mass;
        }
      }
      return out;
    });
    return { spots, samples };
  }

  it("recovers a model from the shares it produced", () => {
    const { spots, samples } = synthetic();
    const fit = fitRealisation(spots, samples, table.equity);
    const report = fit.reports.find((r) => r.potType === "srp");
    expect(report).toBeDefined();
    expect(report?.rmse.fitted).toBeLessThan(0.002);
    expect(report?.rmse.charts1).toBeGreaterThan(5 * (report?.rmse.fitted ?? 1));
    expect(report?.positionEdge).toBeCloseTo(1.25, 1);
    expect(report?.initiativeEdge).toBeCloseTo(1.05, 1);
    // Weights match up to the gauge: compare ratios between classes.
    const got = roleWeights(fit.model, "srp", "oopCaller");
    const want = roleWeights(truth, "srp", "oopCaller");
    const ratio = (w: Float64Array) => w[classByName("55")] / w[classByName("A8o")];
    expect(ratio(got) / ratio(want)).toBeGreaterThan(0.9);
    expect(ratio(got) / ratio(want)).toBeLessThan(1.1);
    // Pot types without data keep the starting model.
    expect(fit.model.potTypes["4bet"]).toEqual(CHARTS1_REALISATION.potTypes["4bet"]);
  });
});

describe("pipeline", () => {
  it("samples the same deals for a seed, and is deterministic end to end", async () => {
    expect(sampleDeals(5, 3, 9)).toEqual(sampleDeals(5, 3, 9));
    expect(sampleDeals(5, 0, 9)[0].rivers).toBeUndefined();
    const options = {
      players: ["BTN", "SB", "BB"] as const,
      equityBoards: 300,
      equitySeed: 3,
      iterations: 30,
      checkEvery: 30,
      headsUpIterations: 0,
      minReach: 0,
      rounds: 1,
      roundIterations: 20,
      measure: { boards: 2, rivers: 4, iterations: 10, minClassReach: 0.2 },
    };
    const a = await generateRealisedChartSet(options);
    const b = await generateRealisedChartSet(options);
    expect(serializeCharts(a.charts)).toBe(serializeCharts(b.charts));
    expect(a.rounds).toHaveLength(1);
    expect(a.rounds[0].jobs).toBeGreaterThan(0);
    const model = a.charts.model as Record<string, any>;
    expect(model.realisation.name).toBe("charts/2-solver-fit");
    expect(model.realisationFit.rounds).toHaveLength(1);
    // Jobs are spot-major over the same deals.
    const spots = prepareSpots(a.solver, 0.2);
    const jobs = measurementJobs(spots, { boards: 2, rivers: 4, iterations: 10, seed: 1, minClassReach: 0.2 });
    expect(jobs).toHaveLength(spots.length * 2);
    if (spots.length > 1) expect(jobs[0].board).toEqual(jobs[2].board);
  });
});
