/**
 * A full flop + turn + river solve of one library job, every street kept
 * (`npm run floplib:full -- --line btn-bb --flop 7s5s3h`).
 *
 * The library keeps only a solve's flop (`nodes: "flop"`); this solves the
 * same job - the same ranges, tree (`FLOP_PROFILE`) and engine - and writes
 *
 * ```
 * <out>/<set>/<tree>/<line>/<flop>/
 *   manifest.json             the solve's numbers and every turn file below
 *   flop.bin                  the flop, a library chunk (what /solver reads)
 *   turn/<flop path>~<card>.bin
 *                             one solve blob (format.ts) per flop line that
 *                             reaches the turn and turn card dealt: the turn
 *                             and its rivers, rooted at the turn's first
 *                             decision, weights = both players' reach there
 * ```
 *
 * so `rangesAt` and `explore.ts` read a turn file as they read a chunk. The
 * turn cards are the solve's (suit isomorphism: one card per class).
 * `/solver` reads a full solve from `NEXT_PUBLIC_FULL_SOLVE_BASE` (local).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { FLOP_PROFILE, flopLinesFor } from "../../../web/src/lib/analysis/flopLibrary.js";
import { rakeOf } from "../../../web/src/lib/analysis/river.js";
import { loadCharts } from "../../../web/src/lib/charts/index.js";
import { Solver } from "../../../web/src/lib/solver/cfr.js";
import { buildFlopGame } from "../../../web/src/lib/solver/flop.js";
import { encodeChunk } from "../../../web/src/lib/solver/flopLibrary.js";
import { encodeSolution, SOLVER_VERSION } from "../../../web/src/lib/solver/format.js";
import { extract, type SolvedNode, type SolveResult } from "../../../web/src/lib/solver/solve.js";
import { ACTION, CHANCE } from "../../../web/src/lib/solver/tree.js";
import { cardCode } from "../../../web/src/lib/equity/index.js";
import { jobHeader, jobSpot, type Job } from "./job.js";
import { lineSpot } from "./spots.js";

const ROOT = resolve(process.env.FLOPLIB_ROOT ?? join(process.cwd(), ".."));

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const set = arg("set", "nlhe-cash-6max-100bb");
const lineId = arg("line", "btn-bb");
const flop = arg("flop", "7s5s3h");
const out = resolve(arg("out", join(process.env.HOME ?? ".", "Projects/rail-fullsolve-out")));
const target = Number(arg("target", "0.3"));
const maxIterations = Number(arg("max-iterations", "1000"));

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const charts = loadCharts(JSON.parse(readFileSync(join(ROOT, "web/src/lib/charts/data", `${set}.json`), "utf8")));
const line = flopLinesFor(charts.game.players).find((l) => l.id === lineId);
if (!line) throw new Error(`unknown line ${lineId}`);
const spot = lineSpot(charts, line);
const rake = rakeOf(charts);
const job: Job = {
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
};

const dir = join(out, set, FLOP_PROFILE.tree, line.id, flop);
mkdirSync(join(dir, "turn"), { recursive: true });
log(`full solve ${set} ${line.id} (${line.key}) ${flop}: ${spot.players.join(" vs ")}, pot ${spot.pot}, stack ${spot.stack}, target ${target}% pot`);

const started = performance.now();
// `deepInfo`: the turn and river decisions keep their pot and actions (the library drops them).
const built = buildFlopGame({ ...jobSpot(job), deepInfo: true });
const solver = new Solver(built.game, FLOP_PROFILE.dcfr, { storage: "i16" });
log(`tree ${built.game.tree.size} nodes, ${built.game.boards.length} boards, solver ${(solver.bytes / 1e9).toFixed(2)} GB`);
const run = solver.run({
  maxIterations,
  targetExploitability: target,
  checkFrom: FLOP_PROFILE.checkFrom,
  checkEvery: FLOP_PROFILE.checkEvery,
  onProgress: (p) => log(`iteration ${p.iteration}: exploitability ${p.exploitability.percentPot.toFixed(3)}% pot`),
  onIteration: (i) => {
    if (i % 10 === 0) log(`iteration ${i}, ${((performance.now() - started) / 60000).toFixed(1)} min`);
  },
});
log(`solved: ${run.iterations} iterations, ${run.exploitability.percentPot.toFixed(3)}% pot, stopped by ${run.stoppedBy}`);

// The flop, as the library keeps it.
const flopResult = extract(built, solver, run, "flop");
writeFileSync(join(dir, "flop.bin"), encodeChunk(jobHeader({ ...job, profile: { ...FLOP_PROFILE, targetPct: target } }), flopResult));

// Every decision's EV, then each turn subtree on its own.
solver.evaluate();
const tree = built.game.tree;
const ev = solver.ev as Float32Array;
const evOffset = solver.evOffset as Int32Array;
const n = [built.game.hands[0].size, built.game.hands[1].size];

/** `extract`'s pre-order walk from any node, with both players' reach on arrival. */
function subtree(rootNode: number, rootReach: [Float64Array, Float64Array]): SolvedNode[] {
  const nodes: SolvedNode[] = [];
  const visit = (node: number, parent: number, parentEdge: number, reach: [Float64Array, Float64Array]): number => {
    const type = tree.type[node];
    if (type !== ACTION && type !== CHANCE) return -1;
    const index = nodes.length;
    const start = tree.childStart[node];
    const count = tree.childCount[node];
    const labels = tree.edgeLabel.slice(start, start + count);
    if (type === CHANCE) {
      const entry: SolvedNode = {
        kind: "chance", player: -1, street: "river", path: built.chancePath.get(node) ?? "", parent, parentEdge,
        pot: 0, toCall: 0, behind: 0, labels, actions: [], children: [],
        strategy: new Float32Array(0), ev: new Float32Array(0), frequency: [],
      };
      nodes.push(entry);
      for (let e = 0; e < count; e += 1) {
        const card = tree.edgeCard[start + e];
        const masked = [0, 1].map((p) => {
          const next = Float64Array.from(reach[p]);
          const hands = built.game.hands[p];
          for (let i = 0; i < hands.size; i += 1) if (hands.c1[i] === card || hands.c2[i] === card) next[i] = 0;
          return next;
        }) as [Float64Array, Float64Array];
        entry.children.push(visit(tree.children[start + e], index, e, masked));
      }
      return index;
    }
    const player = tree.player[node];
    const size = n[player];
    const strategy = solver.averageStrategy(node);
    const off = evOffset[node];
    const info = built.info[node];
    const own = reach[player];
    let total = 0;
    for (let i = 0; i < size; i += 1) total += own[i];
    const frequency: number[] = [];
    for (let a = 0; a < count; a += 1) {
      let f = 0;
      for (let i = 0; i < size; i += 1) f += own[i] * strategy[a * size + i];
      frequency.push(total > 0 ? f / total : 0);
    }
    const entry: SolvedNode = {
      kind: "action", player, street: info?.street ?? "turn", path: info?.path ?? "", parent, parentEdge,
      pot: info?.pot ?? 0, toCall: info?.toCall ?? 0, behind: info?.behind ?? 0, labels,
      actions: info?.actions ?? [], children: [], strategy, ev: ev.slice(off, off + count * size), frequency,
    };
    nodes.push(entry);
    for (let a = 0; a < count; a += 1) {
      const next: [Float64Array, Float64Array] = [reach[0], reach[1]];
      const narrowed = new Float64Array(size);
      for (let i = 0; i < size; i += 1) narrowed[i] = own[i] * strategy[a * size + i];
      next[player] = narrowed;
      entry.children.push(visit(tree.children[start + a], index, a, next));
    }
    return index;
  };
  visit(rootNode, -1, -1, rootReach);
  return nodes;
}

// Walk the flop to every turn deal, carrying reach.
interface TurnFile { flopPath: string; card: string; file: string; nodes: number; bytes: number }
const turns: TurnFile[] = [];
const safe = (s: string) => s.replace(/[^A-Za-z0-9.-]/g, "_") || "root";
const walkFlop = (node: number, reach: [Float64Array, Float64Array]) => {
  const type = tree.type[node];
  const start = tree.childStart[node];
  const count = tree.childCount[node];
  if (type === ACTION) {
    const player = tree.player[node];
    const strategy = solver.averageStrategy(node);
    for (let a = 0; a < count; a += 1) {
      const next: [Float64Array, Float64Array] = [reach[0], reach[1]];
      const narrowed = new Float64Array(n[player]);
      for (let i = 0; i < n[player]; i += 1) narrowed[i] = reach[player][i] * strategy[a * n[player] + i];
      next[player] = narrowed;
      walkFlop(tree.children[start + a], next);
    }
    return;
  }
  if (type !== CHANCE) return;
  const flopPath = built.chancePath.get(node) ?? "";
  for (let e = 0; e < count; e += 1) {
    const card = tree.edgeCard[start + e];
    const child = tree.children[start + e];
    if (tree.type[child] !== ACTION) continue; // all-in on the flop: no decision left
    const masked = [0, 1].map((p) => {
      const next = Float64Array.from(reach[p]);
      const hands = built.game.hands[p];
      for (let i = 0; i < hands.size; i += 1) if (hands.c1[i] === card || hands.c2[i] === card) next[i] = 0;
      return next;
    }) as [Float64Array, Float64Array];
    const nodes = subtree(child, masked);
    const info = built.info[child];
    const result: SolveResult = {
      version: SOLVER_VERSION,
      street: "turn",
      board: [...built.board.map(cardCode), cardCode(card)],
      pot: info?.pot ?? 0,
      stack: info?.behind ?? 0,
      firstToAct: tree.player[child] as 0 | 1,
      hands: built.combos,
      weights: [Float32Array.from(masked[0]), Float32Array.from(masked[1])],
      iterations: run.iterations,
      stoppedBy: run.stoppedBy,
      exploitability: run.exploitability.exploitability,
      exploitabilityPct: run.exploitability.percentPot,
      exploitabilityMbb: run.exploitability.mbb,
      value: [0, 0],
      rootEv: [new Float32Array(n[0]), new Float32Array(n[1])],
      nodes,
      memoryBytes: solver.bytes,
      scope: "all",
    };
    const label = tree.edgeLabel[start + e];
    const file = `turn/${safe(flopPath)}~${label}.bin`;
    const bytes = encodeSolution(result);
    writeFileSync(join(dir, file), bytes);
    turns.push({ flopPath, card: label, file, nodes: nodes.length, bytes: bytes.length });
  }
};
walkFlop(tree.root, [Float64Array.from(built.game.hands[0].weight), Float64Array.from(built.game.hands[1].weight)]);

const manifest = {
  set,
  tree: FLOP_PROFILE.tree,
  line: line.id,
  lineKey: line.key,
  flop,
  players: spot.players,
  pot: spot.pot,
  stack: spot.stack,
  iterations: run.iterations,
  exploitabilityPct: run.exploitability.percentPot,
  stoppedBy: run.stoppedBy,
  seconds: (performance.now() - started) / 1000,
  solverMb: solver.bytes / 1e6,
  turns,
};
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
const total = turns.reduce((s, t) => s + t.bytes, 0);
log(`wrote ${turns.length} turn files (${(total / 1e6).toFixed(0)} MB) + flop.bin to ${dir}`);
