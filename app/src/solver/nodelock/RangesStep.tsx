/**
 * The nodelock editor's Ranges step (`docs/NODELOCK.md` §9.4): which ranges
 * the spot is about, and a range lock when the user changes them. Drawn in
 * the editor's dialog, in its look; the state is `editor/ranges.ts`'s.
 *
 * ```
 * ┌ ⓘ BTN Raise 2.5 · BB Call  A♠6♥3♦ ··············· ↶ ↷ Reset to GTO × ┐
 * │ [BTN 45.2% | BB 31.0% ●]                 │ Weight [=====|   ] 100       │
 * │ 13×13: a cell's fill is its weight,      │ Pairs Suited Offsuit …       │
 * │ GTO's a tick, a changed cell an edge     │ [5] Widen Tighten            │
 * │ (click / drag paints)                    │ text  [Apply] [Copy]         │
 * ├ BB Call 38% (GTO 31%) · +88 −12 combos ·······  Solve these ranges [Lock BB] ┤
 * ```
 *
 * This does not solve preflop again: it fixes the ranges that reach the
 * flop, and the flop is solved from them (the header's ⓘ says so).
 */
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { Icon } from "@rail/ui/icon/Icon";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useT } from "../../i18n";
import {
  canonicalRange,
  classScores,
  classSet,
  classWeights,
  CLASS_SETS,
  formatRange,
  HAND_CLASSES,
  IconButton,
  lineActs,
  loadChartSet,
  paintClasses,
  parseRangeText,
  rangeDiff,
  Segmented,
  scaleEquityTable,
  scaleRange,
  solverStyles,
  ToolButton,
  type SolverDict,
} from "../door";
import styles from "./Editor.module.css";
import { rangeChanged, type RangeEdit, type RangeEditAction } from "./editor/ranges";
import rangeStyles from "./RangesStep.module.css";
import { Dismissible } from "@rail/ui/notice/Dismissible";

type Pair<T> = [T, T];

/** Undo (back) and Redo: a curved arrow, as the node editor's. */
function TurnGlyph({ back }: { back: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={solverStyles.glyph}>
      <path d={back ? "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" : "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3"} />
    </svg>
  );
}

/** The preflop line in words, folds left out (`BTN Raise 2.5 · BB Call`), and each player's last act; null until the charts are read. */
export function usePreflopLine(set: string, lineKey: string, players: Pair<string>, solverT: SolverDict): { line: string; acts: Pair<string | null> } | null {
  const [value, setValue] = useState<{ key: string; line: string; acts: Pair<string | null> } | null>(null);
  const key = `${set}|${lineKey}`;
  useEffect(() => {
    let live = true;
    void loadChartSet(set)
      .then((charts) => {
        if (!live) return;
        const acts = lineActs(charts, lineKey).filter((act) => act.type !== "fold");
        const word = (act: (typeof acts)[number]) => solverT.preflop.action(act.type, act.to ?? 0);
        const last = players.map((position) => {
          const own = acts.filter((act) => act.position === position);
          return own.length ? word(own[own.length - 1]) : null;
        }) as Pair<string | null>;
        setValue({ key, line: acts.map((act) => `${act.position} ${word(act)}`).join(" · "), acts: last });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key, set, lineKey, players, solverT]);
  return value?.key === key ? value : null;
}

export interface RangesStepProps {
  edit: RangeEdit;
  dispatch: (action: RangeEditAction) => void;
  /** The flop as card indices in the chunk's suits (the ranges' combos), and as shown. */
  board: readonly number[];
  shownBoard: readonly string[];
  /** Out of position first. */
  players: Pair<string>;
  /** Who acts at the decision being locked: the step's Next locks them. */
  actor: 0 | 1;
  preflop: { line: string; acts: Pair<string | null> } | null;
  /** The footer's message (an error), or the engine's line. */
  message: string | null;
  busy: boolean;
  /** The ranges differ from the ones the view's flop was solved from: Solve these ranges is offered. */
  canSolve: boolean;
  onNext: () => void;
  /** Solve the ranges alone (a ranges-only lock, §9.1); shown once a range changed. */
  onSolveRanges: () => void;
  onClose: () => void;
}

export function RangesStep({ edit, dispatch, board, shownBoard, players, actor, preflop, message, busy, canSolve, onNext, onSolveRanges, onClose }: RangesStepProps) {
  const t = useT().nodelock;
  const r = t.ranges;
  const [player, setPlayer] = useState<0 | 1>(actor);
  const [weight, setWeight] = useState(100);
  const [scaleBy, setScaleBy] = useState("5");
  const [scaling, setScaling] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const painting = useRef(false);

  useEffect(() => {
    const stop = () => {
      painting.current = false;
    };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);

  const changed: Pair<boolean> = [rangeChanged(edit, 0, board), rangeChanged(edit, 1, board)];
  const diffs = useMemo(
    () => [0, 1].map((p) => rangeDiff(edit.gto[p], edit.ranges[p], board)) as Pair<ReturnType<typeof rangeDiff>>,
    [edit, board],
  );
  const cells = useMemo(() => {
    const now = classWeights(edit.ranges[player], board);
    const gto = classWeights(edit.gto[player], board);
    return HAND_CLASSES.map((c, k) => ({ name: c.name, k, weight: now.weight[k], gto: gto.weight[k], live: now.live[k] }));
  }, [edit, player, board]);
  const shownText = text ?? formatRange(edit.ranges[player], board);

  const paint = (classes: readonly number[], merge: boolean) => {
    dispatch({ type: "set", player, weights: paintClasses(edit.ranges[player], classes, weight / 100, board), merge });
  };
  const scale = (sign: 1 | -1) => {
    const pp = Number(scaleBy);
    if (!(pp > 0)) return;
    setScaling(true);
    // The equity table is worked out once (~1 s): after a paint, so the button shows it is busy.
    setTimeout(() => {
      try {
        const score = classScores(edit.ranges[player === 0 ? 1 : 0], scaleEquityTable());
        dispatch({ type: "set", player, weights: scaleRange(edit.ranges[player], (sign * pp) / 100, score, board) });
      } finally {
        setScaling(false);
      }
    }, 16);
  };
  const applyText = () => {
    try {
      // The board's combos are out of a lock: `canonicalRange` makes them 0.
      dispatch({ type: "set", player, weights: Float64Array.from(canonicalRange(parseRangeText(shownText), board)) });
      setText(null);
      setTextError(null);
    } catch (error) {
      setTextError(r.textError(error instanceof Error ? error.message : String(error)));
    }
  };
  const copy = () => {
    void navigator.clipboard?.writeText(formatRange(edit.ranges[player], board)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const summaryOf = (p: 0 | 1) => r.summary(players[p], preflop?.acts[p] ?? "", diffs[p].edited.share, diffs[p].gto.share).replace("  ", " ");
  const shownSummary = ([0, 1] as const).filter((p) => changed[p] || p === player);

  return (
    <>
      <header className={styles.head}>
        <span className={rangeStyles.scope} title={r.scope} aria-label={r.scope}>
          <Icon name="info" />
        </span>
        <strong className={rangeStyles.line}>{preflop?.line ?? players.join(" · ")}</strong>
        <CardRow cards={[...shownBoard.slice(0, 3)]} size="xs" />
        <span className={solverStyles.spacer} />
        <IconButton size="sm" label={t.undo} disabled={!edit.past.length} onClick={() => dispatch({ type: "undo" })}>
          <TurnGlyph back />
        </IconButton>
        <IconButton size="sm" label={t.redo} disabled={!edit.future.length} onClick={() => dispatch({ type: "redo" })}>
          <TurnGlyph back={false} />
        </IconButton>
        <ToolButton size="sm" disabled={!changed[player]} onClick={() => dispatch({ type: "reset", player })}>
          {r.reset}
        </ToolButton>
        <IconButton size="sm" label={t.close} onClick={onClose}>
          <Icon name="close" />
        </IconButton>
      </header>

      <div className={styles.body}>
        <section className={styles.main}>
          <div className={solverStyles.tools}>
            <Segmented
              size="sm"
              label={r.playersLabel}
              value={String(player)}
              options={([0, 1] as const).map((p) => ({
                value: String(p),
                label: (
                  <span className={rangeStyles.tab}>
                    {r.tab(players[p], diffs[p].edited.share)}
                    {changed[p] ? <span className={rangeStyles.dot} title={r.changed} aria-label={r.changed} /> : null}
                  </span>
                ),
              }))}
              onChange={(value) => {
                setPlayer(Number(value) as 0 | 1);
                setText(null);
                setTextError(null);
              }}
            />
            <span className={rangeStyles.combos}>{r.combos(diffs[player].edited.combos)}</span>
          </div>
          <div
            className={`${solverStyles.grid} ${styles.grid}`}
            role="grid"
            aria-label={r.gridLabel(players[player])}
            onPointerLeave={() => (painting.current = false)}
          >
            {Array.from({ length: 13 }, (_, row) => (
              <div key={row} role="row" className={solverStyles.gridRow}>
                {cells.slice(row * 13, row * 13 + 13).map((c) => {
                  const differs = Math.abs(c.weight - c.gto) > 5e-5;
                  return (
                    <div key={c.name} role="gridcell" className={`${solverStyles.gridCellWrap} ${styles.cellWrap}`}>
                      <button
                        type="button"
                        className={[solverStyles.cell, styles.cell, c.live ? "" : solverStyles.cellFaint, differs ? rangeStyles.changed : ""].filter(Boolean).join(" ")}
                        style={{ "--w": c.weight, "--g": c.gto } as CSSProperties}
                        aria-label={r.cell(c.name, c.weight, c.gto)}
                        title={r.cell(c.name, c.weight, c.gto)}
                        disabled={!c.live}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          painting.current = true;
                          paint([c.k], false);
                        }}
                        onPointerEnter={() => {
                          if (painting.current) paint([c.k], true);
                        }}
                        onClick={(event) => {
                          // A paint happened on pointer down; a keyboard click paints here.
                          if (event.detail === 0) paint([c.k], false);
                        }}
                      >
                        {c.weight > 0 ? <span className={rangeStyles.fill} aria-hidden="true" /> : null}
                        {c.gto > 0 ? <span className={rangeStyles.gto} aria-hidden="true" /> : null}
                        <span className={solverStyles.cellName}>{c.name}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </section>

        <aside className={`${solverStyles.panel} ${styles.panel} ${rangeStyles.panel}`}>
          <div className={styles.slider}>
            <div className={styles.sliderHead}>
              <span className={styles.sliderName}>{r.weight}</span>
              <input
                className={styles.number}
                type="number"
                min={0}
                max={100}
                step={1}
                value={weight}
                aria-label={r.weightLabel}
                onChange={(event) => setWeight(Math.min(100, Math.max(0, Math.round(Number(event.target.value) || 0))))}
              />
            </div>
            <span className={styles.range} style={{ "--v": weight / 100, "--g": 0 } as CSSProperties}>
              <span className={`${styles.rangeFill} ${rangeStyles.weightFill}`} aria-hidden="true" />
              <input type="range" min={0} max={100} step={1} value={weight} aria-label={r.weightLabel} onChange={(event) => setWeight(Number(event.target.value))} />
            </span>
          </div>
          <div className={styles.chips}>
            {CLASS_SETS.map((set) => (
              <button key={set} type="button" className={styles.chip} title={r.setTitle(r.sets[set])} onClick={() => paint(classSet(set), false)}>
                {r.sets[set]}
              </button>
            ))}
          </div>
          <p className={styles.hint}>{r.paintHint}</p>

          <div className={rangeStyles.scale} title={r.scaleTitle}>
            <input
              className={styles.number}
              type="number"
              min={0.5}
              max={50}
              step={0.5}
              value={scaleBy}
              aria-label={r.scaleLabel}
              onChange={(event) => setScaleBy(event.target.value)}
            />
            <span className={styles.sizesUnit}>%</span>
            <ToolButton size="sm" disabled={scaling || !(Number(scaleBy) > 0)} onClick={() => scale(1)}>
              {r.widen}
            </ToolButton>
            <ToolButton size="sm" disabled={scaling || !(Number(scaleBy) > 0)} onClick={() => scale(-1)}>
              {r.tighten}
            </ToolButton>
          </div>
          {scaling ? <p className={styles.hint}>{r.scaleBusy}</p> : null}

          <textarea
            className={rangeStyles.text}
            value={shownText}
            placeholder={r.textPlaceholder}
            aria-label={r.textLabel(players[player])}
            spellCheck={false}
            rows={4}
            onChange={(event) => {
              setText(event.target.value);
              setTextError(null);
            }}
          />
          <div className={rangeStyles.textTools}>
            <ToolButton size="sm" disabled={text === null} onClick={applyText}>
              {r.apply}
            </ToolButton>
            <ToolButton size="sm" onClick={copy}>
              {copied ? r.copied : r.copy}
            </ToolButton>
          </div>
          {textError ? (
            <Dismissible className={styles.message} role="alert">
              {textError}
            </Dismissible>
          ) : null}
        </aside>
      </div>

      <footer className={styles.foot}>
        <div className={styles.footText}>
          {shownSummary.map((p) => (
            <p key={p} className={rangeStyles.summary}>
              <strong>{summaryOf(p)}</strong>
              {changed[p] ? <span>{` · ${r.diff(diffs[p].added, diffs[p].removed)}`}</span> : null}
            </p>
          ))}
          {message ? (
            <Dismissible className={styles.message} role="alert">
              {message}
            </Dismissible>
          ) : null}
        </div>
        {canSolve ? (
          <ToolButton disabled={busy} title={`${r.solveRangesTitle}. ${r.scope}`} onClick={onSolveRanges}>
            {r.solveRanges}
          </ToolButton>
        ) : null}
        <ToolButton tone="primary" title={r.nextTitle(players[actor])} onClick={onNext}>
          {r.next(players[actor])}
        </ToolButton>
      </footer>
    </>
  );
}
