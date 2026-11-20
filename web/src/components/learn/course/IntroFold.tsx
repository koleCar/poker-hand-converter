/**
 * The course map's "how Rail teaches" panel, folded on a phone: there its
 * heading is a button that opens and closes the rest, so the course starts
 * within the first screen. On a wider screen the panel is always open: the
 * heading is plain text and the button is not shown (`course.module.css`,
 * `.introPanel`).
 *
 * The fold is CSS only (`data-open`), so the server's markup is the same on
 * every screen and nothing jumps when the page hydrates.
 */

"use client";

import { useId, useState, type ReactNode } from "react";
import styles from "./course.module.css";

export function IntroFold({ heading, headingId, children }: { heading: string; headingId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const body = useId();
  return (
    <section className={styles.introPanel} aria-labelledby={headingId} data-open={open || undefined}>
      <h2 id={headingId} className={styles.introHeading}>
        <span className={styles.introHeadingText}>{heading}</span>
        <button type="button" className={styles.introToggle} aria-expanded={open} aria-controls={body} onClick={() => setOpen((x) => !x)}>
          {heading}
          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.introChevron}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </h2>
      <div id={body} className={styles.introBody}>
        {children}
      </div>
    </section>
  );
}
