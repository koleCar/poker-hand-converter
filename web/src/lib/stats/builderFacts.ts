/**
 * What the filter builder reads of a hand beyond its counters: the hero's
 * bet sizes, what the hero made and drew to on each street, who was in the
 * pot against the hero and whether the hero had position, the tournament's
 * buy-in, bounty and level, and who was caught bluffing.
 *
 * A port of the desktop's `core/rail-store/src/facts.rs` (`derive`), line for
 * line, so the web's builder filters mean what the app's mean (2026-11-16,
 * the owner: one filter everywhere). The two are held equal over the whole
 * golden corpus: `npm run golden:emit` writes these facts to
 * `testdata/golden-facts/`, and `core/rail-store/tests/facts_corpus.rs`
 * derives the Rust ones from the same hands and compares.
 *
 * Integer arithmetic as Rust does it: a division truncates toward zero.
 *
 * Nothing here is a statistic: these are a hand's facts - a size, a hand
 * category - the way the list's board and result are.
 */

import type { PhfHand, Position } from "../phf/types";
import { primaryBoard } from "../phf/types";
import { effectiveFirstActionBb } from "./events";
import type { StatsRow } from "./mapping";

/**
 * The facts' version (`hand_facts.facts_version`). Bumped when a fact's
 * meaning changes: every stored hand is then derived again (the rebuild
 * route, `hands_needing_stats`' `p_facts_version`). `facts/2`: the effective
 * stack (docs/ANALYTICS.md Step 11).
 */
export const FACTS_VERSION = "facts/2" as const;

/** The builder's facts of one hand (`facts::HandExtras`). */
export interface BuilderFacts {
  /** The hero's open preflop, tenths of a big blind (the size raised to). */
  openTenths: number | null;
  /** The hero's first bet or raise on the flop, turn, river, percent of the pot. */
  betPct: [number | null, number | null, number | null];
  /** What the hero made on the flop, turn, river ({@link MADE} indexes). */
  made: [number | null, number | null, number | null];
  /** A top pair's kicker per street: 1 top, 2 good, 3 weak. */
  kicker: [number | null, number | null, number | null];
  /** What the hero drew to on the flop and turn ({@link DRAWS} bits). */
  draws: [number, number];
  /** Players who saw the flop, the hero among them. */
  playersFlop: number;
  /** The hero saw the flop and acted last on it, or not; null when the hero did not see it. */
  heroIp: boolean | null;
  /** The opponents in the pot (put money in, or saw the flop): seats and positions, spaces around each. */
  vsSeats: string;
  vsPositions: string;
  /** The tournament's buy-in in cents of its unit (prize pool, bounty and fee together). */
  buyInCents: number | null;
  bounty: boolean;
  level: number | null;
  /** Caught bluffing: the hero's streets, then any opponent's (1 flop, 2 turn, 4 river). */
  bluff: [number, number];
  /**
   * The hero's effective stack at its first preflop action, tenths of the
   * largest forced blind (`effectiveFirstActionBb` / 100, rounded down): the
   * Effective stack filter's (docs/ANALYTICS.md Step 11).
   */
  effStack: number | null;
}

/** A hero's made hand, weakest first; stored as its index. */
export const MADE = [
  "highCard",
  "underpair",
  "bottomPair",
  "middlePair",
  "topPair",
  "overpair",
  "twoPair",
  "trips",
  "set",
  "straight",
  "flush",
  "fullHouse",
] as const;
type Made = (typeof MADE)[number];

/** What a hero draws to, as bits. */
export const DRAWS = ["flushDraw", "nutFlushDraw", "oesd", "gutshot", "comboDraw", "backdoorFlush"] as const;
type Draw = (typeof DRAWS)[number];

const RANKS = "23456789TJQKA";

interface Card {
  /** 2 ... 14 (an ace is 14). */
  rank: number;
  suit: number;
}

function card(text: string): Card | null {
  if (text.length < 2) return null;
  const r = RANKS.indexOf(text[0].toUpperCase());
  if (r < 0) return null;
  const suit = { s: 0, h: 1, d: 2, c: 3 }[text[1].toLowerCase()];
  if (suit === undefined) return null;
  return { rank: r + 2, suit };
}

function cardsOf(texts: readonly string[]): Card[] {
  return texts.map(card).filter((c): c is Card => c !== null);
}

const madeIndex = (name: Made): number => MADE.indexOf(name);
const drawBit = (name: Draw): number => 1 << DRAWS.indexOf(name);

/** Ranks present (an ace also as 1), as a bit set over 1 ... 14. */
function rankBits(cards: readonly Card[]): number {
  let bits = 0;
  for (const c of cards) {
    bits |= 1 << c.rank;
    if (c.rank === 14) bits |= 1 << 1;
  }
  return bits;
}

/** A straight in these ranks (five in a row, the wheel too). */
function hasStraight(bits: number): boolean {
  for (let low = 1; low <= 10; low += 1) {
    let all = true;
    for (let i = 0; i < 5; i += 1) {
      if ((bits & (1 << (low + i))) === 0) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** The ranks that would complete a straight with one more card. */
function straightOuts(bits: number): number[] {
  const outs: number[] = [];
  for (let need = 1; need <= 14; need += 1) {
    if ((bits & (1 << need)) !== 0) continue;
    const withCard = bits | (1 << need) | (need === 14 ? 1 << 1 : 0) | (need === 1 ? 1 << 14 : 0);
    if (hasStraight(withCard)) {
      const rank = need === 1 ? 14 : need;
      if (!outs.includes(rank)) outs.push(rank);
    }
  }
  return outs;
}

/** A full house or quads the hero's cards are part of. */
function fullHouse(all: readonly Card[], hole: readonly Card[]): boolean {
  const count = (rank: number) => all.filter((c) => c.rank === rank).length;
  const ranks = [...new Set(all.map((c) => c.rank))].sort((a, b) => a - b);
  const quads = ranks.some((r) => count(r) >= 4 && hole.some((h) => h.rank === r));
  const trips = ranks.filter((r) => count(r) >= 3);
  const pairs = ranks.filter((r) => count(r) >= 2);
  const full = trips.length > 0 && pairs.length >= 2 && hole.some((h) => trips.includes(h.rank) || pairs.includes(h.rank));
  return quads || full;
}

/** The hero's made hand and top pair kicker on a board of three to five cards. */
function madeHand(hole: [Card, Card], board: readonly Card[]): [Made, number | null] {
  const all = [...hole, ...board];
  const count = (rank: number, cards: readonly Card[]) => cards.filter((c) => c.rank === rank).length;
  for (let suit = 0; suit < 4; suit += 1) {
    if (all.filter((c) => c.suit === suit).length >= 5 && hole.some((c) => c.suit === suit)) {
      const suited = all.filter((c) => c.suit === suit);
      if (hasStraight(rankBits(suited))) return ["fullHouse", null];
      return [fullHouse(all, hole) ? "fullHouse" : "flush", null];
    }
  }
  if (fullHouse(all, hole)) return ["fullHouse", null];
  if (hasStraight(rankBits(all)) && !hasStraight(rankBits(board))) return ["straight", null];
  const pocket = hole[0].rank === hole[1].rank;
  if (pocket && count(hole[0].rank, board) >= 1) return ["set", null];
  for (const h of hole) {
    if (count(h.rank, board) >= 2) return ["trips", null];
  }
  const paired = hole.filter((h) => count(h.rank, board) >= 1).map((h) => h.rank);
  if (paired.length === 2 && hole[0].rank !== hole[1].rank) return ["twoPair", null];
  const boardRanks = [...new Set(board.map((c) => c.rank))].sort((a, b) => b - a);
  const top = boardRanks[0] ?? 0;
  const bottom = boardRanks[boardRanks.length - 1] ?? 0;
  if (pocket) {
    const r = hole[0].rank;
    if (board.some((c) => board.filter((d) => d.rank === c.rank).length >= 2)) return ["twoPair", null];
    return [r > top ? "overpair" : r < bottom ? "underpair" : "middlePair", null];
  }
  if (paired.length > 0) {
    const rank = paired[0];
    if (rank === top) {
      const other = hole[0].rank === rank ? hole[1].rank : hole[0].rank;
      // The best kicker that could be: the highest rank not on the board.
      const better: number[] = [];
      for (let r = 14; r >= 2; r -= 1) {
        if (r !== top && !boardRanks.includes(r)) better.push(r);
      }
      const best = better[0] ?? 0;
      const good = better.slice(1, 3);
      const kicker = other >= best ? 1 : good.includes(other) ? 2 : 3;
      return ["topPair", kicker];
    }
    if (rank === bottom) return ["bottomPair", null];
    return ["middlePair", null];
  }
  return ["highCard", null];
}

/** The hero's draws on a flop or turn: flush draws, straight draws, a backdoor flush draw on the flop. */
function draws(hole: [Card, Card], board: readonly Card[], made: Made): number {
  const all = [...hole, ...board];
  let bits = 0;
  let flushDraw = false;
  if (made !== "flush" && made !== "fullHouse") {
    for (let suit = 0; suit < 4; suit += 1) {
      const n = all.filter((c) => c.suit === suit).length;
      const mine = hole.filter((c) => c.suit === suit).length;
      if (n === 4 && mine >= 1) {
        flushDraw = true;
        bits |= drawBit("flushDraw");
        let highest: number | null = null;
        for (let r = 14; r >= 2; r -= 1) {
          if (!board.some((c) => c.suit === suit && c.rank === r)) {
            highest = r;
            break;
          }
        }
        if (hole.some((c) => c.suit === suit && c.rank === highest)) bits |= drawBit("nutFlushDraw");
      }
      if (board.length === 3 && n === 3 && mine >= 1 && !flushDraw) bits |= drawBit("backdoorFlush");
    }
  }
  let straightDraw = false;
  if (made !== "straight" && made !== "flush" && made !== "fullHouse") {
    const withHole = straightOuts(rankBits(all));
    const without = straightOuts(rankBits(board));
    const mine = withHole.filter((r) => !without.includes(r));
    if (mine.length >= 2) {
      bits |= drawBit("oesd");
      straightDraw = true;
    } else if (mine.length === 1) {
      bits |= drawBit("gutshot");
      straightDraw = true;
    }
  }
  if (flushDraw && straightDraw) bits |= drawBit("comboDraw");
  return bits;
}

/** Seats in the order they act after the flop (the small blind first). */
function postflopOrder(position: Position | string | null): number {
  switch (position) {
    case "SB":
      return 1;
    case "BB":
      return 2;
    case "UTG":
      return 3;
    case "UTG+1":
      return 4;
    case "UTG+2":
      return 5;
    case "MP":
      return 6;
    case "LJ":
      return 7;
    case "HJ":
      return 8;
    case "CO":
      return 9;
    case "BTN":
      return 10;
    default:
      return 0;
  }
}

const STREET_INDEX: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };
const NOT_IN_POT = new Set(["show", "muck", "collect", "cashout-choose", "cashout-pay"]);

/** The hero's sizes: the open preflop, the first bet or raise on each later street. */
function sizes(hand: PhfHand, heroSeat: number, facts: BuilderFacts): void {
  const bigBlind = Math.max(hand.game.bigBlind, 1);
  let pot = 0;
  let street: string = "preflop";
  let level = 0;
  const totals = new Map<number, number>();
  let raisedPreflop = false;
  const done = [false, false, false, false];
  for (const action of hand.actions) {
    if (action.runoutIndex !== 0) continue;
    if (action.street !== street) {
      street = action.street;
      level = 0;
      totals.clear();
    }
    // Rust's `u32::MAX` for an action without a seat: a key no seat has.
    const seat = action.seat ?? -1;
    const before = totals.get(seat) ?? 0;
    const index = STREET_INDEX[street] ?? 4;
    const voluntary = action.type === "bet" || action.type === "raise";
    if (seat === heroSeat && voluntary && index < 4 && !done[index]) {
      done[index] = true;
      if (index === 0) {
        if (!raisedPreflop) facts.openTenths = Math.trunc((action.streetTotal * 10) / bigBlind);
      } else {
        let pct: number | null;
        if (action.type === "bet" || level === 0) {
          pct = pot > 0 ? Math.trunc((action.amount * 100) / pot) : null;
        } else {
          const call = Math.max(level - before, 0);
          const raiseBy = action.streetTotal - level;
          pct = pot + call > 0 ? Math.trunc((raiseBy * 100) / (pot + call)) : null;
        }
        facts.betPct[index - 1] = pct;
      }
    }
    if (index === 0 && action.type === "raise") raisedPreflop = true;
    if (!NOT_IN_POT.has(action.type)) {
      pot += action.amount;
      if (action.streetTotal > 0) {
        totals.set(seat, action.streetTotal);
        level = Math.max(level, action.streetTotal);
      }
    }
  }
}

/** Who was caught bluffing, street by street (the hero's bits, then every opponent's). */
function caughtBluffing(hand: PhfHand, rows: readonly StatsRow[]): [number, number] {
  const board = cardsOf(primaryBoard(hand));
  const aggressed = new Map<number, number>();
  const showed: number[] = [];
  for (const action of hand.actions) {
    if (action.runoutIndex !== 0 || action.seat === null) continue;
    const seat = action.seat;
    if (action.type === "show") showed.push(seat);
    if (action.type !== "bet" && action.type !== "raise") continue;
    const bit = action.street === "flop" ? 1 : action.street === "turn" ? 2 : action.street === "river" ? 4 : 0;
    if (bit === 0) continue;
    aggressed.set(seat, (aggressed.get(seat) ?? 0) | bit);
  }
  const bluff: [number, number] = [0, 0];
  for (const row of rows) {
    const streets = aggressed.get(row.seat);
    if (streets === undefined) continue;
    const seen = !row.is_hero || row.wtsd > 0 || showed.includes(row.seat);
    if (!seen) continue;
    const hole = cardsOf(row.hole_cards);
    if (hole.length !== 2) continue;
    for (const [bit, n] of [
      [1, 3],
      [2, 4],
      [4, 5],
    ] as const) {
      if ((streets & bit) === 0 || board.length < n) continue;
      if (madeHand([hole[0], hole[1]], board.slice(0, n))[0] === "highCard") bluff[row.is_hero ? 0 : 1] |= bit;
    }
  }
  return bluff;
}

/**
 * The rows the desktop keeps for a hand (`rail_stats::stored_rows(hand, true)`):
 * the hero's and the villains' (none in a positionally anonymised room), the
 * first of a seat only.
 */
export function keptRows(rows: readonly StatsRow[], positional: boolean): StatsRow[] {
  const kept: StatsRow[] = [];
  for (const row of rows) {
    if (!(row.is_hero || !positional)) continue;
    if (kept.some((k) => k.seat === row.seat)) continue;
    kept.push(row);
  }
  return kept;
}

/** The hero's effective stack in tenths of the largest forced blind (thousandths / 100, rounded down). */
export function effStackTenths(hand: PhfHand, heroSeat: number): number | null {
  const thousandths = effectiveFirstActionBb(hand, heroSeat);
  return thousandths === null ? null : Math.floor(thousandths / 100);
}

/** Derive the builder's facts of `hand` from its PHF and its kept rows ({@link keptRows}). */
export function builderFacts(hand: PhfHand, rows: readonly StatsRow[]): BuilderFacts {
  const facts: BuilderFacts = {
    openTenths: null,
    betPct: [null, null, null],
    made: [null, null, null],
    kicker: [null, null, null],
    draws: [0, 0],
    playersFlop: 0,
    heroIp: null,
    vsSeats: "",
    vsPositions: "",
    buyInCents: null,
    bounty: false,
    level: null,
    bluff: [0, 0],
    effStack: null,
  };
  const hero = rows.find((row) => row.is_hero);
  const flopSeers = rows.filter((row) => row.flop_seen > 0);
  facts.playersFlop = flopSeers.length;
  if (hero) {
    const seats: string[] = [];
    const positions: string[] = [];
    for (const row of rows) {
      if (row.is_hero) continue;
      if (row.vpip > 0 || row.flop_seen > 0) {
        seats.push(String(row.seat));
        if (row.position !== null) positions.push(row.position);
      }
    }
    if (seats.length > 0) {
      facts.vsSeats = ` ${seats.join(" ")} `;
      facts.vsPositions = ` ${positions.join(" ")} `;
    }
    if (hero.flop_seen > 0) {
      const mine = postflopOrder(hero.position);
      facts.heroIp = mine > 0 && flopSeers.filter((row) => !row.is_hero).every((row) => postflopOrder(row.position) < mine);
    }
    const hole = cardsOf(hero.hole_cards);
    const board = cardsOf(primaryBoard(hand));
    if (hole.length === 2) {
      for (const [street, n] of [
        [0, 3],
        [1, 4],
        [2, 5],
      ] as const) {
        if (board.length < n) break;
        const [made, kicker] = madeHand([hole[0], hole[1]], board.slice(0, n));
        facts.made[street] = madeIndex(made);
        facts.kicker[street] = kicker;
        if (street === 0 || street === 1) facts.draws[street] = draws([hole[0], hole[1]], board.slice(0, n), made);
      }
    }
    sizes(hand, hero.seat, facts);
    facts.effStack = effStackTenths(hand, hero.seat);
  }
  facts.bluff = caughtBluffing(hand, rows);
  const tournament = hand.tournament;
  if (tournament) {
    const minor = Math.max(tournament.buyInUnit.minorUnits, 1);
    const total = tournament.buyIn + (tournament.bounty ?? 0) + tournament.fee;
    facts.buyInCents = Math.trunc((total * 100) / minor);
    facts.bounty = (tournament.bounty ?? 0) > 0 || tournament.bounties.length > 0;
    facts.level = tournament.levelNumber;
  }
  return facts;
}
