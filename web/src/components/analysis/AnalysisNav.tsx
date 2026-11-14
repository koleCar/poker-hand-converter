/**
 * The Analysis tab's own navigation (redesign of 2026-11): seven sections as
 * one row of pill tabs, the concept library behind a book icon, and the
 * screen's own tools (filters, the analysis run) on the same row.
 *
 * Ten sections became seven: the study plan lives on Train, your own charts
 * on Charts (Rail | Mine), and the concepts are reached from the icon and
 * from every "Learn" link rather than from a tab. Their pages still exist, so
 * they light up the section that now holds them.
 *
 * The tabs wrap on a narrow screen; nothing is hidden behind a "More".
 */

"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./ui/an.module.css";

export type AnalysisSection =
  | "overview"
  | "session"
  | "plan"
  | "train"
  | "leaks"
  | "progress"
  | "reports"
  | "charts"
  | "my-charts"
  | "learn";

type Tab = "overview" | "session" | "leaks" | "progress" | "reports" | "train" | "charts";

/** The tab a section lights up: the plan is on Train, your charts on Charts. */
function tabOf(section: AnalysisSection): Tab | null {
  if (section === "plan") return "train";
  if (section === "my-charts") return "charts";
  if (section === "learn") return null;
  return section;
}

export function AnalysisNav({ current, children }: { current: AnalysisSection; children?: ReactNode }) {
  const t = useDict().analysis.ui.nav;
  const on = tabOf(current);
  const items: ReadonlyArray<{ id: Tab; href: string; label: string }> = [
    { id: "overview", href: paths.analysis(), label: t.overview },
    { id: "session", href: paths.analysisSession(), label: t.session },
    { id: "leaks", href: paths.analysisLeaks(), label: t.leaks },
    { id: "progress", href: paths.analysisProgress(), label: t.progress },
    { id: "reports", href: paths.analysisReports(), label: t.reports },
    { id: "train", href: paths.analysisTrain(), label: t.train },
    { id: "charts", href: paths.analysisCharts(), label: t.charts },
  ];
  return (
    <div className={styles.sub}>
      <nav className={styles.tabs} aria-label={t.label}>
        {items.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            className={`${styles.tab} ${on === item.id ? styles.tabOn : ""}`}
            aria-current={on === item.id ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <Link
        href={paths.analysisLearn()}
        className={`${styles.iconLink} ${current === "learn" ? styles.iconLinkOn : ""}`}
        aria-label={t.concepts}
        title={t.concepts}
        aria-current={current === "learn" ? "page" : undefined}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6.5a2.5 2.5 0 0 0 0 5H20" />
        </svg>
      </Link>
      {children ? (
        <>
          <span className={styles.grow} />
          <div className={styles.tools}>{children}</div>
        </>
      ) : null}
    </div>
  );
}
