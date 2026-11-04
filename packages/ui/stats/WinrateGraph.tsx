/**
 * The win-rate graph. Hand-written SVG, no chart library.
 *
 * A charting dependency would be the largest thing in this project — the app
 * ships React and supabase-js and nothing else, and `/h/:slug` is a public
 * landing page where every kilobyte is paid for by a stranger on a phone. What
 * is actually needed here is four lines, two axes, a crosshair and a zoom,
 * which is this file and its plot (`WinratePlot.tsx`: the animation, the zoom,
 * the decimated paths; `graphGeometry.ts`: their arithmetic). It also means the chart inherits the token palette exactly rather
 * than being themed twice, once in CSS and once in a library's config object.
 *
 * ## The three series
 *
 * Total, **showdown** and **non-showdown**, all cumulative, in big blinds.
 *
 * The showdown / non-showdown split is the most diagnostic pair in a tracker
 * and the reason this chart is worth building before any other. The
 * non-showdown line is what aggression wins and loses before cards are turned
 * over; the showdown line is what hand selection and calls are worth once they
 * are. A losing graph whose non-showdown line falls steadily while showdown
 * climbs is a player folding too much and paying off at the end; the mirror
 * image is a player bluffing into calling stations. The total line cannot tell
 * those apart, and they need opposite fixes.
 *
 * The fourth series, **all-in EV**, is the total line with the luck of all-in
 * runouts taken out: each all-in is paid at the equity the hands had when the
 * money went in (`lib/equity`, stored in `hand_stats_ev`). The gap between it
 * and the total is how far the deck has run above or below expectation — the
 * one number that tells a downswing from a leak. It is dashed, because it is a
 * counterfactual rather than money that moved, and it is drawn only once some
 * hand in the sample has actually been evaluated.
 *
 * ## Every hand whose money moved
 *
 * Bomb pots included: both surfaces ask for the graph with them
 * (`ReportFilter::bomb_pots`, the web's `includeBombPots`), so a +120 bb
 * bomb pot is on the curve as it is in the session's result. The statistics
 * (VPIP, bb/100...) leave them out, as `aggregate` always has.
 *
 * ## The x-axis is hands, not time
 *
 * Bucketed server-side with `ntile()` over the hand ordering. A player who took
 * three months off must not get three months of x-axis for zero volume — the
 * shape of a win-rate graph is about sample, and a flat stretch meaning "I did
 * not play" is indistinguishable from one meaning "I broke even for 20 000
 * hands". The dates are in the tooltip, where they belong.
 */

import { useCallback, useMemo, useState } from "react";
import { useUiStrings } from "../i18n";
import { countIn, dateFormat, numberFormat } from "./format";
import { WinratePlot, type PlotSeries, type SeriesKey } from "./WinratePlot";
import "./winrate-graph.css";

/**
 * ## In the shared package (R2.7b)
 *
 * Moved from the web's `components/stats/` so the desktop app's Reports draws
 * the same graph. The web passes what it always passed (its `StatsGraph`
 * satisfies {@link WinrateGraphData}) and renders exactly what it rendered;
 * its words are `UiStrings.winrateGraph` (`strings/stats.{en,hr}.ts`), its
 * rules `stats/winrate-graph.css` (imported here, as `StatTile` imports its
 * sheet). The desktop app adds
 * the money view: `unit="money"` draws the same lines in the currency, from
 * the `cum*Net` columns, which only it sends for every line.
 */

/** One bucket of hands and the sums up to its end (the web's `StatsGraphBucket`). */
export interface WinrateGraphBucket {
  bucket: number;
  hands: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  cumHands: number;
  /** Cumulative result, in thousandths of a big blind. */
  cumNetBbMilli: number;
  /** ...of it won in hands that reached showdown. */
  cumSdBbMilli: number;
  /** ...and in hands that did not. */
  cumNsdBbMilli: number;
  /** The all-in EV line, thousandths of a big blind. */
  cumEvBbMilli: number;
  /** Cumulative result in minor units, or null across mixed currencies. */
  cumNet: number | null;
  /** The money view's other lines, minor units (the desktop app's). */
  cumSdNet?: number | null;
  cumNsdNet?: number | null;
  cumEvNet?: number | null;
}

/** What the graph draws (the web's `StatsGraph` is one). */
export interface WinrateGraphData {
  hands: number;
  buckets: readonly WinrateGraphBucket[];
  /** Null when the EV line is not available; `allInHands` evaluated all-ins in the sample. */
  allInEv: { allInHands: number } | null;
  mixedUnitKind: boolean;
  mixedCurrency: boolean;
}

/** The currency of the money view. */
export interface WinrateGraphMoney {
  /** Minor units per unit (100 for cents). */
  minorUnits: number;
  /** An amount in units, signed and with its symbol: "+$12.50". */
  format: (amount: number) => string;
}

interface WinrateGraphProps {
  graph: WinrateGraphData;
  /** Big blinds (the default, and the web's only view) or money. */
  unit?: "bb" | "money";
  /** Required for `unit="money"`. */
  money?: WinrateGraphMoney | null;
}

interface Series extends PlotSeries {
  label: string;
  hint: string;
}

export function WinrateGraph({ graph, unit = "bb", money = null }: WinrateGraphProps) {
  const strings = useUiStrings();
  const t = strings.winrateGraph;
  const locale = strings.intlLocale;
  const count = countIn(locale);
  const bb = numberFormat(locale, { maximumFractionDigits: 1, signDisplay: "exceptZero" });
  const date = dateFormat(locale, { dateStyle: "medium" });
  /** The money view, when asked for and possible. */
  const inMoney = unit === "money" && money !== null ? money : null;
  /** A figure as the table prints it, and as the legend and tooltip do. */
  const plain = (value: number) => (inMoney ? inMoney.format(value) : bb.format(value));
  const labelled = (value: number) => (inMoney ? inMoney.format(value) : t.bb(bb.format(value)));
  const [tableOpen, setTableOpen] = useState(false);

  const model = useMemo(() => {
    // The origin is prepended rather than returned by the server: every series
    // is cumulative and therefore starts at zero by definition, and a curve
    // that begins at its first bucket's total hides the first bucket's result.
    const xs = Float64Array.from([0, ...graph.buckets.map((bucket) => bucket.cumHands)]);

    // Big blinds from thousandths, money from minor units.
    type Pick = (b: WinrateGraphBucket) => number | null | undefined;
    const line = (bbMilli: (b: WinrateGraphBucket) => number, net: Pick) =>
      Float64Array.from(
        inMoney
          ? [0, ...graph.buckets.map((b) => (net(b) ?? 0) / inMoney.minorUnits)]
          : [0, ...graph.buckets.map((b) => bbMilli(b) / 1000)],
      );
    const series: Series[] = [
      {
        key: "total",
        ...t.series.total,
        values: line((b) => b.cumNetBbMilli, (b) => b.cumNet),
      },
      {
        key: "showdown",
        ...t.series.showdown,
        values: line((b) => b.cumSdBbMilli, (b) => b.cumSdNet),
      },
      {
        key: "nonShowdown",
        ...t.series.nonShowdown,
        values: line((b) => b.cumNsdBbMilli, (b) => b.cumNsdNet),
      },
    ];
    if (graph.allInEv && graph.allInEv.allInHands > 0) {
      series.push({
        key: "allInEv",
        label: t.series.allInEv.label,
        hint: t.series.allInEv.hint(graph.allInEv.allInHands),
        values: line((b) => b.cumEvBbMilli, (b) => b.cumEvNet),
      });
    }
    return { xs, series };
  }, [graph.buckets, graph.allInEv, t, inMoney]);

  const tickFormat = useMemo(() => {
    const whole = numberFormat(locale, { maximumFractionDigits: 0 });
    const fine = numberFormat(locale, { maximumFractionDigits: 2 });
    return (value: number, step: number) => (Number.isInteger(step) ? whole : fine).format(Math.abs(value) < 1e-9 ? 0 : value);
  }, [locale]);

  const tooltip = useCallback(
    (index: number) => {
      const bucket = graph.buckets[index - 1];
      if (!bucket) {
        return null;
      }
      const at = (key: SeriesKey) => model.series.find((s) => s.key === key)?.values[index] ?? 0;
      return (
        <>
          <strong>{t.hands(bucket.cumHands)}</strong>
          <span className="muted">
            {bucket.firstPlayedAt
              ? `${date.format(new Date(bucket.firstPlayedAt))} – ${
                  bucket.lastPlayedAt ? date.format(new Date(bucket.lastPlayedAt)) : "?"
                }`
              : t.noDates}
          </span>
          <dl>
            {model.series.map((s) => (
              <div key={s.key}>
                <dt>
                  <span className={`stats-key stats-key--${s.key}`} /> {s.label}
                </dt>
                <dd>{labelled(at(s.key))}</dd>
              </div>
            ))}
          </dl>
        </>
      );
    },
    // `labelled` and `date` are rebuilt each render from `locale`, `t` and `inMoney`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.buckets, model, t, locale, inMoney],
  );

  if (graph.mixedUnitKind) {
    return <p className="notice notice--warn">{t.mixedUnitKind}</p>;
  }

  if (graph.buckets.length < 2) {
    return <p className="notice notice--info">{t.notEnough}</p>;
  }

  const end = (s: Series) => s.values[s.values.length - 1];

  return (
    <div className="stats-chart">
      <WinratePlot
        xs={model.xs}
        series={model.series}
        ariaLabel={t.ariaLabel(graph.hands)}
        strings={t}
        formatHands={count}
        formatTick={tickFormat}
        tooltip={tooltip}
      />

      {/* The legend is always present: colour alone is never the identity
          channel. It carries the end value of each series too, which is what
          direct end-labels would have said — and which, on three converging
          lines, they would have said on top of each other. */}
      <ul className="stats-legend">
        {model.series.map((s) => (
          <li key={s.key}>
            <span className={`stats-key stats-key--${s.key}`} />
            <span className="stats-legend__label">{s.label}</span>
            <span className="stats-legend__value">{labelled(end(s))}</span>
            <span className="stats-legend__hint">{s.hint}</span>
          </li>
        ))}
        {model.series.some((s) => s.key === "allInEv") ? null : (
          <li className="is-pending">
            <span className="stats-key stats-key--allInEv" />
            <span className="stats-legend__label">{t.series.allInEv.label}</span>
            <span className="stats-legend__value">{graph.allInEv ? t.noAllIns : t.notComputed}</span>
            <span className="stats-legend__hint">{graph.allInEv ? t.noAllInsHint : t.notComputedHint}</span>
          </li>
        )}
      </ul>

      {graph.mixedCurrency ? <p className="notice notice--info">{t.mixedCurrency}</p> : null}

      {/* A table view exists for every chart. It is also the only readout that
          survives a screen reader, a print-out and forced-colors mode. Its
          rows (a thousand on a big sample) are built once it is opened. */}
      <details className="stats-chart__table" onToggle={(event) => setTableOpen(event.currentTarget.open)}>
        <summary>{t.showNumbers}</summary>
        {tableOpen ? (
          <table>
            <thead>
              <tr>
                <th scope="col">{t.handsHead}</th>
                <th scope="col">{t.series.total.label}</th>
                <th scope="col">{t.series.showdown.label}</th>
                <th scope="col">{t.series.nonShowdown.label}</th>
                <th scope="col">{t.from}</th>
                <th scope="col">{t.to}</th>
              </tr>
            </thead>
            <tbody>
              {graph.buckets.map((bucket, index) => (
                <tr key={bucket.bucket}>
                  <td>{count(bucket.cumHands)}</td>
                  <td>{plain(model.series[0].values[index + 1])}</td>
                  <td>{plain(model.series[1].values[index + 1])}</td>
                  <td>{plain(model.series[2].values[index + 1])}</td>
                  <td>{bucket.firstPlayedAt ? date.format(new Date(bucket.firstPlayedAt)) : "—"}</td>
                  <td>{bucket.lastPlayedAt ? date.format(new Date(bucket.lastPlayedAt)) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </details>
    </div>
  );
}
