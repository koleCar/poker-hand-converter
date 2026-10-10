/**
 * The turn realisation measurement (`analysis/16`, `TURN_REALISATION` in
 * `lib/analysis/multiway.ts`): the flop's (`realisation.ts`) one street
 * later, on Rail's own heads-up turn solves.
 *
 * **The corpus.** Every chunk of the flop library ends its flop in a few
 * places with chips behind - checked through, a bet called, a raise called -
 * and at each the solve's own reach gives both ranges as the turn comes.
 * Each such place with at least `MIN_LINE_REACH` of both ranges reaching it
 * is dealt one turn card (fixed by a hash of the flop, line and path, so the
 * corpus is the same on every run) and solved with A5a's turn solver as the
 * analysis solves a hand's turn (`TURN_PROFILE`'s menus, caps, target,
 * iterations and DCFR; suit isomorphism; ranges symmetrised then pruned),
 * plus a third of a pot to the bet menu (`MEASURE_TURN_MENU`): the owner's
 * multiway turn bets are a third to a pot, and a tree with one size would
 * measure only a call of 75%.
 *
 * **The measurement.** At every turn node facing a bet or a raise (a node
 * with a call and a fold), every `SAMPLE_EVERY`-th combo of the actor's range
 * gives the solve's `EV(call) − EV(fold) + toCall` against its exact equity
 * (every river card, card removal exact: `nodeEquities` over `runouts(…, 1)`)
 * times the raked pot after the call - the same `Sample` as the flop's, so
 * `fitRealisation` and `agreement` are the flop's too.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FLOP_LINES, FLOP_LINES_9MAX, FLOP_PROFILE } from "../../../frontend/src/lib/analysis/flopLibrary.js";
import { flopRealisationCategory } from "../../../frontend/src/lib/analysis/multiway.js";
import { pruned, toCombos } from "../../../frontend/src/lib/analysis/river.js";
import { toIndices } from "../../../frontend/src/lib/analysis/texture.js";
import {
  TURN_ALLIN_THRESHOLD,
  TURN_CHECK_EVERY,
  TURN_CHECK_FROM,
  TURN_DCFR,
  TURN_MIN_BET,
  TURN_PROFILE,
} from "../../../frontend/src/lib/analysis/turn.js";
import {
  comboHi,
  comboLo,
  decodeChunk,
  NUM_COMBOS,
  rangesAt,
  solveTurn,
  spotSymmetries,
  symmetrize,
  type BetMenu,
  type FlopChunk,
  type SolveResult,
} from "../../../frontend/src/lib/solver/index.js";
import { nodeEquities, runouts, SAMPLE_EVERY, MIN_SHARE, type Sample } from "./realisation.js";

/** A flop ending this share of either player's flop range reaches (or more) is a turn spot. */
export const MIN_LINE_REACH = 0.03;

/**
 * A category enters the table only with at least this much weight (in nodes):
 * the rest - a set, trips, two pair or a straight with a draw - read their
 * no-draw row, as `turnRealisation` does, which keeps the table small.
 */
export const MIN_ROW_NODES = 50;

/** The table from a fit: the rows with `MIN_ROW_NODES` or more, rounded to three places. */
export function smallTable(fit: ReadonlyMap<string, { r: number; weight: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, { r, weight }] of [...fit].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (weight >= MIN_ROW_NODES) out[key] = Math.round(r * 1000) / 1000;
  }
  return out;
}

/** A table's factor for a sample key, with `turnRealisation`'s fallbacks (the no-draw row, then the position's). */
export function tableFactor(table: Readonly<Record<string, number>>, position: Readonly<Record<string, number>>, key: string): number {
  const [pos, made] = key.split("|");
  return table[key] ?? table[`${pos}|${made}|nd`] ?? position[pos] ?? 1;
}

/** The turn bet menu measured on: A5a's 75% and all-in, plus a third of a pot. */
export const MEASURE_TURN_MENU: Readonly<BetMenu> = { ...TURN_PROFILE.menu, bet: [0.33, ...TURN_PROFILE.menu.bet] };

const hashOf = (text: string) => {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
};

/** One turn the corpus solves: a flop ending of a chunk, dealt a turn card. */
export interface LibraryTurn {
  set: string;
  line: string;
  flop: string;
  /** The flop line that ended here, e.g. `X-B1.82-C`. */
  path: string;
  /** Flop board plus the turn card (indices). */
  board: number[];
  turn: number;
  pot: number;
  stack: number;
  /** Out of position first, 1,326 weights each, the turn card's combos removed. */
  ranges: [Float64Array, Float64Array];
  rake: { name: string; percent: number; cap: number };
  /** Held-out split: the flop's name hash, as the flop measurement. */
  train: boolean;
}

/** The flop endings of a chunk with chips behind, each dealt its turn card. */
export function libraryTurns(chunk: FlopChunk, set: string): LibraryTurn[] {
  const result = chunk.result;
  const flop = toIndices(result.board);
  const totals = result.weights.map((w) => w.reduce((s, v) => s + v, 0));
  const out: LibraryTurn[] = [];
  result.nodes.forEach((node, index) => {
    if (node.kind !== "chance" || node.street !== "turn" || index === 0) return;
    const parent = result.nodes[node.parent];
    const label = parent.labels[node.parentEdge];
    // The pot and stack as the turn comes: a check closes the street as it was, a call adds the call.
    const called = label === "C";
    const pot = parent.pot + (called ? parent.toCall : 0);
    const stack = parent.behind - (called ? parent.toCall : 0);
    if (!(stack > 0)) return;
    const reach = rangesAt(result, index);
    const share = reach.map((r, p) => r.reduce((s, v) => s + v, 0) / totals[p]);
    if (share.some((s) => !(s >= MIN_LINE_REACH))) return;
    const unseen: number[] = [];
    for (let c = 0; c < 52; c += 1) if (!flop.includes(c)) unseen.push(c);
    const pick = unseen[Math.abs(hashOf(`${chunk.header.line}|${chunk.header.flop}|${node.path}`)) % unseen.length];
    const ranges = [0, 1].map((p) => {
      const range = toCombos(result, p as 0 | 1, reach[p]);
      for (let c = 0; c < NUM_COMBOS; c += 1) if (comboHi(c) === pick || comboLo(c) === pick) range[c] = 0;
      return range;
    }) as [Float64Array, Float64Array];
    out.push({
      set,
      line: chunk.header.line,
      flop: chunk.header.flop,
      path: node.path,
      board: [...flop, pick],
      turn: pick,
      pot,
      stack,
      ranges,
      rake: chunk.header.rake,
      train: (hashOf(chunk.header.flop) & 1) === 0,
    });
  });
  return out;
}

/** Solves a corpus turn as A5a solves a hand's turn, on `MEASURE_TURN_MENU`. */
export function solveLibraryTurn(spot: LibraryTurn, menu: Readonly<BetMenu> = MEASURE_TURN_MENU): SolveResult {
  const group = spotSymmetries(spot.board, spot.ranges);
  const ranges = spot.ranges.map((r) => pruned(symmetrize(r, group))) as [Float64Array, Float64Array];
  return solveTurn(
    {
      board: spot.board,
      ranges,
      pot: spot.pot,
      stack: spot.stack,
      firstToAct: 0,
      menus: [menu, menu],
      riverMenus: [TURN_PROFILE.riverMenu, TURN_PROFILE.riverMenu],
      raiseCap: TURN_PROFILE.raiseCap,
      riverRaiseCap: TURN_PROFILE.riverRaiseCap,
      allInThreshold: TURN_ALLIN_THRESHOLD,
      minBet: TURN_MIN_BET,
      rake: { percent: spot.rake.percent, cap: spot.rake.cap },
      bigBlind: 1,
      isomorphism: true,
    },
    {
      maxIterations: TURN_PROFILE.maxIterations,
      targetExploitability: TURN_PROFILE.targetPct,
      checkEvery: TURN_CHECK_EVERY,
      checkFrom: TURN_CHECK_FROM,
      dcfr: TURN_DCFR,
      nodes: "turn",
    },
  );
}

/** The samples of one solved turn: the flop's `Sample`, at turn nodes facing a bet. Player 1 is in position. */
export function turnSamples(result: SolveResult, spot: Pick<LibraryTurn, "line" | "train" | "rake">): Sample[] {
  const board = toIndices(result.board);
  const hands = result.hands;
  const pre = runouts(board, hands, 1);
  const out: Sample[] = [];
  result.nodes.forEach((node, index) => {
    if (node.kind !== "action" || node.toCall <= 0 || node.street !== "turn") return;
    const callEdge = node.actions.findIndex((a) => a.kind === "call");
    const foldEdge = node.actions.findIndex((a) => a.kind === "fold");
    if (callEdge < 0 || foldEdge < 0) return;
    // A call that puts the caller all-in ends the betting: it realises its
    // equity exactly (R = 1, measured), and the analysis applies no factor there.
    if (node.toCall >= node.behind - 1e-9) return;
    const p = node.player as 0 | 1;
    const reach = rangesAt(result, index);
    const n = hands[p].length;
    let total = 0;
    for (let i = 0; i < n; i += 1) total += reach[p][i];
    if (!(total > 0)) return;
    const equities = nodeEquities(pre, hands, p, reach[1 - p]);
    const after = node.pot + node.toCall;
    const raked = after - Math.min(after * spot.rake.percent, spot.rake.cap);
    const position = p === 1 ? "ip" : "oop";
    for (let i = 0; i < n; i += SAMPLE_EVERY) {
      const w = reach[p][i] / total;
      if (!(w > MIN_SHARE)) continue;
      let raise: Sample["raise"] = null;
      node.actions.forEach((_, k) => {
        if (k === callEdge || k === foldEdge) return;
        const e = node.ev[k * n + i] / node.pot;
        const f = node.strategy[k * n + i];
        raise = raise ? { f: raise.f + f, e: Math.max(raise.e, e) } : { f, e };
      });
      const combo = hands[p][i];
      const evCall = node.ev[callEdge * n + i] / node.pot;
      const evFold = node.ev[foldEdge * n + i] / node.pot;
      out.push({
        line: spot.line,
        key: `${position}|${flopRealisationCategory([comboHi(combo), comboLo(combo)], board)}`,
        train: spot.train,
        w,
        x: (equities[i] * raked) / node.pot,
        y: evCall - evFold + node.toCall / node.pot,
        toCall: node.toCall / node.pot,
        fold: { f: node.strategy[foldEdge * n + i], e: evFold },
        call: { f: node.strategy[callEdge * n + i], e: evCall },
        raise,
      });
    }
  });
  return out;
}

/** The chunk files of the sets under `dir`, in a fixed order; `shard` = [k, n] keeps every n-th from the k-th. */
export function corpusFiles(dir: string, sets: readonly string[], shard: [number, number] = [0, 1]): Array<{ set: string; id: string; path: string }> {
  const out: Array<{ set: string; id: string; path: string }> = [];
  let k = 0;
  for (const set of sets) {
    const root = join(dir, set, FLOP_PROFILE.tree);
    if (!existsSync(root)) continue;
    for (const line of readdirSync(root).sort()) {
      if (line.endsWith(".json")) continue;
      for (const file of readdirSync(join(root, line)).sort()) {
        if (!file.endsWith(".bin")) continue;
        if (k % shard[1] === shard[0]) out.push({ set, id: `${set}/${line}/${file}`, path: join(root, line, file) });
        k += 1;
      }
    }
  }
  return out;
}

/** The corpus turns of one chunk file. */
export function fileTurns(file: { set: string; path: string }): LibraryTurn[] {
  const bytes = readFileSync(file.path);
  return libraryTurns(decodeChunk(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), file.set);
}

/* ------------------------------------------------------- sample files - */

/** Fields per sample in a shard file (Float32): key, line, train, w, x, y, toCall, fold f/e, call f/e, raise f/e (NaN: none). */
const FIELDS = 13;

const MADE = ["fh+", "flush", "straight", "set", "trips", "two-pair", "overpair", "tp-top", "tp-good", "tp-weak", "middle", "weak", "ace-high", "nothing"];
/** Every realisation key, in a fixed order: a shard file stores the index. */
export const SAMPLE_KEYS: readonly string[] = ["ip", "oop"].flatMap((pos) => MADE.flatMap((made) => [`${pos}|${made}|d`, `${pos}|${made}|nd`]));
/** Every line id of the library, in a fixed order. */
export const SAMPLE_LINES: readonly string[] = [...new Set([...FLOP_LINES, ...FLOP_LINES_9MAX].map((line) => line.id))];

/** Packs samples for a shard file (Float32, `FIELDS` each). */
export function packSamples(samples: readonly Sample[]): Float32Array {
  const index = (list: readonly string[], v: string) => {
    const i = list.indexOf(v);
    if (i < 0) throw new RangeError(`unknown ${v}`);
    return i;
  };
  const data = new Float32Array(samples.length * FIELDS);
  samples.forEach((s, j) => {
    data.set(
      [
        index(SAMPLE_KEYS, s.key),
        index(SAMPLE_LINES, s.line),
        s.train ? 1 : 0,
        s.w,
        s.x,
        s.y,
        s.toCall,
        s.fold.f,
        s.fold.e,
        s.call.f,
        s.call.e,
        s.raise ? s.raise.f : Number.NaN,
        s.raise ? s.raise.e : Number.NaN,
      ],
      j * FIELDS,
    );
  });
  return data;
}

export function unpackSamples(data: Float32Array): Sample[] {
  const out: Sample[] = [];
  for (let j = 0; j + FIELDS <= data.length; j += FIELDS) {
    const d = data.subarray(j, j + FIELDS);
    out.push({
      key: SAMPLE_KEYS[d[0]],
      line: SAMPLE_LINES[d[1]],
      train: d[2] === 1,
      w: d[3],
      x: d[4],
      y: d[5],
      toCall: d[6],
      fold: { f: d[7], e: d[8] },
      call: { f: d[9], e: d[10] },
      raise: Number.isNaN(d[11]) ? null : { f: d[11], e: d[12] },
    });
  }
  return out;
}
