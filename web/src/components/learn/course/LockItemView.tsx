/**
 * One exploit-lab item (Learn L4, the `node-lock` exercise): a river Rail
 * solves in the trainer worker, an opponent tendency locked, and one hand to
 * play against it. The answer is graded by the best response the solver
 * computes against the lock (`gradeLab`); then the lab's numbers — what the
 * read gains, what it risks — and the decisions it changes.
 */

"use client";

import { useEffect, useState } from "react";
import { useDict } from "../../../lib/i18n/client";
import type { CardItem } from "../../../lib/learn/progress";
import { dealLab } from "../../../lib/trainer";
import type { LabItem } from "../../../lib/training";
import { LabNumbers, LabQuestionView, LabSpot, LabViews } from "./LabReport";
import type { ItemAnswer } from "./PracticeItems";
import styles from "./course.module.css";

export type LockCard = Extract<CardItem, { k: "lock" }>;

/** Seeds tried after the item's own; the same on every replay, so a card deals the same item. */
const DEAL_TRIES = 4;

async function deal(card: LockCard): Promise<LabItem | null> {
  for (let attempt = 0; attempt < DEAL_TRIES; attempt += 1) {
    const seed = (card.seed + attempt * 0x9e3779b1) >>> 0;
    const item = await dealLab({ preset: card.preset }, seed);
    if (item) return item;
  }
  return null;
}

export function LockItemView({ card, onAnswer }: { card: LockCard; onAnswer: (answer: ItemAnswer | null) => void }) {
  const c = useDict().course.exercise;
  const [attempt, setAttempt] = useState(0);
  const [dealt, setDealt] = useState<{ item: LabItem | null; error: string | null } | null>(null);
  const [answered, setAnswered] = useState(false);
  const cardKey = JSON.stringify(card);

  useEffect(() => {
    let live = true;
    deal(JSON.parse(cardKey) as LockCard)
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

  return (
    <div className={styles.item}>
      <LabSpot item={item} />
      <LabQuestionView
        item={item}
        onAnswer={(answer) => {
          setAnswered(true);
          onAnswer(answer);
        }}
      />
      {answered ? (
        <>
          <LabNumbers item={item} />
          <LabViews item={item} />
        </>
      ) : null}
    </div>
  );
}
