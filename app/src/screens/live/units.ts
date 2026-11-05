/**
 * The Live screen's unit (big blinds or the session's money) and what follows
 * from it: whether money can be shown, the money's unit, and the session's
 * rate per 100 hands in that unit.
 */
import { useT } from "../../i18n";
import { liveNumberFormat } from "../../i18n/format";
import type { Session } from "../../lib/ipc";
import { useStatDefinitions } from "../../lib/useStatDefinitions";
import { signedMoney, unitOf } from "../hands/format";
import { perHundred } from "./model";

/** Big blinds or the session's money. */
export type LiveUnit = "bb" | "money";

const RATE = liveNumberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" });

/** Whether a session's result can be shown in money: one currency, no tournament chips. */
export function hasMoney(session: Session): boolean {
  const units = session.units;
  return !units.mixedKind && !units.mixedCurrency && units.currency !== null && units.minorUnits !== null;
}

/** The session's money unit, when it has one. */
export function moneyUnitOf(session: Session) {
  const units = session.units;
  return units.currency !== null && units.minorUnits !== null
    ? unitOf({ currency: units.currency, currencySymbol: units.symbol ?? "", minorUnits: units.minorUnits })
    : null;
}

/** A rate per 100 hands: its value as text, its unit, its sign. */
export interface Rate {
  value: string;
  unit: string;
  sign: number;
}

/**
 * The session's rate per 100 hands in the screen's unit ("+42.5" bb/100,
 * "+$21.23" $/100). In big blinds it is the `bb_per_100` definition's value
 * (guideline §14); money has no definition, so there it is the session's
 * money result over its hands.
 */
export function useRate(session: Session, unit: LiveUnit): Rate | null {
  const d = useT().live;
  const definitions = useStatDefinitions();
  const money = moneyUnitOf(session);
  if (unit === "money" && hasMoney(session) && money !== null && session.net !== null) {
    const rate = perHundred(session.net, session.hands);
    if (rate === null) return null;
    return { value: signedMoney(money, Math.round(rate)), unit: d.perHundred.money(money.symbol || money.code || ""), sign: Math.sign(rate) };
  }
  if (definitions === null) return null;
  const index = definitions.findIndex((definition) => definition.id === "bb_per_100");
  const value = session.stats[index]?.value ?? null;
  if (value === null) return null;
  return { value: RATE.format(value), unit: d.perHundred.bb, sign: Math.sign(value) };
}
