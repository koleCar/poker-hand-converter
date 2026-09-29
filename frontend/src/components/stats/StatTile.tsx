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
 * The confidence band is drawn as a bar rather than printed as "±4.1%" alone
 * because the comparison a reader actually makes is between tiles: a row where
 * one bar is a sliver and its neighbour fills the tile says "these two numbers
 * are not the same kind of fact" faster than two sets of digits ever will. The
 * numeric margin is there too, in the title attribute and below the value, for
 * anyone who wants it.
 */

import { confidenceOf, wilson, type Confidence } from "./uncertainty";

interface StatTileProps {
  label: string;
  /** The numerator, e.g. times 3-bet. */
  made: number;
  /** The denominator, e.g. 3-bet opportunities. */
  opportunities: number;
  /** Shown under the label; the definition in a few words. */
  hint?: string;
}

const COUNT = new Intl.NumberFormat("en-GB");

/** Confidence bar width, as a fraction of the tile. Capped so "noise" is full. */
function bandWidth(margin: number): number {
  // 12.5 percentage points of half-width is the cap: past that the interval is
  // a quarter of the whole range and the bar has already said everything it can.
  return Math.min(100, (margin / 12.5) * 100);
}

const CONFIDENCE_TITLE: Record<Confidence, string> = {
  firm: "Tight sample — this number is stable.",
  loose: "Moderate sample — the shape is real, the decimal is not.",
  noise: "Small sample — read this as a hint, not a measurement.",
};

export function StatTile({ label, made, opportunities, hint }: StatTileProps) {
  const interval = wilson(made, opportunities);
  const confidence = confidenceOf(interval);

  return (
    <div className={`stats-tile stats-tile--${confidence}`}>
      <span className="stats-tile__label">{label}</span>
      <span className="stats-tile__value">
        {interval ? `${interval.value.toFixed(1)}%` : "—"}
      </span>
      <span className="stats-tile__sample">
        {interval ? (
          <>
            {COUNT.format(made)} / {COUNT.format(opportunities)}
            <span className="stats-tile__margin"> ±{interval.margin.toFixed(1)}</span>
          </>
        ) : (
          "no opportunities"
        )}
      </span>
      {/* Not a progress bar: the fill is the *width of the doubt*, so a short
          bar is a good thing. Labelled as such for a screen reader, which
          cannot see that the neighbouring tiles make the comparison obvious. */}
      <span
        className="stats-tile__band"
        title={CONFIDENCE_TITLE[confidence]}
        role="img"
        aria-label={
          interval
            ? `95% confidence interval ${interval.low.toFixed(1)}% to ${interval.high.toFixed(1)}%`
            : "no sample"
        }
      >
        <span
          className="stats-tile__band-fill"
          style={{ width: `${interval ? bandWidth(interval.margin) : 100}%` }}
        />
      </span>
      {hint ? <span className="stats-tile__hint">{hint}</span> : null}
    </div>
  );
}
