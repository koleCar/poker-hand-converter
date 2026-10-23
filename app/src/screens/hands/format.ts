/**
 * The Hands list's number and date formats (moved to the shared package,
 * R4.5b: `@rail/ui/hands/format`), with the counts, big blinds and dates
 * bound to the app's live language (`i18n/format.ts`) for the app's other
 * screens.
 */
import { bigBlindsIn, countIn, playedAtIn } from "@rail/ui/hands/format";

import { formatLocale } from "../../i18n/format";

export { money, signedMoney, stakeLabel, stakes, unitOf } from "@rail/ui/hands/format";

/** Thousandths of a big blind as `+12.5`. */
export function bigBlinds(milli: number): string {
  return bigBlindsIn(formatLocale(), milli);
}

export function playedAt(iso: string | null): string {
  return playedAtIn(formatLocale(), iso);
}

export function count(n: number): string {
  return countIn(formatLocale(), n);
}
