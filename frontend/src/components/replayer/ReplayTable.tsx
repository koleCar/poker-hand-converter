/**
 * The felt.
 *
 * Everything in here is placed off `seatLayout`'s slot table: a seat's anchor,
 * which corner of the seat block lands on it, and where that seat's chips go
 * are all designed numbers, not an angle plus a radius guessed per breakpoint.
 * Positioning uses the independent `translate` property rather than
 * `transform`, so the deal-in and pop animations — which own `transform` —
 * can never knock a seat off its slot.
 *
 * Sizes are all `calc(N * var(--u))`, where `--u` is one percent of the felt
 * box's shorter side. `--u` is declared on `.rp__felt` and *not* on
 * `.rp__fit`: a container's own declarations resolve `cq*` units against its
 * ancestor, so a `1cqmin` written on the box it is meant to measure would
 * silently measure the stage instead.
 */

import { useMemo, useRef, useState } from "react";
import { holeCardCount, toDisplayNumber, type PhfHand } from "../../lib/phf/types";
import type { ReplayFrame, SeatFrameState } from "../../lib/replay";
import { ChipStack } from "./ChipStack";
import { PlayingCard } from "./PlayingCard";
import type { NameMask, ReplaySettings } from "./replaySettings";
import {
  SHAPE_METRICS,
  clampSeatCount,
  seatSizeFor,
  slotIndex,
  slotsFor,
  type SeatSlot,
  type TableShape,
} from "./seatLayout";
import { actionTone, describeSeat, spokenPosition, type AmountFormatter } from "./tableMath";
import { TravellingChips } from "./TravellingChips";
import type { FrameMotion } from "./useFrameTransition";

interface ReplayTableProps {
  hand: PhfHand;
  frame: ReplayFrame;
  /** Chosen by the viewer's ResizeObserver so the slots and CSS agree. */
  shape: TableShape;
  /**
   * `"step"` while the frame on screen was reached by a single forward step,
   * `"none"` for a scrub, a jump, or a reduced-motion reader. Chips only
   * travel on a step; see `useFrameTransition`.
   */
  motion: FrameMotion;
  /** Card visibility and naming preferences from the header gear. */
  settings: ReplaySettings;
  /** Neutral labels when anonymous mode is on; pass-through otherwise. */
  mask: NameMask;
  /** Renders every chip amount in the unit the viewer picked. */
  format: AmountFormatter;
  /**
   * Seat the surrounding page is talking about — the one a forum post asks
   * "what would you do?" about, which is very often not the hero.
   *
   * It only marks a seat; it changes nothing about what is shown, because the
   * seat's cards are the replay position's call and a post must not be able to
   * turn them face up early.
   */
  focusSeat?: number | null;
}

interface Placed {
  seat: SeatFrameState;
  slot: SeatSlot;
}

/**
 * How far each hole card slides over the one before it, as a share of a card.
 *
 * Face-down cards carry no information, so they need no legibility: a covered
 * PLO6 hand is drawn as the same fixed-width block as a Hold'em one, which is
 * the single thing that makes nine-handed Omaha fit at all. Only a hand that
 * has actually been turned over opens out — and a seat that opens out pops, so
 * the extra width lands over the felt rather than over its neighbour.
 */
function fanSteps(holeCount: number): { down: number; up: number } {
  const count = Math.max(2, holeCount);
  return {
    // Total width is card * 1.75 whatever the count.
    down: 1 - 0.75 / (count - 1),
    up: count <= 2 ? 0.12 : count <= 4 ? 0.3 : 0.46,
  };
}

/** Where a chip stack hangs relative to its designed spot. */
function chipTranslate(anchor: SeatSlot["chipAnchor"]): string {
  return `${(anchor - 1) * 50}% -50%`;
}

/**
 * Where the deck sits: top-centre of the felt, just inside the rail.
 *
 * Cards used to fade in from nowhere, which is the one thing a real table
 * never does. Giving the deal an origin — even a short slide out of it — is
 * the cheapest "this is a table" win available, and it costs a unit vector.
 */
const DECK = { x: 0.5, y: 0.055 };

/** The middle, where chips are swept to and pots are pushed out of. */
const MIDDLE = { x: 0.5, y: 0.5 };

interface Direction {
  x: number;
  y: number;
}

/**
 * Unit vector from one point on the felt to another.
 *
 * Both points are fractions of the felt *box*, so they measure different
 * lengths on the two axes; `ratio` (the shape's aspect ratio) is what turns
 * them back into a direction. The result is then in the same units on both
 * axes, which is what lets the stylesheet multiply it by a single `--u`
 * distance and get a slide that points where it is aimed at every shape.
 */
function towards(from: Direction, to: Direction, ratio: number): Direction {
  const dx = (to.x - from.x) * ratio;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return { x: 0, y: -1 };
  }
  return { x: dx / length, y: dy / length };
}

/** The two directions a seat's motion is aimed along. */
interface SeatAim {
  /** Seat -> deck: which way its cards slide in from. */
  deal: Direction;
  /** Chip spot -> seat: which way its bet is pushed out from. */
  bet: Direction;
}

function aimFor(slot: SeatSlot, ratio: number): SeatAim {
  return {
    deal: towards({ x: slot.x, y: slot.y }, DECK, ratio),
    bet: towards({ x: slot.cx, y: slot.cy }, { x: slot.x, y: slot.y }, ratio),
  };
}

/** Direction custom properties, for the deal-in and bet-out keyframes. */
function aimStyle(prefix: string, direction: Direction): React.CSSProperties {
  return { [`--${prefix}-x`]: direction.x, [`--${prefix}-y`]: direction.y } as React.CSSProperties;
}

function slotStyle(slot: SeatSlot): React.CSSProperties {
  return {
    left: `${slot.x * 100}%`,
    top: `${slot.y * 100}%`,
    translate: `${-slot.ax * 100}% ${-slot.ay * 100}%`,
  };
}

function chipStyle(slot: SeatSlot): React.CSSProperties {
  return {
    left: `${slot.cx * 100}%`,
    top: `${slot.cy * 100}%`,
    translate: chipTranslate(slot.chipAnchor),
  };
}

interface SweepChip {
  key: string;
  slot: SeatSlot;
  amount: number;
  amountBb: number;
}

/** Pairs every seat with the slot it belongs in, hero first. */
function place(seats: SeatFrameState[], shape: TableShape): Placed[] {
  const count = seats.length;
  if (count === 0) {
    return [];
  }
  const slots = slotsFor(shape, count);
  const heroIndex = Math.max(
    0,
    seats.findIndex((seat) => seat.isHero),
  );
  // A table with more players than the tables cover cannot happen in any
  // format we read; wrapping keeps it drawable rather than crashing.
  return seats.map((seat, index) => ({
    seat,
    slot: slots[slotIndex(index, heroIndex, count) % slots.length],
  }));
}

export function ReplayTable({
  hand,
  frame,
  shape,
  motion,
  settings,
  mask,
  format,
  focusSeat = null,
}: ReplayTableProps) {
  const seatCount = clampSeatCount(frame.seats.length);
  const placed = useMemo(() => place(frame.seats, shape), [frame.seats, shape]);
  const metrics = SHAPE_METRICS[shape];
  const [seatW, seatH] = seatSizeFor(shape, frame.seats.length);
  // `holeCardCount` has existed in the PHF layer since the rewrite and has
  // never been reachable from the UI; it is what tells the felt whether it is
  // drawing two cards or six.
  const holeCount = holeCardCount(hand.game.variant) ?? 2;
  const fan = fanSteps(holeCount);
  const ratio = metrics.arW / metrics.arH;
  // The board is dealt from the same deck as everything else, which from dead
  // centre means straight down the felt.
  const boardAim = towards(MIDDLE, DECK, ratio);
  // The other end of every chip flight, measured rather than assumed: the pile
  // is laid out by flexbox inside a container query, so where it actually is
  // depends on how many pots there are and how big the box got.
  const potsRef = useRef<HTMLDivElement | null>(null);

  // `holeCards`, not `dealtCards`: the deal block only lists the cards the room
  // printed up front (the hero's, in every format we read), while `holeCards`
  // is everything the history ever revealed, including the summary. This map
  // backs the "show known cards" toggle, whose whole job is to surface exactly
  // that later knowledge early.
  const knownCards = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const player of hand.players) {
      if (player.holeCards.length > 0) {
        map.set(player.name, player.holeCards);
      }
    }
    return map;
  }, [hand.players]);

  const bigBlind = toDisplayNumber(hand.game.bigBlind, hand.game.unit);
  const hasSecondBoard = frame.boardSecond.length > 0;
  // Awards are paid one pot at a time, so the chips that fly out of the middle
  // are this pot's share rather than the winner's running total.
  const award = frame.kind === "award" ? frame.potAward : null;
  const awardBySeat = useMemo(() => {
    const map = new Map<number, number>();
    for (const winner of award?.winners ?? []) {
      map.set(winner.seatNo, (map.get(winner.seatNo) ?? 0) + winner.amount);
    }
    return map;
  }, [award]);

  // How this frame was arrived at, and what the frame before it was carrying.
  //
  // The frame the bets vanish on no longer holds them, so the previous frame
  // is kept purely to animate the hand-off — and `stepped` is what stops that
  // hand-off from being synthesised for a street the viewer scrubbed straight
  // past. Worked out while rendering the frame that needs it rather than in an
  // effect, which would paint the swept table once before the chips appeared
  // to leave it.
  //
  // `stepped` is the *edge*; `motion` is whether that edge may move anything.
  // They differ for exactly one reader: reduced motion steps forward normally
  // and gets the flights with their travel removed rather than deleted.
  const [seen, setSeen] = useState<ReplayFrame | null>(null);
  const [arrived, setArrived] = useState<{ stepped: boolean; sweep: SweepChip[] }>({
    stepped: false,
    sweep: [],
  });

  let arrival = arrived;
  if (seen !== frame) {
    const prior = seen;
    const stepped = prior !== null && frame.index === prior.index + 1;
    const chips =
      stepped && frame.kind === "collect" && frame.pot > prior.pot
        ? place(prior.seats, shape)
            .filter((entry) => entry.seat.bet > 0)
            .map((entry) => ({
              key: `${frame.index}-${entry.seat.seatNo}`,
              slot: entry.slot,
              amount: entry.seat.bet,
              amountBb: entry.seat.betBb,
            }))
        : [];
    arrival = { stepped, sweep: chips };
    setSeen(frame);
    setArrived(arrival);
  }

  const boardCards = Array.from({ length: 5 }, (_, index) => frame.board[index] ?? null);
  const boardRows =
    metrics.boardRows === 2 ? [boardCards.slice(0, 3), boardCards.slice(3)] : [boardCards];

  return (
    // The letterbox. Its ratio is the shape's, its size comes from the stage
    // above it, and it is itself a size container so the felt inside can
    // measure it with `1cqmin`.
    <div
      className="rp__fit"
      style={{ "--arw": metrics.arW, "--arh": metrics.arH } as React.CSSProperties}
    >
      <div
        className="rp__felt"
        data-seats={seatCount}
        style={
          {
            "--seat-wu": seatW,
            "--seat-hu": seatH,
            "--card-u": metrics.boardCard,
            "--pot-u": metrics.potH,
            "--chip-wu": metrics.chipW,
            "--chip-hu": metrics.chipH,
            "--hole-count": holeCount,
            "--fan-down": fan.down,
            "--fan-up": fan.up,
          } as React.CSSProperties
        }
      >
        <div className="rp__cloth" aria-hidden="true" />
        <div className="rp__logo" aria-hidden="true">
          {mask.tableName ?? "Hand Replayer"}
        </div>

        <div className="rp__center">
          {/* One pill per pile in the middle: a single "Pot" most of the time,
              "Main" above "Side" once an all-in has capped somebody. Every pile
              is its own labelled pill — Tier 0, because the split is the single
              most consequential thing on the felt once somebody is capped. */}
          <div className="rp__pots" ref={potsRef} role="group" aria-label="Pot">

            {frame.pots.map((pot, index) => (
              <div
                key={pot.name}
                className={`rp__pot ${index > 0 ? "rp__pot--side" : ""}`.trim()}
              >
                <span className="rp__pot-label">{pot.name}</span>
                <span className="rp__pot-value">{format(pot.amount, pot.amountBb)}</span>
                {/* Outstanding bets belong to whichever pot they end up in,
                    which is not decided until they are swept, so the running
                    total sits on the last pile rather than split across them. */}
                {index === frame.pots.length - 1 && frame.potWithBets > frame.pot ? (
                  <span className="rp__pot-total">
                    {format(frame.potWithBets, frame.potWithBetsBb)} total
                  </span>
                ) : null}
              </div>
            ))}
          </div>

          <div className={`rp__boards ${hasSecondBoard ? "rp__boards--twin" : ""}`.trim()}>
            <div className="rp__board" role="group" aria-label="Board">
              {boardRows.map((row, rowIndex) => (
                <div className="rp__board-row" key={`b1-row-${rowIndex}`}>
                  {row.map((code, index) =>
                    code ? (
                      <PlayingCard
                        key={`b1-${rowIndex}-${index}-${code}`}
                        code={code}
                        size="xl"
                        dealIndex={index}
                        dealX={boardAim.x}
                        dealY={boardAim.y}
                      />
                    ) : (
                      <span
                        key={`b1-slot-${rowIndex}-${index}`}
                        className="rp__board-slot"
                        aria-hidden="true"
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
            {hasSecondBoard ? (
              <div className="rp__board rp__board--second" role="group" aria-label="Second runout">
                <div className="rp__board-row">
                  <span className="rp__board-tag">Run 2</span>
                  {frame.boardSecond.map((code, index) => (
                    <PlayingCard
                      key={`b2-${index}-${code}`}
                      code={code}
                      size="xl"
                      dealIndex={index}
                      dealX={boardAim.x}
                      dealY={boardAim.y}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {arrival.sweep.map((chip) => (
          <TravellingChips
            key={chip.key}
            flight="to-pot"
            anchorRef={potsRef}
            positional={motion === "step"}
            className="rp__chips rp__chips--sweep"
            style={chipStyle(chip.slot)}
          >
            <ChipStack
              amount={chip.amount}
              amountBb={chip.amountBb}
              bigBlind={bigBlind}
              format={format}
              label={null}
              variant="sweep"
            />
          </TravellingChips>
        ))}

        {placed.map(({ seat, slot }) =>
          seat.bet > 0 ? (
            <div
              key={`bet-${seat.seatNo}`}
              className="rp__chips rp__chips--bet"
              style={{ ...chipStyle(slot), ...aimStyle("bet", aimFor(slot, ratio).bet) }}
            >
              <ChipStack
                amount={seat.bet}
                amountBb={seat.betBb}
                bigBlind={bigBlind}
                format={format}
                variant="bet"
              />
            </div>
          ) : null,
        )}

        {/* One pot at a time. `potAward` carries this pile's winners only, so
            a side pot is its own beat rather than every winner's stack jumping
            from dead centre at once — and the flight is only synthesised when
            the viewer actually crossed into the award frame. */}
        {award && arrival.stepped
          ? placed
              .filter(({ seat }) => (awardBySeat.get(seat.seatNo) ?? 0) > 0)
              .map(({ seat, slot }) => (
                // Keyed on the frame too, so a second award frame is a new
                // element rather than React reusing the finished one.
                <TravellingChips
                  key={`award-${frame.index}-${seat.seatNo}`}
                  flight="from-pot"
                  anchorRef={potsRef}
                  positional={motion === "step"}
                  className="rp__chips rp__chips--award"
                  // Laid out on the winner's own chip spot — where that seat's
                  // bets went out from — and flown in from the middle.
                  style={chipStyle(slot)}
                >
                  <ChipStack
                    amount={awardBySeat.get(seat.seatNo) ?? 0}
                    bigBlind={bigBlind}
                    format={format}
                    label={null}
                    variant="pot"
                  />
                </TravellingChips>
              ))
          : null}

        {placed.map(({ seat, slot }) => {
          const known =
            seat.cards ?? (settings.showKnownCards ? (knownCards.get(seat.name) ?? null) : null);
          // Hero's own cards can be put back face down to review the spot
          // blind; everyone else's visibility is the replay position's call.
          const revealed = seat.isHero && !settings.showHeroCards ? null : known;
          // Folded players keep greyed-out backs. An empty gap where the cards
          // were reads as "not in this hand at all", which is wrong, and it
          // leaves the FOLDED marker floating with nothing to sit on.
          const backs: Array<string | null> =
            seat.hasCards || seat.folded ? Array.from({ length: holeCount }, () => null) : [];
          const cards = revealed ?? backs;
          const tone = actionTone(seat.lastAction);
          const aim = aimFor(slot, ratio);
          return (
            <div
              key={`seat-${seat.seatNo}`}
              // One group per seat, labelled with everything the plate, the
              // badge, the button and the action pill say between them — which
              // is why all four are `aria-hidden` below. Read as one sentence
              // ("Seat 3, cutoff, Villain, 84 big blinds, folded") rather than
              // as six loose fragments in slot order.
              role="group"
              aria-label={describeSeat(seat, mask.seat(seat.name))}
              className={[
                "pseat",
                seat.folded ? "pseat--folded" : "",
                seat.isActing ? "pseat--acting" : "",
                seat.isHero ? "pseat--hero" : "",
                seat.seatNo === focusSeat ? "pseat--focus" : "",
                seat.allIn ? "pseat--allin" : "",
                seat.winAmount > 0 ? "pseat--winner" : "",
                revealed ? "pseat--shown" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={slotStyle(slot)}
            >
              <div className="pseat__cards">
                {cards.map((code, index) => (
                  <PlayingCard
                    key={`${seat.seatNo}-${index}-${code ?? "back"}`}
                    code={code}
                    size="md"
                    dimmed={seat.folded}
                    highlighted={seat.winAmount > 0}
                    dealIndex={index}
                    dealX={aim.deal.x}
                    dealY={aim.deal.y}
                  />
                ))}
              </div>

              {/* Everything from here down is already in the group's label, so
                  it is hidden from assistive tech rather than repeated four
                  times in whatever order the slot table happened to paint. */}
              <div className="pseat__plate" aria-hidden="true">
                <span className="pseat__name">
                  {seat.position ? (
                    <span className="pseat__pos" title={spokenPosition(seat.position) ?? undefined}>
                      {seat.position}
                    </span>
                  ) : null}
                  {/* Long screen names still have to ellipsis at nine seats on
                      a phone, so the full one stays reachable on hover. */}
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
                <span className="pseat__button" title="Dealer button" aria-hidden="true">
                  D
                </span>
              ) : null}

              {seat.folded ? (
                <span className="pseat__state" aria-hidden="true">
                  Folded
                </span>
              ) : null}

              {/* The win label arrives pre-formatted in currency, so it is the
                  one action pill that has to be re-rendered to honour the
                  big-blind toggle. */}
              {seat.winAmount > 0 ? (
                <span className="pseat__action pseat__action--win" aria-hidden="true">
                  +{format(seat.winAmount)}
                </span>
              ) : seat.lastAction ? (
                <span className={`pseat__action pseat__action--${tone}`} aria-hidden="true">
                  {seat.lastAction}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
