/**
 * Generates the committed preflop chart sets,
 * `frontend/src/lib/charts/data/<id>.json` (configs in `sets.ts`).
 *
 *     cd tests && npm run charts:generate                       # every set
 *     CHARTS_SETS=nlhe-cash-9max-100bb npm run charts:generate  # one set
 *     CHARTS_PARALLEL=4 npm run charts:generate                 # four at a time
 *
 * Per set, the `charts/2` pipeline (`generateRealisedChartSet`, docs/CHARTS.md
 * §4): rounds of preflop solve -> turn+river solves of the charts' own
 * heads-up ranges (on worker threads) -> fit of the realisation model; then
 * the final solve. Deterministic: the equity sample and the deals are seeded
 * and the solvers read no clock, so a rerun with the same code writes the
 * same bytes (the script says whether each file changed). The equity table is
 * cached in `.cache/` (git-ignored) because it depends only on its boards and
 * seed.
 *
 * **Parallel.** A preflop solve is single-threaded, so with `CHARTS_PARALLEL`
 * above 1 and more than one set this process runs one child process per set
 * (at most that many at once), splits `CHARTS_THREADS` between them for the
 * turn+river workers, writes each child's log to `.cache/logs/<id>.log`, and
 * prints each set's summary when it finishes. Results do not depend on the
 * split.
 *
 * Environment (for experiments; the committed sets use the defaults):
 * `CHARTS_SETS`, `CHARTS_PARALLEL`, `CHARTS_ITERATIONS`, `CHARTS_BOARDS`,
 * `CHARTS_OUT` (one set only), `CHARTS_ROUNDS`, `CHARTS_ROUND_ITERATIONS`,
 * `CHARTS_MEASURE_BOARDS`, `CHARTS_THREADS`; `CHARTS_NO_CACHE=1` re-solves the
 * realisation spots instead of reading `.cache/realisation-*.json` (keyed by
 * the jobs, not by the code).
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

import { generateChartSet, PRODUCTION_ITERATIONS, type GenerateResult } from "../../../frontend/src/lib/charts/generate.js";
import { loadCharts, serializeCharts } from "../../../frontend/src/lib/charts/format.js";
import { nodeReaches } from "../../../frontend/src/lib/charts/build.js";
import {
  generateRealisedChartSet,
  PRODUCTION_MEASURE,
  PRODUCTION_ROUND_ITERATIONS,
} from "../../../frontend/src/lib/charts/realisation.js";
import {
  DEFAULT_EQUITY_BOARDS,
  DEFAULT_EQUITY_SEED,
  preflopEquityTable,
  type PreflopEquityTable,
} from "../../../frontend/src/lib/solver/preflopEquity.js";
import { CHARTS1_REALISATION, type RealisationModel } from "../../../frontend/src/lib/solver/preflopModel.js";
import { cachedRun, workerPool } from "./pool.js";
import { report } from "./report.js";
import { SET_CONFIGS, setConfig, type SetConfig } from "./sets.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const DATA = join(ROOT, "frontend/src/lib/charts/data");
const SETS = (process.env.CHARTS_SETS ?? SET_CONFIGS.map((c) => c.id).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(setConfig);
const PARALLEL = Math.max(1, Number(process.env.CHARTS_PARALLEL ?? 1));
const ITERATIONS = Number(process.env.CHARTS_ITERATIONS ?? PRODUCTION_ITERATIONS);
const BOARDS = Number(process.env.CHARTS_BOARDS ?? DEFAULT_EQUITY_BOARDS);
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

/** `charts/2`'s fitted realisation model, read from the committed 6-max 100bb set. */
function charts2Fit(): RealisationModel {
  const json = JSON.parse(readFileSync(join(DATA, "nlhe-cash-6max-100bb.json"), "utf8"));
  const recorded = json.model.realisation as RealisationModel;
  return { name: recorded.name, source: recorded.source, potTypes: recorded.potTypes };
}

/**
 * The committed set's own fitted realisation model and its record, for a
 * `reuseFit` set (`charts/4`): solved once with it, no new rounds. The record
 * is carried over with `reusedBy` set (replaced, never nested), so the
 * regenerated file reads back the same model and a rerun writes the same bytes.
 */
function committedFit(config: SetConfig): { model: RealisationModel; record: Record<string, unknown> } {
  const json = JSON.parse(readFileSync(join(DATA, `${config.id}.json`), "utf8"));
  const recorded = json.model.realisation as RealisationModel;
  const record = { ...(json.model.realisationFit as Record<string, unknown>) };
  record.reusedBy =
    "charts/4 (A2d): the limp tree solved once with this set's committed fit, not re-measured (docs/CHARTS.md §6.7)";
  return { model: { name: recorded.name, source: recorded.source, potTypes: recorded.potTypes }, record };
}

async function generateSet(config: SetConfig, threads: number): Promise<void> {
  const out = SETS.length === 1 && process.env.CHARTS_OUT ? process.env.CHARTS_OUT : join(DATA, `${config.id}.json`);
  const rounds = config.reuseFit ? 0 : Number(process.env.CHARTS_ROUNDS ?? config.rounds);
  const started = performance.now();
  const equity = cachedEquity();
  const log = (line: string) => console.log(`[${config.id}] ${line}`);
  let last = performance.now();
  const onProgress = (p: { phase: string; iteration?: number; nashConvMbb?: number }) => {
    if (p.phase === "solve") {
      const now = performance.now();
      log(`iteration ${p.iteration}: NashConv ${p.nashConvMbb?.toFixed(2)} mbb/hand (${((now - last) / 1000).toFixed(1)} s)`);
      last = now;
    }
  };
  const limps = {
    maxLimpers: config.maxLimpers,
    limpFloor: config.limpFloor,
    minLimpReach: config.minLimpReach,
    ...(config.straddle ? { straddle: config.straddle } : {}),
  };
  let result: GenerateResult;
  if (config.reuseFit) {
    const fit = committedFit(config);
    result = generateChartSet({
      id: config.id,
      version: config.version,
      players: config.players,
      stackBb: config.stackBb,
      sizing: config.sizing,
      ...limps,
      equity,
      equityBoards: BOARDS,
      iterations: ITERATIONS,
      realisation: fit.model,
      realisationFit: fit.record,
      onProgress,
    });
  } else result = await generateRealisedChartSet({
    id: config.id,
    version: config.version,
    players: config.players,
    stackBb: config.stackBb,
    sizing: config.sizing,
    equity,
    equityBoards: BOARDS,
    iterations: ITERATIONS,
    rounds,
    roundIterations: ROUND_ITERATIONS,
    measure: { boards: MEASURE_BOARDS },
    start: config.start === "charts/1" ? CHARTS1_REALISATION : charts2Fit(),
    fitName: config.fitName,
    ...limps,
    run: process.env.CHARTS_NO_CACHE ? workerPool(threads, log, config.id) : cachedRun(workerPool(threads, log, config.id), log),
    onRound: (round) => {
      const now = performance.now();
      log(`round ${round.round}: ${round.jobs} turn+river solves; ${((now - last) / 1000).toFixed(0)} s`);
      log(`  widths under this round's solve: ${JSON.stringify(round.widths)}`);
      for (const fit of round.fit) {
        log(
          `  ${fit.potType}: rmse fitted ${fit.rmse.fitted} / charts/1 ${fit.rmse.charts1} / equity ${fit.rmse.equity}; P ${fit.positionEdge} I ${fit.initiativeEdge}`,
        );
        for (const a of fit.average) {
          log(`    ${a.line.padEnd(14)} ${a.positions.join(" v ")}: R measured ${a.measured.join(" / ")}  fitted ${a.fitted.join(" / ")}`);
        }
        for (const g of fit.groups) {
          log(`    ${g.seat.padEnd(3)} ${g.group.padEnd(42)} R measured ${g.measured.toFixed(3)}  fitted ${g.fitted.toFixed(3)}  (weight ${g.weight})`);
        }
      }
      last = now;
    },
    onProgress,
  });
  const text = serializeCharts(result.charts);
  const previous = existsSync(out) ? readFileSync(out, "utf8") : null;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  const seconds = (performance.now() - started) / 1000;

  const charts = loadCharts(JSON.parse(text));
  const lines: string[] = [];
  lines.push(`\n=== preflop charts: ${config.id} ===`);
  lines.push(`file: ${out}`);
  lines.push(`bytes: ${Buffer.byteLength(text)}; nodes: ${charts.nodes.size} of ${result.tree.actionNodes}`);
  lines.push(`changed: ${previous === null ? "new file" : previous === text ? "no (identical bytes)" : "yes"}`);
  lines.push(`time: ${seconds.toFixed(1)} s (${rounds} rounds, final ${result.solver.iterations} iterations, ${threads} threads); tree ${result.tree.actionNodes} action nodes; rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
  lines.push(`NashConv: ${result.final.nashConvMbb.toFixed(3)} mbb/hand; per position ${result.final.gainMbb.map((g, k) => `${result.tree.players[k]} ${g.toFixed(3)}`).join(", ")}`);
  lines.push(`history: ${result.convergence.map((c) => `${c.iteration}:${c.nashConvMbb}`).join(" ")}`);
  lines.push(`heads-up BvB: ${JSON.stringify(result.headsUp)}`);
  lines.push(`strategy change per checkpoint: ${result.convergence.map((c) => `${c.iteration}:${c.strategyChange}`).join(" ")}`);
  lines.push(report(charts));
  const reaches = nodeReaches(result.solver);
  const counts = [1e-3, 1e-4, 2e-5, 1e-5, 1e-6, 0].map((t) => `>=${t}: ${Array.from(reaches).filter((r) => r >= t).length}`);
  lines.push(`action nodes by reach: ${counts.join(", ")}`);
  const excluded = (result.charts.model as { excluded: { unconverged: unknown[] } }).excluded.unconverged;
  lines.push(`left out as unconverged: ${excluded.length} ${JSON.stringify(excluded)}`);
  lines.push(`realisation model: ${JSON.stringify((result.charts.model as { realisation: unknown }).realisation)}`);
  console.log(lines.join("\n"));
}

/** Runs each set in its own child process, `PARALLEL` at a time. */
async function generateInChildren(sets: readonly SetConfig[]): Promise<void> {
  const logs = join(HERE, ".cache/logs");
  mkdirSync(logs, { recursive: true });
  const threads = Math.max(1, Math.floor(THREADS / Math.min(PARALLEL, sets.length)));
  const vitest = join(ROOT, "tests/node_modules/vitest/vitest.mjs");
  const queue = [...sets];
  const failures: string[] = [];
  const runOne = (config: SetConfig) =>
    new Promise<void>((resolve) => {
      const file = join(logs, `${config.id}.log`);
      const stream = createWriteStream(file);
      const started = performance.now();
      console.log(`${config.id}: started (${threads} threads), log ${file}`);
      const child = spawn(
        process.execPath,
        [vitest, "run", "--config", join(HERE, "vitest.config.ts"), "generate"],
        {
          cwd: join(ROOT, "tests"),
          env: { ...process.env, CHARTS_SETS: config.id, CHARTS_PARALLEL: "1", CHARTS_THREADS: String(threads) },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.pipe(stream, { end: false });
      child.stderr.pipe(stream, { end: false });
      child.on("close", (code) => {
        stream.end();
        const minutes = ((performance.now() - started) / 60_000).toFixed(1);
        console.log(`${config.id}: ${code === 0 ? "done" : `FAILED (${code})`} in ${minutes} min`);
        if (code !== 0) failures.push(config.id);
        resolve();
      });
    });
  const lanes = Array.from({ length: Math.min(PARALLEL, sets.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await runOne(next);
  });
  await Promise.all(lanes);
  if (failures.length) throw new Error(`chart sets failed: ${failures.join(", ")} (see .cache/logs/)`);
}

it("generates the chart sets", async () => {
  if (SETS.length > 1 && PARALLEL > 1) {
    await generateInChildren(SETS);
    return;
  }
  for (const config of SETS) await generateSet(config, THREADS);
});
