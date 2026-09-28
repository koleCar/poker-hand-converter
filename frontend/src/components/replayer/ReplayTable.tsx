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

import { useMemo, useState } from "react";
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
import { actionTone, type AmountFormatter } from "./tableMath";

interface ReplayTableProps {
  hand: PhfHand;
  frame: ReplayFrame;
  /** Chosen by the viewer's ResizeObserver so the slots and CSS agree. */
  shape: TableShape;
  /** Card visibility and naming preferences from the header gear. */
  settings: ReplaySettings;
  /** Neutral labels when anonymous mode is on; pass-through otherwise. */
  mask: NameMask;
  /** Renders every chip amount in the unit the viewer picked. */
  format: AmountFormatter;
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

export function ReplayTable({ hand, frame, shape, settings, mask, format }: ReplayTableProps) {
  const seatCount = clampSeatCount(frame.seats.length);
  const placed = useMemo(() => place(frame.seats, shape), [frame.seats, shape]);
  const metrics = SHAPE_METRICS[shape];
  const [seatW, seatH] = seatSizeFor(shape, frame.seats.length);
  // `holeCardCount` has existed in the PHF layer since the rewrite and has
  // never been reachable from the UI; it is what tells the felt whether it is
  // drawing two cards or six.
  const holeCount = holeCardCount(hand.game.variant) ?? 2;
  const fan = fanSteps(holeCount);

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

  // Chips sweeping from the bet ring into the middle. The frame the bets
  // vanish on no longer carries them, so the previous frame is kept around
  // purely to animate the hand-off. Worked out while rendering the frame that
  // needs it rather than in an effect, which would paint the swept table once
  // before the chips appeared to leave it.
  const [seen, setSeen] = useState<ReplayFrame | null>(null);
  const [sweep, setSweep] = useState<{ atIndex: number; chips: SweepChip[] } | null>(null);

  if (seen !== frame) {
    const prior = seen;
    setSeen(frame);
    const steppedForward = prior !== null && frame.index === prior.index + 1;
    if (steppedForward && frame.kind === "collect" && frame.pot > prior.pot) {
      const chips = place(prior.seats, shape)
        .filter((entry) => entry.seat.bet > 0)
        .map((entry) => ({
          key: `${frame.index}-${entry.seat.seatNo}`,
          slot: entry.slot,
          amount: entry.seat.bet,
          amountBb: entry.seat.betBb,
        }));
      setSweep(chips.length > 0 ? { atIndex: frame.index, chips } : null);
    } else if (sweep !== null && sweep.atIndex !== frame.index) {
      setSweep(null);
    }
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
              "Main" above "Side" once an all-in has capped somebody. */}
          <div className="rp__pots">
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
            <div className="rp__board">
              {boardRows.map((row, rowIndex) => (
                <div className="rp__board-row" key={`b1-row-${rowIndex}`}>
                  {row.map((code, index) =>
                    code ? (
                      <PlayingCard
                        key={`b1-${rowIndex}-${index}-${code}`}
                        code={code}
                        size="xl"
                        dealIndex={index}
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
              <div className="rp__board rp__board--second">
                <div className="rp__board-row">
                  <span className="rp__board-tag">Run 2</span>
                  {frame.boardSecond.map((code, index) => (
                    <PlayingCard key={`b2-${index}-${code}`} code={code} size="xl" dealIndex={index} />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {sweep?.chips.map((chip) => (
          <div key={chip.key} className="rp__chips rp__chips--sweep" style={chipStyle(chip.slot)}>
            <ChipStack
              amount={chip.amount}
              amountBb={chip.amountBb}
              bigBlind={bigBlind}
              format={format}
              label={null}
              variant="sweep"
            />
          </div>
        ))}

        {placed.map(({ seat, slot }) =>
          seat.bet > 0 ? (
            <div
              key={`bet-${seat.seatNo}`}
              className="rp__chips rp__chips--bet"
              style={chipStyle(slot)}
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

        {award
          ? placed
              .filter(({ seat }) => (awardBySeat.get(seat.seatNo) ?? 0) > 0)
              .map(({ seat, slot }) => (
                // Keyed on the frame too, so a second award frame restarts the
                // slide instead of React reusing the finished one.
                <div
                  key={`award-${frame.index}-${seat.seatNo}`}
                  className="rp__chips rp__chips--award"
                  style={
                    {
                      "--award-x": `${slot.cx * 100}%`,
                      "--award-y": `${slot.cy * 100}%`,
                      translate: chipTranslate(slot.chipAnchor),
                    } as React.CSSProperties
                  }
                >
                  <ChipStack
                    amount={awardBySeat.get(seat.seatNo) ?? 0}
                    bigBlind={bigBlind}
                    format={format}
                    label={null}
                    variant="pot"
                  />
                </div>
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
          return (
            <div
              key={`seat-${seat.seatNo}`}
              className={[
                "pseat",
                seat.folded ? "pseat--folded" : "",
                seat.isActing ? "pseat--acting" : "",
                seat.isHero ? "pseat--hero" : "",
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

              {seat.folded ? <span className="pseat__state">Folded</span> : null}

              {/* The win label arrives pre-formatted in currency, so it is the
                  one action pill that has to be re-rendered to honour the
                  big-blind toggle. */}
              {seat.winAmount > 0 ? (
                <span className="pseat__action pseat__action--win">+{format(seat.winAmount)}</span>
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
