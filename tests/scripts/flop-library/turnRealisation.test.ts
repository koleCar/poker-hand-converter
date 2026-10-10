/**
 * `npm run floplib:turn-realisation` (from `tests/`): measures the turn
 * realisation table on turns solved from the flop library and checks it held
 * out (`turnRealisation.ts`). Not part of `npm test`: it solves thousands of
 * turns. Two steps:
 *
 *     # solve (resumable; run shards side by side, e.g. 0/3, 1/3, 2/3)
 *     cd tests && FLOPLIB_DIR=/path/to/out TURNREAL_OUT=/path/to/samples TURNREAL_SHARD=0/3 npm run floplib:turn-realisation
 *     # report
 *     cd tests && TURNREAL_OUT=/path/to/samples npm run floplib:turn-realisation
 *
 * `FLOPLIB_SETS` picks the chart sets solved (default: the 6-max 100bb set,
 * which is complete). A shard appends each chunk's samples to
 * `<out>/<set>.shard-k-of-n.bin` and its id to `….done`, so a stopped run
 * picks up where it was. The report fits the table on every sample, prints
 * it next to the committed `TURN_REALISATION`, then the held-out agreement
 * (fitted on the flops whose name hashes even, judged on the others) of raw
 * equity, the flop's table, a factor per position and the categories at
 * several margins; `TURNREAL_JUDGE=/path/to/other/samples` also judges the
 * held-out fit on another corpus (e.g. the 9-max set's turns).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import {
  FLOP_MARGIN_POT,
  flopRealisation,
  TURN_MARGIN_POT,
  TURN_REALISATION,
  TURN_REALISATION_POSITION,
} from "../../../frontend/src/lib/analysis/multiway.js";
import { agreement, fitRealisation, type Agreement, type Sample } from "./realisation.js";
import {
  corpusFiles,
  fileTurns,
  MIN_ROW_NODES,
  packSamples,
  smallTable,
  solveLibraryTurn,
  tableFactor,
  turnSamples,
  unpackSamples,
} from "./turnRealisation.js";

const DIR = process.env.FLOPLIB_DIR ?? "";
const OUT = process.env.TURNREAL_OUT ?? "";
const JUDGE = process.env.TURNREAL_JUDGE ?? "";
const SHARD = process.env.TURNREAL_SHARD ?? "";
const SETS = (process.env.FLOPLIB_SETS ?? "nlhe-cash-6max-100bb").split(",");

const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
const show = (name: string, a: Agreement) =>
  console.log(
    `${name.padEnd(30)} verdict ${pct(a.sameVerdict)}  |ΔEV| ${a.evPot.toFixed(2)}% pot  same side ${pct(a.sameSide)}  ` +
      `Mistake right ${pct(a.mistakePrecision)}  Perfect right ${pct(a.perfectPrecision)}  false alarm ${pct(a.falseAlarm)}  miss ${pct(a.miss)}`,
  );

function solveShard() {
  const [k, n] = SHARD.split("/").map(Number);
  mkdirSync(OUT, { recursive: true });
  for (const set of SETS) {
    const data = join(OUT, `${set}.shard-${k}-of-${n}.bin`);
    const done = join(OUT, `${set}.shard-${k}-of-${n}.done`);
    const finished = new Set(existsSync(done) ? readFileSync(done, "utf8").split("\n").filter(Boolean) : []);
    const files = corpusFiles(DIR, [set], [k, n]);
    const started = performance.now();
    let solved = 0;
    for (const [j, file] of files.entries()) {
      if (finished.has(file.id)) continue;
      let turns;
      try {
        turns = fileTurns(file);
      } catch (error) {
        console.log(`skip ${file.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const samples: Sample[] = [];
      for (const turn of turns) {
        samples.push(...turnSamples(solveLibraryTurn(turn), turn));
        solved += 1;
      }
      const packed = packSamples(samples);
      appendFileSync(data, new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
      appendFileSync(done, `${file.id}\n`);
      if (j % 10 === 0) {
        console.log(`${set} shard ${k}/${n}: ${j + 1}/${files.length} chunks, ${solved} turns, ${((performance.now() - started) / 1000).toFixed(0)} s`);
      }
    }
  }
}

function load(dir: string): Sample[] {
  const out: Sample[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".bin")) continue;
    const bytes = readFileSync(join(dir, file));
    for (const s of unpackSamples(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))) out.push(s);
  }
  return out;
}

function report() {
  const samples = load(OUT);
  console.log(`=== ${samples.length} samples`);
  const all = fitRealisation(samples);
  let worst = 0;
  for (const [key, { r, weight }] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
    const committed = TURN_REALISATION[key];
    if (committed !== undefined) worst = Math.max(worst, Math.abs(committed - r));
    console.log(`  ${key.padEnd(22)} R ${r.toFixed(3)}  committed ${committed?.toFixed(3) ?? "-"}  weight ${weight.toFixed(1)} nodes`);
  }
  const allPosition = fitRealisation(samples.map((s) => ({ ...s, key: s.key.split("|")[0] })));
  console.log(`  largest difference from the committed table: ${worst.toFixed(4)}`);
  console.log(`  the table (rows of ${MIN_ROW_NODES}+ nodes): ${JSON.stringify(smallTable(all))}`);
  console.log(`  by position: ${[...allPosition].map(([k, v]) => `${k} ${v.r.toFixed(3)}`).join(", ")}`);
  const train = samples.filter((s) => s.train);
  const test = samples.filter((s) => !s.train);
  const held = fitRealisation(train);
  const position = fitRealisation(train.map((s) => ({ ...s, key: s.key.split("|")[0] })));
  const positions = Object.fromEntries([...position].map(([k, v]) => [k, v.r]));
  const byPosition = (key: string) => position.get(key.split("|")[0])?.r ?? 1;
  const flopTable = (key: string) => flopRealisation(key.split("|").slice(1).join("|"), key.startsWith("ip"));
  const heldTable = smallTable(held);
  const fitted = (key: string) => tableFactor(heldTable, positions, key);
  const every = (key: string) => held.get(key)?.r ?? byPosition(key);
  const judge = (name: string, set: readonly Sample[]) => {
    console.log(`=== held out (${name}): fitted on ${train.length} samples, judged on ${set.length}`);
    show("raw equity (R = 1)", agreement(set, () => 1, 0));
    show("raw equity, margin 5%", agreement(set, () => 1, TURN_MARGIN_POT));
    show("the flop's table, margin 5%", agreement(set, flopTable, FLOP_MARGIN_POT));
    show("R by position", agreement(set, byPosition, 0));
    show("every category, margin 5%", agreement(set, every, TURN_MARGIN_POT));
    for (const margin of [0, 0.03, 0.05, 0.08, 0.1, 0.15]) {
      show(`R by category, margin ${(100 * margin).toFixed(0)}%`, agreement(set, fitted, margin));
    }
    const byPot = (s: Sample) => (s.line.endsWith("-3bet") ? "3-bet pots" : s.line === "sb-limp" ? "limped pots" : "single-raised pots");
    for (const pot of ["single-raised pots", "3-bet pots", "limped pots"]) {
      const subset = set.filter((s) => byPot(s) === pot);
      if (subset.length > 0) show(`  ${pot}, 5%`, agreement(subset, fitted, TURN_MARGIN_POT));
    }
    // toCall is a share of the pot with the bet in: a third of a pot is 0.25, three quarters 0.43.
    const bySize = (s: Sample) => (s.toCall < 0.33 ? "facing ~1/3 pot" : s.toCall < 0.47 ? "facing ~3/4 pot" : "facing a raise or all-in");
    for (const size of ["facing ~1/3 pot", "facing ~3/4 pot", "facing a raise or all-in"]) {
      const subset = set.filter((s) => bySize(s) === size);
      if (subset.length > 0) show(`  ${size}, 5%`, agreement(subset, fitted, TURN_MARGIN_POT));
    }
    for (const pos of ["ip", "oop"]) {
      show(`  ${pos}, 5%`, agreement(set.filter((s) => s.key.startsWith(`${pos}|`)), fitted, TURN_MARGIN_POT));
    }
    show("the committed table, margin 5%", agreement(set, (key) => tableFactor(TURN_REALISATION, TURN_REALISATION_POSITION, key), TURN_MARGIN_POT));
  };
  judge("same corpus, other flops", test);
  if (JUDGE && existsSync(JUDGE)) judge(JUDGE, load(JUDGE));
}

it("measures the turn realisation table", { timeout: 24 * 60 * 60_000 }, () => {
  if (!OUT) {
    console.log("TURNREAL_OUT (the samples' directory) must be set; nothing to do");
    return;
  }
  if (SHARD) {
    if (!DIR || !existsSync(DIR)) {
      console.log("FLOPLIB_DIR (the flop library) must be set to solve; nothing to do");
      return;
    }
    solveShard();
  } else report();
});
