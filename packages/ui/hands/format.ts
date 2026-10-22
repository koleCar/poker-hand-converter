/**
 * How the Hands list prints a row's numbers: money with the row's own unit
 * (minor units: `formatAmount` of the web's PHF library, the digits the web's
 * library list printed), results in big blinds, dates and counts in the
 * reader's language (`intlLocale`, never the browser's default - an English
 * page on a Croatian system groups thousands with a comma, a Croatian one
 * with a dot).
 *
 * Moved from the desktop app (R4.5b); `app/src/screens/hands/format.ts`
 * re-exports it with the app's live language for its other screens.
 */
import { formatAmount, type CurrencyUnit } from "../model/phf";
import type { HandRow, StakeFacet } from "./model";

export function unitOf(row: Pick<HandRow, "currency" | "currencySymbol" | "minorUnits">): CurrencyUnit {
  const minorUnits = row.minorUnits || 1;
  return {
    code: row.currency,
    symbol: row.currencySymbol,
    minorUnits,
    kind: minorUnits > 1 ? "cash" : "chips",
  };
}

/** Cash with two decimals, chips whole with thousands grouped (the web's list). */
export function money(unit: CurrencyUnit, amount: number): string {
  return formatAmount(amount, unit, unit.minorUnits > 1 ? "fixed2" : "minimal", true);
}

/** `+$1.20`, `-$1.20`, `$0`. */
export function signedMoney(unit: CurrencyUnit, amount: number): string {
  const text = money(unit, Math.abs(amount));
  return amount > 0 ? `+${text}` : amount < 0 ? `-${text}` : text;
}

/** The blinds: `$0.50/$1`, `100/200`. */
export function stakes(
  row: Pick<HandRow, "currency" | "currencySymbol" | "minorUnits" | "smallBlind" | "bigBlind">,
): string {
  const unit = unitOf(row);
  return `${money(unit, row.smallBlind)}/${money(unit, row.bigBlind)}`;
}

/** A stake chip's label, from a hand of that stake; `null` for tournament chips. */
export function stakeLabel(facet: StakeFacet): string | null {
  if (facet.currency === null || facet.smallBlind === null || facet.bigBlind === null) {
    return null;
  }
  return stakes({
    currency: facet.currency,
    currencySymbol: facet.currencySymbol ?? "",
    minorUnits: facet.minorUnits ?? 1,
    smallBlind: facet.smallBlind,
    bigBlind: facet.bigBlind,
  });
}

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function numberIn(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `n|${locale}|${JSON.stringify(options)}`;
  let format = cache.get(key) as Intl.NumberFormat | undefined;
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    cache.set(key, format);
  }
  return format;
}

function dateIn(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `d|${locale}|${JSON.stringify(options)}`;
  let format = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    cache.set(key, format);
  }
  return format;
}

const BIG_BLINDS: Intl.NumberFormatOptions = {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
};

const DATE: Intl.DateTimeFormatOptions = {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

/** Thousandths of a big blind as `+12.5`. */
export function bigBlindsIn(locale: string, milli: number): string {
  return numberIn(locale, BIG_BLINDS).format(milli / 1000);
}

export function playedAtIn(locale: string, iso: string | null): string {
  return iso ? dateIn(locale, DATE).format(new Date(iso)) : "—";
}

export function countIn(locale: string, n: number): string {
  return numberIn(locale, {}).format(n);
}

/** The three, bound to one language. */
export interface HandFormat {
  bigBlinds: (milli: number) => string;
  playedAt: (iso: string | null) => string;
  count: (n: number) => string;
}

export function handFormat(locale: string): HandFormat {
  return {
    bigBlinds: (milli) => bigBlindsIn(locale, milli),
    playedAt: (iso) => playedAtIn(locale, iso),
    count: (n) => countIn(locale, n),
  };
}
