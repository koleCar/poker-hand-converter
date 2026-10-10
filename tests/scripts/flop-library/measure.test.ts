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
 * the flop's narrowing. `FLOPLIB_DUMP=/path/to/out.jsonl` also writes each
 * hero flop decision the library grades (hand number, decision, grade, EV
 * loss, mapped or exact, the category read): two dumps of the same hands
 * under two versions of the reading compare decision for decision.
 *
 * **Multiway flops** (`analysis/15`): the hero's flop decisions in pots three
 * or more saw the flop of, by source, action and grade, and the approximate
 * flop call checked where an exact answer exists - every heads-up flop call
 * or fold the library grades is graded a second time by the approximation
 * (`flopCallEv` on the heuristic walk), and the two grades are compared.
 * The dump also holds the approximate flop grades.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import {
  analyzeHand,
  FlopLibraryLoader,
  flopCallEv,
  gradeFlopCall,
  gradeRank,
  heroSeatOf,
  heroSpots,
  heuristicModel,
  walkMultiway,
  type HandAnalysis,
} from "../../../frontend/src/lib/analysis/index.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../frontend/src/lib/charts/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { buildContext } from "../../../frontend/src/lib/stats/context.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const DIR = process.env.FLOPLIB_DIR ?? "";
const TURN_SAMPLE = Number(process.env.FLOPLIB_TURN_SAMPLE ?? 0);
const DUMP = process.env.FLOPLIB_DUMP ?? "";

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

/** Seats that acted on the flop. */
const flopPlayers = (hand: PhfHand) => new Set(hand.actions.filter((a) => a.street === "flop" && a.seat !== null).map((a) => a.seat)).size;

/**
 * The approximate flop call against the library where both answer: each
 * heads-up flop call or fold facing a bet that the library grades, graded
 * again by `flopCallEv` on the heuristic walk. "library -> approximate".
 */
function approxAgainstLibrary(hand: PhfHand, after: HandAnalysis, charts: ChartSet, out: Map<string, number>) {
  const targets = after.decisions.filter(
    (d) => d.street === "flop" && d.source === "solver" && (d.action === "call" || d.action === "fold") && d.facts.toCallBb > 0,
  );
  if (targets.length === 0) return;
  const copy = structuredClone(hand);
  const context = buildContext(copy);
  const hero = heroSeatOf(context);
  if (hero === null) return;
  const walk = walkMultiway(copy, context, hero, charts, heuristicModel);
  if (!walk.ok) return;
  const spots = heroSpots(context, hero);
  for (const d of targets) {
    const spot = spots.find((s) => s.action.index === d.actionIndex);
    if (!spot || !d.grade) continue;
    const evs = flopCallEv({ spot, facts: d.facts, hand: copy, context, hero, walk, model: heuristicModel, charts, seed: 7 });
    if (!evs.ok) continue;
    const ours = gradeFlopCall(evs, d.action as "call" | "fold", d.facts.potBb).grade;
    bump(out, `${d.grade} -> ${ours}`);
    bump(out, "n");
    if (ours === d.grade) bump(out, "same");
    if (gradeRank(ours) >= 2 === gradeRank(d.grade) >= 2) bump(out, "same side");
    if (gradeRank(ours) >= 3 && gradeRank(d.grade) <= 1) bump(out, "false alarm");
  }
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
  const dump: string[] = [];
  const multiway = new Map<string, number>();
  const check = new Map<string, number>();
  for (const [h, hand] of hands.entries()) {
    await library.prefetch(hand, charts);
    const before = analyzeHand(structuredClone(hand), { charts, turn: false });
    const after = analyzeHand(structuredClone(hand), { charts, turn: false, flopLibrary: library });
    compare("flop", before, after, flop);
    approxAgainstLibrary(hand, after, charts, check);
    const mwFlop = flopPlayers(hand) >= 3;
    for (const d of after.decisions) {
      if (d.street !== "flop" || !mwFlop) continue;
      bump(multiway, "decisions");
      bump(multiway, `${d.source} ${d.action}${d.facts.toCallBb > 0 ? " facing a bet" : ""}${d.grade ? ` ${d.grade}` : ""}`);
      if (d.source === "approx") bump(multiway, "approx EV loss bb", d.evLoss ?? 0);
    }
    if (DUMP) {
      after.decisions.forEach((d, k) => {
        if (d.street !== "flop" || (d.source !== "solver" && d.source !== "approx")) return;
        const facts = d.facts.flop?.source === "library" ? d.facts.flop : null;
        const real = d.facts.multiway?.ev?.realisation ?? null;
        dump.push(
          JSON.stringify({
            hand: h,
            decision: k,
            source: d.source,
            grade: d.grade,
            evLoss: d.evLoss,
            mapped: facts?.mapped ?? null,
            bucket: facts?.bucket ?? real?.category ?? null,
          }),
        );
      });
    }
  }
  if (DUMP) writeFileSync(DUMP, dump.join("\n") + "\n");
  console.log(`=== ${FILE}: ${hands.length} hands (${((performance.now() - started) / 1000).toFixed(0)} s)`);
  report("flop", flop);
  console.log(
    [
      `--- multiway flops (three or more saw the flop): ${multiway.get("decisions") ?? 0} hero flop decisions`,
      `  ${list(new Map([...multiway].filter(([k]) => k !== "decisions" && !k.startsWith("approx EV"))))}`,
      `  approximate grades' EV loss: ${(multiway.get("approx EV loss bb") ?? 0).toFixed(1)} bb`,
      `--- the approximate flop call against the library (heads-up flop calls and folds both grade): ${check.get("n") ?? 0}`,
      `  same grade ${check.get("same") ?? 0}, same side of Good/Inaccurate ${check.get("same side") ?? 0}, false alarms (approx Mistake, library Perfect or Good) ${check.get("false alarm") ?? 0}`,
      `  ${list(new Map([...check].filter(([k]) => k.includes("->"))))}`,
    ].join("\n"),
  );

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
