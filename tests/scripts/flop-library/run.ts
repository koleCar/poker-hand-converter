/**
 * The flop library batch runner (phase A5b): a resumable queue of
 * (line, flop) solves on disk, one solve per process.
 *
 *     cd tests && npm run floplib -- --only 4 --threads 4     # a pilot
 *     cd tests && npm run floplib -- --estimate               # what the full run costs
 *     cd tests && npm run floplib                             # the full run (hours to days)
 *
 * See `README.md` next to this file for every option.
 *
 * **Resumable.** Each finished solve is a chunk file plus a stats file under
 * `<out>/<set>/<tree>/<line>/`; both are written atomically by the solving
 * process. A job whose chunk exists is done. Stopping the runner (Ctrl-C)
 * kills the solves in flight and loses only them; the next run picks up the
 * rest. `manifest.json` is rebuilt from the stats files after every solve.
 *
 * **Deterministic.** A chunk depends only on its job (ranges from the chart
 * set, the flop, the profile): rerunning a job writes the same bytes. Times
 * and memory are in the stats files and the manifest, never in a chunk.
 */

import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";

import { FLOP_PROFILE, flopLinesFor, type FlopLine } from "../../../frontend/src/lib/analysis/flopLibrary.js";
import { rakeOf } from "../../../frontend/src/lib/analysis/river.js";
import { loadCharts, type ChartSet } from "../../../frontend/src/lib/charts/index.js";
import {
  boardSymmetries,
  cardOrbit,
  chunkPath,
  comboHi,
  comboLo,
  FLOP_REPRESENTATIVES,
  FLOPLIB_VERSION,
  flopIndices,
  flopKey,
  NUM_COMBOS,
  representativeCoverage,
  SOLVER_VERSION,
  type FlopManifest,
  type FlopManifestEntry,
} from "../../../frontend/src/lib/solver/index.js";
import type { Job } from "./job.js";
import { lineSpot, type LineSpot } from "./spots.js";
import { validateDir } from "./validate.js";

interface Options {
  out: string;
  set: string;
  lines: string[] | null;
  flops: string[];
  only: number | null;
  threads: number;
  memGb: number;
  estimate: boolean;
  validate: boolean;
  dry: boolean;
  progressSec: number;
}

const ROOT = resolve(process.env.FLOPLIB_ROOT ?? join(process.cwd(), ".."));

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const list = (value: string | undefined) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : null);
  const coverage = representativeCoverage();
  const byWeight = [...FLOP_REPRESENTATIVES].sort((a, b) => (coverage.get(b)?.flops ?? 0) - (coverage.get(a)?.flops ?? 0) || (a < b ? -1 : 1));
  return {
    out: resolve(get("out") ?? join(ROOT, "tests/scripts/flop-library/out")),
    set: get("set") ?? "nlhe-cash-6max-100bb",
    lines: list(get("lines")),
    flops: (list(get("flops")) ?? byWeight).map((f) => flopKey(f.match(/../g) ?? [])),
    only: get("only") ? Number(get("only")) : null,
    threads: Number(get("threads") ?? Math.max(1, Math.floor(availableParallelism() / 2))),
    memGb: Number(get("mem") ?? Math.round(totalmem() / 2 / 1e9)),
    estimate: has("estimate"),
    validate: has("validate"),
    dry: has("dry"),
    progressSec: Number(get("progress") ?? 60),
  };
}

function loadSet(set: string): ChartSet {
  const file = join(ROOT, "frontend/src/lib/charts/data", `${set}.json`);
  return loadCharts(JSON.parse(readFileSync(file, "utf8")));
}

/** Combos of a range that survive the flop. */
function liveCombos(range: ArrayLike<number>, flop: readonly number[]): number {
  let n = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (range[c] > 0 && !flop.includes(comboHi(c)) && !flop.includes(comboLo(c))) n += 1;
  }
  return n;
}

/** Turn cards dealt under suit isomorphism (chart ranges are suit-blind, so the board's symmetries are the spot's). */
function turnClasses(flop: readonly number[]): number {
  const group = boardSymmetries(flop);
  const seen = new Set<number>();
  let classes = 0;
  for (let card = 0; card < 52; card += 1) {
    if (flop.includes(card) || seen.has(card)) continue;
    for (const m of cardOrbit(card, group)) seen.add(m);
    classes += 1;
  }
  return classes;
}

/** The work proxy a job's time and memory scale with: both ranges' live combos times the turn cards dealt. */
function workOf(spot: LineSpot, flop: string): { hands: number; work: number } {
  const cards = flopIndices(flop);
  const hands = liveCombos(spot.ranges[0], cards) + liveCombos(spot.ranges[1], cards);
  return { hands, work: hands * turnClasses(cards) };
}

interface StatsFile {
  id: string;
  line: string;
  flop: string;
  bytes: number;
  iterations: number;
  exploitabilityPct: number;
  seconds: number;
  solverMb: number;
  peakRssMb: number;
  hands: [number, number];
  turnClasses: number;
}

function readStats(dir: string): StatsFile[] {
  const out: StatsFile[] = [];
  if (!existsSync(dir)) return out;
  for (const line of readdirSync(dir)) {
    const sub = join(dir, line);
    if (!existsSync(sub) || line.endsWith(".json")) continue;
    for (const file of readdirSync(sub)) {
      if (file.endsWith(".json")) out.push(JSON.parse(readFileSync(join(sub, file), "utf8")) as StatsFile);
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function writeManifest(dir: string, charts: ChartSet, stats: StatsFile[]): void {
  const entries: FlopManifestEntry[] = stats.map((s) => ({
    line: s.line,
    flop: s.flop,
    path: `${s.line}/${s.flop}.bin`,
    bytes: s.bytes,
    iterations: s.iterations,
    exploitabilityPct: Math.round(s.exploitabilityPct * 1000) / 1000,
    seconds: Math.round(s.seconds),
    solverMb: Math.round(s.solverMb),
    peakRssMb: Math.round(s.peakRssMb),
  }));
  const manifest: FlopManifest = {
    version: FLOPLIB_VERSION,
    solver: SOLVER_VERSION,
    charts: { id: charts.id, version: charts.version, hash: charts.model.hash },
    tree: FLOP_PROFILE.tree,
    machine: { cpu: cpus()[0]?.model ?? "?", cores: availableParallelism(), node: process.version },
    entries,
  };
  const file = join(dir, "manifest.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 1)}\n`);
  renameSync(tmp, file);
}

const fmtH = (seconds: number) => (seconds / 3600).toFixed(1);

/** The full-run estimate: per-unit-work time, memory and size fitted on the finished solves. */
function estimate(options: Options, lines: readonly FlopLine[], spots: Map<string, LineSpot>, stats: StatsFile[], log: (s: string) => void): void {
  const all: { line: string; flop: string; hands: number; work: number }[] = [];
  for (const line of lines) {
    const spot = spots.get(line.id);
    if (!spot) continue;
    for (const flop of FLOP_REPRESENTATIVES) all.push({ line: line.id, flop, ...workOf(spot, flop) });
  }
  const done = stats.filter((s) => spots.has(s.line));
  if (done.length === 0) {
    log("estimate: no finished solves to fit on yet - run a pilot first (--only 4)");
    return;
  }
  const fit = (pick: (s: StatsFile) => number, per: (s: StatsFile, w: { hands: number; work: number }) => number) => {
    let num = 0;
    let den = 0;
    for (const s of done) {
      const w = workOf(spots.get(s.line) as LineSpot, s.flop);
      num += pick(s);
      den += per(s, w);
    }
    return num / den;
  };
  const secondsPerWork = fit((s) => s.seconds, (_, w) => w.work);
  const mbPerWork = fit((s) => s.solverMb, (_, w) => w.work);
  const rssPerWork = fit((s) => s.peakRssMb, (_, w) => w.work);
  const bytesPerHand = fit((s) => s.bytes, (_, w) => w.hands);
  const remaining = all.filter((j) => !done.some((s) => s.line === j.line && s.flop === j.flop));
  const coreSeconds = all.reduce((sum, j) => sum + j.work * secondsPerWork, 0);
  const remainingSeconds = remaining.reduce((sum, j) => sum + j.work * secondsPerWork, 0);
  const bytes = all.reduce((sum, j) => sum + j.hands * bytesPerHand, 0);
  const biggest = all.reduce((best, j) => (j.work > best.work ? j : best), all[0]);
  log("");
  log(`Full-run estimate (${lines.length} lines x ${FLOP_REPRESENTATIVES.length} flops = ${all.length} solves), fitted on ${done.length} finished:`);
  log(`  time:   ${fmtH(coreSeconds)} core-hours in all, ${fmtH(remainingSeconds)} still to run`);
  for (const threads of [options.threads, availableParallelism()]) {
    log(`          ${fmtH(remainingSeconds / threads)} h wall at ${threads} solves in parallel (if memory allows, below)`);
  }
  log(`  disk:   ${(bytes / 1e6).toFixed(0)} MB of chunks (${((bytes / all.length) / 1e3).toFixed(0)} KB per solve on average)`);
  log(`  memory: up to ${(biggest.work * mbPerWork / 1e3).toFixed(1)} GB of solver arrays, ~${(biggest.work * rssPerWork / 1e3).toFixed(1)} GB resident, for the widest (${biggest.line} ${biggest.flop}); ` +
    `${(options.memGb).toFixed(0)} GB budget fits ~${Math.max(1, Math.floor((options.memGb * 1e3) / (biggest.work * rssPerWork)))} of those at once`);
  log(`  per line (core-hours): ${lines.map((l) => `${l.id} ${fmtH(all.filter((j) => j.line === l.id).reduce((s, j) => s + j.work * secondsPerWork, 0))}`).join(", ")}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const log = (line: string) => console.log(line);
  const charts = loadSet(options.set);
  const rake = rakeOf(charts);
  const treeDir = join(options.out, options.set, FLOP_PROFILE.tree);
  mkdirSync(treeDir, { recursive: true });

  // The set's table decides the lines (6-max, or full ring for the 9-max sets).
  const lines = flopLinesFor(charts.game.players);
  const wanted = options.lines ?? lines.map((l) => l.id);
  const spots = new Map<string, LineSpot>();
  for (const line of lines) {
    try {
      spots.set(line.id, lineSpot(charts, line));
    } catch (error) {
      log(`line ${line.id}: skipped (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const stats = readStats(treeDir);
  if (options.estimate) {
    estimate(options, lines, spots, stats, log);
    return;
  }
  if (options.validate) {
    const pairs = validateDir(treeDir, stats);
    if (!pairs.length) log("validate: no solved flop with its representative solved on the same line");
    const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
    for (const r of pairs) {
      log(
        `${r.line} ${r.flop} -> ${r.representative} (distance ${r.distance.toFixed(1)}, ${r.nodes} nodes): ` +
          `strategy TV ${pct(r.tv)} (own categories ${pct(r.tvOwn)}), |dEV| ${r.evPot.toFixed(2)}% pot (own ${r.evPotOwn.toFixed(2)}%), ` +
          `same top action ${pct(r.sameBest)}, same check/call grade ${pct(r.samePassiveGrade)}`,
      );
    }
    return;
  }

  // The queue: flops in coverage order, each with every line asked for.
  const jobs: Job[] = [];
  for (const flop of options.flops) {
    for (const lineId of wanted) {
      const line = lines.find((l) => l.id === lineId);
      const spot = spots.get(lineId);
      if (!line || !spot) throw new Error(`unknown or unplayable line ${lineId}`);
      jobs.push({
        id: `${line.id}/${flop}`,
        line: line.id,
        lineKey: line.key,
        flop,
        players: spot.players,
        ranges: [Array.from(spot.ranges[0]), Array.from(spot.ranges[1])],
        pot: spot.pot,
        stack: spot.stack,
        charts: { id: charts.id, version: charts.version, hash: charts.model.hash },
        rake: { name: rake.name, percent: rake.percent, cap: rake.cap },
      });
    }
  }
  const selected = options.only !== null ? jobs.slice(0, options.only) : jobs;
  const chunkFile = (job: Job) => join(options.out, chunkPath(options.set, FLOP_PROFILE.tree, job.line, job.flop));
  const statsFile = (job: Job) => chunkFile(job).replace(/\.bin$/, ".json");
  const todo = selected.filter((job) => !existsSync(chunkFile(job)));
  log(`flop library ${FLOP_PROFILE.tree}, charts ${charts.id} (${charts.version}): ${selected.length} jobs, ${selected.length - todo.length} done, ${todo.length} to run`);
  log(`  ${options.threads} solves at a time, memory budget ${options.memGb} GB, out ${treeDir}`);
  if (options.dry) {
    for (const job of todo) log(`  ${job.id}`);
    return;
  }

  // Memory per job, predicted from the work proxy (calibrated on finished solves, else on the pilot's btn-bb rainbow flop).
  const mbPerWork = stats.length
    ? stats.reduce((s, x) => s + x.peakRssMb, 0) / stats.reduce((s, x) => s + workOf(spots.get(x.line) as LineSpot, x.flop).work, 0)
    : 2400 / (1074 * 49);
  const predictMb = (job: Job) => workOf(spots.get(job.line) as LineSpot, job.flop).work * mbPerWork;

  const bundle = join(dirname(process.argv[1]), "worker.mjs");
  const running = new Map<string, { child: ChildProcess; mb: number; started: number }>();
  let next = 0;
  let failed = 0;
  let stopping = false;
  const started = Date.now();
  const stopAll = () => {
    stopping = true;
    for (const { child } of running.values()) child.kill("SIGKILL");
  };
  process.on("SIGINT", () => {
    log("\nstopping: killing the solves in flight (finished ones are kept; run again to resume)");
    stopAll();
    process.exit(130);
  });

  await new Promise<void>((resolveAll) => {
    const pump = () => {
      if (stopping) return;
      while (running.size < options.threads && next < todo.length) {
        const job = todo[next];
        const mb = predictMb(job);
        const used = [...running.values()].reduce((s, r) => s + r.mb, 0);
        if (running.size > 0 && used + mb > options.memGb * 1e3) break;
        next += 1;
        const child = fork(bundle, [], { stdio: ["ignore", "inherit", "inherit", "ipc"], execArgv: [] });
        running.set(job.id, { child, mb, started: Date.now() });
        log(`  start ${job.id} (predicted ~${(mb / 1e3).toFixed(1)} GB)`);
        child.on("message", (message: { type: string; id: string; [key: string]: unknown }) => {
          if (message.type === "progress") {
            log(
              `  ${message.id}: iteration ${message.iteration}, ${((message.elapsedMs as number) / 60000).toFixed(1)} min, ` +
                `exploitability ${typeof message.exploitabilityPct === "number" && Number.isFinite(message.exploitabilityPct) ? `${message.exploitabilityPct.toFixed(2)}%` : "-"}, rss ${((message.rssMb as number) / 1e3).toFixed(2)} GB`,
            );
          } else if (message.type === "done") {
            log(
              `  done ${message.id}: ${message.iterations} iterations, ${(message.exploitabilityPct as number).toFixed(2)}% of the pot, ` +
                `${((message.seconds as number) / 60).toFixed(1)} min, solver ${((message.solverMb as number) / 1e3).toFixed(2)} GB, peak rss ${((message.peakRssMb as number) / 1e3).toFixed(2)} GB, ${((message.bytes as number) / 1e3).toFixed(0)} KB`,
            );
          } else if (message.type === "error") {
            failed += 1;
            log(`  FAILED ${message.id}: ${message.message}`);
          }
        });
        child.on("exit", () => {
          running.delete(job.id);
          writeManifest(treeDir, charts, readStats(treeDir));
          if (running.size === 0 && next >= todo.length) resolveAll();
          else pump();
        });
        child.send({ job, chunkFile: chunkFile(job), statsFile: statsFile(job), progressMs: options.progressSec * 1000 });
      }
      if (running.size === 0 && next >= todo.length) resolveAll();
    };
    pump();
  });

  const finished = readStats(treeDir);
  writeManifest(treeDir, charts, finished);
  log(`\n${todo.length - failed} solved, ${failed} failed, in ${((Date.now() - started) / 3600_000).toFixed(2)} h wall`);
  estimate(options, spots, finished, log);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
