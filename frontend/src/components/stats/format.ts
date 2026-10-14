/**
 * Small formatters shared by the statistics components. Presentation only: no
 * arithmetic beyond dividing a minor-unit integer by its unit.
 *
 * Counts, percentages, big blinds and dates follow the reader's locale
 * (`useIntlLocale`). Currency amounts do not: they stay in the form the rest of
 * the app prints money in (`formatAmount`), "$0.25/$0.50", whatever the
 * language around them.
 */

import type { StakeVolume } from "../../lib/db";
import { useLocale } from "../../lib/i18n/client";
import { INTL_LOCALE } from "../../lib/i18n/dictionaries";

/* `numberFormat`, `countIn` and `fixedIn` live with the tile in the shared
   package (packages/ui, R2.6); one cache of formatters for both. */
export { countIn, fixedIn, numberFormat } from "@rail/ui/stats/format";

/** The reader's BCP 47 tag, for `Intl`. */
export function useIntlLocale(): string {
  return INTL_LOCALE[useLocale()];
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** One `Intl.DateTimeFormat` per locale and options, built on first use. */
export function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateFormats.set(key, format);
  }
  return format;
}

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
  /** What to say when the big blind is unknown (`stats.common.unknownStakes`). */
  unknown: string,
): string {
  const { smallBlind, bigBlind, currency, currencyMinorUnits } = stake;
  if (bigBlind === null) {
    return unknown;
  }
  const bb = money(bigBlind, currency, currencyMinorUnits);
  return smallBlind === null ? bb : `${money(smallBlind, currency, currencyMinorUnits)}/${bb}`;
}
