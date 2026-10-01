/**
 * Small formatters shared by the statistics components. Presentation only: no
 * arithmetic beyond dividing a minor-unit integer by its unit.
 */

import type { StakeVolume } from "../../lib/db";

export const COUNT = new Intl.NumberFormat("en-GB");

export const count = (value: number) => COUNT.format(value);

export function money(amount: number, currency: string, minorUnits: number): string {
  const value = amount / minorUnits;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      // "$0.25/$0.50", not "US$0.25/US$0.50": the room already said which dollar.
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // Not an ISO code (play money, a room's own token): say the number.
    return `${value} ${currency}`;
  }
}

export function stakeLabel(
  stake: Pick<StakeVolume, "smallBlind" | "bigBlind" | "currency" | "currencyMinorUnits">,
): string {
  const { smallBlind, bigBlind, currency, currencyMinorUnits } = stake;
  if (bigBlind === null) {
    return "Unknown stakes";
  }
  const bb = money(bigBlind, currency, currencyMinorUnits);
  return smallBlind === null ? bb : `${money(smallBlind, currency, currencyMinorUnits)}/${bb}`;
}
