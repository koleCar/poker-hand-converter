/**
 * Invariants asserted over every derived stats row of the whole corpus.
 *
 * The same shape as `psggInvariants.ts`: each helper is a pure function that
 * takes a hand and returns a list of human-readable problems, so a failing test
 * names the hand rather than saying `expected false to be true`.
 *
 * What makes this set worth trusting is that **none of it needs a known-good
 * reference.** There is no PokerTracker export to diff against, and building
 * one would only move the question to "is the reference right". Instead every
 * check here is a property that must hold of any correct derivation:
 *
 * - **Money conservation.** The seats collectively win what the house dropped
 *   in and lose what the house took out. One assertion tied to 413 real files.
 * - **Structure.** A stat cannot be made more often than the opportunity
 *   existed; a leg set sums to its opportunity exactly; you cannot see the river
 *   without the turn.
 * - **Round trip.** Serialize the hand to standard text, parse it back, derive
 *   again — the money and every preflop counter must be identical. That proves
 *   the derivation reads PHF *structure* and not one room's text quirks.
 * - **Determinism.** Two calls on the same document give byte-identical output.
 *   Cheap, and the only thing that catches an accidental mutation of the input —
 *   `assignPositions` mutates, and the guard around it is exactly the kind of
 *   thing that rots.
 */

import {
  houseIntoPot,
  totalFees,
  type PhfHand,
} from "../../../frontend/src/lib/phf/types.js";
import { parseStandardHand, toStandardText } from "../../../frontend/src/lib/phf/serialize.js";
import { handFacts } from "../../../frontend/src/lib/stats/derive.js";
import { STATS_COLUMNS, statsRows } from "../../../frontend/src/lib/stats/mapping.js";
import {
  COUNTER_KEYS,
  LEG_SETS,
  MONEY_KEYS,
  OPPORTUNITY_PAIRS,
  STREET_CHAINS,
  type CounterKey,
  type HandFacts,
} from "../../../frontend/src/lib/stats/types.js";

/** One minor unit of slack, the same tolerance the PHF validator uses. */
const TOLERANCE = 1;

/** Preflop counters, which the round trip compares alongside the money. */
const PREFLOP_KEYS: CounterKey[] = [
  "hands",
  "vpip_opp",
  "vpip",
  "pfr_opp",
  "pfr",
  "rfi_opp",
  "rfi",
  "iso_opp",
  "iso",
  "limp_opp",
  "limp",
  "cold_call_opp",
  "cold_call",
  "three_bet_opp",
  "three_bet",
  "four_bet_opp",
  "four_bet",
  "five_bet_opp",
  "five_bet",
  "squeeze_opp",
  "squeeze",
  "steal_opp",
  "steal",
  "fold_to_steal_opp",
  "fold_to_steal",
  "call_steal",
  "three_bet_vs_steal",
  "fold_to_three_bet_opp",
  "fold_to_three_bet",
  "call_three_bet",
  "raise_vs_three_bet",
  "fold_to_four_bet_opp",
  "fold_to_four_bet",
  "call_four_bet",
  "raise_vs_four_bet",
];

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

/**
 * The money identity.
 *
 * `Σ net === houseIntoPot(hand) - totalFees(hand.results.fees)`
 *
 * Both correction terms are money that crosses the table boundary: a GG cash
 * drop or a Run It Once STP is chips the house *added* that no seat put in, and
 * the fee columns are chips the house *took* out of the pot before it was
 * pushed. Everything else is a transfer between seats and nets to zero.
 *
 * Skipped for hands with a `cashout-pay`: a GG EV cashout settles the pot
 * against the house at the player's equity rather than at the showdown, so the
 * collects genuinely do not reconcile against what went in. Those hands carry
 * `has_cashout` and are excluded from money series by default.
 */
export function moneyConservation(hand: PhfHand): string[] {
  if (hand.actions.some((action) => action.type === "cashout-pay")) {
    return [];
  }
  const facts = handFacts(hand);
  const net = facts.seats.reduce((sum, seat) => sum + seat.money.net, 0);
  const expected = houseIntoPot(hand) - totalFees(hand.results.fees);
  return Math.abs(net - expected) > TOLERANCE
    ? [
        `${hand.meta.handId}: seats net ${net}, house dropped ${houseIntoPot(hand)} less fees ` +
          `${totalFees(hand.results.fees)} = ${expected}`,
      ]
    : [];
}

/**
 * Every seat's `contributed` and `won` add back up to the pot the source
 * reports.
 *
 * The other half of conservation: the identity above would still hold if a
 * whole seat were dropped from the derivation and its money attributed to
 * another. This pins the totals to the hand's own summary.
 */
export function potReconciles(hand: PhfHand): string[] {
  if (hand.actions.some((action) => action.type === "cashout-pay")) {
    return [];
  }
  const facts = handFacts(hand);
  const contributed = facts.seats.reduce((sum, seat) => sum + seat.money.contributed, 0);
  const expected = hand.results.totalPot - houseIntoPot(hand);
  return Math.abs(contributed - expected) > TOLERANCE
    ? [`${hand.meta.handId}: seats put in ${contributed}, pot less house money is ${expected}`]
    : [];
}

/** The fee shares add up to the fees exactly, with no rounding leak. */
export function rakeSharesSum(hand: PhfHand): string[] {
  const facts = handFacts(hand);
  const shares = facts.seats.reduce((sum, seat) => sum + seat.money.rake_paid, 0);
  const fees = totalFees(hand.results.fees);
  const awarded = facts.seats.reduce((sum, seat) => sum + seat.money.won, 0);
  // Nothing was awarded, so there is nothing to attribute the fees to. That is
  // a degenerate hand rather than a derivation bug, and the shares are all 0.
  if (awarded <= 0) {
    return shares === 0 ? [] : [`${hand.meta.handId}: fees split over an unawarded pot`];
  }
  return shares === fees
    ? []
    : [`${hand.meta.handId}: fee shares sum to ${shares}, fees are ${fees}`];
}

/**
 * Structural counter rules: `made <= opp`, leg sets sum exactly, streets are
 * monotone, and nothing is negative or fractional.
 */
export function counterStructure(hand: PhfHand): string[] {
  const facts = handFacts(hand);
  const problems: string[] = [];
  for (const seat of facts.seats) {
    const label = `${hand.meta.handId} seat ${seat.seat}`;
    const c = seat.counters;

    for (const key of COUNTER_KEYS) {
      const value = c[key];
      if (!Number.isInteger(value)) {
        problems.push(`${label}: ${key} is ${value}, not an integer`);
      }
      if (value < 0) {
        problems.push(`${label}: ${key} is negative (${value})`);
      }
    }
    for (const key of MONEY_KEYS) {
      if (!Number.isInteger(seat.money[key])) {
        problems.push(`${label}: ${key} is ${seat.money[key]}, not an integer`);
      }
    }

    for (const [opp, made] of OPPORTUNITY_PAIRS) {
      if (c[made] > c[opp]) {
        problems.push(`${label}: ${made} ${c[made]} > ${opp} ${c[opp]}`);
      }
    }

    for (const { opp, legs } of LEG_SETS) {
      const sum = legs.reduce((total, key) => total + c[key], 0);
      if (sum !== c[opp]) {
        problems.push(`${label}: ${legs.join(" + ")} = ${sum}, but ${opp} = ${c[opp]}`);
      }
    }

    for (const chain of STREET_CHAINS) {
      for (let i = 1; i < chain.length; i += 1) {
        if (c[chain[i]] > c[chain[i - 1]]) {
          problems.push(
            `${label}: ${chain[i]} ${c[chain[i]]} > ${chain[i - 1]} ${c[chain[i - 1]]}`,
          );
        }
      }
    }

    // Preflop opportunities are 0 or 1 per hand — rule 5. A counter above 1
    // means a decision walk counted every pass of the action instead of the
    // first qualifying one.
    for (const key of PREFLOP_KEYS) {
      if (c[key] > 1) {
        problems.push(`${label}: ${key} is ${c[key]}, but preflop counters cap at 1`);
      }
    }

    // A bomb pot has no preflop betting round at all.
    if (facts.hand.isBombPot && c.vpip_opp !== 0) {
      problems.push(`${label}: bomb pot with a preflop opportunity`);
    }
  }
  return problems;
}

/**
 * Money keys the round trip compares.
 *
 * `out_of_pot` is deliberately outside it. It holds MicroGaming's
 * `BadBeatContribution` — chips taken off a stack that never reach the pot —
 * and the standard text is the GG dialect, which has no line shape for one.
 * PHF carries it as a `PhfChipMovement`, `toStandardText` cannot write it and
 * the hand comes back without it. Exactly the situation `psggInvariants.ts`
 * documents for a fold's exposed card, and handled the same way: the loss is
 * excluded from the comparison here and asserted to be *only* that, by
 * `outOfPotLossIsExplained` below, so a round trip that started losing real pot
 * money would still fail.
 */
const ROUND_TRIP_MONEY_KEYS = MONEY_KEYS.filter((key) => key !== "out_of_pot");

/** Facts reduced to the pairs the round trip compares: money and preflop. */
function comparable(facts: HandFacts): string {
  return JSON.stringify(
    facts.seats
      .map((seat) => [
        seat.seat,
        seat.player,
        ROUND_TRIP_MONEY_KEYS.map((key) => seat.money[key]),
        PREFLOP_KEYS.map((key) => seat.counters[key]),
      ])
      .sort((a, b) => (a[0] as number) - (b[0] as number)),
  );
}

/**
 * A seat only ever carries `out_of_pot` money when the hand records a chip
 * movement that bypassed the pot.
 *
 * The other half of the exception above: the round trip is allowed to drop
 * `out_of_pot` only because the figure comes from a `PhfChipMovement` the
 * standard text cannot express. If the derivation ever invented that number
 * from somewhere else, this would fail rather than being quietly tolerated.
 */
export function outOfPotLossIsExplained(hand: PhfHand): string[] {
  const facts = handFacts(hand);
  const carried = facts.seats.some((seat) => seat.money.out_of_pot !== 0);
  if (!carried) {
    return [];
  }
  const movements = (hand.chipMovements ?? []).filter(
    (movement) => !movement.toPot && movement.fromSeat !== null,
  );
  return movements.length > 0
    ? []
    : [`${hand.meta.handId}: a seat paid out of pot with no chip movement to explain it`];
}

/**
 * The derivation survives a trip out to standard text and back.
 *
 * This is the invariant that proves the engine reads PHF *structure*. GG writes
 * `posts straddle`, WePlay writes it differently, PokerStars does not write it
 * at all; if any counter were keyed off a room's wording rather than off the
 * action stream, the numbers would move when the hand came back through a
 * different dialect. The standard text is the GG dialect, so every hand in the
 * corpus that is not already GG makes this a genuine cross-dialect test.
 *
 * Only money and the preflop counters are compared, which is the part standard
 * text is known to carry losslessly — `psggInvariants.ts` documents the one
 * postflop reveal the format cannot express.
 */
export function roundTripFacts(hand: PhfHand): string[] {
  const back = parseStandardHand(toStandardText(hand), CTX);
  if (!back) {
    return [`${hand.meta.handId}: serialized text does not parse back`];
  }
  const before = comparable(handFacts(hand));
  const after = comparable(handFacts(back));
  return before === after
    ? []
    : [`${hand.meta.handId}: facts changed on round trip\n  before ${before}\n  after  ${after}`];
}

/**
 * Two derivations of the same document are byte identical.
 *
 * `buildContext` calls `assignPositions`, which mutates the hand it is given.
 * The guard that makes that safe — call it only when every position is null — is
 * invisible at the call site and is exactly the kind of thing a later change
 * removes by accident. This is the check that notices.
 */
export function deterministic(hand: PhfHand): string[] {
  const first = JSON.stringify(handFacts(hand));
  const second = JSON.stringify(handFacts(hand));
  return first === second ? [] : [`${hand.meta.handId}: two derivations differ`];
}

/**
 * Every derived row has exactly the checked-in columns, no more and no fewer.
 *
 * The schema-drift guard: a counter added to `types.ts` without a column in
 * `mapping.ts` would otherwise be derived, never stored, and silently read as
 * zero forever.
 */
export function rowSchema(hand: PhfHand): string[] {
  const rows = statsRows(handFacts(hand));
  const expected = [...STATS_COLUMNS].sort();
  const problems: string[] = [];
  for (const row of rows) {
    const keys = Object.keys(row).sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      const missing = expected.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !expected.includes(key));
      problems.push(
        `${hand.meta.handId}: row columns drifted; missing [${missing}] extra [${extra}]`,
      );
      break;
    }
  }
  return problems;
}

/** Every check above, for a table-driven "the whole corpus holds" assertion. */
export function allStatsInvariants(hand: PhfHand): string[] {
  return [
    ...moneyConservation(hand),
    ...potReconciles(hand),
    ...rakeSharesSum(hand),
    ...counterStructure(hand),
    ...outOfPotLossIsExplained(hand),
    ...deterministic(hand),
    ...rowSchema(hand),
    ...roundTripFacts(hand),
  ];
}
