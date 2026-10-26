"use client";

/**
 * The one upgrade prompt (Rail R6.4): whenever the server refuses a Pro
 * feature or a save past the Free cap (`PT402`, HTTP 402), wherever the call
 * was made, this says why and offers the upgrade - instead of each screen
 * printing a raw error. Mounted once, in the root layout, inside the
 * entitlements provider; it also re-reads the account's entitlements, so
 * the screens' locks catch up with a plan that changed meanwhile.
 *
 * Never shown while enforcement is off: nothing is refused then.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { FEATURES, type Feature } from "../../lib/db/entitlements";
import { useEntitlements } from "../../lib/entitlements/context";
import { onPlanRefusal, type PlanRefusal } from "../../lib/entitlements/planRefusal";
import { useDict, useLocale } from "../../lib/i18n/client";
import { INTL_LOCALE } from "../../lib/i18n/dictionaries";
import { paths } from "../../lib/routes";
import styles from "./PlanRefusalPrompt.module.css";

function isFeature(value: string | null): value is Feature {
  return value !== null && (FEATURES as readonly string[]).includes(value);
}

/** The prompt's words for a refusal (pure: the tests read it in both languages). */
export function promptText(
  refusal: PlanRefusal,
  dict: ReturnType<typeof useDict>,
  formatCount: (n: number) => string,
): { heading: string; body: string } {
  const p = dict.planNotice.prompt;
  if (refusal.feature === "hand_cap" || refusal.cap) {
    return {
      heading: p.capHeading,
      body: refusal.cap ? p.cap(formatCount(refusal.cap.cap)) : refusal.message || p.generic,
    };
  }
  return {
    heading: p.heading,
    body: isFeature(refusal.feature) ? dict.plan.lock.body[refusal.feature] : refusal.message || p.generic,
  };
}

export function PlanRefusalPrompt() {
  const dict = useDict();
  const locale = INTL_LOCALE[useLocale()];
  const { refresh } = useEntitlements();
  const [refusal, setRefusal] = useState<PlanRefusal | null>(null);

  useEffect(
    () =>
      onPlanRefusal((next) => {
        setRefusal(next);
        void refresh();
      }),
    [refresh],
  );

  if (!refusal) {
    return null;
  }
  const p = dict.planNotice.prompt;
  const text = promptText(refusal, dict, (n) => n.toLocaleString(locale));
  return (
    <section className={styles.prompt} role="alert" aria-labelledby="plan-refusal-heading">
      <h2 id="plan-refusal-heading" className={styles.heading}>
        {text.heading}
      </h2>
      <p className={styles.body}>{text.body}</p>
      <div className={styles.actions}>
        <Link href={paths.upgrade()} className="btn btn--primary btn--sm" onClick={() => setRefusal(null)}>
          {p.upgrade}
        </Link>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRefusal(null)}>
          {p.dismiss}
        </button>
      </div>
    </section>
  );
}
