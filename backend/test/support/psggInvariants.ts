/**
 * Invariants asserted over the PokerStars and GGPoker corpora.
 *
 * These are deliberately the same checks `validateHand` makes, re-implemented
 * from the action stream rather than from the parser's own `results` block: a
 * parser that computed both from one broken number would pass the validator and
 * still be wrong. Each helper returns a list of human-readable problems so a
 * failing test names the hand.
 */

import {
  resolveRunout,
  totalFees,
  type PhfHand,
} from "../../../frontend/src/lib/phf/types.js";
import { parseStandardHand, toStandardText } from "../../../frontend/src/lib/phf/serialize.js";

/** One minor unit of slack, the same tolerance the validator uses. */
const TOLERANCE = 1;

/** Warning codes that mean the parser did not understand a line of the source. */
export const BLIND_SPOT_CODES = ["unknown-line", "unknown-summary-line", "dealt-to-unseated"];

export function blindSpots(hand: PhfHand): string[] {
  return hand.meta.warnings
    .filter((warning) => BLIND_SPOT_CODES.includes(warning.code))
    .map((warning) => `${hand.meta.handId} ${warning.code}: ${warning.message}`);
}

/** Everything that went in equals the pot the source reports. */
export function chipConservation(hand: PhfHand): string[] {
  let total = 0;
  for (const action of hand.actions) {
    if (action.type === "collect") {
      continue;
    }
    total += action.amount;
  }
  return Math.abs(total - hand.results.totalPot) > TOLERANCE
    ? [`${hand.meta.handId}: players put in ${total}, pot is ${hand.results.totalPot}`]
    : [];
}

/** No stack goes below zero at any point in the stream. */
export function noNegativeStacks(hand: PhfHand): string[] {
  const stacks = new Map(hand.players.map((player) => [player.name, player.startingStack]));
  const problems: string[] = [];
  for (const action of hand.actions) {
    if (action.type === "collect" || action.amount === 0) {
      continue;
    }
    const stack = stacks.get(action.player);
    if (stack === undefined) {
      continue;
    }
    const next = stack - action.amount;
    stacks.set(action.player, next);
    if (next < -TOLERANCE) {
      problems.push(`${hand.meta.handId}: ${action.player} at ${next} after "${action.rawLine}"`);
    }
  }
  return problems;
}

/** The whole pot is paid out, either before or after fees depending on the room. */
export function potFullyAwarded(hand: PhfHand): string[] {
  const out = hand.actions
    .filter((action) => action.type === "collect")
    .reduce((sum, action) => sum + action.amount, 0);
  if (out === 0) {
    return [];
  }
  const fees = totalFees(hand.results.fees);
  const net = Math.abs(out + fees - hand.results.totalPot) <= TOLERANCE;
  const gross = Math.abs(out - hand.results.totalPot) <= TOLERANCE;
  return net || gross
    ? []
    : [`${hand.meta.handId}: collected ${out} + fees ${fees} != pot ${hand.results.totalPot}`];
}

/** An uncalled return never exceeds what the player put in on that street. */
export function uncalledWithinCommitment(hand: PhfHand): string[] {
  const problems: string[] = [];
  let key = "";
  let commit = new Map<string, number>();
  for (const action of hand.actions) {
    const actionKey = `${action.street}:${action.runoutIndex}`;
    if (actionKey !== key) {
      key = actionKey;
      commit = new Map();
    }
    if (action.type === "uncalled" && -action.amount > (commit.get(action.player) ?? 0) + TOLERANCE) {
      problems.push(
        `${hand.meta.handId}: ${action.player} returned ${-action.amount} of ${commit.get(action.player) ?? 0}`,
      );
    }
    commit.set(action.player, (commit.get(action.player) ?? 0) + action.amount);
  }
  return problems;
}

/** Every actor is seated and every card is dealt at most once. */
export function seatsAndCards(hand: PhfHand): string[] {
  const problems: string[] = [];
  const seated = new Set(hand.players.map((player) => player.name));
  for (const action of hand.actions) {
    if (!seated.has(action.player)) {
      problems.push(`${hand.meta.handId}: "${action.player}" acts but is not seated`);
    }
  }
  const seen = new Set<string>();
  const cards = [
    ...hand.players.flatMap((player) => player.holeCards),
    ...hand.board.runouts.flatMap((run, index) => {
      if (index === 0) {
        return resolveRunout(hand.board, 0);
      }
      const resolved = resolveRunout(hand.board, index);
      return [
        ...(run.flop ? resolved.slice(0, 3) : []),
        ...(run.turn ? [run.turn] : []),
        ...(run.river ? [run.river] : []),
      ];
    }),
  ];
  for (const card of cards) {
    if (seen.has(card)) {
      problems.push(`${hand.meta.handId}: ${card} is dealt twice`);
    }
    seen.add(card);
  }
  return problems;
}

/**
 * The hand survives a trip out to standard text and back.
 *
 * Only the money-moving actions are compared in order: `toStandardText` groups
 * by street, so a `doesn't show hand` that the source printed after the collect
 * comes back before it. That reordering changes no arithmetic, and the
 * zero-amount actions are compared as a set so it is still caught if one is
 * lost.
 *
 * One reveal is deliberately outside the comparison. PokerStars writes
 * `Player6: folds [Ks]` when a player exposes a card on the way out; standard
 * text is the GG dialect and has no line shape for it, so the card cannot come
 * back. The hand that loses it says so - the parser records a
 * `reveal-not-serializable` warning - and `foldRevealIsFlagged` below asserts
 * that, so the loss is checked rather than merely tolerated.
 */
export function roundTripsThroughStandardText(hand: PhfHand): string[] {
  const text = toStandardText(hand);
  const back = parseStandardHand(text, {
    siteId: "standard",
    siteName: "standard",
    originalFilename: null,
  });
  if (!back) {
    return [`${hand.meta.handId}: serialized text does not parse back`];
  }
  const moving = (input: PhfHand) =>
    JSON.stringify(
      input.actions
        .filter((action) => action.amount !== 0 || action.type === "collect")
        .map((a) => [a.street, a.type, a.amount, a.streetTotal, a.player, a.runoutIndex]),
    );
  const still = (input: PhfHand) =>
    JSON.stringify(
      input.actions
        .filter((action) => action.amount === 0 && action.type !== "collect")
        // A fold's exposed card has no standard-text form; see the doc comment.
        .map((a) => `${a.type}/${a.player}/${a.type === "fold" ? "" : (a.cards ?? []).join("")}`)
        .sort(),
    );
  const board = (input: PhfHand) =>
    JSON.stringify(input.board.runouts.map((_, i) => resolveRunout(input.board, i)));
  const problems: string[] = [];
  if (moving(hand) !== moving(back)) {
    problems.push(`${hand.meta.handId}: money actions changed on round trip`);
  }
  if (still(hand) !== still(back)) {
    problems.push(`${hand.meta.handId}: zero-amount actions changed on round trip`);
  }
  if (board(hand) !== board(back)) {
    problems.push(`${hand.meta.handId}: board changed on round trip`);
  }
  if (hand.results.totalPot !== back.results.totalPot) {
    problems.push(`${hand.meta.handId}: pot changed on round trip`);
  }
  if (JSON.stringify(hand.results.fees) !== JSON.stringify(back.results.fees)) {
    problems.push(`${hand.meta.handId}: fees changed on round trip`);
  }
  return problems;
}

/**
 * A hand that loses a reveal on the way out has to admit it.
 *
 * This is the other half of the exception `roundTripsThroughStandardText`
 * makes: the round trip is allowed to drop a fold's exposed card only because
 * the parser flags the hand, so a parser that silently stopped flagging would
 * fail here rather than quietly passing the round trip.
 */
export function foldRevealIsFlagged(hand: PhfHand): string[] {
  const exposing = hand.actions.filter(
    (action) => action.type === "fold" && (action.cards?.length ?? 0) > 0,
  );
  if (exposing.length === 0) {
    return [];
  }
  return hand.meta.warnings.some((warning) => warning.code === "reveal-not-serializable")
    ? []
    : [`${hand.meta.handId}: a fold exposed a card but the hand does not flag the loss`];
}

/** Every check above, for a table-driven "the whole corpus holds" assertion. */
export function allInvariants(hand: PhfHand): string[] {
  return [
    ...blindSpots(hand),
    ...foldRevealIsFlagged(hand),
    ...chipConservation(hand),
    ...noNegativeStacks(hand),
    ...potFullyAwarded(hand),
    ...uncalledWithinCommitment(hand),
    ...seatsAndCards(hand),
    ...roundTripsThroughStandardText(hand),
  ];
}
