/**
 * The heuristic fallback of `docs/ANALYSIS-PLAN.md` §3.6: checks that are true
 * whatever strategy the reference would play.
 *
 * No frequencies, no EVs, no grades. Each check either holds or does not, and
 * when it holds it produces a **flag** — a note the hand panel shows next to the
 * decision, never a grade. Two rules make that safe:
 *
 * 1. **Severity is capped at `inaccurate`.** The type has no worse member. A
 *    heuristic that could call a move a Blunder would be the confident wrong
 *    answer §9 lists as the first risk.
 * 2. **Anything that leans on a placeholder range is a `note`.** Only a check
 *    that holds against *any two cards* — folding the nuts, folding when a
 *    check was free — is allowed to reach `inaccurate`. The default ranges in
 *    `ranges.ts` are a guess, and a guess does not get to be loud.
 *
 * The margins below are wide on purpose. "You needed 25% and had 22%" is noise
 * against a placeholder range; "you needed 25% and had 4%" is not.
 */

import type { Spot } from "./walk";
import type { Flag, SpotFacts } from "./types";

/** A call this far under the price, with no cards to come, is flagged. */
export const CALL_SHORTFALL = 0.15;
/** A fold this far over the price, with no cards to come, is flagged. */
export const FOLD_SURPLUS = 0.2;
/** Equity under this against the range is "beats nothing". */
export const BEATS_NOTHING = 0.005;
/** Behind after a bet, as a share of the pot if called, under which the bet is a commitment in all but name. */
export const THIN_BEHIND = 0.25;
/** Share of the starting stack already in, past which a cheap fold is a committed fold… */
export const COMMITTED_SHARE = 0.4;
/** …when the price needed less than this much equity. */
export const COMMITTED_PRICE = 0.2;

export interface HeuristicInput {
  spot: Spot;
  facts: SpotFacts;
  /** The hero cannot lose to any holding at all — the nuts, against any two cards. */
  cannotLose: boolean;
  /** The hero beats or ties no holding at all, against any two cards. */
  beatsNoHolding: boolean;
  /** No card and no decision is left after this one if the hero continues. */
  noMoreCards: boolean;
  /** The hero's starting stack, minor units. */
  startingStack: number;
  /** Minor units per big blind. */
  bigBlind: number;
}

const pct = (value: number) => Math.round(value * 100);
/** Big blinds to one decimal: the precision every sentence quoting them shows. */
const tenth = (value: number) => Math.round(value * 10) / 10;

/** Every flag that holds for one decision, loudest first. */
export function heuristicFlags(input: HeuristicInput): Flag[] {
  const { spot, facts, cannotLose, noMoreCards } = input;
  const flags: Flag[] = [];
  const action = spot.decision.type;
  const equity = facts.equity?.value ?? null;

  if (action === "fold" && spot.toCall === 0) {
    flags.push({ code: "free-fold", severity: "inaccurate", params: {} });
  }

  if (action === "fold" && spot.toCall > 0 && cannotLose) {
    flags.push({
      code: "fold-nuts",
      severity: "inaccurate",
      params: { hand: facts.made?.class ?? "" },
    });
  }

  if (action === "call" && facts.street === "river" && equity !== null && equity < BEATS_NOTHING) {
    flags.push({
      code: "call-beats-nothing",
      severity: input.beatsNoHolding ? "inaccurate" : "note",
      params: { range: facts.equity?.range ?? "" },
    });
  } else if (
    action === "call" &&
    noMoreCards &&
    equity !== null &&
    facts.potOdds !== null &&
    equity < facts.potOdds - CALL_SHORTFALL
  ) {
    flags.push({
      code: "call-without-odds",
      severity: "note",
      params: { needed: pct(facts.potOdds), equity: pct(equity), range: facts.equity?.range ?? "" },
    });
  }

  // A fold is judged against the strongest quarter of the range on the river
  // (`SpotFacts.equity.strong`), never the whole of it: the placeholder range
  // is not narrowed by the betting, and a whole preflop range would make every
  // fold to a big river bet look like a fold with odds. Facing a river *raise*
  // there is no check at all: a range that bets and then raises is narrower
  // than any fixed share of a preflop range, and guessing how much narrower
  // is inventing the strategy A4 will compute. Before the river (an all-in
  // with cards to come) there is no betting yet to narrow by.
  const foldEquity = facts.street === "river" ? (facts.equity?.strong ?? null) : equity;
  const riverRaise = facts.street === "river" && spot.decision.raisesBefore > 0;
  if (
    action === "fold" &&
    !riverRaise &&
    spot.toCall > 0 &&
    !cannotLose &&
    noMoreCards &&
    foldEquity !== null &&
    facts.potOdds !== null &&
    foldEquity > facts.potOdds + FOLD_SURPLUS
  ) {
    flags.push({
      code: "fold-with-odds",
      severity: "note",
      params: { needed: pct(facts.potOdds), equity: pct(foldEquity), range: facts.equity?.range ?? "" },
    });
  }

  if (
    action === "check" &&
    facts.street === "river" &&
    spot.closesStreet &&
    spot.inPosition === true &&
    facts.made?.nuts
  ) {
    flags.push({ code: "check-back-nuts", severity: "note", params: { hand: facts.made.class } });
  }

  if ((action === "bet" || action === "raise") && !spot.action.allIn) {
    const behind = spot.heroBehind - spot.amount;
    const ifCalled = spot.potBefore + spot.amount + Math.max(0, spot.streetTotalAfter - spot.streetHigh);
    if (behind > 0 && ifCalled > 0 && behind < THIN_BEHIND * ifCalled) {
      flags.push({
        code: "thin-stack-behind",
        severity: "note",
        params: { behind: tenth(facts.behindBb ?? 0), pot: tenth(ifCalled / Math.max(1, input.bigBlind)) },
      });
    }
  }

  if (
    action === "fold" &&
    spot.toCall > 0 &&
    facts.potOdds !== null &&
    facts.potOdds < COMMITTED_PRICE &&
    input.startingStack > 0 &&
    (input.startingStack - spot.heroBehind) / input.startingStack >= COMMITTED_SHARE
  ) {
    flags.push({
      code: "committed-fold",
      severity: "note",
      params: {
        needed: pct(facts.potOdds),
        invested: pct((input.startingStack - spot.heroBehind) / input.startingStack),
      },
    });
  }

  return flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "inaccurate" ? -1 : 1));
}
