import { memo } from "react";
import { SUIT_NAME, SUIT_SYMBOL, isRedSuit, parseCard, type Suit } from "../../lib/cards";

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
  className?: string;
}

const SUIT_CLASS: Record<Suit, string> = {
  s: "suit-s",
  h: "suit-h",
  d: "suit-d",
  c: "suit-c",
};

const RANK_NAME: Record<string, string> = {
  A: "Ace",
  K: "King",
  Q: "Queen",
  J: "Jack",
  T: "Ten",
};

function PlayingCardImpl({
  code,
  size = "md",
  dimmed = false,
  highlighted = false,
  dealIndex = 0,
  className = "",
}: PlayingCardProps) {
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
    ? `${RANK_NAME[card.rank] ?? card.rank} of ${SUIT_NAME[card.suit]}`
    : "face-down card";

  return (
    <span
      className={classes}
      style={{ animationDelay: `${dealIndex * 70}ms` }}
      role="img"
      aria-label={label}
    >
      {card ? (
        <>
          <span className="pcard__corner pcard__corner--tl" aria-hidden="true">
            <span className="pcard__rank">{card.rank}</span>
            <span className="pcard__suit">{SUIT_SYMBOL[card.suit]}</span>
          </span>
          <span className="pcard__center" aria-hidden="true">
            {SUIT_SYMBOL[card.suit]}
          </span>
          <span className="pcard__corner pcard__corner--br" aria-hidden="true">
            <span className="pcard__rank">{card.rank}</span>
            <span className="pcard__suit">{SUIT_SYMBOL[card.suit]}</span>
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
