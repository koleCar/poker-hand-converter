import { useEffect, useMemo, useRef, useState } from "react";
import type { ParsedHand } from "../../lib/handParser";
import type { ReplayFrame, SeatFrameState } from "../../lib/replay";
import { ChipStack } from "./ChipStack";
import { PlayingCard } from "./PlayingCard";
import type { NameMask, ReplaySettings } from "./replaySettings";
import { actionTone, type AmountFormatter } from "./tableMath";

interface ReplayTableProps {
  hand: ParsedHand;
  frame: ReplayFrame;
  /** Card visibility and naming preferences from the header gear. */
  settings: ReplaySettings;
  /** Neutral labels when anonymous mode is on; pass-through otherwise. */
  mask: NameMask;
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
 * |sin| above which a seat counts as sitting at the top or the bottom of the
 * oval rather than on one of its flanks. It decides the seat's own nudge back
 * inside the felt and, with it, which way that seat's chips step away.
 */
const ROW_SIN = 0.55;

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
      row: sin > ROW_SIN ? "bottom" : sin < -ROW_SIN ? "top" : "middle",
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

/**
 * A seat at the very top, bottom or side of the ring lands on a sine or cosine
 * of 1e-16 rather than a clean zero, and which side of zero that lands on
 * decides which way its chips step. Anything this small is a straight angle.
 */
const RING_EPSILON = 1e-6;

function ringStyle(cos: number, sin: number): React.CSSProperties {
  const sinN = Math.sign(sin) * Math.abs(sin) ** NARROW_SIN_EXP;
  const cosN = Math.sign(cos) * Math.sqrt(Math.max(0, 1 - sinN * sinN));
  // Which way this seat's chips step out of its own hand: in towards the
  // middle of the felt, which is where the room is, unless the seat is across
  // the top — an inward step there runs into the pot — or sitting dead centre
  // at the bottom, where "inwards" means nothing. Those slide along the ring
  // instead, and all of them the same way round, so that two seats sharing an
  // end of the felt never aim their chips at the same gap.
  const alongRing = sin < -ROW_SIN || Math.abs(cos) < RING_EPSILON;
  return {
    "--cos-w": cos.toFixed(4),
    "--sin-w": sin.toFixed(4),
    "--cos-n": cosN.toFixed(4),
    "--sin-n": sinN.toFixed(4),
    "--bet-sx": String(-Math.sign(alongRing ? sin : cos)),
    // Which end of the felt the seat belongs to. Only the phone layout, which
    // stacks the chips above and below the board, has any use for it; a seat
    // dead on the midline has no end of its own and is sent below, where the
    // felt is emptier.
    "--bet-sy": String(Math.abs(sin) < RING_EPSILON ? -1 : -Math.sign(sin)),
  } as React.CSSProperties;
}

/**
 * `ROW_SIN` seen through the warp above: a seat is at an end of the phone's
 * ring once `|sin| ** NARROW_SIN_EXP` passes `ROW_SIN`. The phone layout cares
 * about the warped ring, because that is the one it draws.
 */
const NARROW_ROW_SIN = ROW_SIN ** (1 / NARROW_SIN_EXP);

/**
 * The chip spot depends on which way the seat is nudged back inside the felt,
 * on how big its cards are and — on a phone — on whether its hand is level
 * with the board, none of which the vectors above carry.
 */
function chipClass(sin: number, row: Placement["row"], isHero: boolean): string {
  // "flat" is a seat dead on the midline, which four- and eight-handed tables
  // have: its hand is level with the board rather than above or below it, so
  // it wants the height of an end seat's stack and the sideways step of a
  // middle one.
  const narrowRow =
    Math.abs(sin) < RING_EPSILON
      ? "flat"
      : Math.abs(sin) > NARROW_ROW_SIN
        ? "end"
        : "middle";
  return [
    "ptable__chips",
    `ptable__chips--row-${row}`,
    `ptable__chips--nrow-${narrowRow}`,
    isHero ? "ptable__chips--hero" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

interface SweepChip {
  key: string;
  cos: number;
  sin: number;
  row: Placement["row"];
  isHero: boolean;
  amount: number;
  amountBb: number;
}

export function ReplayTable({ hand, frame, settings, mask, format }: ReplayTableProps) {
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
          row: placement.row,
          isHero: placement.seat.isHero,
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
          {mask.tableName ?? "Hand Replayer"}
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
          <div
            key={chip.key}
            className={`ptable__sweep ${chipClass(chip.sin, chip.row, chip.isHero)}`}
            style={ringStyle(chip.cos, chip.sin)}
          >
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

        {placements.map(({ seat, cos, sin, row }) =>
          seat.bet > 0 ? (
            <div
              key={`bet-${seat.seatNo}`}
              className={`ptable__bet ${chipClass(sin, row, seat.isHero)}`}
              style={ringStyle(cos, sin)}
            >
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
              .map(({ seat, cos, sin, row }) => (
                <div
                  key={`award-${seat.seatNo}`}
                  className={`ptable__award ${chipClass(sin, row, seat.isHero)}`}
                  style={ringStyle(cos, sin)}
                >
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
          const known =
            seat.cards ?? (settings.showKnownCards ? (knownCards.get(seat.name) ?? null) : null);
          // Hero's own cards can be put back face down to review the spot
          // blind; everyone else's visibility is the replay position's call.
          const revealed = seat.isHero && !settings.showHeroCards ? null : known;
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
                  {/* Long screen names still have to ellipsis at nine seats on
                      a phone, so the full one stays reachable on hover and to
                      a screen reader. */}
                  <span className="pseat__nick" title={mask.seat(seat.name)}>
                    {mask.seat(seat.name)}
                  </span>
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
