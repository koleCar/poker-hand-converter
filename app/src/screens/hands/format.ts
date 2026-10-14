/**
 * How the Hands list prints a row's numbers: money with the row's own unit
 * (minor units, as the store keeps them: `formatAmount` of the web's PHF
 * library, the same digits the web's library list prints), results in big
 * blinds, dates in the reader's locale.
 */
import { formatAmount, type CurrencyUnit } from "@rail/ui/model/phf";

import type { HandRow, StakeFacet } from "../../lib/ipc";
import { liveDateFormat, liveNumberFormat } from "../../i18n/format";

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
export function stakes(row: Pick<HandRow, "currency" | "currencySymbol" | "minorUnits" | "smallBlind" | "bigBlind">): string {
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

const BIG_BLINDS = liveNumberFormat({
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});

/** Thousandths of a big blind as `+12.5`. */
export function bigBlinds(milli: number): string {
  return BIG_BLINDS.format(milli / 1000);
}

const DATE = liveDateFormat({
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function playedAt(iso: string | null): string {
  return iso ? DATE.format(new Date(iso)) : "—";
}

const COUNT = liveNumberFormat();

export function count(n: number): string {
  return COUNT.format(n);
}
