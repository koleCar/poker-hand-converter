/**
 * Generates the committed preflop chart set:
 * `frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json`.
 *
 *     cd tests && npm run charts:generate
 *
 * The `charts/2` pipeline (`generateRealisedChartSet`, docs/CHARTS.md §4):
 * rounds of preflop solve -> turn+river solves of the charts' own heads-up
 * ranges (on worker threads) -> fit of the realisation model; then the final
 * solve. Deterministic: the equity sample and the deals are seeded and the
 * solvers read no clock, so a rerun with the same code writes the same bytes
 * (the script says whether the file changed). The equity table is cached in
 * `.cache/` (git-ignored) because it depends only on its boards and seed.
 *
 * Environment (for experiments; the committed set uses the defaults):
 * `CHARTS_ITERATIONS`, `CHARTS_BOARDS`, `CHARTS_OUT`, `CHARTS_ROUNDS`,
 * `CHARTS_ROUND_ITERATIONS`, `CHARTS_MEASURE_BOARDS`, `CHARTS_THREADS`;
 * `CHARTS_NO_CACHE=1` re-solves the realisation spots instead of reading
 * `.cache/realisation-*.json` (keyed by the jobs, not by the code).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

import { PRODUCTION_ITERATIONS } from "../../../frontend/src/lib/charts/generate.js";
import { loadCharts, serializeCharts } from "../../../frontend/src/lib/charts/format.js";
import { nodeReaches } from "../../../frontend/src/lib/charts/build.js";
import {
  generateRealisedChartSet,
  PRODUCTION_MEASURE,
  PRODUCTION_ROUND_ITERATIONS,
  PRODUCTION_ROUNDS,
} from "../../../frontend/src/lib/charts/realisation.js";
import {
  DEFAULT_EQUITY_BOARDS,
  DEFAULT_EQUITY_SEED,
  preflopEquityTable,
  type PreflopEquityTable,
} from "../../../frontend/src/lib/solver/preflopEquity.js";
import { cachedRun, workerPool } from "./pool.js";
import { report } from "./report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const OUT = process.env.CHARTS_OUT ?? join(ROOT, "frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json");
const ITERATIONS = Number(process.env.CHARTS_ITERATIONS ?? PRODUCTION_ITERATIONS);
const BOARDS = Number(process.env.CHARTS_BOARDS ?? DEFAULT_EQUITY_BOARDS);
const ROUNDS = Number(process.env.CHARTS_ROUNDS ?? PRODUCTION_ROUNDS);
const ROUND_ITERATIONS = Number(process.env.CHARTS_ROUND_ITERATIONS ?? PRODUCTION_ROUND_ITERATIONS);
const MEASURE_BOARDS = Number(process.env.CHARTS_MEASURE_BOARDS ?? PRODUCTION_MEASURE.boards);
const THREADS = Number(process.env.CHARTS_THREADS ?? availableParallelism());

function cachedEquity(): PreflopEquityTable {
  const dir = join(HERE, ".cache");
  const file = join(dir, `equity-${BOARDS}-${DEFAULT_EQUITY_SEED}.bin`);
  const meta = `${file}.json`;
  if (existsSync(file) && existsSync(meta)) {
    const bytes = readFileSync(file);
    const equity = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { equity, ...JSON.parse(readFileSync(meta, "utf8")) };
  }
  const t0 = performance.now();
  const table = preflopEquityTable({ boards: BOARDS, seed: DEFAULT_EQUITY_SEED });
  console.log(`equity table: ${BOARDS} boards in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, Buffer.from(table.equity.buffer));
  writeFileSync(meta, JSON.stringify({ boards: table.boards, seed: table.seed, standardError: table.standardError }));
  return table;
}

it("generates the 6-max 100bb chart set", async () => {
  const started = performance.now();
  const equity = cachedEquity();
  let last = performance.now();
  const result = await generateRealisedChartSet({
    equity,
    equityBoards: BOARDS,
    iterations: ITERATIONS,
    rounds: ROUNDS,
    roundIterations: ROUND_ITERATIONS,
    measure: { boards: MEASURE_BOARDS },
    run: process.env.CHARTS_NO_CACHE ? workerPool(THREADS) : cachedRun(workerPool(THREADS)),
    onRound: (round) => {
      const now = performance.now();
      console.log(`round ${round.round}: ${round.jobs} turn+river solves; ${((now - last) / 1000).toFixed(0)} s`);
      console.log(`  widths under this round's solve: ${JSON.stringify(round.widths)}`);
      for (const fit of round.fit) {
        console.log(
          `  ${fit.potType}: rmse fitted ${fit.rmse.fitted} / charts/1 ${fit.rmse.charts1} / equity ${fit.rmse.equity}; P ${fit.positionEdge} I ${fit.initiativeEdge}`,
        );
        for (const a of fit.average) {
          console.log(`    ${a.line.padEnd(11)} ${a.positions.join(" v ")}: R measured ${a.measured.join(" / ")}  fitted ${a.fitted.join(" / ")}`);
        }
        for (const g of fit.groups) {
          console.log(`    ${g.seat.padEnd(3)} ${g.group.padEnd(42)} R measured ${g.measured.toFixed(3)}  fitted ${g.fitted.toFixed(3)}  (weight ${g.weight})`);
        }
      }
      last = now;
    },
    onProgress: (p) => {
      if (p.phase === "solve") {
        const now = performance.now();
        console.log(`iteration ${p.iteration}: NashConv ${p.nashConvMbb?.toFixed(2)} mbb/hand (${((now - last) / 1000).toFixed(1)} s)`);
        last = now;
      }
    },
  });
  const text = serializeCharts(result.charts);
  const previous = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  const seconds = (performance.now() - started) / 1000;

  const charts = loadCharts(JSON.parse(text));
  console.log("\n=== preflop charts ===");
  console.log(`file: ${OUT}`);
  console.log(`bytes: ${Buffer.byteLength(text)}; nodes: ${charts.nodes.size} of ${result.tree.actionNodes}`);
  console.log(`changed: ${previous === null ? "new file" : previous === text ? "no (identical bytes)" : "yes"}`);
  console.log(`time: ${seconds.toFixed(1)} s (${ROUNDS} rounds, final ${result.solver.iterations} iterations, ${THREADS} threads)`);
  console.log(`NashConv: ${result.final.nashConvMbb.toFixed(3)} mbb/hand; per position ${result.final.gainMbb.map((g) => g.toFixed(3)).join(", ")}`);
  console.log(`history: ${result.convergence.map((c) => `${c.iteration}:${c.nashConvMbb}`).join(" ")}`);
  console.log(`heads-up BvB: ${JSON.stringify(result.headsUp)}`);
  console.log(`strategy change per checkpoint: ${result.convergence.map((c) => `${c.iteration}:${c.strategyChange}`).join(" ")}`);
  console.log(report(charts));
  const reaches = nodeReaches(result.solver);
  const counts = [1e-3, 1e-4, 2e-5, 1e-5, 1e-6, 0].map(
    (t) => `>=${t}: ${Array.from(reaches).filter((r) => r >= t).length}`,
  );
  console.log(`action nodes by reach: ${counts.join(", ")}`);
  const excluded = (result.charts.model as { excluded: { unconverged: unknown[] } }).excluded.unconverged;
  console.log(`left out as unconverged: ${excluded.length} ${JSON.stringify(excluded)}`);
  console.log(`realisation model: ${JSON.stringify((result.charts.model as { realisation: unknown }).realisation)}`);
});
