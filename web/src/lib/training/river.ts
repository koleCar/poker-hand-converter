/**
 * The river spot trainer: a realistic heads-up river, solved on demand, the
 * hero dealt a combo from their own range at the node, the answer graded
 * exactly as the analysis grades a real hand there (A4).
 *
 * ```
 * a preflop line from the charts (heads-up to the flop) ─▶ a random board
 *   ─▶ flop and turn lines from a small set of common patterns
 *   ─▶ the hand as text (handText.ts) ─▶ walkRanges: both ranges narrowed (narrowing.ts)
 *   ─▶ solveRiverSpot (the analysis' own river solve)
 *   ─▶ out of position first: the villain's action drawn from the solve's own frequencies
 *   ─▶ the hero's combo drawn from the hero's range at the node (reach-weighted)
 * answer ─▶ the hand plus the hero's action ─▶ gradeAnswer (analyzeHand, grade.ts)
 * ```
 *
 * **Why the solve the hero sees is the one that grades.** The walk does not
 * read the hero's cards and the solve adds the hero's combo only when it is
 * not already in the range, so dealing a combo from the range at the node
 * leaves both unchanged: `analyzeHand` on the finished hand re-runs the same
 * walk and the same solve and lands on the same node. The trainer never
 * grades with anything the analysis does not.
 *
 * **The ranges are the analysis' ranges**: the charts' preflop ranges,
 * narrowed through the flop and turn by the heuristic model (`heuristic/2`),
 * with every caveat that carries (`narrowing-heuristic`). The screen says so.
 */

import type { ChartPosition, ChartSet } from "../charts";
import { followLine, solveRiverSpot, walkLine, walkRanges, type RiverAct, type RiverSolve } from "../analysis";
import { cardCode } from "../equity/evaluator";
import type { PhfHand } from "../phf/types";
import { comboHi, comboLo, NUM_COMBOS, rangesAt, type ActionKind } from "../solver";
import { buildContext } from "../stats/context";
import {
  handUpTo,
  lastHeroDecision,
  POSTFLOP_ORDER,
  scriptHand,
  scriptMoney,
  seatOf,
  type HandScript,
  type ScriptAct,
} from "./handText";
import { lineActs, type DealBias } from "./preflop";
import { pickOne, pickWeighted, seeded, type Rng } from "./rng";

export const RIVER_POTS = ["srp", "3bp", "limped"] as const;
export type RiverPot = (typeof RIVER_POTS)[number];
export const RIVER_SEATS = ["ip", "oop"] as const;
export type RiverSeat = (typeof RIVER_SEATS)[number];

/** A heads-up preflop line as a chart line key (one letter per action, folds included). */
export interface RiverLine {
  id: string;
  pot: RiverPot;
  line: string;
}

/**
 * The preflop lines a river spot starts from: the common heads-up pots, all
 * reached by the charts with real frequency. A flat the charts almost never
 * make (the button calling a cutoff open, 0.2%) is left out: its range would
 * be a handful of combos.
 */
export const RIVER_LINES: readonly RiverLine[] = [
  { id: "utg-bb", pot: "srp", line: "rffffc" },
  { id: "hj-bb", pot: "srp", line: "frfffc" },
  { id: "co-bb", pot: "srp", line: "ffrffc" },
  { id: "btn-bb", pot: "srp", line: "fffrfc" },
  { id: "btn-sb", pot: "srp", line: "fffrcf" },
  { id: "sb-bb", pot: "srp", line: "ffffrc" },
  { id: "co-btn-3bet", pot: "3bp", line: "ffrrffc" },
  { id: "co-bb-3bet", pot: "3bp", line: "ffrffrc" },
  { id: "btn-sb-3bet", pot: "3bp", line: "fffrrfc" },
  { id: "btn-bb-3bet", pot: "3bp", line: "fffrfrc" },
  { id: "sb-bb-3bet", pot: "3bp", line: "ffffrrc" },
  { id: "sb-limp", pot: "limped", line: "ffffck" },
];

/** One flop or turn line, by who acts: `o` out of position, `i` in position. */
export interface StreetPattern {
  id: string;
  steps: ReadonlyArray<readonly ["o" | "i", "check" | "call" | "bet", number?]>;
}

const PATTERNS: Record<string, StreetPattern> = {
  xx: { id: "xx", steps: [["o", "check"], ["i", "check"]] },
  xb33: { id: "xb33", steps: [["o", "check"], ["i", "bet", 0.33], ["o", "call"]] },
  xb75: { id: "xb75", steps: [["o", "check"], ["i", "bet", 0.75], ["o", "call"]] },
  b33: { id: "b33", steps: [["o", "bet", 0.33], ["i", "call"]] },
  b75: { id: "b75", steps: [["o", "bet", 0.75], ["i", "call"]] },
};

/** How often each pattern is played, by who has the initiative (the preflop raiser). */
export const PATTERN_WEIGHTS: Record<"ip" | "oop" | "none", Record<"flop" | "turn", Array<[string, number]>>> = {
  // The preflop raiser in position: c-bets or checks back; the caller rarely leads.
  ip: {
    flop: [["xb33", 0.45], ["xb75", 0.15], ["xx", 0.32], ["b33", 0.06], ["b75", 0.02]],
    turn: [["xb75", 0.3], ["xb33", 0.15], ["xx", 0.4], ["b75", 0.1], ["b33", 0.05]],
  },
  // The preflop raiser out of position: leads or checks; the caller stabs after a check.
  oop: {
    flop: [["b33", 0.4], ["b75", 0.12], ["xx", 0.3], ["xb33", 0.13], ["xb75", 0.05]],
    turn: [["b75", 0.3], ["b33", 0.12], ["xx", 0.35], ["xb75", 0.15], ["xb33", 0.08]],
  },
  none: {
    flop: [["xx", 0.4], ["xb33", 0.25], ["b33", 0.25], ["xb75", 0.05], ["b75", 0.05]],
    turn: [["xx", 0.4], ["xb75", 0.2], ["b75", 0.2], ["xb33", 0.1], ["b33", 0.1]],
  },
};

/** A bet that would put in more than this share of what is behind is played as a check instead: no all-ins before the river. */
const MAX_BET_SHARE = 0.6;
/** The villain's river action is drawn only from actions the solve takes at least this often (the analysis' `MIN_ACTION_FREQ`). */
export const MIN_VILLAIN_FREQ = 0.01;
/** Attempts before giving up on a seed (a line the solve never reaches, a range emptied by the board). */
export const MAX_ATTEMPTS = 12;
/** `borderline`: the floor every combo keeps. */
const BORDERLINE_FLOOR = 0.1;

/** The hero's preflop role on a river line: the last raiser, or the one who called. */
export const RIVER_ROLES = ["pfr", "caller"] as const;
export type RiverRole = (typeof RIVER_ROLES)[number];

export interface RiverSpotOptions {
  pot?: RiverPot | "any";
  seat?: RiverSeat | "any";
  /** Only lines where the hero raised preflop last (`pfr`) or called (`caller`); a limped pot is neither. */
  role?: RiverRole | "any";
  bias?: DealBias;
  /**
   * In position only (the villain acts first there): deal only spots where
   * the villain checked (`check`) or bet (`bet`). Asking for either makes the
   * hero the in-position player. Additive (Learn, L1); absent means any.
   */
  facing?: "check" | "bet" | "any";
}

/** The seat a spot filter pins: a `facing` filter is an in-position spot by definition. */
export function filterSeat(options: Pick<RiverSpotOptions, "seat" | "facing">): RiverSeat | "any" {
  if (options.facing === "check" || options.facing === "bet") return "ip";
  return options.seat ?? "any";
}

/** The villain's first actions a `facing` filter allows, as weights over the root's actions. */
export function facingWeights(
  actions: ReadonlyArray<{ kind: ActionKind }>,
  frequency: ArrayLike<number>,
  facing: RiverSpotOptions["facing"],
  minFreq: number,
): number[] {
  return actions.map((action, i) => {
    const f = frequency[i];
    if (!(f >= minFreq)) return 0;
    if (facing === "check" && action.kind !== "check") return 0;
    if (facing === "bet" && action.kind === "check") return 0;
    return f;
  });
}

export interface RiverMenuItem {
  kind: ActionKind;
  /** Bet / raise / all-in: the hero's river total after it, bb. */
  to: number;
  /** Chips it puts in, bb. */
  amount: number;
  /** Fraction of the pot (a raise: its increment over the pot after the call). */
  sizePot: number;
}

export interface RiverTrainerSpot {
  kind: "river";
  seed: number;
  set: string;
  lineId: string;
  pot: RiverPot;
  hero: ChartPosition;
  villain: ChartPosition;
  seat: RiverSeat;
  board: string[];
  cards: [string, string];
  /** The hand up to the hero's river decision. */
  script: HandScript;
  hand: PhfHand;
  menu: RiverMenuItem[];
  /** Pot at the decision and the bet to call, bb. */
  potBb: number;
  toCallBb: number;
  /** Effective stack at the start of the river, bb. */
  stackBb: number;
  /** The villain's river action before the hero's, if the villain acts first. */
  facing: { kind: ActionKind; to: number; sizePot: number } | null;
  /** Where each preflop range came from (`chart` or the labelled `placeholder`). */
  sources: { hero: "chart" | "placeholder"; villain: "chart" | "placeholder" };
  model: string;
  iterations: number;
  exploitabilityPct: number;
}

/** The lines the chart set can play: every raise and call on the line is in its tree. */
export function riverLines(charts: ChartSet, pot: RiverPot | "any" = "any"): RiverLine[] {
  return RIVER_LINES.filter((line) => {
    if (pot !== "any" && line.pot !== pot) return false;
    try {
      lineActs(charts, line.line);
      return true;
    } catch {
      return false;
    }
  });
}

/** The two players who see the flop on a line, out of position first. */
export function flopPlayers(line: string): [ChartPosition, ChartPosition] {
  const { steps } = walkLine(line);
  const folded = new Set(steps.filter((s) => s.code === "f").map((s) => s.position));
  const live = (["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const).filter((p) => !folded.has(p));
  if (live.length !== 2) throw new RangeError(`line ${line} is not heads-up to the flop`);
  live.sort((a, b) => POSTFLOP_ORDER.indexOf(a) - POSTFLOP_ORDER.indexOf(b));
  return [live[0], live[1]];
}

/** The last raiser on a preflop line, or null for a limped pot. */
export function raiserOf(line: string): ChartPosition | null {
  let last: ChartPosition | null = null;
  for (const step of walkLine(line).steps) if (step.code === "r" || step.code === "a") last = step.position;
  return last;
}

/** One way a river spot can be dealt: a line, the hero's side, and who that makes the hero. */
export interface RiverSeating {
  line: RiverLine;
  seat: RiverSeat;
  hero: ChartPosition;
  villain: ChartPosition;
  /** The hero's preflop role; `limped` in a limped pot. */
  role: RiverRole | "limped";
}

/**
 * Every (line, side) the river trainer can deal under a filter, from
 * {@link RIVER_LINES} alone (no chart set needed): what a study plan links to,
 * and — as `<line id>:<hero seat>` — what it counts the trainer's answers by
 * (`trainer_results.spot` and `.position`).
 */
export function riverSeatings(filter: Pick<RiverSpotOptions, "pot" | "seat" | "role"> = {}, lines: readonly RiverLine[] = RIVER_LINES): RiverSeating[] {
  const out: RiverSeating[] = [];
  for (const line of lines) {
    if (filter.pot && filter.pot !== "any" && line.pot !== filter.pot) continue;
    const [oop, ip] = flopPlayers(line.line);
    const raiser = raiserOf(line.line);
    for (const seat of RIVER_SEATS) {
      if (filter.seat && filter.seat !== "any" && seat !== filter.seat) continue;
      const hero = seat === "ip" ? ip : oop;
      const role: RiverSeating["role"] = raiser === null ? "limped" : raiser === hero ? "pfr" : "caller";
      if (filter.role && filter.role !== "any" && role !== filter.role) continue;
      out.push({ line, seat, hero, villain: seat === "ip" ? oop : ip, role });
    }
  }
  return out;
}

export const round2 = (value: number) => Math.round(value * 100) / 100;

/** A street pattern as script actions, sized against the pot; a bet too big for the stacks becomes a check. */
export function patternActs(
  pattern: StreetPattern,
  oop: ChartPosition,
  ip: ChartPosition,
  pot: number,
  behind: number,
): ScriptAct[] {
  const bet = pattern.steps.find((step) => step[1] === "bet");
  if (bet && (bet[2] ?? 0) * pot > MAX_BET_SHARE * behind) return patternActs(PATTERNS.xx, oop, ip, pot, behind);
  return pattern.steps.map(([who, type, size]) => {
    const position = who === "o" ? oop : ip;
    return type === "bet" ? { position, type, to: round2((size ?? 0) * pot) } : { position, type };
  });
}

export function drawPattern(weights: Array<[string, number]>, rng: Rng): StreetPattern {
  return PATTERNS[weights[pickWeighted(weights.map(([, w]) => w), rng)][0]];
}

/** Which flop lines a turn spot may follow (Learn L3): the flop checked through, or a bet called; any when absent. */
export type FlopLineFilter = "checked" | "bet" | "any";

/**
 * The flop pattern under a filter: `checked` is the check-through (nothing
 * drawn), `bet` one of the patterns with a bet, drawn by the same weights; no
 * filter draws as always, so an unfiltered seed deals what it always did.
 */
export function drawFlopPattern(weights: Array<[string, number]>, filter: FlopLineFilter | undefined, rng: Rng): StreetPattern {
  if (filter === "checked") return PATTERNS.xx;
  if (filter === "bet") return drawPattern(weights.filter(([id]) => id !== "xx"), rng);
  return drawPattern(weights, rng);
}

export function menuOf(solve: Pick<RiverSolve, "result">, node: number): RiverMenuItem[] {
  return solve.result.nodes[node].actions.map((action) => ({
    kind: action.kind,
    to: round2(action.to),
    amount: round2(action.amount),
    sizePot: Math.round(action.sizePot * 1000) / 1000,
  }));
}

export function shuffled(rng: Rng): number[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Per hand of the hero at the node: how often it is dealt (reach, × interest when `borderline`). */
export function riverDealingWeights(solve: Pick<RiverSolve, "result" | "hero">, node: number, bias: DealBias = "range"): Float64Array {
  const result = solve.result;
  const reach = rangesAt(result, node)[solve.hero];
  const at = result.nodes[node];
  const n = result.hands[solve.hero].length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    if (!(reach[i] > 0)) continue;
    if (bias === "borderline") {
      let max = 0;
      for (let a = 0; a < at.actions.length; a += 1) max = Math.max(max, at.strategy[a * n + i]);
      out[i] = reach[i] * (BORDERLINE_FLOOR + 1 - max);
    } else {
      out[i] = reach[i];
    }
  }
  return out;
}

/** A river solved for a seed's line, seat and board, before anything is dealt to the hero. */
export interface RiverSetup {
  line: RiverLine;
  seat: RiverSeat;
  hero: ChartPosition;
  villain: ChartPosition;
  /** Five cards. */
  board: string[];
  /** The hand through the turn, the river dealt and empty. */
  toRiver: HandScript;
  heroFirst: boolean;
  potBb: number;
  stack: number;
  villainSeat: number;
  solve: RiverSolve;
  sources: { hero: "chart" | "placeholder"; villain: "chart" | "placeholder" };
  model: string;
}

/**
 * A line, a board, flop and turn lines and the river solved from both
 * narrowed ranges: the first half of a river spot, and what the river split
 * and paint read (Learn L3). Null when the attempt does not reach a solve.
 * Draws from `rng` in the order a river spot always has, so a seed deals the
 * same spot it did before the split existed.
 */
export function riverSetup(charts: ChartSet, options: RiverSpotOptions, rng: Rng, seed: number): RiverSetup | null {
  const lines = riverLines(charts, options.pot ?? "any");
  if (lines.length === 0) return null;
  let line: RiverLine;
  let seat: RiverSeat;
  const wantSeat = filterSeat(options);
  if (options.role && options.role !== "any") {
    // A role pins who the hero is on each line: draw among the seatings that fit.
    const seatings = riverSeatings({ seat: wantSeat, role: options.role }, lines);
    if (seatings.length === 0) return null;
    const picked = pickOne(seatings, rng);
    line = picked.line;
    seat = picked.seat;
  } else {
    line = pickOne(lines, rng);
    seat = wantSeat !== "any" ? wantSeat : rng() < 0.5 ? "ip" : "oop";
  }
  const [oop, ip] = flopPlayers(line.line);
  const hero = seat === "ip" ? ip : oop;
  const villain = seat === "ip" ? oop : ip;
  const raiser = raiserOf(line.line);
  const initiative = raiser === null ? "none" : raiser === ip ? "ip" : "oop";

  const deck = shuffled(rng);
  const board = deck.slice(0, 5).map(cardCode);
  const preflop = lineActs(charts, line.line);
  const stackBb = charts.game.stackBb;
  const base: HandScript = { id: `TR${seed.toString(36)}`, hero, heroCards: null, stackBb, preflop, board };

  // Flop and turn, sized against the pot as it stands.
  const afterPre = scriptMoney(base);
  const flop = patternActs(drawPattern(PATTERN_WEIGHTS[initiative].flop, rng), oop, ip, afterPre.pot, Math.min(afterPre.behind[oop], afterPre.behind[ip]));
  const afterFlop = scriptMoney({ ...base, flop });
  const turn = patternActs(drawPattern(PATTERN_WEIGHTS[initiative].turn, rng), oop, ip, afterFlop.pot, Math.min(afterFlop.behind[oop], afterFlop.behind[ip]));
  const toRiver: HandScript = { ...base, flop, turn, river: [] };
  const money = scriptMoney(toRiver);
  const potBb = money.streetPot.river ?? 0;
  const behind = money.streetBehind.river ?? {};
  const stack = Math.min(behind[hero] ?? 0, behind[villain] ?? 0);
  if (!(potBb > 0) || !(stack > 0)) return null;

  // Both ranges as the river comes, exactly as the analysis walks them. The
  // walk records them at the river's first action (before narrowing by it),
  // so the hand it reads carries a placeholder first river action.
  const hand = scriptHand({ ...toRiver, river: [{ position: oop, type: "check" }] });
  const heroSeat = seatOf(hero);
  const villainSeat = seatOf(villain);
  const walk = walkRanges(hand, buildContext(hand), heroSeat, villainSeat, charts);
  if (!walk.ok || !walk.riverStart) return null;

  // Solve with a stand-in hero combo from the range itself (the heaviest), so
  // the solve is the one any combo of the range gets.
  let standIn = -1;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (standIn < 0 || walk.riverStart.hero[c] > walk.riverStart.hero[standIn]) standIn = c;
  }
  if (standIn < 0 || !(walk.riverStart.hero[standIn] > 0)) return null;
  const boardIdx = deck.slice(0, 5);
  const heroFirst = seat === "oop";
  const solve = solveRiverSpot({
    hand,
    heroSeat,
    villainSeat,
    heroFirst,
    heroCards: [comboHi(standIn), comboLo(standIn)],
    board: boardIdx,
    potBb,
    stackBb: stack,
    ranges: walk.riverStart,
    charts,
    model: walk.model,
    key: {
      players: 6,
      stackBucket: `${stackBb}bb`,
      preflopLine: line.pot,
      positions: heroFirst ? [hero, villain] : [villain, hero],
    },
  });
  if (!solve.ok) return null;
  return { line, seat, hero, villain, board, toRiver, heroFirst, potBb, stack, villainSeat, solve, sources: walk.sources, model: walk.model };
}

function attempt(charts: ChartSet, options: RiverSpotOptions, rng: Rng, seed: number): RiverTrainerSpot | null {
  const setup = riverSetup(charts, options, rng, seed);
  if (!setup) return null;
  const { line, seat, hero, villain, board, toRiver, heroFirst, potBb, stack, villainSeat, solve } = setup;

  // In position: the villain acts first, as the solve plays its range.
  const acts: RiverAct[] = [];
  let facing: RiverTrainerSpot["facing"] = null;
  const riverActs: ScriptAct[] = [];
  if (!heroFirst) {
    const root = solve.result.nodes[0];
    const pick = pickWeighted(facingWeights(root.actions, root.frequency, options.facing, MIN_VILLAIN_FREQ), rng);
    if (pick < 0) return null;
    const action = root.actions[pick];
    const to = round2(action.to);
    if (action.kind === "check") {
      riverActs.push({ position: villain, type: "check" });
      acts.push({ index: 0, seat: villainSeat, type: "check", to: 0, allIn: false, pot: potBb, toCall: 0, sizePot: null });
    } else {
      riverActs.push({ position: villain, type: "bet", to });
      acts.push({
        index: 0,
        seat: villainSeat,
        type: "bet",
        to,
        allIn: action.kind === "allin",
        pot: potBb,
        toCall: 0,
        sizePot: potBb > 0 ? to / potBb : null,
      });
      facing = { kind: action.kind, to, sizePot: Math.round(action.sizePot * 1000) / 1000 };
    }
  }
  const found = followLine(solve, acts);
  if (!found.ok) return null;

  // The hero's combo, from the hero's range at the node.
  const weights = riverDealingWeights(solve, found.node, options.bias ?? "range");
  const i = pickWeighted(weights, rng);
  if (i < 0) return null;
  const combo = solve.result.hands[solve.hero][i];
  const cards: [string, string] = [cardCode(comboHi(combo)), cardCode(comboLo(combo))];
  const script: HandScript = { ...toRiver, heroCards: cards, river: riverActs };
  const node = solve.result.nodes[found.node];

  return {
    kind: "river",
    seed,
    set: charts.id,
    lineId: line.id,
    pot: line.pot,
    hero,
    villain,
    seat,
    board,
    cards,
    script,
    hand: handUpTo(scriptHand(script), Number.MAX_SAFE_INTEGER),
    menu: menuOf(solve, found.node),
    potBb: round2(node.pot),
    toCallBb: round2(node.toCall),
    stackBb: round2(stack),
    facing,
    sources: setup.sources,
    model: setup.model,
    iterations: solve.result.iterations,
    exploitabilityPct: Math.round(solve.result.exploitabilityPct * 1000) / 1000,
  };
}

/**
 * Generates a river spot from `seed`. Deterministic: the same chart set,
 * options and seed give the same spot. Null when no attempt produced a spot
 * the solve reaches (rare; the caller tries another seed).
 */
export function generateRiverSpot(charts: ChartSet, options: RiverSpotOptions, seed: number): RiverTrainerSpot | null {
  const rng = seeded(seed);
  for (let tries = 0; tries < MAX_ATTEMPTS; tries += 1) {
    const spot = attempt(charts, options, rng, seed);
    if (spot) return spot;
  }
  return null;
}

/** The hero's script action for a menu item. */
function riverAct(spot: RiverTrainerSpot, item: RiverMenuItem): ScriptAct {
  const position = spot.hero;
  switch (item.kind) {
    case "fold":
      return { position, type: "fold" };
    case "check":
      return { position, type: "check" };
    case "call":
      return { position, type: "call" };
    case "bet":
      return { position, type: "bet", to: item.to };
    case "raise":
      return { position, type: "raise", to: item.to };
    default:
      // All-in: everything behind.
      return { position, type: spot.toCallBb > 0 ? "raise" : "bet", to: spot.script.stackBb };
  }
}

/** The spot's hand with the hero's answer appended, and the answer's action index. */
export function riverAnswer(spot: RiverTrainerSpot, menuIndex: number): { hand: PhfHand; actionIndex: number } {
  const item = spot.menu[menuIndex];
  if (!item) throw new RangeError(`no menu item ${menuIndex}`);
  const hand = scriptHand({ ...spot.script, river: [...(spot.script.river ?? []), riverAct(spot, item)] });
  const decision = lastHeroDecision(hand);
  if (!decision || decision.street !== "river") throw new RangeError("the answer did not parse as a hero river decision");
  return { hand, actionIndex: decision.index };
}
