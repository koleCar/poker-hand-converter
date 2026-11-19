/**
 * The v0 runner (docs/PREFLOP-PLAN.md §4.4, P2): solves Rail's 11 draft sets
 * (`railSets.ts`) one at a time with the existing generator (`solve.ts`) and
 * writes OUTSIDE the repo:
 *
 *     <out>/<set-id>/charts.json    the chart set (charts/12-draft)
 *     <out>/<set-id>/summary.json   totals: RFI, SB, BB defence, 3-bet; NashConv, time
 *     <out>/run.log                 every run's log, appended
 *     <out>/run.lock                the running process's pid (one run at a time)
 *     <out>/plan.json               the sets and their estimates, for report.mjs
 *     <out>/../cache/               the equity table (computed once, ~80 s)
 *
 * Run it through `cli.mjs` (it bundles this file):
 *
 *     node tests/scripts/preflop-v0/cli.mjs [--sets a,b] [--out DIR] [--threads 4]
 *         [--iterations N] [--rounds N] [--force] [--dry-run [--probe K]]
 *
 * - **Resumable:** a set whose `summary.json` exists for the same spec,
 *   iterations, rounds and fit is skipped (`--force` solves it again); files
 *   are written to `.tmp` and renamed, `summary.json` last.
 * - **Working hours:** refuses to start Mon-Fri 08:00-16:00 Europe/Zagreb
 *   (exit 2), and does not start a set whose estimate (x1.5) would reach
 *   08:00 on a weekday - it stops cleanly (exit 0) and the next run resumes.
 *   `RAIL_FORCE=1` overrides both. A run estimated under a minute (a
 *   heads-up set at a few hundred iterations: a smoke test) is let through.
 * - **Gentle:** the process lowers its own priority (nice 10; `run-v0.sh`
 *   also starts it under `nice -n 10`); the preflop solve is one thread, and
 *   `--threads` (default 4, `RAIL_THREADS`) caps the turn+river workers of
 *   `--rounds`.
 * - `--dry-run` builds every tree and prints its size; with `--probe K` it
 *   also times K iterations per set and prints the estimated solve time. It
 *   takes no lock, ignores the guard and writes nothing but the equity cache.
 *
 * Exit codes: 0 done or stopped before working hours, 1 error, 2 refused
 * (working hours), 3 another run holds the lock.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { availableParallelism, homedir, hostname, setPriority } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { RAIL_SETS, railSet, type RailSetSpec } from "../../../web/src/lib/charts/railSets.js";
import {
  DEFAULT_EQUITY_BOARDS,
  DEFAULT_EQUITY_SEED,
  preflopEquityTable,
  type PreflopEquityTable,
} from "../../../web/src/lib/solver/preflopEquity.js";
import { workerPool } from "../preflop-charts/pool.js";
import { inWorkingHours, workingHoursConflict } from "./guard.js";
import { probeV0Set, solveV0Set, v0Fit, v0Iterations, v0Tree } from "./solve.js";

/**
 * Estimated minutes per set at its default iterations, without rounds: the
 * dry run's probe (`--probe 20`) on the M2 Pro on 2026-11-19, in working
 * hours under load, rounded up. The first iterations are the slowest (every
 * strategy is still uniform, nothing is pruned), so these are upper bounds;
 * docs/CHARTS.md §10 measured the 6-max 100bb `charts/2` solve at ~3.5 min.
 * The guard multiplies them by `ESTIMATE_MARGIN`.
 */
export const ESTIMATE_MINUTES: Readonly<Record<string, number>> = {
  "rail-hu-100bb": 2,
  "rail-hu-150bb": 2,
  "rail-6max-50bb": 25,
  "rail-6max-100bb": 40,
  "rail-6max-150bb": 25,
  "rail-6max-200bb": 20,
  "rail-6max-100bb-ante": 20,
  "rail-9max-100bb": 130,
  "rail-9max-150bb": 130,
  "rail-9max-100bb-ante": 130,
  "rail-6max-100bb-straddle": 5,
};
const ESTIMATE_MARGIN = 1.5;
/**
 * A run whose pending sets (plus the equity table, if not cached) are
 * estimated under this many minutes is a smoke test (a heads-up set at a few
 * hundred iterations: about a second): the working-hours guard lets it run.
 */
const TINY_RUN_MINUTES = 1;
/** The equity table, when it is not cached yet (~110 s on one core). */
const EQUITY_MINUTES = 2;
/** Rounds add per round about one 1,500-iteration solve plus the turn+river solves; a rough factor. */
const ROUND_FACTOR = 1.5;

const { values } = parseArgs({
  options: {
    sets: { type: "string" },
    out: { type: "string" },
    threads: { type: "string" },
    iterations: { type: "string" },
    rounds: { type: "string" },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    probe: { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(
    "usage: node tests/scripts/preflop-v0/cli.mjs [--sets id,id] [--out DIR] [--threads N] [--iterations N] [--rounds N] [--force] [--dry-run [--probe K]]\n" +
      `sets: ${RAIL_SETS.map((s) => s.id).join(", ")}\n` +
      "default out: ~/Projects/rail-preflop-out/v0. See the header of tests/scripts/preflop-v0/run.ts.",
  );
  process.exit(0);
}

const OUT = resolve(values.out ?? join(homedir(), "Projects/rail-preflop-out/v0"));
const CACHE = join(dirname(OUT), "cache");
const LOG = join(OUT, "run.log");
const LOCK = join(OUT, "run.lock");
const SETS: RailSetSpec[] = values.sets ? values.sets.split(",").map((s) => railSet(s.trim())) : [...RAIL_SETS];
const THREADS = Math.max(1, Math.min(availableParallelism(), Number(values.threads ?? process.env.RAIL_THREADS ?? 4)));
const ITERATIONS = values.iterations ? Number(values.iterations) : undefined;
const ROUNDS = Number(values.rounds ?? 0);
const FORCE_HOURS = process.env.RAIL_FORCE === "1";
const DRY = values["dry-run"];

mkdirSync(OUT, { recursive: true });

function log(line: string): void {
  const stamped = `${new Date().toISOString()} [${process.pid}] ${line}`;
  console.log(stamped);
  if (!DRY) appendFileSync(LOG, `${stamped}\n`);
}

function writeAtomic(file: string, text: string | Uint8Array): void {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

const EQUITY_FILE = join(CACHE, `equity-${DEFAULT_EQUITY_BOARDS}-${DEFAULT_EQUITY_SEED}.bin`);

function equityTable(): PreflopEquityTable {
  const file = EQUITY_FILE;
  const meta = `${file}.json`;
  if (existsSync(file) && existsSync(meta)) {
    const bytes = readFileSync(file);
    const equity = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { equity, ...JSON.parse(readFileSync(meta, "utf8")) };
  }
  const t0 = performance.now();
  const table = preflopEquityTable({ boards: DEFAULT_EQUITY_BOARDS, seed: DEFAULT_EQUITY_SEED });
  log(`equity table: ${DEFAULT_EQUITY_BOARDS} boards in ${((performance.now() - t0) / 1000).toFixed(1)} s, cached in ${CACHE}`);
  mkdirSync(CACHE, { recursive: true });
  writeAtomic(file, Buffer.from(table.equity.buffer));
  writeAtomic(meta, JSON.stringify({ boards: table.boards, seed: table.seed, standardError: table.standardError }));
  return table;
}

/** What a set's result depends on: a changed spec, iteration count, rounds or fit solves it again. */
function runKey(spec: RailSetSpec): string {
  const iterations = ITERATIONS ?? v0Iterations(spec);
  const json = JSON.stringify({ spec, iterations, rounds: ROUNDS, fit: v0Fit(spec).from });
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function estimateMinutes(spec: RailSetSpec): number {
  const base = ESTIMATE_MINUTES[spec.id] ?? 120;
  const scale = (ITERATIONS ?? v0Iterations(spec)) / v0Iterations(spec);
  return base * scale * (ROUNDS > 0 ? 1 + ROUND_FACTOR * ROUNDS : 1);
}

function isDone(spec: RailSetSpec): boolean {
  const file = join(OUT, spec.id, "summary.json");
  if (!existsSync(file)) return false;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { runKey?: string }).runKey === runKey(spec);
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- lock - */

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(): boolean {
  const body = JSON.stringify({ pid: process.pid, host: hostname(), started: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(LOCK, body, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let pid = NaN;
      try {
        pid = Number((JSON.parse(readFileSync(LOCK, "utf8")) as { pid: number }).pid);
      } catch {
        // unreadable: treat as stale
      }
      if (Number.isFinite(pid) && pidAlive(pid)) {
        log(`another run holds ${LOCK} (pid ${pid}); not starting`);
        return false;
      }
      log(`removing stale lock (pid ${Number.isFinite(pid) ? pid : "?"})`);
      unlinkSync(LOCK);
    }
  }
  return false;
}

function releaseLock(): void {
  try {
    const held = JSON.parse(readFileSync(LOCK, "utf8")) as { pid: number };
    if (held.pid === process.pid) unlinkSync(LOCK);
  } catch {
    // gone already
  }
}

/* ---------------------------------------------------------------- main - */

function dryRun(): void {
  const probe = values.probe ? Number(values.probe) : 0;
  const equity = probe > 0 ? equityTable() : null;
  for (const spec of SETS) {
    if (!equity) {
      const tree = v0Tree(spec);
      log(`${spec.id}: ${tree.actionNodes} action nodes, ${tree.size} nodes; fit from ${v0Fit(spec).from}; ${v0Iterations(spec)} iterations; estimate ${estimateMinutes(spec)} min`);
      continue;
    }
    const p = probeV0Set(spec, equity, probe);
    log(
      `${spec.id}: ${p.actionNodes} action nodes; ${(p.secondsPerIteration * 1000).toFixed(1)} ms/iteration, ${p.secondsPerCheckpoint.toFixed(2)} s/checkpoint; ` +
        `~${p.estimateMinutes.toFixed(1)} min for ${v0Iterations(spec)} iterations (table: ${ESTIMATE_MINUTES[spec.id]} min)`,
    );
  }
}

async function main(): Promise<number> {
  if (DRY) {
    dryRun();
    return 0;
  }
  const started = new Date();
  const pending = SETS.filter((s) => values.force || !isDone(s));
  const pendingMinutes =
    pending.reduce((sum, s) => sum + estimateMinutes(s), 0) + (pending.length && !existsSync(EQUITY_FILE) ? EQUITY_MINUTES : 0);
  const tiny = pendingMinutes < TINY_RUN_MINUTES;
  if (inWorkingHours(started) && !FORCE_HOURS && !tiny) {
    log(`refused: ${workingHoursConflict(started, 0)}`);
    return 2;
  }
  if (tiny && inWorkingHours(started)) log(`a smoke run (~${pendingMinutes.toFixed(2)} min estimated): the working-hours guard lets it run`);
  if (!acquireLock()) return 3;
  const cleanup = (signal: string, code: number) => {
    log(`stopped by ${signal}; the set in progress is solved again next run`);
    releaseLock();
    process.exit(code);
  };
  process.on("SIGINT", () => cleanup("SIGINT", 130));
  process.on("SIGTERM", () => cleanup("SIGTERM", 143));
  try {
    setPriority(10);
  } catch {
    // already lower, or not allowed: run-v0.sh starts it under nice anyway
  }
  try {
    log(
      `run started: ${SETS.length} sets, out ${OUT}, threads ${THREADS} (turn+river workers, --rounds only), rounds ${ROUNDS}, iterations ${ITERATIONS ?? "default"}${FORCE_HOURS ? ", RAIL_FORCE=1" : ""}`,
    );
    writeAtomic(
      join(OUT, "plan.json"),
      JSON.stringify(
        { written: started.toISOString(), sets: SETS.map((s) => ({ id: s.id, estimateMinutes: estimateMinutes(s), runKey: runKey(s) })) },
        null,
        2,
      ),
    );
    let equity: PreflopEquityTable | null = null;
    let solved = 0;
    for (const spec of SETS) {
      if (!values.force && isDone(spec)) {
        log(`${spec.id}: done already, skipped`);
        continue;
      }
      const minutes = estimateMinutes(spec) * ESTIMATE_MARGIN;
      const conflict = FORCE_HOURS || tiny ? null : workingHoursConflict(new Date(), minutes);
      if (conflict) {
        log(`${spec.id}: not started - ${conflict}; the next run resumes here`);
        break;
      }
      equity ??= equityTable();
      const dir = join(OUT, spec.id);
      mkdirSync(dir, { recursive: true });
      log(`${spec.id}: started (estimate ${estimateMinutes(spec).toFixed(0)} min)`);
      const t0 = performance.now();
      const result = await solveV0Set(spec, {
        equity,
        iterations: ITERATIONS,
        rounds: ROUNDS,
        run: ROUNDS > 0 ? workerPool(THREADS, (line) => log(`[${spec.id}] ${line}`), spec.id, process.env.RAIL_V0_WORKER) : undefined,
        log: (line) => log(`[${spec.id}] ${line}`),
      });
      const seconds = (performance.now() - t0) / 1000;
      writeAtomic(join(dir, "charts.json"), result.text);
      const model = result.charts.model as { hash: string; convergence: { nashConvMbb: number; rakeBbPerHand: number } };
      const summary = {
        id: spec.id,
        version: spec.version,
        runKey: runKey(spec),
        finished: new Date().toISOString(),
        seconds: Math.round(seconds),
        iterations: result.iterations,
        rounds: result.rounds,
        fitFrom: result.fitFrom,
        hash: model.hash,
        nashConvMbb: model.convergence.nashConvMbb,
        rakeBbPerHand: model.convergence.rakeBbPerHand,
        actionNodes: result.result.tree.actionNodes,
        nodes: result.charts.nodes.length,
        totals: result.totals,
      };
      writeAtomic(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
      log(`${spec.id}: done in ${(seconds / 60).toFixed(1)} min; NashConv ${summary.nashConvMbb} mbb/hand; RFI ${JSON.stringify(result.totals.rfi)}`);
      solved += 1;
    }
    const left = SETS.filter((s) => !isDone(s)).map((s) => s.id);
    log(`run finished: ${solved} solved, ${left.length} left${left.length ? ` (${left.join(", ")})` : ""}`);
    return 0;
  } finally {
    releaseLock();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    releaseLock();
    process.exit(1);
  },
);
