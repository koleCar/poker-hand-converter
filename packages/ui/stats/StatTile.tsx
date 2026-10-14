/**
 * One number on the HUD, with its uncertainty attached to it.
 *
 * The tile is the whole argument of this screen in miniature: a percentage on
 * its own is a claim about a population, and the sample it came from is the
 * only thing that says how much of a claim. So every tile renders three things
 * and none of them is optional —
 *
 *   1. the rate,
 *   2. the sample it was measured over (`made / opportunities`),
 *   3. a band showing how wide the 95% interval is.
 *
 * How far to trust it is the shared rule of `lib/stats/reliability.ts` (R2.5),
 * the one the desktop app and the HUD use: the level (`ok` / `low` /
 * `insufficient`, from the definition's `sample.min`) colours the band, and the
 * opacity dims the figure, continuously, until the sample reaches `sample.min`.
 *
 * The confidence band is drawn as a bar rather than printed as "±4.1%" alone
 * because the comparison a reader actually makes is between tiles: a row where
 * one bar is a sliver and its neighbour fills the tile says "these two numbers
 * are not the same kind of fact" faster than two sets of digits ever will. The
 * numeric margin is there too, below the value, and the sample and interval in
 * the value's tooltip ("n = 80, 95% CI 20.0–39.5%").
 */

import { useUiStrings } from "../i18n";
import type { StatReliability } from "../model/stats";
import { countIn, fixedIn } from "./format";
import "./stat-tile.css";

interface StatTileProps {
  label: string;
  /** The numerator, e.g. times 3-bet. */
  made: number;
  /** The denominator, e.g. 3-bet opportunities. */
  opportunities: number;
  /** The definition's value (`pct(made, opportunities)`), null without opportunities. */
  value: number | null;
  /** The definition's `statReliability`. */
  reliability: StatReliability;
  /** Shown under the label; the definition in a few words. */
  hint?: string;
}

/** Confidence bar width, as a fraction of the tile. Capped so a wide interval is full. */
function bandWidth(margin: number): number {
  // 12.5 percentage points of half-width is the cap: past that the interval is
  // a quarter of the whole range and the bar has already said everything it can.
  return Math.min(100, (margin / 12.5) * 100);
}

export function StatTile({ label, made, opportunities, value, reliability, hint }: StatTileProps) {
  const strings = useUiStrings();
  const t = strings.statTile;
  const locale = strings.intlLocale;
  const count = countIn(locale);
  const one = fixedIn(locale, 1);
  const { interval, level, opacity } = reliability;
  const margin = interval ? (interval.high - interval.low) / 2 : null;

  return (
    <div className={`stats-tile stats-tile--${level}`}>
      <span className="stats-tile__label">{label}</span>
      <span
        className="stats-tile__value"
        style={{ opacity }}
        title={interval ? t.sample(count(opportunities), one(interval.low), one(interval.high)) : undefined}
      >
        {value !== null ? `${one(value)}%` : "—"}
      </span>
      <span className="stats-tile__sample">
        {interval && margin !== null ? (
          <>
            {count(made)} / {count(opportunities)}
            <span className="stats-tile__margin"> ±{one(margin)}</span>
          </>
        ) : (
          t.noOpportunities
        )}
      </span>
      {/* Not a progress bar: the fill is the *width of the doubt*, so a short
          bar is a good thing. Labelled as such for a screen reader, which
          cannot see that the neighbouring tiles make the comparison obvious. */}
      <span
        className="stats-tile__band"
        title={t.reliability[level]}
        role="img"
        aria-label={interval ? t.interval(one(interval.low), one(interval.high)) : t.noSample}
      >
        <span
          className="stats-tile__band-fill"
          style={{ width: `${margin !== null ? bandWidth(margin) : 100}%` }}
        />
      </span>
      {hint ? <span className="stats-tile__hint">{hint}</span> : null}
    </div>
  );
}
