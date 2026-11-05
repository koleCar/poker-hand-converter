/**
 * The win-rate graph's geometry (`packages/ui/stats/graphGeometry.ts`) and
 * its first render: finding a point, reading a line between its points (how
 * a new hand grows out of the old endpoint), the y range of a zoomed window,
 * zooming and panning a window, the decimated path, and the markup with the
 * zoom bar.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import {
  extentIn,
  linePath,
  lowerBound,
  nearestIndex,
  niceRange,
  panWindow,
  resample,
  valueAt,
  windowBetween,
  zoomWindow,
} from "@rail/ui/stats/graphGeometry";
import { WinrateGraph, type WinrateGraphBucket } from "@rail/ui/stats/WinrateGraph";
import { statsUiEn } from "@rail/ui/strings/stats.en";

const xs = Float64Array.from([0, 10, 20, 30]);
const ys = Float64Array.from([0, 5, -5, 15]);

describe("the graph's geometry", () => {
  it("finds points", () => {
    expect(lowerBound(xs, -1)).toBe(0);
    expect(lowerBound(xs, 10)).toBe(1);
    expect(lowerBound(xs, 11)).toBe(2);
    expect(lowerBound(xs, 99)).toBe(4);
    expect(nearestIndex(xs, 14)).toBe(1);
    expect(nearestIndex(xs, 16)).toBe(2);
    expect(nearestIndex(xs, 15)).toBe(1);
    expect(nearestIndex(xs, 1e9)).toBe(3);
  });

  it("reads a line between its points, its end's value past either end", () => {
    expect(valueAt(xs, ys, 5)).toBe(2.5);
    expect(valueAt(xs, ys, 25)).toBe(5);
    expect(valueAt(xs, ys, -3)).toBe(0);
    expect(valueAt(xs, ys, 45)).toBe(15);
    // A new hand at 40: the old line, read there, is still its last value.
    expect(Array.from(resample(xs, ys, Float64Array.from([0, 15, 30, 40])))).toEqual([0, 0, 15, 15]);
  });

  it("fits the y range to a window, with zero only for the whole sample", () => {
    expect(extentIn(xs, [ys], 0, 30)).toEqual([-5, 15]);
    // The edges are read on the line: 5 at 25 is the window's low.
    expect(extentIn(xs, [ys], 25, 30)).toEqual([5, 15]);
    const whole = niceRange(5, 15, true);
    expect(whole.y0).toBe(0);
    const zoomed = niceRange(5, 15, false);
    expect(zoomed.y0).toBeGreaterThan(0);
    expect(zoomed.y1).toBeGreaterThanOrEqual(15);
    // A flat window still has a height.
    const flat = niceRange(7, 7, false);
    expect(flat.y1).toBeGreaterThan(flat.y0);
  });

  it("zooms about a hand and pans inside the sample", () => {
    const half = zoomWindow(null, 0.5, 50, 100, 4);
    expect(half).toEqual({ from: 25, to: 75 });
    // About the pointer: the hand under it stays put.
    const left = zoomWindow({ from: 0, to: 100 }, 0.5, 20, 100, 4);
    expect(left).toEqual({ from: 10, to: 60 });
    // Never narrower than the minimum, never wider than the sample.
    expect(zoomWindow({ from: 40, to: 50 }, 0.01, 45, 100, 4)).toEqual({ from: 43, to: 47 });
    expect(zoomWindow({ from: 25, to: 75 }, 4, 50, 100, 4)).toBeNull();
    expect(panWindow({ from: 25, to: 75 }, 40, 100)).toEqual({ from: 50, to: 100 });
    expect(panWindow({ from: 25, to: 75 }, -40, 100)).toEqual({ from: 0, to: 50 });
    expect(panWindow(null, 10, 100)).toBeNull();
    expect(windowBetween(80, 60, 100, 4)).toEqual({ from: 60, to: 80 });
    expect(windowBetween(50, 51, 100, 4)).toEqual({ from: 48.5, to: 52.5 });
    expect(windowBetween(0, 100, 100, 4)).toBeNull();
  });

  it("draws every point when there is room, a few per pixel column when not", () => {
    const toX = (x: number) => x;
    const toY = (y: number) => -y;
    expect(linePath(xs, ys, 0, 30, toX, toY)).toBe("M0,0L10,-5L20,5L30,-15");
    // Over a window, one point either side so the line reaches the edges.
    expect(linePath(xs, ys, 12, 18, toX, toY)).toBe("M10,-5L20,5");

    const n = 10_000;
    const many = Float64Array.from({ length: n }, (_, i) => i);
    const zigzag = Float64Array.from({ length: n }, (_, i) => (i % 2 === 0 ? i % 7 : -(i % 11)));
    // 10,000 points on 100 pixels.
    const d = linePath(many, zigzag, 0, n - 1, (x) => x / 100, (y) => y);
    const points = d.split(/[ML]/).filter(Boolean);
    expect(points.length).toBeLessThanOrEqual(100 * 4 + 4);
    // The extremes survive the cut.
    const values = points.map((p) => Number(p.split(",")[1]));
    expect(Math.max(...values)).toBe(6);
    expect(Math.min(...values)).toBe(-10);
  });
});

function bucket(i: number, cumHands: number, net: number): WinrateGraphBucket {
  return {
    bucket: i,
    hands: 1,
    firstPlayedAt: null,
    lastPlayedAt: null,
    cumHands,
    cumNetBbMilli: net,
    cumSdBbMilli: net,
    cumNsdBbMilli: 0,
    cumEvBbMilli: net,
    cumNet: null,
  };
}

describe("the graph's first render", () => {
  it("draws the lines, the zoom bar and a closed table", () => {
    const strings = {
      intlLocale: "en-GB",
      winrateGraph: {
        ...statsUiEn.graph,
        hands: statsUiEn.hands,
        handsHead: statsUiEn.handsHead,
        bb: statsUiEn.bb,
      },
    } as unknown as UiStrings;
    const html = renderToStaticMarkup(
      createElement(
        UiStringsProvider,
        { strings },
        createElement(WinrateGraph, {
          graph: {
            hands: 3,
            buckets: [bucket(1, 1, -1000), bucket(2, 2, 118_500), bucket(3, 3, 117_000)],
            allInEv: null,
            mixedUnitKind: false,
            mixedCurrency: false,
          },
        }),
      ),
    );
    expect(html).toContain("stats-chart__line--total");
    expect(html).toContain(statsUiEn.graph.zoom.hint);
    expect(html).toContain(`aria-label="${statsUiEn.graph.zoom.in}"`);
    // The legend carries the end value; the table's rows wait to be opened.
    expect(html).toContain("+117 bb");
    expect(html).not.toContain("<tbody>");
  });
});
