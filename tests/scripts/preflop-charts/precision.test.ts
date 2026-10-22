/**
 * How precise the charts' EVs are, in big blinds (ANALYSIS-PLAN §10
 * 2026-10-22, preflop tiny losses): the question before any preflop floor.
 * A grade reads `evLoss = max(ev) − ev[chosen]` at the hero's class; this
 * measures how much that number moves when nothing but the solve's own
 * precision changes, and when the model changes.
 *
 * 1. **Indifference gaps** (every committed set): at an equilibrium every
 *    action a class plays has the same EV. For each class in range that
 *    plays two or more actions at least `MIX` of the time, the gap between
 *    the best and worst of them, weighted by how often a player is there
 *    (`reach × combos × range`). The solve's own EV error, and the 0.01bb
 *    the file stores EVs in.
 * 2. **Pairs of sets** that differ in one thing (`PRECISION_OLD`, a directory
 *    of set files, see below): per node both have, per class in range and
 *    per action, |Δ evLoss|, weighted as above; and the grade a hero would
 *    get there (plain shares of the node's pot), how often it changes, by the
 *    loss band. Files looked for in `PRECISION_OLD`:
 *    - `it3000-<id>.json`: the 200bb and 9-max 150bb sets at 3,000 iterations
 *      (`charts/4`, before `charts/6` / `charts/7` solved them to 9,000);
 *    - `it9000-nlhe-cash-6max-100bb.json`: the 6-max 100bb set re-solved to
 *      9,000 (`CHARTS_ITERATIONS=9000 CHARTS_OUT=...`);
 *    - `eq240k-nlhe-cash-6max-100bb.json`: the same set on a 240,000-board
 *      equity table (`CHARTS_BOARDS=240000`), the equity sample's noise;
 *    - `rake-cap1.5-` / `rake-none-nlhe-cash-6max-100bb.json`: the same set
 *      under a 1.5bb rake cap / no rake (`CHARTS_RAKE=0.05:1.5`, `0:0`);
 *    - `c2-` / `c1-nlhe-cash-6max-100bb.json`: `charts/2` (no limp tree) and
 *      `charts/1` (hand-set realisation), model changes for scale;
 *    - `refit-` / `seed2-nlhe-cash-6max-100bb.json`: the `charts/2` pipeline
 *      (three measurement rounds, no limp tree) rerun on the default board
 *      sample and on another (`CHARTS_REFIT=1`, `CHARTS_MEASURE_SEED=2`):
 *      the realisation fit's own sampling error.
 *    Old sets come from the repository's history (`show <commit>:<path>`):
 *    `charts/4`'s 200bb files before #122, its 9-max 150bb before #125,
 *    `charts/2` at #106, `charts/1` at #95. The re-solves are
 *    `npm run charts:generate` with `CHARTS_SETS=nlhe-cash-6max-100bb
 *    CHARTS_OUT=<file>` and the variable named; on one thread 3,000
 *    iterations take 15-18 min, 9,000 41 min, a refit (three rounds of 1,560
 *    turn+river solves) about 2 h.
 * 3. **The stored hands** (`PRECISION_HANDS`, one PHF JSON per line, never
 *    committed): every hero preflop decision the charts grade, graded again
 *    with each pair's other set in the library, the EV loss and grade moves
 *    by the loss band; the preflop grades by loss band, scenario and move;
 *    and pot floors tried on the rows (`max(pot, floor)`, the postflop
 *    rule's form): per floor, the Mistakes and Blunders left and how many of
 *    them each pair's other set grades differently under the same floor -
 *    whether a floor leaves grades the noise cannot move. Console only,
 *    aggregates only.
 *
 *     cd tests && PRECISION_OLD=/path/old PRECISION_HANDS=/path/hands.jsonl npm run charts:precision
 *
 * Not part of `npm test`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import { analyzeHand, gradePreflop, type DecisionAnalysis, type Grade } from "../../../frontend/src/lib/analysis/index.js";
import { grade } from "../../../frontend/src/lib/analysis/grading.js";
import { modelCaveat } from "../../../frontend/src/lib/analysis/reference.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../frontend/src/lib/charts/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { CLASS_COMBOS } from "../../../frontend/src/lib/solver/handClasses.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const OLD = process.env.PRECISION_OLD ?? "";
const HANDS = process.env.PRECISION_HANDS ?? "";
/** A class "plays" an action from this frequency on (for the indifference gaps). */
const MIX = Number(process.env.PRECISION_MIX ?? 0.1);

/** A set file; `charts/1`'s format is `charts/2`'s, read under that label (the loader no longer lists it). */
const load = (file: string) => {
  const json = JSON.parse(readFileSync(file, "utf8"));
  if (json.version === "charts/1") json.version = "charts/2";
  return loadCharts(json);
};
const committed = (id: string) => load(join(DATA, `${id}.json`));

/* --------------------------------------------------------------- helpers - */

type W = [value: number, weight: number];

function quantile(items: W[], q: number): number {
  if (items.length === 0) return NaN;
  const sorted = [...items].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, x) => s + x[1], 0);
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= q * total) return v;
  }
  return sorted[sorted.length - 1][0];
}
const share = (items: W[], pred: (v: number) => boolean) => {
  const total = items.reduce((s, x) => s + x[1], 0);
  return total > 0 ? items.filter((x) => pred(x[0])).reduce((s, x) => s + x[1], 0) / total : NaN;
};
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : "-");
const pc = (v: number) => (Number.isFinite(v) ? `${(100 * v).toFixed(1)}%` : "-");
const summary = (items: W[]) =>
  `n ${items.length}; p50 ${f3(quantile(items, 0.5))} p75 ${f3(quantile(items, 0.75))} p90 ${f3(quantile(items, 0.9))} p99 ${f3(quantile(items, 0.99))} bb; > 0.02bb ${pc(share(items, (v) => v > 0.02))}, > 0.05bb ${pc(share(items, (v) => v > 0.05))}, > 0.1bb ${pc(share(items, (v) => v > 0.1))}`;

/** Loss bands, bb: what a grade at the preflop pot sizes is made of. */
const BANDS: [string, number, number][] = [
  ["(0, 0.02]", 0, 0.02],
  ["(0.02, 0.05]", 0.02, 0.05],
  ["(0.05, 0.10]", 0.05, 0.1],
  ["(0.10, 0.25]", 0.1, 0.25],
  ["(0.25, 0.50]", 0.25, 0.5],
  ["(0.50, 1]", 0.5, 1],
  ["> 1", 1, Infinity],
];
const bandOf = (loss: number) => BANDS.find(([, lo, hi]) => loss > lo && loss <= hi)?.[0] ?? "0";

/** A hero's grade at `node` with class `i` choosing action `a`, plain shares of the node's pot. */
function nodeGrade(set: ChartSet, line: string, i: number, a: number): Grade {
  const node = set.nodes.get(line)!;
  const options = node.options.map((o, k) => ({ action: "fold" as const, sizeBb: o.toBb, freq: node.freq[k * 169 + i], ev: node.ev[k * 169 + i] }));
  return grade({ options, chosen: a, pot: node.potBb }).grade;
}

/* ------------------------------------------------------------ 1. the gaps - */

function indifference(set: ChartSet): { all: W[]; byScenario: Map<string, W[]> } {
  const all: W[] = [];
  const byScenario = new Map<string, W[]>();
  for (const node of set.nodes.values()) {
    const n = node.options.length;
    for (let i = 0; i < 169; i += 1) {
      const w = node.reach * CLASS_COMBOS[i] * node.range[i];
      if (w <= 0) continue;
      let lo = Infinity;
      let hi = -Infinity;
      let played = 0;
      for (let a = 0; a < n; a += 1) {
        if (node.freq[a * 169 + i] < MIX) continue;
        played += 1;
        lo = Math.min(lo, node.ev[a * 169 + i]);
        hi = Math.max(hi, node.ev[a * 169 + i]);
      }
      if (played < 2) continue;
      all.push([hi - lo, w]);
      const list = byScenario.get(node.scenario) ?? [];
      list.push([hi - lo, w]);
      byScenario.set(node.scenario, list);
    }
  }
  return { all, byScenario };
}

/* ----------------------------------------------------------- 2. the pairs - */

interface Pair {
  name: string;
  base: ChartSet;
  other: ChartSet;
}

function pairs(): Pair[] {
  if (!OLD || !existsSync(OLD)) return [];
  const out: Pair[] = [];
  const add = (name: string, base: () => ChartSet, file: string) => {
    const path = join(OLD, file);
    if (existsSync(path)) out.push({ name, base: base(), other: load(path) });
  };
  for (const id of ["nlhe-cash-6max-200bb", "nlhe-cash-9max-200bb", "nlhe-cash-9max-150bb"]) {
    add(`iterations 9,000 vs 3,000: ${id}`, () => committed(id), `it3000-${id}.json`);
  }
  add("iterations 3,000 vs 9,000: nlhe-cash-6max-100bb (re-solved)", () => committed("nlhe-cash-6max-100bb"), "it9000-nlhe-cash-6max-100bb.json");
  add("equity table 120k vs 240k boards: nlhe-cash-6max-100bb", () => committed("nlhe-cash-6max-100bb"), "eq240k-nlhe-cash-6max-100bb.json");
  add("model: charts/4 vs charts/2 (limp tree): nlhe-cash-6max-100bb", () => committed("nlhe-cash-6max-100bb"), "c2-nlhe-cash-6max-100bb.json");
  add("rake 5% cap 3bb vs cap 1.5bb: nlhe-cash-6max-100bb", () => committed("nlhe-cash-6max-100bb"), "rake-cap1.5-nlhe-cash-6max-100bb.json");
  add("rake 5% cap 3bb vs none: nlhe-cash-6max-100bb", () => committed("nlhe-cash-6max-100bb"), "rake-none-nlhe-cash-6max-100bb.json");
  const c2 = join(OLD, "c2-nlhe-cash-6max-100bb.json");
  if (existsSync(c2)) {
    add("model: charts/2 vs charts/1 (realisation fit): nlhe-cash-6max-100bb", () => load(c2), "c1-nlhe-cash-6max-100bb.json");
  }
  // The fit's own sampling error: the charts/2 pipeline rerun today on the default board sample and on another.
  const refit = join(OLD, "refit-nlhe-cash-6max-100bb.json");
  if (existsSync(refit)) {
    if (existsSync(c2)) add("charts/2 as committed vs rerun today (reproduction check): nlhe-cash-6max-100bb", () => load(c2), "refit-nlhe-cash-6max-100bb.json");
    add("realisation fit on another board sample (charts/2 pipeline, measurement seed changed): nlhe-cash-6max-100bb", () => load(refit), "seed2-nlhe-cash-6max-100bb.json");
  }
  return out;
}

function comparePair(pair: Pair): string[] {
  const all: W[] = [];
  const notPlayed: W[] = [];
  const bands = new Map<string, { d: W[]; flip: number; w: number }>();
  let nodes = 0;
  let matched = 0;
  for (const node of pair.base.nodes.values()) {
    nodes += 1;
    const other = pair.other.nodes.get(node.line);
    if (!other || other.options.map((o) => o.code).join() !== node.options.map((o) => o.code).join()) continue;
    matched += 1;
    const n = node.options.length;
    for (let i = 0; i < 169; i += 1) {
      const w = node.reach * CLASS_COMBOS[i] * node.range[i];
      if (w <= 0) continue;
      let maxA = -Infinity;
      let maxB = -Infinity;
      for (let a = 0; a < n; a += 1) {
        maxA = Math.max(maxA, node.ev[a * 169 + i]);
        maxB = Math.max(maxB, other.ev[a * 169 + i]);
      }
      for (let a = 0; a < n; a += 1) {
        const lossA = maxA - node.ev[a * 169 + i];
        const lossB = maxB - other.ev[a * 169 + i];
        const d = Math.abs(lossA - lossB);
        all.push([d, w]);
        // What a grade is made of: an action the base set rarely plays, at a loss.
        if (node.freq[a * 169 + i] >= 0.035 || lossA <= 0) continue;
        notPlayed.push([d, w]);
        const band = bandOf(lossA);
        const b = bands.get(band) ?? { d: [], flip: 0, w: 0 };
        b.d.push([d, w]);
        b.w += w;
        if (nodeGrade(pair.base, node.line, i, a) !== nodeGrade(pair.other, other.line, i, a)) b.flip += w;
        bands.set(band, b);
      }
    }
  }
  const lines = [`### ${pair.name}`, `nodes ${nodes}, matched ${matched}`, `every class × action, |Δ evLoss|: ${summary(all)}`, `actions played under 3.5% at a loss: ${summary(notPlayed)}`];
  lines.push("| base loss | entries | Δ p50 | Δ p90 | grade changes (weighted) |", "|---|---|---|---|---|");
  for (const [band] of BANDS) {
    const b = bands.get(band);
    if (!b) continue;
    lines.push(`| ${band} | ${b.d.length} | ${f3(quantile(b.d, 0.5))} | ${f3(quantile(b.d, 0.9))} | ${pc(b.flip / b.w)} |`);
  }
  return lines;
}

/* ------------------------------------------------------ 3. the stored hands - */

interface Row {
  set: string;
  scenario: string;
  grade: Grade;
  evLoss: number;
  potBb: number;
  chosenFreq: number;
  /** The implied-odds caveat the hand view already shows (`modelCaveat`). */
  caveat: boolean;
  offRange: boolean;
  /** `chosen → top` actions and the hero's position, for the breakdown (no cards). */
  move: string;
  position: string;
  /** The grade as `gradePreflop` returns it (options and chosen), for the floors. */
  base: Graded | null;
  /** Per pair name: the other set's EV loss and grade, or null when it does not grade the decision. */
  other: Map<string, { delta: number; baseLoss: number; baseGrade: Grade; grade: Grade; base: Graded; again: Graded } | null>;
}

type Graded = Extract<ReturnType<typeof gradePreflop>, { ok: true }>;

/** A chart grade judged against a pot of at least `floor` bb (the postflop rule's form, analysis/33). */
function floored(g: Graded, potBb: number, floor: number): Grade {
  const capAtInaccurate = g.approximations.includes("off-tree-size") || g.approximations.includes("rare-line-depth") || g.approximations.includes("posted-blind");
  return grade({ options: g.options, chosen: g.chosen, pot: Math.max(potBb, floor), capAtInaccurate }).grade;
}

function libraryWith(sets: ChartSet[], swap: ChartSet | null): ChartSet {
  const list = swap ? sets.map((s) => (s.id === swap.id ? swap : s)) : sets;
  const single = list.find((s) => s.id === DEFAULT_CHART_SET) as ChartSet;
  return chartLibrary([single, ...list.filter((s) => s !== single)]);
}

function storedHands(pairList: Pair[]): string[] {
  const hands: PhfHand[] = readFileSync(HANDS, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PhfHand);
  const sets = CHART_SETS.map((spec) => committed(spec.id));
  const base = libraryWith(sets, null);
  const swaps = pairList.map((p) => ({ name: p.name, id: p.base.id, lib: libraryWith(sets, p.other), baseLib: libraryWith(sets, p.base) }));
  const rows: Row[] = [];
  let mismatch = 0;
  for (const hand of hands) {
    if (hand.game.format !== "cash") continue;
    const result = analyzeHand(structuredClone(hand), { charts: base, turn: false });
    if (result.heroSeat === null) continue;
    let nth = 0;
    for (const d of result.decisions as DecisionAnalysis[]) {
      if (d.street !== "preflop") continue;
      const here = nth;
      nth += 1;
      if (d.source !== "chart" || d.grade === null || d.evLoss === null || d.chosen === null) continue;
      const input = { hand, heroSeat: result.heroSeat, nth: here, actionIndex: d.actionIndex, potBb: d.facts.potBb };
      const again = gradePreflop(input, base);
      if (!again.ok || again.grade !== d.grade || again.evLoss !== d.evLoss) mismatch += 1;
      const other: Row["other"] = new Map();
      for (const s of swaps) {
        if (d.facts.chart?.set !== s.id) continue;
        // The pair's base, when it is not the committed set (charts/2 against charts/1).
        const b = s.baseLib === base ? again : gradePreflop(input, s.baseLib);
        const o = gradePreflop(input, s.lib);
        other.set(s.name, b.ok && o.ok ? { delta: Math.abs(o.evLoss - b.evLoss), baseLoss: b.evLoss, baseGrade: b.grade, grade: o.grade, base: b, again: o } : null);
      }
      rows.push({
        set: d.facts.chart?.set ?? "?",
        scenario: d.facts.chart?.scenario ?? "?",
        grade: d.grade,
        evLoss: d.evLoss,
        potBb: d.facts.potBb,
        chosenFreq: d.options[d.chosen].freq,
        caveat: modelCaveat(d),
        offRange: d.approximations.includes("out-of-range"),
        move: `${d.options[d.chosen].action} → ${d.options.reduce((b, o) => (o.freq > b.freq ? o : b)).action}`,
        position: d.facts.position ?? "?",
        base: again.ok ? again : null,
        other,
      });
    }
  }
  const out: string[] = [`## Stored hands: ${rows.length} preflop decisions graded by the charts (${mismatch} not reproduced by gradePreflop)`];
  const count = (pred: (r: Row) => boolean) => rows.filter(pred).length;
  const bad = (r: Row) => r.grade === "mistake" || r.grade === "blunder";
  out.push(`grades: ${["perfect", "good", "inaccurate", "mistake", "blunder"].map((g) => `${g} ${count((r) => r.grade === g)}`).join(", ")}`);
  out.push("", "### Mistakes and Blunders by EV loss", "| loss | mistake | blunder | chosen freq 0 | off range | implied-odds caveat | pot median |", "|---|---|---|---|---|---|---|");
  for (const [band] of BANDS) {
    const sel = rows.filter((r) => bad(r) && bandOf(r.evLoss) === band);
    if (!sel.length) continue;
    const pots = sel.map((r) => r.potBb).sort((a, b) => a - b);
    out.push(`| ${band} | ${sel.filter((r) => r.grade === "mistake").length} | ${sel.filter((r) => r.grade === "blunder").length} | ${sel.filter((r) => r.chosenFreq === 0).length} | ${sel.filter((r) => r.offRange).length} | ${sel.filter((r) => r.caveat).length} | ${pots[pots.length >> 1]} |`);
  }
  const scen = new Map<string, number[]>();
  for (const r of rows.filter(bad)) {
    const k = r.scenario;
    const v = scen.get(k) ?? [0, 0, 0];
    v[0] += 1;
    if (r.evLoss <= 0.25) v[1] += 1;
    if (r.evLoss <= 0.05) v[2] += 1;
    scen.set(k, v);
  }
  out.push("", "### Mistakes and Blunders by scenario (all, ≤ 0.25bb, ≤ 0.05bb)", ...[...scen].sort((a, b) => b[1][0] - a[1][0]).map(([k, v]) => `- ${k}: ${v.join(" / ")}`));
  const moves = new Map<string, number[]>();
  for (const r of rows.filter(bad)) {
    const k = `${r.scenario}: ${r.move}`;
    const v = moves.get(k) ?? [0, 0, 0];
    v[0] += 1;
    if (r.evLoss <= 0.25) v[1] += 1;
    if (r.evLoss <= 0.05) v[2] += 1;
    moves.set(k, v);
  }
  out.push("", "### Mistakes and Blunders by scenario and move, chosen → most played (all, ≤ 0.25bb, ≤ 0.05bb)", ...[...moves].sort((a, b) => b[1][0] - a[1][0]).map(([k, v]) => `- ${k}: ${v.join(" / ")}`));
  const rfiPos = new Map<string, number[]>();
  for (const r of rows.filter((r) => bad(r) && r.scenario === "rfi")) {
    const v = rfiPos.get(r.position) ?? [0, 0, 0];
    v[0] += 1;
    if (r.evLoss <= 0.25) v[1] += 1;
    if (r.evLoss <= 0.05) v[2] += 1;
    rfiPos.set(r.position, v);
  }
  out.push("", "### rfi Mistakes and Blunders by position (all, ≤ 0.25bb, ≤ 0.05bb)", ...[...rfiPos].sort((a, b) => b[1][0] - a[1][0]).map(([k, v]) => `- ${k}: ${v.join(" / ")}`));
  const bySet = new Map<string, number[]>();
  for (const r of rows) {
    const v = bySet.get(r.set) ?? [0, 0, 0];
    v[0] += 1;
    if (bad(r)) v[1] += 1;
    if (bad(r) && r.evLoss <= 0.25) v[2] += 1;
    bySet.set(r.set, v);
  }
  out.push("", "### By set (graded, Mistake+Blunder, of those ≤ 0.25bb)", ...[...bySet].sort((a, b) => b[1][0] - a[1][0]).map(([k, v]) => `- ${k}: ${v.join(" / ")}`));

  for (const s of swaps) {
    const sel = rows.filter((r) => r.other.has(s.name));
    if (!sel.length) continue;
    const graded = sel.filter((r) => r.other.get(s.name));
    out.push("", `### ${s.name}: ${sel.length} decisions on the set, ${graded.length} graded by both`, "| loss | n | Δ p50 | Δ p90 | grade changes |", "|---|---|---|---|---|");
    for (const [band] of BANDS) {
      const b = graded.filter((r) => bandOf(r.other.get(s.name)!.baseLoss) === band);
      if (!b.length) continue;
      const d: W[] = b.map((r) => [r.other.get(s.name)!.delta, 1]);
      out.push(`| ${band} | ${b.length} | ${f3(quantile(d, 0.5))} | ${f3(quantile(d, 0.9))} | ${b.filter((r) => r.other.get(s.name)!.grade !== r.other.get(s.name)!.baseGrade).length} |`);
    }
    const tiny = graded.filter((r) => {
      const o = r.other.get(s.name)!;
      return (o.baseGrade === "mistake" || o.baseGrade === "blunder") && o.baseLoss <= 0.25;
    });
    out.push(`Mistakes and Blunders ≤ 0.25bb: ${tiny.length}, grade changes ${tiny.filter((r) => r.other.get(s.name)!.grade !== r.other.get(s.name)!.baseGrade).length}`);
  }

  // Floors against the noise: per pot floor, the Mistakes and Blunders left, and how many of them a pair's other set grades differently (floored the same way).
  const FLOORS = [0, 2, 2.5, 3, 4, 5, 6, 8, 12.5];
  const bad2 = (g: Grade) => g === "mistake" || g === "blunder";
  out.push("", "### Pot floors: Mistakes / Blunders left, and their grade under each pair's other set", ...swaps.map((s, k) => `- pair ${k + 1}: ${s.name}`), "", `| floor bb | mistake | blunder | ${swaps.map((_, k) => `pair ${k + 1}: changed / M+B (not M+B there)`).join(" | ")} |`, `|---|---|---|${swaps.map(() => "---").join("|")}|`);
  for (const floor of FLOORS) {
    const cells = swaps.map((s) => {
      const sel = rows.flatMap((r) => {
        const o = r.other.get(s.name);
        return o ? [{ o, pot: r.potBb }] : [];
      });
      const flagged = sel.filter(({ o, pot }) => bad2(floored(o.base, pot, floor)));
      const moved = flagged.filter(({ o, pot }) => floored(o.base, pot, floor) !== floored(o.again, pot, floor));
      const cleared = flagged.filter(({ o, pot }) => !bad2(floored(o.again, pot, floor)));
      return `${moved.length}/${flagged.length} (${cleared.length} not M/B)`;
    });
    const gs = rows.map((r) => (r.base ? floored(r.base, r.potBb, floor) : r.grade));
    out.push(`| ${floor} | ${gs.filter((g) => g === "mistake").length} | ${gs.filter((g) => g === "blunder").length} | ${cells.join(" | ")} |`);
  }
  for (const s of swaps) {
    const d: W[] = rows.flatMap((r) => {
      const o = r.other.get(s.name);
      return o && bad2(o.baseGrade) && o.baseLoss <= 0.25 ? [[o.delta, 1] as W] : [];
    });
    if (d.length) out.push(`- ${s.name}: |Δ evLoss| over the Mistakes and Blunders ≤ 0.25bb: ${summary(d)}`);
  }

  // A loss under which the move would count as negligible (Perfect), the other form a rule could take.
  out.push("", "### Negligible below a loss in bb (rows that would change grade)");
  for (const negligible of [0.01, 0.02, 0.05]) {
    const moved = new Map<string, number>();
    for (const r of rows) {
      if (r.evLoss > negligible || r.grade === "perfect") continue;
      moved.set(`${r.grade} → perfect`, (moved.get(`${r.grade} → perfect`) ?? 0) + 1);
    }
    const total = [...moved.values()].reduce((x, y) => x + y, 0);
    out.push(`- ≤ ${negligible}bb: ${total} (${[...moved].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  }
  return out;
}

it("measures the charts' EV precision", { timeout: 6 * 60 * 60_000 }, () => {
  const out: string[] = [`## 1. Indifference gaps (classes playing two or more actions ≥ ${MIX * 100}%), bb`];
  for (const spec of CHART_SETS) {
    const set = committed(spec.id);
    const gaps = indifference(set);
    out.push(`- ${spec.id} (${set.version}, ${set.model.convergence.history.at(-1)?.iteration} it, NashConv ${set.model.convergence.nashConvMbb} mbb): ${summary(gaps.all)}`);
    if (spec.id === DEFAULT_CHART_SET || spec.id === "nlhe-cash-9max-100bb") {
      for (const [scenario, items] of [...gaps.byScenario].sort((a, b) => b[1].length - a[1].length)) out.push(`    - ${scenario}: ${summary(items)}`);
    }
  }
  const pairList = pairs();
  out.push("", "## 2. Pairs of sets, |Δ evLoss| per class × action, reach-weighted");
  for (const pair of pairList) out.push(...comparePair(pair), "");
  if (HANDS && existsSync(HANDS)) out.push(...storedHands(pairList));
  console.log(out.join("\n"));
});
