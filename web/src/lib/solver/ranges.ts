/**
 * Both ranges at one decision of a solve (the Solver library's Ranges tab and
 * hand filters, `/solver`): who holds what, what each combo is worth, how
 * much equity it has, and which made hand and draw it is.
 *
 * ```
 * a chunk + a node index
 *   ─▶ nodeRanges: each player's combos with their reach, their EV and what they have in the pot
 *   ─▶ equityTable (once per board) ─▶ rangeEquity: each combo's equity against the other range's reach
 *   ─▶ handFeature: the made hand and the draw of a combo on the board (the filters' categories)
 * ```
 *
 * **EV of both players.** A node stores the actor's EV per action and combo;
 * the actor's EV at the node is their strategy's mix of it. The other
 * player's EV at the node is the EV of the action that brought the hand here,
 * stored at their own decision just above (the actor has not acted since, so
 * it is conditioned on the same range), or the solve's `rootEv` at the root.
 * Right below a dealt card (a full solve's turn and river) it is not stored
 * for the player not acting: `ev` is null there.
 *
 * **EV as a share of the pot.** The solve's EVs are net winnings from the
 * flop with the flop's pot counted as winnable; adding what the player has
 * put in since gives what they take back out of the pot, so the two
 * players' EVs add up to the pot at the node (less rake). That is the EV the
 * Ranges tab shows, and EQR is it over equity times the pot.
 *
 * **Equity.** All-in equity over every runout against the other player's
 * reach at the node, card removal exact. A board's hands are evaluated and
 * sorted once per runout (`equityTable`, ~1,081 runouts on a flop, cached per
 * chunk); each node is then a linear sweep of the two sorted lists, as at a
 * solver's showdown (`cfr.ts`).
 *
 * Pure: no fetch, no React.
 */

import { cardCode, cardIndex, categoryOf, evaluateMasks, STANDARD } from "../equity";
import { comboHi, comboLo } from "./combos";
import type { FlopChunk } from "./flopLibrary";
import { rangesAt } from "./solve";

export interface RangeSide {
  player: 0 | 1;
  /** `header.players[player]`, e.g. `BTN`. */
  position: string;
  /** Combo indices, the solve's order (`result.hands[player]`). */
  hands: Uint16Array;
  /** Reach of each combo at the node, 0..1. */
  reach: Float64Array;
  /** Chips each combo takes back out of the pot, bb (see header); null where not stored. */
  ev: Float64Array | null;
  /** Chips the player has put in since the flop, bb. */
  invested: number;
}

export interface NodeRanges {
  /** The board at the node: the solve's board and any card dealt on the way, card indices. */
  board: number[];
  pot: number;
  actor: 0 | 1;
  /** Indexed by solve player (0 is out of position). */
  sides: [RangeSide, RangeSide];
}

/** Both ranges at a decision of a chunk. */
export function nodeRanges(chunk: FlopChunk, index: number): NodeRanges {
  const { result, header } = chunk;
  const node = result.nodes[index];
  if (!node || node.kind !== "action") throw new RangeError(`node ${index} is not a decision`);
  const actor = node.player as 0 | 1;
  const reach = rangesAt(result, index);

  // Walk to the root: the cards dealt, what each player put in, the other player's last edge.
  const board = result.board.map(cardIndex);
  // A full solve's turn file is a subtree of the flop's solve, its EVs counted from the flop:
  // both put in the same to reach the turn.
  const before = Math.max(0, (result.pot - header.pot) / 2);
  const invested = [before, before];
  let otherEdge: { node: number; edge: number } | null = null;
  let crossedDeal = false;
  for (let at = index; result.nodes[at].parent >= 0; ) {
    const child = result.nodes[at];
    const parent = child.parent;
    if (result.nodes[parent].kind === "chance") {
      board.push(cardIndex(result.nodes[parent].labels[child.parentEdge]));
      // The player not acting has no stored EV below a dealt card.
      if (!otherEdge) crossedDeal = true;
      const deal = result.nodes[parent];
      if (deal.parent < 0) break;
      // The decision that closed the street put in what makes the next street's pot.
      const closer = result.nodes[deal.parent];
      invested[closer.player] += child.pot - closer.pot;
      at = deal.parent;
      continue;
    }
    const decision = result.nodes[parent];
    invested[decision.player] += child.pot - decision.pot;
    if (!otherEdge && !crossedDeal && decision.player !== actor) otherEdge = { node: parent, edge: child.parentEdge };
    at = parent;
  }

  const sideEv = (player: 0 | 1): Float64Array | null => {
    const size = result.hands[player].length;
    const out = new Float64Array(size);
    if (player === actor) {
      const count = node.actions.length;
      for (let i = 0; i < size; i += 1) {
        let v = 0;
        for (let a = 0; a < count; a += 1) v += node.strategy[a * size + i] * node.ev[a * size + i];
        out[i] = v + invested[player];
      }
      return out;
    }
    // A turn file stores no root EV (zeros): the flop's EV is not this turn card's.
    if (index === 0 && result.rootEv?.[player]?.length === size && result.rootEv[player].some((v) => v !== 0)) {
      for (let i = 0; i < size; i += 1) out[i] = result.rootEv[player][i] + invested[player];
      return out;
    }
    if (!otherEdge) return null;
    const above = result.nodes[otherEdge.node];
    for (let i = 0; i < size; i += 1) out[i] = above.ev[otherEdge.edge * size + i] + invested[player];
    return out;
  };

  const side = (player: 0 | 1): RangeSide => ({
    player,
    position: header.players[player],
    hands: result.hands[player],
    reach: reach[player],
    ev: sideEv(player),
    invested: invested[player],
  });
  return { board, pot: node.pot, actor, sides: [side(0), side(1)] };
}

/* ------------------------------------------------------------- equity - */

/** One runout's hands, weakest first. */
interface Runout {
  order: [Uint16Array, Uint16Array];
  strength: [Int32Array, Int32Array];
}

export interface EquityTable {
  board: number[];
  hands: [Uint16Array, Uint16Array];
  runouts: Runout[];
  /** Per player: index of each combo (0..1325) among the *other* player's hands, or -1. */
  inOther: [Int32Array, Int32Array];
}

const tables = new WeakMap<FlopChunk, Map<string, EquityTable>>();

/** The sorted runouts of a board for a chunk's hands. Cached per chunk and board. */
export function equityTable(chunk: FlopChunk, board: readonly number[]): EquityTable {
  let byBoard = tables.get(chunk);
  if (!byBoard) {
    byBoard = new Map();
    tables.set(chunk, byBoard);
  }
  const key = board.join(",");
  let table = byBoard.get(key);
  if (!table) {
    table = buildEquityTable(chunk.result.hands, board);
    byBoard.set(key, table);
  }
  return table;
}

export function buildEquityTable(hands: [Uint16Array, Uint16Array], board: readonly number[]): EquityTable {
  const dead = new Uint8Array(52);
  for (const card of board) dead[card] = 1;
  const rest: number[] = [];
  for (let c = 0; c < 52; c += 1) if (!dead[c]) rest.push(c);
  const missing = 5 - board.length;
  const deals: number[][] = [];
  if (missing === 0) deals.push([]);
  else if (missing === 1) for (const a of rest) deals.push([a]);
  else for (let x = 0; x < rest.length; x += 1) for (let y = x + 1; y < rest.length; y += 1) deals.push([rest[x], rest[y]]);

  const masks = [0, 0, 0, 0];
  for (const card of board) masks[card & 3] |= 1 << (card >> 2);
  const hi = hands.map((h) => Uint8Array.from(h, comboHi)) as [Uint8Array, Uint8Array];
  const lo = hands.map((h) => Uint8Array.from(h, comboLo)) as [Uint8Array, Uint8Array];
  const keys = [new Float64Array(hands[0].length), new Float64Array(hands[1].length)];

  const runouts: Runout[] = deals.map((deal) => {
    const m = masks.slice();
    for (const card of deal) m[card & 3] |= 1 << (card >> 2);
    const sides = [0, 1].map((p) => {
      let n = 0;
      const key = keys[p];
      for (let i = 0; i < hands[p].length; i += 1) {
        const a = hi[p][i];
        const b = lo[p][i];
        if (dead[a] || dead[b] || deal.includes(a) || deal.includes(b)) continue;
        const s = [m[0], m[1], m[2], m[3]];
        s[a & 3] |= 1 << (a >> 2);
        s[b & 3] |= 1 << (b >> 2);
        // Strength above, hand index below: one native sort orders both.
        key[n] = evaluateMasks(STANDARD, s[0], s[1], s[2], s[3]) * 2048 + i;
        n += 1;
      }
      const sorted = key.subarray(0, n).slice().sort();
      const order = new Uint16Array(n);
      const strength = new Int32Array(n);
      for (let k = 0; k < n; k += 1) {
        order[k] = sorted[k] % 2048;
        strength[k] = Math.floor(sorted[k] / 2048);
      }
      return { order, strength };
    });
    return { order: [sides[0].order, sides[1].order], strength: [sides[0].strength, sides[1].strength] };
  });

  const inOther = [0, 1].map((p) => {
    const out = new Int32Array(1326).fill(-1);
    hands[1 - p].forEach((combo, i) => {
      out[combo] = i;
    });
    return out;
  }) as [Int32Array, Int32Array];
  return { board: [...board], hands, runouts, inOther };
}

/**
 * Each combo's equity (0..1) against the other player's reach, per player.
 * NaN for a combo the board blocks or that meets nothing of the other range.
 */
export function rangeEquity(table: EquityTable, reach: [ArrayLike<number>, ArrayLike<number>]): [Float64Array, Float64Array] {
  const out: Float64Array[] = [];
  const lessCard = new Float64Array(52);
  const leqCard = new Float64Array(52);
  const allCard = new Float64Array(52);
  for (const p of [0, 1] as const) {
    const o = (1 - p) as 0 | 1;
    const hands = table.hands[p];
    const other = table.hands[o];
    const w = reach[o];
    const num = new Float64Array(hands.length);
    const den = new Float64Array(hands.length);
    const hiO = Uint8Array.from(other, comboHi);
    const loO = Uint8Array.from(other, comboLo);
    const same = Int32Array.from(hands, (combo) => table.inOther[p][combo]);
    for (const runout of table.runouts) {
      const oOrder = runout.order[o];
      const oStrength = runout.strength[o];
      const pOrder = runout.order[p];
      const pStrength = runout.strength[p];
      allCard.fill(0);
      lessCard.fill(0);
      leqCard.fill(0);
      let all = 0;
      for (let k = 0; k < oOrder.length; k += 1) {
        const j = oOrder[k];
        const v = w[j];
        if (v === 0) continue;
        all += v;
        allCard[hiO[j]] += v;
        allCard[loO[j]] += v;
      }
      let less = 0;
      let leq = 0;
      let kl = 0;
      let ke = 0;
      for (let k = 0; k < pOrder.length; k += 1) {
        const i = pOrder[k];
        const s = pStrength[k];
        while (kl < oOrder.length && oStrength[kl] < s) {
          const j = oOrder[kl];
          const v = w[j];
          less += v;
          lessCard[hiO[j]] += v;
          lessCard[loO[j]] += v;
          kl += 1;
        }
        while (ke < oOrder.length && oStrength[ke] <= s) {
          const j = oOrder[ke];
          const v = w[j];
          leq += v;
          leqCard[hiO[j]] += v;
          leqCard[loO[j]] += v;
          ke += 1;
        }
        const a = comboHi(hands[i]);
        const b = comboLo(hands[i]);
        // The other player's copy of this very combo holds both cards: subtracted twice, added back once.
        const twin = same[i] >= 0 ? w[same[i]] : 0;
        const total = all - allCard[a] - allCard[b] + twin;
        if (total <= 0) continue;
        const win = less - lessCard[a] - lessCard[b];
        const winTie = leq - leqCard[a] - leqCard[b] + twin;
        num[i] += win + (winTie - win) / 2;
        den[i] += total;
      }
    }
    out.push(num.map((x, i) => (den[i] > 0 ? x / den[i] : Number.NaN)));
  }
  return [out[0], out[1]];
}

/* ---------------------------------------------------------- categories - */

/** Made hands, strongest first: the filters list them in this order. */
export const MADE_HANDS = [
  "straightFlush",
  "quads",
  "fullHouse",
  "flush",
  "straight",
  "set",
  "trips",
  "twoPair",
  "overpair",
  "topPair",
  "secondPair",
  "thirdPair",
  "weakPair",
  "underpair",
  "aceHigh",
  "kingHigh",
  "nothing",
] as const;
export type MadeHand = (typeof MADE_HANDS)[number];

/** Draws, strongest first; a combo has the first that applies. None on the river. */
export const DRAWS = ["comboDraw", "flushDraw", "oesd", "gutshot", "bdfd2", "bdfd1", "bdsd", "noDraw"] as const;
export type Draw = (typeof DRAWS)[number];

export const EQ_BUCKETS = ["best", "good", "weak", "trash"] as const;
export type EqBucket = (typeof EQ_BUCKETS)[number];
/** Lower edge of each simple bucket. */
const EQ_BUCKET_FROM = [0.75, 0.5, 0.33, 0];

export const EQ_BANDS = ["90", "80", "70", "60", "50", "25", "0"] as const;
export type EqBand = (typeof EQ_BANDS)[number];

export function eqBucket(equity: number): number {
  return EQ_BUCKET_FROM.findIndex((from) => equity >= from);
}

export function eqBand(equity: number): number {
  return EQ_BANDS.findIndex((from) => equity * 100 >= Number(from));
}

/** Rank masks with the ace also low, for straights. */
function straightTop(mask: number): number {
  const m = (mask << 1) | ((mask >> 12) & 1);
  for (let top = 13; top >= 4; top -= 1) {
    const window = 0b11111 << (top - 4);
    if ((m & window) === window) return top;
  }
  return 0;
}

/** Ranks that complete a straight with the hole cards in it (the board alone does not). */
function straightOuts(own: number, boardMask: number): number {
  let outs = 0;
  for (let r = 0; r < 13; r += 1) {
    const bit = 1 << r;
    if (own & bit && boardMask & bit) continue;
    if (straightTop(own | bit) && !straightTop(boardMask | bit)) outs += 1;
  }
  return outs;
}

/** Two-card completions of a backdoor straight that need the hole cards. */
function backdoorStraights(own: number, boardMask: number): number {
  let count = 0;
  for (let r = 0; r < 13; r += 1) {
    for (let q = r + 1; q < 13; q += 1) {
      const bits = (1 << r) | (1 << q);
      if (own & bits) continue;
      if (straightTop(own | bits) && !straightTop(boardMask | bits)) count += 1;
    }
  }
  return count;
}

export interface HandFeature {
  made: number;
  /** -1 on the river. */
  draw: number;
}

/** The made hand and the draw of two hole cards on a board (card indices). */
export function handFeature(c1: number, c2: number, board: readonly number[]): HandFeature {
  const s = [0, 0, 0, 0];
  const boardSuits = [0, 0, 0, 0];
  let boardMask = 0;
  for (const card of board) {
    s[card & 3] |= 1 << (card >> 2);
    boardSuits[card & 3] += 1;
    boardMask |= 1 << (card >> 2);
  }
  s[c1 & 3] |= 1 << (c1 >> 2);
  s[c2 & 3] |= 1 << (c2 >> 2);
  const category = categoryOf(evaluateMasks(STANDARD, s[0], s[1], s[2], s[3]));
  const r1 = c1 >> 2;
  const r2 = c2 >> 2;
  const hiRank = Math.max(r1, r2);
  const boardRanks: number[] = [];
  for (let r = 12; r >= 0; r -= 1) if (boardMask & (1 << r)) boardRanks.push(r);
  const boardCount = (rank: number) => board.filter((card) => card >> 2 === rank).length;
  const pocket = r1 === r2;

  const highCard = (): number =>
    MADE_HANDS.indexOf(hiRank === 12 ? "aceHigh" : hiRank === 11 ? "kingHigh" : "nothing");
  const pairOf = (rank: number): number => {
    const at = boardRanks.indexOf(rank);
    return MADE_HANDS.indexOf(at === 0 ? "topPair" : at === 1 ? "secondPair" : at === 2 ? "thirdPair" : "weakPair");
  };
  const pocketPair = (): number => {
    const below = boardRanks.filter((r) => r > r1).length;
    if (below === 0) return MADE_HANDS.indexOf("overpair");
    if (below === boardRanks.length) return MADE_HANDS.indexOf("underpair");
    return MADE_HANDS.indexOf(below === 1 ? "secondPair" : below === 2 ? "thirdPair" : "weakPair");
  };
  /** A pair made with a hole card, or none (the board's own pair does not count). */
  const pairs = (): number => {
    if (pocket) return pocketPair();
    const paired = [r1, r2].filter((r) => boardMask & (1 << r)).sort((a, b) => b - a);
    return paired.length ? pairOf(paired[0]) : highCard();
  };

  let made: number;
  switch (category) {
    case "straight-flush":
      made = MADE_HANDS.indexOf("straightFlush");
      break;
    case "quads":
      made = MADE_HANDS.indexOf("quads");
      break;
    case "full-house":
      made = MADE_HANDS.indexOf("fullHouse");
      break;
    case "flush":
      made = MADE_HANDS.indexOf("flush");
      break;
    case "straight":
      made = straightTop(boardMask) ? pairs() : MADE_HANDS.indexOf("straight");
      break;
    case "trips":
      made = pocket && boardMask & (1 << r1)
        ? MADE_HANDS.indexOf("set")
        : [r1, r2].some((r) => boardCount(r) >= 2)
          ? MADE_HANDS.indexOf("trips")
          : pairs();
      break;
    case "two-pair":
      made = !pocket && r1 !== r2 && boardMask & (1 << r1) && boardMask & (1 << r2) ? MADE_HANDS.indexOf("twoPair") : pairs();
      break;
    case "pair":
      made = pairs();
      break;
    default:
      made = highCard();
  }

  if (board.length >= 5) return { made, draw: -1 };
  const madeName = MADE_HANDS[made];
  const own = boardMask | (1 << r1) | (1 << r2);
  const flushDraw =
    madeName !== "flush" && madeName !== "straightFlush" && [c1 & 3, c2 & 3].some((suit) => boardSuits[suit] + countSuit(c1, c2, suit) === 4);
  const outs = madeName === "straight" || madeName === "straightFlush" ? 0 : straightOuts(own, boardMask);
  let draw: Draw;
  if (flushDraw && outs > 0) draw = "comboDraw";
  else if (flushDraw) draw = "flushDraw";
  else if (outs >= 2) draw = "oesd";
  else if (outs === 1) draw = "gutshot";
  else if (board.length === 3 && (c1 & 3) === (c2 & 3) && boardSuits[c1 & 3] === 1) draw = "bdfd2";
  else if (board.length === 3 && [c1 & 3, c2 & 3].some((suit) => boardSuits[suit] === 2 && countSuit(c1, c2, suit) === 1)) draw = "bdfd1";
  else if (board.length === 3 && backdoorStraights(own, boardMask) >= 3) draw = "bdsd";
  else draw = "noDraw";
  return { made, draw: DRAWS.indexOf(draw) };
}

function countSuit(c1: number, c2: number, suit: number): number {
  return ((c1 & 3) === suit ? 1 : 0) + ((c2 & 3) === suit ? 1 : 0);
}

/** Every combo's feature for a list of combos on a board. */
export function handFeatures(hands: Uint16Array, board: readonly number[]): HandFeature[] {
  return Array.from(hands, (combo) => handFeature(comboHi(combo), comboLo(combo), board));
}

/* -------------------------------------------------------------- filter - */

/**
 * The hand filter: groups of categories. A combo passes when, in every group
 * with an included category, it is one of them, and it is none of the
 * excluded ones. Suits are one group: `o` an offsuit combo holding the suit,
 * `s` a suited one of it (in the suits the board is shown in).
 */
export interface HandFilter {
  include: readonly string[];
  exclude: readonly string[];
}

export const EMPTY_FILTER: HandFilter = { include: [], exclude: [] };

export function filterActive(filter: HandFilter): boolean {
  return filter.include.length > 0 || filter.exclude.length > 0;
}

export type FilterGroup = "made" | "draw" | "eq" | "band" | "suit";

/** `made:topPair`, `draw:oesd`, `eq:best`, `band:90`, `suit:os` / `suit:ss`. */
export function filterId(group: FilterGroup, value: string): string {
  return `${group}:${value}`;
}

/** The ids a combo is: one per group (two for suits: the suit of each card). */
export function comboIds(cards: string, feature: HandFeature, equity: number): string[] {
  const ids = [filterId("made", MADE_HANDS[feature.made])];
  if (feature.draw >= 0) ids.push(filterId("draw", DRAWS[feature.draw]));
  if (!Number.isNaN(equity)) {
    ids.push(filterId("eq", EQ_BUCKETS[eqBucket(equity)]), filterId("band", EQ_BANDS[eqBand(equity)]));
  }
  const a = cards[1];
  const b = cards[3];
  if (a === b) ids.push(filterId("suit", `s${a}`));
  else ids.push(filterId("suit", `o${a}`), filterId("suit", `o${b}`));
  return ids;
}

/** Whether a combo with these ids passes the filter. */
export function passes(filter: HandFilter, ids: readonly string[]): boolean {
  if (filter.exclude.some((id) => ids.includes(id))) return false;
  const groups = new Set(filter.include.map((id) => id.slice(0, id.indexOf(":"))));
  for (const group of groups) {
    const wanted = filter.include.filter((id) => id.startsWith(`${group}:`));
    if (!wanted.some((id) => ids.includes(id))) return false;
  }
  return true;
}

/** A combo's two cards as text, higher first, e.g. `AhKh`. */
export function comboText(combo: number): string {
  return `${cardCode(comboHi(combo))}${cardCode(comboLo(combo))}`;
}
