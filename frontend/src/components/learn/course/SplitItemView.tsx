/**
 * One range split (Learn L2, the `range-split` exercise): the hero's whole
 * range at a flop node of Rail's flop library (or a turn or river solved on
 * demand),
 * sorted by hand class. The learner puts each class where they think it
 * goes — check, a small bet, a big bet; or fold, call, raise — and then sees
 * the solve's own mix per class (`lib/training/split.ts`).
 *
 * A class is right when the solve plays the picked action within
 * `SPLIT_SLACK` of its most played one; the item is right when most classes
 * are (`SPLIT_PASS`).
 */

"use client";

import { useEffect, useId, useState } from "react";
import { useDict } from "../../../lib/i18n/client";
import { useFormats } from "../controls";
import type { CardItem } from "../../../lib/learn/progress";
import { dealSplit } from "../../../lib/trainer";
import { gradeSplit, rightGroups, type SplitGrade, type SplitItem } from "../../../lib/training";
import { CardRow } from "../../replayer/PlayingCard";
import type { ItemAnswer } from "./PracticeItems";
import styles from "./course.module.css";

export type SplitCard = Extract<CardItem, { k: "split" }>;

/** Seeds tried after the item's own; the same on every replay, so a card deals the same split. */
const DEAL_TRIES = 5;

async function deal(card: SplitCard): Promise<SplitItem | null> {
  for (let attempt = 0; attempt < DEAL_TRIES; attempt += 1) {
    const seed = (card.seed + attempt * 0x9e3779b1) >>> 0;
    const item = await dealSplit({ street: card.street, pot: card.pot, seat: card.seat, role: card.role, facing: card.facing, line: card.line, flop: card.flop }, seed);
    if (item) return item;
  }
  return null;
}

export function SplitItemView({ card, onAnswer }: { card: SplitCard; onAnswer: (answer: ItemAnswer | null) => void }) {
  const en = useDict();
  const t = en.course.split;
  const c = en.course.exercise;
  const f = useFormats();
  const id = useId();
  const [attempt, setAttempt] = useState(0);
  const [dealt, setDealt] = useState<{ item: SplitItem | null; error: string | null } | null>(null);
  const [picks, setPicks] = useState<number[]>([]);
  const [graded, setGraded] = useState<SplitGrade | null>(null);
  const cardKey = JSON.stringify(card);

  useEffect(() => {
    let live = true;
    deal(JSON.parse(cardKey) as SplitCard)
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
        {c.solving}
      </p>
    );
  }
  const item = dealt.item;
  if (!item) return <p className="notice notice--warn">{c.noSpot}</p>;

  const label = (key: string): string => {
    if (item.street === "turn") return en.analysis.turn.categories[key] ?? key;
    if (item.street === "river") return en.analysis.river.categories[key] ?? key;
    const [made, draw] = key.split("/");
    const m = t.made[made] ?? made;
    return draw && draw !== "none" ? `${m} + ${t.draws[draw] ?? draw}` : m;
  };
  const groupName = (g: number) => t.groups[item.groups[g]] ?? item.groups[g];
  const mix = (freq: readonly number[]) =>
    freq
      .map((x, g) => ({ x, g }))
      .filter(({ x }) => x >= 0.005)
      .map(({ x, g }) => `${groupName(g)} ${f.pct(x)}`)
      .join(" · ");

  const complete = item.rows.every((_, r) => picks[r] !== undefined && picks[r] >= 0);
  const check = () => {
    if (graded || !complete) return;
    const result = gradeSplit(item, picks);
    setGraded(result);
    onAnswer({ correct: result.passed, grade: result.passed ? (result.correct === result.total ? "perfect" : "good") : "mistake" });
  };

  return (
    <div className={styles.item}>
      <div className={styles.cardsLine}>
        <span className={styles.cardsGroup}>
          <span className={styles.muted}>{en.course.calc.cards.board}</span>
          <CardRow cards={[...item.board]} size="md" />
        </span>
      </div>
      <p>{en.analysis.train.riverSpot(item.pot, item.hero, item.villain, item.seat === "ip")}</p>
      <p>{item.before.length > 0 ? item.before.map((step) => t.step(step.who === "hero" ? t.you : item.villain, step.kind, step.sizePot, step.who === "hero")).join(" ") : t.first(item.street)}</p>
      <p className={styles.muted}>{t.pot(f.bb(item.potBb), item.toCallBb > 0 ? f.bb(item.toCallBb) : null)}</p>
      <p id={`${id}-q`} className={styles.question}>
        {t.question(item.street)}
      </p>
      <div className={styles.splitTable} role="group" aria-labelledby={`${id}-q`}>
        {item.rows.map((row, r) => {
          const right = graded ? rightGroups(row) : [];
          return (
            <div key={row.key} className={styles.splitRow} data-state={graded ? (graded.right[r] ? "right" : "wrong") : undefined}>
              <div className={styles.splitLabel}>
                <span>{label(row.key)}</span>
                <span className={styles.muted}>{t.share(f.pct(row.share))}</span>
              </div>
              <div className={styles.splitChoices}>
                {item.groups.map((group, g) => (
                  <button
                    key={group}
                    type="button"
                    className={`btn btn--sm ${styles.choice}`}
                    aria-pressed={picks[r] === g}
                    data-state={!graded ? (picks[r] === g ? "picked" : undefined) : right.includes(g) ? "right" : picks[r] === g ? "wrong" : undefined}
                    disabled={Boolean(graded)}
                    onClick={() =>
                      setPicks((prev) => {
                        const next = [...prev];
                        next[r] = g;
                        return next;
                      })
                    }
                  >
                    {groupName(g)}
                  </button>
                ))}
              </div>
              {graded ? <p className={styles.splitMix}>{t.railMix(mix(row.freq))}</p> : null}
            </div>
          );
        })}
      </div>
      {!graded ? (
        <div className={styles.nextRow}>
          <button type="button" className="btn btn--primary" onClick={check} disabled={!complete}>
            {t.check}
          </button>
        </div>
      ) : (
        <div className={styles.revealBox} aria-live="polite">
          <p className={graded.passed ? styles.right : styles.wrong}>{t.result(graded.correct, graded.total, graded.passed)}</p>
          <p>{t.overall(mix(item.overall))}</p>
          <p className={styles.muted}>
            {item.source === "library"
              ? t.libraryNote(en.course.spot.lineName(item.lineId), f.num(item.iterations, 0), f.num(item.exploitabilityPct, 2))
              : item.source === "river-solve"
                ? t.riverNote
                : t.turnNote}
          </p>
        </div>
      )}
    </div>
  );
}
