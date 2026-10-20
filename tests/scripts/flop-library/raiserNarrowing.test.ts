/**
 * How the narrowing reads the preflop aggressor's postflop line, scored
 * unselected (§10, 2026-10-20, raisers' postflop narrowing). The first open
 * item of the raising-order entry (#219): isolators and 3-bettors walked to a
 * river showdown still muck more than their ranges say (+0.22 ± 0.05, +0.18 ±
 * 0.08 at `analysis/31`), yet a flatter preflop order puts those who show
 * first too high in their range. Is it the heuristic's flop, turn and river
 * trims of the aggressor's line (a c-bet and barrels read as strength, a
 * check as weakness)?
 *
 * Spots and score as `preflopWidth.test.ts`: every river showdown in one pot
 * with nobody all-in; the first to show by their combo in their own walked
 * range, each later player by their combo when shown, else by the range's
 * chance of losing to the best hand shown before them. Preflop ranges are
 * the shipped `analysis/31` ones; the multiway walk from the hero's seat, no
 * flop library (`RN_LIB` - a JSON list of hand indices whose hero flop the
 * library answers, from a census - splits the diagnostics).
 *
 * Initiative: the last player to bet or raise on the latest street that had
 * a bet (preflop's last raiser on the flop; kept through a street checked
 * through). An *initiative bet* is the street's first bet made by that
 * player; an *initiative check* a check by them before any bet on the
 * street. A candidate (`Cand`) changes the heuristic's likelihood L for those
 * actions only: `pow` L → L^t (t < 1: the action says less), `mid` L →
 * max(L, m) (the middle and the bottom bet at least m), per street and per
 * preflop line group (`R1` opens, `R2` isolations and 3-bets, `R4` 4-bets,
 * `any` whoever holds the initiative).
 *
 * What it found (`analysis/32`): the excess mucks are not in the raisers'
 * bets - they sit as much on lines with no bet as on c-bet lines - but every
 * bet (not only the initiative holder's) is read as too strong, and the
 * initiative holder's checks as too weak a signal. Shipped: `BET_EVIDENCE`
 * (a bet's L to the power 0.4, not in a bomb pot) and
 * `INITIATIVE_CHECK_POWER` (an initiative check's L squared); the study's
 * `analysis/31` is the shipped heuristic with those flags off (`a31Model`).
 *
 *     cd tests && FLOPLIB_HANDS=/path/hands.jsonl [RN_CANDS='[...]' or a JSON file path] [RN_LIB=file] \
 *       [RN_GUARD=1|<name>] [RN_REF=<name>] [RN_PICK=<regex>] [RN_DIAG_BEST=<name>] npm run floplib:raiser-narrowing
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import {
  flopSeats,
  handStrength,
  heroSeatOf,
  heuristicModel,
  preflopRangeOf,
  removeCards,
  streetStrength,
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
import { comboIndex, NUM_COMBOS } from "../../../frontend/src/lib/solver/index.js";
import { buildContext, detectBombPot } from "../../../frontend/src/lib/stats/context.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
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

/* ------------------------------------------------------------ initiative - */

type Street = "flop" | "turn" | "river";
interface ActInfo {
  seat: number;
  street: Street;
  /** "B" initiative bet, "b" other bet, "R" raise, "C" call, "X" initiative check, "x" other check. */
  code: string;
  /** A bomb pot (analysis/28: any two cards, no preflop betting). */
  bomb: boolean;
}

/** Each postflop decision's initiative code, by `PhfAction.index`. */
function initiativeCodes(hand: PhfHand): Map<number, ActInfo> {
  const out = new Map<number, ActInfo>();
  const bomb = detectBombPot(hand);
  let holder: number | null = null;
  let street = "";
  let betOnStreet = false;
  let lastAggr: number | null = null;
  for (const a of hand.actions) {
    if (a.street !== street) {
      if (lastAggr !== null) holder = lastAggr;
      street = a.street;
      betOnStreet = false;
      lastAggr = null;
    }
    if (a.seat === null || !DECISIONS.has(a.type)) continue;
    if (a.type === "bet" || a.type === "raise") lastAggr = a.seat;
    if (street !== "flop" && street !== "turn" && street !== "river") continue;
    let code = "";
    if (a.type === "bet") code = !betOnStreet && a.seat === holder ? "B" : "b";
    else if (a.type === "raise") code = "R";
    else if (a.type === "call") code = "C";
    else if (a.type === "check") code = !betOnStreet && a.seat === holder ? "X" : "x";
    if (a.type === "bet" || a.type === "raise") betOnStreet = true;
    if (code) out.set(a.index, { seat: a.seat, street: street as Street, code, bomb });
  }
  return out;
}

/** A seat's postflop line, one letter per street (its first initiative-relevant action; "-" none). */
function lineOf(codes: Map<number, ActInfo>, seat: number): string {
  const per: Record<Street, string> = { flop: "-", turn: "-", river: "-" };
  for (const info of codes.values()) {
    if (info.seat !== seat) continue;
    const cur = per[info.street];
    // The aggressive letter wins over a check or call on the same street.
    if (cur === "-" || ("BbR".includes(info.code) && !"BbR".includes(cur))) per[info.street] = info.code;
  }
  return `${per.flop}${per.turn}${per.river}`;
}

/* ------------------------------------------------------------- candidates - */

const R_GROUP: Record<string, string> = { open: "R1", iso: "R2", "3bet": "R2", "4bet": "R4" };

interface Cand {
  name: string;
  /** Per street, the change of an initiative bet's likelihood. */
  bet?: Partial<Record<Street, { kind: "pow" | "mid"; p: number }>>;
  /** Per street, the change of an initiative check's likelihood (`pow` only). */
  check?: Partial<Record<Street, number>>;
  /** Line groups it applies to (`R1`, `R2`, `R4`, or `any`); default `any`. */
  groups?: string[];
  /** Also non-initiative bets (a control). */
  allBets?: boolean;
  /** Also raises (with `allBets`: every aggressive action). */
  raises?: boolean;
  /** An initiative check is not discounted by `CHECK_REPEAT` (each one trims as the first). */
  checkNoRepeat?: boolean;
  /** Bets in a bomb pot keep the heuristic's likelihood. */
  noBomb?: boolean;
  /** The shipped heuristic as it is (`analysis/32`), for the fidelity line. */
  shipped?: boolean;
}
const BASE: Cand = { name: "analysis/31" };

/**
 * `analysis/31`'s heuristic from the shipped one: `analysis/32`'s flags off
 * (a bet read as in a bomb pot keeps its full likelihood; no initiative check).
 */
const a31Model: NarrowingModel = {
  id: heuristicModel.id,
  likelihood: (input) => heuristicModel.likelihood({ ...input, action: { ...input.action, initiative: false, bombPot: true } }),
};

function candModel(cand: Cand, codes: Map<number, ActInfo>, groupOfSeat: (seat: number) => string): NarrowingModel {
  if (cand.shipped) return heuristicModel;
  if (!cand.bet && !cand.check && !cand.checkNoRepeat) return a31Model;
  return {
    id: heuristicModel.id,
    likelihood(input: NarrowInput) {
      const info = input.actionIndex !== undefined ? codes.get(input.actionIndex) : undefined;
      const groups = cand.groups ?? ["any"];
      const applies = !!info && (groups.includes("any") || groups.includes(groupOfSeat(info.seat)));
      const l =
        applies && cand.checkNoRepeat && info?.code === "X"
          ? a31Model.likelihood({ ...input, action: { ...input.action, checksBefore: 0 } })
          : a31Model.likelihood(input);
      if (!info || !applies) return l;
      const betRule = cand.bet?.[info.street];
      if (betRule && !(cand.noBomb && info.bomb) && (info.code === "B" || (cand.allBets && info.code === "b") || (cand.raises && info.code === "R"))) {
        for (let c = 0; c < NUM_COMBOS; c += 1) {
          if (!(input.actor[c] > 0)) continue;
          l[c] = betRule.kind === "pow" ? Math.pow(Math.max(0, l[c]), betRule.p) : Math.max(l[c], betRule.p);
        }
      }
      const t = cand.check?.[info.street];
      if (t !== undefined && info.code === "X") {
        for (let c = 0; c < NUM_COMBOS; c += 1) if (input.actor[c] > 0) l[c] = Math.min(1, Math.pow(Math.max(0, l[c]), t));
      }
      return l;
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
  walker: number;
  actual: number | null;
  multiway: boolean;
  checked: boolean;
  order: number[];
  last: Map<number, number>;
  combo: Map<number, number>;
  cards: Map<number, string[]>;
  boardCodes: string[];
  strength: StreetStrength;
  firstShare: number;
  firstName: string;
  codes: Map<number, ActInfo>;
  lib: boolean;
}

interface Cens {
  ll: number;
  p: number;
  y: number;
  seat: number;
  label: string;
  line: string;
}
interface Result {
  share: number;
  firstLL: number;
  pitPre: number;
  firstLabel: string;
  firstLine: string;
  cens: Cens[];
}

function pitOf(range: Float64Array, value: Int32Array, combo: number): number {
  const v0 = value[combo];
  let below = 0;
  let tied = 0;
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const w = range[c];
    if (!(w > 0) || value[c] < 0) continue;
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

const groupOfLabel = (label: string) => R_GROUP[label.split(":")[0]] ?? "other";

function walk(hand: PhfHand, walker: number, actual: number | null, charts: ChartSet, cand: Cand, codes: Map<number, ActInfo>) {
  // Labels come from a first walk's preflop ranges; the groups need them before narrowing.
  const labels = new Map<number, string>();
  const groupOfSeat = (seat: number) => groupOfLabel(labels.get(seat) ?? "?");
  const rec = recording(candModel(cand, codes, groupOfSeat));
  try {
    if (cand.groups && !cand.groups.includes("any")) {
      const context = buildContext(structuredClone(hand));
      for (const seat of flopSeats(context)) {
        const first = hand.actions.find((a) => a.street !== "preflop" && a.street !== "showdown");
        const r = preflopRangeOf(hand, context, seat, first?.index ?? Number.MAX_SAFE_INTEGER, charts, { populationHero: actual ?? -1 });
        if (r) labels.set(seat, r.label);
      }
    }
    const w = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), walker, charts, rec.model, { populationHero: actual ?? -1 });
    return w.ok ? { w, after: rec.after } : null;
  } catch {
    return null;
  }
}

function evaluate(spot: Spot, charts: ChartSet, cand: Cand, withShare: boolean): Result | null {
  const run = walk(spot.hand, spot.walker, spot.actual, charts, cand, spot.codes);
  if (!run) return null;
  const final = (seat: number) => run.after.get(spot.last.get(seat) as number);
  const first = spot.order[0];
  const own = toIndices(spot.cards.get(first) as string[]);
  const others = spot.order.slice(1).map((s) => final(s));
  if (others.some((r) => !r)) return null;
  let share = NaN;
  if (withShare) {
    const lists = others.map((r) => weightedCombos(removeCards(Float64Array.from(r as Float64Array), own))).filter((l) => l.length > 0);
    if (lists.length === 0) return null;
    if (lists.length === 1) {
      const r = removeCards(Float64Array.from(others[0] as Float64Array), own);
      share = handStrength(spot.strength, r)[spot.combo.get(first) as number];
    } else {
      share = equityVsRanges({ hero: spot.cards.get(first) as string[], ranges: lists, board: spot.boardCodes, seed: 77 + spot.h, trials: 8000 }).equity;
    }
  }
  const fr = final(first) as Float64Array;
  const fc = spot.combo.get(first) as number;
  const value = spot.strength.value;
  const board = toIndices(spot.boardCodes);
  const pre = removeCards(Float64Array.from(run.w.preflop.get(first) as Float64Array), board);
  const res: Result = {
    share,
    firstLL: llOf(fr, fc),
    pitPre: pitOf(pre, value, fc),
    firstLabel: run.w.labels.get(first) ?? "?",
    firstLine: lineOf(spot.codes, first),
    cens: [],
  };
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
    const label = run.w.labels.get(seat) ?? "?";
    const line = lineOf(spot.codes, seat);
    if (combo !== undefined) {
      res.cens.push({ ll: llOf(r, combo), p, y: 0, seat, label, line });
      best = Math.max(best, value[combo]);
      shownCards.push(...toIndices(spot.cards.get(seat) as string[]));
    } else {
      res.cens.push({ ll: Math.max(FLOOR_LL, Math.log(Math.max(1e-9, p))), p, y: 1, seat, label, line });
    }
  }
  return res;
}

const llScore = (s: Spot, r: Result) => (s.order[0] === s.actual ? 0 : r.firstLL) + r.cens.reduce((a, c) => a + c.ll, 0);

/* ------------------------------------------------------------------ guard - */

/** The earlier studies' shown-hand rows (`analysis/22`, `/23`, `/28`, the river trim), candidate − reference per combo, clustered by player. */
function guard(hands: readonly PhfHand[], charts: ChartSet, cand: Cand, ref: Cand) {
  const rows: { player: string; kind: string; d: number }[] = [];
  for (const hand of hands) {
    if (hand.board.runouts.length > 1 || hand.game.bombPot?.doubleBoard) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length < 2) continue;
    const actual = heroSeatOf(context);
    const shown = seats.filter((s) => s !== actual && (context.players.get(s)?.holeCards?.length ?? 0) === 2);
    if (shown.length === 0) continue;
    const walker = actual !== null && seats.includes(actual) ? actual : seats[0];
    const codes = initiativeCodes(hand);
    const a = walk(hand, walker, actual, charts, ref, codes);
    const b = walk(hand, walker, actual, charts, cand, codes);
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
  console.log(`--- guard: the shown-hand checks, ${cand.name} − ${ref.name}, per combo (clustered by player)`);
  for (const k of [...new Set(rows.map((r) => r.kind))].sort()) {
    const sub = rows.filter((r) => r.kind === k);
    console.log(`  ${k}: n ${sub.length} | Δ ${fmt(clustered(sub, (r) => r.player, (r) => r.d))}`);
  }
}

/* --------------------------------------------------------------------- run - */

it("the preflop aggressor's postflop narrowing, scored unselected", { timeout: 12 * 60 * 60_000 }, () => {
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
  const libHands = new Set<number>(process.env.RN_LIB && existsSync(process.env.RN_LIB) ? (JSON.parse(readFileSync(process.env.RN_LIB, "utf8")) as number[]) : []);

  const spots: Spot[] = [];
  for (const [h, hand] of hands.entries()) {
    if (hand.actions.some((a) => a.allIn) || hand.board.runouts.length > 1 || hand.game.bombPot?.doubleBoard) continue;
    if (hand.results.pots.length > 1) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length < 2) continue;
    const river = hand.actions.filter((a) => a.street === "river" && a.seat !== null && DECISIONS.has(a.type));
    if (river.length === 0) continue;
    const folded = new Set(river.filter((a) => a.type === "fold").map((a) => a.seat as number));
    let order: number[] = [];
    for (const a of river) if (!folded.has(a.seat as number) && !order.includes(a.seat as number)) order.push(a.seat as number);
    if (order.length < 2) continue;
    const checked = river.every((a) => a.type === "check");
    if (!checked) {
      const aggr = [...river].reverse().find((a) => a.type === "bet" || a.type === "raise");
      if (!aggr || aggr.seat === null || !order.includes(aggr.seat)) continue;
      const i = order.indexOf(aggr.seat);
      order = [...order.slice(i), ...order.slice(0, i)];
    } else {
      const atRiver = new Set(river.map((a) => a.seat as number));
      if (atRiver.size < (seats.length === 2 ? 2 : 3)) continue;
    }
    const actual = heroSeatOf(context);
    const won = new Map(hand.results.players.map((p) => [p.seat, p.won]));
    const known = (seat: number) => (context.players.get(seat)?.holeCards?.length ?? 0) === 2;
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
    spots.push({
      h,
      hand,
      walker: actual !== null && seats.includes(actual) ? actual : seats[0],
      actual,
      multiway: seats.length >= 3,
      checked,
      order,
      last,
      combo,
      cards,
      boardCodes,
      strength: streetStrength(toIndices(boardCodes)),
      firstShare: (won.get(order[0]) ?? 0) / totalWon,
      firstName: `${hand.meta.siteId}/${context.players.get(order[0])?.name ?? order[0]}`,
      codes: initiativeCodes(hand),
      lib: libHands.has(h),
    });
  }
  const groups: [string, (s: Spot) => boolean][] = [
    ["checked, three or more", (s) => s.checked && s.multiway],
    ["checked, heads-up", (s) => s.checked && !s.multiway],
    ["bet called, three or more", (s) => !s.checked && s.multiway],
    ["bet called, heads-up", (s) => !s.checked && !s.multiway],
  ];
  console.log(`=== ${hands.length} hands; ${spots.length} river showdowns: ${groups.map(([t, p]) => `${t} ${spots.filter(p).length}`).join(", ")}; library-answered hero flops ${spots.filter((s) => s.lib).length}`);

  const grid: Cand[] = [BASE];
  if (process.env.RN_CANDS) {
    const text = process.env.RN_CANDS.startsWith("/") ? readFileSync(process.env.RN_CANDS, "utf8") : process.env.RN_CANDS;
    for (const c of JSON.parse(text) as Cand[]) grid.push(c);
  }
  const t0 = performance.now();
  const scores = new Map<string, Map<Spot, Result>>();
  for (const [i, cand] of grid.entries()) {
    const m = new Map<Spot, Result>();
    for (const s of spots) {
      const r = evaluate(s, charts, cand, true);
      if (r) m.set(s, r);
    }
    scores.set(cand.name, m);
    process.stderr.write(`  ${i}/${grid.length - 1} ${cand.name} (${((performance.now() - t0) / 1000).toFixed(0)} s)\n`);
  }
  const names = grid.map((c) => c.name);
  const ok = spots.filter((s) => names.every((n) => scores.get(n)?.has(s)));
  console.log(`scored by every candidate: ${ok.length}`);
  const R = (n: string, s: Spot) => scores.get(n)?.get(s) as Result;
  const ll = (n: string, s: Spot) => llScore(s, R(n, s));

  const diagnose = (n: string) => {
    console.log(`--- diagnostics: ${n}`);
    for (const [gt, pick] of groups) {
      const sub = ok.filter(pick);
      const d = clustered(sub, (s) => s.h, (s) => s.firstShare - R(n, s).share);
      const cens = sub.flatMap((s) => R(n, s).cens.map((c) => ({ ...c, h: s.h })));
      const dd = clustered(cens, (c) => c.h, (c) => c.y - c.p);
      console.log(`  ${gt}: n ${sub.length} | first's share won − predicted ${fmt(d)} | later mucked − predicted ${fmt(dd)} (n ${cens.length})`);
    }
    const cens = ok.flatMap((s) => R(n, s).cens.map((c) => ({ ...c, h: s.h, lib: s.lib, g: groupOfLabel(c.label) })));
    const tab = (title: string, keyOf: (c: (typeof cens)[number]) => string | null) => {
      const by = new Map<string, typeof cens>();
      for (const c of cens) {
        const k = keyOf(c);
        if (k !== null) by.set(k, [...(by.get(k) ?? []), c]);
      }
      console.log(`  later players, ${title}: n | mucked | mucked − predicted`);
      for (const [k, list] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (list.length < 8) continue;
        const muck = list.reduce((s, c) => s + c.y, 0) / list.length;
        console.log(`    ${k}: n ${list.length} | ${muck.toFixed(3)} | ${fmt(clustered(list, (c) => c.h, (c) => c.y - c.p))}`);
      }
    };
    tab("by preflop group", (c) => c.g);
    tab("by preflop group × library-answered hero flop", (c) => `${c.g} ${c.lib ? "library" : "heuristic"}`);
    tab("raisers (R1/R2/R4) by postflop line (flop turn river: B initiative bet, X initiative check, b other bet, x check, C call, R raise)", (c) => (c.g === "other" ? null : `${c.g === "R2" ? "R2" : "R1/R4"} ${c.line}`));
    tab("raisers by whether they bet as initiative on flop / turn / river", (c) => (c.g === "other" ? null : `${c.g === "R2" ? "R2" : "R1/R4"} ${["flop", "turn", "river"].map((st, i) => (c.line[i] === "B" ? st[0].toUpperCase() : "·")).join("")}`));
    tab("others by line", (c) => (c.g === "other" ? `other ${c.line}` : null));
    // The first to show (opponents), PIT in preflop range by line group.
    const firsts = ok.filter((s) => s.order[0] !== s.actual);
    const by = new Map<string, Spot[]>();
    for (const s of firsts) {
      const g = groupOfLabel(R(n, s).firstLabel);
      if (g === "other") continue;
      const k = `${g === "R2" ? "R2" : "R1/R4"} ${R(n, s).firstLine.replace(/[^B]/g, "·")}`;
      for (const kk of [g, k]) by.set(kk, [...(by.get(kk) ?? []), s]);
    }
    console.log("  first to show (opponent raisers): n | PIT in preflop range − 0.5 | first's final-range LL");
    for (const [k, list] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (list.length < 8) continue;
      console.log(`    ${k}: n ${list.length} | ${fmt(clustered(list, (s) => s.h, (s) => R(n, s).pitPre - 0.5))}`);
    }
  };
  diagnose(BASE.name);

  const REF = process.env.RN_REF && scores.has(process.env.RN_REF) ? process.env.RN_REF : BASE.name;
  const pickable = process.env.RN_PICK ? names.filter((n) => n === BASE.name || new RegExp(process.env.RN_PICK as string).test(n)) : names;
  const scopes: [string, (s: Spot) => boolean][] = [["all", () => true], ...groups, ["library hero flop", (s) => s.lib], ["heuristic", (s) => !s.lib]];
  console.log(`in sample (unselected LL gain per spot over ${REF}, clustered by hand; share won − predicted; later players of R2 lines mucked − predicted):`);
  for (const n of names) {
    if (n === REF) continue;
    const parts = scopes.slice(0, 5).map(([t, pick]) => {
      const sub = ok.filter(pick);
      const g = clustered(sub, (s) => s.h, (s) => ll(n, s) - ll(REF, s));
      return `${t} ${fmt(g)}`;
    });
    const r2 = ok.flatMap((s) => R(n, s).cens.filter((c) => groupOfLabel(c.label) === "R2").map((c) => ({ ...c, h: s.h })));
    const r1 = ok.flatMap((s) => R(n, s).cens.filter((c) => groupOfLabel(c.label) === "R1").map((c) => ({ ...c, h: s.h })));
    console.log(`  ${n}: ${parts.join(" | ")} | R2 mucks ${fmt(clustered(r2, (c) => c.h, (c) => c.y - c.p))} R1 ${fmt(clustered(r1, (c) => c.h, (c) => c.y - c.p))}`);
  }
  for (const [fname, foldFn, key] of [
    ["hand", (s: Spot) => foldOfHand(s.h), (s: Spot) => s.h as string | number],
    ["player", (s: Spot) => foldOfName(s.firstName), (s: Spot) => s.firstName as string | number],
  ] as const) {
    const chosen: string[] = [];
    const held = new Map<Spot, string>();
    for (let k = 0; k < FOLDS; k += 1) {
      const train = ok.filter((s) => foldFn(s) !== k);
      let best = pickable[0];
      let bestV = -Infinity;
      for (const n of pickable) {
        const v = train.reduce((a, s) => a + ll(n, s), 0);
        if (v > bestV) {
          bestV = v;
          best = n;
        }
      }
      chosen.push(best);
      for (const s of ok) if (foldFn(s) === k) held.set(s, best);
    }
    const out = scopes.map(([t, pick]) => {
      const sub = ok.filter(pick);
      const g = clustered(sub, key, (s) => ll(held.get(s) as string, s) - ll(REF, s));
      const sq = clustered(sub, key, (s) => (s.firstShare - R(REF, s).share) ** 2 - (s.firstShare - R(held.get(s) as string, s).share) ** 2);
      const d = clustered(sub, key, (s) => s.firstShare - R(held.get(s) as string, s).share);
      return `${t}: n ${sub.length} LL gain ${fmt(g)} (${(g.mean / g.se).toFixed(1)} SE); share won − predicted ${fmt(d)}, squared-error gain ${fmt(sq)}`;
    });
    console.log(`held out [folds by ${fname}] over ${REF}, from ${pickable.length} candidates, chose ${chosen.join(" / ")}\n    ${out.join("\n    ")}`);
  }
  if (process.env.RN_DIAG_BEST && scores.has(process.env.RN_DIAG_BEST)) diagnose(process.env.RN_DIAG_BEST);
  // Fidelity: the shipped heuristic against the study's twin of it (`RN_TWIN`, a candidate's name), spot by spot.
  const shipped = grid.find((c) => c.shipped);
  if (shipped && process.env.RN_TWIN && scores.has(process.env.RN_TWIN)) {
    const twin = process.env.RN_TWIN;
    const diffs = ok.map((s) => Math.abs(ll(twin, s) - ll(shipped.name, s)));
    console.log(`fidelity: "${shipped.name}" vs the study's "${twin}", ${ok.length} spots: ${diffs.filter((d) => d > 1e-9).length} differ by more than 1e-9 nats (largest ${Math.max(...diffs).toExponential(2)})`);
  }
  const guarded = process.env.RN_GUARD ?? "";
  const refCand = grid.find((c) => c.name === REF) ?? BASE;
  if (guarded) for (const c of grid) if (c !== refCand && (guarded === "1" || guarded === c.name)) guard(hands, charts, c, refCand);
});
