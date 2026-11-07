/**
 * The win-rate graph's plot (`WinrateGraph.tsx` draws the legend and the
 * notices around it): the lines, the axes, the crosshair, and
 * since the zoom the three things a static SVG cannot do.
 *
 * ## Motion
 *
 * The plot never jumps. A new hand (Live reads the report again as one lands)
 * moves every line from where it was to where it now is: the old line is read
 * at the new points (`resample`, its last value past its old end, so the new
 * hand grows out of the old endpoint), the axes slide to their new range, and
 * the total's endpoint pulses once. The first draw rises from zero, and a
 * zoom glides. Under `prefers-reduced-motion` every change is a cut.
 *
 * ## Zoom
 *
 * The x-axis zooms to a window of hands, and the y-axis fits the window (no
 * forced zero: a zoomed swing gets the whole height). Drag across the plot to
 * zoom to that stretch; Ctrl/⌘ + scroll, a trackpad pinch or the buttons zoom
 * about the pointer or the middle; a horizontal scroll, Shift + scroll, the
 * arrow keys or the strip under a zoomed plot pan; a double-click or Show all
 * goes back to every hand. A window that ends at the last hand stays there as
 * hands land.
 *
 * ## Cost
 *
 * The lines are paths of at most a few points per pixel column (`linePath`),
 * only over the window, and the animation re-renders this component alone -
 * the legend sits in the parent.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "../replayer/useFrameTransition";
import { niceStep, ticks } from "./chartScale";
import {
  clamp,
  extentIn,
  linePath,
  nearestIndex,
  niceRange,
  panWindow,
  resample,
  windowBetween,
  zoomWindow,
  type HandsWindow,
} from "./graphGeometry";

export type SeriesKey = "total" | "showdown" | "nonShowdown" | "allInEv";

export interface PlotSeries {
  key: SeriesKey;
  /** One value per point of `xs`. */
  values: Float64Array;
}

export interface PlotStrings {
  axisLabel: string;
  zoom: {
    label: string;
    in: string;
    out: string;
    reset: string;
    hint: string;
    range: (from: string, to: string, total: string) => string;
    navigator: string;
  };
}

interface WinratePlotProps {
  /** Cumulative hands, ascending, from 0. */
  xs: Float64Array;
  series: readonly PlotSeries[];
  ariaLabel: string;
  strings: PlotStrings;
  /** A hand count as the axis prints it. */
  formatHands: (hands: number) => string;
  /** A y tick, `step` apart from the next. */
  formatTick: (value: number, step: number) => string;
  /** The tooltip's content for a point (null: none, the origin). */
  tooltip: (index: number) => ReactNode;
}

const PAD = { top: 18, right: 22, bottom: 30, left: 56 };
const HEIGHT = 300;
const NAV_HEIGHT = 36;
/** Milliseconds: the first draw, a change of data, a zoom. */
const DURATION = { enter: 800, data: 650, zoom: 320 };
/** How far the pointer travels before a press is a drag (px). */
const DRAG_THRESHOLD = 5;

type Values = Partial<Record<SeriesKey, Float64Array>>;

/** What is on screen: the lines at some point of an animation and the axes' range. */
interface Frame {
  xs: Float64Array;
  values: Values;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface Target {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  step: number;
}

/** A zoom and the sample size it was set over (the window follows new hands). */
interface ZoomState {
  window: HandsWindow;
  total: number;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** The y range either side of zero an empty plot shows. */
const EMPTY_SPAN = 10;

function reducedNow(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** The window over a sample of `total` hands: a window at the old end follows the end; one the sample no longer covers goes. */
function windowFor(zoom: ZoomState | null, total: number): HandsWindow | null {
  if (!zoom) {
    return null;
  }
  const { window, total: was } = zoom;
  if (was === total) {
    return window;
  }
  if (window.to > total + 1e-9) {
    return null;
  }
  if (total > was && window.to >= was - 1e-9) {
    const span = window.to - window.from;
    return { from: total - span, to: total };
  }
  return window;
}

/** The frame a first draw starts from: the lines flat at zero (or already in place, without motion). */
function firstFrame(xs: Float64Array, series: readonly PlotSeries[], target: Target, still: boolean): Frame {
  const values: Values = {};
  for (const s of series) {
    values[s.key] = still ? s.values : new Float64Array(s.values.length);
  }
  return { xs, values, x0: target.x0, x1: target.x1, y0: target.y0, y1: target.y1 };
}

export function WinratePlot({ xs, series, ariaLabel, strings, formatHands, formatTick, tooltip }: WinratePlotProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const clipId = `stats-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [width, setWidth] = useState(860);
  const [hover, setHover] = useState<number | null>(null);
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null);
  const [zoom, setZoom] = useState<ZoomState | null>(null);
  const reduced = useReducedMotion();

  const total = xs[xs.length - 1] || 1;
  // A window of at least four buckets (or a few hands): narrower is a line
  // between two points stretched across the screen.
  const minSpan = Math.min(total, Math.max(3, (total / Math.max(1, xs.length - 1)) * 4));
  const win = windowFor(zoom, total);
  const view = win ?? { from: 0, to: total };

  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;

  /**
   * The viewBox is measured in CSS pixels rather than fixed with
   * `preserveAspectRatio`, so one SVG unit is one device-independent pixel at
   * every width. A fixed viewBox scaled to fit would shrink the axis labels
   * along with everything else, and a 12px tick becomes 5px on a phone.
   */
  useEffect(() => {
    const element = wrapRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
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

  const target = useMemo<Target>(() => {
    // No lines yet (a session that has only just started): an empty frame
    // around zero, so the graph is already there and the first curve grows
    // into it rather than replacing a notice.
    const [lo, hi] =
      series.length === 0
        ? [-EMPTY_SPAN, EMPTY_SPAN]
        : extentIn(
            xs,
            series.map((s) => s.values),
            view.from,
            view.to,
          );
    const range = niceRange(lo, hi, win === null);
    return { x0: view.from, x1: view.to, ...range };
  }, [xs, series, view.from, view.to, win]);

  // ------------------------------------------------------------- motion

  const [frame, setFrame] = useState<Frame>(() => firstFrame(xs, series, target, reducedNow()));
  /** The frame on screen, for the next animation to start from (set with it). */
  const shown = useRef<Frame | null>(null);
  /** The data the last animation went to: a change of it is new hands, not a zoom. */
  const lastData = useRef<{ xs: Float64Array; series: readonly PlotSeries[] } | null>(null);
  /** How the next zoom moves: a wheel or a drag of the strip follows the hand at once. */
  const motion = useRef<"glide" | "follow">("glide");
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    const first = lastData.current === null;
    const from = shown.current ?? firstFrame(xs, series, target, reduced);
    const newData = first || lastData.current?.xs !== xs || lastData.current?.series !== series;
    const grew = !first && newData && xs[xs.length - 1] > (lastData.current?.xs.at(-1) ?? 0);
    lastData.current = { xs, series };
    const to: Values = {};
    for (const s of series) {
      to[s.key] = s.values;
    }
    const end: Frame = { xs, values: to, x0: target.x0, x1: target.x1, y0: target.y0, y1: target.y1 };
    const instant = reduced || (!newData && motion.current === "follow");
    motion.current = "glide";
    let raf = 0;
    const show = (next: Frame) => {
      shown.current = next;
      setFrame(next);
    };
    if (instant) {
      raf = requestAnimationFrame(() => show(end));
      return () => cancelAnimationFrame(raf);
    }
    let pulsed = !grew;
    // Every line from where it is now, read at the new points.
    const start: Values = {};
    for (const s of series) {
      const was = from.values[s.key] ?? from.values.total;
      start[s.key] =
        from.xs === xs && was ? was : was ? resample(from.xs, was, xs) : new Float64Array(xs.length);
    }
    const duration = first ? DURATION.enter : newData ? DURATION.data : DURATION.zoom;
    const began = performance.now();
    const step = (now: number) => {
      if (!pulsed) {
        pulsed = true;
        setPulse((n) => n + 1);
      }
      const t = Math.min(1, (now - began) / duration);
      const e = easeOut(t);
      const values: Values = {};
      for (const s of series) {
        const a = start[s.key];
        const b = s.values;
        if (!a || a === b || t >= 1) {
          values[s.key] = b;
          continue;
        }
        const out = new Float64Array(b.length);
        for (let i = 0; i < b.length; i += 1) {
          out[i] = a[i] + (b[i] - a[i]) * e;
        }
        values[s.key] = out;
      }
      const mix = (a: number, b: number) => a + (b - a) * e;
      show({
        xs,
        values,
        x0: mix(from.x0, end.x0),
        x1: mix(from.x1, end.x1),
        y0: mix(from.y0, end.y0),
        y1: mix(from.y1, end.y1),
      });
      if (t < 1) {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [xs, series, target, reduced]);

  // --------------------------------------------------------------- zoom

  /** The latest geometry, for the native listeners (wheel, pinch), which outlive a render. */
  const latest = useRef({ total, minSpan, frame, innerW });
  useEffect(() => {
    latest.current = { total, minSpan, frame, innerW };
  });

  const setWindow = useCallback((next: (current: HandsWindow | null, total: number) => HandsWindow | null, how: "glide" | "follow") => {
    const { total: n } = latest.current;
    motion.current = how;
    setZoom((was) => {
      const window = next(windowFor(was, n), n);
      return window ? { window, total: n } : null;
    });
  }, []);

  const zoomBy = useCallback(
    (factor: number, center: number | null, how: "glide" | "follow") => {
      const { minSpan: min } = latest.current;
      setWindow((current, n) => {
        const middle = center ?? (current ? (current.from + current.to) / 2 : n / 2);
        return zoomWindow(current, factor, middle, n, min);
      }, how);
    },
    [setWindow],
  );

  const panBy = useCallback(
    (hands: number, how: "glide" | "follow") => setWindow((current, n) => panWindow(current, hands, n), how),
    [setWindow],
  );

  const reset = useCallback(() => setWindow(() => null, "glide"), [setWindow]);

  /** Hands at a pointer's x, on the frame on screen. */
  const handsAt = useCallback((clientX: number) => {
    const svg = svgRef.current;
    const { frame: f, innerW: w } = latest.current;
    if (!svg) {
      return f.x0;
    }
    const left = svg.getBoundingClientRect().left;
    const share = clamp((clientX - left - PAD.left) / w, 0, 1);
    return f.x0 + share * (f.x1 - f.x0);
  }, []);

  // The wheel and Safari's pinch: native listeners, since React's wheel
  // handler is passive and cannot keep the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }
    let pointerX = 0;
    let scale = 1;
    const onWheel = (event: WheelEvent) => {
      pointerX = event.clientX;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const delta = clamp(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY, -60, 60);
        zoomBy(Math.exp(delta * 0.01), handsAt(event.clientX), "follow");
        return;
      }
      const { frame: f, total: n, innerW: w } = latest.current;
      const zoomed = f.x1 - f.x0 < n - 1e-9;
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
      if (!zoomed || sideways === 0) {
        return;
      }
      event.preventDefault();
      panBy((sideways / w) * (f.x1 - f.x0), "follow");
    };
    const onPointerMove = (event: PointerEvent) => {
      pointerX = event.clientX;
    };
    // WebKit (Safari, the macOS app's webview) pinches with gesture events.
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      scale = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const next = (event as Event & { scale?: number }).scale ?? 1;
      if (next > 0) {
        zoomBy(scale / next, handsAt(pointerX), "follow");
        scale = next;
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("gesturestart", onGestureStart);
    svg.addEventListener("gesturechange", onGestureChange);
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("pointermove", onPointerMove);
      svg.removeEventListener("gesturestart", onGestureStart);
      svg.removeEventListener("gesturechange", onGestureChange);
    };
  }, [zoomBy, panBy, handsAt]);

  // ------------------------------------------------------ the plot's pointer

  const press = useRef<{ x: number; dragging: boolean } | null>(null);
  const localX = (event: React.PointerEvent) => event.clientX - (svgRef.current?.getBoundingClientRect().left ?? 0);
  const live = frame.xs === xs;

  const hoverAt = (clientX: number) => {
    if (!live) {
      return;
    }
    const index = nearestIndex(xs, handsAt(clientX));
    setHover(index >= 0 ? index : null);
  };

  const onPointerDown = (event: React.PointerEvent<SVGRectElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    press.current = { x: localX(event), dragging: false };
  };

  const onPointerMove = (event: React.PointerEvent<SVGRectElement>) => {
    const down = press.current;
    if (down) {
      const x = clamp(localX(event), PAD.left, PAD.left + innerW);
      if (down.dragging || Math.abs(x - down.x) > DRAG_THRESHOLD) {
        down.dragging = true;
        setHover(null);
        setBrush({ a: clamp(down.x, PAD.left, PAD.left + innerW), b: x });
        return;
      }
    }
    hoverAt(event.clientX);
  };

  const onPointerUp = (event: React.PointerEvent<SVGRectElement>) => {
    const down = press.current;
    press.current = null;
    setBrush(null);
    if (!down?.dragging) {
      return;
    }
    const svgLeft = svgRef.current?.getBoundingClientRect().left ?? 0;
    const a = handsAt(down.x + svgLeft);
    const b = handsAt(event.clientX);
    if (Math.abs(localX(event) - down.x) > DRAG_THRESHOLD) {
      const { minSpan: min } = latest.current;
      setWindow((_, n) => windowBetween(a, b, n, min), "glide");
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const span = view.to - view.from;
    const keys: Record<string, () => void> = {
      "+": () => zoomBy(0.5, null, "glide"),
      "=": () => zoomBy(0.5, null, "glide"),
      "-": () => zoomBy(2, null, "glide"),
      "0": reset,
      Escape: reset,
      ArrowLeft: () => panBy(-span * 0.2, "glide"),
      ArrowRight: () => panBy(span * 0.2, "glide"),
    };
    const action = keys[event.key];
    if (action && !(event.key.startsWith("Arrow") && !win)) {
      event.preventDefault();
      action();
    }
  };

  // --------------------------------------------------------------- drawing

  const xAt = (hands: number) => PAD.left + ((hands - frame.x0) / (frame.x1 - frame.x0 || 1)) * innerW;
  const yAt = (value: number) => PAD.top + innerH - ((value - frame.y0) / (frame.y1 - frame.y0 || 1)) * innerH;

  const paths = useMemo(() => {
    const span = frame.x1 - frame.x0 || 1;
    const dy = frame.y1 - frame.y0 || 1;
    const toX = (hands: number) => PAD.left + ((hands - frame.x0) / span) * innerW;
    const toY = (value: number) => PAD.top + innerH - ((value - frame.y0) / dy) * innerH;
    // The total last, on top: it is the line the graph is about, and it
    // lies on the showdown or the non-showdown line wherever the other is flat.
    const order = [...series].sort((a, b) => Number(a.key === "total") - Number(b.key === "total"));
    return order.map((s) => {
      const values = frame.values[s.key];
      return {
        key: s.key,
        d: values ? linePath(frame.xs, values, frame.x0, frame.x1, toX, toY) : "",
      };
    });
  }, [frame, series, innerW, innerH]);

  // The step of the range on screen: mid-animation that is between the old
  // range and the new, and the labels follow it.
  const ySpan = frame.y1 - frame.y0;
  const yStep = Math.abs(ySpan - (target.y1 - target.y0)) < 1e-9 ? target.step : niceStep(ySpan, 5);
  const yTicks = ticks(frame.y0, frame.y1, yStep);
  const xStep = Math.max(1, niceStep(frame.x1 - frame.x0, 5));
  const xTicks = ticks(frame.x0, frame.x1, xStep);

  const lastX = xs[xs.length - 1];
  const endVisible = lastX >= frame.x0 - 1e-9 && lastX <= frame.x1 + 1e-9;
  const active = live && series.length > 0 && hover !== null && hover > 0 ? hover : null;
  const zoomed = win !== null;
  const canZoomIn = view.to - view.from > minSpan + 1e-9;

  return (
    <div className="stats-chart__plot" ref={wrapRef}>
      {/* Nothing to zoom on an empty plot: the toolbar keeps its height, so the
          plot does not move when the first line arrives. */}
      <div
        className="stats-chart__toolbar"
        style={series.length === 0 ? { visibility: "hidden" } : undefined}
        aria-hidden={series.length === 0 || undefined}
      >
        <p className="stats-chart__range" aria-live="polite">
          {zoomed
            ? strings.zoom.range(
                formatHands(Math.floor(view.from) + 1),
                formatHands(Math.ceil(view.to)),
                formatHands(total),
              )
            : strings.zoom.hint}
        </p>
        <div className="stats-chart__zoom" role="group" aria-label={strings.zoom.label}>
          <button
            type="button"
            className="chip-btn"
            onClick={() => zoomBy(2, null, "glide")}
            disabled={!zoomed}
            aria-label={strings.zoom.out}
            title={strings.zoom.out}
          >
            −
          </button>
          <button
            type="button"
            className="chip-btn"
            onClick={() => zoomBy(0.5, null, "glide")}
            disabled={!canZoomIn}
            aria-label={strings.zoom.in}
            title={strings.zoom.in}
          >
            +
          </button>
          <button type="button" className="chip-btn" onClick={reset} disabled={!zoomed}>
            {strings.zoom.reset}
          </button>
        </div>
      </div>

      <div className="stats-chart__canvas">
      <svg
        ref={svgRef}
        className="stats-chart__svg"
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.left - 2} y={PAD.top - 6} width={innerW + 4} height={innerH + 12} />
          </clipPath>
        </defs>

        {/* Gridlines: hairline, solid, one step off the surface. They exist to
            be read past, so they never get a dash or a second weight. */}
        {yTicks.map((value) => (
          <g key={`y${value}`}>
            <line
              className={Math.abs(value) < yStep * 1e-6 ? "stats-chart__zero" : "stats-chart__grid"}
              x1={PAD.left}
              x2={width - PAD.right}
              y1={yAt(value)}
              y2={yAt(value)}
            />
            <text className="stats-chart__tick stats-chart__tick--y" x={PAD.left - 8} y={yAt(value) + 4}>
              {formatTick(value, yStep)}
            </text>
          </g>
        ))}

        {xTicks.map((value) => (
          <text key={`x${value}`} className="stats-chart__tick stats-chart__tick--x" x={xAt(value)} y={HEIGHT - 10}>
            {formatHands(Math.round(value))}
          </text>
        ))}

        <g clipPath={`url(#${clipId})`}>
          {paths.map((p) => (
            <path key={p.key} className={`stats-chart__line stats-chart__line--${p.key}`} d={p.d} />
          ))}
        </g>

        {/* Endpoint markers. A ring in the surface colour keeps them legible
            where two series finish on top of each other. */}
        {endVisible
          ? series.map((s) => {
              const values = frame.values[s.key];
              return values ? (
                <circle
                  key={`${s.key}-end`}
                  className={`stats-chart__dot stats-chart__dot--${s.key}`}
                  cx={xAt(lastX)}
                  cy={yAt(values[values.length - 1])}
                  r={4}
                />
              ) : null;
            })
          : null}

        {/* A hand landed: the total's endpoint pulses once. */}
        {endVisible && pulse > 0 && frame.values.total ? (
          <circle
            key={`pulse-${pulse}`}
            className="stats-chart__pulse"
            cx={xAt(lastX)}
            cy={yAt(frame.values.total[frame.values.total.length - 1])}
            r={4}
          />
        ) : null}

        {active !== null ? (
          <g>
            <line
              className="stats-chart__crosshair"
              x1={xAt(xs[active])}
              x2={xAt(xs[active])}
              y1={PAD.top}
              y2={PAD.top + innerH}
            />
            {series.map((s) => {
              const values = frame.values[s.key];
              return values ? (
                <circle
                  key={`${s.key}-hover`}
                  className={`stats-chart__dot stats-chart__dot--${s.key}`}
                  cx={xAt(xs[active])}
                  cy={yAt(values[active])}
                  r={4}
                />
              ) : null;
            })}
          </g>
        ) : null}

        {brush ? (
          <rect
            className="stats-chart__brush"
            x={Math.min(brush.a, brush.b)}
            y={PAD.top}
            width={Math.abs(brush.b - brush.a)}
            height={innerH}
          />
        ) : null}

        <rect
          className="stats-chart__hit"
          x={PAD.left}
          y={PAD.top}
          width={innerW}
          height={innerH}
          onPointerDown={onPointerDown}
          // A press neither focuses the plot (its ring is for the keyboard)
          // nor starts a text selection across the page while dragging.
          onMouseDown={(event) => event.preventDefault()}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            press.current = null;
            setBrush(null);
          }}
          onPointerLeave={() => {
            if (!press.current) setHover(null);
          }}
          onDoubleClick={reset}
        />
      </svg>

      {active !== null ? (
        <div
          className="stats-chart__tooltip"
          style={{
            // Flip to the left of the crosshair once it is past the middle, so
            // the panel never runs off the right-hand edge.
            left: `${xAt(xs[active])}px`,
            transform: xAt(xs[active]) > width / 2 ? "translate(-100%, 0)" : "translate(8px, 0)",
          }}
        >
          {tooltip(active)}
        </div>
      ) : null}
      </div>

      {zoomed ? (
        <Navigator
          xs={xs}
          values={series[0]?.values ?? null}
          width={width}
          innerW={innerW}
          from={frame.x0}
          to={frame.x1}
          label={strings.zoom.navigator}
          onMove={(from) => setWindow((current, n) => (current ? panWindow(current, from - current.from, n) : current), "follow")}
        />
      ) : null}

      <p className="stats-chart__axis-label">{strings.axisLabel}</p>
    </div>
  );
}

/**
 * The strip under a zoomed plot: the whole sample's total, the window on it.
 * Drag the window to move it; press elsewhere to centre it there.
 */
function Navigator({
  xs,
  values,
  width,
  innerW,
  from,
  to,
  label,
  onMove,
}: {
  xs: Float64Array;
  values: Float64Array | null;
  width: number;
  innerW: number;
  from: number;
  to: number;
  label: string;
  onMove: (from: number) => void;
}) {
  const total = xs[xs.length - 1] || 1;
  const xAt = (hands: number) => PAD.left + (hands / total) * innerW;
  const grab = useRef<number | null>(null);

  const d = useMemo(() => {
    if (!values) {
      return "";
    }
    const [lo, hi] = extentIn(xs, [values], 0, total);
    const low = Math.min(0, lo);
    const span = Math.max(0, hi) - low || 1;
    return linePath(
      xs,
      values,
      0,
      total,
      (hands) => PAD.left + (hands / total) * innerW,
      (value) => NAV_HEIGHT - 4 - ((value - low) / span) * (NAV_HEIGHT - 8),
    );
  }, [xs, values, total, innerW]);

  const handsAt = (event: React.PointerEvent<SVGSVGElement>) => {
    const left = event.currentTarget.getBoundingClientRect().left;
    return ((event.clientX - left - PAD.left) / innerW) * total;
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const at = handsAt(event);
    const span = to - from;
    if (at >= from && at <= to) {
      grab.current = at - from;
    } else {
      grab.current = span / 2;
      onMove(at - span / 2);
    }
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (grab.current !== null) {
      onMove(handsAt(event) - grab.current);
    }
  };

  const release = () => {
    grab.current = null;
  };

  return (
    <svg
      className="stats-chart__nav"
      width={width}
      height={NAV_HEIGHT}
      viewBox={`0 0 ${width} ${NAV_HEIGHT}`}
      role="img"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <title>{label}</title>
      <rect className="stats-chart__nav-track" x={PAD.left} y={0} width={innerW} height={NAV_HEIGHT} rx={4} />
      <path className="stats-chart__nav-line" d={d} />
      <rect className="stats-chart__nav-shade" x={PAD.left} y={0} width={Math.max(0, xAt(from) - PAD.left)} height={NAV_HEIGHT} />
      <rect
        className="stats-chart__nav-shade"
        x={xAt(to)}
        y={0}
        width={Math.max(0, PAD.left + innerW - xAt(to))}
        height={NAV_HEIGHT}
      />
      <rect
        className="stats-chart__nav-window"
        x={xAt(from)}
        y={0.5}
        width={Math.max(2, xAt(to) - xAt(from))}
        height={NAV_HEIGHT - 1}
        rx={4}
      />
    </svg>
  );
}
