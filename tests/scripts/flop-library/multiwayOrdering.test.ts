/**
 * The flop library as an ordering of hands only, multiway, held out on shown
 * hands (§10, 2026-10-15). The open item of 2026-10-13
 * (`multiwayNarrowing.test.ts`): reading multiway flops with the heads-up
 * library's strategy lost to the heuristic held out (−0.090 ± 0.018 per combo
 * on the bettors and callers), because a heads-up equilibrium bets and calls
 * a different, more polarised share of its range. Untested there: keep the
 * heuristic's **multiway action shares** (how much of the range takes the
 * action: Σ w·L) and let the library only decide **which combos** carry it.
 *
 * For every multiway flop action the library can read (`multiwayLibrary.ts`,
 * the same plan, roles and line-following), with H the heuristic's
 * likelihood (`analysis/23`), S the library's frequency of the action for the
 * combo (S' = FLOOR + (1 − FLOOR) · S) and w the actor's range before the
 * action, three hybrids, one parameter each (α = 0 is the heuristic):
 *
 * - **geometric**: L ∝ H^(1−α) · S'^α;
 * - **linear**: L ∝ (1 − α) · H + α · S' · (Σ w·H / Σ w·S');
 * - **rank**: each combo's percentile in the range by H and by S (pH, pS) is
 *   blended, s = (1 − α) · pH + α · pS, and the combo takes the heuristic's
 *   likelihood at s's percentile (the heuristic's distribution of
 *   likelihoods, the library's order at α = 1);
 *
 * each rescaled so Σ w·L equals the heuristic's Σ w·H, no L above 1 (the
 * scale found by bisection with the cap). Every other action (turn, river,
 * flops without a chunk, actions the line cannot follow) is the heuristic.
 *
 * Scored as `analysis/17`-`/23`: every opponent shown down after a flop three
 * or more saw (the hero left out; no bomb pot), on their range as the turn
 * came (flop rows) and, if they acted on the turn, as the river came (turn
 * rows). Mean log-likelihood per combo of the shown combo, a combo outside
 * the range at a twentieth of a uniform combo. α is chosen held out (five
 * folds by player, the hash of the earlier studies, fitted on flop and turn
 * rows together); standard errors clustered by player.
 *
 *     cd tests && FLOPLIB_HANDS=/path/library.jsonl FLOPLIB_DIR=/path/out npm run floplib:multiway-ordering
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { it } from "vitest";

import {
  FLOOR,
  FlopLibraryLoader,
  flopSeats,
  heroSeatOf,
  heuristicModel,
  percentiles,
  walkMultiway,
  type NarrowingModel,
  type NarrowInput,
} from "../../../frontend/src/lib/analysis/index.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../frontend/src/lib/charts/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { comboIndex, NUM_COMBOS } from "../../../frontend/src/lib/solver/index.js";
import { buildContext } from "../../../frontend/src/lib/stats/context.js";
import { multiwayLibraryModel, multiwayLibraryPlan, type MultiwayLibraryModel } from "./multiwayLibrary.js";
import { toIndices } from "../../../frontend/src/lib/analysis/texture.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const DIR = process.env.FLOPLIB_DIR ?? "";
const FLOOR_LL = Math.log(1 / (20 * NUM_COMBOS));
const FOLDS = 5;
const ALPHAS = [0, 0.1, 0.25, 0.5, 0.75, 1];
const VARIANTS = ["geometric", "linear", "rank"] as const;
type Variant = (typeof VARIANTS)[number];
const BASE = "heuristic";
const name = (v: Variant, a: number) => (a === 0 ? BASE : `${v} ${a}`);

const localFetch = async (url: string): Promise<Response> => {
  const path = join(DIR, url.replace(/^local:\/*/, ""));
  if (!existsSync(path)) return new Response(null, { status: 404 });
  return new Response(readFileSync(path));
};

function ll(range: Float64Array | undefined, combo: number): number {
  if (!range) return FLOOR_LL;
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) total += range[c] > 0 ? range[c] : 0;
  if (!(total > 0) || !(range[combo] > 0)) return FLOOR_LL;
  return Math.max(FLOOR_LL, Math.log(range[combo] / total));
}

/** Scales `l` in place so Σ w·min(1, k·l) = mass (as close as the cap allows). */
function rescale(w: Float64Array, l: Float64Array, mass: number): Float64Array {
  const at = (k: number) => {
    let s = 0;
    for (let c = 0; c < NUM_COMBOS; c += 1) if (w[c] > 0) s += w[c] * Math.min(1, k * l[c]);
    return s;
  };
  let hi = 1;
  while (at(hi) < mass && hi < 1e9) hi *= 2;
  let lo = 0;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (at(mid) < mass) lo = mid;
    else hi = mid;
  }
  for (let c = 0; c < NUM_COMBOS; c += 1) l[c] = Math.min(1, hi * l[c]);
  return l;
}

/** The hybrid likelihood of one read action (the module comment). */
function hybrid(variant: Variant, alpha: number, w: Float64Array, h: Float64Array, s: Float64Array): Float64Array {
  const sp = new Float64Array(NUM_COMBOS);
  let mass = 0;
  let libMass = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    sp[c] = FLOOR + (1 - FLOOR) * Math.min(1, Math.max(0, s[c] || 0));
    if (w[c] > 0) {
      mass += w[c] * h[c];
      libMass += w[c] * sp[c];
    }
  }
  const out = new Float64Array(NUM_COMBOS);
  if (!(mass > 0) || !(libMass > 0)) return Float64Array.from(h);
  if (variant === "geometric") {
    for (let c = 0; c < NUM_COMBOS; c += 1) out[c] = w[c] > 0 ? Math.pow(Math.max(h[c], 1e-9), 1 - alpha) * Math.pow(sp[c], alpha) : h[c];
  } else if (variant === "linear") {
    const k = mass / libMass;
    for (let c = 0; c < NUM_COMBOS; c += 1) out[c] = w[c] > 0 ? (1 - alpha) * h[c] + alpha * sp[c] * k : h[c];
  } else {
    const pH = percentiles(h, w);
    const pS = percentiles(sp, w);
    const blend = new Float64Array(NUM_COMBOS).fill(NaN);
    for (let c = 0; c < NUM_COMBOS; c += 1) if (w[c] > 0) blend[c] = (1 - alpha) * pH[c] + alpha * pS[c] + 1e-6 * pH[c];
    const q = percentiles(blend, w);
    // The heuristic's weighted quantile function.
    const live: number[] = [];
    let total = 0;
    for (let c = 0; c < NUM_COMBOS; c += 1) {
      if (w[c] > 0) {
        live.push(c);
        total += w[c];
      }
    }
    live.sort((a, b) => h[a] - h[b] || a - b);
    const cum = new Float64Array(live.length);
    let run = 0;
    live.forEach((c, i) => {
      run += w[c];
      cum[i] = run / total;
    });
    for (let c = 0; c < NUM_COMBOS; c += 1) {
      if (!(w[c] > 0)) {
        out[c] = h[c];
        continue;
      }
      const target = q[c];
      let a = 0;
      let b = live.length - 1;
      while (a < b) {
        const m = (a + b) >> 1;
        if (cum[m] < target) a = m + 1;
        else b = m;
      }
      out[c] = h[live[a]];
    }
  }
  return rescale(w, out, mass);
}

/** The heuristic, with each library-read flop action replaced by the hybrid. */
const hybridModel = (variant: Variant, alpha: number, lib: MultiwayLibraryModel): NarrowingModel => ({
  id: `${variant}-${alpha}`,
  likelihood(input: NarrowInput) {
    const h = heuristicModel.likelihood(input);
    if (input.street !== "flop" || input.actionIndex === undefined || !lib.covers(input.actionIndex)) return h;
    return hybrid(variant, alpha, input.actor, h, lib.likelihood(input));
  },
});

interface Row {
  player: string;
  fold: number;
  street: "flop" | "turn";
  /** The player's flop actions: bet or raised, called (no bet), checked only. */
  role: "bettor" | "caller" | "checker";
  hero: boolean;
  covered: boolean;
  /** Own flop actions read by the library. */
  read: number;
  pot: string;
  score: Record<string, number>;
}

const foldOf = (n: string) => createHash("sha256").update(n).digest()[0] % FOLDS;

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

it("scores the library as an ordering of hands on multiway flops", { timeout: 12 * 60 * 60_000 }, async () => {
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

  const names: string[] = [BASE];
  for (const v of VARIANTS) for (const a of ALPHAS) if (a > 0) names.push(name(v, a));

  const started = performance.now();
  const rows: Row[] = [];
  let reads = 0;
  for (const hand of hands) {
    if (hand.actions.some((a) => a.type === "bomb-ante")) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length < 3) continue;
    const actual = heroSeatOf(context);
    const comboOf = (seat: number): number | null => {
      try {
        const cards = toIndices(context.players.get(seat)?.holeCards ?? []);
        return cards.length === 2 ? comboIndex(cards[0], cards[1]) : null;
      } catch {
        return null;
      }
    };
    const shown = seats.filter((seat) => seat !== actual && comboOf(seat) !== null);
    if (shown.length === 0) continue;
    const heroIn = actual !== null && seats.includes(actual);
    const hero = heroIn ? (actual as number) : seats[0];
    const options = { populationHero: actual ?? -1 };
    const plan = multiwayLibraryPlan(hand, context, charts, library);
    const chunk = plan ? await library.load(plan.set, plan.line.id, plan.flop) : null;
    const probe = plan && chunk ? multiwayLibraryModel(hand, plan, chunk, charts, { floor: 0 }) : null;

    const walk = (model: NarrowingModel) => {
      try {
        return walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), hero, charts, model, options);
      } catch {
        return { ok: false as const, reason: "range-empty" as const };
      }
    };
    const walks: Record<string, ReturnType<typeof walkMultiway>> = { [BASE]: walk(heuristicModel) };
    if (!walks[BASE].ok) continue;
    if (plan && chunk && probe) {
      for (const v of VARIANTS) {
        for (const a of ALPHAS) {
          if (a === 0) continue;
          const lib = multiwayLibraryModel(hand, plan, chunk, charts, { floor: 0 }) as MultiwayLibraryModel;
          walks[name(v, a)] = walk(hybridModel(v, a, lib));
          if (v === "geometric" && a === 1) {
            reads += lib.counts().library;
          }
        }
      }
    }
    const base = walks[BASE];
    for (const seat of shown) {
      const combo = comboOf(seat) as number;
      const player = `${hand.meta.siteId}/${context.players.get(seat)?.name ?? seat}`;
      const flopActs = hand.actions.filter((a) => a.street === "flop" && a.seat === seat && ["check", "bet", "raise", "call"].includes(a.type));
      if (flopActs.length === 0) continue;
      const role = flopActs.some((a) => a.type === "bet" || a.type === "raise") ? "bettor" : flopActs.some((a) => a.type === "call") ? "caller" : "checker";
      for (const street of ["flop", "turn"] as const) {
        if (street === "turn") {
          const turnActs = hand.actions.filter((a) => a.street === "turn" && a.seat === seat && ["check", "bet", "raise", "call"].includes(a.type));
          if (turnActs.length === 0) continue;
        }
        const at = (w: (typeof walks)[string]) => (w.ok ? (street === "flop" ? w.starts.turn : w.starts.river) : null);
        if (!at(base)?.has(seat)) continue;
        const score: Record<string, number> = {};
        for (const n of names) score[n] = walks[n] ? ll(at(walks[n])?.get(seat), combo) : score[BASE];
        rows.push({
          player,
          fold: foldOf(player),
          street,
          role,
          hero: heroIn,
          covered: probe !== null,
          read: probe ? flopActs.filter((a) => probe.covers(a.index)).length : 0,
          pot: plan?.pot ?? "none",
          score,
        });
      }
    }
  }
  const flop = rows.filter((r) => r.street === "flop");
  const turn = rows.filter((r) => r.street === "turn");
  console.log(
    `=== ${FILE}: ${hands.length} hands; ${rows.length} rows (flop ${flop.length}, turn ${turn.length}; ${new Set(rows.map((r) => r.player)).size} players); flop rows on a chunk ${flop.filter((r) => r.covered).length}; flop actions narrowed by a hybrid ${reads} (${((performance.now() - started) / 1000).toFixed(0)} s)`,
  );

  // Held out: each fold scored with the candidate that did best on the other four (flop and turn rows together).
  const heldOut = (pool: readonly string[]) => {
    const chosen: string[] = [];
    const out = new Map<Row, number>();
    for (let k = 0; k < FOLDS; k += 1) {
      const train = rows.filter((r) => r.fold !== k);
      let best = BASE;
      let bestMean = -Infinity;
      for (const n of pool) {
        const mean = train.reduce((s, r) => s + r.score[n], 0) / Math.max(1, train.length);
        if (mean > bestMean + 1e-12) {
          bestMean = mean;
          best = n;
        }
      }
      chosen.push(best);
      for (const r of rows) if (r.fold === k) out.set(r, r.score[best]);
    }
    return { chosen, out };
  };
  const fits: Record<string, ReturnType<typeof heldOut>> = {};
  for (const v of VARIANTS) fits[v] = heldOut(ALPHAS.map((a) => name(v, a)));
  fits.any = heldOut(names);
  for (const [k, f] of Object.entries(fits)) console.log(`held-out choices, ${k}: ${f.chosen.join(" / ")}`);
  const insample = [...names].sort((a, b) => rows.reduce((s, r) => s + r.score[b], 0) - rows.reduce((s, r) => s + r.score[a], 0));
  console.log(`in-sample best: ${insample.slice(0, 6).map((n) => `${n} ${f3(clustered(rows, (r) => r.score[n] - r.score[BASE]).mean)}`).join(", ")}`);
  const fixed = ["geometric 0.5", "geometric 1", "linear 0.5", "linear 1", "rank 0.5", "rank 1"];

  const cols = [...VARIANTS, "any"];
  console.log(`| subset | n (players) | analysis/23 | ${cols.map((c) => `${c}, held out`).join(" | ")} | ${fixed.join(" | ")} |`);
  const report = (title: string, subset: readonly Row[]) => {
    if (subset.length === 0) return;
    const b = clustered(subset, (r) => r.score[BASE]);
    const held = cols.map((c) => {
      const d = clustered(subset, (r) => (fits[c].out.get(r) as number) - r.score[BASE]);
      return `${f3(d.mean)} ± ${d.se.toFixed(3)}`;
    });
    const extra = fixed.map((n) => {
      const d = clustered(subset, (r) => r.score[n] - r.score[BASE]);
      return `${f3(d.mean)} ± ${d.se.toFixed(3)}`;
    });
    console.log(`| ${title} | ${subset.length} (${b.players}) | ${b.mean.toFixed(3)} | ${held.join(" | ")} | ${extra.join(" | ")} |`);
  };
  report("flop and turn together", rows);
  report("flop, everyone", flop);
  report("flop, a chunk read", flop.filter((r) => r.covered));
  report("flop, at least one own action read", flop.filter((r) => r.read > 0));
  report("flop, bet or raised", flop.filter((r) => r.role === "bettor"));
  report("flop, called (no bet)", flop.filter((r) => r.role === "caller"));
  report("flop, checked only", flop.filter((r) => r.role === "checker"));
  report("flop, bet, raised or called, a chunk read", flop.filter((r) => r.covered && r.role !== "checker"));
  report("flop, checked only, a chunk read", flop.filter((r) => r.covered && r.role === "checker"));
  for (const pot of ["srp", "limped", "3bp"]) report(`flop, ${pot}, a chunk read`, flop.filter((r) => r.covered && r.pot === pot));
  report("flop, the hero's pots", flop.filter((r) => r.hero));
  report("flop, pots without the hero", flop.filter((r) => !r.hero));
  report("turn after a multiway flop", turn);
  report("turn, a chunk read on the flop", turn.filter((r) => r.covered));
  report("turn, the hero's pots", turn.filter((r) => r.hero));
  report("turn, pots without the hero", turn.filter((r) => !r.hero));
});
