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
import type { StatsGraph, StatsGraphBucket } from "../../lib/db";
import { useDict } from "../../lib/i18n/client";
import { countIn, dateFormat, numberFormat, useIntlLocale } from "./format";

interface WinrateGraphProps {
  graph: StatsGraph;
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
  bucket: StatsGraphBucket | null;
}

/** Round a span up to a readable step: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(span: number, targetTicks: number): number {
  if (span <= 0) {
    return 1;
  }
  const rough = span / Math.max(1, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + 1e-9; value += step) {
    // Kill the -0 that falls out of the accumulation and prints as "-0".
    out.push(value === 0 ? 0 : value);
  }
  return out;
}

export function WinrateGraph({ graph }: WinrateGraphProps) {
  const t = useDict().stats;
  const en = t.graph;
  const locale = useIntlLocale();
  const count = countIn(locale);
  const bb = numberFormat(locale, { maximumFractionDigits: 1, signDisplay: "exceptZero" });
  const date = dateFormat(locale, { dateStyle: "medium" });
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

    const series: Series[] = [
      {
        key: "total",
        ...en.series.total,
        values: [0, ...graph.buckets.map((b) => b.cumNetBbMilli / 1000)],
      },
      {
        key: "showdown",
        ...en.series.showdown,
        values: [0, ...graph.buckets.map((b) => b.cumSdBbMilli / 1000)],
      },
      {
        key: "nonShowdown",
        ...en.series.nonShowdown,
        values: [0, ...graph.buckets.map((b) => b.cumNsdBbMilli / 1000)],
      },
    ];
    if (graph.allInEv && graph.allInEv.allInHands > 0) {
      series.push({
        key: "allInEv",
        label: en.series.allInEv.label,
        hint: en.series.allInEv.hint(graph.allInEv.allInHands),
        values: [0, ...graph.buckets.map((b) => b.cumEvBbMilli / 1000)],
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
  }, [graph.buckets, graph.allInEv, en]);

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
      <p className="notice notice--warn">{en.mixedUnitKind}</p>
    );
  }

  if (graph.buckets.length < 2) {
    return (
      <p className="notice notice--info">{en.notEnough}</p>
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
        aria-label={en.ariaLabel(graph.hands)}
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

      <p className="stats-chart__axis-label">{en.axisLabel}</p>

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
          <strong>{t.common.hands(activeBucket.cumHands)}</strong>
          <span className="muted">
            {activeBucket.firstPlayedAt
              ? `${date.format(new Date(activeBucket.firstPlayedAt))} – ${
                  activeBucket.lastPlayedAt ? date.format(new Date(activeBucket.lastPlayedAt)) : "?"
                }`
              : en.noDates}
          </span>
          <dl>
            {model.series.map((s) => (
              <div key={s.key}>
                <dt>
                  <span className={`stats-key stats-key--${s.key}`} /> {s.label}
                </dt>
                <dd>{t.common.bb(bb.format(s.values[hover ?? 0]))}</dd>
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
            <span className="stats-legend__value">{t.common.bb(bb.format(s.values[s.values.length - 1]))}</span>
            <span className="stats-legend__hint">{s.hint}</span>
          </li>
        ))}
        {model.series.some((s) => s.key === "allInEv") ? null : (
          <li className="is-pending">
            <span className="stats-key stats-key--allInEv" />
            <span className="stats-legend__label">{en.series.allInEv.label}</span>
            <span className="stats-legend__value">{graph.allInEv ? en.noAllIns : en.notComputed}</span>
            <span className="stats-legend__hint">{graph.allInEv ? en.noAllInsHint : en.notComputedHint}</span>
          </li>
        )}
      </ul>

      {graph.mixedCurrency ? (
        <p className="notice notice--info">{en.mixedCurrency}</p>
      ) : null}

      {/* A table view exists for every chart. It is also the only readout that
          survives a screen reader, a print-out and forced-colors mode. */}
      <details className="stats-chart__table">
        <summary>{en.showNumbers}</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{t.common.handsHead}</th>
              <th scope="col">{en.series.total.label}</th>
              <th scope="col">{en.series.showdown.label}</th>
              <th scope="col">{en.series.nonShowdown.label}</th>
              <th scope="col">{en.from}</th>
              <th scope="col">{en.to}</th>
            </tr>
          </thead>
          <tbody>
            {graph.buckets.map((bucket) => (
              <tr key={bucket.bucket}>
                <td>{count(bucket.cumHands)}</td>
                <td>{bb.format(bucket.cumNetBbMilli / 1000)}</td>
                <td>{bb.format(bucket.cumSdBbMilli / 1000)}</td>
                <td>{bb.format(bucket.cumNsdBbMilli / 1000)}</td>
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
