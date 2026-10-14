/**
 * One displayed statistic's value (R2.4 `Shown`, R2.5 reliability), where a
 * table cell or a figure needs it outside `StatTable`: the definition's
 * digits with the reader's decimal mark (a percent gets its sign), at the
 * reliability's opacity, with the sample and the 95% interval in its
 * tooltip. The desktop app's Today and Reports use it in their breakdowns
 * and the session's figures (R2.7b); `StatTable` lays out its rows with the
 * same helpers. Nothing here divides anything (guideline §14).
 */

import type { CSSProperties } from "react";
import { useUiStrings, type StatTableStrings, type StatTileStrings } from "../i18n";
import type { Shown, StatUnit } from "../model/stats";
import { countIn } from "./format";

const decimalMarks = new Map<string, string>();

/** "," for hr-HR, "." for en-GB. */
export function decimalMark(locale: string): string {
  let mark = decimalMarks.get(locale);
  if (mark === undefined) {
    mark = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")?.value ?? ".";
    decimalMarks.set(locale, mark);
  }
  return mark;
}

/**
 * The value as shown: the definition's digits, the locale's mark, `%` for a
 * percent; `—` without one. A count (whole digits) gets the locale's
 * grouping when `group` is given ("18,000"): the same digits, set apart.
 */
export function shownText(shown: Shown, unit: StatUnit, mark: string, group?: (value: number) => string): string {
  if (shown.text === null) {
    return "—";
  }
  if (unit === "count" && group && /^-?\d{1,15}$/.test(shown.text)) {
    return group(Number(shown.text));
  }
  return `${shown.text.replace(".", mark)}${unit === "percent" ? "%" : ""}`;
}

/** The value's tooltip: "n = 80, 95% CI 20.0–39.5%", or "n = 80" without an interval. */
export function shownTitle(
  shown: Shown,
  strings: { statTile: StatTileStrings; statTable: StatTableStrings },
  count: (value: number) => string,
): string | undefined {
  if (shown.sample === null) {
    return undefined;
  }
  const n = count(shown.sample);
  const interval = shown.reliability.intervalText;
  return interval ? strings.statTile.sample(n, interval.low, interval.high) : strings.statTable.sampleOnly(n);
}

export interface StatValueProps {
  shown: Shown;
  unit: StatUnit;
  className?: string;
  style?: CSSProperties;
}

/** A value, faded by its reliability, its sample in the tooltip. */
export function StatValue({ shown, unit, className, style }: StatValueProps) {
  const strings = useUiStrings();
  const count = countIn(strings.intlLocale);
  return (
    <span
      className={className}
      data-tone={shown.tone ?? undefined}
      data-reliability={shown.reliability.level}
      style={{ ...style, opacity: shown.reliability.opacity }}
      title={shownTitle(shown, strings, count)}
    >
      {shownText(shown, unit, decimalMark(strings.intlLocale), count)}
    </span>
  );
}
