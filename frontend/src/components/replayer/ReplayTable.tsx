import { useEffect, useMemo, useRef, useState } from "react";
import type { ParsedHand } from "../../lib/handParser";
import type { ReplayFrame, SeatFrameState } from "../../lib/replay";
import { ChipStack } from "./ChipStack";
import { PlayingCard } from "./PlayingCard";
import { actionTone, type AmountFormatter } from "./tableMath";

interface ReplayTableProps {
  hand: ParsedHand;
  frame: ReplayFrame;
  /** Reveal every player's known cards regardless of the replay position. */
  revealAll: boolean;
  /** Renders every chip amount in the unit the viewer picked. */
  format: AmountFormatter;
}

interface Placement {
  seat: SeatFrameState;
  /** Unit vector around the seat ring; CSS turns it into a left/top pair. */
  cos: number;
  sin: number;
  side: "left" | "right" | "center";
  row: "top" | "bottom" | "middle";
}

/**
 * Seats sit on an ellipse with the hero at the bottom. Only the angle is
 * decided here — the radii live in CSS so the ring can be reshaped per
 * breakpoint without re-rendering.
 */
function placeSeats(seats: SeatFrameState[]): Placement[] {
  const count = seats.length;
  if (count === 0) {
    return [];
  }
  const heroIndex = Math.max(
    0,
    seats.findIndex((seat) => seat.isHero),
  );

  return seats.map((seat, index) => {
    const relative = (index - heroIndex + count) % count;
    const angle = ((90 + relative * (360 / count)) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      seat,
      cos,
      sin,
      side: cos < -0.3 ? "left" : cos > 0.3 ? "right" : "center",
      row: sin > 0.55 ? "bottom" : sin < -0.55 ? "top" : "middle",
    };
  });
}

/**
 * On a phone the felt is portrait and the board fills most of its width, so
 * seats sitting near the horizontal midline collide with it. Pushing |sin|
 * towards 1 slides those seats up and down out of the board's band; the cosine
 * is recomputed from the circle so every seat stays exactly on the ellipse.
 * The stylesheet picks between the two rings at the phone breakpoint.
 */
const NARROW_SIN_EXP = 0.55;

function ringStyle(cos: number, sin: number): React.CSSProperties {
  const sinN = Math.sign(sin) * Math.abs(sin) ** NARROW_SIN_EXP;
  const cosN = Math.sign(cos) * Math.sqrt(Math.max(0, 1 - sinN * sinN));
  return {
    "--cos-w": cos.toFixed(4),
    "--sin-w": sin.toFixed(4),
    "--cos-n": cosN.toFixed(4),
    "--sin-n": sinN.toFixed(4),
  } as React.CSSProperties;
}

interface SweepChip {
  key: string;
  cos: number;
  sin: number;
  amount: number;
  amountBb: number;
}

export function ReplayTable({ hand, frame, revealAll, format }: ReplayTableProps) {
  const placements = useMemo(() => placeSeats(frame.seats), [frame.seats]);
  const knownCards = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const seat of hand.seats) {
      if (seat.cards.length > 0) {
        map.set(seat.name, seat.cards);
      }
    }
    return map;
  }, [hand.seats]);

  const hasSecondBoard = frame.boardSecond.length > 0;
  const isAward = frame.kind === "award";

  // Chips sweeping from the bet ring into the middle. The frame the bets
  // vanish on no longer carries them, so the previous frame is kept around
  // purely to animate the hand-off.
  const previous = useRef<ReplayFrame | null>(null);
  const [sweep, setSweep] = useState<{ atIndex: number; chips: SweepChip[] } | null>(null);

  useEffect(() => {
    const prior = previous.current;
    previous.current = frame;
    const steppedForward = prior !== null && frame.index === prior.index + 1;
    if (steppedForward && frame.kind === "collect" && frame.pot > prior.pot) {
      const chips = placeSeats(prior.seats)
        .filter((placement) => placement.seat.bet > 0)
        .map((placement) => ({
          key: `${frame.index}-${placement.seat.seatNo}`,
          cos: placement.cos,
          sin: placement.sin,
          amount: placement.seat.bet,
          amountBb: placement.seat.betBb,
        }));
      setSweep(chips.length > 0 ? { atIndex: frame.index, chips } : null);
      return;
    }
    setSweep((current) => (current && current.atIndex === frame.index ? current : null));
  }, [frame]);

  return (
    // The seat count drives sizing on phones: nine plates and a five-card
    // board do not fit the same portrait oval that six do.
    <div className="ptable" data-seats={frame.seats.length}>
      <div className="ptable__felt">
        <div className="ptable__rail" />
        <div className="ptable__logo" aria-hidden="true">
          {hand.tableName ?? "Hand Replayer"}
        </div>

        <div className="ptable__center">
          <div className="ptable__pot">
            <span className="ptable__pot-label">Pot</span>
            <span className="ptable__pot-value">{format(frame.pot, frame.potBb)}</span>
            {frame.potWithBets > frame.pot ? (
              <span className="ptable__pot-total">
                {format(frame.potWithBets, frame.potWithBetsBb)} total
              </span>
            ) : null}
          </div>

          <div className={`ptable__boards ${hasSecondBoard ? "ptable__boards--twin" : ""}`.trim()}>
            <div className="ptable__board">
              {Array.from({ length: 5 }, (_, index) => {
                const code = frame.board[index] ?? null;
                return code ? (
                  <PlayingCard key={`b1-${index}-${code}`} code={code} size="xl" dealIndex={index} />
                ) : (
                  <span key={`b1-slot-${index}`} className="board-slot" aria-hidden="true" />
                );
              })}
            </div>
            {hasSecondBoard ? (
              <div className="ptable__board ptable__board--second">
                <span className="ptable__board-tag">Run 2</span>
                {frame.boardSecond.map((code, index) => (
                  <PlayingCard key={`b2-${index}-${code}`} code={code} size="lg" dealIndex={index} />
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {sweep?.chips.map((chip) => (
          <div key={chip.key} className="ptable__sweep" style={ringStyle(chip.cos, chip.sin)}>
            <ChipStack
              amount={chip.amount}
              amountBb={chip.amountBb}
              bigBlind={hand.bigBlind}
              format={format}
              label={null}
              variant="sweep"
            />
          </div>
        ))}

        {placements.map(({ seat, cos, sin }) =>
          seat.bet > 0 ? (
            <div key={`bet-${seat.seatNo}`} className="ptable__bet" style={ringStyle(cos, sin)}>
              <ChipStack
                amount={seat.bet}
                amountBb={seat.betBb}
                bigBlind={hand.bigBlind}
                format={format}
                variant="bet"
              />
            </div>
          ) : null,
        )}

        {isAward
          ? placements
              .filter(({ seat }) => seat.winAmount > 0)
              .map(({ seat, cos, sin }) => (
                <div key={`award-${seat.seatNo}`} className="ptable__award" style={ringStyle(cos, sin)}>
                  <ChipStack
                    amount={seat.winAmount}
                    bigBlind={hand.bigBlind}
                    format={format}
                    label={null}
                    variant="pot"
                  />
                </div>
              ))
          : null}

        {placements.map(({ seat, cos, sin, side, row }) => {
          const revealed = seat.cards ?? (revealAll ? (knownCards.get(seat.name) ?? null) : null);
          // Folded players keep two greyed-out backs. An empty gap where the
          // cards were reads as "not in this hand at all", which is wrong, and
          // it leaves the FOLDED marker floating with nothing to sit on.
          const cards = revealed ?? (seat.hasCards || seat.folded ? [null, null] : []);
          const tone = actionTone(seat.lastAction);
          return (
            <div
              key={`seat-${seat.seatNo}`}
              className={[
                "pseat",
                `pseat--${side}`,
                `pseat--row-${row}`,
                seat.folded ? "pseat--folded" : "",
                seat.isActing ? "pseat--acting" : "",
                seat.isHero ? "pseat--hero" : "",
                seat.allIn ? "pseat--allin" : "",
                seat.winAmount > 0 ? "pseat--winner" : "",
                cards.length === 0 ? "pseat--nocards" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={ringStyle(cos, sin)}
            >
              <div className="pseat__cards">
                {cards.map((code, index) => (
                  <PlayingCard
                    key={`${seat.seatNo}-${index}-${code ?? "back"}`}
                    code={code}
                    size={seat.isHero ? "lg" : "md"}
                    dimmed={seat.folded}
                    highlighted={seat.winAmount > 0}
                    dealIndex={index}
                  />
                ))}
              </div>

              <div className="pseat__plate">
                <span className="pseat__name">
                  {seat.position ? <span className="pseat__pos">{seat.position}</span> : null}
                  <span className="pseat__nick">{seat.name}</span>
                </span>
                <span className="pseat__stack">
                  {seat.allIn && seat.stack <= 0 ? (
                    <span className="pseat__allin-text">ALL-IN</span>
                  ) : (
                    format(seat.stack, seat.stackBb)
                  )}
                </span>
              </div>

              {seat.isButton ? (
                <span className="pseat__button" title="Dealer button">
                  D
                </span>
              ) : null}

              {seat.folded ? <span className="pseat__state pseat__state--fold">Folded</span> : null}

              {/* The win label arrives pre-formatted in currency, so it is the
                  one action pill that has to be re-rendered to honour the
                  big-blind toggle. */}
              {seat.winAmount > 0 ? (
                <span className="pseat__action pseat__action--win">
                  +{format(seat.winAmount)}
                </span>
              ) : seat.lastAction ? (
                <span className={`pseat__action pseat__action--${tone}`}>{seat.lastAction}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
