/**
 * A smaller multiway check trim, held out on shown hands (§10, 2026-10-14).
 * The open point of the 2026-10-13 study (`multiwayNarrowing.test.ts`, whose
 * data source, score and folds this reuses): not narrowing multiway checks
 * at all scored +0.037 ± 0.022 per combo over the heuristic on players who
 * only checked. Here the heuristic's check likelihood is recomputed with
 * other constants (`CHECK_VALUE`, `CHECK_AIR`, `CHECK_DRAW`), or with its
 * trim scaled by one factor, **only for checks made with three or more live
 * players** (`NarrowInput.players ≥ 3`, as `walkMultiway` sets it); every
 * other action is the shipped `heuristic/2`.
 *
 * Scored: every opponent shown down after a flop three or more saw (the hero
 * left out; no bomb pot), on their range as the turn came (flop rows), and
 * every one still in as the river came after a turn three or more began
 * (turn rows), on their range as the river came. Score as `analysis/17`-`/21`:
 * mean log-likelihood per combo of the shown combo, a combo outside the range
 * at a twentieth of a uniform combo. The candidate is chosen held out: five
 * folds by player (the same hash as `multiwayNarrowing.test.ts`), every
 * player scored by the candidate that did best on the other four folds' flop
 * and turn rows together; standard errors clustered by player.
 *
 * The baseline is `analysis/21`'s heuristic, restated here (`SHIPPED`), so the
 * study still compares against it after `analysis/22`; a fidelity check
 * confirms the shipped `heuristicModel` is the study's winner (`WINNER`).
 *
 * Control: heads-up flops (every one with a shown opponent, the heuristic
 * walk, not only the library's), where the shipped candidate changes nothing;
 * the same trims applied heads-up are scored too, to say whether the trim is
 * too hard everywhere or only multiway.
 *
 *     cd tests && FLOPLIB_HANDS=/path/library.jsonl FLOPLIB_DIR=/path/out npm run floplib:check-trim
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { it } from "vitest";

import {
  BLUFF_ZONE,
  CHECK_REPEAT,
  effectiveStrength,
  FlopLibraryLoader,
  flopSeats,
  handStrength,
  heroSeatOf,
  heuristicModel,
  percentiles,
  streetStrength,
  VALUE_SHARE,
  walkMultiway,
  walkRanges,
  type NarrowingModel,
  type NarrowInput,
} from "../../../web/src/lib/analysis/index.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../web/src/lib/charts/index.js";
import type { PhfHand } from "../../../web/src/lib/phf/types.js";
import { comboIndex, NUM_COMBOS } from "../../../web/src/lib/solver/index.js";
import { buildContext } from "../../../web/src/lib/stats/context.js";
import { multiwayLibraryPlan } from "./multiwayLibrary.js";
import { toIndices } from "../../../web/src/lib/analysis/texture.js";

const DATA = join(import.meta.dirname, "../../../web/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const DIR = process.env.FLOPLIB_DIR ?? "";
const FLOOR_LL = Math.log(1 / (20 * NUM_COMBOS));
const FOLDS = 5;

/**
 * `analysis/21`'s check constants (`narrowing.ts`, heads-up and multiway
 * alike), restated so the study can vary them: the baseline every candidate
 * is compared with. `analysis/22` ships the held-out winner, multiway only.
 */
const SHIPPED = { value: 0.5, air: 0.7, draw: 0.6 };
/** What `analysis/22` ships for multiway flop and turn checks (`MULTIWAY_CHECK_VALUE`, `MULTIWAY_CHECK_DRAW`). */
const WINNER = { value: 0.65, air: 0.7, draw: 1, scale: 1 };
const FLOOR = 0.03;
const RAMP = 0.12;
const STRONG_DRAW_OUTS = 8;
const WEAK_DRAW_OUTS = 4;

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

function ramp(q: number, from: number, to: number): number {
  if (q <= from) return 0;
  if (q >= to) return 1;
  return (q - from) / (to - from);
}

interface Trim {
  value: number;
  air: number;
  draw: number;
  /** The whole trim × this (1: the constants as they are). */
  scale: number;
}

/** `narrowing.ts`'s `check()`, with its constants as parameters. */
function checkLikelihood(input: NarrowInput, t: Trim): Float64Array {
  const strength = input.strength ?? streetStrength(input.board);
  let hs = handStrength(strength, input.opponent);
  if (input.opponents && input.opponents.length >= 2) {
    hs = handStrength(strength, input.opponents[0]);
    for (let i = 1; i < input.opponents.length; i += 1) {
      const other = handStrength(strength, input.opponents[i]);
      for (let c = 0; c < NUM_COMBOS; c += 1) hs[c] *= other[c];
    }
  }
  const q = percentiles(effectiveStrength(strength, hs), input.actor);
  const outs = strength.outs;
  const repeat = t.scale * Math.pow(CHECK_REPEAT, Math.max(0, input.action.checksBefore ?? 0));
  const cut = 1 - VALUE_SHARE[input.street];
  const out = new Float64Array(NUM_COMBOS);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (!(input.actor[c] > 0) || Number.isNaN(q[c])) continue;
    const o = outs[c];
    if (o >= STRONG_DRAW_OUTS) {
      out[c] = 1 - (1 - t.draw) * repeat;
      continue;
    }
    const value = ramp(q[c], cut - RAMP, cut);
    const air = q[c] < BLUFF_ZONE && o < WEAK_DRAW_OUTS ? 1 - ramp(q[c], BLUFF_ZONE - RAMP, BLUFF_ZONE) : 0;
    out[c] = Math.max(FLOOR, 1 - repeat * (value * (1 - t.value) + air * (1 - t.air)));
  }
  return out;
}

/** The heuristic with checks re-trimmed: multiway checks only, or every check (`everywhere`, the heads-up control). */
const trimmed = (id: string, t: Trim, everywhere = false): NarrowingModel => ({
  id,
  likelihood(input: NarrowInput) {
    if (input.action.kind === "check" && input.street !== "river" && (everywhere || (input.players ?? 2) >= 3)) return checkLikelihood(input, t);
    return heuristicModel.likelihood(input);
  },
});

const label = (t: Trim) => (t.scale !== 1 ? `scale ${t.scale}` : `V${t.value} A${t.air} D${t.draw}`);
const CURRENT = label({ ...SHIPPED, scale: 1 });

const GRID: Trim[] = [];
for (const value of [0.5, 0.65, 0.8, 1]) for (const air of [0.7, 0.8, 0.9, 1]) for (const draw of [0.6, 0.8, 1]) GRID.push({ value, air, draw, scale: 1 });
for (const scale of [0, 0.25, 0.5, 0.75]) GRID.push({ ...SHIPPED, scale });
const SCALES = GRID.filter((t) => t.scale !== 1 || label(t) === CURRENT);

interface Row {
  player: string;
  fold: number;
  street: "flop" | "turn";
  /** Checked on the street and did nothing else on it. */
  checker: boolean;
  /** Checked at least once on the street (a check-call or check-raise too). */
  checked: boolean;
  covered: boolean;
  /** Live players as the street began. */
  players: number;
  score: Record<string, number>;
}

const foldOf = (name: string) => createHash("sha256").update(name).digest()[0] % FOLDS;

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

it("scores a smaller multiway check trim on shown hands", { timeout: 12 * 60 * 60_000 }, async () => {
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

  const models: Record<string, NarrowingModel> = {};
  for (const t of GRID) models[label(t)] = trimmed(label(t), t);
  // The shipped heuristic must be the study's winner, to the bit.
  const fidelity = trimmed("fidelity", WINNER);
  let checked = 0;
  let mismatched = 0;

  const started = performance.now();
  const rows: Row[] = [];
  const control: Row[] = [];
  for (const hand of hands) {
    if (hand.actions.some((a) => a.type === "bomb-ante")) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    const actual = heroSeatOf(context);
    const comboOf = (seat: number): number | null => {
      try {
        const cards = toIndices(context.players.get(seat)?.holeCards ?? []);
        return cards.length === 2 ? comboIndex(cards[0], cards[1]) : null;
      } catch {
        return null;
      }
    };
    const acts = (seat: number, street: string) => hand.actions.filter((a) => a.street === street && a.seat === seat && ["check", "bet", "raise", "call", "fold"].includes(a.type));

    if (seats.length === 2) {
      // Control: heads-up, the heuristic walk, the trims applied to every check.
      if (actual === null || !seats.includes(actual)) continue;
      const villain = seats[0] === actual ? seats[1] : seats[0];
      const combo = comboOf(villain);
      if (combo === null) continue;
      const flop = acts(villain, "flop");
      if (flop.length === 0) continue;
      const score: Record<string, number> = {};
      for (const t of SCALES) {
        const model = trimmed(label(t), t, true);
        const walk = walkRanges(structuredClone(hand), buildContext(structuredClone(hand)), actual, villain, charts, model, { populationHero: actual });
        score[label(t)] = walk.ok ? ll(walk.turnStart?.villain, combo) : FLOOR_LL;
      }
      const name = `${hand.meta.siteId}/${context.players.get(villain)?.name ?? villain}`;
      const checks = flop.filter((a) => a.type === "check").length;
      control.push({ player: name, fold: foldOf(name), street: "flop", checker: checks === flop.length, checked: checks > 0, covered: false, players: 2, score });
      continue;
    }
    if (seats.length < 3) continue;
    const shown = seats.filter((seat) => seat !== actual && comboOf(seat) !== null);
    if (shown.length === 0) continue;
    const hero = actual !== null && seats.includes(actual) ? actual : seats[0];
    const options = { populationHero: actual ?? -1 };
    const plan = multiwayLibraryPlan(hand, context, charts, library);
    const covered = plan ? (await library.load(plan.set, plan.line.id, plan.flop)) !== null : false;

    const walks: Record<string, ReturnType<typeof walkMultiway>> = {};
    for (const [name, model] of Object.entries(models)) {
      try {
        walks[name] = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), hero, charts, model, options);
      } catch {
        walks[name] = { ok: false, reason: "range-empty" };
      }
    }
    const base = walks[CURRENT];
    if (!base.ok) continue;
    if (checked < 400) {
      const shipped = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), hero, charts, heuristicModel, options);
      const again = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), hero, charts, fidelity, options);
      if (shipped.ok && again.ok) {
        for (const [seat, range] of shipped.starts.river ?? shipped.starts.turn ?? new Map()) {
          checked += 1;
          const other = (again.starts.river ?? again.starts.turn)?.get(seat);
          if (!other || other.some((w, c) => w !== range[c])) mismatched += 1;
        }
      }
    }
    for (const seat of shown) {
      const combo = comboOf(seat) as number;
      const name = `${hand.meta.siteId}/${context.players.get(seat)?.name ?? seat}`;
      for (const street of ["flop", "turn"] as const) {
        const own = acts(seat, street);
        if (own.length === 0) continue;
        const begun = street === "flop" ? seats.length : (base.starts.turn?.size ?? 0);
        if (begun < 3) continue;
        const at = (w: (typeof walks)[string]) => (w.ok ? (street === "flop" ? w.starts.turn : w.starts.river) : null);
        if (!at(base)?.has(seat)) continue;
        const score: Record<string, number> = {};
        for (const [m, walk] of Object.entries(walks)) score[m] = ll(at(walk)?.get(seat), combo);
        const checks = own.filter((a) => a.type === "check").length;
        rows.push({ player: name, fold: foldOf(name), street, checker: checks === own.length, checked: checks > 0, covered, players: begun, score });
      }
    }
  }
  console.log(`=== ${FILE}: ${hands.length} hands; ${rows.length} multiway rows (flop ${rows.filter((r) => r.street === "flop").length}, turn ${rows.filter((r) => r.street === "turn").length}); heads-up control ${control.length} (${((performance.now() - started) / 1000).toFixed(0)} s)`);
  console.log(`fidelity: the study's winner vs the shipped heuristic, ${checked} river- or turn-start ranges, ${mismatched} differ`);

  // Held out: each fold scored with the candidate that did best on the other four (flop and turn rows together).
  const names = GRID.map(label);
  const heldOut = (fit: readonly Row[], pool: readonly string[]) => {
    const chosen: string[] = [];
    const out = new Map<Row, number>();
    for (let k = 0; k < FOLDS; k += 1) {
      const train = fit.filter((r) => r.fold !== k);
      let best = CURRENT;
      let bestMean = -Infinity;
      for (const name of pool) {
        const mean = train.reduce((s, r) => s + r.score[name], 0) / Math.max(1, train.length);
        if (mean > bestMean) {
          bestMean = mean;
          best = name;
        }
      }
      chosen.push(best);
      for (const r of fit) if (r.fold === k) out.set(r, r.score[best]);
    }
    return { chosen, out };
  };
  const grid = heldOut(rows, names);
  const scale = heldOut(rows, SCALES.map(label));
  const whole = [...names].sort((a, b) => rows.reduce((s, r) => s + r.score[b], 0) - rows.reduce((s, r) => s + r.score[a], 0));
  console.log(`held-out choices: grid ${grid.chosen.join(" / ")}; scale ${scale.chosen.join(" / ")}`);
  console.log(`in-sample best on all rows: ${whole.slice(0, 5).map((n) => `${n} ${f3(clustered(rows, (r) => r.score[n] - r.score[CURRENT]).mean)}`).join(", ")}`);
  const fixed = [whole[0], "scale 0", "scale 0.5", "V1 A1 D1"].filter((n, i, a) => a.indexOf(n) === i);

  const report = (title: string, subset: readonly Row[]) => {
    if (subset.length === 0) return;
    const b = clustered(subset, (r) => r.score[CURRENT]);
    const g = clustered(subset, (r) => (grid.out.get(r) as number) - r.score[CURRENT]);
    const s = clustered(subset, (r) => (scale.out.get(r) as number) - r.score[CURRENT]);
    const extra = fixed.map((n) => {
      const d = clustered(subset, (r) => r.score[n] - r.score[CURRENT]);
      return `${n} ${f3(d.mean)} ± ${d.se.toFixed(3)}`;
    });
    console.log(`| ${title} | ${subset.length} (${b.players}) | ${b.mean.toFixed(3)} | ${f3(g.mean)} ± ${g.se.toFixed(3)} | ${f3(s.mean)} ± ${s.se.toFixed(3)} | ${extra.join(" | ")} |`);
  };
  console.log(`| subset | n (players) | heuristic | grid, held out | scale, held out | ${fixed.join(" | ")} |`);
  const flop = rows.filter((r) => r.street === "flop");
  const turn = rows.filter((r) => r.street === "turn");
  report("all multiway rows", rows);
  report("flop, everyone shown", flop);
  report("flop, checked only", flop.filter((r) => r.checker));
  report("flop, checked only, a chunk read", flop.filter((r) => r.checker && r.covered));
  report("flop, checked then called or raised", flop.filter((r) => r.checked && !r.checker));
  report("flop, never checked", flop.filter((r) => !r.checked));
  report("flop, three players", flop.filter((r) => r.players === 3));
  report("flop, four or more", flop.filter((r) => r.players >= 4));
  report("turn, everyone shown", turn);
  report("turn, checked only", turn.filter((r) => r.checker));
  report("turn, checked then called or raised", turn.filter((r) => r.checked && !r.checker));
  report("turn, never checked", turn.filter((r) => !r.checked));

  // Heads-up control: the shipped candidate is multiway-only (Δ 0 by construction); the same scales applied heads-up.
  const hu = heldOut(control, SCALES.map(label));
  for (const [title, subset] of [
    ["heads-up, everyone shown", control],
    ["heads-up, checked only", control.filter((r) => r.checker)],
    ["heads-up, bet, raised or called", control.filter((r) => !r.checker)],
  ] as const) {
    if (subset.length === 0) continue;
    const b = clustered(subset, (r) => r.score[CURRENT]);
    const parts = SCALES.map(label)
      .filter((n) => n !== CURRENT)
      .map((n) => {
        const d = clustered(subset, (r) => r.score[n] - r.score[CURRENT]);
        return `${n} ${f3(d.mean)} ± ${d.se.toFixed(3)}`;
      });
    const h = clustered(subset, (r) => (hu.out.get(r) as number) - r.score[CURRENT]);
    console.log(`--- ${title}: ${subset.length} (${b.players} players); heuristic ${b.mean.toFixed(3)}; scale held out (${hu.chosen.join("/")}) ${f3(h.mean)} ± ${h.se.toFixed(3)}; ${parts.join("; ")}`);
  }
});
