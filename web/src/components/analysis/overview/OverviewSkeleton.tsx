/**
 * The Analysis overview's waits, drawn as the screen they wait for: grey
 * blocks where the figures, the heatmap, the side cards and the hand rows
 * will be, with a light sweeping across them. The page keeps its shape from
 * the first frame, so nothing jumps when the numbers land.
 *
 * Each part has its own skeleton so a part that loads on its own (the
 * heatmap, the hands, the side cards) can wait in place while the rest of the
 * screen is already there. `OverviewSkeleton` is all of them together, for
 * the first load and the route's `loading.tsx`.
 *
 * Skeletons fade in after a short delay (`.skWrap`), like `RailLoader`: a
 * read that answers at once never flashes grey.
 */

"use client";

import type { CSSProperties } from "react";
import styles from "../ui/an.module.css";

/** One grey block. Width and height in CSS lengths. */
export function Sk({ w, h = 12, round = false, style }: { w?: number | string; h?: number | string; round?: boolean; style?: CSSProperties }) {
  return <i className={`${styles.sk} ${round ? styles.skRound : ""}`} aria-hidden="true" style={{ inlineSize: w, blockSize: h, ...style }} />;
}

const HEAT_ROWS = 6;
const STREETS = 4;

/** The heatmap's grid: a label column and four street cells per row. */
export function HeatSkeleton() {
  return (
    <div className={`${styles.heat} ${styles.skWrap}`} aria-hidden="true">
      <div className={styles.heatRow}>
        <span />
        {Array.from({ length: STREETS }, (_, i) => (
          <span key={i} className={styles.heatLabel}>
            <Sk w={36} h={10} />
          </span>
        ))}
      </div>
      {Array.from({ length: HEAT_ROWS }, (_, row) => (
        <div key={row} className={styles.heatRow}>
          <span className={styles.heatLabel}>
            <Sk w={32} h={10} />
          </span>
          {Array.from({ length: STREETS }, (_, i) => (
            <Sk key={i} h={44} style={{ inlineSize: "auto", borderRadius: "var(--radius-2)" }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Hand rows under the list's own column heads. */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className={styles.skWrap} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.hrow} style={{ pointerEvents: "none" }}>
          <span style={{ display: "flex", gap: 3 }}>
            <Sk w={22} h={30} />
            <Sk w={22} h={30} />
          </span>
          <Sk w={34} h={20} />
          <span className={styles.hideMid}>
            <Sk w={`${55 + ((i * 17) % 35)}%`} h={10} />
          </span>
          <span className={styles.hideNarrow}>
            <Sk w={70 + ((i * 13) % 40)} h={14} />
          </span>
          <span className={styles.hideNarrow}>
            <Sk w={64} h={10} />
          </span>
          <span className={`${styles.r} ${styles.hideNarrow}`}>
            <Sk w={40} h={10} style={{ marginInlineStart: "auto" }} />
          </span>
          <span className={styles.r}>
            <Sk w={52} h={10} style={{ marginInlineStart: "auto" }} />
          </span>
          <span className={styles.hideMid}>
            <Sk w={64} h={10} style={{ marginInlineStart: "auto" }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The top-leaks card: three ranked rows with a bar under each. */
export function LeaksSkeleton() {
  return (
    <section className={`${styles.card} ${styles.skWrap}`} aria-hidden="true">
      <div className={styles.cardHead}>
        <Sk w={72} h={10} />
        <span className={styles.grow} />
        <Sk w={48} h={10} />
      </div>
      {[0.9, 0.6, 0.4].map((share, i) => (
        <div key={i} className={styles.lrow} style={{ pointerEvents: "none" }}>
          <span className={styles.lline}>
            <Sk w={8} h={10} />
            <Sk w={`${60 - i * 10}%`} h={12} />
            <span className={styles.grow} />
            <Sk w={38} h={12} />
          </span>
          <span className={styles.lline} style={{ paddingInlineStart: 22 }}>
            <Sk w="70%" h={9} />
          </span>
          <Sk w={`calc(${share * 100}% - 22px)`} h={6} style={{ marginInlineStart: 22 }} />
        </div>
      ))}
    </section>
  );
}

/** The headline card: four figures and the grade bar. */
export function HeadSkeleton() {
  return (
    <section className={`${styles.card} ${styles.skWrap}`} aria-hidden="true">
      <div className={styles.kpis}>
        {[64, 84, 48, 72].map((w, i) => (
          <dl key={i} className={styles.kpi}>
            <dt>
              <Sk w={52} h={10} />
            </dt>
            <dd>
              <Sk w={w} h={26} />
            </dd>
          </dl>
        ))}
        <div className={styles.gradeBox}>
          <Sk w={56} h={10} />
          <Sk w="100%" h={10} round />
          <span style={{ display: "flex", gap: 12 }}>
            {[54, 44, 66, 52, 56].map((w, i) => (
              <Sk key={i} w={w} h={10} />
            ))}
          </span>
        </div>
      </div>
    </section>
  );
}

/** The whole overview, for the first load. */
export function OverviewSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={styles.skPage}>
      <HeadSkeleton />
      <div className={styles.mainSide}>
        <div className={styles.main}>
          <section className={`${styles.card} ${styles.skWrap}`} aria-hidden="true">
            <div className={styles.cardHead}>
              <Sk w={110} h={10} />
              <span className={styles.grow} />
              <Sk w={120} h={26} />
              <Sk w={170} h={26} />
            </div>
            <HeatSkeleton />
          </section>
        </div>
        <div className={styles.side}>
          <LeaksSkeleton />
          <section className={`${styles.card} ${styles.skWrap}`} aria-hidden="true">
            <div className={styles.cardHead}>
              <span className={styles.kpi}>
                <Sk w={64} h={10} />
                <Sk w={40} h={26} style={{ marginBlockStart: 4 }} />
              </span>
              <span className={styles.grow} />
              <Sk w={64} h={28} />
            </div>
            <Sk w="100%" h={8} round />
          </section>
        </div>
      </div>
      <section className={`${styles.card} ${styles.flush}`} aria-hidden="true">
        <div className={styles.cardHead}>
          <Sk w={48} h={10} />
          <Sk w={64} h={10} />
          <span className={styles.grow} />
          <Sk w={80} h={28} round />
          <Sk w={90} h={28} round />
        </div>
        <ListSkeleton />
      </section>
    </div>
  );
}
