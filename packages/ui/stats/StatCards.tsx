/**
 * Statistics as a row of cards, the Live screen's look (the owner's variant
 * C, 2026-11-05) for a shared screen: each card has its short label (`VPIP`,
 * `3B`) over its value, the value coloured by how far it sits from the
 * middle of its target range (`range.ts`: green in the middle, through amber
 * to red well outside), and a strip under it with the band and the value's
 * mark. A statistic with no target (a win rate) is coloured by its sign.
 * The value is dimmed by its reliability, and its full name, sample and
 * interval are in the card's tooltip. The cards wrap into rows of even
 * length, never one left alone on a row.
 */
import type { CSSProperties } from "react";

import { useUiStrings } from "../i18n";
import type { Shown, StatDefinition } from "../model/stats";
import { shownOf, textLocale } from "../reports/definitions";
import { countIn } from "./format";
import { rangeBar, rangeColour, rangeScore, targetRange, type RangeBar } from "./range";
import { decimalMark, shownText, shownTitle } from "./StatValue";
import styles from "./StatCards.module.css";

export function StatCards({
  ids,
  stats,
  definitions,
}: {
  /** The definitions to show, in this order; one with no definition is left out. */
  ids: readonly string[];
  stats: readonly Shown[];
  definitions: readonly StatDefinition[];
}) {
  const all = useUiStrings();
  const locale = all.intlLocale;
  const count = countIn(locale);
  const mark = decimalMark(locale);
  const text = textLocale(locale);

  const present = ids.filter((id) => shownOf(definitions, stats, id) !== null);
  // Rows of even length: all in one, else halves, else thirds (`StatCards.module.css`).
  const columns = {
    "--cards-all": present.length,
    "--cards-half": Math.ceil(present.length / 2),
    "--cards-third": Math.ceil(present.length / 3),
  } as CSSProperties;

  return (
    <div className={styles.frame}>
      <ul className={styles.cards} style={columns}>
        {present.map((id) => {
          const found = shownOf(definitions, stats, id);
          if (found === null) return null;
          const { definition, shown } = found;
          const range = targetRange(definition);
          const value = shown.value;
          let colour: string | null = null;
          let bar: RangeBar | null = null;
          if (value !== null && range) {
            colour = rangeColour(rangeScore(value, range));
            bar = rangeBar(value, range);
          } else if (value !== null && value !== 0 && definition.format.unit === "bb_per_100") {
            colour = value > 0 ? "var(--profit-fg)" : "var(--loss-fg)";
          }
          const tip = shownTitle(shown, all, count);
          return (
            <li
              key={id}
              className={styles.card}
              title={tip ? `${definition.name[text]}\n${tip}` : definition.name[text]}
            >
              <span className={styles.label}>{definition.label[text]}</span>
              <span
                className={styles.value}
                style={{
                  opacity: shown.reliability.opacity,
                  ...(colour ? { color: colour } : {}),
                }}
              >
                {shownText(shown, definition.format.unit, mark, count)}
              </span>
              {bar ? (
                <span className={styles.rangeBar} aria-hidden="true">
                  <span
                    className={styles.rangeBand}
                    style={{
                      left: `${bar.bandLeft}%`,
                      right: `${bar.bandRight}%`,
                    }}
                  />
                  <span
                    className={styles.rangeMark}
                    style={{
                      left: `${bar.mark}%`,
                      background: colour ?? "var(--text-secondary)",
                    }}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
