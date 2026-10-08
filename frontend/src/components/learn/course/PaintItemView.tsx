/**
 * One range paint (Learn L3, the `range-paint` exercise): the learner paints
 * a range on the 13×13 grid — the hands a seat plays first in, from Rail's
 * chart; or, at a river node solved on demand, the hands of their range that
 * bet, or that continue against a bet — and then sees it graded cell by cell
 * (`lib/training/paint.ts`).
 *
 * The tolerance is said on screen: a cell Rail plays at least 75% of the
 * time must be painted, at most 25% must be empty, anything between counts
 * either way; the item is right at 80% of the weight that matters.
 *
 * Accessibility: the grid is one tab stop with arrow-key movement (a roving
 * tabindex, as the chart grid), every cell is a toggle button (`aria-pressed`)
 * named by its hand, and after grading by its verdict and Rail's share. A
 * pointer can paint several cells in one drag. Colour is never alone: a
 * graded cell also carries a mark (✓, + or −).
 */

"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useDict } from "../../../lib/i18n/client";
import type { CardItem } from "../../../lib/learn/progress";
import { HAND_CLASSES } from "../../../lib/solver/handClasses";
import { dealPaint } from "../../../lib/trainer";
import { gradePaint, PAINT_IN, PAINT_OUT, PAINT_PASS, type PaintGrade, type PaintItem, type PaintOptions } from "../../../lib/training";
import { CardRow } from "../../replayer/PlayingCard";
import { useFormats } from "../controls";
import type { ItemAnswer } from "./PracticeItems";
import styles from "./course.module.css";

export type PaintCard = Extract<CardItem, { k: "paint" }>;

/** Seeds tried after the item's own; the same on every replay, so a card deals the same paint. */
const DEAL_TRIES = 5;

function optionsOf(card: PaintCard): PaintOptions {
  if (card.source === "chart") return { source: "chart", set: card.set ?? null, seat: card.seat ?? null };
  return { source: "river", pot: card.pot, seat: card.seat, role: card.role, facing: card.facing };
}

async function deal(card: PaintCard): Promise<PaintItem | null> {
  for (let attempt = 0; attempt < DEAL_TRIES; attempt += 1) {
    const seed = (card.seed + attempt * 0x9e3779b1) >>> 0;
    const item = await dealPaint(optionsOf(card), seed);
    if (item) return item;
  }
  return null;
}

const MARK: Record<string, string> = { right: "✓", missed: "−", extra: "+" };

export function PaintItemView({ card, onAnswer }: { card: PaintCard; onAnswer: (answer: ItemAnswer | null) => void }) {
  const dict = useDict();
  const t = dict.course.paint;
  const c = dict.course.exercise;
  const f = useFormats();
  const id = useId();
  const [attempt, setAttempt] = useState(0);
  const [dealt, setDealt] = useState<{ item: PaintItem | null; error: string | null } | null>(null);
  const [painted, setPainted] = useState<boolean[]>(() => new Array(169).fill(false));
  const [graded, setGraded] = useState<PaintGrade | null>(null);
  const [focus, setFocus] = useState(0);
  const drag = useRef<boolean | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const cardKey = JSON.stringify(card);

  useEffect(() => {
    let live = true;
    deal(JSON.parse(cardKey) as PaintCard)
      .then((item) => {
        if (live) setDealt({ item, error: null });
      })
      .catch((error: unknown) => {
        if (live) setDealt({ item: null, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [cardKey, attempt]);

  useEffect(() => {
    const stop = () => {
      drag.current = null;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  if (dealt?.error) {
    return (
      <div className="notice notice--error">
        <p>{c.failed(dealt.error)}</p>
        <button type="button" className="btn btn--sm" onClick={() => setAttempt((value) => value + 1)}>
          {c.retry}
        </button>
      </div>
    );
  }
  if (!dealt) {
    return (
      <p className={styles.muted} role="status">
        {card.source === "river" ? c.solving : c.generating}
      </p>
    );
  }
  const item = dealt.item;
  if (!item) return <p className="notice notice--warn">{c.noSpot}</p>;

  const set = (k: number, value: boolean) =>
    setPainted((prev) => {
      if (prev[k] === value) return prev;
      const next = [...prev];
      next[k] = value;
      return next;
    });

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, k: number) => {
    if (graded || !item.cells[k] || event.button !== 0) return;
    event.preventDefault();
    // A touch captures the pointer to the first cell; release it so the drag reaches the others.
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const value = !painted[k];
    drag.current = value;
    set(k, value);
    setFocus(k);
    // Cancelling the pointer's default also cancels the focus a click gives: give it back, so the keys work from here.
    event.currentTarget.focus({ preventScroll: true });
  };
  /** A drag paints every cell under the pointer, read from the point itself (fast moves skip enter events). */
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (graded || drag.current === null) return;
    const under = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-k]");
    const k = under ? Number(under.dataset.k) : -1;
    if (k >= 0 && item.cells[k]) set(k, drag.current);
  };
  const move = (event: KeyboardEvent<HTMLButtonElement>, k: number) => {
    const row = Math.floor(k / 13);
    const col = k % 13;
    let next = k;
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
    setFocus(next);
    buttons.current[next]?.focus();
  };

  const check = () => {
    if (graded) return;
    const result = gradePaint(item.cells, painted);
    setGraded(result);
    onAnswer({ correct: result.passed, grade: result.passed ? (result.missed + result.extra === 0 ? "perfect" : "good") : "mistake" });
  };

  const facing = item.facing;
  const villain = item.villain ?? "";
  const question = item.source === "chart" ? t.questionOpen(item.hero) : item.ask === "continue" ? t.questionContinue : t.questionBet;

  return (
    <div className={styles.item}>
      {item.source === "river" ? (
        <>
          <div className={styles.cardsLine}>
            <span className={styles.cardsGroup}>
              <span className={styles.muted}>{dict.course.calc.cards.board}</span>
              <CardRow cards={[...item.board]} size="md" />
            </span>
          </div>
          <p>{dict.analysis.train.riverSpot(item.pot ?? "srp", item.hero, villain, item.seat === "ip")}</p>
          <p>
            {facing ? dict.course.split.step(villain, facing.kind, facing.sizePot) : dict.course.split.first("river")}
          </p>
          {item.potBb !== null ? <p className={styles.muted}>{dict.course.split.pot(f.bb(item.potBb), null)}</p> : null}
        </>
      ) : null}
      <p id={`${id}-q`} className={styles.question}>
        {question}
      </p>
      <p className={styles.muted}>{t.how(f.pct(PAINT_IN), f.pct(PAINT_OUT), f.pct(PAINT_PASS))}</p>
      <div className={styles.paintGrid} role="grid" aria-labelledby={`${id}-q`} onPointerMove={onPointerMove}>
        {Array.from({ length: 13 }, (_, row) => (
          <div key={row} role="row" className={styles.paintRow}>
            {Array.from({ length: 13 }, (_, col) => {
              const k = row * 13 + col;
              const cell = item.cells[k];
              const name = HAND_CLASSES[k].name;
              const state = graded ? graded.cells[k] : null;
              const label = !cell
                ? t.notInRange(name)
                : graded
                  ? t.cellGraded(name, painted[k], f.pct(cell.f), state)
                  : t.cell(name, painted[k]);
              return (
                <div key={k} role="gridcell" className={styles.paintSlot}>
                  <button
                    ref={(el) => {
                      buttons.current[k] = el;
                    }}
                    type="button"
                    className={styles.paintCell}
                    data-on={painted[k] || undefined}
                    data-empty={!cell || undefined}
                    data-state={state ?? undefined}
                    aria-pressed={cell ? painted[k] : undefined}
                    aria-label={label}
                    title={graded && cell ? t.railShare(name, f.pct(cell.f)) : name}
                    disabled={!cell}
                    tabIndex={k === focus ? 0 : -1}
                    data-k={k}
                    onPointerDown={(event) => onPointerDown(event, k)}
                    // Space, Enter and assistive technology click without a pointer (detail 0); a pointer paints on pointerdown.
                    onClick={(event) => {
                      if (event.detail === 0 && !graded && cell) set(k, !painted[k]);
                    }}
                    onKeyDown={(event) => move(event, k)}
                    onFocus={() => setFocus(k)}
                  >
                    <span>{name}</span>
                    {state ? <span aria-hidden="true" className={styles.paintMark}>{MARK[state]}</span> : null}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {!graded ? (
        <div className={styles.nextRow}>
          <button type="button" className="btn btn--sm" onClick={() => setPainted(new Array(169).fill(false))}>
            {t.clear}
          </button>
          <button type="button" className="btn btn--primary" onClick={check}>
            {t.check}
          </button>
        </div>
      ) : (
        <div className={styles.revealBox} aria-live="polite">
          <p className={graded.passed ? styles.right : styles.wrong}>{t.result(f.pct(graded.score), graded.passed)}</p>
          <p>{t.counts(graded.missed, graded.extra)}</p>
          <p className={styles.muted}>{t.legend}</p>
          <p className={styles.muted}>
            {item.source === "chart"
              ? t.chartNote(dict.analysis.charts.setOption(Number(item.set.match(/(\d+)max/)?.[1] ?? 6), Number(item.set.match(/(\d+)bb/)?.[1] ?? 100)))
              : t.riverNote(f.num(item.iterations ?? 0, 0), f.num(item.exploitabilityPct ?? 0, 2))}
          </p>
        </div>
      )}
    </div>
  );
}
