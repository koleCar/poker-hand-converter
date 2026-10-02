/**
 * The Analysis tab's own navigation: your analysis, the study plan, the
 * trainer, leaks, progress, the reports, the preflop charts, and the concept
 * library.
 *
 * Inside the tab rather than in the app bar (`docs/ANALYSIS-PLAN.md` §6.0):
 * five top-level tabs already scroll sideways at 375px, and the library is
 * part of analysis — every explanation links into it. Rendered on every
 * Analysis screen, signed in or not, so the library is always one click away.
 *
 * Eight sections do not fit a phone's width on one line, and two lines of
 * tabs read as two rows of something else. So on a narrow screen three stay
 * as tabs (your analysis, the trainer, leaks) and the rest — the plan among
 * them; the overview's plan card links to it — go under a "More" disclosure — a native
 * `<details>`, keyboard- and screen-reader-operable without a script, closed
 * by Escape or a click elsewhere. When the current page is one of those, the
 * disclosure is named after it, so the reader still sees where they are.
 * Wide screens show every section as a tab and never render the disclosure.
 */

"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./analysis.module.css";

export type AnalysisSection = "overview" | "plan" | "train" | "leaks" | "progress" | "reports" | "charts" | "learn";

/** Sections that stay tabs on a narrow screen. */
const PRIMARY: readonly AnalysisSection[] = ["overview", "train", "leaks"];

export function AnalysisNav({ current }: { current: AnalysisSection }) {
  const t = useDict().learn.nav;
  const more = useRef<HTMLDetailsElement>(null);
  const items: ReadonlyArray<{ id: AnalysisSection; href: string; label: string }> = [
    { id: "overview", href: paths.analysis(), label: t.overview },
    { id: "plan", href: paths.analysisPlan(), label: t.plan },
    { id: "train", href: paths.analysisTrain(), label: t.train },
    { id: "leaks", href: paths.analysisLeaks(), label: t.leaks },
    { id: "progress", href: paths.analysisProgress(), label: t.progress },
    { id: "reports", href: paths.analysisReports(), label: t.reports },
    { id: "charts", href: paths.analysisCharts(), label: t.charts },
    { id: "learn", href: paths.analysisLearn(), label: t.learn },
  ];
  const secondary = items.filter((item) => !PRIMARY.includes(item.id));
  const currentSecondary = secondary.find((item) => item.id === current) ?? null;

  // Escape or a click outside closes the disclosure, as a menu would.
  useEffect(() => {
    const close = (event: Event) => {
      const details = more.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        details.open = false;
        details.querySelector("summary")?.focus();
        return;
      }
      if (event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, []);

  const link = (item: (typeof items)[number]) => (
    <Link href={item.href} className={styles.subnavLink} aria-current={current === item.id ? "page" : undefined}>
      {item.label}
    </Link>
  );

  return (
    <nav className={styles.subnav} aria-label={t.label}>
      <ul>
        {items.map((item) => (
          <li key={item.id} className={PRIMARY.includes(item.id) ? undefined : styles.subnavWide}>
            {link(item)}
          </li>
        ))}
        <li className={styles.subnavMore}>
          <details ref={more}>
            <summary className={styles.subnavLink} aria-current={currentSecondary ? "page" : undefined}>
              {currentSecondary ? currentSecondary.label : t.more}
              <span aria-hidden="true" className={styles.subnavCaret}>
                ▾
              </span>
            </summary>
            <ul className={styles.subnavMenu}>
              {secondary.map((item) => (
                <li key={item.id}>{link(item)}</li>
              ))}
            </ul>
          </details>
        </li>
      </ul>
    </nav>
  );
}
