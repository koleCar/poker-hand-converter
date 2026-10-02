/**
 * The shared read of a hand that every counter module walks.
 *
 * Built once per hand, then handed to `preflop.ts`, `postflop.ts`,
 * `showdown.ts` and `money.ts`. Everything the counters need to know about the
 * *shape* of the hand is decided here, in one place, so that "is this a bomb
 * pot" or "who was the last preflop aggressor" cannot be answered two different
 * ways in two different files.
 *
 * Two rules govern this file:
 *
 * **Derive from the action stream, not from `game`.** `game.straddles` and
 * `game.anteModel` are populated by exactly two of the nineteen parsers
 * (`parsers/shared/ps-gg-hand.ts` and `phf/serialize.ts`); the other seventeen
 * leave them at their defaults, so reading them would make every WePlay,
 * Winamax or iPoker hand silently report "no straddle" and "no ante". The
 * stream is authoritative — PHF design rule 2 — and `actions.some(a => a.type
 * === "straddle")` is true for all nineteen.
 *
 * **A decision is a decision.** `fold`, `check`, `call`, `bet` and `raise` are
 * the only five action types a player chooses. Everything else is filtered out
 * before any counter sees it:
 *
 * - `isPostingAction(type)` — antes, blinds, straddles, dead posts. Forced
 *   money. Never voluntary, never aggression, never a decision.
 * - `uncalled` — a *negative-amount bookkeeping event*, not a move. Left in, it
 *   would appear as the last thing the bettor did on the street, which breaks
 *   every last-aggressor search and every "who acted after the bet" walk.
 * - `show` / `muck` / `collect` / `cashout-choose` / `cashout-pay` — results,
 *   not choices.
 */

import {
  assignPositions,
  isButtonBlind,
  houseIntoPot,
  isPostingAction,
  resolveRunout,
  seatOutOfPot,
  totalFees,
  type Amount,
  type AnteModel,
  type PhfAction,
  type PhfHand,
  type PhfPlayer,
  type Position,
  type Street,
} from "../phf/types";

/** The three streets that have their own betting round after the flop is dealt. */
export const POSTFLOP_STREETS = ["flop", "turn", "river"] as const;
export type PostflopStreet = (typeof POSTFLOP_STREETS)[number];

/** The five action types that represent a player choosing something. */
const DECISION_TYPES = new Set(["fold", "check", "call", "bet", "raise"]);

/**
 * Whether an action is a decision the player made.
 *
 * The single test the whole module funnels through. See the file header for
 * why each excluded type is excluded.
 */
export function isDecision(action: PhfAction): boolean {
  if (action.seat === null) {
    return false;
  }
  if (isPostingAction(action.type)) {
    return false;
  }
  return DECISION_TYPES.has(action.type);
}

/**
 * One decision, with the betting state that existed immediately *before* it.
 *
 * The "before" state is what makes a counter definable: whether a raise is a
 * 3-bet depends on how many raises preceded it, not on anything about the raise
 * itself.
 */
export interface Decision {
  /** Index into `StatsContext.decisions`. */
  order: number;
  action: PhfAction;
  seat: number;
  street: Street;
  type: PhfAction["type"];
  /** Voluntary raises already made on this street. A straddle is not one. */
  raisesBefore: number;
  /** Opening bets already made on this street (postflop only, at most one). */
  betsBefore: number;
  /** `raisesBefore + betsBefore`: is there a live bet to answer? */
  aggressionBefore: number;
  /** Seats that had already voluntarily put chips in on this street. */
  enteredBefore: number[];
  /**
   * Seats that have called since the last bet or raise on this street.
   *
   * What makes a squeeze a squeeze, and what decides whether a flop
   * continuation bet was *called* — the condition PT4 puts on a turn cbet.
   */
  callersSinceAggression: number;
  /** This is the seat's first decision on this street. */
  firstOnStreet: boolean;
  /** The seat had already checked on this street before this decision. */
  checkedBefore: boolean;
}

export interface StatsContext {
  hand: PhfHand;
  bigBlind: Amount;

  /** Seats that were dealt in, ascending. One derived row per entry. */
  dealtInSeats: number[];
  players: Map<number, PhfPlayer>;
  position: Map<number, Position | null>;
  /** Seats that posted a blind or a straddle: they cannot "cold" call. */
  blindSeats: Set<number>;
  straddleSeats: Set<number>;
  /** Seat that posted the big blind, from the stream. Null in a bomb pot. */
  bigBlindSeat: number | null;
  smallBlindSeat: number | null;

  /** Every decision in the hand, in stream order. */
  decisions: Decision[];
  /** Decisions for one street, in stream order. */
  byStreet: Map<Street, Decision[]>;

  /** Street the hand actually reached, derived from the board and the stream. */
  streetReached: Street;
  /** Streets whose cards were dealt. `flop` implies three board cards exist. */
  dealt: Set<PostflopStreet>;

  /** Seats that folded, and on which street. */
  foldedOn: Map<number, Street>;
  /** Seats that never folded. Two or more of them means a showdown. */
  liveSeats: number[];

  /** Last seat to voluntarily raise preflop, or null in a limped pot. */
  preflopAggressor: number | null;
  /** Last seat to bet or raise on each postflop street. */
  streetAggressor: Map<PostflopStreet, number | null>;

  hasStraddle: boolean;
  /**
   * The table's only blind was posted by the button: GG's ante-only short
   * deck. Read from the stream (`isButtonBlind`) like everything else here.
   */
  hasButtonBlind: boolean;
  isBombPot: boolean;
  anteModel: AnteModel;
  isBigBlindAnte: boolean;
  isRunItTwice: boolean;
  hasCashout: boolean;
  isWalk: boolean;

  houseIntoPot: Amount;
  fees: Amount;
}

/* ----------------------------------------------------------- hand shape - */

/**
 * Seats that took part: anyone who put a chip in or made a move.
 *
 * Mirrors the rule `assignPositions` uses, on purpose — a seat that gets a
 * position must get a row, and a seat that contributed money must get a row or
 * the table's `net` stops adding up.
 */
function dealtInSeatsOf(hand: PhfHand): number[] {
  const acted = new Set<number>();
  for (const action of hand.actions) {
    if (action.seat !== null) {
      acted.add(action.seat);
    }
  }
  const seated = hand.players.map((player) => player.seat).sort((a, b) => a - b);
  const dealtIn = seated.filter((seat) => acted.has(seat));
  return dealtIn.length >= 2 ? dealtIn : seated;
}

/**
 * A bomb pot: everybody antes, nobody posts a blind, the flop comes straight
 * out.
 *
 * Read from the stream rather than from `game.bombPot` for the reason in the
 * file header. `bomb-ante` is the explicit marker; the fallback — two or more
 * ante posters and no blind at all — is the same structural test
 * `phf/serialize.ts` uses to reconstruct the field, so the two agree.
 */
export function detectBombPot(hand: PhfHand): boolean {
  if (hand.actions.some((action) => action.type === "bomb-ante")) {
    return true;
  }
  const antePosters = new Set<number>();
  let hasBlind = false;
  for (const action of hand.actions) {
    if (action.type === "ante" && action.seat !== null) {
      antePosters.add(action.seat);
    }
    if (action.type === "small-blind" || action.type === "big-blind") {
      hasBlind = true;
    }
  }
  return antePosters.size >= 2 && !hasBlind;
}

/**
 * Who paid the ante and how, from the stream.
 *
 * One ante poster at a multi-handed table is a **big-blind ante**: that seat put
 * in the whole table's ante, which inflates its `contributed` by every other
 * player's share. The money is real and stays in `net`; what it means is that a
 * report filtered to the big blind alone reads worse than the seat actually
 * did. Documented, not "fixed" — see `docs/STATS-SPEC.md` §7.2.
 */
export function detectAnteModel(hand: PhfHand): AnteModel {
  const posters = new Set<number>();
  for (const action of hand.actions) {
    if ((action.type === "ante" || action.type === "bomb-ante") && action.seat !== null) {
      posters.add(action.seat);
    }
  }
  if (posters.size === 0) {
    return "none";
  }
  const dealtIn = dealtInSeatsOf(hand).length;
  return posters.size === 1 && dealtIn > 1 ? "big-blind-ante" : "posted-per-player";
}

/**
 * Furthest street the hand reached, from the board and the action stream.
 *
 * `results.streetReached` says the same thing, but it is a denormalized copy
 * that a parser could compute wrongly, and the round-trip invariant compares
 * derived facts across a serialization boundary — so the derivation reads the
 * two sources that always survive: how much board came out, and where the last
 * decision happened.
 */
function streetsDealt(hand: PhfHand): Set<PostflopStreet> {
  const out = new Set<PostflopStreet>();
  let widest = 0;
  for (let index = 0; index < hand.board.runouts.length; index += 1) {
    widest = Math.max(widest, resolveRunout(hand.board, index).length);
  }
  if (widest >= 3) out.add("flop");
  if (widest >= 4) out.add("turn");
  if (widest >= 5) out.add("river");
  // A street with betting on it was reached even if a parser lost the card, and
  // a card that came out was reached even if nobody could act on it.
  for (const action of hand.actions) {
    if (action.street === "flop") out.add("flop");
    if (action.street === "turn") out.add("turn");
    if (action.street === "river") out.add("river");
  }
  return out;
}

/* ------------------------------------------------------- decision stream - */

function buildDecisions(hand: PhfHand): Decision[] {
  const out: Decision[] = [];

  let street: Street | null = null;
  let raises = 0;
  let bets = 0;
  let entered: number[] = [];
  let seen = new Set<number>();
  let checked = new Set<number>();
  let callers = 0;

  for (const action of hand.actions) {
    if (!isDecision(action)) {
      continue;
    }
    if (action.street !== street) {
      street = action.street;
      raises = 0;
      bets = 0;
      entered = [];
      seen = new Set();
      checked = new Set();
      callers = 0;
    }
    const seat = action.seat as number;
    out.push({
      order: out.length,
      action,
      seat,
      street: action.street,
      type: action.type,
      raisesBefore: raises,
      betsBefore: bets,
      aggressionBefore: raises + bets,
      enteredBefore: [...entered],
      callersSinceAggression: callers,
      firstOnStreet: !seen.has(seat),
      checkedBefore: checked.has(seat),
    });
    seen.add(seat);
    if (action.type === "raise") {
      raises += 1;
      callers = 0;
    }
    if (action.type === "bet") {
      bets += 1;
      callers = 0;
    }
    if (action.type === "call") {
      callers += 1;
    }
    if (action.type === "check") {
      checked.add(seat);
    }
    if (action.type === "call" || action.type === "bet" || action.type === "raise") {
      if (!entered.includes(seat)) {
        entered.push(seat);
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------- the build - */

/**
 * Reads one hand into the shape the counters walk.
 *
 * **Positions.** `assignPositions(hand)` *mutates its argument*: it writes
 * `player.position` on every seat. It is called here only when every position
 * is already null, which is the case for a hand that came straight out of a
 * parser that does not resolve positions itself. Calling it unconditionally
 * would overwrite a caller's deliberate labelling, and calling it twice would
 * make this function non-deterministic in its side effects — the determinism
 * invariant in `tests/test/statsDerive.test.ts` exists to catch exactly that.
 */
export function buildContext(hand: PhfHand): StatsContext {
  if (hand.players.length > 0 && hand.players.every((player) => player.position === null)) {
    assignPositions(hand);
  }

  const dealtInSeats = dealtInSeatsOf(hand);
  const players = new Map<number, PhfPlayer>();
  const position = new Map<number, Position | null>();
  for (const player of hand.players) {
    players.set(player.seat, player);
    position.set(player.seat, player.position);
  }

  const blindSeats = new Set<number>();
  const straddleSeats = new Set<number>();
  for (const action of hand.actions) {
    if (action.seat === null) {
      continue;
    }
    if (
      action.type === "small-blind" ||
      action.type === "big-blind" ||
      action.type === "post" ||
      action.type === "missed-blind"
    ) {
      blindSeats.add(action.seat);
    }
    if (action.type === "straddle") {
      straddleSeats.add(action.seat);
      blindSeats.add(action.seat);
    }
  }

  const decisions = buildDecisions(hand);
  const byStreet = new Map<Street, Decision[]>();
  for (const decision of decisions) {
    const bucket = byStreet.get(decision.street);
    if (bucket) {
      bucket.push(decision);
    } else {
      byStreet.set(decision.street, [decision]);
    }
  }

  const foldedOn = new Map<number, Street>();
  for (const decision of decisions) {
    if (decision.type === "fold" && !foldedOn.has(decision.seat)) {
      foldedOn.set(decision.seat, decision.street);
    }
  }
  const liveSeats = dealtInSeats.filter((seat) => !foldedOn.has(seat));

  let preflopAggressor: number | null = null;
  for (const decision of byStreet.get("preflop") ?? []) {
    if (decision.type === "raise") {
      preflopAggressor = decision.seat;
    }
  }

  const streetAggressor = new Map<PostflopStreet, number | null>();
  for (const street of POSTFLOP_STREETS) {
    let last: number | null = null;
    for (const decision of byStreet.get(street) ?? []) {
      if (decision.type === "bet" || decision.type === "raise") {
        last = decision.seat;
      }
    }
    streetAggressor.set(street, last);
  }

  const dealt = streetsDealt(hand);
  const streetReached: Street = dealt.has("river")
    ? "river"
    : dealt.has("turn")
      ? "turn"
      : dealt.has("flop")
        ? "flop"
        : "preflop";

  const anteModel = detectAnteModel(hand);
  const isBombPot = detectBombPot(hand);

  /*
   * A walk: everyone folded to the big blind and the big blind never got to
   * act. The test is structural — there is a big blind, the preflop decisions
   * are all folds by other seats, and the big blind made none. PT4 gives that
   * seat `vpip_opp = 0`; see `preflop.ts`.
   */
  const bigBlindSeat =
    hand.actions.find((action) => action.type === "big-blind" && action.seat !== null)?.seat ?? null;
  const smallBlindSeat =
    hand.actions.find((action) => action.type === "small-blind" && action.seat !== null)?.seat ??
    null;
  const preflop = byStreet.get("preflop") ?? [];
  const isWalk =
    !isBombPot &&
    bigBlindSeat !== null &&
    preflop.length > 0 &&
    preflop.every((decision) => decision.type === "fold" && decision.seat !== bigBlindSeat);

  return {
    hand,
    bigBlind: hand.game.bigBlind,
    dealtInSeats,
    players,
    position,
    blindSeats,
    straddleSeats,
    bigBlindSeat,
    smallBlindSeat,
    decisions,
    byStreet,
    streetReached,
    dealt,
    foldedOn,
    liveSeats,
    preflopAggressor,
    streetAggressor,
    hasStraddle: hand.actions.some((action) => action.type === "straddle"),
    hasButtonBlind: hand.actions.some(isButtonBlind),
    isBombPot,
    anteModel,
    isBigBlindAnte: anteModel === "big-blind-ante",
    isRunItTwice: hand.board.runouts.length > 1,
    hasCashout: hand.actions.some(
      (action) => action.type === "cashout-choose" || action.type === "cashout-pay",
    ),
    isWalk,
    houseIntoPot: houseIntoPot(hand),
    fees: totalFees(hand.results.fees),
  };
}

/* ----------------------------------------------------------------- utils - */

/** Decisions the seat made on a street, in order. */
export function seatStreet(
  context: StatsContext,
  seat: number,
  street: Street,
): Decision[] {
  return (context.byStreet.get(street) ?? []).filter((decision) => decision.seat === seat);
}

/** The seat's first decision on a street, or null if it never acted there. */
export function firstDecision(
  context: StatsContext,
  seat: number,
  street: Street,
): Decision | null {
  for (const decision of context.byStreet.get(street) ?? []) {
    if (decision.seat === seat) {
      return decision;
    }
  }
  return null;
}

/** Whether the seat was still in the hand when `street` was dealt. */
export function liveOnStreet(
  context: StatsContext,
  seat: number,
  street: PostflopStreet,
): boolean {
  if (!context.dealt.has(street)) {
    return false;
  }
  const folded = context.foldedOn.get(seat);
  if (folded === undefined) {
    return true;
  }
  const order: Street[] = ["preflop", "flop", "turn", "river", "showdown"];
  return order.indexOf(folded) >= order.indexOf(street);
}

/** Chips a seat paid out of its stack that never reached the pot. */
export function outOfPot(context: StatsContext, seat: number): Amount {
  return seatOutOfPot(context.hand, seat);
}
