/**
 * One decision as a solver's viewer shows it: the 13×13 grid on the left, the
 * actions and the picked hand on the right (under the grid on a narrow
 * screen). The same view for a preflop chart node and a flop decision of the
 * library: the caller builds the model (`preflopModel`, `flopModel` in
 * `SolverLibrary.tsx`).
 *
 * Each cell is the class's mix drawn as coloured columns, as tall as the
 * share of the class that reaches the decision, with the class's EV in the
 * corner. Accessibility as in the chart browser's grid: one tab stop with
 * arrow keys, every cell a button that reads its mix in words, the detail a
 * polite live region.
 */

"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { SUIT_SYMBOL, type Suit } from "../../lib/cards";
import { useDict } from "../../lib/i18n/client";
import type { ExploreCombo } from "../../lib/solver";
import { GRID_CELLS } from "../analysis/chartSpots";
import analysis from "../analysis/analysis.module.css";
import styles from "./solver.module.css";

export interface ViewAction {
  key: string;
  label: string;
  /** `actionColours`. */
  colour: string;
  share: number;
  combos: number;
  /** Why the action leads nowhere further, if it does not. */
  ends: string | null;
  onPick: () => void;
}

export interface ViewClass {
  /** `in` the range, `faint` (in the tree, never reached), or `absent` (no combo of it here). */
  state: "in" | "faint" | "absent";
  /** How much of the class reaches the decision, 0..1: the height of its columns. */
  fill: number;
  freq: number[];
  ev: number[];
  value: number;
  /** The reach line of the detail. */
  reach: string;
}

export interface StrategyModel {
  /** Changes with the decision: the picked hand resets. */
  id: string;
  actor: string;
  actions: ViewAction[];
  classes: ViewClass[];
  /** A class's combos (flop decisions only), in the picked suits. */
  combos?: (classIndex: number) => ExploreCombo[];
  note: string;
}

/** Below this an action rounds to nothing (it reads `<0.1%`): left out of a cell's spoken mix. */
const SHOWN_FREQ = 0.0005;

/**
 * The colour of each action: bets and raises darken with size, so two sizes
 * never look alike; the largest is the full raise colour.
 */
export function actionColours(actions: ReadonlyArray<{ kind: string; amount: number }>): string[] {
  const aggressive = actions
    .map((action, a) => ({ action, a }))
    .filter(({ action }) => action.kind === "bet" || action.kind === "raise")
    .sort((x, y) => x.action.amount - y.action.amount);
  const shade = new Map(aggressive.map(({ a }, rank) => [a, aggressive.length - 1 - rank]));
  return actions.map((action, a) => {
    switch (action.kind) {
      case "fold":
        return analysis.actFold;
      case "check":
        return analysis.actCheck;
      case "call":
        return analysis.actCall;
      case "allin":
        return analysis.actAllin;
      default:
        return styles[`lighter${Math.min(2, shade.get(a) ?? 0)}`] ?? analysis.actRaise;
    }
  });
}

export function StrategyView({ model, overview }: { model: StrategyModel; overview: ReactNode }) {
  return (
    <div className={styles.strategy}>
      <Grid key={model.id} model={model} overview={overview} />
    </div>
  );
}

function Grid({ model, overview }: { model: StrategyModel; overview: ReactNode }) {
  const t = useDict().solver;
  const [focusIndex, setFocusIndex] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const shown = hovered ?? picked;
  const detail = shown === null ? null : model.classes[shown];
  const combos = useMemo(() => (shown === null || !model.combos ? [] : model.combos(shown)), [model, shown]);
  const labels = model.actions.map((a) => a.label);

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const row = Math.floor(index / 13);
    const col = index % 13;
    const next =
      event.key === "ArrowRight"
        ? row * 13 + Math.min(12, col + 1)
        : event.key === "ArrowLeft"
          ? row * 13 + Math.max(0, col - 1)
          : event.key === "ArrowDown"
            ? Math.min(12, row + 1) * 13 + col
            : event.key === "ArrowUp"
              ? Math.max(0, row - 1) * 13 + col
              : null;
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    setPicked(next);
    buttons.current[next]?.focus();
  };

  return (
    <>
      <div className={styles.gridWrap}>
        <div className={styles.grid} role="grid" aria-label={t.gridLabel(model.actor)}>
          {Array.from({ length: 13 }, (_, row) => (
            <div key={row} role="row" className={styles.gridRow}>
              {GRID_CELLS.slice(row * 13, row * 13 + 13).map((cell, col) => {
                const index = row * 13 + col;
                const data = model.classes[index];
                const name = t.cellLabel(
                  cell.name,
                  data.freq.map((freq, a) => t.part(labels[a], freq)).filter((_, a) => data.freq[a] >= SHOWN_FREQ),
                  data.state === "absent",
                );
                return (
                  <div key={cell.name} role="gridcell" className={styles.gridCellWrap}>
                    <button
                      ref={(element) => {
                        buttons.current[index] = element;
                      }}
                      type="button"
                      tabIndex={index === focusIndex ? 0 : -1}
                      className={`${styles.cell} ${data.state !== "in" ? styles.cellFaint : ""} ${index === shown ? styles.cellShown : ""}`}
                      aria-label={name}
                      aria-pressed={index === picked}
                      onClick={() => {
                        setFocusIndex(index);
                        setPicked(index === picked ? null : index);
                      }}
                      onFocus={() => setFocusIndex(index)}
                      onKeyDown={(event) => move(event, index)}
                      onPointerEnter={() => setHovered(index)}
                      onPointerLeave={() => setHovered((current) => (current === index ? null : current))}
                    >
                      {data.state === "absent" ? null : (
                        <span className={styles.cellFill} aria-hidden="true" style={{ blockSize: `${Math.max(8, data.fill * 100)}%` }}>
                          {data.freq.map((freq, a) =>
                            freq > 0 ? (
                              <span key={a} className={model.actions[a].colour} style={{ inlineSize: `${freq * 100}%` }} />
                            ) : null,
                          )}
                        </span>
                      )}
                      <span className={styles.cellName}>{cell.name}</span>
                      {data.state === "in" ? <span className={styles.cellEv}>{t.evShort(data.value)}</span> : null}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <aside className={styles.panel}>
        <section className={styles.panelBlock}>{overview}</section>

        <section className={styles.panelBlock} aria-label={t.panel.actions}>
          <div className={styles.actionBoxes}>
            {model.actions.map((action) => (
              <button
                key={action.key}
                type="button"
                className={styles.actionBox}
                disabled={action.ends !== null}
                title={action.ends ?? t.panel.follow(action.label)}
                onClick={action.onPick}
              >
                <span className={`${styles.actionBoxHead} ${action.colour}`}>
                  <span className={styles.actionBoxLabel}>{action.label}</span>
                </span>
                <span className={styles.actionBoxBody}>
                  <strong className={styles.actionBoxShare}>{t.shareOnly(action.share)}</strong>
                  <span>{t.combosCount(action.combos)}</span>
                </span>
              </button>
            ))}
          </div>
          <div className={styles.shareBar} aria-hidden="true">
            {model.actions.map((action) => (
              <span key={action.key} className={action.colour} style={{ inlineSize: `${action.share * 100}%` }} />
            ))}
          </div>
        </section>

        <section className={`${styles.panelBlock} ${styles.handBlock}`} aria-live="polite" aria-label={t.panel.hand}>
          {detail ? (
            <>
              <p className={styles.handHead}>
                <strong>{GRID_CELLS[shown!].name}</strong> {detail.state === "absent" ? null : <span>{t.value(detail.value)}</span>}
              </p>
              <p className={analysis.muted}>{detail.state === "absent" ? t.absent : detail.reach}</p>
              {detail.state === "absent" ? null : (
                <ul className={styles.handActions}>
                  {model.actions.map((action, a) => (
                    <li key={action.key}>
                      <span className={`${analysis.swatch} ${action.colour}`} aria-hidden="true" />
                      <span>{action.label}</span>
                      <span className={analysis.num}>{t.freq(detail.freq[a])}</span>
                      <span className={analysis.num}>{t.signedBb(detail.ev[a])}</span>
                    </li>
                  ))}
                </ul>
              )}
              {combos.length > 0 ? (
                <div className={styles.combosWrap}>
                  <table className={styles.combos}>
                    <thead>
                      <tr>
                        <th scope="col">{t.combo}</th>
                        <th scope="col">{t.weight}</th>
                        {labels.map((label) => (
                          <th key={label} scope="col">
                            {label}
                          </th>
                        ))}
                        <th scope="col">{t.ev}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {combos.map((c) => (
                        <tr key={c.cards} className={c.weight === 0 ? styles.comboOut : ""}>
                          <th scope="row">
                            <ComboText cards={c.cards} />
                          </th>
                          <td>{t.freq(c.weight)}</td>
                          {c.freq.map((f, a) => (
                            <td key={a}>{t.freq(f)}</td>
                          ))}
                          <td>{t.signedBb(c.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : (
            <p className={analysis.muted}>{t.detailEmpty}</p>
          )}
          <p className={analysis.muted}>{model.note}</p>
        </section>
      </aside>
    </>
  );
}

/**
 * Two cards as text, `K♠Q♦`: compact enough for a table row, the glyph naming the suit.
 * Four colours like the board's cards: at text size ♦ and ♥ are hard to tell apart in one red.
 */
const SUIT_TEXT_CLASS: Record<Suit, string | undefined> = {
  s: undefined,
  h: styles.comboSuitH,
  d: styles.comboSuitD,
  c: styles.comboSuitC,
};

export function ComboText({ cards }: { cards: string }) {
  return (
    <span className={styles.comboText}>
      {[cards.slice(0, 2), cards.slice(2, 4)].map((card) => {
        const suit = card[1] as Suit;
        return (
          <span key={card} className={SUIT_TEXT_CLASS[suit]}>
            {card[0]}
            {SUIT_SYMBOL[suit]}
          </span>
        );
      })}
    </span>
  );
}
