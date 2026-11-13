/**
 * Playing a whole hand in the Trainer (T2, `docs/TRAINER.md` §4): the hero
 * against one opponent, from preflop or from the flop to the showdown, every
 * hero decision graded and every opponent decision played by the reference.
 *
 * **The analysis is the oracle for both seats.** At a hero decision the
 * menu is the analysis' own options for the hero's hand there (the hand with
 * a stand-in answer, `only` that decision), and the answer is graded by the
 * analysis on the hand with the answer appended - the trainer's one grader.
 * At an opponent decision the same analysis runs from the opponent's seat
 * with the opponent's cards, and the opponent's move is drawn from its
 * frequencies for that exact hand: the opponent plays the strategy that
 * grades the hero. Where the analysis has no answer for the opponent (off
 * the reference), it checks or calls; where it has none for the hero, the
 * hand stops there and says so.
 *
 * ```
 * start ─▶ (preflop: a chart spot, the opponent the line's raiser or a seat behind;
 *           flop: a library line and flop, both hands drawn from their preflop ranges)
 *   ─▶ advance: whoever is to act - the opponent from the reference, anyone else folds -
 *      streets dealt from the five cards drawn at the start, until the hero is to act
 *   ─▶ decision (menu) ─▶ answer graded ─▶ advance … ─▶ over (a fold or the showdown)
 * ```
 *
 * Pure and deterministic given the state's seed, apart from the flop
 * library's chunks: an analysis that asks for a chunk not loaded yet is run
 * again once it is ({@link analyse}).
 */

import {
  analyzeHand,
  opponentRanges,
  walkRanges,
  type DecisionAnalysis,
  type FlopLibrary,
  type OptionAnalysis,
} from "../analysis";
import type { ChartPosition, ChartSet } from "../charts";
import { cardCode, cardIndex, evaluate } from "../equity/evaluator";
import type { PhfHand } from "../phf/types";
import { COMBO_CLASS, comboHi, comboLo, NUM_COMBOS, flopCards, permuteCard, SUIT_PERMUTATIONS } from "../solver";
import { buildContext } from "../stats/context";
import { planFlop, type FlopSpotOptions } from "./flop";
import {
  completePreflop,
  handUpTo,
  lastHeroDecision,
  POSTFLOP_ORDER,
  SCRIPT_POSITIONS,
  scriptHand,
  scriptMoney,
  seatOf,
  type HandScript,
  type ScriptAct,
  type ScriptPosition,
} from "./handText";
import { dealPreflop, lineAggressor, lineActs, trainerSet, type PreflopFamily, type PreflopSpotOptions } from "./preflop";
import { decisionRange, type RangeView } from "./rangeView";
import { scriptSeats } from "./river";
import { pickOne, pickWeighted, seeded, type Rng } from "./rng";

export type PlayStreet = "preflop" | "flop" | "turn" | "river";
const STREETS: readonly PlayStreet[] = ["preflop", "flop", "turn", "river"];
const BOARD_AT: Record<PlayStreet, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

/** The preflop families a whole hand starts from: heads-up lines (no caller in front, no limpers). */
export const PLAY_FAMILIES: readonly PreflopFamily[] = ["rfi", "vs-open", "vs-3bet", "bvb", "vs-4bet"];

export interface PlayOptions {
  start: "preflop" | "flop";
  preflop: PreflopSpotOptions;
  flop: FlopSpotOptions;
}

export interface PlayState {
  seed: number;
  /** Advances taken: each draws from its own generator, so a state replays. */
  steps: number;
  /** The chart set the hand is played at. */
  set: string;
  hero: ChartPosition;
  villain: ChartPosition;
  heroCards: [string, string];
  villainCards: [string, string];
  /** The five board cards, drawn at the start; the script holds the ones dealt. */
  runout: string[];
  /** The hand so far, as the hero sees it (the board as dealt). */
  script: HandScript;
  /** The opponent played off the reference somewhere (it checked or called by default). */
  approximate: boolean;
}

export interface PlayDecision {
  street: PlayStreet;
  /** The hand up to the hero's decision, as the hero sees it. */
  hand: PhfHand;
  cards: [string, string];
  board: string[];
  /** The analysis' options for the hero's hand here: the answer buttons. */
  menu: OptionAnalysis[];
  potBb: number;
  toCallBb: number;
}

export interface PlayOver {
  reason: "fold" | "showdown" | "no-reference";
  winner: "hero" | "villain" | "split" | null;
  /** The hero's result over the hand, bb. */
  heroNetBb: number;
  potBb: number;
  /** The whole hand as played, for the table at the end. */
  hand: PhfHand;
  board: string[];
  /** Shown at a showdown. */
  villainCards: [string, string] | null;
}

export interface PlayStep {
  state: PlayState;
  decision: PlayDecision | null;
  over: PlayOver | null;
}

/** What the engine needs of the flop library: the reader, and loading a chunk it asked for. */
export interface PlayLibrary {
  library: FlopLibrary;
  ready(set: string): Promise<boolean>;
  load(set: string, line: string, flop: string): Promise<unknown>;
}

/* --------------------------------------------------------- the oracle - */

/**
 * One decision analysed (`only`), with the flop library's chunk loaded when
 * the analysis wants one: run once reading through a recorder, load what it
 * asked for and did not have, run again. A chunk that cannot be loaded
 * leaves the first answer (the flop read by the heuristic, or not graded).
 */
export async function analyse(
  hand: PhfHand,
  actionIndex: number,
  charts: ChartSet,
  street: PlayStreet,
  library: PlayLibrary | null,
): Promise<DecisionAnalysis | null> {
  const run = (flopLibrary: FlopLibrary | null) =>
    analyzeHand(structuredClone(hand), {
      charts,
      only: actionIndex,
      // A turn decision is graded by the turn solve (A5a); the river is narrowed through the turn by the
      // heuristic, as the river trainer's is - one solve per decision, not two.
      turn: street === "turn",
      flopLibrary,
    }).decisions.find((d) => d.actionIndex === actionIndex) ?? null;
  if (!library || street === "preflop") return run(library?.library ?? null);
  const asked: Array<[string, string, string]> = [];
  const lib = library.library;
  const recorder: FlopLibrary = {
    tree: lib.tree,
    has: (set, line, flop) => lib.has(set, line, flop),
    get: (set, line, flop) => {
      const chunk = lib.get(set, line, flop);
      if (!chunk && lib.has(set, line, flop)) asked.push([set, line, flop]);
      return chunk;
    },
  };
  const first = run(recorder);
  if (asked.length === 0) return first;
  await Promise.all(asked.map(([set, line, flop]) => library.load(set, line, flop).catch(() => undefined)));
  return run(lib);
}

/* ------------------------------------------------------- the betting - */

const seatsOf = (script: HandScript): readonly ScriptPosition[] => script.seats ?? SCRIPT_POSITIONS;

/** The street the script is on: the last one dealt. */
export function streetOf(script: HandScript): PlayStreet {
  if (script.river) return "river";
  if (script.turn) return "turn";
  if (script.flop) return "flop";
  return "preflop";
}

function actsOf(script: HandScript, street: PlayStreet): readonly ScriptAct[] {
  return street === "preflop" ? script.preflop : (script[street] ?? []);
}

function withAct(script: HandScript, street: PlayStreet, act: ScriptAct): HandScript {
  if (street === "preflop") return { ...script, preflop: [...script.preflop, act] };
  return { ...script, [street]: [...(script[street] ?? []), act] };
}

/** The order of play on a street: preflop the table's order, after it from the small blind (heads-up the big blind first). */
function orderOf(script: HandScript, street: PlayStreet): ScriptPosition[] {
  const seats = [...seatsOf(script)];
  if (street === "preflop") return seats;
  if (seats.length === 2) return ["BB", "SB"].filter((p) => seats.includes(p as ScriptPosition)) as ScriptPosition[];
  const known = POSTFLOP_ORDER.filter((p) => seats.includes(p));
  if (known.length === seats.length) return [...known];
  const sb = seats.indexOf("SB");
  return sb < 0 ? seats : [...seats.slice(sb), ...seats.slice(0, sb)];
}

/** Who is to act now on the script's street, or null when its betting is closed. */
export function toAct(script: HandScript): ScriptPosition | null {
  const street = streetOf(script);
  const money = scriptMoney(script);
  const order = orderOf(script, street);
  const acts = actsOf(script, street);
  const folded = new Set(money.folded);
  if (order.filter((p) => !folded.has(p)).length <= 1) return null;
  let lastAggression = -1;
  acts.forEach((act, i) => {
    if (act.type === "bet" || act.type === "raise") lastAggression = i;
  });
  const actedSince = new Set(acts.slice(Math.max(0, lastAggression)).map((act) => act.position));
  const needs = (p: ScriptPosition) =>
    !folded.has(p) && (money.behind[p] ?? 0) > 0.0001 && ((money.streetTotal[p] ?? 0) < money.high - 0.0001 || !actedSince.has(p));
  const last = acts.length > 0 ? acts[acts.length - 1].position : null;
  const from = last === null ? 0 : order.indexOf(last) + 1;
  for (let k = 0; k < order.length; k += 1) {
    const p = order[(from + k) % order.length];
    if (needs(p)) return p;
  }
  return null;
}

/** The act an option is, for the player making it. */
export function optionAct(script: HandScript, position: ScriptPosition, option: OptionAnalysis): ScriptAct {
  if (option.action === "fold" || option.action === "check" || option.action === "call") return { position, type: option.action };
  const money = scriptMoney(script);
  const to = option.allIn || option.sizeBb === undefined ? (money.streetTotal[position] ?? 0) + (money.behind[position] ?? 0) : option.sizeBb;
  return { position, type: option.action, to: Math.round(to * 100) / 100 };
}

/** A stand-in answer for the analysis: a fold facing a bet, a check otherwise. */
function standIn(script: HandScript, position: ScriptPosition): ScriptAct {
  const money = scriptMoney(script);
  return { position, type: (money.streetTotal[position] ?? 0) < money.high - 0.0001 ? "fold" : "check" };
}

/** The hand an analysis reads for `position`'s decision with `act`: that seat as the hero, its cards dealt. */
function decisionHand(state: PlayState, position: ScriptPosition, act: ScriptAct): { hand: PhfHand; index: number } {
  const own: HandScript =
    position === state.hero ? state.script : { ...state.script, hero: state.villain, heroCards: state.villainCards };
  const street = streetOf(own);
  const appended = withAct(own, street, act);
  // Preflop the players behind must be dealt in (`completePreflop`): they act once after the decision.
  const hand = scriptHand(street === "preflop" ? completePreflop(appended) : appended);
  const decision = lastHeroDecision(hand);
  if (!decision) throw new RangeError("the decision did not parse");
  return { hand, index: decision.index };
}

/* ---------------------------------------------------------- dealing - */

function cardsOf(combo: number): [string, string] {
  return [cardCode(comboHi(combo)), cardCode(comboLo(combo))];
}

/** A combo drawn from per-combo weights, none touching `dead`. */
function drawCombo(weights: (combo: number) => number, dead: ReadonlySet<number>, rng: Rng): number {
  const w = new Float64Array(NUM_COMBOS);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (dead.has(comboHi(c)) || dead.has(comboLo(c))) continue;
    w[c] = Math.max(0, weights(c));
  }
  return pickWeighted(w, rng);
}

function restOfDeck(dead: ReadonlySet<number>, rng: Rng, count: number): string[] {
  const deck: number[] = [];
  for (let i = 0; i < 52; i += 1) if (!dead.has(i)) deck.push(i);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.slice(0, count).map(cardCode);
}

/** The seats behind `hero` preflop that could still play the hand (the opponent of a first-in spot). */
function seatsBehind(seats: readonly ScriptPosition[], hero: ScriptPosition): ScriptPosition[] {
  const i = seats.indexOf(hero);
  return i < 0 ? [] : seats.slice(i + 1);
}

/** A hand from preflop: a chart spot for the hero, the opponent the line's raiser (first in: a seat behind). */
function startPreflop(charts: ChartSet, options: PreflopSpotOptions, seed: number): PlayState | null {
  const rng = seeded(seed ^ 0x5bd1e995);
  const family = options.family === "random" ? pickOne(PLAY_FAMILIES, rng) : options.family;
  if (!PLAY_FAMILIES.includes(family)) return null;
  const spot = dealPreflop(charts, { ...options, family }, seed);
  if (!spot) return null;
  const set = trainerSet(charts, spot.set);
  const seats = seatsOf(spot.script);
  let villain: ChartPosition | null;
  if (family === "rfi") {
    const behind = seatsBehind(seats, spot.hero);
    villain = options.vs && behind.includes(options.vs) ? options.vs : behind.length > 0 ? pickOne(behind, rng) : null;
  } else {
    villain = lineAggressor(spot.line, set.game.positions);
  }
  if (!villain || villain === spot.hero) return null;
  const dead = new Set(spot.cards.map(cardIndex));
  // The opponent's cards from its range after its own actions on the line (no action yet: any two).
  const range = opponentRanges(set, spot.line).find((r) => r.position === villain);
  const combo = drawCombo((c) => (range ? range.weights[COMBO_CLASS[c]] : 1), dead, rng);
  if (combo < 0) return null;
  const villainCards = cardsOf(combo);
  for (const card of villainCards) dead.add(cardIndex(card));
  return {
    seed,
    steps: 0,
    set: set.id,
    hero: spot.hero,
    villain,
    heroCards: spot.cards,
    villainCards,
    runout: restOfDeck(dead, rng, 5),
    script: { ...spot.script, id: `TP${seed.toString(36)}` },
    approximate: false,
  };
}

/** A hand from the flop: a library line and flop, both hands drawn from their preflop ranges. */
function startFlop(charts: ChartSet, library: FlopLibrary, options: FlopSpotOptions, seed: number): PlayState | null {
  const rng = seeded(seed ^ 0x27d4eb2f);
  const set = trainerSet(charts, options.set);
  const plan = planFlop(set, library, options, rng);
  if (!plan) return null;
  const perm = pickOne(SUIT_PERMUTATIONS, rng);
  const flop = flopCards(plan.flop).map((code) => cardCode(permuteCard(cardIndex(code), perm)));
  const preflop = lineActs(set, plan.line.line);
  const base: HandScript = { id: `TP${seed.toString(36)}`, hero: plan.hero, heroCards: null, ...scriptSeats(plan.line), stackBb: set.game.stackBb, preflop };
  const seats = seatsOf(base);
  // Both preflop ranges, read by the analysis' own walk (a stand-in flop check makes the hand reach it).
  const [oop] = orderOf(base, "flop").filter((p) => p === plan.hero || p === plan.villain);
  const walked = scriptHand({ ...base, board: flop, flop: [{ position: oop, type: "check" }] });
  const walk = walkRanges(walked, buildContext(walked), seatOf(plan.hero, seats), seatOf(plan.villain, seats), charts);
  if (!walk.ok) return null;
  const dead = new Set(flop.map(cardIndex));
  const heroCombo = drawCombo((c) => walk.preflop.hero[c], dead, rng);
  if (heroCombo < 0) return null;
  const heroCards = cardsOf(heroCombo);
  for (const card of heroCards) dead.add(cardIndex(card));
  const villainCombo = drawCombo((c) => walk.preflop.villain[c], dead, rng);
  if (villainCombo < 0) return null;
  const villainCards = cardsOf(villainCombo);
  for (const card of villainCards) dead.add(cardIndex(card));
  const runout = [...flop, ...restOfDeck(dead, rng, 2)];
  return {
    seed,
    steps: 0,
    set: set.id,
    hero: plan.hero,
    villain: plan.villain,
    heroCards,
    villainCards,
    runout,
    script: { ...base, heroCards, board: flop, flop: [] },
    approximate: false,
  };
}

/* ---------------------------------------------------------- playing - */

/** The next street dealt: its cards from the runout, its betting empty. */
function dealNext(state: PlayState): PlayState {
  const next = STREETS[STREETS.indexOf(streetOf(state.script)) + 1] as Exclude<PlayStreet, "preflop">;
  return { ...state, script: { ...state.script, board: state.runout.slice(0, BOARD_AT[next]), [next]: [] } };
}

function contributed(script: HandScript, position: ScriptPosition): number {
  return script.stackBb - (scriptMoney(script).behind[position] ?? script.stackBb);
}

function finish(state: PlayState, reason: PlayOver["reason"]): PlayStep {
  const money = scriptMoney(state.script);
  const folded = new Set(money.folded);
  const potBb = Math.round(money.pot * 100) / 100;
  const heroIn = contributed(state.script, state.hero);
  let winner: PlayOver["winner"] = null;
  if (reason === "fold") winner = folded.has(state.hero) ? "villain" : "hero";
  else if (reason === "showdown") {
    const board = state.runout.slice(0, 5);
    const hero = evaluate([...state.heroCards, ...board]);
    const villain = evaluate([...state.villainCards, ...board]);
    winner = hero > villain ? "hero" : villain > hero ? "villain" : "split";
  }
  const won = winner === "hero" ? potBb : winner === "split" ? potBb / 2 : 0;
  const shown = reason === "showdown";
  const full = shown ? { ...state.script, board: state.runout.slice(0, 5) } : state.script;
  const hand = handUpTo(scriptHand(full), Number.MAX_SAFE_INTEGER);
  return {
    state,
    decision: null,
    over: {
      reason,
      winner,
      heroNetBb: reason === "no-reference" ? 0 : Math.round((won - heroIn) * 100) / 100,
      potBb,
      hand,
      board: shown ? state.runout.slice(0, 5) : (state.script.board ?? []).slice(),
      villainCards: shown ? state.villainCards : null,
    },
  };
}

/**
 * Plays on until the hero is to act or the hand is over: the opponent from
 * the reference, anyone else folding, the next street dealt when a street's
 * betting closes, the board run out when the players are all in.
 */
export async function advance(start: PlayState, charts: ChartSet, library: PlayLibrary | null): Promise<PlayStep> {
  let state = { ...start, steps: start.steps + 1 };
  const rng = seeded((state.seed ^ Math.imul(state.steps, 0x9e3779b1)) >>> 0);
  for (let guard = 0; guard < 60; guard += 1) {
    const street = streetOf(state.script);
    const money = scriptMoney(state.script);
    const folded = new Set(money.folded);
    if (folded.has(state.hero) || folded.has(state.villain)) return finish(state, "fold");
    const actor = toAct(state.script);
    if (actor === null) {
      if (street === "river") return finish(state, "showdown");
      // Everyone but one all in: the board runs out.
      const canBet = [state.hero, state.villain].filter((p) => (money.behind[p] ?? 0) > 0.0001);
      if (canBet.length <= 1) {
        while (streetOf(state.script) !== "river") state = dealNext(state);
        return finish(state, "showdown");
      }
      state = dealNext(state);
      continue;
    }
    if (actor === state.hero) {
      const probe = decisionHand(state, state.hero, standIn(state.script, state.hero));
      const decision = await analyse(probe.hand, probe.index, charts, street, library);
      if (!decision || decision.status !== "analysed" || decision.options.length === 0) return finish(state, "no-reference");
      return {
        state,
        decision: {
          street,
          hand: handUpTo(probe.hand, probe.index),
          cards: state.heroCards,
          board: (state.script.board ?? []).slice(),
          menu: decision.options,
          potBb: Math.round(decision.facts.potBb * 100) / 100,
          toCallBb: Math.round(decision.facts.toCallBb * 100) / 100,
        },
        over: null,
      };
    }
    if (actor !== state.villain) {
      // Hero against one opponent: everyone else lets the hand go.
      state = { ...state, script: withAct(state.script, street, standIn(state.script, actor)) };
      continue;
    }
    const probe = decisionHand(state, state.villain, standIn(state.script, state.villain));
    const decision = await analyse(probe.hand, probe.index, charts, street, library);
    let act: ScriptAct;
    if (decision && decision.status === "analysed" && decision.options.length > 0) {
      const pick = pickWeighted(
        decision.options.map((o) => o.freq),
        rng,
      );
      act = optionAct(state.script, state.villain, decision.options[Math.max(0, pick)]);
    } else {
      // Off the reference: the opponent checks, or calls.
      const facing = (money.streetTotal[state.villain] ?? 0) < money.high - 0.0001;
      act = { position: state.villain, type: facing ? "call" : "check" };
      state = { ...state, approximate: true };
    }
    state = { ...state, script: withAct(state.script, street, act) };
  }
  return finish(state, "no-reference");
}

/** A new hand for `seed`, played on to the hero's first decision; null when the options deal none. */
export async function startHand(options: PlayOptions, charts: ChartSet, library: PlayLibrary | null, seed: number): Promise<PlayStep | null> {
  let state: PlayState | null;
  if (options.start === "flop") {
    if (!library) return null;
    await library.ready(trainerSet(charts, options.flop.set).id);
    state = startFlop(charts, library.library, options.flop, seed);
  } else {
    state = startPreflop(charts, options.preflop, seed);
    if (state && library) await library.ready(state.set);
  }
  if (!state) return null;
  return advance(state, charts, library);
}

/** The hero's answer: the hand with it appended, graded by the analysis. */
export async function gradePlay(
  step: PlayStep,
  menuIndex: number,
  charts: ChartSet,
  library: PlayLibrary | null,
): Promise<{ hand: PhfHand; actionIndex: number; decision: DecisionAnalysis | null }> {
  const { state, decision } = step;
  if (!decision) throw new RangeError("the hand is over");
  const option = decision.menu[menuIndex];
  if (!option) throw new RangeError(`no option ${menuIndex}`);
  const act = optionAct(state.script, state.hero, option);
  const { hand, index } = decisionHand(state, state.hero, act);
  if (library) await library.ready(state.set);
  return { hand, actionIndex: index, decision: await analyse(hand, index, charts, decision.street, library) };
}

/** The hero's answer played: appended, then on to the next decision or the end. */
export async function answerPlay(step: PlayStep, menuIndex: number, charts: ChartSet, library: PlayLibrary | null): Promise<PlayStep> {
  const { state, decision } = step;
  if (!decision) throw new RangeError("the hand is over");
  const option = decision.menu[menuIndex];
  if (!option) throw new RangeError(`no option ${menuIndex}`);
  const street = streetOf(state.script);
  const next = { ...state, script: withAct(state.script, street, optionAct(state.script, state.hero, option)) };
  if (library) await library.ready(state.set);
  return advance(next, charts, library);
}

/** The hero's range at the hand's current decision (the range panel, T3). */
export async function playRange(step: PlayStep, charts: ChartSet, library: PlayLibrary | null): Promise<RangeView | null> {
  const { state, decision } = step;
  if (!decision) return null;
  const probe = decisionHand(state, state.hero, standIn(state.script, state.hero));
  if (library) await library.ready(state.set);
  // Preflop the chart node the analysis read; after it the street's study (its chunk loaded first).
  const analysed = await analyse(probe.hand, probe.index, charts, decision.street, library);
  return decisionRange(probe.hand, probe.index, decision.street, charts, library?.library ?? null, analysed);
}
