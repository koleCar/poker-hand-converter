/**
 * The overview's plan card (phase A8b): this week's focus and how much of
 * its checklist is done, one link to the plan. No plan yet this week: a link
 * that builds it. Quiet when the plans are not installed or anything fails —
 * the overview is about the analysis, not this card.
 */

"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { fetchStudyPlan, type StoredPlan } from "../../../lib/db/studyPlan";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import { planProgress, weekBounds, weekStart } from "../../../lib/training/plan";
import { usePlanWords } from "./planWords";
import styles from "./plan.module.css";

type Loaded = { key: number; plan: StoredPlan | null } | { key: number; failed: true };

export function PlanCard({ generation }: { generation: number }) {
  const t = useDict().analysis.plan;
  const words = usePlanWords();
  const id = useId();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let live = true;
    const week = weekStart(new Date());
    fetchStudyPlan(week, weekBounds(week).from)
      .then((plan) => {
        if (live) setLoaded({ key: generation, plan });
      })
      .catch(() => {
        if (live) setLoaded({ key: generation, failed: true });
      });
    return () => {
      live = false;
    };
  }, [generation]);

  if (!loaded || "failed" in loaded) return null;
  const plan = loaded.plan;

  if (!plan) {
    return (
      <section className={`card ${styles.card}`} aria-labelledby={id}>
        <h3 id={id}>{t.card.heading}</h3>
        <div className={styles.cardRow}>
          <p className="muted">{t.card.none}</p>
          <Link href={paths.analysisPlan()} className="btn btn--primary btn--sm">
            {t.card.build}
          </Link>
        </div>
      </section>
    );
  }

  const progress = planProgress(plan.tasks);
  const names = plan.kind === "fundamentals" ? t.card.fundamentals : plan.focus.map((area) => words.area(area).heading).join("; ");
  const share = Math.round(Math.min(1, progress.share) * 100);
  return (
    <section className={`card ${styles.card}`} aria-labelledby={id}>
      <h3 id={id}>{t.card.heading}</h3>
      <p>{t.card.focus(names)}</p>
      <div className={styles.cardRow}>
        <div className={styles.meter}>
          <span id={`${id}-progress`}>{t.progress(progress.done, progress.total)}</span>
          <div
            className={styles.track}
            role="progressbar"
            aria-labelledby={`${id}-progress`}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-valuetext={t.progress(progress.done, progress.total)}
          >
            <div className={styles.fill} style={{ inlineSize: `${share}%` }} />
          </div>
        </div>
        <Link href={paths.analysisPlan()} className="btn btn--primary btn--sm">
          {t.card.open}
        </Link>
      </div>
    </section>
  );
}
