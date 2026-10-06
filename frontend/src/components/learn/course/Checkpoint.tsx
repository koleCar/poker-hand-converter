/**
 * A lesson's "predict, then reveal" question: the reader commits to an
 * answer, then sees whether it was right, why, and — when the question has
 * one — Rail's calculator opened on the question's numbers. Retrieval before
 * explanation; nothing is recorded (checkpoints teach, exercises grade).
 *
 * The words come from the server as props: only this lesson's text reaches
 * the client.
 */

"use client";

import { useId, useState } from "react";
import type { WidgetPreset } from "../../../lib/learn/concepts";
import { useDict } from "../../../lib/i18n/client";
import { ConceptWidget } from "../ConceptWidget";
import styles from "./course.module.css";

interface CheckpointProps {
  question: string;
  options: readonly string[];
  answer: number;
  explain: string;
  reveal?: WidgetPreset;
}

export function Checkpoint({ question, options, answer, explain, reveal }: CheckpointProps) {
  const t = useDict().course.checkpoint;
  const [picked, setPicked] = useState<number | null>(null);
  const id = useId();
  const answered = picked !== null;
  const right = picked === answer;
  return (
    <aside className={styles.checkpoint} aria-labelledby={`${id}-q`}>
      <p className={styles.checkpointLabel}>{t.label}</p>
      <p id={`${id}-q`} className={styles.checkpointQuestion}>
        {question}
      </p>
      <div className={styles.choices} role="group" aria-label={t.hint}>
        {options.map((option, index) => (
          <button
            key={option}
            type="button"
            className={`btn btn--sm ${styles.choice}`}
            data-state={!answered ? undefined : index === answer ? "right" : index === picked ? "wrong" : undefined}
            aria-pressed={picked === index}
            disabled={answered}
            onClick={() => setPicked(index)}
          >
            {option}
          </button>
        ))}
      </div>
      {answered ? (
        <div className={styles.checkpointAnswer} aria-live="polite">
          <p className={right ? styles.right : styles.wrong}>{right ? t.right : t.wrong(options[answer])}</p>
          <p>{explain}</p>
          {reveal ? (
            <div className={styles.reveal}>
              <p className={styles.muted}>{t.reveal}</p>
              <ConceptWidget preset={reveal} />
            </div>
          ) : null}
        </div>
      ) : (
        <p className={styles.muted}>{t.hint}</p>
      )}
    </aside>
  );
}
