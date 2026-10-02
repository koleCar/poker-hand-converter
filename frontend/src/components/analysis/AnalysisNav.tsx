/**
 * The Analysis tab's own navigation: your analysis, the preflop charts, and
 * the concept library.
 *
 * Inside the tab rather than in the app bar (`docs/ANALYSIS-PLAN.md` §6.0):
 * five top-level tabs already scroll sideways at 375px, and the library is
 * part of analysis — every explanation links into it. Rendered on every
 * Analysis screen, signed in or not, so the library is always one click away.
 */

"use client";

import Link from "next/link";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./analysis.module.css";

export function AnalysisNav({ current }: { current: "overview" | "charts" | "learn" }) {
  const t = useDict().learn.nav;
  const items = [
    { id: "overview", href: paths.analysis(), label: t.overview },
    { id: "charts", href: paths.analysisCharts(), label: t.charts },
    { id: "learn", href: paths.analysisLearn(), label: t.learn },
  ] as const;
  return (
    <nav className={styles.subnav} aria-label={t.label}>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <Link href={item.href} className={styles.subnavLink} aria-current={current === item.id ? "page" : undefined}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
