/**
 * The Trainer opened from Analytics (docs/ANALYTICS.md Step 9, canvas board
 * `AN-Train`): the *From Analytics* bar over the table - the leak, the spot
 * and the size, its cost, the way back to the stat - and the goal panel
 * beside it: your rate here, the target, and this drill's rate, which counts
 * up as the player answers.
 *
 * The stat's and the spot's words are Analytics' own (`@rail/ui`'s
 * `statName`, `spotName`, the catalogue's labels), so the Trainer names the
 * leak exactly as the screen it came from.
 */

"use client";

import { breakdownName, directionWords, percentText, statName } from "@rail/ui/analytics/findings";
import { spotName } from "@rail/ui/analytics/spot";
import { useUiStrings } from "@rail/ui/i18n";
import { useMemo } from "react";
import { ANALYTICS } from "../../lib/stats/analytics";
import { drillGoal, rateOf, type AnalyticsFrom } from "./analytics";
import { useTrainerHost } from "./host";
import type { SessionAnswer } from "./sessions";
import type { TrainerSettings } from "./settings";
import styles from "./trainer.module.css";

/** The bar over the table: where the drill came from. */
export function AnalyticsBar({ from, size, approximate = false }: { from: AnalyticsFrom; size: string | null; approximate?: boolean }) {
  const host = useTrainerHost();
  const t = host.t.analytics;
  const words = useUiStrings().analytics;
  const stat = ANALYTICS.get(from.stat);
  if (!stat) return null;
  const direction = from.you !== null && from.ref !== null && from.you !== from.ref ? (from.you > from.ref ? "high" : "low") : null;
  const headline = direction ? `${directionWords(stat, direction, words)} · ${statName(stat, words)}` : statName(stat, words);
  const where = [from.spot ? spotName(from.spot, words.spot) : null, size ? t.facingSize(breakdownName(ANALYTICS, "size", size, words)) : null]
    .filter(Boolean)
    .join(words.spot.separator);
  const back = host.analyticsHref?.(from.stat);
  return (
    <div className={styles.focus} data-from="analytics">
      <span className={styles.focusLabel}>{t.from}</span>
      <strong>{headline}</strong>
      {where ? <span className={styles.muted}>{where}</span> : null}
      {from.cost !== null && from.cost > 0 ? <span className={styles.focusCost}>{t.costs(from.cost)}</span> : null}
      {approximate ? <span className={styles.muted}>{t.approximate}</span> : null}
      {back ? (
        <a className={`${styles.linkButton} ${styles.fromBack}`} href={back}>
          {t.back}
        </a>
      ) : null}
    </div>
  );
}

const TONE: Record<string, string | undefined> = { ok: styles.toneOk, off: styles.toneOff, far: styles.toneFar };

/** The side panel's goal: your rate here and the target (from Analytics), and this drill's, counting as it goes. */
export function GoalPanel({ settings, answers }: { settings: TrainerSettings; answers: readonly SessionAnswer[] }) {
  const host = useTrainerHost();
  const t = host.t.analytics;
  const words = useUiStrings().analytics;
  const locale = host.locale;
  const from = settings.from;
  const rate = rateOf(from ? ANALYTICS.get(from.stat) : undefined);
  const goal = useMemo(() => (rate ? drillGoal(answers, rate.class) : null), [answers, rate]);
  if (!from || !rate || !goal) return null;
  const pct = (value: number) => percentText(value, words, locale);
  // The player's number in Analytics' own tone for it (the link carries it).
  const youTone = from.tone ? TONE[from.tone] : undefined;
  const classes = settings.classes.map((cls) => breakdownName(ANALYTICS, "class", cls, words));
  return (
    <section className={styles.goal} aria-label={t.goal}>
      <span className={styles.goalHead}>{t.goal}</span>
      <dl className={styles.goalRows}>
        <div>
          <dt>{t.rateHere(rate.class)}</dt>
          <dd className={youTone}>{from.you === null ? "—" : pct(from.you)}</dd>
        </div>
        <div>
          <dt>{rate.street === "preflop" ? t.targetCharts : t.target}</dt>
          <dd>{from.ref === null ? "—" : pct(from.ref)}</dd>
        </div>
        <div>
          <dt>{t.drill}</dt>
          <dd className={TONE[goal.tone]} data-goal-tone={goal.tone}>
            {goal.rate === null ? "—" : pct(goal.rate)}
          </dd>
        </div>
      </dl>
      {goal.ref !== null ? (
        <span className={styles.muted}>{goal.tone === "few" ? `${t.few} · ${t.drillRef(pct(goal.ref))}` : t.drillRef(pct(goal.ref))}</span>
      ) : null}
      {classes.length > 0 ? <span className={styles.muted}>{t.dealtFrom(classes.join(", "))}</span> : null}
      <span className={styles.muted}>{t.later}</span>
    </section>
  );
}
