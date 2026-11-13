/**
 * Rail's charts or your own (redesign of 2026-11): one Charts tab, two
 * pages, switched here. A segment of links, so each stays its own address.
 */

"use client";

import Link from "next/link";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./ui/an.module.css";

export function ChartsSource({ current }: { current: "rail" | "mine" }) {
  const t = useDict().analysis.ui.charts;
  return (
    <nav className={styles.seg} aria-label={t.label}>
      <Link href={paths.analysisCharts()} className={styles.segLink} aria-current={current === "rail" ? "page" : undefined}>
        {t.rail}
      </Link>
      <Link href={paths.analysisMyCharts()} className={styles.segLink} aria-current={current === "mine" ? "page" : undefined}>
        {t.mine}
      </Link>
    </nav>
  );
}
