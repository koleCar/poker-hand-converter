/**
 * The flop spot trainer (Learn L2): a heads-up flop from Rail's flop library
 * (A5b), the hero dealt a combo from their range at the node, the answer
 * graded exactly as the analysis grades a real hand's flop there.
 *
 * ```
 * a line of FLOP_LINES and a flop the library holds (`flopPlan`)
 *   ─▶ the chunk, with its suits relabelled at random (the same canonical flop: exact, never mapped)
 *   ─▶ the line's flop actions before the hero's decision, drawn from the solve's own frequencies (`heroNode`)
 *   ─▶ the hero's combo drawn from the hero's range at the node
 * answer ─▶ the hand plus the hero's action ─▶ gradeAnswer(…, { flopLibrary }) — analyzeHand reads the same chunk
 * ```
 *
 * **The solve the hero sees is the one that grades.** The spot's preflop is
 * the chart line the chunk was solved from, at the chart's own sizes and
 * 100bb, so the hand reads the same chunk combo for combo (`flop-mapped`
 * never applies), its pot is the solved pot and its flop sizes are the
 * tree's own: `analyzeHand` lands on the node the hero was dealt at.
 *
 * Pure and synchronous: the library is handed in with the chunk already
 * loaded. The worker loads it first (`flopChunkFor`, then
 * `FlopLibraryLoader.load`).
 */

import type { ChartPosition, ChartSet } from "../charts";
import { chartLineOf, FLOP_LINES, LIBRARY_MODEL, type FlopLibrary, type FlopLine } from "../analysis";
import { cardCode, cardIndex } from "../equity/evaluator";
import type { PhfHand } from "../phf/types";
import {
  comboHi,
  comboLo,
  FLOP_REPRESENTATIVES,
  flopCards,
  permuteCard,
  rangesAt,
  SUIT_PERMUTATIONS,
  type ActionInfo,
  type FlopChunk,
  type SolveResult,
} from "../solver";
import { handUpTo, lastHeroDecision, scriptHand, seatOf, type HandScript, type ScriptAct } from "./handText";
import { lineActs, type DealBias } from "./preflop";
import {
  MAX_ATTEMPTS,
  MIN_VILLAIN_FREQ,
  flopPlayers,
  menuOf,
  riverDealingWeights,
  riverSeatings,
  round2,
  type RiverLine,
  type RiverMenuItem,
  type RiverPot,
  type RiverRole,
  type RiverSeat,
} from "./river";
import { pickOne, pickWeighted, seeded, type Rng } from "./rng";

/**
 * What the hero faces at the node:
 * - `check`: in position, the opponent checked;
 * - `bet`: a bet to answer (in position: a lead; out of position: a bet after the hero's check);
 * - `raise`: the hero bet and was raised;
 * - `any` (or absent): the hero's first flop decision.
 */
export type FlopFacing = "check" | "bet" | "raise" | "any";

export interface FlopSpotOptions {
  pot?: RiverPot | "any";
  seat?: RiverSeat | "any";
  role?: RiverRole | "any";
  facing?: FlopFacing;
  /** One line of `FLOP_LINES` by id (`btn-bb`); any that fits when absent. */
  line?: string;
  bias?: DealBias;
}

export interface FlopTrainerSpot {
  kind: "flop";
  seed: number;
  set: string;
  lineId: string;
  pot: RiverPot;
  hero: ChartPosition;
  villain: ChartPosition;
  seat: RiverSeat;
  /** Three cards, in the spot's own suits. */
  board: string[];
  /** The library's canonical flop the spot was dealt on (its chunk). */
  flop: string;
  cards: [string, string];
  script: HandScript;
  /** The hand up to the hero's flop decision. */
  hand: PhfHand;
  menu: RiverMenuItem[];
  potBb: number;
  toCallBb: number;
  /** Effective stack at the start of the flop, bb. */
  stackBb: number;
  facing: { kind: RiverMenuItem["kind"]; to: number; sizePot: number } | null;
  /** The node's path in the solve (`X-B1.8`). */
  path: string;
  sources: { hero: "chart"; villain: "chart" };
  model: string;
  iterations: number;
  exploitabilityPct: number;
}

/* ------------------------------------------------------------ the plan - */

const asRiverLine = (line: FlopLine): RiverLine => ({ id: line.id, pot: line.pot, line: line.key });

/** The seat a flop filter pins: facing a check is in position by definition. */
export function flopFilterSeat(options: Pick<FlopSpotOptions, "seat" | "facing">): RiverSeat | "any" {
  if (options.facing === "check") return "ip";
  return options.seat ?? "any";
}

const readable = new Map<string, boolean>();

/**
 * Whether a real hand on this line reads the library, as the analysis
 * places it (`chartLineOf` on a scripted hand gives the line's own key). A
 * drill is only dealt where the analysis would grade the same hand from the
 * library: since A5b, `btn-sb` is placed as `fffrc` (the big blind's fold
 * after the small blind's call is not part of either flop player's line), so
 * its chunks are never read and it is left out.
 */
export function analysisReadsLine(charts: ChartSet, line: FlopLine): boolean {
  const key = `${charts.id}:${charts.model.hash}:${line.id}`;
  let ok = readable.get(key);
  if (ok === undefined) {
    try {
      const [oop, ip] = flopPlayers(line.key);
      const hand = scriptHand({ id: "LINE", hero: oop, heroCards: null, stackBb: charts.game.stackBb, preflop: lineActs(charts, line.key), board: ["2c", "7d", "Kh"], flop: [] });
      const seats = [seatOf(oop), seatOf(ip)];
      ok = chartLineOf(hand, seats, charts)?.line === line.key;
    } catch {
      ok = false;
    }
    readable.set(key, ok);
  }
  return ok;
}

/** The (line, seat) pairs a filter allows on the chart set, whatever the library holds. */
export function flopSeatings(charts: ChartSet, options: FlopSpotOptions) {
  const lines = FLOP_LINES.filter((line) => {
    if (options.line && line.id !== options.line) return false;
    if (options.pot && options.pot !== "any" && line.pot !== options.pot) return false;
    return analysisReadsLine(charts, line);
  }).map(asRiverLine);
  return riverSeatings({ pot: options.pot, seat: flopFilterSeat(options), role: options.role }, lines);
}

/** The library's flops for a line of a chart set, in the representatives' order. */
export function libraryFlops(library: Pick<FlopLibrary, "has">, set: string, line: string): string[] {
  return FLOP_REPRESENTATIVES.filter((flop) => library.has(set, line, flop));
}

export interface FlopPlan {
  set: string;
  line: RiverLine;
  seat: RiverSeat;
  hero: ChartPosition;
  villain: ChartPosition;
  flop: string;
}

/**
 * The line, seat and library flop a seed deals, drawn first from the seed's
 * generator (so the worker can fetch the chunk before generating). Null
 * when the library holds nothing the filter allows.
 */
export function planFlop(charts: ChartSet, library: Pick<FlopLibrary, "has">, options: FlopSpotOptions, rng: Rng): FlopPlan | null {
  const seatings = flopSeatings(charts, options).filter((s) => libraryFlops(library, charts.id, s.line.id).length > 0);
  if (seatings.length === 0) return null;
  const seating = pickOne(seatings, rng);
  const flop = pickOne(libraryFlops(library, charts.id, seating.line.id), rng);
  return { set: charts.id, line: seating.line, seat: seating.seat, hero: seating.hero, villain: seating.villain, flop };
}

/** The chunk a seed's spot (or split) is dealt from, for the worker to load first. */
export function flopChunkFor(
  charts: ChartSet,
  library: Pick<FlopLibrary, "has">,
  options: FlopSpotOptions,
  seed: number,
): { set: string; line: string; flop: string } | null {
  const plan = planFlop(charts, library, options, seeded(seed));
  return plan ? { set: plan.set, line: plan.line.id, flop: plan.flop } : null;
}

/* ---------------------------------------------------- walking the tree - */

/** One edge taken on the way to the hero's node. */
export interface TreeStep {
  node: number;
  edge: number;
  /** 0: out of position, 1: in position. */
  player: 0 | 1;
}

const isBet = (a: ActionInfo) => a.kind === "bet" || a.kind === "raise" || a.kind === "allin";

/**
 * An edge at `node`, drawn by how often the actor's range takes it, among
 * the edges `allow` accepts and the range takes at least 1% of the time.
 */
function drawEdge(result: SolveResult, node: number, allow: (a: ActionInfo) => boolean, rng: Rng): number {
  const at = result.nodes[node];
  const weights = at.actions.map((action, i) => (allow(action) && at.frequency[i] >= MIN_VILLAIN_FREQ && at.children[i] >= 0 ? at.frequency[i] : 0));
  return pickWeighted(weights, rng);
}

/**
 * The hero's decision node for a `facing` filter, and the edges taken on
 * the way, drawn from the solve's own frequencies (player 0 acts first).
 * Null when the drawn line does not reach such a node.
 */
export function heroNode(
  result: SolveResult,
  hero: 0 | 1,
  facing: FlopFacing | undefined,
  rng: Rng,
  street: "flop" | "turn" = "flop",
): { node: number; steps: TreeStep[] } | null {
  const steps: TreeStep[] = [];
  let node = 0;
  const take = (allow: (a: ActionInfo) => boolean): boolean => {
    const at = result.nodes[node];
    if (at.kind !== "action") return false;
    const edge = drawEdge(result, node, allow, rng);
    if (edge < 0) return false;
    steps.push({ node, edge, player: at.player as 0 | 1 });
    node = at.children[edge];
    return node >= 0 && result.nodes[node].kind === "action";
  };
  const want = facing ?? "any";
  if (want === "check") {
    if (hero !== 1 || !take((a) => a.kind === "check")) return null;
  } else if (want === "bet") {
    if (hero === 1) {
      if (!take(isBet)) return null;
    } else if (!take((a) => a.kind === "check") || !take(isBet)) return null;
  } else if (want === "raise") {
    if (hero === 1 && !take((a) => a.kind === "check")) return null;
    if (!take(isBet) || !take(isBet)) return null;
  } else if (hero === 1 && !take(() => true)) {
    return null;
  }
  const at = result.nodes[node];
  if (at.kind !== "action" || at.player !== hero || at.street !== street) return null;
  // A node the hero's range reaches with too little weight to deal from.
  const reach = rangesAt(result, node)[hero];
  let total = 0;
  for (let i = 0; i < reach.length; i += 1) total += reach[i];
  return total > 0.5 ? { node, steps } : null;
}

/** An edge as the script plays it. */
export function stepAct(result: SolveResult, step: TreeStep, position: ChartPosition): ScriptAct {
  const at = result.nodes[step.node];
  const action = at.actions[step.edge];
  switch (action.kind) {
    case "fold":
      return { position, type: "fold" };
    case "check":
      return { position, type: "check" };
    case "call":
      return { position, type: "call" };
    case "bet":
      return { position, type: "bet", to: round2(action.to) };
    case "raise":
      return { position, type: "raise", to: round2(action.to) };
    default:
      return { position, type: at.toCall > 0 ? "raise" : "bet", to: round2(action.to) };
  }
}

/* ------------------------------------------------------------ the spot - */

function attempt(charts: ChartSet, plan: FlopPlan, chunk: FlopChunk, options: FlopSpotOptions, rng: Rng, seed: number): FlopTrainerSpot | null {
  const result = chunk.result;
  const [oop, ip] = flopPlayers(plan.line.line);
  const heroIdx: 0 | 1 = plan.seat === "oop" ? 0 : 1;
  const walked = heroNode(result, heroIdx, options.facing, rng);
  if (!walked) return null;

  // The chunk's suits relabelled: the same canonical flop, so the hand reads this chunk exactly.
  const perm = pickOne(SUIT_PERMUTATIONS, rng);
  const relabel = (code: string) => cardCode(permuteCard(cardIndex(code), perm));
  const board = flopCards(chunk.header.flop).map(relabel);

  const flop = walked.steps.map((step) => stepAct(result, step, step.player === 0 ? oop : ip));
  const preflop = lineActs(charts, plan.line.line);
  const stackBb = charts.game.stackBb;
  const script0: HandScript = { id: `TF${seed.toString(36)}`, hero: plan.hero, heroCards: null, stackBb, preflop, board, flop };

  const weights = riverDealingWeights({ result, hero: heroIdx }, walked.node, options.bias ?? "range");
  const i = pickWeighted(weights, rng);
  if (i < 0) return null;
  const combo = result.hands[heroIdx][i];
  const cards: [string, string] = [cardCode(permuteCard(comboHi(combo), perm)), cardCode(permuteCard(comboLo(combo), perm))];
  const script: HandScript = { ...script0, heroCards: cards };
  const hand = handUpTo(scriptHand(script), Number.MAX_SAFE_INTEGER);

  const node = result.nodes[walked.node];
  const last = walked.steps[walked.steps.length - 1];
  let facing: FlopTrainerSpot["facing"] = null;
  if (last && last.player !== heroIdx) {
    const action = result.nodes[last.node].actions[last.edge];
    if (action.kind !== "check") facing = { kind: action.kind, to: round2(action.to), sizePot: Math.round(action.sizePot * 1000) / 1000 };
  }

  return {
    kind: "flop",
    seed,
    set: plan.set,
    lineId: plan.line.id,
    pot: plan.line.pot,
    hero: plan.hero,
    villain: plan.villain,
    seat: plan.seat,
    board,
    flop: chunk.header.flop,
    cards,
    script,
    hand,
    menu: menuOf({ result }, walked.node),
    potBb: round2(node.pot),
    toCallBb: round2(node.toCall),
    stackBb: round2(chunk.header.stack),
    facing,
    path: node.path,
    sources: { hero: "chart", villain: "chart" },
    model: LIBRARY_MODEL,
    iterations: result.iterations,
    exploitabilityPct: Math.round(result.exploitabilityPct * 1000) / 1000,
  };
}

/** The chunk a plan reads, if the library has it loaded and it was solved from these charts. */
function planChunk(charts: ChartSet, library: FlopLibrary, plan: FlopPlan): FlopChunk | null {
  const chunk = library.get(plan.set, plan.line.id, plan.flop);
  if (!chunk || chunk.header.charts.hash !== charts.model.hash) return null;
  return chunk;
}

/**
 * A flop spot for `seed`, or null when the library holds nothing the filter
 * allows, its chunk is not loaded, or no attempt reached a node. Deterministic.
 */
export function generateFlopSpot(charts: ChartSet, library: FlopLibrary, options: FlopSpotOptions, seed: number): FlopTrainerSpot | null {
  const rng = seeded(seed);
  const plan = planFlop(charts, library, options, rng);
  if (!plan) return null;
  const chunk = planChunk(charts, library, plan);
  if (!chunk) return null;
  for (let tries = 0; tries < MAX_ATTEMPTS; tries += 1) {
    const spot = attempt(charts, plan, chunk, options, rng, seed);
    if (spot) return spot;
  }
  return null;
}

/** The chunk of a plan, for the split generator (`split.ts`). */
export function plannedChunk(charts: ChartSet, library: FlopLibrary, options: FlopSpotOptions, rng: Rng): { plan: FlopPlan; chunk: FlopChunk } | null {
  const plan = planFlop(charts, library, options, rng);
  if (!plan) return null;
  const chunk = planChunk(charts, library, plan);
  return chunk ? { plan, chunk } : null;
}

function flopAct(spot: FlopTrainerSpot, item: RiverMenuItem): ScriptAct {
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
export function flopAnswer(spot: FlopTrainerSpot, menuIndex: number): { hand: PhfHand; actionIndex: number } {
  const item = spot.menu[menuIndex];
  if (!item) throw new RangeError(`no menu item ${menuIndex}`);
  const hand = scriptHand({ ...spot.script, flop: [...(spot.script.flop ?? []), flopAct(spot, item)] });
  const decision = lastHeroDecision(hand);
  if (!decision || decision.street !== "flop") throw new RangeError("the answer did not parse as a hero flop decision");
  return { hand, actionIndex: decision.index };
}
