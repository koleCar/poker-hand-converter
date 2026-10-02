/**
 * One analysis metric over time (phase A6): a line of per-bucket values, an
 * optional 95% band, and the graded-move volume under it. Hand-written SVG on
 * the win-rate graph's pattern (`components/stats/WinrateGraph.tsx`): the
 * viewBox is measured in CSS pixels so a tick is 12px on a phone too, the
 * axis arithmetic is shared (`chartScale.ts`), the classes are the stats
 * chart's, and a table view carries every number for screen readers, print
 * and forced colours.
 *
 * Unlike the win-rate graph the x-axis is **buckets** (weeks, months,
 * sessions), evenly spaced: a mean per stretch is not cumulative, and a gap
 * in play is not a stretch. A bucket with few graded moves is drawn hollow —
 * its mean swings by chance — and the band says by how much.
 *
 * Keyboard: the chart is one tab stop; the arrow keys walk the points, Home
 * and End jump, Escape leaves, and the point's numbers are announced.
 */

"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useDict } from "../../../lib/i18n/client";
import { niceStep, ticks } from "../../stats/chartScale";
import styles from "../leaks/leaks.module.css";

export interface TrendChartPoint {
  key: string;
  /** Tick label under the point. */
  label: string;
  /** The stretch it covers, for the tooltip and the table. */
  range: string;
  value: number | null;
  low: number | null;
  high: number | null;
  /** Graded moves. */
  volume: number;
  hands: number;
  thin: boolean;
}

interface TrendChartProps {
  name: string;
  hint?: string;
  points: TrendChartPoint[];
  format: (value: number) => string;
  /** The y-axis labels; defaults to `format`. */
  formatTick?: (value: number) => string;
  /** Keep zero on the axis (EV lost, shares). */
  fromZero?: boolean;
  /** Clamp the axis (a score never leaves 0–100). */
  bounds?: [number, number];
  compact?: boolean;
}

const PAD = { top: 14, right: 16, bottom: 28, left: 52 };

export function TrendChart({ name, hint, points, format, formatTick = format, fromZero = false, bounds, compact = false }: TrendChartProps) {
  const t = useDict().analysis.progress;
  const height = compact ? 170 : 260;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);
  const hintId = useId();

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(Math.max(280, Math.round(next)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = useMemo(() => {
    const values = points.flatMap((point) =>
      [point.value, point.low, point.high].filter((value): value is number => value !== null && Number.isFinite(value)),
    );
    let min = values.length ? Math.min(...values) : 0;
    let max = values.length ? Math.max(...values) : 1;
    if (fromZero) min = Math.min(0, min);
    if (bounds) {
      min = Math.max(bounds[0], min);
      max = Math.min(bounds[1], max);
    }
    const span = max - min || Math.max(1, Math.abs(max) * 0.1);
    const step = niceStep(span, compact ? 3 : 5);
    let lo = Math.floor(min / step) * step;
    let hi = Math.ceil(max / step) * step;
    if (hi === lo) hi = lo + step;
    if (bounds) {
      lo = Math.max(bounds[0], lo);
      hi = Math.min(bounds[1], hi);
    }
    const maxVolume = Math.max(1, ...points.map((point) => point.volume));
    return { lo, hi, step, maxVolume };
  }, [points, fromZero, bounds, compact]);

  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(1, points.length);
  const xAt = useCallback((index: number) => PAD.left + slot * (index + 0.5), [slot]);
  const yAt = useCallback(
    (value: number) => {
      const clamped = Math.min(scale.hi, Math.max(scale.lo, value));
      return PAD.top + innerH - ((clamped - scale.lo) / (scale.hi - scale.lo)) * innerH;
    },
    [innerH, scale.hi, scale.lo],
  );

  const onPointer = useCallback(
    (event: React.PointerEvent<SVGRectElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const ratio = (event.clientX - box.left) / Math.max(1, box.width);
      setActive(Math.min(points.length - 1, Math.max(0, Math.floor(ratio * points.length))));
    },
    [points.length],
  );

  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (points.length === 0) return;
    const last = points.length - 1;
    const current = active ?? last;
    let next: number | null = current;
    if (event.key === "ArrowRight") next = Math.min(last, current + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") next = null;
    else return;
    event.preventDefault();
    setActive(next);
  };

  // Segments break at a bucket with no value rather than drawing across it.
  const segments: string[] = [];
  let run: string[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (run.length) segments.push(run.join(" "));
      run = [];
      return;
    }
    run.push(`${xAt(index)},${yAt(point.value)}`);
  });
  if (run.length) segments.push(run.join(" "));

  const band = points
    .map((point, index) => (point.low !== null && point.high !== null ? { index, low: point.low, high: point.high } : null))
    .filter((entry): entry is { index: number; low: number; high: number } => entry !== null);
  const bandPath =
    band.length > 1
      ? `M ${band.map((entry) => `${xAt(entry.index)},${yAt(entry.high)}`).join(" L ")} L ${[...band]
          .reverse()
          .map((entry) => `${xAt(entry.index)},${yAt(entry.low)}`)
          .join(" L ")} Z`
      : null;

  const yTicks = ticks(scale.lo, scale.hi, scale.step);
  // At most ~6 labels under the axis, whatever the number of buckets.
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerW / 90))));
  const point = active !== null ? points[active] : null;
  const volumeTop = PAD.top + innerH * 0.78;
  const barW = Math.max(2, Math.min(28, slot * 0.6));

  const describe = (entry: TrendChartPoint) =>
    `${entry.range}: ${entry.value !== null ? format(entry.value) : "—"}${
      entry.low !== null && entry.high !== null ? ` (${t.charts.interval(entry.low, entry.high)})` : ""
    }, ${t.moves(entry.volume)}`;

  return (
    <div className={`stats-chart ${styles.trend}`}>
      <div className={styles.trendHead}>
        <h4 className={styles.trendName}>{name}</h4>
        {hint ? <span className={styles.trendHint}>{hint}</span> : null}
      </div>
      <div
        ref={wrapRef}
        className={styles.trendPlot}
        tabIndex={0}
        role="group"
        aria-label={t.charts.aria(name, points.length)}
        aria-describedby={hintId}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <svg
          className="stats-chart__svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          focusable="false"
        >
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
                {formatTick(value)}
              </text>
            </g>
          ))}

          {points.map((entry, index) => {
            const h = (entry.volume / scale.maxVolume) * (PAD.top + innerH - volumeTop);
            return (
              <rect
                key={`v${entry.key}`}
                className={styles.volumeBar}
                x={xAt(index) - barW / 2}
                y={PAD.top + innerH - h}
                width={barW}
                height={h}
              />
            );
          })}

          {bandPath ? <path className={styles.band} d={bandPath} /> : null}

          {segments.map((segment, index) => (
            <polyline key={`s${index}`} className="stats-chart__line stats-chart__line--total" points={segment} />
          ))}

          {points.map((entry, index) =>
            entry.value === null ? null : (
              <circle
                key={`p${entry.key}`}
                className={entry.thin ? styles.thinDot : "stats-chart__dot stats-chart__dot--total"}
                cx={xAt(index)}
                cy={yAt(entry.value)}
                r={active === index ? 5 : 3.5}
              />
            ),
          )}

          {points.map((entry, index) =>
            index % every === 0 || index === points.length - 1 ? (
              <text key={`x${entry.key}`} className="stats-chart__tick stats-chart__tick--x" x={xAt(index)} y={height - 8}>
                {entry.label}
              </text>
            ) : null,
          )}

          {point && active !== null ? (
            <line
              className="stats-chart__crosshair"
              x1={xAt(active)}
              x2={xAt(active)}
              y1={PAD.top}
              y2={PAD.top + innerH}
            />
          ) : null}

          <rect
            className="stats-chart__hit"
            x={PAD.left}
            y={PAD.top}
            width={innerW}
            height={innerH}
            onPointerMove={onPointer}
            onPointerLeave={() => setActive(null)}
          />
        </svg>

        {point && active !== null ? (
          <div
            className="stats-chart__tooltip"
            style={{
              left: `${xAt(active)}px`,
              transform: xAt(active) > width / 2 ? "translate(-100%, 0)" : "translate(8px, 0)",
            }}
          >
            <strong>{point.value !== null ? format(point.value) : "—"}</strong>
            <span className="muted">{point.range}</span>
            {point.low !== null && point.high !== null ? (
              <span className="muted">{t.charts.interval(point.low, point.high)}</span>
            ) : null}
            <dl>
              <div>
                <dt>{t.charts.moves}</dt>
                <dd>{point.volume}</dd>
              </div>
              <div>
                <dt>{t.charts.hands}</dt>
                <dd>{point.hands}</dd>
              </div>
            </dl>
          </div>
        ) : null}
      </div>
      <p id={hintId} className={styles.srOnly}>
        {t.charts.keys}
      </p>
      <p className={styles.srOnly} aria-live="polite">
        {point ? describe(point) : ""}
      </p>

      <details className="stats-chart__table">
        <summary>{t.charts.showNumbers}</summary>
        <div className="stats-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t.charts.when}</th>
                <th scope="col">{name}</th>
                <th scope="col">{t.charts.moves}</th>
                <th scope="col">{t.charts.hands}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((entry) => (
                <tr key={`t${entry.key}`}>
                  <th scope="row">{entry.range}</th>
                  <td>
                    {entry.value !== null ? format(entry.value) : "—"}
                    {entry.low !== null && entry.high !== null ? (
                      <span className={styles.tableInterval}>{t.charts.interval(entry.low, entry.high)}</span>
                    ) : null}
                  </td>
                  <td>{entry.volume}</td>
                  <td>{entry.hands}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
