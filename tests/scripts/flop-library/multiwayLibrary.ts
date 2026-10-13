/**
 * A flop narrowing for multiway pots read from the heads-up flop library
 * (`docs/ANALYSIS-PLAN.md` §10, 2026-10-13, "Multiway flop narrowing from
 * the library: nothing shipped"). **Study code only**: held out on shown
 * hands it explained the multiway flop bettors' and callers' hands worse
 * than the heuristic, so the analysis does not use it; it lives beside the
 * study (`multiwayNarrowing.test.ts`) so the result can be re-run.
 *
 * No multiway solve exists, so each flop player is read as one of the two
 * seats of the heads-up chunk of the closest line:
 *
 * ```
 * the preflop line ─▶ pot type, aggressor, callers
 *   single raised: the line `<aggressor>-bb` (the aggressor's seat against the big blind)
 *   3-bet:         the 3-bet line of the same opener and 3-bettor, if the library has it
 *   limped:        the small blind's limped pot (`sb-limp`)
 * roles ─▶ the aggressor plays the chunk's aggressor, every caller its caller;
 *          limped, the last to act plays the big blind (in position), every other the small blind
 * the flop ─▶ the exact chunk, else its representative read by hand category (as heads-up)
 * the street's actions ─▶ one heads-up line between the two roles:
 *   a check is followed into the tree only when the next actor has the other role
 *   (several players of one role checking are that role checking once),
 *   a call or a fold leaves the line where it is (the next player of the same role
 *   answers the same bet), a bet or a raise follows its edge
 * each action ─▶ L(combo | action) = ε + (1 − ε) · the role's solved strategy at that node
 * ```
 *
 * Where the line cannot follow (the actor's role is not the one deciding at
 * the node, a size off the tree, a re-raise the tree has not, a node the
 * role's range hardly reaches) the action falls back to `fallback` (the
 * heuristic model with its multiway adjustments); after an aggressive
 * action that cannot follow, the rest of the street does too. The turn and
 * river are never read here.
 *
 * The approximation is that a heads-up strategy, of the closest heads-up
 * line, describes how each player of a multiway pot plays each combo; the
 * chunk's ranges are the charts' heads-up ones, not the multiway players'.
 * Only the strategy per combo is read (a likelihood), never an EV, so the
 * pot's size and the stack-to-pot ratio do not have to match.
 */

import type { ChartSet } from "../../../frontend/src/lib/charts/index.js";
import { isChartLibrary, pickChartSet, preflopSpotFromHand } from "../../../frontend/src/lib/charts/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import {
  canonicalBoard,
  comboHi,
  comboLo,
  FLOP_REPRESENTATIVES,
  flopKey,
  mapFlop,
  NUM_COMBOS,
  OFF_TREE_DISTANCE,
  permuteCombo,
  rangesAt,
  type FlopChunk,
  type SolvedNode,
} from "../../../frontend/src/lib/solver/index.js";
import type { StatsContext } from "../../../frontend/src/lib/stats/context.js";
import {
  categoryReader,
  FLOP_PROFILE,
  flopLinesFor,
  flopPlayersOf,
  flopSeats,
  heuristicModel,
  lineSeats,
  mapAct,
  MIN_LINE_REACH,
  readingChain,
  streetActs,
  toIndices,
  walkLine,
  type FlopLibrary,
  type FlopLine,
  type NarrowingModel,
  type NarrowInput,
  type StreetAct,
} from "../../../frontend/src/lib/analysis/index.js";

/** The model id: `mwlib:flop-m1`. */
export const MULTIWAY_LIBRARY_MODEL = `mwlib:${FLOP_PROFILE.tree}`;

/**
 * The least likelihood the library gives any combo: the solve's pure
 * strategies say "never" where real players sometimes do (ε of the header).
 * The design's value; the study also scores 0 to 1 (§10 2026-10-13).
 */
export const MULTIWAY_LIBRARY_FLOOR = 0.03;

const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);
/** Postflop order over every position a hand can name. */
const POSTFLOP: readonly string[] = ["SB", "BB", "UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BTN"];

/** Which heads-up chunk a multiway flop reads, and which of its two seats each flop player plays. */
export interface MultiwayLibraryPlan {
  set: string;
  line: FlopLine;
  pot: FlopLine["pot"];
  /** The chunk to read: the canonical flop, or its representative. */
  flop: string;
  exact: boolean;
  /** Seat -> the chunk's player (0 out of position) it plays. */
  roles: ReadonlyMap<number, 0 | 1>;
}

/** A hand's position spelled as a line's table spells it (a full ring's MP is the lojack; 6-max has no UTG+1). */
function linePosition(position: string, players: 6 | 9): string {
  const seats = lineSeats({ players }) as readonly string[];
  if (seats.includes(position)) return position;
  if (position === "UTG+1" || position === "UTG+2") return "UTG";
  if (position === "MP" || position === "LJ") return players === 9 ? "LJ" : "HJ";
  return position;
}

/** The raisers of a line key, in order (positions). */
function raisersOf(line: FlopLine): string[] {
  return walkLine(line.key, lineSeats(line))
    .steps.filter((s) => s.code === "r")
    .map((s) => s.position);
}

/**
 * The heads-up chunk a multiway flop reads and the roles (the module
 * comment), or null: not three or more at the flop, a preflop all-in, four or
 * more raises, a line or a flop the library does not hold, a chart set
 * without a library.
 */
export function multiwayLibraryPlan(
  hand: PhfHand,
  context: StatsContext,
  charts: ChartSet | null,
  library: Pick<FlopLibrary, "has"> | null | undefined,
): MultiwayLibraryPlan | null {
  if (!charts || !library) return null;
  const seats = flopSeats(context);
  if (seats.length < 3) return null;
  const flopCodes = hand.board.runouts[0]?.flop;
  if (!flopCodes || flopCodes.length !== 3) return null;
  const preflop = hand.actions.filter((a) => a.street === "preflop" && a.seat !== null && DECISIONS.has(a.type));
  if (preflop.some((a) => a.allIn)) return null;
  const raises = preflop.filter((a) => a.type === "raise" || a.type === "bet");
  if (raises.length > 2) return null;
  const position = (seat: number) => String(context.position.get(seat) ?? "");
  const order = [...seats].sort((a, b) => POSTFLOP.indexOf(position(a)) - POSTFLOP.indexOf(position(b)));
  if (order.some((seat) => POSTFLOP.indexOf(position(seat)) < 0)) return null;

  // The chart set: the one the aggressor's (limped: the last to act's) last preflop decision is read on.
  const anchor = raises.length > 0 ? (raises[raises.length - 1].seat as number) : order[order.length - 1];
  if (!seats.includes(anchor)) return null;
  const nth = preflop.filter((a) => a.seat === anchor).length - 1;
  const found = preflopSpotFromHand(hand, nth, anchor);
  if (!found.ok || found.spot.ante || found.spot.straddle) return null;
  let set: ChartSet | null = null;
  if (isChartLibrary(charts)) {
    const pick = pickChartSet(charts.specs, found.spot);
    set = pick.ok ? (charts.sets.get(pick.spec.id) ?? null) : null;
  } else {
    set = charts;
  }
  if (!set) return null;
  const players = set.game.players > 6 ? 9 : 6;
  const lines = flopLinesFor(set.game.players);

  let line: FlopLine | undefined;
  const roles = new Map<number, 0 | 1>();
  if (raises.length === 0) {
    line = lines.find((l) => l.pot === "limped");
    if (!line) return null;
    for (const seat of order) roles.set(seat, seat === order[order.length - 1] ? 1 : 0);
  } else {
    const aggressor = raises[raises.length - 1].seat as number;
    const aggressorAt = linePosition(position(aggressor), players);
    if (raises.length === 1) {
      const srp = lines.filter((l) => l.pot === "srp" && raisersOf(l)[0] === aggressorAt);
      line = srp.find((l) => flopPlayersOf(l.key, lineSeats(l)).includes("BB")) ?? srp[0];
    } else {
      const openerAt = linePosition(position(raises[0].seat as number), players);
      line = lines.find((l) => {
        if (l.pot !== "3bp") return false;
        const r = raisersOf(l);
        return r[0] === openerAt && r[1] === aggressorAt;
      });
    }
    if (!line) return null;
    const pair = flopPlayersOf(line.key, lineSeats(line)) as readonly string[];
    const mine = pair.indexOf(aggressorAt);
    if (mine < 0) return null;
    for (const seat of seats) roles.set(seat, (seat === aggressor ? mine : 1 - mine) as 0 | 1);
  }

  let cards: number[];
  try {
    cards = toIndices(flopCodes);
  } catch {
    return null;
  }
  const key = flopKey(cards);
  if (library.has(set.id, line.id, key)) return { set: set.id, line, pot: line.pot, flop: key, exact: true, roles };
  const mapped = mapFlop(cards, FLOP_REPRESENTATIVES);
  if (library.has(set.id, line.id, mapped.representative)) {
    return { set: set.id, line, pot: line.pot, flop: mapped.representative, exact: false, roles };
  }
  return null;
}

/** Where one flop action reads the chunk: the node and the edges (with the size translation's weights). */
interface ReadAt {
  node: number;
  edges: number[];
  weights: number[];
}

export interface MultiwayLibraryModel extends NarrowingModel {
  /** How many flop actions read the library, and how many fell back. */
  counts(): { library: number; fallback: number };
  /** Whether the flop action with this `PhfAction.index` reads the library. */
  covers(actionIndex: number): boolean;
}

export interface MultiwayLibraryOptions {
  /** ε: the least likelihood (default `MULTIWAY_LIBRARY_FLOOR`). */
  floor?: number;
  fallback?: NarrowingModel;
}

/**
 * The narrowing model of a multiway hand whose flop has a chunk (the module
 * comment). `chunk` must be the plan's; null when its charts hash differs
 * from the set's (the chunk was solved from other ranges).
 */
export function multiwayLibraryModel(
  hand: PhfHand,
  plan: MultiwayLibraryPlan,
  chunk: FlopChunk,
  charts: ChartSet | null,
  options: MultiwayLibraryOptions = {},
): MultiwayLibraryModel | null {
  const set = charts && isChartLibrary(charts) ? charts.sets.get(plan.set) : charts;
  if (!set || chunk.header.charts.id !== plan.set || chunk.header.charts.hash !== set.model.hash) return null;
  if (chunk.header.line !== plan.line.id || chunk.header.flop !== plan.flop) return null;
  const floor = options.floor ?? MULTIWAY_LIBRARY_FLOOR;
  const fallback = options.fallback ?? heuristicModel;
  const result = chunk.result;
  let board: number[];
  try {
    board = toIndices(hand.board.runouts[0]?.flop ?? []);
  } catch {
    return null;
  }
  const perm = canonicalBoard(board).perm;
  const libIndex = [0, 1].map((p) => {
    const at = new Int32Array(NUM_COMBOS).fill(-1);
    result.hands[p].forEach((combo, i) => {
      at[combo] = i;
    });
    return at;
  });
  let reader: ReturnType<typeof categoryReader> | null = null;
  const byCategory = (node: number, keys: readonly string[]) => {
    reader ??= categoryReader(result, toIndices(result.board));
    return reader(node, keys);
  };

  // The street's actions onto one heads-up line between the two roles.
  const acts: StreetAct[] = streetActs(hand, "flop");
  const reads = new Map<number, ReadAt>();
  const reachOk = new Map<number, boolean>();
  const reached = (node: number, p: number) => {
    const key = node * 2 + p;
    let ok = reachOk.get(key);
    if (ok === undefined) {
      const reach = rangesAt(result, node)[p];
      let start = 0;
      let now = 0;
      for (let i = 0; i < reach.length; i += 1) {
        start += result.weights[p][i];
        now += reach[i];
      }
      ok = start > 0 && now / start >= MIN_LINE_REACH;
      reachOk.set(key, ok);
    }
    return ok;
  };
  let at = 0;
  let broken = false;
  for (let k = 0; k < acts.length && !broken; k += 1) {
    const act = acts[k];
    const role = plan.roles.get(act.seat);
    const aggressive = act.type === "bet" || act.type === "raise";
    const node: SolvedNode | undefined = result.nodes[at];
    if (role === undefined || !node || node.kind !== "action" || node.player !== role || !reached(at, role)) {
      if (aggressive) broken = true;
      continue;
    }
    // A short all-in is a size like any other; only a shove of 1.5 pots or more is the tree's all-in.
    const mapped = mapAct(node, { ...act, allIn: act.allIn && (act.sizePot ?? 0) >= 1.5 }, Number.POSITIVE_INFINITY);
    if (!mapped || mapped.distance > OFF_TREE_DISTANCE) {
      if (aggressive) broken = true;
      continue;
    }
    reads.set(act.index, { node: at, edges: mapped.edges, weights: mapped.weights });
    if (aggressive) {
      const next = node.children[mapped.edges[0]];
      if (next < 0) broken = true;
      else at = next;
    } else if (act.type === "check") {
      const after = acts[k + 1];
      const nextRole = after ? plan.roles.get(after.seat) : undefined;
      if (nextRole !== undefined && nextRole !== role) {
        const next = node.children[mapped.edges[0]];
        if (next < 0) broken = true;
        else at = next;
      }
    }
    // A call or a fold: the next player of the same role answers the same bet.
  }

  let library = 0;
  let fell = 0;
  const likelihood = (input: NarrowInput): Float64Array => {
    const read = input.street === "flop" && input.actionIndex !== undefined ? reads.get(input.actionIndex) : undefined;
    if (!read) {
      if (input.street === "flop") fell += 1;
      return fallback.likelihood(input);
    }
    library += 1;
    const node = result.nodes[read.node];
    const p = node.player;
    const m = result.hands[p].length;
    let mean = 0;
    read.edges.forEach((edge, e) => {
      mean += read.weights[e] * (node.frequency[edge] ?? 0);
    });
    const out = new Float64Array(NUM_COMBOS);
    for (let c = 0; c < NUM_COMBOS; c += 1) {
      const hi = comboHi(c);
      const lo = comboLo(c);
      if (board.includes(hi) || board.includes(lo)) continue;
      let s = 0;
      const j = plan.exact ? libIndex[p][permuteCombo(c, perm)] : -1;
      if (j >= 0) {
        read.edges.forEach((edge, e) => {
          s += read.weights[e] * node.strategy[edge * m + j];
        });
      } else {
        const row = byCategory(read.node, readingChain([hi, lo], board));
        if (row) {
          read.edges.forEach((edge, e) => {
            s += read.weights[e] * row.strategy[edge];
          });
        } else {
          s = mean;
        }
      }
      out[c] = floor + (1 - floor) * Math.min(1, Math.max(0, s));
    }
    return out;
  };
  return {
    id: `${MULTIWAY_LIBRARY_MODEL}+${fallback.id}`,
    likelihood,
    counts: () => ({ library, fallback: fell }),
    covers: (actionIndex) => reads.has(actionIndex),
  };
}
