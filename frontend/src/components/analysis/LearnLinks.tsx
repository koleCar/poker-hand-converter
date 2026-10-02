/**
 * "Learn: Pot odds · SPR and commitment" — the links from an explanation to
 * the concept pages it leans on (`lib/learn/links.ts` decides which).
 */

"use client";

import Link from "next/link";
import type { ConceptId } from "../../lib/learn/concepts";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./analysis.module.css";

export function LearnLinks({ concepts }: { concepts: readonly ConceptId[] }) {
  const t = useDict().learn;
  if (concepts.length === 0) return null;
  return (
    <div className={styles.learnLinks}>
      <span className={styles.learnLabel} aria-hidden="true">
        {t.learnLabel}
      </span>
      <ul>
        {concepts.map((id) => (
          <li key={id}>
            <Link href={paths.analysisConcept(id)} aria-label={t.learnLink(t.titles[id] ?? id)}>
              {t.titles[id] ?? id}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One link, for a table row: "Learn: Pot odds". */
export function LearnLink({ concept }: { concept: ConceptId }) {
  const t = useDict().learn;
  return (
    <Link href={paths.analysisConcept(concept)} className={styles.learnInline}>
      {t.learnLink(t.titles[concept] ?? concept)}
    </Link>
  );
}
