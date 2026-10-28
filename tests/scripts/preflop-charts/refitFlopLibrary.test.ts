/**
 * The realisation model fitted on the flop library instead of checked-flop
 * turn solves (an experiment; docs/CHARTS.md §9 names it as the lasting fix).
 *
 * Reads every chunk of a set's flop library (`--out` of `npm run floplib`),
 * measures each line's per-class realised share and check-down equity
 * (`lib/charts/realisationFlopLibrary.ts`), fits the model with
 * `fitRealisation` on those twelve spots, and writes the fit where
 * `CHARTS_FIT_FROM` reads one: the chart set solved once with it is then
 *
 *     cd tests && FLOPLIB_DIR=~/Projects/rail-floplib-out npm run charts:refit-floplib
 *     CHARTS_SETS=nlhe-cash-6max-100bb CHARTS_FIT_FROM=scripts/preflop-charts/.cache/fit-floplib-nlhe-cash-6max-100bb.json \
 *       CHARTS_OUT=/tmp/6max-100bb-floplib.json npm run charts:generate
 *
 * Pot types the library has no line for (4-bet) keep the committed fit's
 * numbers. Not part of `npm test`: it decodes ~1,200 chunks (a few minutes).
 *
 * It also measures the rake growth: per line, the final pot / flop pot `g`
 * with `min(5% x pot x g, 3bb) = ` the rake the line's solves took, averaged
 * per pot type (lines weighted equally; 4-bet and all-in keep
 * `RAKE_POT_GROWTH`). Recorded as `realisationFit.rakePotGrowth` and printed
 * as a `CHARTS_RAKE_GROWTH` value for `charts:generate`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

import { flopLinesFor } from "../../../web/src/lib/analysis/flopLibrary.js";
import { loadCharts } from "../../../web/src/lib/charts/format.js";
import { fitRealisation, type PreparedSpot } from "../../../web/src/lib/charts/realisation.js";
import { flopLibrarySample, flopLibrarySpot, type WeightedFlop } from "../../../web/src/lib/charts/realisationFlopLibrary.js";
import { decodeChunk } from "../../../web/src/lib/solver/flopLibrary.js";
import { FLOP_REPRESENTATIVES, representativeCoverage } from "../../../web/src/lib/solver/flopSet.js";
import { DEFAULT_EQUITY_BOARDS, DEFAULT_EQUITY_SEED, preflopEquityTable } from "../../../web/src/lib/solver/preflopEquity.js";
import { CLASS_COMBOS } from "../../../web/src/lib/solver/handClasses.js";
import {
  RAKE_POT_GROWTH,
  roleWeights,
  STANDARD_RAKE,
  type PotType,
  type RealisationModel,
  type RealisationRole,
} from "../../../web/src/lib/solver/preflopModel.js";
import type { RealisationSample } from "../../../web/src/lib/solver/preflopRealisation.js";

const HERE = import.meta.dirname;
const DATA = join(HERE, "../../../web/src/lib/charts/data");
const SET = process.env.CHARTS_SETS ?? "nlhe-cash-6max-100bb";
const TREE = process.env.FLOPLIB_TREE ?? "flop-m1";
const DIR = (process.env.FLOPLIB_DIR ?? join(homedir(), "Projects/rail-floplib-out")).replace(/^~/, homedir());
const OUT = process.env.REFIT_OUT ?? join(HERE, `.cache/fit-floplib-${SET}.json`);

function cachedEquity(): Float64Array {
  const file = join(HERE, `.cache/equity-${DEFAULT_EQUITY_BOARDS}-${DEFAULT_EQUITY_SEED}.bin`);
  if (existsSync(file)) {
    const bytes = readFileSync(file);
    return new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  const table = preflopEquityTable({ boards: DEFAULT_EQUITY_BOARDS, seed: DEFAULT_EQUITY_SEED });
  mkdirSync(join(HERE, ".cache"), { recursive: true });
  writeFileSync(file, Buffer.from(table.equity.buffer));
  writeFileSync(`${file}.json`, JSON.stringify({ boards: table.boards, seed: table.seed, standardError: table.standardError }));
  return table.equity;
}

const POT_TYPE: Record<string, PotType> = { srp: "srp", "3bp": "3bet", "4bp": "4bet", limped: "limped" };

it("fits the realisation model on the flop library", () => {
  const json = JSON.parse(readFileSync(join(DATA, `${SET}.json`), "utf8"));
  const charts = loadCharts(json);
  const committed = json.model.realisation as RealisationModel;
  const coverage = representativeCoverage();
  const spots: PreparedSpot[] = [];
  const samples: RealisationSample[] = [];
  const lines: Record<string, unknown>[] = [];
  for (const line of flopLinesFor(charts.game.players)) {
    const t0 = performance.now();
    const flops: WeightedFlop[] = [];
    let players: [string, string] = ["", ""];
    for (const flop of FLOP_REPRESENTATIVES) {
      const file = join(DIR, SET, TREE, line.id, `${flop}.bin`);
      if (!existsSync(file)) continue;
      const chunk = decodeChunk(readFileSync(file));
      if (chunk.header.charts.hash !== charts.model.hash) {
        throw new Error(`${file} was solved on model ${chunk.header.charts.hash}, the set is ${charts.model.hash}`);
      }
      players = chunk.header.players;
      flops.push({ result: chunk.result, coverage: coverage.get(flop)?.flops ?? 0 });
    }
    if (flops.length < FLOP_REPRESENTATIVES.length / 2) {
      console.log(`${line.id}: ${flops.length} flops solved, skipped`);
      continue;
    }
    // The last raiser is whoever the caller's (or checker's) node faces.
    const facing = charts.nodes.get(line.key.slice(0, -1))?.facing?.position;
    const aggressor = facing === undefined ? -1 : facing === players[0] ? 0 : 1;
    const potType = POT_TYPE[line.pot];
    const spot = flopLibrarySpot(line.key, potType, players, aggressor, flops);
    const { sample, rake } = flopLibrarySample(flops);
    spots.push(spot);
    samples.push(sample);
    const rakeGrowth = lineRakeGrowth(spot.pot, rake * spot.pot);
    lines.push({
      line: line.id,
      key: line.key,
      potType,
      players,
      roles: spot.roles,
      flops: flops.length,
      pot: spot.pot,
      rakeOfPot: Math.round(rake * 1e4) / 1e4,
      rakeGrowth: Math.round(rakeGrowth * 1e4) / 1e4,
    });
    console.log(
      `${line.id}: ${flops.length} flops, ${spot.roles.join(" / ")}, combos ${spot.combos.map((c) => c.toFixed(0)).join(" / ")}, ` +
        `rake ${(rake * spot.pot).toFixed(2)}bb of a ${spot.pot}bb pot (${((performance.now() - t0) / 1000).toFixed(1)} s)`,
    );
  }

  // A raised pot type whose lines all have the raiser on the same side cannot
  // tell position from initiative: fitPotType pins the initiative edge to 1 and
  // the position edge takes the product (or the ratio), which the model would
  // then apply to the other orientation too (heads-up 3-bet and 4-bet pots).
  // Those keep the committed fit, like pot types with no line at all.
  const fitted = new Set<PotType>();
  const kept = new Set<PotType>();
  for (const potType of new Set(spots.map((s) => s.potType))) {
    const sides = new Set(spots.filter((s) => s.potType === potType).flatMap((s) => s.roles.filter((r) => r.endsWith("Agg"))));
    (potType === "limped" || sides.size === 2 ? fitted : kept).add(potType);
  }
  for (const potType of kept) console.log(`${potType}: the raiser is on one side in every line - keeping the committed fit`);
  const use = spots.map((s, k) => (fitted.has(s.potType) ? k : -1)).filter((k) => k >= 0);
  const fit = fitRealisation(
    use.map((k) => spots[k]),
    use.map((k) => samples[k]),
    cachedEquity(),
    committed,
    "charts/10-floplib-fit",
  );
  fit.model.source =
    `fitted to the flop library's flop+turn+river solves of the charts' own heads-up ranges (raked; rake scaled back out): ` +
    `${[...fitted].join(", ")}; every other pot type keeps the set's committed fit`;
  for (const report of fit.reports) {
    console.log(
      `\n${report.potType}: share RMSE fitted ${report.rmse.fitted.toFixed(3)}, charts/1 ${report.rmse.charts1.toFixed(3)}, equity ${report.rmse.equity.toFixed(3)}; ` +
        `P ${report.positionEdge.toFixed(2)} (charts/2 ${edge(committed, report.potType, "P").toFixed(2)}), I ${report.initiativeEdge.toFixed(2)} (charts/2 ${edge(committed, report.potType, "I").toFixed(2)})`,
    );
    for (const a of report.average) {
      console.log(`  ${a.positions.join(" vs ").padEnd(12)} R measured ${a.measured.map((x) => x.toFixed(2)).join(" / ")}, fitted ${a.fitted.map((x) => x.toFixed(2)).join(" / ")}`);
    }
    for (const g of report.groups) {
      if (g.weight > 0) console.log(`  ${g.seat.padEnd(3)} ${g.group.padEnd(42)} measured ${g.measured.toFixed(2)}  fitted ${g.fitted.toFixed(2)}`);
    }
  }
  console.log(`\nrake growth (final pot / flop pot; the model's RAKE_POT_GROWTH is ${JSON.stringify(RAKE_POT_GROWTH)}):`);
  const rakePotGrowth = measuredRakeGrowth(lines as { potType: PotType; rakeGrowth: number }[]);
  const spec = (["limped", "srp", "3bet", "4bet"] as const).map((t) => rakePotGrowth[t]).join(":");
  console.log(`  CHARTS_RAKE_GROWTH=${spec}`);
  const record = {
    method: "the flop library's chunks: per line, root EV / pot per class over its representative flops (weighted by the flops each stands for), divided by check-down equity on the same flops, times the class's table equity; fitted as charts/2 (docs/CHARTS.md §4.2 step 4)",
    library: { dir: DIR, set: SET, tree: TREE, charts: { id: charts.id, version: charts.version, hash: charts.model.hash } },
    lines,
    reports: fit.reports,
    rakePotGrowth,
    rakePotGrowthMethod:
      "per line, g with min(5% x flop pot x g, 3bb) = the rake its solves took (lines[].rakeGrowth), averaged per pot type with lines weighted equally; 4-bet and all-in keep RAKE_POT_GROWTH; for charts:generate as CHARTS_RAKE_GROWTH=" +
      spec,
  };
  mkdirSync(join(HERE, ".cache"), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ model: { realisation: fit.model, realisationFit: record } }, null, 1));
  console.log(`\nwrote ${OUT}`);
});

/** A committed fit's position (`P`) or initiative (`I`) edge: its roles' combo-weighted mean log weights, as the fit centres them. */
function edge(model: RealisationModel, potType: PotType, which: "P" | "I"): number {
  const mean = (role: RealisationRole) => {
    const w = roleWeights(model, potType, role);
    let s = 0;
    let n = 0;
    for (let i = 0; i < w.length; i += 1) {
      s += CLASS_COMBOS[i] * Math.log(w[i]);
      n += CLASS_COMBOS[i];
    }
    return s / n;
  };
  // ipAgg - oopCaller = ln P + ln I; ipCaller - oopAgg = ln P - ln I.
  const sum = mean("ipAgg") - mean("oopCaller");
  const diff = mean("ipCaller") - mean("oopAgg");
  return Math.exp(which === "P" ? (sum + diff) / 2 : (sum - diff) / 2);
}

/**
 * The final pot / flop pot `g` with `min(percent x pot x g, cap) = rakeBb`
 * under the standard rake. A rake at the cap only bounds `g` from below: the
 * smallest such `g` is returned.
 */
function lineRakeGrowth(pot: number, rakeBb: number): number {
  return Math.min(rakeBb, STANDARD_RAKE.capBb) / (STANDARD_RAKE.percent * pot);
}

/** Per pot type, the mean of its lines' `rakeGrowth` (3 decimals); pot types without a line keep `RAKE_POT_GROWTH`. */
function measuredRakeGrowth(lines: readonly { potType: PotType; rakeGrowth: number }[]): Record<PotType, number> {
  const out: Record<PotType, number> = { ...RAKE_POT_GROWTH };
  for (const potType of Object.keys(out) as PotType[]) {
    const own = lines.filter((l) => l.potType === potType).map((l) => l.rakeGrowth);
    if (!own.length) continue;
    out[potType] = Math.round((own.reduce((a, b) => a + b, 0) / own.length) * 1e3) / 1e3;
    console.log(`  ${potType}: rake growth ${out[potType]} over ${own.length} lines (${Math.min(...own).toFixed(3)} to ${Math.max(...own).toFixed(3)})`);
  }
  return out;
}
