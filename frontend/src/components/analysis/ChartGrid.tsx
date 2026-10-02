/**
 * One chart node as the 13×13 grid (`docs/ANALYSIS-PLAN.md` §6.1 *Study*):
 * every hand class with the reference's action mix as stacked bars, the
 * action totals over the whole range, and — for the hand under the pointer
 * or the keyboard focus — each action's frequency and EV.
 *
 * Used twice: in the Analysis sheet, on the node a preflop decision was
 * graded at (the hero's class outlined), and in the chart browser.
 *
 * Accessibility: the grid is one tab stop with arrow-key movement (a roving
 * tabindex), every cell is a button whose name reads the whole mix in words,
 * and the detail panel is a polite live region. Colour is never alone: the
 * legend and the detail name every action.
 */

"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ChartNode } from "../../lib/charts";
import { useDict } from "../../lib/i18n/client";
import styles from "./analysis.module.css";
import { GRID_CELLS, OFF_RANGE_WEIGHT, actionTotals, cellData, lineSteps } from "./chartSpots";

const ACTION_CLASS: Record<string, string> = {
  fold: styles.actFold,
  check: styles.actCheck,
  call: styles.actCall,
  raise: styles.actRaise,
  allin: styles.actAllin,
};

interface ChartGridProps {
  node: ChartNode;
  /** A class to outline and open the detail on: the hero's hand. */
  highlight?: string | null;
  /** Optional heading level for the grid's title. */
  title?: string;
}

export function ChartGrid({ node, highlight = null, title }: ChartGridProps) {
  const t = useDict().analysis.charts;
  const startIndex = Math.max(0, GRID_CELLS.findIndex((cell) => cell.name === highlight));
  const [focusIndex, setFocusIndex] = useState(startIndex);
  const [hovered, setHovered] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const labels = node.options.map((option) => t.action(option.action, option.toBb));
  const totals = useMemo(() => actionTotals(node), [node]);
  const spot = t.spotLabel(
    node.actor,
    lineSteps(node.line).map((step) => ({ position: step.position, verb: t.verbs[step.verb] ?? step.verb })),
  );
  const shown = hovered ?? picked ?? highlight;
  const detail = shown ? cellData(node, shown) : null;

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const row = Math.floor(index / 13);
    const col = index % 13;
    let next = index;
    switch (event.key) {
      case "ArrowRight":
        next = row * 13 + Math.min(12, col + 1);
        break;
      case "ArrowLeft":
        next = row * 13 + Math.max(0, col - 1);
        break;
      case "ArrowDown":
        next = Math.min(12, row + 1) * 13 + col;
        break;
      case "ArrowUp":
        next = Math.max(0, row - 1) * 13 + col;
        break;
      case "Home":
        next = row * 13;
        break;
      case "End":
        next = row * 13 + 12;
        break;
      default:
        return;
    }
    event.preventDefault();
    setFocusIndex(next);
    setPicked(GRID_CELLS[next].name);
    buttons.current[next]?.focus();
  };

  return (
    <div className={styles.chart}>
      <div className={styles.chartHead}>
        {title ? <h3 className={styles.chartTitle}>{title}</h3> : null}
        <p className={styles.chartSpot}>{spot}</p>
        <p className={styles.muted}>
          {t.pot(node.potBb, node.scenario === "rfi" ? 0 : Math.max(0, node.toMatchBb - node.inBb))}
        </p>
      </div>

      <ul className={styles.chartLegend} aria-label={t.legend}>
        {node.options.map((option, a) => (
          <li key={option.code}>
            <span className={`${styles.swatch} ${ACTION_CLASS[option.action] ?? ""}`} aria-hidden="true" />
            {t.total(labels[a], totals[a].share, totals[a].combos)}
          </li>
        ))}
      </ul>

      <div className={styles.chartBody}>
        <div className={styles.grid} role="grid" aria-label={t.gridLabel(spot)}>
          {Array.from({ length: 13 }, (_, row) => (
            <div key={row} role="row" className={styles.gridRow}>
              {GRID_CELLS.slice(row * 13, row * 13 + 13).map((cell, col) => {
                const index = row * 13 + col;
                const data = cellData(node, cell.name);
                const offRange = data.range < OFF_RANGE_WEIGHT;
                const name = t.cellLabel(
                  cell.name,
                  data.freq.map((freq, a) => t.part(labels[a], freq)).filter((_, a) => data.freq[a] > 0),
                  offRange,
                );
                return (
                  <div key={cell.name} role="gridcell" className={styles.gridCellWrap}>
                    <button
                      ref={(element) => {
                        buttons.current[index] = element;
                      }}
                      type="button"
                      tabIndex={index === focusIndex ? 0 : -1}
                      className={`${styles.gridCell}${offRange ? ` ${styles.offRange}` : ""}${
                        cell.name === highlight ? ` ${styles.heroCell}` : ""
                      }${cell.name === shown ? ` ${styles.shownCell}` : ""}`}
                      aria-label={name}
                      aria-pressed={cell.name === picked}
                      onClick={() => {
                        setFocusIndex(index);
                        setPicked(cell.name === picked ? null : cell.name);
                      }}
                      onFocus={() => setFocusIndex(index)}
                      onKeyDown={(event) => move(event, index)}
                      onPointerEnter={() => setHovered(cell.name)}
                      onPointerLeave={() => setHovered((current) => (current === cell.name ? null : current))}
                    >
                      <span className={styles.cellName}>{cell.name}</span>
                      <span className={styles.cellBar} aria-hidden="true">
                        {data.freq.map((freq, a) =>
                          freq > 0 ? (
                            <span
                              key={a}
                              className={ACTION_CLASS[node.options[a].action] ?? ""}
                              style={{ inlineSize: `${freq * 100}%` }}
                            />
                          ) : null,
                        )}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className={styles.chartDetail} aria-live="polite">
          {detail ? (
            <>
              <p className={styles.chartDetailHead}>
                <strong>{detail.name}</strong>
                {detail.name === highlight ? <span className={styles.tag}>{t.yourHand}</span> : null}
              </p>
              <p className={styles.muted}>{detail.range < OFF_RANGE_WEIGHT ? t.offRange : t.reaches(detail.range)}</p>
              <ul className={styles.detailList}>
                {node.options.map((option, a) => (
                  <li key={option.code}>
                    <span className={`${styles.swatch} ${ACTION_CLASS[option.action] ?? ""}`} aria-hidden="true" />
                    <span>{labels[a]}</span>
                    <span className={styles.num}>{t.freq(detail.freq[a])}</span>
                    <span className={styles.num}>{t.signedBb(detail.ev[a])}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className={styles.muted}>{t.detailEmpty}</p>
          )}
          <p className={styles.muted}>{t.evNote}</p>
        </div>
      </div>
    </div>
  );
}
