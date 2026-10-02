/**
 * Evidence for the short-handed reading (docs/CHARTS.md §6.2): solve a
 * `k`-handed game natively, with the realisation model, sizes and depth of a
 * committed bigger set, and compare it with that set read with its earliest
 * seats folded - against the noise floor of two native solves that differ
 * only in iteration count.
 *
 *     cd tests && npm run charts:compare                         # 8-handed vs 9-max 100bb
 *     COMPARE_PLAYERS=7 COMPARE_SET=nlhe-cash-9max-100bb npm run charts:compare
 *
 * Not part of `npm test` (a native 8-max solve takes half an hour).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import { generateChartSet, PRODUCTION_ITERATIONS } from "../../../frontend/src/lib/charts/generate.js";
import { loadCharts } from "../../../frontend/src/lib/charts/format.js";
import { DEFAULT_EQUITY_BOARDS, DEFAULT_EQUITY_SEED } from "../../../frontend/src/lib/solver/preflopEquity.js";
import type { RealisationModel } from "../../../frontend/src/lib/solver/preflopModel.js";
import type { PreflopPosition, PreflopSizing } from "../../../frontend/src/lib/solver/preflopTree.js";
import { compareSets, type SetComparison } from "./compare.js";

const HERE = import.meta.dirname;
const SET = process.env.COMPARE_SET ?? "nlhe-cash-9max-100bb";
const PLAYERS = Number(process.env.COMPARE_PLAYERS ?? 8);
const ITERATIONS = Number(process.env.COMPARE_ITERATIONS ?? PRODUCTION_ITERATIONS);

function equity() {
  const file = join(HERE, `.cache/equity-${DEFAULT_EQUITY_BOARDS}-${DEFAULT_EQUITY_SEED}.bin`);
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  return {
    equity: new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    ...JSON.parse(readFileSync(`${file}.json`, "utf8")),
  };
}

const show = (name: string, c: SetComparison) =>
  [
    `${name}: ${c.matched} of ${c.nodes} nodes matched`,
    `  per-class frequency difference (reach-weighted mean of L1/2): ${(100 * c.freqDiff).toFixed(2)}%`,
    `  largest action-share difference at a node reached >= 1e-3: ${(100 * c.worstShare.diff).toFixed(2)} pts at ${JSON.stringify(c.worstShare.line)}`,
    `  mean |EV difference|: ${c.evDiff.toFixed(3)} bb`,
    `  RFI: ${c.rfi.map((r) => `${r.seat} ${(100 * r.small).toFixed(1)} / ${(100 * r.big).toFixed(1)}`).join(", ")}`,
  ].join("\n");

it("compares a native short-handed solve with the bigger set read short-handed", () => {
  const big = loadCharts(JSON.parse(readFileSync(join(HERE, `../../../frontend/src/lib/charts/data/${SET}.json`), "utf8")));
  const model = big.model as { realisation: RealisationModel; tree: { sizing: PreflopSizing; maxEntrants: number } };
  const players = big.game.positions.slice(big.game.positions.length - PLAYERS) as PreflopPosition[];
  const table = equity();
  const solve = (iterations: number) =>
    generateChartSet({
      id: `native-${PLAYERS}`,
      players,
      stackBb: big.game.stackBb,
      sizing: model.tree.sizing,
      maxEntrants: model.tree.maxEntrants,
      realisation: { name: model.realisation.name, source: model.realisation.source, potTypes: model.realisation.potTypes },
      equity: table,
      iterations,
      checkEvery: iterations,
      headsUpIterations: 0,
    });
  const t0 = performance.now();
  const native = loadCharts(solve(ITERATIONS).charts);
  const t1 = performance.now();
  const shorter = loadCharts(solve(Math.round(ITERATIONS * 0.8)).charts);
  const t2 = performance.now();
  console.log(
    [
      `native ${PLAYERS}-handed (${players.join(", ")}) at ${big.game.stackBb}bb with ${SET}'s model: ${((t1 - t0) / 60_000).toFixed(1)} min, ${native.nodes.size} nodes`,
      show(`native vs ${SET} with ${big.game.positions.length - PLAYERS} folded`, compareSets(native, big)),
      show(`noise floor: native ${ITERATIONS} vs ${Math.round(ITERATIONS * 0.8)} iterations (${((t2 - t1) / 60_000).toFixed(1)} min)`, compareSets(native, shorter)),
    ].join("\n"),
  );
});
