import { memo } from "react";
import { formatMoney } from "../../lib/format";

interface ChipStackProps {
  amount: number;
  currency: string;
  /** Big blind, used to scale how many chips are drawn. */
  bigBlind: number;
  label?: string;
  variant?: "bet" | "pot";
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

function ChipStackImpl({ amount, currency, bigBlind, label, variant = "bet" }: ChipStackProps) {
  if (amount <= 0) {
    return null;
  }

  const count = chipCount(amount, bigBlind);
  const bb = bigBlind > 0 ? amount / bigBlind : amount;
  const colorSeed = Math.min(CHIP_COLORS.length - 1, Math.floor(Math.log2(bb + 1)));

  return (
    <span className={`chip-stack chip-stack--${variant}`}>
      <span className="chip-stack__discs">
        {Array.from({ length: count }, (_, index) => (
          <span
            key={index}
            className="chip"
            style={{
              bottom: `${index * 4}px`,
              background: CHIP_COLORS[(colorSeed + index) % CHIP_COLORS.length],
              zIndex: index,
            }}
          >
            <span className="chip__edge" />
          </span>
        ))}
      </span>
      <span className="chip-stack__amount">{label ?? formatMoney(currency, amount)}</span>
    </span>
  );
}

export const ChipStack = memo(ChipStackImpl);
