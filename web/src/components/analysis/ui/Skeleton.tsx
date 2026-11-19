/**
 * The Analysis tabs' waits, drawn as the screens they wait for (2026-11-19):
 * grey blocks with a light sweeping across them where the filters, figures,
 * charts, lists and tables will be. Each tab keeps its shape from the first
 * frame, so nothing jumps when the answer lands, and the route's
 * `loading.tsx` (`AnalysisRouteLoading`) draws the same skeleton as the tab's
 * own first load, so the two waits read as one.
 *
 * Blocks fade in after 150ms (`.skWrap`), like `RailLoader`: a read that
 * answers at once never flashes grey. Under `prefers-reduced-motion` they are
 * still grey blocks with no sweep. Every skeleton is `aria-hidden`; the
 * caller wraps it in one `role="status"` with the tab's own words
 * (`SkStatus`).
 */

"use client";

import type { CSSProperties, ReactNode } from "react";
import styles from "./an.module.css";

/** One grey block. Width and height in CSS lengths. */
export function Sk({ w, h = 12, round = false, style }: { w?: number | string; h?: number | string; round?: boolean; style?: CSSProperties }) {
  return <i className={`${styles.sk} ${round ? styles.skRound : ""}`} aria-hidden="true" style={{ inlineSize: w, blockSize: h, ...style }} />;
}

/** The one announcement for a skeleton: screen readers hear the label, not the blocks. */
export function SkStatus({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={className ?? styles.skStack}>
      {children}
    </div>
  );
}

/** A raised card that fades in after the delay. */
function SkCard({ children, flush = false, style }: { children: ReactNode; flush?: boolean; style?: CSSProperties }) {
  return (
    <section className={`${styles.card} ${flush ? styles.flush : ""} ${styles.skWrap}`} aria-hidden="true" style={style}>
      {children}
    </section>
  );
}

function Row({ children, gap = 8, style, fade = false }: { children: ReactNode; gap?: number; style?: CSSProperties; fade?: boolean }) {
  return (
    <div className={fade ? styles.skWrap : undefined} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap, ...style }}>
      {children}
    </div>
  );
}

/** Varied widths so rows read as text, not as a barcode. */
const vary = (i: number, base: number, spread: number) => base + ((i * 37) % spread);

/* ------------------------------------------------------------ shared rows - */

/** The filter row (kind switch, add filter, all filters) and the quick-filter chips under it. */
export function FilterSkeleton() {
  return (
    <div className={`${styles.skStack} ${styles.skWrap}`} style={{ gap: 10 }} aria-hidden="true">
      <Row>
        <Sk w={56} h={28} round />
        <Sk w={60} h={28} round />
        <Sk w={96} h={28} />
        <span className={styles.grow} />
        <Sk w={92} h={30} />
      </Row>
      <Row>
        {[44, 92, 80, 112, 104, 110].map((w, i) => (
          <Sk key={i} w={w} h={26} round />
        ))}
      </Row>
    </div>
  );
}

/** A table: a head line and rows of cells of the given widths (the last ones right-aligned). */
function TableRows({ cols, rows = 7, head = true }: { cols: Array<number | string>; rows?: number; head?: boolean }) {
  const template = cols.map((c) => (typeof c === "number" ? `${c}px` : c)).join(" ");
  const line = (key: number, h: number, isHead: boolean) => (
    <div
      key={key}
      style={{
        display: "grid",
        gridTemplateColumns: template,
        alignItems: "center",
        gap: 12,
        padding: "10px 16px",
        borderBlockStart: isHead ? undefined : "1px solid var(--border-subtle)",
      }}
    >
      {cols.map((c, i) => (
        <Sk
          key={i}
          w={typeof c === "number" ? Math.max(18, c - (isHead ? 18 : vary(key + i, 0, 16))) : `${vary(key + i, 45, 40)}%`}
          h={h}
          style={i >= cols.length - 2 ? { marginInlineStart: "auto" } : undefined}
        />
      ))}
    </div>
  );
  return (
    <div>
      {head ? line(-1, 9, true) : null}
      {Array.from({ length: rows }, (_, i) => line(i, 11, false))}
    </div>
  );
}

/* ---------------------------------------------------------------- session - */

/** The Cash / Tournaments switch. */
export function KindSkeleton() {
  return (
    <Row fade gap={6}>
      <Sk w={56} h={28} round />
      <Sk w={60} h={28} round />
    </Row>
  );
}

/** Session review: the picker, the figure tiles, two short sections and the biggest pots. */
export function SessionSkeleton({ picker = true }: { picker?: boolean }) {
  return (
    <>
      {picker ? (
        <Row fade style={{ gap: 10 }}>
          <Sk w={28} h={28} />
          <Sk w="min(360px, 70%)" h={30} />
          <Sk w={28} h={28} />
        </Row>
      ) : null}
      <div className={`${styles.skTiles} ${styles.skWrap}`} aria-hidden="true">
        {[150, 40, 70, 30, 72, 52, 64].map((w, i) => (
          <div key={i} className={styles.card} style={{ gap: 8 }}>
            <Sk w={vary(i, 40, 30)} h={10} />
            <Sk w={w} h={22} />
          </div>
        ))}
      </div>
      {[0, 1].map((i) => (
        <div key={i} className={`${styles.skStack} ${styles.skWrap}`} style={{ gap: 8 }} aria-hidden="true">
          <Sk w={140 - i * 20} h={14} />
          <Sk w={`${55 - i * 10}%`} h={10} />
        </div>
      ))}
      <SkCard flush>
        <div className={styles.cardHead}>
          <Sk w={110} h={14} />
          <Sk w={18} h={14} round />
        </div>
        <TableRows cols={[48, 80, 36, 64, 110, "1fr", 84, 56, 48]} rows={5} />
      </SkCard>
    </>
  );
}

/* ------------------------------------------------------------------ leaks - */

/** One leak row: rank, dot, title and context, bar, count, value. */
function LeakRows({ rows = 7 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px" }}>
          <Sk w={10} h={10} />
          <Sk w={8} h={8} round />
          <span style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 200px", minInlineSize: 0 }}>
            <Sk w={vary(i, 110, 60)} h={12} />
            <Sk w={vary(i, 150, 70)} h={9} />
          </span>
          <span style={{ flex: "1 1 120px", minInlineSize: 0 }} className={styles.hideNarrow}>
            <Sk w={`${Math.max(6, 92 - i * 14)}%`} h={6} round />
          </span>
          <Sk w={110} h={10} />
          <Sk w={92} h={12} />
        </div>
      ))}
    </>
  );
}

/** Leaks: the street chips and the ranking, then the list. */
export function LeaksTabSkeleton({ filters = true }: { filters?: boolean }) {
  return (
    <>
      {filters ? <FilterSkeleton /> : null}
      <Row fade style={{ justifyContent: "space-between" }}>
        <Row gap={6}>
          {[92, 64, 52, 52, 56].map((w, i) => (
            <Sk key={i} w={w} h={28} round />
          ))}
        </Row>
        <Sk w="min(380px, 100%)" h={30} />
      </Row>
      <SkCard style={{ padding: 8, gap: 2 }}>
        <Sk w={260} h={10} style={{ margin: "6px 12px 8px" }} />
        <LeakRows />
      </SkCard>
    </>
  );
}

/* ---------------------------------------------------------------- progress - */

/** A line chart's frame: title, a y-axis of ticks and the plot. */
function ChartCard({ height = 220 }: { height?: number }) {
  return (
    <SkCard>
      <Row>
        <Sk w={60} h={13} />
        <Sk w={240} h={10} />
      </Row>
      <div style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 10, blockSize: height }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          {[0, 1, 2, 3].map((i) => (
            <Sk key={i} w={22} h={9} />
          ))}
        </div>
        <Sk h="100%" style={{ inlineSize: "100%", opacity: 0.6 }} />
      </div>
    </SkCard>
  );
}

/** Progress: the grouping controls and two charts. */
export function ProgressSkeleton({ filters = true }: { filters?: boolean }) {
  return (
    <>
      {filters ? <FilterSkeleton /> : null}
      <Row fade style={{ justifyContent: "flex-end" }}>
        <Sk w={190} h={30} />
        <Sk w={260} h={30} />
      </Row>
      <ChartCard />
      <ChartCard height={180} />
    </>
  );
}

/* ----------------------------------------------------------------- reports - */

/** Reports: the chart-set field, a line of help, then the statistics table. */
export function ReportsSkeleton({ filters = true, field = true }: { filters?: boolean; field?: boolean }) {
  return (
    <>
      {filters ? <FilterSkeleton /> : null}
      {field ? (
        <div className={`${styles.skStack} ${styles.skWrap}`} style={{ gap: 6 }} aria-hidden="true">
          <Sk w={52} h={9} />
          <Sk w="100%" h={34} />
          <Sk w="70%" h={10} style={{ marginBlockStart: 4 }} />
        </div>
      ) : null}
      <SkCard flush>
        <div className={styles.skStack} style={{ gap: 8, padding: "16px 16px 4px" }}>
          <Sk w={250} h={15} />
          <Sk w="60%" h={10} />
        </div>
        <TableRows cols={["1fr", 52, 64, 72, 72, 64, 64]} rows={8} />
      </SkCard>
    </>
  );
}

/* ------------------------------------------------------------------- plan - */

/** Plan: the intro, the kind field, the week and the first focus. */
export function PlanSkeleton({ intro = true }: { intro?: boolean }) {
  return (
    <>
      {intro ? (
        <div className={`${styles.skStack} ${styles.skWrap}`} style={{ gap: 7 }} aria-hidden="true">
          <Sk w="88%" h={11} />
          <Sk w="82%" h={11} />
          <Sk w="40%" h={11} />
          <Sk w={70} h={9} style={{ marginBlockStart: 12 }} />
          <Row gap={6}>
            <Sk w={46} h={26} round />
            <Sk w={56} h={26} round />
          </Row>
        </div>
      ) : null}
      <SkCard>
        <Row>
          <Sk w={220} h={15} />
          <span className={styles.grow} />
          <Sk w={70} h={10} />
        </Row>
        <Sk w={130} h={11} />
        <Sk w="100%" h={8} round />
        <Sk w="75%" h={10} />
        <Row>
          <Sk w={190} h={30} />
          <Sk w={260} h={10} />
        </Row>
      </SkCard>
      <SkCard>
        <Sk w={150} h={16} />
        <Sk w="55%" h={10} />
        {[0, 1].map((i) => (
          <div key={i} className={styles.skStack} style={{ gap: 7, marginBlockStart: 8 }}>
            <Sk w={50} h={9} />
            <Sk w={200} h={12} />
            <Sk w={150} h={18} />
            <Sk w="65%" h={10} />
          </div>
        ))}
      </SkCard>
    </>
  );
}

/* ----------------------------------------------------------------- charts - */

/** Charts: three fields, the spot's name, the legend and the 13×13 grid beside its help. */
export function ChartsSkeleton({ caveat = true }: { caveat?: boolean }) {
  return (
    <div className={`${styles.skStack} ${styles.skWrap}`} style={{ gap: 14 }} aria-hidden="true">
      {caveat ? <Sk w={190} h={10} /> : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, maxInlineSize: 680 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={styles.skStack} style={{ gap: 6 }}>
            <Sk w={60} h={9} />
            <Sk w="100%" h={34} />
          </div>
        ))}
      </div>
      <Sk w={130} h={15} />
      <Row>
        <Sk w={150} h={10} />
        <Sk w={200} h={10} />
        <Sk w={120} h={10} />
      </Row>
      <div className={styles.skChartRow}>
        <div className={styles.skGrid13}>
          {Array.from({ length: 169 }, (_, i) => (
            <Sk key={i} h="auto" style={{ inlineSize: "auto", aspectRatio: "1.3", borderRadius: 3 }} />
          ))}
        </div>
        <div className={styles.skStack} style={{ gap: 7, flex: "1 1 200px" }}>
          <Sk w="90%" h={10} />
          <Sk w="80%" h={10} />
          <Sk w="85%" h={10} />
          <Sk w="40%" h={10} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ train - */

/** One training spot: the hand, the board and the answer buttons. */
export function SpotSkeleton() {
  return (
    <div className={`${styles.skStack} ${styles.skWrap}`} style={{ gap: 14 }} aria-hidden="true">
      <Row gap={14}>
        <span className={styles.skStack} style={{ gap: 6 }}>
          <Sk w={60} h={9} />
          <Row gap={4}>
            <Sk w={38} h={52} />
            <Sk w={38} h={52} />
          </Row>
        </span>
        <span className={styles.skStack} style={{ gap: 6 }}>
          <Sk w={44} h={9} />
          <Row gap={4}>
            {[0, 1, 2].map((i) => (
              <Sk key={i} w={38} h={52} />
            ))}
          </Row>
        </span>
      </Row>
      <Sk w="70%" h={11} />
      <Row>
        {[88, 96, 110].map((w, i) => (
          <Sk key={i} w={w} h={38} />
        ))}
      </Row>
    </div>
  );
}

/** Train: the spot on the left, the session and the plan beside it. */
export function TrainSkeleton() {
  return (
    <div className={styles.mainSide}>
      <div className={styles.main}>
        <SkCard>
          <Row>
            <Sk w={120} h={14} />
            <span className={styles.grow} />
            <Sk w={40} h={10} />
          </Row>
          <SpotSkeleton />
        </SkCard>
      </div>
      <div className={styles.side}>
        <SkCard>
          <Sk w={90} h={12} />
          <Row>
            {[0, 1, 2].map((i) => (
              <span key={i} className={styles.skStack} style={{ gap: 5 }}>
                <Sk w={44} h={9} />
                <Sk w={34} h={20} />
              </span>
            ))}
          </Row>
        </SkCard>
        <SkCard>
          <Sk w={110} h={12} />
          <Sk w="100%" h={8} round />
          <Sk w="60%" h={10} />
        </SkCard>
      </div>
    </div>
  );
}
