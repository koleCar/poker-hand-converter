/**
 * The session's score beside the trainer — answers, score, how often the
 * answer was a move the reference plays, streaks, EV lost, and the answers by
 * class (Perfect…Blunder, glyph and word, never colour alone) — and, signed
 * in, the last 30 days of kept answers per trainer.
 */

"use client";

import { useEffect, useState } from "react";
import { GRADES } from "../../../lib/analysis/types";
import { fetchTrainerSummary, type TrainerModeSummary } from "../../../lib/db/training";
import { useDict } from "../../../lib/i18n/client";
import { sessionAccuracy, sessionScore, type SessionStats } from "../../../lib/training";
import { GradeIcon } from "../GradeIcon";
import styles from "../analysis.module.css";
import own from "./train.module.css";

const HISTORY_DAYS = 30;

export function SessionPanel({ stats, onReset }: { stats: SessionStats; onReset: () => void }) {
  const en = useDict().analysis;
  const t = en.train.session;
  const score = sessionScore(stats);
  const accuracy = sessionAccuracy(stats);
  return (
    <section className={`card ${own.session}`} aria-labelledby="train-session">
      <div className={own.sessionHead}>
        <h3 id="train-session" className={own.spotHead}>
          {t.heading}
        </h3>
        <span className={own.muted}>{t.answers(stats.answers)}</span>
        {stats.answers > 0 ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onReset}>
            {t.reset}
          </button>
        ) : null}
      </div>
      {stats.answers === 0 ? (
        <p className={own.muted}>{t.none}</p>
      ) : (
        <>
          <dl className={own.counts}>
            <div>
              <dt>{t.score}</dt>
              <dd>{score === null ? "—" : Math.round(score)}</dd>
            </div>
            <div>
              <dt>{t.accuracy}</dt>
              <dd>{accuracy === null ? "—" : t.pct(accuracy)}</dd>
            </div>
            <div>
              <dt>{t.streak}</dt>
              <dd>{stats.streak}</dd>
            </div>
            <div>
              <dt>{t.best}</dt>
              <dd>{stats.bestStreak}</dd>
            </div>
            <div>
              <dt>{t.evLost}</dt>
              <dd>{t.bb(stats.evLoss)}</dd>
            </div>
          </dl>
          <ul className={own.classes} aria-label={t.distribution}>
            {GRADES.map((grade) => (
              <li key={grade} className={`${own.classItem} ${styles[grade] ?? ""}`}>
                <GradeIcon grade={grade} />
                <span className={own.className}>{en.grades[grade]}</span>
                <strong>{stats.counts[grade]}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The kept answers per trainer, over the last 30 days. */
export function TrainerHistory({ refresh }: { refresh: number }) {
  const t = useDict().analysis.train.history;
  const [rows, setRows] = useState<TrainerModeSummary[] | null>(null);

  useEffect(() => {
    let live = true;
    fetchTrainerSummary(HISTORY_DAYS)
      .then((value) => {
        if (live) setRows(value);
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [refresh]);

  if (rows === null) return null;
  return (
    <section className={`card ${own.session}`} aria-labelledby="train-history">
      <h3 id="train-history" className={own.spotHead}>
        {t.heading(HISTORY_DAYS)}
      </h3>
      {rows.filter((row) => row.recent > 0).length === 0 ? (
        <p className={own.muted}>{t.none}</p>
      ) : (
        <ul className={own.history}>
          {rows
            .filter((row) => row.recent > 0)
            .map((row) => (
              <li key={row.mode}>
                <strong>{t.modes[row.mode] ?? row.mode}</strong>
                <span>{t.row(row.recent, row.recent > 0 ? row.scoreSum / row.recent : null, row.evLossBb)}</span>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
