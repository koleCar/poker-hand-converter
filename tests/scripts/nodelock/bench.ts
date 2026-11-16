/**
 * Wall time of one real flop-m1 solve, sequential and split over worker
 * threads (`docs/NODELOCK.md` §0): the same partition and the same code the
 * app's worker engine runs (`SplitCoordinator` here, `SplitPart` per
 * worker), in Node.
 *
 *     cd tests && node scripts/nodelock/cli.mjs --mode par --threads 9
 *     cd tests && node scripts/nodelock/cli.mjs --mode seq --iterations 10
 *
 * Options: `--set` (nlhe-cash-6max-100bb), `--line` (btn-bb), `--flop`
 * (Ks5h3s), `--mode` seq | par | check (default par), `--threads` (cores - 1),
 * `--iterations` N (a fixed count instead of the profile's 1% target),
 * `--target` pct (default the profile's). `check` runs both at a fixed
 * count and compares the exploitability bit for bit.
 */
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import { nodelockSpot } from "../../../web/src/lib/analysis/flopJob.js";
import { FLOP_PROFILE } from "../../../web/src/lib/analysis/flopLibrary.js";
import { loadCharts } from "../../../web/src/lib/charts/index.js";
import {
  driveAsync,
  SplitCoordinator,
  splitCards,
  solveFlop,
  type RunOptions,
  type SplitSpec,
  type SplitStep,
  type UnitValues,
} from "../../../web/src/lib/solver/index.js";

const ROOT = resolve(process.env.NODELOCK_ROOT ?? join(process.cwd(), ".."));
const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const set = arg("set", "nlhe-cash-6max-100bb");
const line = arg("line", "btn-bb");
const flop = arg("flop", "Ks5h3s");
const mode = arg("mode", "par");
const threads = Number(arg("threads", String(Math.max(1, availableParallelism() - 1))));
const fixed = process.argv.includes("--iterations") ? Number(arg("iterations", "10")) : null;
const target = Number(arg("target", String(FLOP_PROFILE.targetPct)));

const log = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);
const charts = loadCharts(JSON.parse(readFileSync(join(ROOT, "web/src/lib/charts/data", `${set}.json`), "utf8")));
const spot = nodelockSpot(charts, line, flop);
const spec: SplitSpec = { spot, dcfr: FLOP_PROFILE.dcfr, storage: "i16" };
const options: RunOptions = {
  maxIterations: fixed ?? FLOP_PROFILE.maxIterations,
  targetExploitability: fixed ? 0 : target,
  checkFrom: fixed ?? FLOP_PROFILE.checkFrom,
  checkEvery: fixed ?? FLOP_PROFILE.checkEvery,
};
const rssGb = () => (process.resourceUsage().maxRSS / 1024 / 1e3).toFixed(2);

async function sequential(): Promise<number> {
  const started = performance.now();
  let built = 0;
  const solved = solveFlop(spot, {
    ...options,
    dcfr: FLOP_PROFILE.dcfr,
    storage: "i16",
    now: () => performance.now(),
    onIteration: (p) => {
      if (p.iteration === 1) built = performance.now();
      if (p.iteration % 5 === 0) log(`  seq iteration ${p.iteration}, ${(p.elapsedMs / 1000).toFixed(0)} s, exploitability ${Number.isFinite(p.exploitabilityPct) ? p.exploitabilityPct.toFixed(3) : "-"}%`);
    },
  });
  const seconds = (performance.now() - started) / 1000;
  log(
    `sequential: ${solved.run.iterations} iterations to ${solved.result.exploitabilityPct.toFixed(3)}% (${solved.run.stoppedBy}) in ${seconds.toFixed(1)} s ` +
      `(${((performance.now() - built) / 1000 / Math.max(1, solved.run.iterations - 1)).toFixed(2)} s per iteration after the first), solver ${(solved.stats.solverBytes / 1e9).toFixed(2)} GB, peak rss ${rssGb()} GB`,
  );
  return solved.result.exploitabilityPct;
}

async function parallel(): Promise<number> {
  const started = performance.now();
  const coordinator = new SplitCoordinator(spec, []);
  const groups = splitCards(coordinator.built, threads);
  const workers = groups.map(() => new Worker(new URL("./worker.mjs", import.meta.url)));
  let seq = 0;
  const pending = new Map<number, (value: unknown) => void>();
  for (const worker of workers) {
    worker.on("message", (message: { id: number }) => {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
  }
  const call = <T>(worker: Worker, message: object): Promise<T> =>
    new Promise((resolve) => {
      const id = (seq += 1);
      pending.set(id, resolve as (value: unknown) => void);
      worker.postMessage({ ...message, id });
    });
  const ready = await Promise.all(workers.map((w, i) => call<{ bytes: number; valueSum: number | null }>(w, { type: "part", spec, cards: groups[i] })));
  coordinator.setPartSums(ready.map((r) => r.valueSum));
  const partBytes = ready.reduce((s, r) => s + r.bytes, 0);
  const builtAt = performance.now();
  log(`parallel: ${groups.length} parts built in ${((builtAt - started) / 1000).toFixed(1)} s (turn cards per part ${groups.map((g) => g.length).join("/")}), solver ${(partBytes / 1e9).toFixed(2)} GB`);
  const traverse = async (step: SplitStep): Promise<UnitValues[]> =>
    (await Promise.all(workers.map((w) => call<{ values: UnitValues }>(w, { type: "traverse", step })))).map((a) => a.values);
  let firstAt = 0;
  const run = await driveAsync(
    coordinator.run({
      ...options,
      onIteration: (iteration) => {
        if (iteration === 1) firstAt = performance.now();
        if (iteration % 5 === 0) log(`  par iteration ${iteration}, ${((performance.now() - started) / 1000).toFixed(0)} s`);
      },
      onProgress: (p) => log(`  par measured ${p.exploitability.percentPot.toFixed(3)}% at ${p.iteration}`),
    }),
    traverse,
  );
  const result = await driveAsync(coordinator.result(run, partBytes), traverse);
  const seconds = (performance.now() - started) / 1000;
  log(
    `parallel (${groups.length} threads): ${run.iterations} iterations to ${result.exploitabilityPct.toFixed(3)}% (${run.stoppedBy}) in ${seconds.toFixed(1)} s ` +
      `(build ${((builtAt - started) / 1000).toFixed(1)} s, ${((performance.now() - firstAt) / 1000 / Math.max(1, run.iterations - 1)).toFixed(2)} s per iteration after the first), peak rss ${rssGb()} GB`,
  );
  await Promise.all(workers.map((w) => w.terminate()));
  return result.exploitabilityPct;
}

log(`nodelock bench: ${set} ${line} ${flop}, mode ${mode}, ${threads} threads, ${fixed ? `${fixed} iterations` : `target ${target}%`}`);
if (mode === "seq") await sequential();
else if (mode === "par") await parallel();
else {
  const a = await parallel();
  const b = await sequential();
  log(a === b ? `bit-identical: both ${a}` : `DIFFERENT: parallel ${a}, sequential ${b}`);
  if (a !== b) process.exitCode = 1;
}
