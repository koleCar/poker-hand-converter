import { memo } from "react";
import { SUIT_PATH, isRedSuit, parseCard, type Suit } from "../../lib/cards";
import { useDict } from "../../lib/i18n/client";

export type CardSize = "xs" | "sm" | "md" | "lg" | "xl";

interface PlayingCardProps {
  /** Card code such as "Ah". Null renders a face-down card. */
  code: string | null;
  size?: CardSize;
  /** Dim the card, used for players who folded. */
  dimmed?: boolean;
  /** Highlight ring, used for the winning hand. */
  highlighted?: boolean;
  /** Stagger index for the deal-in animation. */
  dealIndex?: number;
  /**
   * Unit vector from where this card lies to the deck, as `[x, y]` in screen
   * directions (y negative is up the felt).
   *
   * The card deals *in* along it — a short slide out of the dealer's hands
   * plus the flip it already had. Passed as two numbers rather than a point or
   * a style object because this component is memoised and an object prop would
   * be a new identity on every render of the table.
   */
  dealX?: number;
  dealY?: number;
  className?: string;
}

const SUIT_CLASS: Record<Suit, string> = {
  s: "suit-s",
  h: "suit-h",
  d: "suit-d",
  c: "suit-c",
};

/**
 * The suit pip, drawn rather than typed.
 *
 * U+2660/2662/2663 are missing from most UI fonts — Inter ships none of them —
 * so the glyph always came from an OS fallback, and on Windows and Android that
 * fallback is the colour emoji font: a blue diamond and a green club at a size
 * and baseline the card layout never agreed to. The shape is also the only cue
 * a colour-blind player has, so it is the last thing that should be left to
 * whatever happens to be installed.
 *
 * Sized entirely from CSS off `--card-w`, so the card's size system is unchanged.
 */
function SuitPip({ suit, className }: { suit: Suit; className: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" focusable="false" aria-hidden="true">
      <path d={SUIT_PATH[suit]} fill="currentColor" />
    </svg>
  );
}

function PlayingCardImpl({
  code,
  size = "md",
  dimmed = false,
  highlighted = false,
  dealIndex = 0,
  dealX = 0,
  dealY = -1,
  className = "",
}: PlayingCardProps) {
  const words = useDict().replayer.playingCard;
  const card = code ? parseCard(code) : null;

  const classes = [
    "pcard",
    `pcard--${size}`,
    card ? SUIT_CLASS[card.suit] : "pcard--back",
    card && isRedSuit(card.suit) ? "pcard--red" : "",
    dimmed ? "pcard--dim" : "",
    highlighted ? "pcard--win" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // Spelled out rather than "Ah": screen readers render the suit glyph
  // inconsistently, and the glyph is also the only non-colour suit cue.
  const label = card
    ? words.card(words.ranks[card.rank] ?? card.rank, words.suits[card.suit])
    : words.faceDown;

  return (
    <span
      className={classes}
      style={
        {
          animationDelay: `${dealIndex * 70}ms`,
          "--deal-x": dealX,
          "--deal-y": dealY,
        } as React.CSSProperties
      }
      role="img"
      aria-label={label}
    >
      {card ? (
        <>
          <span className="pcard__corner pcard__corner--tl" aria-hidden="true">
            <span className="pcard__rank">{card.rank}</span>
            <SuitPip suit={card.suit} className="pcard__suit" />
          </span>
          <span className="pcard__center" aria-hidden="true">
            <SuitPip suit={card.suit} className="pcard__pip" />
          </span>
          <span className="pcard__corner pcard__corner--br" aria-hidden="true">
            <span className="pcard__rank">{card.rank}</span>
            <SuitPip suit={card.suit} className="pcard__suit" />
          </span>
        </>
      ) : (
        <span className="pcard__back" aria-hidden="true" />
      )}
    </span>
  );
}

export const PlayingCard = memo(PlayingCardImpl);

interface CardRowProps {
  cards: Array<string | null>;
  size?: CardSize;
  dimmed?: boolean;
  highlighted?: boolean;
  className?: string;
}

export function CardRow({
  cards,
  size = "md",
  dimmed,
  highlighted,
  className = "",
}: CardRowProps) {
  return (
    <span className={`card-row card-row--${size} ${className}`.trim()}>
      {cards.map((code, index) => (
        <PlayingCard
          key={`${code ?? "back"}-${index}`}
          code={code}
          size={size}
          dimmed={dimmed}
          highlighted={highlighted}
          dealIndex={index}
        />
      ))}
    </span>
  );
}
