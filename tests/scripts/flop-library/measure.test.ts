/**
 * What turning the flop library on changes, on a stored library (A5b, §10):
 * every hand of a JSONL file of PHF hands (one `hands.phf` per line, as
 * `psql -Atc "select phf from hands where owner_id = ..."` prints them) is
 * analysed twice with `analyzeHand` - without the library (the heuristic flop,
 * as before) and with the library read from a local directory through the
 * worker's own loader (`FlopLibraryLoader`) - and the hero's flop decisions
 * are compared: how many the library grades (exact or mapped), the grade
 * distribution before and after, and how grades move.
 *
 *     cd tests && FLOPLIB_HANDS=/path/to/library.jsonl FLOPLIB_DIR=/path/to/out npm run floplib:measure
 *
 * `FLOPLIB_DIR` holds `<set>/<tree>/manifest.json` and the chunks, as the
 * batch runner writes them. Turns are not solved (`turn: false`): flop grades
 * do not depend on them. `FLOPLIB_TURN_SAMPLE=N` also analyses the first N
 * hands with turn solving on and reports how turn and river grades move with
 * the flop's narrowing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import { analyzeHand, FlopLibraryLoader, type HandAnalysis } from "../../../frontend/src/lib/analysis/index.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../frontend/src/lib/charts/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const DIR = process.env.FLOPLIB_DIR ?? "";
const TURN_SAMPLE = Number(process.env.FLOPLIB_TURN_SAMPLE ?? 0);

const bump = (m: Map<string, number>, key: string, by = 1) => m.set(key, (m.get(key) ?? 0) + by);
const list = (m: Map<string, number>) =>
  [...m]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;

/** A fetch over the local directory, shaped like the worker's. */
const localFetch = async (url: string): Promise<Response> => {
  const path = join(DIR, url.replace(/^local:\/*/, ""));
  if (!existsSync(path)) return new Response(null, { status: 404 });
  return new Response(readFileSync(path));
};

function compare(street: "flop" | "turn" | "river", before: HandAnalysis, after: HandAnalysis, out: Record<string, Map<string, number>>) {
  const b = before.decisions.filter((d) => d.street === street);
  const a = after.decisions.filter((d) => d.street === street);
  a.forEach((d, k) => {
    const old = b[k];
    if (!old) return;
    bump(out.sourceBefore, String(old.source));
    bump(out.sourceAfter, String(d.source));
    if (old.grade) bump(out.gradeBefore, old.grade);
    if (d.grade) bump(out.gradeAfter, d.grade);
    if (old.grade !== d.grade) bump(out.moves, `${old.grade ?? "none"} -> ${d.grade ?? "none"}`);
    if (street === "flop" && d.source === "solver") {
      bump(out.how, d.approximations.includes("flop-mapped") ? "mapped" : "exact");
    }
    bump(out.evBefore, "bb", old.evLoss ?? 0);
    bump(out.evAfter, "bb", d.evLoss ?? 0);
  });
}

const fresh = () => ({
  sourceBefore: new Map<string, number>(),
  sourceAfter: new Map<string, number>(),
  gradeBefore: new Map<string, number>(),
  gradeAfter: new Map<string, number>(),
  moves: new Map<string, number>(),
  how: new Map<string, number>(),
  evBefore: new Map<string, number>(),
  evAfter: new Map<string, number>(),
});

function report(title: string, r: ReturnType<typeof fresh>) {
  const n = [...r.sourceAfter.values()].reduce((s, v) => s + v, 0);
  const solved = r.sourceAfter.get("solver") ?? 0;
  console.log(
    [
      `--- ${title}: ${n} hero decisions`,
      `  source before: ${list(r.sourceBefore)}`,
      `  source after:  ${list(r.sourceAfter)} (solver ${pct(solved, n)}${r.how.size ? `; ${list(r.how)}` : ""})`,
      `  grades before: ${list(r.gradeBefore)}`,
      `  grades after:  ${list(r.gradeAfter)}`,
      `  EV loss: ${(r.evBefore.get("bb") ?? 0).toFixed(1)} bb -> ${(r.evAfter.get("bb") ?? 0).toFixed(1)} bb`,
      `  moves: ${list(r.moves)}`,
    ].join("\n"),
  );
}

it("measures the flop library on a stored library", { timeout: 12 * 60 * 60_000 }, async () => {
  if (!FILE || !existsSync(FILE) || !DIR || !existsSync(DIR)) {
    console.log("FLOPLIB_HANDS (JSONL of PHF hands) and FLOPLIB_DIR (the library) must both be set; nothing to do");
    return;
  }
  const hands: PhfHand[] = readFileSync(FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PhfHand);
  const load = (id: string) => loadCharts(JSON.parse(readFileSync(join(DATA, `${id}.json`), "utf8")));
  const sets = CHART_SETS.map((spec) => load(spec.id));
  const single = sets.find((s) => s.id === DEFAULT_CHART_SET) as ChartSet;
  const charts = chartLibrary([single, ...sets.filter((s) => s !== single)]);
  const library = new FlopLibraryLoader("local:", localFetch);

  const started = performance.now();
  const flop = fresh();
  for (const hand of hands) {
    await library.prefetch(hand, charts);
    const before = analyzeHand(structuredClone(hand), { charts, turn: false });
    const after = analyzeHand(structuredClone(hand), { charts, turn: false, flopLibrary: library });
    compare("flop", before, after, flop);
  }
  console.log(`=== ${FILE}: ${hands.length} hands (${((performance.now() - started) / 1000).toFixed(0)} s)`);
  report("flop", flop);

  if (TURN_SAMPLE > 0) {
    const turn = fresh();
    const river = fresh();
    const t0 = performance.now();
    for (const hand of hands.slice(0, TURN_SAMPLE)) {
      const before = analyzeHand(structuredClone(hand), { charts });
      const after = analyzeHand(structuredClone(hand), { charts, flopLibrary: library });
      compare("turn", before, after, turn);
      compare("river", before, after, river);
    }
    console.log(`=== turn and river, first ${TURN_SAMPLE} hands (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
    report("turn", turn);
    report("river", river);
  }
});
