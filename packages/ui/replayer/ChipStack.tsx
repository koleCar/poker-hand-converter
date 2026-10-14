import { memo } from "react";
import type { AmountFormatter } from "./tableMath";

interface ChipStackProps {
  amount: number;
  /** The same amount in big blinds, straight off the replay frame. */
  amountBb?: number;
  /** Big blind, used to scale how many chips are drawn. */
  bigBlind: number;
  /** Renders the caption in the unit the viewer picked (currency or bb). */
  format: AmountFormatter;
  /** Overrides the caption entirely; pass null to draw discs with no caption. */
  label?: string | null;
  variant?: "bet" | "pot" | "sweep";
}

const CHIP_COLORS = [
  "#f4f4f5", // white
  "#e03b3b", // red
  "#2f7be5", // blue
  "#2fa36b", // green
  "#1b1b22", // black
  "#7b4ae2", // purple
  "#e5a12f", // gold
];

/**
 * Number of chips drawn grows logarithmically with the bet so a 200bb pot does
 * not turn into a tower, but a min-raise still looks different from a shove.
 */
function chipCount(amount: number, bigBlind: number): number {
  const bb = bigBlind > 0 ? amount / bigBlind : amount;
  if (bb <= 0) return 0;
  return Math.max(1, Math.min(6, Math.round(Math.log2(bb + 1)) + 1));
}

function ChipStackImpl({
  amount,
  amountBb,
  bigBlind,
  format,
  label,
  variant = "bet",
}: ChipStackProps) {
  if (amount <= 0) {
    return null;
  }

  const count = chipCount(amount, bigBlind);
  const bb = bigBlind > 0 ? amount / bigBlind : amount;
  const colorSeed = Math.min(CHIP_COLORS.length - 1, Math.floor(Math.log2(bb + 1)));
  const caption = label === undefined ? format(amount, amountBb) : label;

  return (
    <span className={`chip-stack chip-stack--${variant}`}>
      <span className="chip-stack__discs" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <span
            key={index}
            className="chip"
            style={{
              bottom: `calc(var(--chip-lift) * ${index})`,
              background: CHIP_COLORS[(colorSeed + index) % CHIP_COLORS.length],
              zIndex: index,
            }}
          >
            <span className="chip__edge" />
          </span>
        ))}
      </span>
      {caption ? <span className="chip-stack__amount">{caption}</span> : null}
    </span>
  );
}

export const ChipStack = memo(ChipStackImpl);
