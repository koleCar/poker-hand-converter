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

/** The reader's BCP 47 tag, for `Intl`. */
export function useIntlLocale(): string {
  return INTL_LOCALE[useLocale()];
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** One `Intl.NumberFormat` per locale and options, built on first use. */
export function numberFormat(locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

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

/** A whole-number formatter for `locale`: "1,234" / "1.234". */
export const countIn = (locale: string) => (value: number) => numberFormat(locale).format(value);

/**
 * A fixed number of decimals, without grouping — the locale's decimal mark in
 * place of `toFixed`, and otherwise the same digits.
 */
export const fixedIn = (locale: string, digits: number) => (value: number) =>
  numberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(
    value,
  );

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
