import { useMemo } from "react";
import type { ParsedHand } from "../../lib/handParser";
import type { ReplayFrame } from "../../lib/replay";
import { CardRow } from "./PlayingCard";
import type { NameMask, ReplaySettings } from "./replaySettings";
import type { AmountFormatter } from "./tableMath";

interface ShowdownStripProps {
  hand: ParsedHand;
  frame: ReplayFrame;
  settings: ReplaySettings;
  mask: NameMask;
  format: AmountFormatter;
}

/**
 * Who showed what, who won and how the pot split. Only rendered once the
 * replay has actually reached the showdown so it never spoils the hand.
 */
export function ShowdownStrip({ hand, frame, settings, mask, format }: ShowdownStripProps) {
  // "a pair of Aces" lives on the show action; the frame only carries it for
  // the single frame the player turns their cards over.
  const descriptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const action of hand.actions) {
      if (action.type === "show" && action.description) {
        map.set(action.player, action.description);
      }
    }
    return map;
  }, [hand.actions]);

  if (frame.street !== "showdown") {
    return null;
  }

  // When the hand ended before anyone turned their cards over there is nothing
  // to compare, so the strip collapses to the result: who took it, for how
  // much. Hero's own cards are already face up on the felt and would otherwise
  // pad the list with a row that says nothing.
  const showdown = hand.wentToShowdown;
  const rows = frame.seats
    .filter((seat) => (showdown ? seat.cards !== null || seat.winAmount > 0 : seat.winAmount > 0))
    .sort((a, b) => b.winAmount - a.winAmount);

  if (rows.length === 0) {
    return null;
  }

  const splitPot = rows.filter((seat) => seat.winAmount > 0).length > 1;

  return (
    <div className="replay__showdown">
      <div className="replay__showdown-head">
        <span>{showdown ? "Showdown" : "Result"}</span>
        <span className="replay__showdown-pot">
          Pot {format(hand.totalPot)}
          {hand.rake > 0 ? <span className="replay__showdown-rake"> · rake {format(hand.rake)}</span> : null}
          {splitPot ? <span className="replay__showdown-rake"> · split</span> : null}
        </span>
      </div>
      <ul className="replay__showdown-list">
        {rows.map((seat) => {
          // Hiding hero's holding has to hold here too, or the strip would
          // spoil the very cards the felt is keeping face down.
          const hideHero = seat.isHero && !settings.showHeroCards;
          return (
            <li
              key={seat.seatNo}
              className={`replay__showdown-row ${seat.winAmount > 0 ? "is-winner" : ""}`.trim()}
            >
              <span className="replay__showdown-who">
                {seat.position ? <span className="pseat__pos">{seat.position}</span> : null}
                <span className="replay__showdown-name">{mask.seat(seat.name)}</span>
              </span>
              <span className="replay__showdown-cards">
                {seat.cards && hideHero ? (
                  <CardRow cards={[null, null]} size="sm" />
                ) : seat.cards ? (
                  <CardRow cards={seat.cards} size="sm" />
                ) : showdown ? (
                  <span className="muted">mucked</span>
                ) : null}
              </span>
              <span className="replay__showdown-desc">
                {hideHero ? "" : (descriptions.get(seat.name) ?? "")}
              </span>
              <span className="replay__showdown-amount">
                {seat.winAmount > 0 ? `+${format(seat.winAmount)}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
