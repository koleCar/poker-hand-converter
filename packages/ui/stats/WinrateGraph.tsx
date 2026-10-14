/**
 * The win-rate graph. Hand-written SVG, no chart library.
 *
 * A charting dependency would be the largest thing in this project — the app
 * ships React and supabase-js and nothing else, and `/h/:slug` is a public
 * landing page where every kilobyte is paid for by a stranger on a phone. What
 * is actually needed here is four polylines, two axes and a crosshair, which is
 * this file. It also means the chart inherits the token palette exactly rather
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
 * ## The x-axis is hands, not time
 *
 * Bucketed server-side with `ntile()` over the hand ordering. A player who took
 * three months off must not get three months of x-axis for zero volume — the
 * shape of a win-rate graph is about sample, and a flat stretch meaning "I did
 * not play" is indistinguishable from one meaning "I broke even for 20 000
 * hands". The dates are in the tooltip, where they belong.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUiStrings } from "../i18n";
import { niceStep, ticks } from "./chartScale";
import { countIn, dateFormat, numberFormat } from "./format";
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

const PAD = { top: 18, right: 22, bottom: 30, left: 56 };
const HEIGHT = 300;

type SeriesKey = "total" | "showdown" | "nonShowdown" | "allInEv";

interface Series {
  key: SeriesKey;
  label: string;
  hint: string;
  /** Cumulative big blinds, one entry per point (including the origin). */
  values: number[];
}

interface Point {
  /** Cumulative hands. */
  x: number;
  bucket: WinrateGraphBucket | null;
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
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(860);
  const [hover, setHover] = useState<number | null>(null);

  /**
   * The viewBox is measured in CSS pixels rather than fixed with
   * `preserveAspectRatio`, so one SVG unit is one device-independent pixel at
   * every width. A fixed viewBox scaled to fit would shrink the axis labels
   * along with everything else, and a 12px tick becomes 5px on a phone.
   */
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) {
        setWidth(Math.max(320, Math.round(next)));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => {
    // The origin is prepended rather than returned by the server: every series
    // is cumulative and therefore starts at zero by definition, and a curve
    // that begins at its first bucket's total hides the first bucket's result.
    const points: Point[] = [{ x: 0, bucket: null }];
    for (const bucket of graph.buckets) {
      points.push({ x: bucket.cumHands, bucket });
    }

    // Big blinds from thousandths, money from minor units.
    type Pick = (b: WinrateGraphBucket) => number | null | undefined;
    const line = (bbMilli: (b: WinrateGraphBucket) => number, net: Pick) =>
      inMoney
        ? [0, ...graph.buckets.map((b) => (net(b) ?? 0) / inMoney.minorUnits)]
        : [0, ...graph.buckets.map((b) => bbMilli(b) / 1000)];
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

    const all = series.flatMap((s) => s.values);
    const rawMin = Math.min(0, ...all);
    const rawMax = Math.max(0, ...all);
    // A dead-flat sample would otherwise divide by zero; give it a unit range.
    const span = rawMax - rawMin || 2;
    const step = niceStep(span, 5);
    const min = Math.floor(rawMin / step) * step;
    const max = Math.ceil(rawMax / step) * step;

    return { points, series, min, max: max === min ? min + step : max, step };
  }, [graph.buckets, graph.allInEv, t, inMoney]);

  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const maxHands = model.points[model.points.length - 1]?.x || 1;

  const xAt = useCallback(
    (hands: number) => PAD.left + (hands / maxHands) * innerW,
    [innerW, maxHands],
  );
  const yAt = useCallback(
    (bb: number) => PAD.top + innerH - ((bb - model.min) / (model.max - model.min)) * innerH,
    [innerH, model.min, model.max],
  );

  const onPointer = useCallback(
    (event: React.PointerEvent<SVGRectElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const ratio = (event.clientX - box.left) / Math.max(1, box.width);
      const hands = ratio * maxHands;
      let best = 0;
      let bestGap = Infinity;
      model.points.forEach((point, index) => {
        const gap = Math.abs(point.x - hands);
        if (gap < bestGap) {
          bestGap = gap;
          best = index;
        }
      });
      setHover(best);
    },
    [maxHands, model.points],
  );

  if (graph.mixedUnitKind) {
    return (
      <p className="notice notice--warn">{t.mixedUnitKind}</p>
    );
  }

  if (graph.buckets.length < 2) {
    return (
      <p className="notice notice--info">{t.notEnough}</p>
    );
  }

  const yTicks = ticks(model.min, model.max, model.step);
  const xStep = niceStep(maxHands, 5);
  const xTicks = ticks(0, maxHands, xStep).filter((value) => value <= maxHands);
  const active = hover !== null ? model.points[hover] : null;
  const activeBucket = active?.bucket ?? null;

  return (
    <div className="stats-chart" ref={wrapRef}>
      <svg
        className="stats-chart__svg"
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={t.ariaLabel(graph.hands)}
      >
        {/* Gridlines: hairline, solid, one step off the surface. They exist to
            be read past, so they never get a dash or a second weight. */}
        {yTicks.map((value) => (
          <g key={`y${value}`}>
            <line
              className={value === 0 ? "stats-chart__zero" : "stats-chart__grid"}
              x1={PAD.left}
              x2={width - PAD.right}
              y1={yAt(value)}
              y2={yAt(value)}
            />
            <text className="stats-chart__tick stats-chart__tick--y" x={PAD.left - 8} y={yAt(value) + 4}>
              {count(Math.round(value))}
            </text>
          </g>
        ))}

        {xTicks.map((value) => (
          <text
            key={`x${value}`}
            className="stats-chart__tick stats-chart__tick--x"
            x={xAt(value)}
            y={HEIGHT - 10}
          >
            {count(Math.round(value))}
          </text>
        ))}

        {model.series.map((s) => (
          <polyline
            key={s.key}
            className={`stats-chart__line stats-chart__line--${s.key}`}
            points={s.values.map((value, index) => `${xAt(model.points[index].x)},${yAt(value)}`).join(" ")}
          />
        ))}

        {/* Endpoint markers. A ring in the surface colour keeps them legible
            where two series finish on top of each other. */}
        {model.series.map((s) => (
          <circle
            key={`${s.key}-end`}
            className={`stats-chart__dot stats-chart__dot--${s.key}`}
            cx={xAt(maxHands)}
            cy={yAt(s.values[s.values.length - 1])}
            r={4}
          />
        ))}

        {active ? (
          <g>
            <line
              className="stats-chart__crosshair"
              x1={xAt(active.x)}
              x2={xAt(active.x)}
              y1={PAD.top}
              y2={PAD.top + innerH}
            />
            {model.series.map((s) => (
              <circle
                key={`${s.key}-hover`}
                className={`stats-chart__dot stats-chart__dot--${s.key}`}
                cx={xAt(active.x)}
                cy={yAt(s.values[hover ?? 0])}
                r={4}
              />
            ))}
          </g>
        ) : null}

        <rect
          className="stats-chart__hit"
          x={PAD.left}
          y={PAD.top}
          width={innerW}
          height={innerH}
          onPointerMove={onPointer}
          onPointerLeave={() => setHover(null)}
        />
      </svg>

      <p className="stats-chart__axis-label">{t.axisLabel}</p>

      {activeBucket ? (
        <div
          className="stats-chart__tooltip"
          style={{
            // Flip to the left of the crosshair once it is past the middle, so
            // the panel never runs off the right-hand edge.
            left: `${xAt(activeBucket.cumHands)}px`,
            transform:
              xAt(activeBucket.cumHands) > width / 2 ? "translate(-100%, 0)" : "translate(8px, 0)",
          }}
        >
          <strong>{t.hands(activeBucket.cumHands)}</strong>
          <span className="muted">
            {activeBucket.firstPlayedAt
              ? `${date.format(new Date(activeBucket.firstPlayedAt))} – ${
                  activeBucket.lastPlayedAt ? date.format(new Date(activeBucket.lastPlayedAt)) : "?"
                }`
              : t.noDates}
          </span>
          <dl>
            {model.series.map((s) => (
              <div key={s.key}>
                <dt>
                  <span className={`stats-key stats-key--${s.key}`} /> {s.label}
                </dt>
                <dd>{labelled(s.values[hover ?? 0])}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {/* The legend is always present: colour alone is never the identity
          channel. It carries the end value of each series too, which is what
          direct end-labels would have said — and which, on three converging
          lines, they would have said on top of each other. */}
      <ul className="stats-legend">
        {model.series.map((s) => (
          <li key={s.key}>
            <span className={`stats-key stats-key--${s.key}`} />
            <span className="stats-legend__label">{s.label}</span>
            <span className="stats-legend__value">{labelled(s.values[s.values.length - 1])}</span>
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

      {graph.mixedCurrency ? (
        <p className="notice notice--info">{t.mixedCurrency}</p>
      ) : null}

      {/* A table view exists for every chart. It is also the only readout that
          survives a screen reader, a print-out and forced-colors mode. */}
      <details className="stats-chart__table">
        <summary>{t.showNumbers}</summary>
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
      </details>
    </div>
  );
}
