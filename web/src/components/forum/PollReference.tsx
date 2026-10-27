"use client";

/**
 * A poll's reference answer (A7.1): how the reference plays the polled
 * decision, beside how readers voted.
 *
 * Shown only after the reveal, and only when the hand's author shared its
 * analysis — both decided by the database (`read_shared_analysis` returns
 * nothing to a reader who has not voted). Each answer's line in the results
 * comes from `pollReference`; below them, the reference's whole options
 * table at the decision, with the grade's source and approximations, as the
 * Analysis sheet shows them.
 */

import type { DecisionAnalysis, Grade } from "../../lib/analysis/types";
import type { PollOptionReference } from "../../lib/forum/pollReference";
import { useDict } from "../../lib/i18n/client";
import { GradeIcon } from "../analysis/GradeIcon";
import { OptionsTable } from "../analysis/AnalysisSheet";
import a from "../analysis/analysis.module.css";
import styles from "./forum.module.css";

/** The grade word with its icon, coloured like the Analysis sheet's. */
export function GradeWord({ grade }: { grade: Grade }) {
  const t = useDict().analysis;
  return (
    <span className={`${a.gradeTag} ${a[grade]}`}>
      <GradeIcon grade={grade} />
      {t.grades[grade]}
    </span>
  );
}

/** One answer's line under its vote bar: the reference's frequency and EV for it, and its grade. */
export function PollOptionLine({
  decision,
  reference,
}: {
  decision: DecisionAnalysis;
  reference: PollOptionReference | null | undefined;
}) {
  const t = useDict().analysis;
  const s = t.sheet;
  if (!reference) {
    return <span className={styles.pollReferenceLine}>{t.share.poll.notInReference}</span>;
  }
  const option = decision.options[reference.option];
  const sized = option && (option.action === "bet" || option.action === "raise") && !option.allIn;
  return (
    <span className={styles.pollReferenceLine}>
      <span>{t.share.poll.reference(s.freq(reference.freq), s.signedBb(reference.ev))}</span>
      {sized ? <span>{t.share.poll.bestSize(s.option(option.action, option.sizeBb, option.allIn, option.sizePot))}</span> : null}
      <GradeWord grade={reference.grade} />
    </span>
  );
}

/** The reference's options at the polled decision, under the results. */
export function PollReference({ decision }: { decision: DecisionAnalysis | null }) {
  const t = useDict().analysis;
  const s = t.sheet;
  const graded = decision !== null && decision.grade !== null && decision.options.length > 0;
  return (
    <section className={`stack ${styles.pollReference}`} aria-labelledby="poll-reference-heading">
      <h3 id="poll-reference-heading" className={styles.cardTitle}>
        {t.share.poll.heading}
      </h3>
      {graded && decision ? (
        <>
          <p className="muted">{t.share.poll.intro}</p>
          <p className={a.sourceLine}>
            {decision.grade ? (
              <span>
                {t.share.poll.heroGraded} <GradeWord grade={decision.grade} />
              </span>
            ) : null}
            <span className={a.muted}>{s.source[decision.source] ?? decision.source}</span>
          </p>
          <OptionsTable decision={decision} readOnly />
          {decision.approximations.length > 0 ? (
            <div className={a.approx}>
              <strong>{s.approximate}</strong>
              <ul>
                {decision.approximations.map((code) => (
                  <li key={code}>{t.approximations[code] ?? code}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted">{t.share.poll.notGraded}</p>
      )}
    </section>
  );
}
