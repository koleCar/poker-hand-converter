/**
 * The turn spot trainer (Learn L1): a heads-up turn, solved on demand by the
 * analysis' own turn solve (A5a), the hero dealt a combo from their range at
 * the node, the answer graded exactly as the analysis grades a real hand's
 * turn there.
 *
 * The river trainer's twin (`river.ts`), one street earlier:
 *
 * ```
 * a preflop line from the charts ─▶ a random four-card board ─▶ a flop line from the common patterns
 *   ─▶ the hand as text ─▶ walkRanges: both ranges narrowed through the flop (narrowing.ts)
 *   ─▶ solveTurnSpot (A5a's tree: 75% + all-in, through a coarse river)
 *   ─▶ in position: the villain's first turn action drawn from the solve (or only a check, `facing`)
 *   ─▶ the hero's combo drawn from the hero's range at the node
 * answer ─▶ the hand plus the hero's action ─▶ gradeAnswer(…, { turn: true })
 * ```
 *
 * **The solve the hero sees is the one that grades.** The walk does not read
 * the hero's cards; the turn solve adds the hero's combo only when it is not
 * in the range; and it adds a bet size to the tree only for a bet the hand
 * played off the menu, which an answer from the menu never is. So
 * `analyzeHand` on the finished hand re-runs the same walk and the same solve
 * and lands on the same node.
 *
 * A turn solve takes about a second (wide single-raised ranges: several), and
 * grading solves it again (twice when the sensitivity check runs): the screen
 * says "solving" and the work is in the trainer's worker.
 */

import type { ChartPosition, ChartSet } from "../charts";
import { followTurnLine, solveTurnSpot, streetActs, walkRanges, type TurnSolve } from "../analysis";
import { cardCode } from "../equity/evaluator";
import type { PhfHand } from "../phf/types";
import { comboHi, comboLo, NUM_COMBOS } from "../solver";
import { buildContext } from "../stats/context";
import { handUpTo, lastHeroDecision, scriptHand, scriptMoney, seatOf, type HandScript, type ScriptAct } from "./handText";
import { lineActs, type DealBias } from "./preflop";
import {
  MAX_ATTEMPTS,
  MIN_VILLAIN_FREQ,
  PATTERN_WEIGHTS,
  drawPattern,
  facingWeights,
  filterSeat,
  flopPlayers,
  menuOf,
  patternActs,
  raiserOf,
  riverDealingWeights,
  riverLines,
  riverSeatings,
  round2,
  shuffled,
  type RiverLine,
  type RiverMenuItem,
  type RiverPot,
  type RiverRole,
  type RiverSeat,
} from "./river";
import { pickOne, pickWeighted, seeded, type Rng } from "./rng";

export interface TurnSpotOptions {
  pot?: RiverPot | "any";
  seat?: RiverSeat | "any";
  role?: RiverRole | "any";
  bias?: DealBias;
  /** In position: only spots where the villain checked or bet first. Asking makes the hero the in-position player. */
  facing?: "check" | "bet" | "any";
}

export interface TurnTrainerSpot {
  kind: "turn";
  seed: number;
  set: string;
  lineId: string;
  pot: RiverPot;
  hero: ChartPosition;
  villain: ChartPosition;
  seat: RiverSeat;
  /** Four cards. */
  board: string[];
  cards: [string, string];
  script: HandScript;
  /** The hand up to the hero's turn decision. */
  hand: PhfHand;
  menu: RiverMenuItem[];
  potBb: number;
  toCallBb: number;
  /** Effective stack at the start of the turn, bb. */
  stackBb: number;
  facing: { kind: RiverMenuItem["kind"]; to: number; sizePot: number } | null;
  sources: { hero: "chart" | "placeholder"; villain: "chart" | "placeholder" };
  model: string;
  iterations: number;
  exploitabilityPct: number;
}

/** A turn solved for a seed's line, seat and board, before anything is dealt to the hero. */
export interface TurnSetup {
  line: RiverLine;
  seat: RiverSeat;
  hero: ChartPosition;
  villain: ChartPosition;
  /** Four cards. */
  board: string[];
  /** The hand through the flop, the turn dealt and empty. */
  toTurn: HandScript;
  heroFirst: boolean;
  stack: number;
  solve: TurnSolve;
  sources: { hero: "chart" | "placeholder"; villain: "chart" | "placeholder" };
  model: string;
}

/**
 * A line, a board, a flop line and the turn solved from both narrowed ranges:
 * the first half of a turn spot, and what the split exercise reads by
 * category (Learn L2). Null when the attempt does not reach a solve.
 */
export function turnSetup(charts: ChartSet, options: TurnSpotOptions, rng: Rng, seed: number): TurnSetup | null {
  const lines = riverLines(charts, options.pot ?? "any");
  if (lines.length === 0) return null;
  const wantSeat = filterSeat(options);
  let line: RiverLine;
  let seat: RiverSeat;
  if (options.role && options.role !== "any") {
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
  const boardIdx = deck.slice(0, 4);
  const board = boardIdx.map(cardCode);
  const preflop = lineActs(charts, line.line);
  const stackBb = charts.game.stackBb;
  const base: HandScript = { id: `TT${seed.toString(36)}`, hero, heroCards: null, stackBb, preflop, board };

  const afterPre = scriptMoney(base);
  const flop = patternActs(drawPattern(PATTERN_WEIGHTS[initiative].flop, rng), oop, ip, afterPre.pot, Math.min(afterPre.behind[oop], afterPre.behind[ip]));
  const toTurn: HandScript = { ...base, flop, turn: [] };
  const money = scriptMoney(toTurn);
  const potBb = money.streetPot.turn ?? 0;
  const behind = money.streetBehind.turn ?? {};
  const stack = Math.min(behind[hero] ?? 0, behind[villain] ?? 0);
  if (!(potBb > 0) || !(stack > 0)) return null;

  // Both ranges as the turn comes; the walk records them at the turn's first
  // action, so the hand it reads carries a placeholder one.
  const walked = scriptHand({ ...toTurn, turn: [{ position: oop, type: "check" }] });
  const heroSeat = seatOf(hero);
  const villainSeat = seatOf(villain);
  const walk = walkRanges(walked, buildContext(walked), heroSeat, villainSeat, charts);
  if (!walk.ok || !walk.turnStart) return null;

  let standIn = -1;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (standIn < 0 || walk.turnStart.hero[c] > walk.turnStart.hero[standIn]) standIn = c;
  }
  if (standIn < 0 || !(walk.turnStart.hero[standIn] > 0)) return null;
  const heroFirst = seat === "oop";
  const solve = solveTurnSpot({
    hand: walked,
    heroSeat,
    villainSeat,
    heroFirst,
    heroCards: [comboHi(standIn), comboLo(standIn)],
    board: boardIdx,
    potBb,
    stackBb: stack,
    ranges: walk.turnStart,
    charts,
    model: walk.model,
    // The villain's check carries no size; the hero's answer adds the act the grade re-reads.
    acts: [],
    key: {
      players: 6,
      stackBucket: `${stackBb}bb`,
      preflopLine: line.pot,
      positions: heroFirst ? [hero, villain] : [villain, hero],
    },
  });
  if (!solve.ok) return null;
  return { line, seat, hero, villain, board, toTurn, heroFirst, stack, solve, sources: walk.sources, model: walk.model };
}

function attempt(charts: ChartSet, options: TurnSpotOptions, rng: Rng, seed: number): TurnTrainerSpot | null {
  const setup = turnSetup(charts, options, rng, seed);
  if (!setup) return null;
  const { line, seat, hero, villain, board, toTurn, heroFirst, stack, solve } = setup;

  let facing: TurnTrainerSpot["facing"] = null;
  const turnActs: ScriptAct[] = [];
  if (!heroFirst) {
    const root = solve.result.nodes[0];
    const pick = pickWeighted(facingWeights(root.actions, root.frequency, options.facing, MIN_VILLAIN_FREQ), rng);
    if (pick < 0) return null;
    const action = root.actions[pick];
    const to = round2(action.to);
    if (action.kind === "check") {
      turnActs.push({ position: villain, type: "check" });
    } else {
      turnActs.push({ position: villain, type: "bet", to });
      facing = { kind: action.kind, to, sizePot: Math.round(action.sizePot * 1000) / 1000 };
    }
  }
  const script0: HandScript = { ...toTurn, turn: turnActs };
  const hand0 = scriptHand(script0);
  const found = followTurnLine(solve, streetActs(hand0, "turn"));
  if (!found.ok) return null;

  const weights = riverDealingWeights(solve, found.node, options.bias ?? "range");
  const i = pickWeighted(weights, rng);
  if (i < 0) return null;
  const combo = solve.result.hands[solve.hero][i];
  const cards: [string, string] = [cardCode(comboHi(combo)), cardCode(comboLo(combo))];
  const script: HandScript = { ...script0, heroCards: cards };
  const node = solve.result.nodes[found.node];

  return {
    kind: "turn",
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

/** A turn spot for `seed`, or null when no attempt produced one. Deterministic. */
export function generateTurnSpot(charts: ChartSet, options: TurnSpotOptions, seed: number): TurnTrainerSpot | null {
  const rng = seeded(seed);
  for (let tries = 0; tries < MAX_ATTEMPTS; tries += 1) {
    const spot = attempt(charts, options, rng, seed);
    if (spot) return spot;
  }
  return null;
}

function turnAct(spot: TurnTrainerSpot, item: RiverMenuItem): ScriptAct {
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
      return { position, type: spot.toCallBb > 0 ? "raise" : "bet", to: spot.script.stackBb };
  }
}

/** The spot's hand with the hero's answer appended, and the answer's action index. */
export function turnAnswer(spot: TurnTrainerSpot, menuIndex: number): { hand: PhfHand; actionIndex: number } {
  const item = spot.menu[menuIndex];
  if (!item) throw new RangeError(`no menu item ${menuIndex}`);
  const hand = scriptHand({ ...spot.script, turn: [...(spot.script.turn ?? []), turnAct(spot, item)] });
  const decision = lastHeroDecision(hand);
  if (!decision || decision.street !== "turn") throw new RangeError("the answer did not parse as a hero turn decision");
  return { hand, actionIndex: decision.index };
}
