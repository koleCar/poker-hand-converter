/**
 * Multiway flop narrowing from the library, held out on shown hands (§10,
 * 2026-10-13). Every opponent whose hole cards a hand shows and who saw a
 * flop three or more saw (the hero left out; no bomb pot) is scored on their
 * range as the turn came, narrowed through the flop by each candidate model:
 * the heuristic (`heuristic/2` with its multiway adjustments, as the analysis
 * narrows multiway flops today) and the library read for multiway pots
 * (`multiwayLibrary.ts` beside this file, study code only) at several floors ε. Score as `analysis/17`-`/20`:
 * mean log-likelihood per combo of the shown combo, a combo outside the
 * range at a twentieth of a uniform combo. ε is chosen held out (five folds
 * by player, every player scored by the ε that did best on the other four);
 * standard errors are clustered by player.
 *
 *     cd tests && FLOPLIB_HANDS=/path/library.jsonl FLOPLIB_DIR=/path/out npm run floplib:multiway-narrowing
 *
 * **Grades.** For the hero's flop and turn calls and folds facing a bet that
 * the analysis grades approximately (`analysis/15`, `/16`) in hands whose
 * multiway flop has a chunk, the approximate call is computed twice on the
 * same path (`flopCallEv`/`turnCallEv` and their grade, without the
 * sensitivity check) - on the heuristic walk and on the library walk (ε =
 * `MULTIWAY_LIBRARY_FLOOR` and ε = 0.5, the held-out choice) - and the grades
 * compared; `FLOPLIB_EXAMPLES=1` prints the changed ones (board, cards,
 * action, share, grade) to the console.
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { it } from "vitest";

import {
  analyzeHand,
  FlopLibraryLoader,
  flopCallEv,
  gradeFlopCall,
  gradeTurnCall,
  heroSpots,
  turnCallEv,
  flopSeats,
  heroSeatOf,
  heuristicModel,
  libraryEntry,
  libraryModel,
  walkMultiway,
  walkRanges,
  type NarrowingModel,
  type NarrowInput,
} from "../../../web/src/lib/analysis/index.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../web/src/lib/charts/index.js";
import type { PhfHand } from "../../../web/src/lib/phf/types.js";
import { comboIndex, NUM_COMBOS } from "../../../web/src/lib/solver/index.js";
import { buildContext } from "../../../web/src/lib/stats/context.js";
import { multiwayLibraryModel, multiwayLibraryPlan } from "./multiwayLibrary.js";
import { toIndices } from "../../../web/src/lib/analysis/texture.js";

const DATA = join(import.meta.dirname, "../../../web/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const DIR = process.env.FLOPLIB_DIR ?? "";
const FLOORS = [0, 0.01, 0.03, 0.1, 0.3, 0.5, 1];
const FLOOR_LL = Math.log(1 / (20 * NUM_COMBOS));
const FOLDS = 5;
const EXAMPLES = process.env.FLOPLIB_EXAMPLES === "1";
/** `FLOPLIB_HAND=n`: only the n-th hand of the file, every approximate grade printed with its plan. */
const ONLY = process.env.FLOPLIB_HAND ? Number(process.env.FLOPLIB_HAND) : null;

const localFetch = async (url: string): Promise<Response> => {
  const path = join(DIR, url.replace(/^local:\/*/, ""));
  if (!existsSync(path)) return new Response(null, { status: 404 });
  return new Response(readFileSync(path));
};

/** ln(w(c) / Σw), floored at a twentieth of a uniform combo. */
function ll(range: Float64Array | undefined, combo: number): number {
  if (!range) return FLOOR_LL;
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) total += range[c] > 0 ? range[c] : 0;
  if (!(total > 0) || !(range[combo] > 0)) return FLOOR_LL;
  return Math.max(FLOOR_LL, Math.log(range[combo] / total));
}

/** The geometric mean of two models' likelihoods. */
const geometric = (a: NarrowingModel, b: NarrowingModel): NarrowingModel => ({
  id: `${a.id}*${b.id}`,
  likelihood(input: NarrowInput) {
    const x = a.likelihood(input);
    const y = b.likelihood(input);
    const out = new Float64Array(x.length);
    for (let c = 0; c < x.length; c += 1) out[c] = Math.sqrt(Math.max(0, x[c]) * Math.max(0, y[c]));
    return out;
  },
});

/** No narrowing on the flop (every flop action likelihood 1), the heuristic after it: how much any flop narrowing is worth. */
const flopBlind: NarrowingModel = {
  id: "flop-blind",
  likelihood(input: NarrowInput) {
    return input.street === "flop" ? new Float64Array(NUM_COMBOS).fill(1) : heuristicModel.likelihood(input);
  },
};

interface Row {
  player: string;
  fold: number;
  pot: string;
  covered: boolean;
  /** Bet, raised or called on the flop. */
  active: boolean;
  /** The player's flop actions, and how many of them read the library. */
  acts: number;
  read: number;
  score: Record<string, number>;
}

const foldOf = (name: string) => createHash("sha256").update(name).digest()[0] % FOLDS;

/** Mean and standard error clustered by player of x[i] (paired differences go in as x). */
function clustered(rows: readonly Row[], x: (r: Row) => number): { mean: number; se: number; n: number; players: number } {
  const n = rows.length;
  if (n === 0) return { mean: NaN, se: NaN, n: 0, players: 0 };
  const mean = rows.reduce((s, r) => s + x(r), 0) / n;
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.player, (by.get(r.player) ?? 0) + (x(r) - mean));
  const g = by.size;
  let v = 0;
  for (const s of by.values()) v += s * s;
  const se = g > 1 ? Math.sqrt((g / (g - 1)) * v) / n : NaN;
  return { mean, se, n, players: g };
}

const f3 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);

it("scores multiway flop narrowing on shown hands", { timeout: 12 * 60 * 60_000 }, async () => {
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
  for (const spec of CHART_SETS) await library.ready(spec.id);

  /** Control: heads-up flops the library reads for the hero today; the shown opponent's range by the shipped library model and by the heuristic. */
  const control: Row[] = [];
  const headsUp = async (hand: PhfHand, context: ReturnType<typeof buildContext>, seats: number[]) => {
    const hero = heroSeatOf(context);
    if (hero === null || !seats.includes(hero)) return;
    const villain = seats[0] === hero ? seats[1] : seats[0];
    if ((context.players.get(villain)?.holeCards?.length ?? 0) !== 2) return;
    await library.prefetch(hand, charts);
    const entry = libraryEntry(hand, context, hero, charts, library);
    if (!entry.ok) return;
    const flopActs = hand.actions.filter((a) => a.street === "flop" && a.seat === villain && ["check", "bet", "raise", "call"].includes(a.type));
    if (flopActs.length === 0) return;
    let combo: number;
    try {
      const cards = toIndices(context.players.get(villain)?.holeCards ?? []);
      combo = comboIndex(cards[0], cards[1]);
    } catch {
      return;
    }
    const score: Record<string, number> = {};
    const lib = libraryModel(entry, heuristicModel);
    for (const [name, model] of Object.entries({ heuristic: heuristicModel, "lib 0": lib, "no flop narrowing": flopBlind } as Record<string, NarrowingModel>)) {
      const walk = walkRanges(structuredClone(hand), buildContext(structuredClone(hand)), hero, villain, charts, model, { populationHero: hero });
      score[name] = walk.ok ? ll(walk.turnStart?.villain, combo) : FLOOR_LL;
    }
    if (lib.flopSource() === "heuristic") return;
    const name = `${hand.meta.siteId}/${context.players.get(villain)?.name ?? villain}`;
    control.push({ player: name, fold: foldOf(name), pot: "hu", covered: true, active: flopActs.some((a) => a.type !== "check"), acts: flopActs.length, read: 0, score });
  };

  /** The hero's approximate flop and turn call grades, on the heuristic walk and on the library's. */
  const moves = new Map<string, number>();
  const move = (k: string) => moves.set(k, (moves.get(k) ?? 0) + 1);
  const examples: string[] = [];
  const grades = async (
    hand: PhfHand,
    hero: number,
    plan: NonNullable<ReturnType<typeof multiwayLibraryPlan>>,
    chunk: NonNullable<Awaited<ReturnType<typeof library.load>>>,
  ) => {
    await library.prefetch(hand, charts);
    const analysis = analyzeHand(structuredClone(hand), { charts, turn: false, flopLibrary: library });
    const targets = analysis.decisions.filter((d) => d.source === "approx" && (d.street === "flop" || d.street === "turn") && (d.action === "call" || d.action === "fold"));
    if (targets.length === 0) return;
    const copy = structuredClone(hand);
    const context = buildContext(copy);
    const spots = heroSpots(context, hero);
    const options = { populationHero: hero };
    const walks: Record<string, ReturnType<typeof walkMultiway>> = { heuristic: walkMultiway(copy, context, hero, charts, heuristicModel, options) };
    for (const floor of [undefined, 0.5]) {
      const m = multiwayLibraryModel(hand, plan, chunk, charts, floor === undefined ? {} : { floor });
      if (m) walks[`lib ${floor ?? "default"}`] = walkMultiway(copy, context, hero, charts, m, options);
    }
    for (const d of targets) {
      const spot = spots.find((x) => x.action.index === d.actionIndex);
      if (!spot) continue;
      const out: Record<string, { grade: string; equity: number; evLoss: number } | null> = {};
      for (const [name, walk] of Object.entries(walks)) {
        if (!walk.ok) {
          out[name] = null;
          continue;
        }
        const input = { spot, facts: d.facts, hand: copy, context, hero, walk, model: heuristicModel, charts, seed: 7 };
        const evs = d.street === "flop" ? flopCallEv(input) : turnCallEv(input);
        if (!evs.ok) {
          out[name] = null;
          continue;
        }
        const g = d.street === "flop" ? gradeFlopCall(evs, d.action as "call" | "fold", d.facts.potBb) : gradeTurnCall(evs, d.action as "call" | "fold", d.facts.potBb);
        out[name] = { grade: g.grade, equity: evs.equity, evLoss: g.evLoss };
      }
      const base = out.heuristic;
      if (!base) continue;
      for (const name of Object.keys(walks)) {
        if (name === "heuristic") continue;
        const now = out[name];
        move(`${name} ${d.street} graded`);
        if (!now) {
          move(`${name} ${d.street} lost`);
          continue;
        }
        if (ONLY !== null) {
          console.log(`  hand ${ONLY}: ${plan.line.id} ${plan.flop}${plan.exact ? "" : " (mapped)"} roles ${[...plan.roles].map(([seat, p]) => `${context.position.get(seat)}=${p}`).join(" ")} | ${d.street} ${d.action} | ${name}: share ${(100 * base.equity).toFixed(0)}% -> ${(100 * now.equity).toFixed(0)}%, ${base.grade} (${base.evLoss.toFixed(2)}bb) -> ${now.grade} (${now.evLoss.toFixed(2)}bb)`);
        }
        if (now.grade !== base.grade) {
          move(`${name} ${d.street} changed`);
          move(`${name} ${d.street} ${d.action} ${base.grade} -> ${now.grade}`);
          if (EXAMPLES && name === "lib default") {
            const runout = hand.board.runouts[0];
            const board = [...(runout?.flop ?? []), ...(d.street === "turn" && runout?.turn ? [runout.turn] : [])].join(" ");
            examples.push(
              `${d.street} ${plan.pot}${plan.exact ? "" : " (mapped)"} ${board} | ${(context.players.get(hero)?.holeCards ?? []).join("")} ${d.action} ${d.facts.toCallBb.toFixed(1)}bb into ${d.facts.potBb.toFixed(1)}bb, ${d.facts.players} at the decision | share ${(100 * base.equity).toFixed(0)}% -> ${(100 * now.equity).toFixed(0)}% | ${base.grade} (${base.evLoss.toFixed(1)}bb) -> ${now.grade} (${now.evLoss.toFixed(1)}bb)`,
            );
          }
        }
      }
    }
  };

  const started = performance.now();
  const rows: Row[] = [];
  const census = new Map<string, number>();
  const bump = (k: string, by = 1) => census.set(k, (census.get(k) ?? 0) + by);
  for (const [h, hand] of hands.entries()) {
    if (ONLY !== null && h !== ONLY) continue;
    if (hand.actions.some((a) => a.type === "bomb-ante")) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length === 2) {
      await headsUp(hand, context, seats);
      continue;
    }
    if (seats.length < 3) continue;
    const actual = heroSeatOf(context);
    const shown = seats.filter((seat) => seat !== actual && (context.players.get(seat)?.holeCards?.length ?? 0) === 2);
    bump("multiway flops");
    const plan = multiwayLibraryPlan(hand, context, charts, library);
    let chunk = null;
    if (plan) chunk = await library.load(plan.set, plan.line.id, plan.flop);
    if (plan && chunk && actual !== null && seats.includes(actual)) await grades(hand, actual, plan, chunk);
    if (shown.length === 0) continue;
    const hero = actual !== null && seats.includes(actual) ? actual : seats[0];
    const options = { populationHero: actual ?? -1 };

    const models: Record<string, NarrowingModel> = { heuristic: heuristicModel, "no flop narrowing": flopBlind };
    let probe = null;
    if (plan && chunk) {
      for (const floor of FLOORS) {
        const m = multiwayLibraryModel(hand, plan, chunk, charts, { floor });
        if (m) models[`lib ${floor}`] = m;
      }
      probe = multiwayLibraryModel(hand, plan, chunk, charts);
      if (probe) models["lib 0.03 × heuristic"] = geometric(probe, heuristicModel);
    }
    bump(plan ? (chunk ? `plan ${plan.pot} ${plan.exact ? "exact" : "mapped"}` : "plan, no chunk") : "no plan");
    const ranges: Record<string, ReturnType<typeof walkMultiway>> = {};
    for (const [name, model] of Object.entries(models)) {
      try {
        ranges[name] = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), hero, charts, model, options);
      } catch {
        ranges[name] = { ok: false, reason: "range-empty" };
      }
    }
    if (!ranges.heuristic.ok) {
      bump(`walk failed ${ranges.heuristic.reason}`);
      continue;
    }
    for (const seat of shown) {
      let combo: number;
      try {
        const cards = toIndices(context.players.get(seat)?.holeCards ?? []);
        combo = comboIndex(cards[0], cards[1]);
      } catch {
        continue;
      }
      const flopActs = hand.actions.filter((a) => a.street === "flop" && a.seat === seat && ["check", "bet", "raise", "call"].includes(a.type));
      if (flopActs.length === 0) continue;
      const name = `${hand.meta.siteId}/${context.players.get(seat)?.name ?? seat}`;
      const score: Record<string, number> = {};
      for (const [m, walk] of Object.entries(ranges)) {
        score[m] = walk.ok ? ll(walk.starts.turn?.get(seat), combo) : FLOOR_LL;
      }
      // Where the library has no chunk, every library candidate is the heuristic.
      for (const floor of FLOORS) score[`lib ${floor}`] ??= score.heuristic;
      score["lib 0.03 × heuristic"] ??= score.heuristic;
      rows.push({
        player: name,
        fold: foldOf(name),
        pot: plan?.pot ?? (hand.actions.some((a) => a.street === "preflop" && a.type === "raise") ? "other" : "limped-other"),
        covered: probe !== null,
        active: flopActs.some((a) => a.type !== "check"),
        acts: flopActs.length,
        read: probe ? flopActs.filter((a) => probe.covers(a.index)).length : 0,
        score,
      });
    }
  }
  console.log(`=== ${FILE}: ${hands.length} hands, ${rows.length} shown multiway flop players (${((performance.now() - started) / 1000).toFixed(0)} s)`);
  console.log(`census: ${[...census].map(([k, v]) => `${k} ${v}`).join(", ")}`);

  // ε held out: each fold scored with the floor that did best on the other folds (active rows).
  const heldOut = (subset: readonly Row[], train: (r: Row) => boolean) => {
    const chosen: number[] = [];
    const out = new Map<Row, number>();
    for (let k = 0; k < FOLDS; k += 1) {
      const fit = subset.filter((r) => r.fold !== k && train(r));
      let best = FLOORS[0];
      let bestMean = -Infinity;
      for (const floor of FLOORS) {
        const mean = fit.reduce((s, r) => s + r.score[`lib ${floor}`], 0) / Math.max(1, fit.length);
        if (mean > bestMean) {
          bestMean = mean;
          best = floor;
        }
      }
      chosen.push(best);
      for (const r of subset) if (r.fold === k) out.set(r, r.score[`lib ${best}`]);
    }
    return { chosen, out };
  };

  const report = (title: string, subset: readonly Row[]) => {
    if (subset.length === 0) return;
    const { chosen, out } = heldOut(subset, (r) => r.covered);
    const base = clustered(subset, (r) => r.score.heuristic);
    const lines = [`--- ${title}: ${subset.length} shown (${new Set(subset.map((r) => r.player)).size} players); heuristic ${base.mean.toFixed(3)}`];
    const d = clustered(subset, (r) => (out.get(r) as number) - r.score.heuristic);
    lines.push(`  library, ε held out (${chosen.join("/")}): ${(base.mean + d.mean).toFixed(3)}, Δ ${f3(d.mean)} ± ${d.se.toFixed(3)}`);
    for (const name of [...FLOORS.map((f) => `lib ${f}`), "lib 0.03 × heuristic", "no flop narrowing"]) {
      const dd = clustered(subset, (r) => r.score[name] - r.score.heuristic);
      lines.push(`  ${name}: Δ ${f3(dd.mean)} ± ${dd.se.toFixed(3)}`);
    }
    console.log(lines.join("\n"));
  };

  const active = rows.filter((r) => r.active);
  report("bettors, raisers and callers on the flop, all", active);
  report("bettors, raisers and callers, a chunk read", active.filter((r) => r.covered));
  report("bettors, raisers and callers, at least one own action read by the library", active.filter((r) => r.read > 0));
  for (const pot of ["srp", "3bp", "limped"]) report(`bettors, raisers and callers, ${pot}`, active.filter((r) => r.covered && r.pot === pot));
  report("checkers only (check, then nothing else on the flop), a chunk read", rows.filter((r) => !r.active && r.covered));
  report("everyone shown, a chunk read", rows.filter((r) => r.covered));
  for (const [title, subset] of [
    ["control, heads-up flops the library reads (shipped since analysis/8), bettors/raisers/callers", control.filter((r) => r.active)],
    ["control, heads-up, checkers only", control.filter((r) => !r.active)],
  ] as const) {
    if (subset.length === 0) continue;
    const base = clustered(subset, (r) => r.score.heuristic);
    const a = clustered(subset, (r) => r.score["lib 0"] - r.score.heuristic);
    const b = clustered(subset, (r) => r.score["no flop narrowing"] - r.score.heuristic);
    console.log(`--- ${title}: ${subset.length} shown (${base.players} players); heuristic ${base.mean.toFixed(3)}; library Δ ${f3(a.mean)} ± ${a.se.toFixed(3)}; no flop narrowing Δ ${f3(b.mean)} ± ${b.se.toFixed(3)}`);
  }
  console.log(`--- the hero's approximate flop and turn calls and folds on a multiway flop with a chunk, heuristic walk -> library walk:`);
  for (const [k, v] of [...moves].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${k}: ${v}`);
  for (const e of examples) console.log(`  example: ${e}`);
  const covered = active.filter((r) => r.covered);
  console.log(
    `coverage among the bettors, raisers and callers: ${covered.length} of ${active.length} on a chunk; their flop actions ${covered.reduce((s, r) => s + r.acts, 0)}, read by the library ${covered.reduce((s, r) => s + r.read, 0)}`,
  );
});
