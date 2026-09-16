import { useMemo } from "react";
import type { ParsedHand } from "../../lib/handParser";
import type { ReplayFrame, SeatFrameState } from "../../lib/replay";
import { formatMoney } from "../../lib/format";
import { ChipStack } from "./ChipStack";
import { PlayingCard } from "./PlayingCard";

interface ReplayTableProps {
  hand: ParsedHand;
  frame: ReplayFrame;
  /** Reveal every player's known cards regardless of the replay position. */
  revealAll: boolean;
}

const RADIUS_X = 40;
const RADIUS_Y = 37;
const BET_RADIUS = 0.54;

interface Placement {
  seat: SeatFrameState;
  x: number;
  y: number;
  betX: number;
  betY: number;
  side: "left" | "right" | "center";
}

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
      x: 50 + RADIUS_X * cos,
      y: 50 + RADIUS_Y * sin,
      betX: 50 + RADIUS_X * BET_RADIUS * cos,
      betY: 50 + RADIUS_Y * BET_RADIUS * sin,
      side: cos < -0.3 ? "left" : cos > 0.3 ? "right" : "center",
    };
  });
}

export function ReplayTable({ hand, frame, revealAll }: ReplayTableProps) {
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
  const currency = hand.currency;
  const hasSecondBoard = frame.boardSecond.length > 0;

  return (
    <div className="ptable">
      <div className="ptable__felt">
        <div className="ptable__rail" />
        <div className="ptable__logo">{hand.tableName ?? "PokerConverter"}</div>

        <div className="ptable__center">
          <div className="ptable__pot">
            <span className="ptable__pot-label">Pot</span>
            <span className="ptable__pot-value">{formatMoney(currency, frame.pot)}</span>
            {frame.potWithBets > frame.pot ? (
              <span className="ptable__pot-total">
                total {formatMoney(currency, frame.potWithBets)}
              </span>
            ) : null}
          </div>

          <div className="ptable__boards">
            <div className="ptable__board">
              {Array.from({ length: 5 }, (_, index) => {
                const code = frame.board[index] ?? null;
                return code ? (
                  <PlayingCard key={`b1-${index}-${code}`} code={code} size="lg" dealIndex={index} />
                ) : (
                  <span key={`b1-slot-${index}`} className="board-slot" />
                );
              })}
            </div>
            {hasSecondBoard ? (
              <div className="ptable__board ptable__board--second">
                <span className="ptable__board-tag">2nd</span>
                {frame.boardSecond.map((code, index) => (
                  <PlayingCard key={`b2-${index}-${code}`} code={code} size="md" dealIndex={index} />
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {placements.map(({ seat, betX, betY }) =>
          seat.bet > 0 ? (
            <div
              key={`bet-${seat.seatNo}`}
              className="ptable__bet"
              style={{ left: `${betX}%`, top: `${betY}%` }}
            >
              <ChipStack
                amount={seat.bet}
                currency={currency}
                bigBlind={hand.bigBlind}
                variant="bet"
              />
            </div>
          ) : null,
        )}

        {placements.map(({ seat, x, y, side }) => {
          const revealed =
            seat.cards ?? (revealAll ? (knownCards.get(seat.name) ?? null) : null);
          const cards = revealed ?? (seat.hasCards ? [null, null] : []);
          return (
            <div
              key={`seat-${seat.seatNo}`}
              className={[
                "pseat",
                `pseat--${side}`,
                seat.folded ? "pseat--folded" : "",
                seat.isActing ? "pseat--acting" : "",
                seat.isHero ? "pseat--hero" : "",
                seat.allIn ? "pseat--allin" : "",
                seat.winAmount > 0 ? "pseat--winner" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ left: `${x}%`, top: `${y}%` }}
            >
              <div className="pseat__cards">
                {cards.map((code, index) => (
                  <PlayingCard
                    key={`${seat.seatNo}-${index}-${code ?? "back"}`}
                    code={code}
                    size={seat.isHero ? "md" : "sm"}
                    dimmed={seat.folded}
                    highlighted={seat.winAmount > 0}
                    dealIndex={index}
                  />
                ))}
              </div>

              <div className="pseat__plate">
                <span className="pseat__name">{seat.name}</span>
                <span className="pseat__stack">{formatMoney(currency, seat.stack)}</span>
              </div>

              {seat.isButton ? <span className="pseat__button">D</span> : null}

              {seat.lastAction ? (
                <span className="pseat__action">{seat.lastAction}</span>
              ) : null}

              {seat.allIn && !seat.folded ? (
                <span className="pseat__badge">ALL-IN</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
