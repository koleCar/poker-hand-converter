/**
 * Why the walked ranges are too strong at a checked river (§10, 2026-10-20).
 * The open item of 2026-10-19 (`multiwayBets.test.ts`): at a river checked
 * through, the first to act - shown whatever they hold - wins far more of the
 * pot than the walked ranges of the others say.
 *
 * Part 1, who is shown. At every river showdown of the stored hands: the
 * share of each showdown player whose cards the history shows, by their place
 * in the showing order and by whether they won. The first to act at a
 * checked river is always shown; a later player is shown (nearly) only when
 * their hand beats or ties the best one shown before them. Every study that
 * scored "the shown hands of the opponents" scored a sample selected on
 * winning.
 *
 * Part 2, unselected scores, per candidate narrowing (a study-local model:
 * the shipped `heuristic/2` with its check and call constants as parameters):
 *   - **share**: the first to act's showdown share against the others' walked
 *     ranges (after their river checks), against the share won (the bar of
 *     2026-10-19);
 *   - **first LL**: the first to act's shown combo in their own walked range
 *     (log per combo; outside the range at a twentieth of a uniform combo);
 *   - **censored LL**: every later opponent, shown or not: shown, the combo's
 *     log-likelihood; not shown, the log of the range's chance of losing to
 *     the best hand shown before them (what not showing says);
 *   - **PIT**: the first to act's place in their own range by river value
 *     (0.5 on average when the range is right).
 * Candidates are chosen held out, five folds by hand and five by player. The
 * baseline is `analysis/29`'s constants, restated (`SHIPPED`); `analysis/30`
 * ships `WINNER` (a fidelity check confirms the shipped heuristic is it, to
 * the bit).
 *
 * Part 3 (`CR_GUARD`, a JSON candidate or list): the earlier studies' shown-
 * hand rows (`analysis/22`, `/23`, `/28`, the 2026-10-14 river trim), paired,
 * candidate − baseline per combo - the bar's "no existing check worse".
 *
 *     cd tests && FLOPLIB_HANDS=/path/hands.jsonl [CR_GRID=1] [CR_CANDS='[...]'] [CR_GUARD='[...]'] npm run floplib:checked-ranges
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it, vi } from "vitest";

// Study only: lets a candidate widen an opponent's chart range (`Cand.pm`).
vi.mock("../../../frontend/src/lib/analysis/rangeWalk.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../frontend/src/lib/analysis/rangeWalk.js")>();
  return {
    ...original,
    preflopRangeOf: (...args: Parameters<typeof original.preflopRangeOf>) => {
      const found = original.preflopRangeOf(...args);
      const pm = (globalThis as { __crHook?: { pm: number } }).__crHook?.pm ?? 0;
      const [, , seat, , , options] = args;
      if (!found || !(pm > 0) || found.source !== "chart" || found.label.startsWith("unknown")) return found;
      if (options?.populationHero === undefined || seat === options.populationHero) return found;
      return { ...found, range: Float64Array.from(found.range, (w) => (1 - pm) * w + pm) };
    },
  };
});

import {
  BLUFF_ZONE,
  CHECK_REPEAT,
  effectiveStrength,
  flopSeats,
  handStrength,
  heroSeatOf,
  heuristicModel,
  mdfSplit,
  percentiles,
  removeCards,
  streetStrength,
  VALUE_SHARE,
  walkMultiway,
  weightedCombos,
  type NarrowingModel,
  type NarrowInput,
  type StreetStrength,
} from "../../../frontend/src/lib/analysis/index.js";
import { toIndices } from "../../../frontend/src/lib/analysis/texture.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../frontend/src/lib/charts/index.js";
import { equityVsRanges } from "../../../frontend/src/lib/equity/multiway.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { comboHi, comboIndex, comboLo, NUM_COMBOS } from "../../../frontend/src/lib/solver/index.js";
import { buildContext, type StatsContext } from "../../../frontend/src/lib/stats/context.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const GRID_ON = process.env.CR_GRID === "1";
const FOLDS = 5;
const FLOOR_LL = Math.log(1 / (20 * NUM_COMBOS));
const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);
const foldOfHand = (hand: number) => (hand * 2654435761) % FOLDS;
const foldOfName = (name: string) => createHash("sha256").update(name).digest()[0] % FOLDS;
const f3 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);

function clustered<T>(rows: readonly T[], key: (r: T) => string | number, x: (r: T) => number) {
  const n = rows.length;
  if (n === 0) return { mean: NaN, se: NaN, n: 0 };
  const mean = rows.reduce((s, r) => s + x(r), 0) / n;
  const by = new Map<string | number, number>();
  for (const r of rows) by.set(key(r), (by.get(key(r)) ?? 0) + (x(r) - mean));
  const g = by.size;
  let v = 0;
  for (const s of by.values()) v += s * s;
  return { mean, se: g > 1 ? Math.sqrt((g / (g - 1)) * v) / n : NaN, n };
}
const fmt = (c: { mean: number; se: number }) => `${f3(c.mean)} ± ${c.se.toFixed(3)}`;

/* -------------------------------------------------------------- candidates - */

/** The shipped constants, restated so a candidate can vary them. */
const RAMP = 0.12;
const FLOOR = 0.03;
const STRONG = 8;
const WEAK = 4;
const TOP_ZONE = 0.95;
const TOP_CALL = 0.6;
const DRAW_CALL = 1;

interface Cand {
  /** River check by the first to check on the street: value checks this often. */
  rv: number;
  /** River check by a player checked to: value checks this often. */
  rt: number;
  /** River check: air checks this often. */
  ra: number;
  /** Flop and turn checks heads-up: the shipped trim × this. */
  hs: number;
  /** Flop and turn checks three or more ways: the shipped trim × this. */
  ms: number;
  /** An opponent's preflop range from the charts, mixed with any two cards at this share. */
  pm: number;
  /** A call's cut moved by this (negative: wider calling ranges). */
  cs: number;
  /** River checks by the first to check: each earlier postflop check scales the trim by this (`CHECK_REPEAT` 0.5; 1 no discount). */
  rr: number;
  /** River check by a player checked to: air checks this often. */
  rta: number;
  /** River check by a player checked to: the repeat discount. */
  rtr: number;
  /** Flop or turn check by a player checked to: value checks this often (−1: the shipped constants). */
  ft: number;
}
/** `analysis/29`'s constants, restated: the baseline every candidate is compared with. */
const SHIPPED: Cand = { rv: 0.5, rt: 0.5, ra: 0.7, hs: 1, ms: 1, pm: 0, cs: 0, rr: 0.5, rta: 0.7, rtr: 0.5, ft: -1 };
/** What `analysis/30` ships (`CHECKED_TO_RIVER_VALUE` 0.3, no repeat discount when checked to on the river). */
const WINNER: Cand = { ...SHIPPED, rt: 0.3, rtr: 1 };
const label = (c: Cand) =>
  `rv${c.rv} rt${c.rt} ra${c.ra} rr${c.rr} rta${c.rta} rtr${c.rtr} ft${c.ft} hs${c.hs} ms${c.ms} pm${c.pm} cs${c.cs}`;

/** The preflop hook the mocked `preflopRangeOf` reads (study only). */
const hook: { pm: number } = { pm: 0 };
(globalThis as { __crHook?: typeof hook }).__crHook = hook;

function scoredQ(input: NarrowInput): Float64Array {
  const strength = input.strength ?? streetStrength(input.board);
  let hs = handStrength(strength, input.opponent);
  if (input.opponents && input.opponents.length >= 2) {
    hs = handStrength(strength, input.opponents[0]);
    for (let i = 1; i < input.opponents.length; i += 1) {
      const other = handStrength(strength, input.opponents[i]);
      for (let c = 0; c < NUM_COMBOS; c += 1) hs[c] *= other[c];
    }
  }
  return percentiles(effectiveStrength(strength, hs), input.actor);
}
const ramp = (q: number, from: number, to: number) => (q <= from ? 0 : q >= to ? 1 : (q - from) / (to - from));

function candidateModel(cand: Cand, checkedTo: ReadonlySet<number>): NarrowingModel {
  return {
    id: label(cand),
    likelihood(input: NarrowInput) {
      const kind = input.action.kind;
      if (kind === "bet" || kind === "raise") return heuristicModel.likelihood(input);
      if (kind === "call" && cand.cs === 0) return heuristicModel.likelihood(input);
      const q = scoredQ(input);
      const outs = (input.strength ?? streetStrength(input.board)).outs;
      const extra = Math.max(0, (input.players ?? 2) - 2);
      const out = new Float64Array(NUM_COMBOS);
      if (kind === "call") {
        const x = input.action.sizePot !== null && input.action.sizePot > 0 ? input.action.sizePot : 0.5;
        const cut = (extra > 0 ? 1 - mdfSplit(x, extra + 1) : x / (1 + x)) + cand.cs;
        for (let c = 0; c < NUM_COMBOS; c += 1) {
          if (!(input.actor[c] > 0) || Number.isNaN(q[c])) continue;
          let made = ramp(q[c], cut - RAMP / 2, cut + RAMP / 2);
          if (q[c] >= TOP_ZONE) made = TOP_CALL;
          const o = outs[c];
          const draw = o >= STRONG ? DRAW_CALL : o >= WEAK ? DRAW_CALL / 2 : 0;
          out[c] = Math.max(FLOOR, made, draw);
        }
        return out;
      }
      // check
      const river = input.street === "river";
      const to = input.actionIndex !== undefined && checkedTo.has(input.actionIndex);
      const base = river ? (to ? cand.rtr : cand.rr) : CHECK_REPEAT;
      const repeat = Math.pow(base, Math.max(0, input.action.checksBefore ?? 0));
      let v: number, a: number, d: number, scale: number;
      if (river) {
        v = to ? cand.rt : cand.rv;
        a = to ? cand.rta : cand.ra;
        d = 0.6;
        scale = 1;
      } else if (extra > 0) {
        v = 0.65;
        d = 1;
        a = 0.7;
        scale = cand.ms;
      } else {
        v = 0.75;
        d = 0.8;
        a = 0.85;
        scale = cand.hs;
      }
      if (!river && to && cand.ft >= 0) v = cand.ft;
      const cut = 1 - VALUE_SHARE[input.street];
      for (let c = 0; c < NUM_COMBOS; c += 1) {
        if (!(input.actor[c] > 0) || Number.isNaN(q[c])) continue;
        const o = outs[c];
        if (o >= STRONG) {
          out[c] = Math.min(1, Math.max(FLOOR, 1 - scale * (1 - d) * repeat));
          continue;
        }
        const value = ramp(q[c], cut - RAMP, cut);
        const air = q[c] < BLUFF_ZONE && o < WEAK ? 1 - ramp(q[c], BLUFF_ZONE - RAMP, BLUFF_ZONE) : 0;
        out[c] = Math.min(1, Math.max(FLOOR, 1 - scale * repeat * (value * (1 - v) + air * (1 - a))));
      }
      return out;
    },
  };
}

/** Records each action's narrowed range (after it), by `actionIndex`. */
function recording(model: NarrowingModel) {
  const after = new Map<number, Float64Array>();
  const wrapped: NarrowingModel = {
    id: model.id,
    likelihood(input: NarrowInput) {
      const l = model.likelihood(input);
      if (input.actionIndex !== undefined) {
        const o = new Float64Array(NUM_COMBOS);
        for (let c = 0; c < NUM_COMBOS; c += 1) if (input.actor[c] > 0) o[c] = input.actor[c] * Math.min(1, Math.max(0, l[c] || 0));
        after.set(input.actionIndex, o);
      }
      return l;
    },
  };
  return { after, model: wrapped };
}

/* -------------------------------------------------------------------- data - */

interface Spot {
  h: number;
  hand: PhfHand;
  context: StatsContext;
  walker: number;
  actual: number | null;
  multiway: boolean;
  /** Showdown seats in showing order (river action order). */
  order: number[];
  /** Each seat's last postflop decision index. */
  last: Map<number, number>;
  combo: Map<number, number>;
  cards: Map<number, string[]>;
  boardCodes: string[];
  board: number[];
  strength: StreetStrength;
  firstShare: number;
  firstName: string;
  names: Map<number, string>;
  lines: Map<number, string>;
  /** River checks made after another player's check on the river. */
  checkedTo: Set<number>;
}

interface Result {
  share: number;
  firstLL: number;
  pit: number;
  pitStart: number;
  pitPre: number;
  /** Later opponents: log-likelihood, predicted chance of not showing, not shown (1/0). */
  cens: { ll: number; p: number; y: number; seat: number }[];
  labels: Map<number, string>;
}

function pitOf(range: Float64Array, value: Int32Array, combo: number, dead: readonly number[]): number {
  const v0 = value[combo];
  let below = 0;
  let tied = 0;
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const w = range[c];
    if (!(w > 0) || value[c] < 0) continue;
    if (dead.includes(comboHi(c)) || dead.includes(comboLo(c))) continue;
    total += w;
    if (value[c] < v0) below += w;
    else if (value[c] === v0) tied += w;
  }
  return total > 0 ? (below + tied / 2) / total : NaN;
}

function llOf(range: Float64Array | undefined, combo: number): number {
  if (!range) return FLOOR_LL;
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) total += range[c] > 0 ? range[c] : 0;
  if (!(total > 0) || !(range[combo] > 0)) return FLOOR_LL;
  return Math.max(FLOOR_LL, Math.log(range[combo] / total));
}

function evaluate(spot: Spot, charts: ChartSet, cand: Cand): Result | null {
  const rec = recording(candidateModel(cand, spot.checkedTo));
  let walk: ReturnType<typeof walkMultiway>;
  hook.pm = cand.pm;
  try {
    walk = walkMultiway(structuredClone(spot.hand), buildContext(structuredClone(spot.hand)), spot.walker, charts, rec.model, { populationHero: spot.actual ?? -1 });
  } catch {
    hook.pm = 0;
    return null;
  }
  hook.pm = 0;
  if (!walk.ok) return null;
  const final = (seat: number) => rec.after.get(spot.last.get(seat) as number);
  const first = spot.order[0];
  const own = toIndices(spot.cards.get(first) as string[]);
  const others = spot.order.slice(1).map((s) => final(s));
  if (others.some((r) => !r)) return null;
  const lists = others.map((r) => weightedCombos(removeCards(Float64Array.from(r as Float64Array), own))).filter((l) => l.length > 0);
  if (lists.length === 0) return null;
  let share: number;
  if (lists.length === 1) {
    // Exact heads-up: the hand strength against the one range.
    const r = removeCards(Float64Array.from(others[0] as Float64Array), own);
    share = handStrength(spot.strength, r)[spot.combo.get(first) as number];
  } else {
    share = equityVsRanges({ hero: spot.cards.get(first) as string[], ranges: lists, board: spot.boardCodes, seed: 77 + spot.h, trials: 8000 }).equity;
  }
  if (!Number.isFinite(share)) return null;
  const fr = final(first) as Float64Array;
  const fc = spot.combo.get(first) as number;
  const value = spot.strength.value;
  const pre = removeCards(Float64Array.from(walk.preflop.get(first) as Float64Array), spot.board);
  const start = walk.starts.river?.get(first);
  const res: Result = {
    share,
    firstLL: llOf(fr, fc),
    pit: pitOf(fr, value, fc, []),
    pitStart: start ? pitOf(start, value, fc, []) : NaN,
    pitPre: pitOf(pre, value, fc, []),
    cens: [],
    labels: new Map(walk.labels),
  };
  // Later opponents, censored by what not showing says.
  let best = value[fc];
  const shownCards = [...own];
  for (const seat of spot.order.slice(1)) {
    const combo = spot.combo.get(seat);
    if (seat === spot.actual) {
      if (combo !== undefined) {
        best = Math.max(best, value[combo]);
        shownCards.push(...toIndices(spot.cards.get(seat) as string[]));
      }
      continue;
    }
    const r = removeCards(Float64Array.from(final(seat) as Float64Array), shownCards);
    let total = 0;
    let lose = 0;
    for (let c = 0; c < NUM_COMBOS; c += 1) {
      const w = r[c];
      if (!(w > 0) || value[c] < 0) continue;
      total += w;
      if (value[c] < best) lose += w;
    }
    if (!(total > 0)) continue;
    const p = lose / total;
    if (combo !== undefined) {
      res.cens.push({ ll: llOf(r, combo), p, y: 0, seat });
      best = Math.max(best, value[combo]);
      shownCards.push(...toIndices(spot.cards.get(seat) as string[]));
    } else {
      res.cens.push({ ll: Math.max(FLOOR_LL, Math.log(Math.max(1e-9, p))), p, y: 1, seat });
    }
  }
  return res;
}

/**
 * The earlier studies' shown-hand checks, paired: every opponent shown down
 * (the hero left out) after a flop they acted on, scored on their range as
 * the turn came (flop rows, `analysis/22`/`/23`), as the river came (turn
 * rows) and after their last river action (river rows, the 2026-10-14 river
 * trim study); bomb pots apart (`analysis/28`: its lift differs from the log-
 * likelihood by the starting range's term, the same for both models). The
 * heuristic walk throughout (no flop library). Δ candidate − shipped per
 * combo, clustered by player. These hands are selected on winning (part 1).
 */
function guard(hands: readonly PhfHand[], charts: ChartSet, cand: Cand) {
  interface Row {
    player: string;
    kind: string;
    d: number;
  }
  const rows: Row[] = [];
  for (const hand of hands) {
    if (hand.board.runouts.length > 1 || hand.game.bombPot?.doubleBoard) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length < 2) continue;
    const actual = heroSeatOf(context);
    const shown = seats.filter((s) => s !== actual && (context.players.get(s)?.holeCards?.length ?? 0) === 2);
    if (shown.length === 0) continue;
    const walker = actual !== null && seats.includes(actual) ? actual : seats[0];
    const checkedTo = checkedToOf(hand);
    const run = (c: Cand) => {
      const rec = recording(candidateModel(c, checkedTo));
      hook.pm = c.pm;
      try {
        const w = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), walker, charts, rec.model, { populationHero: actual ?? -1 });
        return w.ok ? { w, after: rec.after } : null;
      } catch {
        return null;
      } finally {
        hook.pm = 0;
      }
    };
    const a = run(SHIPPED);
    const b = run(cand);
    if (!a || !b) continue;
    const bomb = hand.game.bombPot ? "bomb " : "";
    const way = seats.length >= 3 ? "3+" : "HU";
    for (const seat of shown) {
      const cs = toIndices(context.players.get(seat)?.holeCards as string[]);
      const combo = comboIndex(cs[0], cs[1]);
      const player = `${hand.meta.siteId}/${context.players.get(seat)?.name ?? seat}`;
      const acts = (street: string) => hand.actions.filter((x) => x.street === street && x.seat === seat && DECISIONS.has(x.type));
      if (acts("flop").length > 0 && a.w.starts.turn?.has(seat))
        rows.push({ player, kind: `${bomb}flop ${way}`, d: llOf(b.w.starts.turn?.get(seat), combo) - llOf(a.w.starts.turn?.get(seat), combo) });
      if (acts("turn").length > 0 && a.w.starts.river?.has(seat)) {
        const tw = (a.w.starts.turn?.size ?? 0) >= 3 ? "3+" : "HU";
        rows.push({ player, kind: `${bomb}turn ${tw}`, d: llOf(b.w.starts.river?.get(seat), combo) - llOf(a.w.starts.river?.get(seat), combo) });
      }
      const river = acts("river");
      if (river.length > 0 && river[river.length - 1].type !== "fold") {
        const idx = river[river.length - 1].index;
        const rw = (a.w.starts.river?.size ?? 0) >= 3 ? "3+" : "HU";
        const checker = river.every((x) => x.type === "check") ? " checked only" : "";
        rows.push({ player, kind: `${bomb}river ${rw}${checker}`, d: llOf(b.after.get(idx), combo) - llOf(a.after.get(idx), combo) });
        rows.push({ player, kind: `${bomb}river all`, d: llOf(b.after.get(idx), combo) - llOf(a.after.get(idx), combo) });
      }
    }
  }
  console.log(`--- guard: the shown-hand checks, ${label(cand)} − shipped, per combo (clustered by player)`);
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  for (const k of kinds) {
    const sub = rows.filter((r) => r.kind === k);
    const c = clustered(sub, (r) => r.player, (r) => r.d);
    console.log(`  ${k}: n ${sub.length} | Δ ${fmt(c)}`);
  }
}

/** Postflop checks made after another player's check on the same street (checked to). */
function checkedToOf(hand: PhfHand): Set<number> {
  const out = new Set<number>();
  for (const street of ["flop", "turn", "river"]) {
    const acts = hand.actions.filter((a) => a.street === street && a.seat !== null && DECISIONS.has(a.type));
    for (const [i, a] of acts.entries()) if (i > 0 && a.type === "check") out.add(a.index);
  }
  return out;
}

function lineOf(hand: PhfHand, seat: number): string {
  const parts: string[] = [];
  for (const street of ["flop", "turn", "river"]) {
    const a = hand.actions.filter((x) => x.street === street && x.seat === seat && DECISIONS.has(x.type));
    parts.push(a.map((x) => ({ check: "x", bet: "b", call: "c", raise: "r", fold: "f" })[x.type as "check"]).join("") || "-");
  }
  return parts.join("/");
}

it("why the walked ranges are too strong at a checked river", { timeout: 12 * 60 * 60_000 }, () => {
  if (!FILE || !existsSync(FILE)) {
    console.log("FLOPLIB_HANDS (JSONL of PHF hands) must be set; nothing to do");
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

  /* ---------------------------------------------- part 1: who is shown - */
  const shownCount = new Map<string, [number, number]>();
  const bumpShown = (k: string, shown: boolean) => {
    const v = shownCount.get(k) ?? [0, 0];
    v[shown ? 0 : 1] += 1;
    shownCount.set(k, v);
  };
  const spots: Spot[] = [];
  for (const [h, hand] of hands.entries()) {
    if (hand.actions.some((a) => a.allIn) || hand.board.runouts.length > 1 || hand.game.bombPot?.doubleBoard) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length < 2) continue;
    const river = hand.actions.filter((a) => a.street === "river" && a.seat !== null && DECISIONS.has(a.type));
    if (river.length === 0) continue;
    const folded = new Set(river.filter((a) => a.type === "fold").map((a) => a.seat as number));
    const order: number[] = [];
    for (const a of river) if (!folded.has(a.seat as number) && !order.includes(a.seat as number)) order.push(a.seat as number);
    if (order.length < 2) continue;
    const checked = river.every((a) => a.type === "check");
    const actual = heroSeatOf(context);
    const won = new Map(hand.results.players.map((p) => [p.seat, p.won]));
    const known = (seat: number) => (context.players.get(seat)?.holeCards?.length ?? 0) === 2;
    for (const [i, seat] of order.entries()) {
      if (seat === actual) continue;
      const k = `${checked ? "checked" : "bet"} ${order.length === 2 ? "HU" : "3+"} ${i === 0 ? "first" : "later"} ${(won.get(seat) ?? 0) > 0 ? "won" : "lost"}`;
      bumpShown(k, known(seat));
    }
    if (!checked || hand.results.pots.length > 1) continue;
    const atRiver = new Set(river.map((a) => a.seat as number));
    if (atRiver.size < (seats.length === 2 ? 2 : 3)) continue;
    const totalWon = order.reduce((s, seat) => s + (won.get(seat) ?? 0), 0);
    if (!(totalWon > 0) || !known(order[0])) continue;
    const combo = new Map<number, number>();
    const cards = new Map<number, string[]>();
    for (const seat of order) {
      if (!known(seat)) continue;
      const cs = context.players.get(seat)?.holeCards as string[];
      const idx = toIndices(cs);
      combo.set(seat, comboIndex(idx[0], idx[1]));
      cards.set(seat, [...cs]);
    }
    const last = new Map<number, number>();
    for (const a of hand.actions) if (a.seat !== null && a.street !== "preflop" && DECISIONS.has(a.type)) last.set(a.seat, a.index);
    const boardCodes = [...(hand.board.runouts[0].flop ?? []), hand.board.runouts[0].turn, hand.board.runouts[0].river].filter((c): c is string => !!c);
    if (boardCodes.length !== 5) continue;
    const board = toIndices(boardCodes);
    const names = new Map<number, string>();
    const lines = new Map<number, string>();
    for (const seat of order) {
      names.set(seat, `${hand.meta.siteId}/${context.players.get(seat)?.name ?? seat}`);
      lines.set(seat, lineOf(hand, seat));
    }
    spots.push({
      checkedTo: checkedToOf(hand),
      h,
      hand,
      context,
      walker: actual !== null && seats.includes(actual) ? actual : seats[0],
      actual,
      multiway: seats.length >= 3,
      order,
      last,
      combo,
      cards,
      boardCodes,
      board,
      strength: streetStrength(board),
      firstShare: (won.get(order[0]) ?? 0) / totalWon,
      firstName: names.get(order[0]) as string,
      names,
      lines,
    });
  }
  console.log(`=== ${hands.length} hands; ${spots.length} checked-through river showdowns (${spots.filter((s) => s.multiway).length} from multiway flops)`);
  console.log("--- part 1: opponents shown at river showdowns (shown / not shown)");
  for (const [k, [a, b]] of [...shownCount].sort()) console.log(`  ${k}: ${a} / ${b} (${((100 * a) / (a + b)).toFixed(0)}% shown)`);

  /* -------------------------------------------- part 2: the baseline - */
  const t0 = performance.now();
  const base = new Map<Spot, Result>();
  for (const s of spots) {
    const r = evaluate(s, charts, SHIPPED);
    if (r) base.set(s, r);
  }
  const used = spots.filter((s) => base.has(s));
  console.log(`baseline: ${used.length} spots scored (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  const groups: [string, (s: Spot) => boolean][] = [
    ["three or more ways", (s) => s.multiway],
    ["heads-up", (s) => !s.multiway],
  ];
  for (const [title, pick] of groups) {
    const sub = used.filter(pick);
    const r = (s: Spot) => base.get(s) as Result;
    const won = clustered(sub, (s) => s.h, (s) => s.firstShare);
    const d = clustered(sub, (s) => s.h, (s) => s.firstShare - r(s).share);
    const pit = clustered(sub, (s) => s.h, (s) => r(s).pit);
    const pitS = clustered(sub.filter((s) => Number.isFinite(r(s).pitStart)), (s) => s.h, (s) => r(s).pitStart);
    const pitP = clustered(sub, (s) => s.h, (s) => r(s).pitPre);
    console.log(`${title}: n ${sub.length} | first's share won ${won.mean.toFixed(3)}, predicted ${(won.mean - d.mean).toFixed(3)}, won − predicted ${fmt(d)} | first's PIT in own range: final ${fmt(pit)}, river start ${fmt(pitS)}, preflop ${fmt(pitP)}`);
    const cens = sub.flatMap((s) => r(s).cens.map((c) => ({ ...c, h: s.h, s })));
    const y = clustered(cens, (c) => c.h, (c) => c.y);
    const p = clustered(cens, (c) => c.h, (c) => c.p);
    const dd = clustered(cens, (c) => c.h, (c) => c.y - c.p);
    console.log(`  later opponents: n ${cens.length} | not shown ${y.mean.toFixed(3)} ± ${y.se.toFixed(3)}, predicted ${p.mean.toFixed(3)} (observed − predicted ${fmt(dd)})`);
    // By the first's and the later players' lines and preflop sources.
    const by = new Map<string, Spot[]>();
    for (const s of sub) {
      const lab = r(s).labels.get(s.order[0]) ?? "?";
      const k1 = `first: ${s.order[0] === s.actual ? "hero" : "opp"} ${lab.split(":")[0]}`;
      const k2 = `first line ${s.lines.get(s.order[0])}`;
      for (const k of [k1, k2]) by.set(k, [...(by.get(k) ?? []), s]);
    }
    for (const [k, list] of [...by].sort((a, b) => b[1].length - a[1].length).slice(0, 18)) {
      if (list.length < 10) continue;
      const pk = clustered(list, (s) => s.h, (s) => r(s).pit);
      const dk = clustered(list, (s) => s.h, (s) => s.firstShare - r(s).share);
      console.log(`    ${k}: n ${list.length} | PIT ${fmt(pk)} | share won − predicted ${fmt(dk)}`);
    }
    const byc = new Map<string, typeof cens>();
    for (const c of cens) {
      const lab = r(c.s).labels.get(c.seat) ?? "?";
      for (const k of [`later: ${lab.split(":")[0]}`, `later line ${c.s.lines.get(c.seat)}`]) byc.set(k, [...(byc.get(k) ?? []), c]);
    }
    for (const [k, list] of [...byc].sort((a, b) => b[1].length - a[1].length).slice(0, 18)) {
      if (list.length < 10) continue;
      const yk = clustered(list, (c) => c.h, (c) => c.y);
      const dk = clustered(list, (c) => c.h, (c) => c.y - c.p);
      console.log(`    ${k}: n ${list.length} | not shown ${yk.mean.toFixed(3)}, observed − predicted ${fmt(dk)}`);
    }
  }
  if (process.env.CR_GUARD) {
    const list = JSON.parse(process.env.CR_GUARD) as Partial<Cand> | Partial<Cand>[];
    for (const c of Array.isArray(list) ? list : [list]) guard(hands, charts, { ...SHIPPED, ...c });
  }
  if (!GRID_ON) return;

  /* ---------------------------------------- part 3: candidates, held out - */
  const grid: Cand[] = [SHIPPED];
  if (process.env.CR_CANDS) {
    // A list of partial candidates (JSON), each over the shipped constants.
    for (const c of JSON.parse(process.env.CR_CANDS) as Partial<Cand>[]) grid.push({ ...SHIPPED, ...c });
  } else {
    // The river check of a player checked to (value, air, repeat), the same on the flop and turn, the first river check's value.
    for (const rt of [0.5, 0.3, 0.15, 0.03])
      for (const rtr of [0.5, 1])
        for (const rta of [0.7, 1])
          for (const ft of [-1, 0.5, 0.3])
            for (const rv of [0.5, 0.25]) {
              const c = { ...SHIPPED, rt, rtr, rta, ft, rv };
              if (label(c) !== label(SHIPPED)) grid.push(c);
            }
  }
  // Fidelity: the study's re-implementation of the winner is the shipped model, to the bit.
  {
    let differ = 0;
    for (const s of used.slice(0, 120)) {
      const rec = recording(candidateModel(WINNER, s.checkedTo));
      const w = walkMultiway(structuredClone(s.hand), buildContext(structuredClone(s.hand)), s.walker, charts, rec.model, { populationHero: s.actual ?? -1 });
      const ref = recording(heuristicModel);
      const w2 = walkMultiway(structuredClone(s.hand), buildContext(structuredClone(s.hand)), s.walker, charts, ref.model, { populationHero: s.actual ?? -1 });
      for (const seat of s.order) {
        const b = w.ok ? rec.after.get(s.last.get(seat) as number) : null;
        const c = w2.ok ? ref.after.get(s.last.get(seat) as number) : null;
        if (!b || !c || b.some((x, i) => Math.abs(x - c[i]) > 1e-12)) differ += 1;
      }
    }
    console.log(`fidelity: the study's ${label(WINNER)} vs the shipped heuristic/2, 120 spots, ${differ} final ranges differ`);
  }
  console.log(`grid: ${grid.length} candidates`);
  const scores = new Map<string, Map<Spot, Result>>();
  scores.set(label(SHIPPED), base);
  const t1 = performance.now();
  for (const [i, cand] of grid.entries()) {
    if (i === 0) continue;
    const m = new Map<Spot, Result>();
    for (const s of used) {
      const r = evaluate(s, charts, cand);
      if (r) m.set(s, r);
    }
    scores.set(label(cand), m);
    if (i % 10 === 0) process.stderr.write(`  ${i}/${grid.length} (${((performance.now() - t1) / 1000).toFixed(0)} s)\n`);
  }
  const names = grid.map(label);
  const ok = used.filter((s) => names.every((n) => scores.get(n)?.has(s)));
  console.log(`scored by every candidate: ${ok.length}`);
  const R = (n: string, s: Spot) => scores.get(n)?.get(s) as Result;
  // Per spot objectives (higher is better).
  const objectives: Record<string, (n: string, s: Spot) => number> = {
    share: (n, s) => -((s.firstShare - R(n, s).share) ** 2),
    ll: (n, s) => R(n, s).firstLL + R(n, s).cens.reduce((a, c) => a + c.ll, 0),
  };
  for (const [oname, obj] of Object.entries(objectives)) {
    for (const [fname, foldFn] of [
      ["hand", (s: Spot) => foldOfHand(s.h)],
      ["player", (s: Spot) => foldOfName(s.firstName)],
    ] as const) {
      const chosen: string[] = [];
      const held = new Map<Spot, string>();
      for (let k = 0; k < FOLDS; k += 1) {
        const train = ok.filter((s) => foldFn(s) !== k);
        let best = names[0];
        let bestV = -Infinity;
        for (const n of names) {
          const v = train.reduce((a, s) => a + obj(n, s), 0);
          if (v > bestV) {
            bestV = v;
            best = n;
          }
        }
        chosen.push(best);
        for (const s of ok) if (foldFn(s) === k) held.set(s, best);
      }
      const B = label(SHIPPED);
      const key = fname === "hand" ? (s: Spot) => s.h : (s: Spot) => s.firstName;
      const out: string[] = [];
      for (const [title, pick] of groups) {
        const sub = ok.filter(pick);
        const dB = clustered(sub, key, (s) => s.firstShare - R(B, s).share);
        const dC = clustered(sub, key, (s) => s.firstShare - R(held.get(s) as string, s).share);
        const sq = clustered(sub, key, (s) => (s.firstShare - R(B, s).share) ** 2 - (s.firstShare - R(held.get(s) as string, s).share) ** 2);
        const llg = clustered(sub, key, (s) => objectives.ll(held.get(s) as string, s) - objectives.ll(B, s));
        out.push(`${title}: won − predicted ${fmt(dB)} → ${fmt(dC)}; squared-error gain ${fmt(sq)}; unselected LL gain ${fmt(llg)}`);
      }
      console.log(`held out [${oname}, folds by ${fname}] chose ${chosen.join(" / ")}\n    ${out.join("\n    ")}`);
    }
  }
  // In-sample table of the top candidates by each objective.
  for (const [oname, obj] of Object.entries(objectives)) {
    const ranked = [...names].sort((a, b) => ok.reduce((x, s) => x + obj(b, s), 0) - ok.reduce((x, s) => x + obj(a, s), 0));
    console.log(`in-sample top by ${oname}:`);
    for (const n of ranked.slice(0, 8)) {
      const parts = groups.map(([title, pick]) => {
        const sub = ok.filter(pick);
        const d = clustered(sub, (s) => s.h, (s) => s.firstShare - R(n, s).share);
        const l = clustered(sub, (s) => s.h, (s) => objectives.ll(n, s) - objectives.ll(label(SHIPPED), s));
        return `${title} Δshare ${fmt(d)} LL ${fmt(l)}`;
      });
      console.log(`  ${n}: ${parts.join(" | ")}`);
    }
  }
});
