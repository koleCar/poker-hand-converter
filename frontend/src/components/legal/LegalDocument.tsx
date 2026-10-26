import { renderMarkdown } from "../../lib/legal/markdown";
import { LEGAL_TEXTS } from "../../lib/legal/texts.generated";
import type { Locale } from "../../lib/i18n/types";
import styles from "./legal.module.css";

export type LegalDocumentId = keyof typeof LEGAL_TEXTS;

/** The document's title: its first `#` heading. */
export function legalTitle(id: LegalDocumentId, locale: Locale): string {
  const first = /^#\s+(.+)$/m.exec(LEGAL_TEXTS[id][locale]);
  return first ? first[1].trim() : id;
}

/**
 * `/terms` and `/privacy` (R6.5): the document from `docs/legal/` in the
 * reader's language, under a banner that says it is a draft. Server-rendered
 * (no state, nothing of the reader's).
 */
export function LegalDocument({ id, locale, draft }: { id: LegalDocumentId; locale: Locale; draft: string }) {
  return (
    <article className={`card ${styles.article}`} lang={locale}>
      <p className={`notice notice--warn ${styles.draft}`} role="note">
        <strong>{draft}</strong>
      </p>
      <h1 className={styles.title}>{legalTitle(id, locale)}</h1>
      <div className={styles.body}>{renderMarkdown(LEGAL_TEXTS[id][locale], { skipTitle: true, tableClass: styles.table })}</div>
    </article>
  );
}
