/**
 * The Learn tab's generated practice: `calc` items (a number to work out,
 * answered before the calculator reveals it) and `classify` items (a board or
 * a hand to sort into a bucket). Every item is a function of its seed, and
 * every answer is graded by Rail's own code:
 *
 * - arithmetic by `lib/learn/math.ts`, the functions the concept pages'
 *   calculators use;
 * - equities exactly, by enumerating every runout with `lib/equity`'s
 *   evaluator;
 * - grades by `grade()` (`lib/analysis/grading.ts`), the analysis' own;
 * - board words by `boardTexture()`, hand words by `madeHand()` / `draws()`
 *   (`lib/analysis/texture.ts`), the functions that describe the reader's
 *   own hands;
 * - range and nut advantage by `rangeVsRange()` / `nutShare()` on the concept
 *   library's illustrative ranges (`presets.ts`, labelled as such on screen).
 *
 * A missed item can come back as a review card: `cardItem` / `itemFromCard`
 * turn it into the small spec the card stores and back, by kind and seed.
 *
 * Pure TypeScript, no React: `tests/test/course.test.ts` imports it under
 * plain Node and checks that every generated item is gradable.
 */

import { grade, type GradeResult } from "../analysis/grading";
import { boardTexture, draws, madeHand, toIndices } from "../analysis/texture";
import { GRADES, type Grade, type MadeHandClass, type OptionAnalysis } from "../analysis/types";
import { cardCode, evaluate } from "../equity/evaluator";
import { pickOne, seeded, type Rng } from "../training/rng";
import type { CalcKind, ClassifyKind } from "./course";
import type { WidgetPreset } from "./concepts";
import { allFold, alpha, callEv, countCombos, mdf, mdfSplit, nutShare, rangeVsRange, requiredEquity, spr } from "./math";
import { presetRange } from "./presets";

/* ---------------------------------------------------------------- shared - */

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function deck(): number[] {
  return Array.from({ length: 52 }, (_, i) => i);
}

/** `n` distinct cards not in `dead`. */
function deal(rng: Rng, n: number, dead: readonly number[] = []): number[] {
  const out: number[] = [];
  const used = new Set(dead);
  while (out.length < n) {
    const card = Math.floor(rng() * 52);
    if (used.has(card)) continue;
    used.add(card);
    out.push(card);
  }
  return out;
}

const codes = (cards: readonly number[]) => cards.map(cardCode);
const rankOf = (card: number) => card >> 2;

/* ------------------------------------------------------------------ calc - */

/** How an answer is entered and compared. Shares are fractions (0.25), shown as percentages. */
export type CalcUnit = "pct" | "bb" | "ratio" | "count" | "grade";

export interface CalcItem {
  kind: CalcKind;
  seed: number;
  /** What the question shows. Amounts in bb, shares as fractions, cards as codes. */
  params: Readonly<Record<string, number | string | readonly string[] | readonly OptionAnalysis[]>>;
  /** Which variant of the question (e.g. `alpha` or `mdf`). */
  ask: string;
  unit: CalcUnit;
  /** The right answer, in `unit` (a grade's index in `GRADES` for `grade`). */
  answer: number;
  /** Absolute tolerance, in `unit`. */
  tolerance: number;
  /** The calculator that reveals it, opened on the item's numbers; null when the reveal is the working alone. */
  widget: WidgetPreset | null;
  /** Numbers the reveal shows besides the answer (the working). */
  working: Readonly<Record<string, number>>;
}

export interface CalcVerdict {
  correct: boolean;
  /** Answer minus truth, in the item's unit (0 for a grade). */
  error: number;
}

const SIZES = [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 2] as const;
const pickPot = (rng: Rng, lo: number, hi: number) => round(lo + Math.floor(rng() * ((hi - lo) * 2 + 1)) / 2, 1);

function potOddsItem(seed: number, rng: Rng): CalcItem {
  const pot = pickPot(rng, 4, 40);
  const size = pickOne(SIZES, rng);
  const bet = round(pot * size, 1);
  const total = round(pot + bet, 1);
  const answer = requiredEquity(total, bet);
  return {
    kind: "pot-odds",
    seed,
    ask: "required",
    params: { pot, bet },
    unit: "pct",
    answer,
    tolerance: 0.015,
    widget: { id: "bet-math", focus: "pot-odds", pot: total, bet, share: round(answer, 3) },
    working: { potAfterCall: round(total + bet, 2), call: bet },
  };
}

/** Every turn and river: the share of the pot `a` wins against `b` on `board` (ties split). */
export function exactEquity(a: readonly number[], b: readonly number[], board: readonly number[]): number {
  const used = new Set([...a, ...b, ...board]);
  const rest = deck().filter((card) => !used.has(card));
  const missing = 5 - board.length;
  let share = 0;
  let runs = 0;
  const score = (cards: number[]) => {
    const va = evaluate([...a, ...cards]);
    const vb = evaluate([...b, ...cards]);
    share += va > vb ? 1 : va === vb ? 0.5 : 0;
    runs += 1;
  };
  if (missing === 0) score([...board]);
  else if (missing === 1) for (const x of rest) score([...board, x]);
  else
    for (let i = 0; i < rest.length; i += 1) {
      for (let j = i + 1; j < rest.length; j += 1) score([...board, rest[i], rest[j]]);
    }
  return runs > 0 ? share / runs : 0;
}

/** Turn cards that put `a` ahead of `b` (strictly): the outs against this one hand. */
export function outsAgainst(a: readonly number[], b: readonly number[], flop: readonly number[]): number {
  const used = new Set([...a, ...b, ...flop]);
  let outs = 0;
  for (let card = 0; card < 52; card += 1) {
    if (used.has(card)) continue;
    if (evaluate([...a, ...flop, card]) > evaluate([...b, ...flop, card])) outs += 1;
  }
  return outs;
}

const PAIRED: readonly MadeHandClass[] = ["overpair", "top-pair", "pocket-pair-below-top", "second-pair", "weak-pair", "underpair", "two-pair", "set", "trips"];

function outsEquityItem(seed: number, rng: Rng): CalcItem {
  // A drawing hand behind a made one on the flop: deal until it is.
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    const flop = deal(rng, 3);
    const hero = deal(rng, 2, flop);
    const villain = deal(rng, 2, [...flop, ...hero]);
    const heroMade = madeHand(hero, flop);
    const villainMade = madeHand(villain, flop);
    if (!heroMade || !villainMade) continue;
    if (heroMade.class !== "high-card" && heroMade.class !== "ace-high") continue;
    if (!PAIRED.includes(villainMade.class) || villainMade.class === "set" || villainMade.class === "trips") continue;
    const heroDraws = draws(hero, flop);
    if (!heroDraws.some((d) => d === "flush-draw" || d === "nut-flush-draw" || d === "oesd" || d === "gutshot")) continue;
    const outs = outsAgainst(hero, villain, flop);
    if (outs < 4) continue;
    const answer = exactEquity(hero, villain, flop);
    return {
      kind: "outs-equity",
      seed,
      ask: "equity",
      params: { flop: codes(flop), hero: codes(hero), villain: codes(villain) },
      unit: "pct",
      answer,
      tolerance: 0.05,
      widget: null,
      working: { outs, ruleOf4: Math.min(1, outs * 0.04), ruleOf2: Math.min(1, outs * 0.02) },
    };
  }
  throw new Error(`outs-equity: no draw found for seed ${seed}`);
}

function evItem(seed: number, rng: Rng): CalcItem {
  const pot = pickPot(rng, 6, 30);
  const size = pickOne([0.5, 0.66, 0.75, 1] as const, rng);
  const bet = round(pot * size, 1);
  const folds = round(0.2 + Math.floor(rng() * 9) * 0.05, 2);
  const equity = round(0.15 + Math.floor(rng() * 7) * 0.05, 2);
  // Folded: win the pot. Called: the hand goes to showdown with no more betting.
  const whenFolded = pot;
  const whenCalled = callEv(pot + bet, bet, equity);
  const answer = folds * whenFolded + (1 - folds) * whenCalled;
  return {
    kind: "ev",
    seed,
    ask: "semi-bluff",
    params: { pot, bet, folds, equity },
    unit: "bb",
    answer,
    tolerance: Math.max(0.25, 0.08 * Math.abs(answer)),
    widget: { id: "bet-math", focus: "alpha", pot, bet, share: folds },
    working: { whenFolded, whenCalled: round(whenCalled, 2), foldPart: round(folds * whenFolded, 2), callPart: round((1 - folds) * whenCalled, 2) },
  };
}

const RANKS = "23456789TJQKA";

function combosItem(seed: number, rng: Rng): CalcItem {
  const board = deal(rng, 3);
  const hero = deal(rng, 2, board);
  const seen = [...board, ...hero];
  const seenRanks = [...new Set(seen.map(rankOf))];
  // Ask about a rank that is on the board or in the hand, so card removal matters.
  const shape = pickOne(["pair", "offsuit-or-suited", "suited"] as const, rng);
  let label: string;
  let classes: string[];
  if (shape === "pair") {
    const r = RANKS[pickOne(seenRanks, rng)];
    label = `${r}${r}`;
    classes = [label];
  } else {
    const a = pickOne(seenRanks, rng);
    let b = pickOne(seenRanks, rng);
    if (b === a) b = (a + 1 + Math.floor(rng() * 12)) % 13;
    const [hi, lo] = a > b ? [a, b] : [b, a];
    const base = `${RANKS[hi]}${RANKS[lo]}`;
    if (shape === "suited") {
      label = `${base}s`;
      classes = [label];
    } else {
      label = base;
      classes = [`${base}s`, `${base}o`];
    }
  }
  const counted = countCombos(classes, codes(seen));
  const total = counted.reduce((sum, c) => sum + c.total, 0);
  const left = counted.reduce((sum, c) => sum + c.left, 0);
  return {
    kind: "combos",
    seed,
    ask: shape,
    params: { board: codes(board), hero: codes(hero), hand: label },
    unit: "count",
    answer: left,
    tolerance: 0,
    widget: null,
    working: { total, removed: total - left },
  };
}

function alphaMdfItem(seed: number, rng: Rng): CalcItem {
  const size = pickOne(SIZES, rng);
  const ask = rng() < 0.5 ? "alpha" : "mdf";
  const pot = 10;
  const bet = round(pot * size, 2);
  const answer = ask === "alpha" ? alpha(pot, bet) : mdf(pot, bet);
  return {
    kind: "alpha-mdf",
    seed,
    ask,
    params: { size },
    unit: "pct",
    answer,
    tolerance: 0.015,
    widget: { id: "bet-math", focus: "mdf", pot, bet },
    working: { alpha: round(alpha(pot, bet), 4), mdf: round(mdf(pot, bet), 4) },
  };
}

function sprItem(seed: number, rng: Rng): CalcItem {
  const shape = pickOne(["srp", "3bp", "4bp"] as const, rng);
  const start = pickOne([100, 100, 150, 200] as const, rng);
  let pot: number;
  let inPer: number;
  if (shape === "srp") {
    inPer = pickOne([2.2, 2.5, 3] as const, rng);
    pot = round(inPer * 2 + 0.5 + (rng() < 0.5 ? 0 : 1), 1);
  } else if (shape === "3bp") {
    inPer = pickOne([7.5, 9, 10, 11, 12] as const, rng);
    pot = round(inPer * 2 + 0.5 + (rng() < 0.5 ? 0 : 1), 1);
  } else {
    inPer = pickOne([20, 22, 24, 25] as const, rng);
    pot = round(inPer * 2 + 0.5 + (rng() < 0.5 ? 0 : 1), 1);
  }
  const stack = round(start - inPer, 1);
  const answer = spr(stack, pot);
  return {
    kind: "spr",
    seed,
    ask: shape,
    params: { pot, stack, start },
    unit: "ratio",
    answer,
    tolerance: Math.max(0.15, 0.05 * answer),
    widget: { id: "spr", pot, stack },
    working: {},
  };
}

/** A small options table and a choice; the question is the grade `grade()` gives it. */
function gradeItem(seed: number, rng: Rng): CalcItem {
  const target = pickOne(GRADES, rng);
  const pot = pickPot(rng, 6, 60);
  const actions = pickOne(
    [
      ["fold", "call", "raise"],
      ["check", "bet"],
      ["fold", "call"],
      ["check", "bet", "bet"],
    ] as const,
    rng,
  );
  const n = actions.length;
  const best = Math.floor(rng() * n);
  let chosen = (best + 1 + Math.floor(rng() * (n - 1))) % n;
  const freqs = new Array<number>(n).fill(0);
  const evs = new Array<number>(n).fill(0);
  const baseEv = round(pot * (0.05 + rng() * 0.3), 2);
  // EV loss as a share of the pot, and the chosen option's frequency, per target.
  let lossPot: number;
  let chosenFreq: number;
  switch (target) {
    case "perfect":
      chosen = best;
      lossPot = 0;
      chosenFreq = round(0.55 + rng() * 0.4, 2);
      break;
    case "good":
      lossPot = 0.003 + rng() * 0.01;
      chosenFreq = round(0.1 + rng() * 0.25, 2);
      break;
    case "inaccurate":
      lossPot = 0.003 + rng() * 0.015;
      chosenFreq = round(rng() * 0.03, 2);
      break;
    case "mistake":
      lossPot = 0.025 + rng() * 0.05;
      chosenFreq = 0;
      break;
    default:
      lossPot = 0.1 + rng() * 0.3;
      chosenFreq = 0;
  }
  freqs[chosen] = chosenFreq;
  const others = [...Array(n).keys()].filter((i) => i !== chosen);
  let left = round(1 - chosenFreq, 2);
  others.forEach((i, k) => {
    if (k === others.length - 1) {
      freqs[i] = left;
    } else {
      const f = i === best ? round(Math.max(left * 0.7, left - 0.05), 2) : round(left * 0.2, 2);
      freqs[i] = f;
      left = round(left - f, 2);
    }
  });
  // The best option holds the most frequency, so a chosen non-best one is never "near the max".
  if (chosen !== best && freqs[best] < freqs[chosen] + 0.1) {
    const move = Math.min(freqs[chosen], 0.1);
    freqs[chosen] = round(freqs[chosen] - move, 2);
    freqs[best] = round(freqs[best] + move, 2);
  }
  for (let i = 0; i < n; i += 1) {
    if (i === best) evs[i] = baseEv;
    else if (i === chosen) evs[i] = round(baseEv - lossPot * pot, 2);
    else evs[i] = round(baseEv - pot * (0.01 + rng() * 0.1), 2);
  }
  if (actions[0] === "fold") {
    // Folding is worth exactly zero; shift every option so it is.
    const shift = evs[0];
    for (let i = 0; i < n; i += 1) evs[i] = round(evs[i] - shift, 2);
  }
  const options: OptionAnalysis[] = actions.map((action, i) => ({
    action,
    freq: freqs[i],
    ev: evs[i],
    ...(action === "bet" || action === "raise" ? { sizePot: actions.filter((a) => a === action).length > 1 ? (i === n - 1 ? 1 : 0.33) : 0.66 } : {}),
  }));
  const result: GradeResult = grade({ options, chosen, pot });
  return {
    kind: "grade",
    seed,
    ask: "grade",
    params: { pot, options, chosen },
    unit: "grade",
    answer: GRADES.indexOf(result.grade),
    tolerance: 0,
    widget: { id: "grading" },
    working: { evLoss: round(result.evLoss, 2), evLossPot: round(result.evLossPot, 4), freqDiff: round(result.freqDiff, 2) },
  };
}

const OPENS = [2, 2.2, 2.5, 3, 3.5, 4, 5] as const;

function stealItem(seed: number, rng: Rng): CalcItem {
  const open = pickOne(OPENS, rng);
  const blinds = 1.5;
  const answer = alpha(blinds, open);
  return {
    kind: "steal",
    seed,
    ask: "break-even",
    params: { open, blinds },
    unit: "pct",
    answer,
    tolerance: 0.015,
    widget: { id: "bet-math", focus: "steal", pot: blinds, bet: open, share: round(answer, 2) },
    working: {},
  };
}

function blindPriceItem(seed: number, rng: Rng): CalcItem {
  const open = pickOne(OPENS, rng);
  // The small blind folds: the pot holds its 0.5, the big blind's 1 and the open.
  const pot = round(open + 1.5, 2);
  const call = round(open - 1, 2);
  const answer = requiredEquity(pot, call);
  return {
    kind: "blind-price",
    seed,
    ask: "required",
    params: { open },
    unit: "pct",
    answer,
    tolerance: 0.015,
    widget: { id: "bet-math", focus: "pot-odds", pot, bet: call, share: round(answer, 3) },
    working: { pot, call },
  };
}

function per100Item(seed: number, rng: Rng): CalcItem {
  const hands = 500 + Math.floor(rng() * 56) * 100;
  const lost = round(5 + Math.floor(rng() * 230) * 0.5, 1);
  const answer = (lost / hands) * 100;
  return {
    kind: "per100",
    seed,
    ask: "per100",
    params: { hands, lost },
    unit: "bb",
    answer,
    tolerance: Math.max(0.05, 0.03 * answer),
    widget: null,
    working: {},
  };
}

function allinEvItem(seed: number, rng: Rng): CalcItem {
  const stack = pickOne([20, 25, 30, 40, 50, 60, 80, 100] as const, rng);
  const dead = pickOne([1.5, 3, 6.5, 10, 20] as const, rng);
  const equity = round(0.25 + Math.floor(rng() * 11) * 0.05, 2);
  const pot = round(dead + stack, 2);
  const answer = callEv(pot, stack, equity);
  return {
    kind: "allin-ev",
    seed,
    ask: "call-ev",
    params: { stack, dead, equity },
    unit: "bb",
    answer,
    tolerance: Math.max(0.3, 0.03 * Math.abs(answer)),
    widget: { id: "bet-math", focus: "pot-odds", pot, bet: stack, share: equity },
    working: { win: round(dead + stack, 2), lose: -stack, required: round(requiredEquity(pot, stack), 4) },
  };
}

function multiwayItem(seed: number, rng: Rng): CalcItem {
  const pot = pickPot(rng, 6, 30);
  const size = pickOne([0.33, 0.5, 0.75, 1] as const, rng);
  const bet = round(pot * size, 1);
  const opponents = pickOne([2, 3] as const, rng);
  const ask = rng() < 0.5 ? "all-fold" : "mdf-split";
  const foldEach = round(0.4 + Math.floor(rng() * 8) * 0.05, 2);
  const answer = ask === "all-fold" ? allFold(foldEach, opponents) : mdfSplit(pot, bet, opponents);
  return {
    kind: "multiway",
    seed,
    ask,
    params: { pot, bet, opponents, foldEach },
    unit: "pct",
    answer,
    tolerance: 0.02,
    widget: { id: "multiway", pot, bet, share: foldEach, opponents },
    working: { alpha: round(alpha(pot, bet), 4) },
  };
}

const CALC_MAKERS: Readonly<Record<CalcKind, (seed: number, rng: Rng) => CalcItem>> = {
  "pot-odds": potOddsItem,
  "outs-equity": outsEquityItem,
  ev: evItem,
  combos: combosItem,
  "alpha-mdf": alphaMdfItem,
  spr: sprItem,
  grade: gradeItem,
  steal: stealItem,
  "blind-price": blindPriceItem,
  per100: per100Item,
  "allin-ev": allinEvItem,
  multiway: multiwayItem,
};

/** A calc item for `seed`. Deterministic. */
export function generateCalc(kind: CalcKind, seed: number): CalcItem {
  return CALC_MAKERS[kind](seed >>> 0, seeded(seed >>> 0));
}

/** Grades an answer in the item's unit (shares as fractions; a grade as its index). */
export function gradeCalc(item: CalcItem, value: number): CalcVerdict {
  if (!Number.isFinite(value)) return { correct: false, error: Number.NaN };
  if (item.unit === "grade") return { correct: Math.round(value) === item.answer, error: 0 };
  const error = value - item.answer;
  // Half a hundredth of slack for rounding on screen.
  return { correct: Math.abs(error) <= item.tolerance + 1e-9, error };
}

/** `GRADES`, for the grade question's choices. */
export const GRADE_CHOICES: readonly Grade[] = GRADES;

/* -------------------------------------------------------------- classify - */

export interface ClassifyItem {
  kind: ClassifyKind;
  seed: number;
  /** What is sorted: for `texture`, which property. */
  ask: string;
  board: readonly string[];
  hand?: readonly string[];
  /** Bucket ids, in display order. */
  buckets: readonly string[];
  answer: string;
  /** Numbers the reveal shows (volatility, equities, nut shares, the made hand). */
  detail: Readonly<Record<string, number | string>>;
  widget: WidgetPreset | null;
}

const TEXTURE_ASKS = ["suits", "pairing", "connectedness", "high-card"] as const;

function textureBuckets(ask: (typeof TEXTURE_ASKS)[number]): string[] {
  switch (ask) {
    case "suits":
      return ["rainbow", "two-tone", "monotone"];
    case "pairing":
      return ["unpaired", "paired"];
    case "connectedness":
      return ["disconnected", "semi-connected", "connected"];
    default:
      return ["ace", "broadway", "middle", "low"];
  }
}

function textureBucket(ask: (typeof TEXTURE_ASKS)[number], board: number[]): string | null {
  const t = boardTexture(board);
  if (!t) return null;
  switch (ask) {
    case "suits":
      return t.suits;
    case "pairing":
      return t.paired ? "paired" : "unpaired";
    case "connectedness":
      return t.connectedness;
    default:
      return t.highCard;
  }
}

/** Deals flops until one lands in the target bucket (chosen first, so every bucket comes up). */
function flopIn(rng: Rng, test: (flop: number[]) => boolean, tries = 5000): number[] | null {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const flop = deal(rng, 3);
    if (test(flop)) return flop;
  }
  return null;
}

function textureItem(seed: number, rng: Rng): ClassifyItem {
  const ask = pickOne(TEXTURE_ASKS, rng);
  const buckets = textureBuckets(ask);
  const target = pickOne(buckets, rng);
  const flop = flopIn(rng, (f) => textureBucket(ask, f) === target) ?? deal(rng, 3);
  const t = boardTexture(flop)!;
  return {
    kind: "texture",
    seed,
    ask,
    board: codes(flop),
    buckets,
    answer: textureBucket(ask, flop)!,
    detail: { straightCombos: t.straightCombos, volatility: round(t.volatility ?? 0, 3) },
    widget: { id: "board-texture", focus: "texture", board: codes(flop) },
  };
}

function dynamismItem(seed: number, rng: Rng): ClassifyItem {
  const buckets = ["static", "medium", "dynamic"];
  const target = pickOne(buckets, rng);
  const flop = flopIn(rng, (f) => boardTexture(f)?.dynamism === target) ?? deal(rng, 3);
  const t = boardTexture(flop)!;
  return {
    kind: "dynamism",
    seed,
    ask: "dynamism",
    board: codes(flop),
    buckets,
    answer: t.dynamism ?? "static",
    detail: { volatility: round(t.volatility ?? 0, 3) },
    widget: { id: "board-texture", focus: "dynamism", board: codes(flop) },
  };
}

const STRONG: readonly MadeHandClass[] = ["straight-flush", "quads", "full-house", "flush", "straight", "set", "trips", "two-pair"];
const TOP: readonly MadeHandClass[] = ["overpair", "top-pair"];
const MIDDLE: readonly MadeHandClass[] = ["pocket-pair-below-top", "second-pair", "weak-pair", "underpair"];

/** A hand on a flop in one of five plain buckets: strong, top pair or better pair, a lesser pair, a strong draw, or air. */
export function handBucket(hole: readonly number[], flop: readonly number[]): { bucket: string; made: MadeHandClass; draws: string[] } | null {
  const made = madeHand(hole, flop);
  if (!made) return null;
  const drawList = draws(hole, flop);
  let bucket: string;
  if (STRONG.includes(made.class)) bucket = "strong";
  else if (TOP.includes(made.class)) bucket = "top";
  else if (MIDDLE.includes(made.class)) bucket = "middle";
  else if (drawList.some((d) => d === "flush-draw" || d === "nut-flush-draw" || d === "oesd")) bucket = "draw";
  else bucket = "air";
  return { bucket, made: made.class, draws: drawList };
}

function handClassItem(seed: number, rng: Rng): ClassifyItem {
  const buckets = ["strong", "top", "middle", "draw", "air"];
  const target = pickOne(buckets, rng);
  let flop: number[] = [];
  let hole: number[] = [];
  let found: ReturnType<typeof handBucket> = null;
  for (let attempt = 0; attempt < 8000; attempt += 1) {
    flop = deal(rng, 3);
    hole = deal(rng, 2, flop);
    found = handBucket(hole, flop);
    if (found && found.bucket === target) break;
  }
  found = found ?? handBucket(hole, flop)!;
  return {
    kind: "hand-class",
    seed,
    ask: "hand-class",
    board: codes(flop),
    hand: codes(hole),
    buckets,
    answer: found.bucket,
    detail: { made: found.made, draws: found.draws.join(",") },
    widget: null,
  };
}

/** Range-equity samples for a classify item: enough that the buckets' gaps are several standard errors wide. */
const CLASSIFY_TRIALS = 12_000;
const TURN_TRIALS = 20_000;
/**
 * The raiser's range equity from which a flop counts as clearly the raiser's,
 * and up to which it counts as close. With the concept library's illustrative
 * button-open and big-blind ranges the flops run from about 48% to 57%, so
 * the two buckets sit at either end, with a gap between them that is never
 * asked about.
 */
export const RAISER_FAVOURED = 0.535;
export const CLOSE_MAX = 0.505;

/** Flops worth proposing for each bucket, before the equity decides. */
function proposeFlop(rng: Rng, bucket: string): number[] {
  if (bucket === "close") {
    return (
      flopIn(rng, (f) => Math.max(...f.map(rankOf)) <= 10 && boardTexture(f)?.connectedness !== "disconnected") ?? deal(rng, 3)
    );
  }
  if (bucket === "raiser") {
    return flopIn(rng, (f) => Math.max(...f.map(rankOf)) === 12 || boardTexture(f)?.paired === true) ?? deal(rng, 3);
  }
  return deal(rng, 3);
}

function rangeAdvantageItem(seed: number, rng: Rng): ClassifyItem {
  const a = presetRange("open-btn");
  const b = presetRange("call-bb");
  const buckets = ["raiser", "close"];
  const target = pickOne(buckets, rng);
  let fallback: ClassifyItem | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const flop = proposeFlop(rng, target);
    const equity = rangeVsRange(a, b, codes(flop), CLASSIFY_TRIALS, seed ^ 0x5eed).equity;
    const bucket = equity >= RAISER_FAVOURED ? "raiser" : equity <= CLOSE_MAX ? "close" : null;
    if (!bucket) continue;
    const item: ClassifyItem = {
      kind: "range-advantage",
      seed,
      ask: "btn-vs-bb",
      board: codes(flop),
      buckets,
      answer: bucket,
      detail: { equity: round(equity, 3) },
      widget: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: codes(flop) },
    };
    if (bucket === target) return item;
    fallback = fallback ?? item;
  }
  if (fallback) return fallback;
  throw new Error(`range-advantage: no flop for seed ${seed}`);
}

/**
 * The raiser's nut-share lead (a UTG open against the big blind's call) that
 * counts as big, and up to which it counts as small. The early opener's
 * narrow range holds a bigger share of the strongest hands on almost every
 * flop; how much bigger is what moves bet sizes.
 */
export const NUT_BIG = 0.14;
export const NUT_SMALL = 0.085;

function nutAdvantageItem(seed: number, rng: Rng): ClassifyItem {
  const a = presetRange("open-utg");
  const b = presetRange("call-bb-vs-utg");
  const buckets = ["big", "small"];
  const target = pickOne(buckets, rng);
  let fallback: ClassifyItem | null = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const flop =
      target === "small"
        ? (flopIn(rng, (f) => Math.max(...f.map(rankOf)) <= 9 && boardTexture(f)?.connectedness !== "disconnected") ?? deal(rng, 3))
        : deal(rng, 3);
    const board = codes(flop);
    const sa = nutShare(a, board);
    const sb = nutShare(b, board);
    const gap = sa - sb;
    const bucket = gap >= NUT_BIG ? "big" : gap <= NUT_SMALL ? "small" : null;
    if (!bucket) continue;
    const item: ClassifyItem = {
      kind: "nut-advantage",
      seed,
      ask: "utg-vs-bb",
      board,
      buckets,
      answer: bucket,
      detail: { raiser: round(sa, 3), caller: round(sb, 3) },
      widget: { id: "range-vs-range", focus: "nuts", preset: "utg-vs-bb", board },
    };
    if (bucket === target) return item;
    fallback = fallback ?? item;
  }
  if (fallback) return fallback;
  throw new Error(`nut-advantage: no flop for seed ${seed}`);
}

/** Change in the raiser's range equity a turn card needs to count as helping one side, and the band that counts as neutral. */
export const TURN_SHIFT = 0.02;
export const TURN_NEUTRAL = 0.005;

function turnCardItem(seed: number, rng: Rng): ClassifyItem {
  const a = presetRange("open-btn");
  const b = presetRange("call-bb");
  const buckets = ["raiser", "neutral", "caller"];
  const target = pickOne(buckets, rng);
  let fallback: ClassifyItem | null = null;
  for (let flopTry = 0; flopTry < 4; flopTry += 1) {
    const flop = deal(rng, 3);
    const flopCodes = codes(flop);
    const base = rangeVsRange(a, b, flopCodes, TURN_TRIALS, seed ^ 0x7a11).equity;
    const used = new Set(flop);
    const turns = deck().filter((card) => !used.has(card));
    // Shuffle the turn cards, then take the first that lands in the target bucket.
    for (let i = turns.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [turns[i], turns[j]] = [turns[j], turns[i]];
    }
    for (const turn of turns.slice(0, 16)) {
      const board = [...flopCodes, cardCode(turn)];
      const equity = rangeVsRange(a, b, board, TURN_TRIALS, seed ^ 0x7a11).equity;
      const shift = equity - base;
      const bucket = shift >= TURN_SHIFT ? "raiser" : shift <= -TURN_SHIFT ? "caller" : Math.abs(shift) <= TURN_NEUTRAL ? "neutral" : null;
      if (!bucket) continue;
      const item: ClassifyItem = {
        kind: "turn-card",
        seed,
        ask: "btn-vs-bb",
        board,
        buckets,
        answer: bucket,
        detail: { before: round(base, 3), after: round(equity, 3) },
        widget: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board },
      };
      if (bucket === target) return item;
      fallback = fallback ?? item;
    }
  }
  if (fallback) return fallback;
  throw new Error(`turn-card: no turn for seed ${seed}`);
}

const CLASSIFY_MAKERS: Readonly<Record<ClassifyKind, (seed: number, rng: Rng) => ClassifyItem>> = {
  texture: textureItem,
  dynamism: dynamismItem,
  "hand-class": handClassItem,
  "range-advantage": rangeAdvantageItem,
  "nut-advantage": nutAdvantageItem,
  "turn-card": turnCardItem,
};

/** A classify item for `seed`. Deterministic. */
export function generateClassify(kind: ClassifyKind, seed: number): ClassifyItem {
  return CLASSIFY_MAKERS[kind](seed >>> 0, seeded(seed >>> 0));
}

export function gradeClassify(item: ClassifyItem, bucket: string): boolean {
  return bucket === item.answer;
}

/** The board as indices, for the components that draw cards. */
export const boardIndices = (item: Pick<ClassifyItem, "board">) => toIndices(item.board);

/* ----------------------------------------------------------- pass rules - */

/** Whether `correct` of `total` answers passes an exercise that asks `count` with a pass share of `pass`. */
export function passes(correct: number, total: number, count: number, pass: number): boolean {
  return total >= count && correct >= Math.ceil(pass * count - 1e-9);
}

/** The answers right needed to pass. */
export function needed(count: number, pass: number): number {
  return Math.ceil(pass * count - 1e-9);
}

/** Pot odds and MDF as `calc` reveal sentences need them (re-exported so components import one module). */
export { requiredEquity };
