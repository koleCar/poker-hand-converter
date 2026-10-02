/**
 * `PhfHand` → `HandFacts`. The entry point of the derivation engine.
 *
 * Pure: it reads a hand and returns a value. The only thing it touches outside
 * its own scope is `assignPositions`, which PHF defines as mutating — see
 * `buildContext` in `context.ts` for the guard that makes that idempotent.
 *
 * Nothing in `lib/stats/**` may import anything but `lib/phf/types`,
 * `lib/phf/validate` and `lib/cards`. No Supabase, no React, no `window`, no
 * `process`. That is what lets `tests/test/` import this module directly and
 * run it over the whole corpus, and what will let a server-side backfill run the
 * identical function over stored hands later. `lib/replay.ts` obeys the same
 * rule and is the precedent.
 */

import { handClass } from "../cards";
import { cardInDeck, holeCardCount, type PhfHand } from "../phf/types";
import { buildContext } from "./context";
import { moneyBySeat } from "./money";
import { cbetChain, postflopCounters } from "./postflop";
import { preflopCounters } from "./preflop";
import { showdownCounters } from "./showdown";
import {
  STATS_VERSION,
  emptyCounters,
  type HandDimensions,
  type HandFacts,
  type SeatFacts,
  type PotType,
} from "./types";

/**
 * The canonical starting-hand class for a seat, or null.
 *
 * **Never assume two hole cards.** `holeCardCount(variant)` is the authority:
 * Hold'em and short deck deal two, Omaha four, five-card Omaha five, and stud
 * and draw have no fixed answer at all. The seat's cards are checked against
 * what the variant deals before anything reads them, so a hand whose cards were
 * only partially revealed produces `null` rather than a class derived from half
 * a holding.
 *
 * `handClass` covers the two-card case and returns null for anything else,
 * which is the right answer here rather than a gap. The multi-card form lives
 * separately (`omahaHandClass` in `lib/cards`); wiring it in is additive and
 * belongs with the PLO reporting that would read it, not with M0 — a class
 * column nothing groups by is a column that will be wrong before it is used.
 *
 * Short deck uses the same `AKs` / `AKo` / `77` notation, over the nine ranks
 * the deck has: 81 of the 169 Hold'em classes. A card the deck does not hold
 * has no class rather than a Hold'em one; the validator refuses such a hand
 * anyway (`card-not-in-deck`), so this only matters for a hand built in code.
 */
function classOf(hand: PhfHand, cards: string[]): string | null {
  const dealt = holeCardCount(hand.game.variant);
  if (dealt === null || cards.length !== dealt) {
    return null;
  }
  if (!cards.every((card) => cardInDeck(card, hand.game.variant))) {
    return null;
  }
  return handClass(cards);
}

/** Big blinds, to one decimal, held as an integer count of tenths. */
function bbTenths(amount: number, bigBlind: number): number {
  if (!bigBlind) {
    return 0;
  }
  const value = (amount * 10) / bigBlind;
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Derives every counter for every dealt-in seat of one hand.
 *
 * Deterministic by construction: it reads only the hand, and two calls on the
 * same document produce byte-identical output. `tests/test/statsDerive.test.ts`
 * asserts that over the corpus, because the cheapest way to break it is an
 * accidental mutation of the input.
 */
export function handFacts(hand: PhfHand): HandFacts {
  const context = buildContext(hand);
  const money = moneyBySeat(context);
  const chain = cbetChain(context);

  const seats: SeatFacts[] = context.dealtInSeats.map((seat) => {
    const player = context.players.get(seat);
    const counters = emptyCounters();
    counters.hands = 1;

    const seatMoney = money.get(seat) ?? {
      won: 0,
      contributed: 0,
      net: 0,
      net_bb_milli: 0,
      rake_paid: 0,
      out_of_pot: 0,
      cashout_risk: 0,
    };

    preflopCounters(context, seat, counters);
    postflopCounters(context, seat, counters, chain);
    showdownCounters(context, seat, counters, seatMoney);
    if (seatMoney.cashout_risk !== 0) {
      counters.cashed_out = 1;
    }

    const holeCards = player?.holeCards ?? [];
    return {
      seat,
      player: player?.name ?? "",
      isHero: player?.isHero ?? false,
      position: context.position.get(seat) ?? null,
      holeCards: [...holeCards],
      handClass: classOf(hand, holeCards),
      startingStack: player?.startingStack ?? 0,
      startingStackBbTenths: bbTenths(player?.startingStack ?? 0, context.bigBlind),
      counters,
      money: seatMoney,
    };
  });

  const dimensions: HandDimensions = {
    statsVersion: STATS_VERSION,
    handKey: `${hand.meta.siteId.trim().toLowerCase()}:${hand.meta.handKey || hand.meta.handId}`,
    siteId: hand.meta.siteId,
    handId: hand.meta.handId,
    playedAt: hand.playedAt,
    variant: hand.game.variant,
    limit: hand.game.limit,
    format: hand.game.format,
    currency: hand.game.unit.code,
    currencyMinorUnits: hand.game.unit.minorUnits,
    smallBlind: hand.game.smallBlind,
    bigBlind: hand.game.bigBlind,
    playerCount: context.dealtInSeats.length,
    maxSeats: hand.table.maxSeats,
    tableName: hand.table.name,
    tournamentId: hand.tournament?.id ?? null,
    fastFold: hand.table.fastFold ?? null,
    hasStraddle: context.hasStraddle,
    isBombPot: context.isBombPot,
    isBigBlindAnte: context.isBigBlindAnte,
    isRunItTwice: context.isRunItTwice,
    hasCashout: context.hasCashout,
    isWalk: context.isWalk,
    streetReached: context.streetReached,
    potType: potTypeOf(context),
    houseIntoPot: context.houseIntoPot,
    fees: context.fees,
    totalPot: hand.results.totalPot,
  };

  return { hand: dimensions, seats };
}

/**
 * See `HandDimensions.potType`. Voluntary preflop raises; a straddle is not one.
 * Exported for `lib/analysis`, which groups decisions by the same pot type the
 * statistics breakdown uses and must not grow a second definition of it.
 */
export function potTypeOf(context: ReturnType<typeof buildContext>): PotType {
  if (context.isBombPot) return "bomb";
  if (context.isWalk) return "walk";
  const raises = (context.byStreet.get("preflop") ?? []).filter((decision) => decision.type === "raise").length;
  if (raises === 0) return "limped";
  if (raises === 1) return "single-raised";
  if (raises === 2) return "3bet";
  return "4bet+";
}

/** `handFacts` over many hands, flattened. Convenience for a backfill batch. */
export function handFactsAll(hands: PhfHand[]): HandFacts[] {
  return hands.map((hand) => handFacts(hand));
}
