import { useMemo } from "react";
import type { ReplayFrame } from "../../lib/replay";
import {
  toDisplayNumber,
  type Amount,
  type PhfHand,
  type PhfPlayerResult,
} from "../../lib/phf/types";
import { CardRow } from "./PlayingCard";
import type { NameMask, ReplaySettings } from "./replaySettings";
import type { AmountFormatter } from "./tableMath";

interface ShowdownStripProps {
  hand: PhfHand;
  frame: ReplayFrame;
  settings: ReplaySettings;
  mask: NameMask;
  format: AmountFormatter;
  onClose: () => void;
}

/**
 * Every fee a room can take out of a pot, in the order the summary line prints
 * them. Reading `PhfFees` field by field rather than showing `rake` alone is
 * the point of the sheet: a GG cash pot can lose money to five separate levies,
 * and "rake $0.15" on a hand that actually paid $0.15 rake plus $0.02 jackpot
 * plus $0.01 fortune is simply a wrong number.
 */
const FEE_LABELS: Array<{ key: keyof PhfHand["results"]["fees"]; label: string }> = [
  { key: "rake", label: "rake" },
  { key: "jackpot", label: "jackpot" },
  { key: "bingo", label: "bingo" },
  { key: "fortune", label: "fortune" },
  { key: "tax", label: "tax" },
  { key: "other", label: "other" },
];

/**
 * Who showed what, who won and how the pot split.
 *
 * A sheet over the felt rather than a block under it: in a layout that may not
 * scroll, a list whose length is decided by the hand cannot be allowed into the
 * main flow. Only rendered once the replay has reached the showdown, so it
 * never spoils the hand.
 */
export function ShowdownStrip({
  hand,
  frame,
  settings,
  mask,
  format,
  onClose,
}: ShowdownStripProps) {
  const unit = hand.game.unit;
  const money = (amount: Amount) => format(toDisplayNumber(amount, unit));

  const resultBySeat = useMemo(() => {
    const map = new Map<number, PhfPlayerResult>();
    for (const result of hand.results.players) {
      map.set(result.seat, result);
    }
    return map;
  }, [hand.results.players]);

  // "a pair of Aces" is on the summary row for everyone who was scored, and on
  // the show action for anyone the summary skipped.
  const descriptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const result of hand.results.players) {
      if (result.handDescription) {
        map.set(result.player, result.handDescription);
      }
    }
    for (const action of hand.actions) {
      if (action.type === "show" && action.description) {
        map.set(action.player, action.description);
      }
    }
    return map;
  }, [hand.results.players, hand.actions]);

  if (frame.street !== "showdown") {
    return null;
  }

  // When the hand ended before anyone turned their cards over there is nothing
  // to compare, so the sheet collapses to the result: who took it, for how
  // much. Hero's own cards are already face up on the felt and would otherwise
  // pad the list with a row that says nothing.
  const showdown = hand.results.wentToShowdown;
  const rows = frame.seats
    .filter((seat) => (showdown ? seat.cards !== null || seat.winAmount > 0 : seat.winAmount > 0))
    .sort((a, b) => b.winAmount - a.winAmount);

  if (rows.length === 0) {
    return null;
  }

  const fees = FEE_LABELS.filter(({ key }) => hand.results.fees[key] > 0);
  const splitPot = rows.filter((seat) => seat.winAmount > 0).length > 1;

  return (
    <aside className="rp__sheet rp__sheet--result" aria-label={showdown ? "Showdown" : "Result"}>
      <div className="rp__sheet-head">
        <span className="rp__sheet-title">{showdown ? "Showdown" : "Result"}</span>
        <span className="rp__sheet-note">
          Pot {money(hand.results.totalPot)}
          {/* The breakdown the summary reported, which is what the middle of
              the felt was drawing as separate piles. */}
          {hand.results.pots.length > 1
            ? hand.results.pots.map((pot) => (
                <span key={pot.name} className="rp__sheet-fee">
                  {" "}
                  · {pot.name.toLowerCase()} {money(pot.amount)}
                </span>
              ))
            : null}
          {fees.map(({ key, label }) => (
            <span key={key} className="rp__sheet-fee">
              {" "}
              · {label} {money(hand.results.fees[key])}
            </span>
          ))}
          {splitPot ? <span className="rp__sheet-fee"> · split</span> : null}
        </span>
        <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close result">
          ✕
        </button>
      </div>
      <ul className="rp__sheet-list rp__result-list">
        {rows.map((seat) => {
          // Hiding hero's holding has to hold here too, or the sheet would
          // spoil the very cards the felt is keeping face down.
          const hideHero = seat.isHero && !settings.showHeroCards;
          const result = resultBySeat.get(seat.seatNo);
          const note =
            result?.cashoutRisk !== null && result?.cashoutRisk !== undefined
              ? `cashed out · risk ${money(result.cashoutRisk)}`
              : (descriptions.get(seat.name) ?? "");
          return (
            <li
              key={seat.seatNo}
              className={`rp__result-row ${seat.winAmount > 0 ? "is-winner" : ""}`.trim()}
            >
              <span className="rp__result-who">
                {seat.position ? <span className="pseat__pos">{seat.position}</span> : null}
                <span className="rp__result-name">{mask.seat(seat.name)}</span>
              </span>
              <span className="rp__result-cards">
                {seat.cards && hideHero ? (
                  <CardRow cards={[null, null]} size="sm" />
                ) : seat.cards ? (
                  <CardRow cards={seat.cards} size="sm" />
                ) : showdown ? (
                  <span className="muted">{result?.mucked ? "mucked" : "folded"}</span>
                ) : null}
              </span>
              <span className="rp__result-desc">{hideHero ? "" : note}</span>
              <span className="rp__result-amount">
                {seat.winAmount > 0 ? `+${format(seat.winAmount)}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
