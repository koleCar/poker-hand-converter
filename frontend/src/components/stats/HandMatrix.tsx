/**
 * The 13x13 starting-hand grid: pairs on the diagonal, suited above it,
 * offsuit below — the layout every range chart uses, so it reads without a
 * legend.
 *
 * A CSS grid of buttons rather than an SVG or a chart library: each cell is a
 * real control (focusable, announced, clickable on a phone), and the colours
 * are the theme's own tokens mixed with `color-mix()`, so it follows light and
 * dark without a second palette.
 *
 * Hold'em only. An Omaha hand class is a different alphabet entirely and a
 * 13x13 grid of it would be a picture of nothing; the parent passes
 * `variant: "holdem"` and this grid simply has no cells for anything else.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchStatsBreakdown,
  type BreakdownRow,
  type StatsBreakdown,
  type StatsFilters,
} from "../../lib/db";
import { emptyMoney, rates } from "../../lib/stats";
import { POSITIONS } from "../handFilters";
import { count } from "./format";

const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"] as const;

type Metric = "bb100" | "vpip" | "pfr" | "hands";

const METRICS: Array<{ id: Metric; label: string }> = [
  { id: "bb100", label: "Win rate" },
  { id: "vpip", label: "VPIP" },
  { id: "pfr", label: "PFR" },
  { id: "hands", label: "Dealt" },
];

/** `AKs` for row A / column K above the diagonal; `AKo` below; `AA` on it. */
function classAt(row: number, col: number): string {
  if (row === col) {
    return `${RANKS[row]}${RANKS[col]}`;
  }
  return row < col ? `${RANKS[row]}${RANKS[col]}s` : `${RANKS[col]}${RANKS[row]}o`;
}

/** Combinations per class: the denominator for "how often was I dealt this". */
function combos(handClass: string): number {
  return handClass.length === 2 ? 6 : handClass.endsWith("s") ? 4 : 12;
}

interface CellData {
  hands: number;
  moneyHands: number;
  vpip: number | null;
  pfr: number | null;
  bb100: number | null;
  netBb: number;
  hasMoney: boolean;
}

function cellData(row: BreakdownRow): CellData {
  const r = rates({ counters: row.counters, money: row.money ?? emptyMoney(), moneyHands: row.moneyHands });
  return {
    hands: row.counters.hands,
    moneyHands: row.moneyHands,
    vpip: r.vpip,
    pfr: r.pfr,
    bb100: row.money ? r.bb100 : null,
    netBb: r.netBb,
    hasMoney: row.money !== null,
  };
}

const PCT = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const BB = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});

/**
 * How strongly to tint a cell, 0..1. Win rate is scaled to ±150 bb/100 and
 * then damped by sample — an AA that is +900 bb/100 over four hands is the
 * single most misleading cell on a grid like this, and full saturation would
 * make it the loudest.
 */
function intensity(metric: Metric, cell: CellData | undefined, maxHandsPerCombo: number, handClass: string): number {
  if (!cell || cell.hands === 0) {
    return 0;
  }
  if (metric === "hands") {
    return Math.min(1, cell.hands / combos(handClass) / Math.max(maxHandsPerCombo, 1));
  }
  if (metric === "vpip") {
    return (cell.vpip ?? 0) / 100;
  }
  if (metric === "pfr") {
    return (cell.pfr ?? 0) / 100;
  }
  if (cell.bb100 === null) {
    return 0;
  }
  const confidence = Math.min(1, cell.moneyHands / 30);
  return Math.min(1, Math.abs(cell.bb100) / 150) * (0.25 + 0.75 * confidence);
}

function cellValue(metric: Metric, cell: CellData | undefined): string {
  if (!cell || cell.hands === 0) {
    return "";
  }
  switch (metric) {
    case "hands":
      return count(cell.hands);
    case "vpip":
      return cell.vpip === null ? "" : PCT.format(cell.vpip);
    case "pfr":
      return cell.pfr === null ? "" : PCT.format(cell.pfr);
    default:
      return cell.bb100 === null ? "" : BB.format(cell.bb100 / 100);
  }
}

export function HandMatrix({
  filters,
  refreshToken,
}: {
  filters: StatsFilters;
  refreshToken: number;
}) {
  const [metric, setMetric] = useState<Metric>("bb100");
  const [position, setPosition] = useState<string>("");
  const [data, setData] = useState<StatsBreakdown | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestKey = JSON.stringify({
    ...filters,
    variant: "holdem",
    ...(position ? { positions: [position] } : {}),
  });

  useEffect(() => {
    let live = true;
    fetchStatsBreakdown(JSON.parse(requestKey) as StatsFilters, "hand_class").then(
      (next) => {
        if (live) {
          setData(next);
          setError(null);
        }
      },
      (failure: unknown) => {
        if (live) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [requestKey, refreshToken]);

  const cells = useMemo(() => {
    const map = new Map<string, CellData>();
    for (const row of data?.rows ?? []) {
      if (row.key) {
        map.set(row.key, cellData(row));
      }
    }
    return map;
  }, [data]);

  const maxPerCombo = useMemo(() => {
    let max = 0;
    for (const [handClass, cell] of cells) {
      max = Math.max(max, cell.hands / combos(handClass));
    }
    return max;
  }, [cells]);

  const moneyAvailable = [...cells.values()].some((cell) => cell.hasMoney);
  const activeMetric: Metric = metric === "bb100" && !moneyAvailable ? "vpip" : metric;

  if (data && cells.size === 0 && !position) {
    // No Hold'em in this scope at all (an Omaha-only library): nothing to draw.
    return null;
  }

  const detail = selected ? cells.get(selected) : undefined;

  return (
    <section className="card stats-group">
      <div className="card__head stats-breakdown__head">
        <h3>Starting hands</h3>
        <div className="stats-matrix__controls">
          <div className="stats-scope__formats" role="group" aria-label="Colour by">
            {METRICS.filter((entry) => entry.id !== "bb100" || moneyAvailable).map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`btn btn--sm${entry.id === activeMetric ? " btn--primary" : ""}`}
                aria-pressed={entry.id === activeMetric}
                onClick={() => setMetric(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <label className="field field--narrow">
            <span className="field__label">Position</span>
            <select value={position} onChange={(event) => setPosition(event.target.value)}>
              <option value="">Every seat</option>
              {POSITIONS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error ? <p className="notice notice--error">{error}</p> : null}

      <div
        className={`stats-matrix stats-matrix--${activeMetric}`}
        role="grid"
        aria-label="Starting hands, thirteen by thirteen"
      >
        {RANKS.map((_, row) => (
          <div key={row} role="row" className="stats-matrix__row">
            {RANKS.map((__, col) => {
              const handClass = classAt(row, col);
              const cell = cells.get(handClass);
              const strength = intensity(activeMetric, cell, maxPerCombo, handClass);
              const tone =
                activeMetric === "bb100" && cell?.bb100 !== null && cell?.bb100 !== undefined
                  ? cell.bb100 >= 0
                    ? "up"
                    : "down"
                  : "accent";
              return (
                <button
                  key={col}
                  type="button"
                  role="gridcell"
                  className={`stats-matrix__cell is-${tone}${cell ? "" : " is-empty"}${
                    selected === handClass ? " is-selected" : ""
                  }`}
                  style={{ "--cell-strength": `${Math.round(strength * 85)}%` } as React.CSSProperties}
                  aria-pressed={selected === handClass}
                  aria-label={`${handClass}: ${cell ? `${cell.hands} hands` : "never dealt"}`}
                  onClick={() => setSelected(selected === handClass ? null : handClass)}
                >
                  <span className="stats-matrix__class">{handClass}</span>
                  <span className="stats-matrix__value">{cellValue(activeMetric, cell)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <p className="stats-matrix__detail" aria-live="polite">
        {selected ? (
          detail ? (
            <>
              <strong>{selected}</strong> · {count(detail.hands)} hands
              {detail.vpip !== null ? ` · VPIP ${PCT.format(detail.vpip)}%` : ""}
              {detail.pfr !== null ? ` · PFR ${PCT.format(detail.pfr)}%` : ""}
              {detail.hasMoney && detail.bb100 !== null
                ? ` · ${BB.format(detail.netBb)} bb (${BB.format(detail.bb100)} bb/100)`
                : ""}
            </>
          ) : (
            <>
              <strong>{selected}</strong> · never dealt in this sample
            </>
          )
        ) : (
          <span className="muted">
            {activeMetric === "bb100"
              ? "Win rate per hand, in bb per hand played. Pale cells are thin samples, not small results."
              : activeMetric === "hands"
                ? "How often each hand was dealt, per combination — a flat grid is a fair deck."
                : "How often you played each hand. Select a cell for the numbers."}
          </span>
        )}
      </p>
    </section>
  );
}
