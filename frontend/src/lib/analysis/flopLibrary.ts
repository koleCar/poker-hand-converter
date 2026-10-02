/**
 * The flop library in the analysis (phase A5b, `docs/ANALYSIS-PLAN.md` §3.2,
 * §10): what it solves, and how a hand reads it.
 *
 * ```
 * hand ─▶ its preflop line (charts) + its flop ─▶ a chunk: the exact canonical flop, else the representative (flopSet.ts)
 *      ─▶ the chunk read in the hand's own combos and pot (`FlopEntry.result`): combo for combo, or by hand category
 *         ├▶ flop narrowing: L(combo | action) = the solved strategy at the node (`libraryModel`), heuristic where it cannot follow
 *         └▶ flop grading: the hero's options, freq and EV at the node, grade() (§2), source "solver" (`gradeFlop`)
 * ```
 *
 * **Disabled by default** (`FLOP_LIBRARY_ENABLED`): only the pilot exists
 * (§10 A5b). The analysis reads the library only when it is handed one
 * (`AnalyzeOptions.flopLibrary`); the worker hands it one only when the flag
 * is on. Tests hand it the pilot's chunks or a small solve of their own.
 *
 * **When a hand reads the library**: heads-up to the flop on one of
 * `FLOP_LINES` (both players' preflop ranges are the charts' for the line -
 * the ranges the library was solved from, checked by the chart set's hash),
 * stacks at the flop within `SPR_TOLERANCE` of the solve's. Anything else
 * keeps the heuristic, as before A5b.
 *
 * **Exact or mapped.** A flop whose canonical spelling has a chunk reads it
 * combo for combo through the suit relabelling (exact up to suits). Any
 * other flop reads its representative's chunk (`mapFlop`) **by hand
 * category**: each combo of the real flop takes the reach-weighted mean
 * strategy and EV of the combos in the same category on the representative
 * (`flopBucket`: made hand × draw), with coarser categories when that one is
 * empty there. Approximations `flop-mapped` and `library-bucketed`. A hero
 * combo the exact chunk does not hold (out of the chart range) is read by
 * category too (`library-bucketed`, `out-of-range`).
 *
 * **Units.** The chunk is solved at the chart line's own pot and stack; a
 * real hand's pot differs a little (a 2.2 bb open is not 2.5). Sizes are
 * fractions of the pot, so the tree carries over; amounts and EVs are scaled
 * by the real pot over the solved one, so EV loss is in the hand's own big
 * blinds and its share of the pot is unchanged.
 */

import type { ChartPosition, ChartSet } from "../charts";
import { lookupPreflop, preflopSpotFromHand } from "../charts";
import { cardCode } from "../equity/evaluator";
import type { PhfHand } from "../phf/types";
import {
  canonicalBoard,
  chunkPath,
  comboHi,
  comboIndex,
  comboLo,
  decodeChunk,
  FLOP_REPRESENTATIVES,
  flopKey,
  mapFlop,
  NUM_COMBOS,
  OFF_TREE_DISTANCE,
  permuteCombo,
  rangesAt,
  type BetMenu,
  type FlopChunk,
  type FlopManifest,
  type SolvedNode,
  type SolveResult,
} from "../solver";
import { buildContext, type StatsContext } from "../stats/context";
import type { GradeResult } from "./grading";
import { comboRange, heuristicModel, type NarrowingModel, type NarrowInput } from "./narrowing";
import { chartRange } from "./preflop";
import { walkLine } from "./reports";
import {
  followSolvedLine,
  gradeMapped,
  mapAct,
  optionsAt,
  streetActs,
  TRANSLATED_DISTANCE,
  type StreetAct,
} from "./river";
import { draws, madeHand, toIndices } from "./texture";
import { TURN_DCFR, TURN_MENU, TURN_RIVER_MENU } from "./turn";
import type { Approximation, FlopFacts, OptionAnalysis } from "./types";

/**
 * The flop library is off until the full library exists: the worker never
 * loads one, so `analyzeHand` grades the flop with the heuristic, as before.
 * Turning it on is a grade change (`ANALYSIS_VERSION`).
 */
export const FLOP_LIBRARY_ENABLED = false;

/** Where the worker fetches chunks from when the flag is on (`<base>/<set>/<tree>/<line>/<flop>.bin`). */
export const FLOP_LIBRARY_BASE = "/floplib";

/* ---------------------------------------------------------- the lines - */

/** A heads-up preflop line the library solves: a chart line key, folds included. */
export interface FlopLine {
  id: string;
  pot: "srp" | "3bp" | "limped";
  key: string;
}

/**
 * The preflop lines of the library: the river trainer's twelve heads-up pots
 * (`lib/training/river.ts`), every one reached by the charts with real
 * frequency - single raised pots of every opener against the big blind and
 * the button against the small blind, the common 3-bet pots, and the small
 * blind's limp. Most common first (the batch runner's order).
 */
export const FLOP_LINES: readonly FlopLine[] = [
  { id: "btn-bb", pot: "srp", key: "fffrfc" },
  { id: "co-bb", pot: "srp", key: "ffrffc" },
  { id: "sb-bb", pot: "srp", key: "ffffrc" },
  { id: "hj-bb", pot: "srp", key: "frfffc" },
  { id: "utg-bb", pot: "srp", key: "rffffc" },
  { id: "btn-sb", pot: "srp", key: "fffrcf" },
  { id: "btn-bb-3bet", pot: "3bp", key: "fffrfrc" },
  { id: "btn-sb-3bet", pot: "3bp", key: "fffrrfc" },
  { id: "co-btn-3bet", pot: "3bp", key: "ffrrffc" },
  { id: "co-bb-3bet", pot: "3bp", key: "ffrffrc" },
  { id: "sb-bb-3bet", pot: "3bp", key: "ffffrrc" },
  { id: "sb-limp", pot: "limped", key: "ffffck" },
];

const POSTFLOP: readonly ChartPosition[] = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];

/** The two players who see the flop on a line, out of position first. */
export function flopPlayersOf(key: string): [ChartPosition, ChartPosition] {
  const { steps } = walkLine(key);
  const folded = new Set(steps.filter((s) => s.code === "f").map((s) => s.position));
  const live = (["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const).filter((p) => !folded.has(p));
  if (live.length !== 2) throw new RangeError(`line ${key} is not heads-up to the flop`);
  live.sort((a, b) => POSTFLOP.indexOf(a) - POSTFLOP.indexOf(b));
  return [live[0], live[1]];
}

/* --------------------------------------------------------- the profile - */

/** What the library solves per (line, flop): the tree, the target, the engine settings. */
export interface FlopProfile {
  /** Part of every chunk's header and path; a different tree is a different library. */
  tree: string;
  flopMenu: BetMenu;
  flopRaiseCap: number;
  turnMenu: BetMenu;
  turnRaiseCap: number;
  riverMenu: BetMenu;
  riverRaiseCap: number;
  allInThreshold: number;
  minBet: number;
  /** Exploitability target, % of the flop pot, measured exactly over the whole flop+turn+river tree. */
  targetPct: number;
  maxIterations: number;
  checkFrom: number;
  checkEvery: number;
  dcfr: { alpha: number; beta: number; gamma: number };
}

/**
 * The library's tree (`flop-m1`), chosen by measurement (§10 A5b):
 *
 * - flop: bets of 33% and 75% (real flop bets cluster at both; with one size
 *   half of them would be off the tree), a raise of half the pot after the
 *   call (about 3.5x a 33% bet) and all-in up to three pots, one raise;
 * - turn: the A5a turn's 75% and all-in up to three pots, **no raise** (a
 *   turn raise cost 40% more time and memory on the widest line);
 * - river: 75% and all-in, no raise (A5a's).
 */
export const FLOP_PROFILE: Readonly<FlopProfile> = {
  tree: "flop-m1",
  flopMenu: { bet: [0.33, 0.75], raise: [0.5], allIn: true, allInMaxPot: 3 },
  flopRaiseCap: 1,
  turnMenu: TURN_MENU,
  turnRaiseCap: 0,
  riverMenu: TURN_RIVER_MENU,
  riverRaiseCap: 0,
  allInThreshold: 0.1,
  minBet: 1,
  targetPct: 1,
  maxIterations: 300,
  checkFrom: 40,
  checkEvery: 20,
  dcfr: TURN_DCFR,
};

/** A hand reads the library only when its stack-to-pot ratio at the flop is within this factor of the solve's. */
export const SPR_TOLERANCE = 0.3;
/** A hand category with less reach than this (combos) at a node is too thin to stand for anything; a coarser one is used. */
export const MIN_BUCKET_COMBOS = 0.5;

/* ---------------------------------------------------------- the source - */

/**
 * Chunks for `analyzeHand`, synchronously: the worker fetches ahead
 * (`FlopLibraryLoader`). Keyed by chart set id, line and canonical flop: a
 * chunk is solved from one set's ranges (the 6-max 100bb set's in the
 * pilot), and a hand reads only chunks of the set its own preflop line was
 * answered from.
 */
export interface FlopLibrary {
  /** The tree the chunks were solved with. */
  readonly tree: string;
  /** Whether a chunk exists for (set, line, canonical flop), loaded or not. */
  has(set: string, line: string, flop: string): boolean;
  /** The chunk, if it exists and is loaded. */
  get(set: string, line: string, flop: string): FlopChunk | null;
}

/** A library held in memory (tests, scripts). */
export function memoryLibrary(chunks: readonly FlopChunk[], tree?: string): FlopLibrary {
  const byKey = new Map(chunks.map((c) => [`${c.header.charts.id}/${c.header.line}/${c.header.flop}`, c]));
  return {
    tree: tree ?? chunks[0]?.header.tree ?? FLOP_PROFILE.tree,
    has: (set, line, flop) => byKey.has(`${set}/${line}/${flop}`),
    get: (set, line, flop) => byKey.get(`${set}/${line}/${flop}`) ?? null,
  };
}

/** What the loader needs of `fetch`: a test passes one that reads files. */
export type LibraryFetch = (url: string) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>;

/**
 * Fetches chunks on demand from a base URL: a set's manifest the first time
 * a hand on that set needs it, then each chunk the first time a hand reads
 * it (`prefetch`), kept for the worker's life. Never bundled into a page: a
 * chunk is a separate request. A set with no manifest is an empty library.
 */
export class FlopLibraryLoader implements FlopLibrary {
  readonly base: string;
  readonly tree: string;
  private readonly fetcher: LibraryFetch;
  /** Per set id: the (line/flop) keys its manifest lists; empty when it has none. */
  private readonly manifests = new Map<string, Set<string>>();
  private readonly chunks = new Map<string, FlopChunk | null>();

  constructor(base: string, fetcher: LibraryFetch, tree: string = FLOP_PROFILE.tree) {
    this.base = base;
    this.tree = tree;
    this.fetcher = fetcher;
  }

  private url(path: string): string {
    return `${this.base.replace(/\/$/, "")}/${path}`;
  }

  /** Loads a set's manifest (once). False when there is none. */
  async ready(set: string): Promise<boolean> {
    let keys = this.manifests.get(set);
    if (!keys) {
      keys = new Set();
      this.manifests.set(set, keys);
      try {
        const response = await this.fetcher(this.url(`${set}/${this.tree}/manifest.json`));
        if (response.ok) {
          const manifest = (await response.json()) as FlopManifest;
          for (const entry of manifest.entries) keys.add(`${entry.line}/${entry.flop}`);
        }
      } catch {
        // No manifest: nothing of this set is in the library.
      }
    }
    return keys.size > 0;
  }

  has(set: string, line: string, flop: string): boolean {
    return this.manifests.get(set)?.has(`${line}/${flop}`) ?? false;
  }

  get(set: string, line: string, flop: string): FlopChunk | null {
    return this.chunks.get(`${set}/${line}/${flop}`) ?? null;
  }

  /** Fetches the chunk a hand would read, if any. Never throws: a missing chunk is the heuristic. */
  async prefetch(hand: PhfHand, charts: ChartSet | null): Promise<void> {
    if (!charts) return;
    let want: ReturnType<typeof chunkFor> = null;
    try {
      const context = buildContext(hand);
      const pair = flopPair(context);
      const placed = pair ? chartLineOf(hand, pair, charts) : null;
      if (!placed || !(await this.ready(placed.set.id))) return;
      want = chunkFor(hand, context, charts, this);
    } catch {
      return;
    }
    if (!want) return;
    const key = `${want.set}/${want.line.id}/${want.flop}`;
    if (this.chunks.has(key)) return;
    try {
      const response = await this.fetcher(this.url(chunkPath(want.set, this.tree, want.line.id, want.flop)));
      this.chunks.set(key, response.ok ? decodeChunk(await response.arrayBuffer()) : null);
    } catch {
      this.chunks.set(key, null);
    }
  }
}

/* ------------------------------------------------------- hand → chunk - */

const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);

/** The two seats that saw the flop, if exactly two did. */
function flopPair(context: StatsContext): [number, number] | null {
  if (!context.dealt.has("flop")) return null;
  const seats = context.dealtInSeats.filter((seat) => context.foldedOn.get(seat) !== "preflop");
  return seats.length === 2 ? [seats[0], seats[1]] : null;
}

/**
 * The hand's preflop line as a chart line key (`"fffrfc"`) and the chart set
 * that answered it (a chart library picks one per table and depth), read the
 * way `chartRange` reads each player's line: the chart node of each flop
 * player's last preflop decision plus the action taken there; the longer of
 * the two is the whole line. Null when the charts cannot place it, or the
 * two players' lines were answered by different sets.
 */
export function chartLineOf(hand: PhfHand, seats: readonly number[], charts: ChartSet): { line: string; set: ChartSet } | null {
  let best: { line: string; set: ChartSet } | null = null;
  for (const seat of seats) {
    let nth = -1;
    for (const action of hand.actions) {
      if (action.street !== "preflop") continue;
      if (action.seat === seat && DECISIONS.has(action.type)) nth += 1;
    }
    if (nth < 0) return null;
    const found = preflopSpotFromHand(hand, nth, seat);
    if (!found.ok) return null;
    const lookup = lookupPreflop(charts, found.spot, null, found.heroAction);
    if (!lookup.ok || lookup.chosen === null || lookup.chosen < 0) return null;
    const line = lookup.node.line + lookup.node.options[lookup.chosen].code;
    if (best && best.set.id !== lookup.set.id) return null;
    if (!best || line.length > best.line.length) best = { line, set: lookup.set };
  }
  return best;
}

/** The (set, line, flop) chunk a hand would read, with how: the exact canonical flop or its representative. */
export function chunkFor(
  hand: PhfHand,
  context: StatsContext,
  charts: ChartSet,
  library: Pick<FlopLibrary, "has">,
): { set: string; line: FlopLine; flop: string; exact: boolean; distance: number; key: string } | null {
  const pair = flopPair(context);
  const flop = hand.board.runouts[0]?.flop;
  if (!pair || !flop || flop.length !== 3) return null;
  let cards: number[];
  try {
    cards = toIndices(flop);
  } catch {
    return null;
  }
  const placed = chartLineOf(hand, pair, charts);
  const line = FLOP_LINES.find((l) => l.key === placed?.line);
  if (!placed || !line) return null;
  const set = placed.set.id;
  const key = flopKey(cards);
  if (library.has(set, line.id, key)) return { set, line, flop: key, exact: true, distance: 0, key };
  const mapped = mapFlop(cards, FLOP_REPRESENTATIVES);
  if (library.has(set, line.id, mapped.representative)) {
    return { set, line, flop: mapped.representative, exact: false, distance: mapped.distance, key };
  }
  return null;
}

/* ------------------------------------------------------ hand categories - */

/**
 * A combo's hand category on a flop, for reading a representative's chunk:
 * the made hand (the nuts down to nothing, top pair split by kicker) and
 * the draw (flush and straight, combo draws, backdoors), `made/draw`.
 * Suit-blind and rank-relative, so the same category means the same thing
 * on the real flop and on its representative.
 */
export function flopBucket(hole: readonly [number, number], board: readonly number[]): string {
  const made = madeHand(hole, board);
  let m: string;
  switch (made?.class) {
    case "straight-flush":
    case "quads":
    case "full-house":
      m = "fh+";
      break;
    case "flush":
    case "straight":
    case "set":
    case "trips":
    case "two-pair":
    case "overpair":
      m = made.class;
      break;
    case "top-pair":
      m = `tp-${made.kicker ?? "weak"}`;
      break;
    case "pocket-pair-below-top":
    case "second-pair":
      m = "middle";
      break;
    case "weak-pair":
    case "underpair":
      m = "weak";
      break;
    case "ace-high":
      m = "ace-high";
      break;
    default:
      m = "nothing";
  }
  const found = draws(hole, board);
  const flush = found.includes("flush-draw") || found.includes("nut-flush-draw");
  const straight = found.includes("oesd");
  const gut = found.includes("gutshot");
  const back = found.includes("backdoor-flush") || found.includes("backdoor-straight");
  const d = flush && (straight || gut) ? "combo" : flush ? (found.includes("nut-flush-draw") ? "nfd" : "fd") : straight ? "oesd" : gut ? "gut" : back ? "bd" : "none";
  return `${m}/${d}`;
}

/** Category keys from fine to coarse: the bucket, the made hand alone, everything. */
function bucketChain(bucket: string): string[] {
  return [bucket, `${bucket.split("/")[0]}/*`, "*"];
}

/** Per node of a result: reach-weighted mean strategy and EV per category, for the acting player. */
interface BucketTable {
  /** key -> [reach, ...strategy per action, ...ev per action] */
  rows: Map<string, Float64Array>;
}

function bucketTables(result: SolveResult, boardCards: readonly number[]): (BucketTable | null)[] {
  const keyOf = [0, 1].map((p) =>
    Array.from(result.hands[p], (combo) => flopBucket([comboHi(combo), comboLo(combo)], boardCards)),
  );
  return result.nodes.map((node, index) => {
    if (node.kind !== "action") return null;
    const p = node.player;
    const n = result.hands[p].length;
    const count = node.actions.length;
    const reach = rangesAt(result, index)[p];
    const rows = new Map<string, Float64Array>();
    for (let i = 0; i < n; i += 1) {
      const w = reach[i];
      if (!(w > 0)) continue;
      for (const key of bucketChain(keyOf[p][i])) {
        let row = rows.get(key);
        if (!row) {
          row = new Float64Array(1 + 2 * count);
          rows.set(key, row);
        }
        row[0] += w;
        for (let a = 0; a < count; a += 1) {
          row[1 + a] += w * node.strategy[a * n + i];
          row[1 + count + a] += w * node.ev[a * n + i];
        }
      }
    }
    return { rows };
  });
}

/** The category row a combo reads: the finest with enough reach. */
function bucketRow(table: BucketTable, bucket: string): Float64Array | null {
  for (const key of bucketChain(bucket)) {
    const row = table.rows.get(key);
    if (row && row[0] >= MIN_BUCKET_COMBOS) return row;
  }
  for (const key of bucketChain(bucket)) {
    const row = table.rows.get(key);
    if (row && row[0] > 0) return row;
  }
  return null;
}

/**
 * Reading a flop solve by hand category, as a mapped flop reads its
 * representative: for a node (result index) and a category (`flopBucket`),
 * the reach-weighted mean strategy and EV per action of the combos in that
 * category there (coarser when it is too thin), or null. For the pilot's
 * validation of the mapping (`tests/scripts/flop-library/validate.ts`).
 */
export function categoryReader(
  result: SolveResult,
  board: readonly number[],
): (node: number, bucket: string) => { strategy: number[]; ev: number[] } | null {
  const tables = bucketTables(result, board);
  return (node, bucket) => {
    const table = tables[node];
    const row = table ? bucketRow(table, bucket) : null;
    if (!row) return null;
    const count = (row.length - 1) / 2;
    return {
      strategy: Array.from(row.subarray(1, 1 + count), (x) => x / row[0]),
      ev: Array.from(row.subarray(1 + count), (x) => x / row[0]),
    };
  };
}

/* ------------------------------------------------------- the entry - */

/** Why a hand does not read the library (it keeps the heuristic). Never stored. */
export type FlopMiss =
  | "no-library"
  | "not-heads-up"
  | "line"
  | "ranges"
  | "charts-differ"
  | "no-chunk"
  | "depth";

/** A hand's view of its chunk: the solve in the hand's own combos, suits and pot. */
export interface FlopEntry {
  ok: true;
  chunk: FlopChunk;
  line: FlopLine;
  /** The real flop's canonical key, and the chunk's (its representative when mapped). */
  key: string;
  flop: string;
  exact: boolean;
  distance: number;
  /** The solve read in the hand's combos (player 0 out of position), amounts and EVs in the hand's bb. */
  result: SolveResult;
  /** Per player, per hand of `result`: read by category (not combo for combo). */
  bucketed: [Uint8Array, Uint8Array];
  /** Real pot over the solved pot. */
  scale: number;
  heroSeat: number;
  villainSeat: number;
  heroFirst: boolean;
  /** Real pot and effective stack at the flop, bb. */
  potBb: number;
  stackBb: number;
  board: number[];
  /** The hand's flop decisions, both players', in order. */
  acts: StreetAct[];
}

function scaleNode(node: SolvedNode, k: number): SolvedNode {
  return {
    ...node,
    pot: node.pot * k,
    toCall: node.toCall * k,
    behind: node.behind * k,
    actions: node.actions.map((a) => ({ ...a, amount: a.amount * k, to: a.to * k })),
  };
}

/** Pot and each seat's stack behind at the flop, bb. */
function flopMoney(hand: PhfHand, context: StatsContext, seats: readonly number[]): { pot: number; behind: number[] } | null {
  const bb = Math.max(1, hand.game.bigBlind);
  const acts = streetActs(hand, "flop");
  let pot = acts[0]?.pot ?? null;
  const put = new Map<number, number>();
  let potChips = 0;
  for (const action of hand.actions) {
    if (action.street !== "preflop") continue;
    if (action.seat === null || ["collect", "cashout-pay", "cashout-choose", "show", "muck"].includes(action.type)) continue;
    potChips += action.amount;
    put.set(action.seat, (put.get(action.seat) ?? 0) + (action.type === "uncalled" ? -Math.abs(action.amount) : action.amount));
  }
  pot ??= potChips / bb;
  const behind = seats.map((seat) => ((context.players.get(seat)?.startingStack ?? 0) - (put.get(seat) ?? 0)) / bb);
  return pot > 0 ? { pot, behind } : null;
}

/**
 * A hand's entry into the library: the chunk it reads and the solve in the
 * hand's own terms, or why not. `hero` is the hero's seat.
 */
export function libraryEntry(
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  charts: ChartSet | null,
  library: FlopLibrary | null | undefined,
): FlopEntry | { ok: false; reason: FlopMiss } {
  if (!library || !charts) return { ok: false, reason: "no-library" };
  const pair = flopPair(context);
  if (!pair || !pair.includes(hero)) return { ok: false, reason: "not-heads-up" };
  const villain = pair[0] === hero ? pair[1] : pair[0];
  const want = chunkFor(hand, context, charts, library);
  if (!want) return { ok: false, reason: chartLineOf(hand, pair, charts) ? "no-chunk" : "line" };
  const chunk = library.get(want.set, want.line.id, want.flop);
  if (!chunk) return { ok: false, reason: "no-chunk" };
  const { header } = chunk;
  // The ranges the chunk was solved from must be the ones this hand's set gives (its model hash).
  const answered = chartLineOf(hand, pair, charts)?.set;
  if (!answered || header.charts.id !== answered.id || header.charts.hash !== answered.model.hash) {
    return { ok: false, reason: "charts-differ" };
  }

  // Both preflop ranges, as the walk reads them (`rangeWalk.ts`): the charts' for each line.
  const firstPostflop = hand.actions.find((a) => a.street !== "preflop" && a.street !== "showdown");
  const cut = firstPostflop?.index ?? Number.MAX_SAFE_INTEGER;
  const heroChart = chartRange(hand, hero, cut, charts);
  const villainChart = chartRange(hand, villain, cut, charts);
  if (!heroChart || !villainChart) return { ok: false, reason: "ranges" };

  const heroPos = context.position.get(hero) as ChartPosition | undefined;
  const villainPos = context.position.get(villain) as ChartPosition | undefined;
  const heroFirst = heroPos !== undefined && villainPos !== undefined ? POSTFLOP.indexOf(heroPos) < POSTFLOP.indexOf(villainPos) : true;
  const money = flopMoney(hand, context, [hero, villain]);
  if (!money) return { ok: false, reason: "depth" };
  const stackBb = Math.min(money.behind[0], money.behind[1]);
  const spr = stackBb / money.pot;
  const solvedSpr = header.stack / header.pot;
  if (!(spr > 0) || Math.abs(spr / solvedSpr - 1) > SPR_TOLERANCE) return { ok: false, reason: "depth" };

  const board = toIndices(hand.board.runouts[0]?.flop ?? []);
  const lib = chunk.result;
  const libBoard = toIndices(lib.board);
  const k = money.pot / header.pot;
  // Real suits -> the chunk's (exact) and back.
  const perm = canonicalBoard(board).perm;
  const tables = bucketTables(lib, libBoard);
  const libIndex = [0, 1].map((p) => {
    const at = new Int32Array(NUM_COMBOS).fill(-1);
    lib.hands[p].forEach((combo, i) => {
      at[combo] = i;
    });
    return at;
  });

  // Each player's hands: the real range on the real flop (player 0 out of position).
  const realRanges = [comboRange(heroChart.range), comboRange(villainChart.range)];
  const ordered = heroFirst ? realRanges : [realRanges[1], realRanges[0]];
  const heroIndex = heroFirst ? 0 : 1;
  const heroCards = context.players.get(hero)?.holeCards ?? [];
  let heroCombo = -1;
  try {
    const cards = toIndices(heroCards);
    if (cards.length === 2) heroCombo = comboIndex(cards[0], cards[1]);
  } catch {
    heroCombo = -1;
  }
  const hands: [Uint16Array, Uint16Array] = [new Uint16Array(0), new Uint16Array(0)];
  const weights: [Float32Array, Float32Array] = [new Float32Array(0), new Float32Array(0)];
  const source: [Int32Array, Int32Array] = [new Int32Array(0), new Int32Array(0)];
  const buckets: [string[], string[]] = [[], []];
  const bucketed: [Uint8Array, Uint8Array] = [new Uint8Array(0), new Uint8Array(0)];
  for (const p of [0, 1] as const) {
    const combos: number[] = [];
    for (let c = 0; c < NUM_COMBOS; c += 1) {
      const blocked = board.includes(comboHi(c)) || board.includes(comboLo(c));
      if (blocked) continue;
      if (ordered[p][c] > 0 || (p === heroIndex && c === heroCombo)) combos.push(c);
    }
    hands[p] = Uint16Array.from(combos);
    weights[p] = Float32Array.from(combos, (c) => ordered[p][c]);
    source[p] = Int32Array.from(combos, (c) => (want.exact ? libIndex[p][permuteCombo(c, perm)] : -1));
    buckets[p] = combos.map((c) => flopBucket([comboHi(c), comboLo(c)], board));
    bucketed[p] = Uint8Array.from(source[p], (s) => (s < 0 ? 1 : 0));
  }

  const nodes: SolvedNode[] = lib.nodes.map((node, index) => {
    if (node.kind !== "action") return { ...scaleNode(node, k), labels: [], children: node.children.map(() => -1) };
    const p = node.player;
    const n = hands[p].length;
    const m = lib.hands[p].length;
    const count = node.actions.length;
    const strategy = new Float32Array(count * n);
    const ev = new Float32Array(count * n);
    const table = tables[index] as BucketTable;
    for (let i = 0; i < n; i += 1) {
      const j = source[p][i];
      if (j >= 0) {
        for (let a = 0; a < count; a += 1) {
          strategy[a * n + i] = node.strategy[a * m + j];
          ev[a * n + i] = node.ev[a * m + j] * k;
        }
        continue;
      }
      const row = bucketRow(table, buckets[p][i]);
      for (let a = 0; a < count; a += 1) {
        strategy[a * n + i] = row ? row[1 + a] / row[0] : 1 / count;
        ev[a * n + i] = row ? (row[1 + count + a] / row[0]) * k : 0;
      }
    }
    return { ...scaleNode(node, k), strategy, ev };
  });

  const result: SolveResult = {
    ...lib,
    board: board.map(cardCode),
    pot: money.pot,
    stack: stackBb,
    hands,
    weights,
    value: [lib.value[0] * k, lib.value[1] * k],
    rootEv: [new Float32Array(hands[0].length), new Float32Array(hands[1].length)],
    nodes,
    scope: "flop",
  };
  return {
    ok: true,
    chunk,
    line: want.line,
    key: want.key,
    flop: want.flop,
    exact: want.exact,
    distance: want.distance,
    result,
    bucketed,
    scale: k,
    heroSeat: hero,
    villainSeat: villain,
    heroFirst,
    potBb: money.pot,
    stackBb,
    board,
    acts: streetActs(hand, "flop"),
  };
}

/** The entry as a solve the line-following code reads (`followSolvedLine`). */
function lineSolve(entry: FlopEntry) {
  return {
    result: entry.result,
    hero: (entry.heroFirst ? 0 : 1) as 0 | 1,
    input: { heroFirst: entry.heroFirst, heroSeat: entry.heroSeat, villainSeat: entry.villainSeat, stackBb: entry.stackBb },
  };
}

/* ------------------------------------------------------- narrowing - */

/** The narrowing model id of a hand whose flop reads the library. */
export const LIBRARY_MODEL = `floplib:${FLOP_PROFILE.tree}`;

export interface LibraryModel extends NarrowingModel {
  /** How the flop's actions were narrowed: every one by the library, some, or none. */
  flopSource(): "library" | "mixed" | "heuristic";
}

/**
 * The narrowing model of a hand that reads the library: on the flop, the
 * likelihood of an action is the solved strategy at the node the line has
 * reached (`L(c) = strategy[edge][c]`, the translation's mix for a size
 * between two of the tree's); where the line leaves the tree (a size more
 * than `OFF_TREE_DISTANCE` from any, a re-raise the tree has not), and on
 * later streets, `fallback`.
 */
export function libraryModel(entry: FlopEntry, fallback: NarrowingModel = heuristicModel): LibraryModel {
  const acts = entry.acts;
  let library = 0;
  let heuristic = 0;
  const id = `${LIBRARY_MODEL}+${fallback.id}`;
  const likelihood = (input: NarrowInput): Float64Array => {
    if (input.street !== "flop" || input.actionIndex === undefined) return fallback.likelihood(input);
    const k = acts.findIndex((a) => a.index === input.actionIndex);
    const at = k < 0 ? null : nodeOfAct(entry, acts, k);
    if (at === null) {
      heuristic += 1;
      return fallback.likelihood(input);
    }
    const node = entry.result.nodes[at];
    const mapped = mapAct(node, acts[k], entry.stackBb);
    if (!mapped || mapped.distance > OFF_TREE_DISTANCE) {
      heuristic += 1;
      return fallback.likelihood(input);
    }
    library += 1;
    const p = node.player;
    const n = entry.result.hands[p].length;
    const out = new Float64Array(NUM_COMBOS);
    entry.result.hands[p].forEach((combo, i) => {
      let l = 0;
      mapped.edges.forEach((edge, e) => {
        l += mapped.weights[e] * node.strategy[edge * n + i];
      });
      out[combo] = l;
    });
    return out;
  };
  return {
    id,
    likelihood,
    flopSource: () => (heuristic === 0 ? (library > 0 ? "library" : "heuristic") : library > 0 ? "mixed" : "heuristic"),
  };
}

/**
 * The node where the actor of `acts[k]` decides, followed exactly as grading
 * follows a line (`followSolvedLine`: sizes to the likelier side, an
 * opponent's size the solve hardly uses to one it does), or null: off the
 * tree, further than `OFF_TREE_DISTANCE` from it, or a line one of the two
 * ranges reaches under 2% of the time (a strategy there answers a sliver).
 */
function nodeOfAct(entry: FlopEntry, acts: readonly StreetAct[], k: number): number | null {
  const firstSeat = entry.heroFirst ? entry.heroSeat : entry.villainSeat;
  const actor: 0 | 1 = acts[k].seat === firstSeat ? 0 : 1;
  const found = followSolvedLine({ ...lineSolve(entry), hero: actor }, acts.slice(0, k), "flop");
  return found.ok && found.distance <= OFF_TREE_DISTANCE ? found.node : null;
}

/* ---------------------------------------------------------- grading - */

export interface FlopGrade extends GradeResult {
  ok: true;
  options: OptionAnalysis[];
  chosen: number;
  approximations: Approximation[];
  flop: FlopFacts;
}

export type FlopGradeMiss = { ok: false; reason: "flop-off-tree" | "flop-unreached"; detail: string };

const round2 = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Grades the hero's flop decision with action index `actionIndex` from the
 * library: the line before it followed onto the tree, the hero's combo's
 * strategy and EV per option there (combo for combo, or by category), the
 * hero's own size graded as the better of its neighbours, §2's grade.
 */
export function gradeFlop(entry: FlopEntry, actionIndex: number, heroCards: readonly [number, number]): FlopGrade | FlopGradeMiss {
  const acts = entry.acts;
  const at = acts.findIndex((a) => a.index === actionIndex);
  if (at < 0) return { ok: false, reason: "flop-off-tree", detail: "the decision is not on the flop" };
  const solve = lineSolve(entry);
  const found = followSolvedLine(solve, acts.slice(0, at), "flop");
  if (!found.ok) return found;
  const { result } = entry;
  const node = result.nodes[found.node];
  const heroCombo = comboIndex(heroCards[0], heroCards[1]);
  const heroHand = result.hands[solve.hero].indexOf(heroCombo);
  if (heroHand < 0) return { ok: false, reason: "flop-off-tree", detail: "the hero's combo is not in the entry" };
  const options = optionsAt(result, node, heroHand);
  const act = acts[at];
  const mapped = mapAct(node, act, entry.stackBb);
  if (!mapped) return { ok: false, reason: "flop-off-tree", detail: `no ${act.type} for the hero at ${node.path}` };
  const distance = Math.max(found.distance, mapped.distance);
  const offTree = distance > OFF_TREE_DISTANCE;
  const best = gradeMapped(options, mapped, act.pot, offTree);
  if (!best) return { ok: false, reason: "flop-off-tree", detail: "nothing to grade against" };
  const { chosen, graded } = best;

  const bucketedHero = entry.bucketed[solve.hero][heroHand] === 1;
  const outOfRange = !(result.weights[solve.hero][heroHand] > 0);
  const approximations = new Set<Approximation>(["rake-profile", "coarse-river"]);
  if (!entry.exact) approximations.add("flop-mapped");
  if (!entry.exact || bucketedHero) approximations.add("library-bucketed");
  if (outOfRange) approximations.add("out-of-range");
  if (offTree) approximations.add("off-tree-size");
  else if (distance > TRANSLATED_DISTANCE) approximations.add("size-translated");
  if (result.exploitabilityPct > entry.chunk.header.targetPct) approximations.add("solver-unconverged");

  const flop: FlopFacts = {
    source: "library",
    line: entry.line.id,
    flop: entry.flop,
    mapped: !entry.exact,
    distance: round2(entry.distance),
    tree: entry.chunk.header.tree,
    path: node.path,
    iterations: result.iterations,
    exploitabilityPct: round3(result.exploitabilityPct),
    bucket: bucketedHero ? flopBucket(heroCards, entry.board) : null,
    translated: distance > TRANSLATED_DISTANCE ? round3(distance) : null,
    reach: { hero: round3(found.reach.hero), villain: round3(found.reach.villain) },
  };
  return {
    ok: true,
    options,
    chosen,
    approximations: [...approximations].sort(),
    flop,
    grade: graded.grade,
    evLoss: round3(graded.evLoss),
    evLossPot: Number.isFinite(graded.evLossPot) ? round4(graded.evLossPot) : 1,
    freqDiff: round4(graded.freqDiff),
    score: round2(graded.score),
  };
}
