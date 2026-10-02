/**
 * The overview's "what improved / what to work on" card (phase A6): the last
 * 7 or 30 days of play against the same stretch before, per street and per
 * leak, worded no more confidently than the sample allows.
 *
 * - **The window ends on the last day played**, not today: a library that
 *   stopped in February is compared as of February, and the card says so.
 * - Streets and the whole sample compare by mean move score (Welch's z), a
 *   leak by its mistake rate in its spot (two-proportion z), grouped on both
 *   periods together so one leak means the same spots in both
 *   (`comparePeriods` in `lib/analysis/leaks.ts`).
 * - The words come in tiers — better / leaning / no clear change / too few —
 *   each with the sentence that says what it means, so a 30-hand week never
 *   reads as a verdict. The trend is a word and a glyph, never colour alone.
 */

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { comparePeriods, leakKind, periodWindows, type LeakChange, type PeriodComparison, type Trend } from "../../../lib/analysis/leaks";
import type { AnalysisFilters } from "../../../lib/db/analysis";
import { fetchLeaks } from "../../../lib/db/analysisLeaks";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import { EMPTY_LEAKS_STATE, leaksQuery, windowState } from "./leaksState";
import styles from "./leaks.module.css";

const PERIODS = [7, 30] as const;
type Period = (typeof PERIODS)[number];
/** Under this many graded moves in the current period the whole card is a hint. */
const THIN_PERIOD = 50;

const TREND_GLYPH: Record<Trend, string> = {
  better: "▲",
  "leaning-better": "△",
  steady: "–",
  "leaning-worse": "▽",
  worse: "▼",
  "too-few": "·",
};

interface Loaded {
  key: string;
  comparison: PeriodComparison | null;
  windows: ReturnType<typeof periodWindows> | null;
}

export function WhatChanged({ scopeKey, generation }: { scopeKey: string; generation: number }) {
  const t = useDict().analysis.summary;
  const [days, setDays] = useState<Period>(7);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestKey = `${scopeKey}|${days}|${generation}`;

  useEffect(() => {
    let live = true;
    const scope = JSON.parse(scopeKey) as AnalysisFilters;
    (async () => {
      const all = await fetchLeaks(scope);
      if (!all || !all.last) return { key: requestKey, comparison: null, windows: null };
      const windows = periodWindows(all.last, days);
      const [current, prior] = await Promise.all([
        fetchLeaks({ ...scope, from: windows.current.from, to: windows.current.to }),
        fetchLeaks({ ...scope, from: windows.prior.from, to: windows.prior.to }),
      ]);
      if (!current || !prior) return { key: requestKey, comparison: null, windows: null };
      const comparison = comparePeriods(current.rows, prior.rows, { currentHands: current.hands, priorHands: prior.hands });
      return { key: requestKey, comparison, windows };
    })()
      .then((next) => {
        if (!live) return;
        setLoaded(next);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, [scopeKey, days, generation, requestKey]);

  const loading = loaded?.key !== requestKey && !error;
  const comparison = loaded?.comparison ?? null;
  const windows = loaded?.windows ?? null;

  // A leak opens on the Leaks screen over both periods, where it was grouped.
  const leakHref = useMemo(
    () => (id: string) =>
      windows
        ? paths.analysisLeaks(leaksQuery({ ...EMPTY_LEAKS_STATE, ...windowState(windows.prior.from, windows.current.to), leak: id }))
        : paths.analysisLeaks(),
    [windows],
  );

  // Nothing graded at all: the overview already says so.
  if (loaded && !comparison && !loading && !error) return null;

  return (
    <section className={`card stats-group ${styles.summary}`} aria-labelledby="what-changed" aria-busy={loading}>
      <div className={styles.summaryHead}>
        <h3 id="what-changed">
          {t.heading}
        </h3>
        <div className={styles.periodToggle} role="group" aria-label={t.period}>
          {PERIODS.map((period) => (
            <button
              key={period}
              type="button"
              className="btn btn--sm btn--ghost"
              aria-pressed={days === period}
              onClick={() => setDays(period)}
            >
              {t.periods[period]}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="notice notice--error">{t.failed(error)}</p> : null}
      {loading && !comparison ? (
        <p className="muted" role="status">
          {t.loading}
        </p>
      ) : null}
      {comparison && windows ? <Body comparison={comparison} windows={windows} days={days} leakHref={leakHref} /> : null}
    </section>
  );
}

function TrendTag({ trend }: { trend: Trend }) {
  const t = useDict().analysis.summary;
  const tone =
    trend === "better" || trend === "leaning-better"
      ? styles.better
      : trend === "worse" || trend === "leaning-worse"
        ? styles.worse
        : styles.neutral;
  return (
    <span className={`${styles.trendWord} ${tone}`}>
      <span aria-hidden="true">{TREND_GLYPH[trend]}</span>
      {t.trends[trend]}
    </span>
  );
}

function Body({
  comparison,
  windows,
  days,
  leakHref,
}: {
  comparison: PeriodComparison;
  windows: ReturnType<typeof periodWindows>;
  days: number;
  leakHref: (id: string) => string;
}) {
  const en = useDict().analysis;
  const t = en.summary;
  const { overall } = comparison;
  const lastDay = new Date(Date.parse(windows.current.to) - 24 * 60 * 60 * 1000).toISOString();
  return (
    <>
      <p>
        {t.window(days, windows.current.from, lastDay, overall.current.n, overall.prior.n)}{" "}
        <span className="muted">{t.anchorNote}</span>
      </p>
      {overall.current.n < THIN_PERIOD ? <p className="notice notice--warn">{t.thin(overall.current.n)}</p> : null}

      {overall.current.mean !== null && overall.prior.mean !== null ? (
        <p>
          <strong>{t.overall(overall.current.mean, overall.prior.mean)}</strong> <TrendTag trend={overall.trend} />{" "}
          <span className="muted">— {t.trendNotes[overall.trend]}</span>
        </p>
      ) : null}
      {comparison.streets.length > 0 ? (
        <ul className={styles.streetLines}>
          {comparison.streets.map((street) => (
            <li key={street.key}>
              {t.street(en.leaks.streets[street.key] ?? street.key, street.current.mean, street.prior.mean)}{" "}
              <TrendTag trend={street.trend} />
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.changes}>
        <div>
          <h4 className={styles.changeHead}>{t.improvedHeading}</h4>
          {comparison.improved.length === 0 ? (
            <p className="muted">{t.improvedNone}</p>
          ) : (
            <ul className={styles.changeList}>
              {comparison.improved.slice(0, 3).map((change) => (
                <ChangeItem key={change.leak.id} change={change} href={leakHref(change.leak.id)} />
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className={styles.changeHead}>{t.workHeading}</h4>
          {comparison.focus.length === 0 ? (
            <p className="muted">{t.workNone}</p>
          ) : (
            <ul className={styles.changeList}>
              {comparison.focus.map((change) => (
                <ChangeItem key={change.leak.id} change={change} href={leakHref(change.leak.id)} cost />
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className={styles.summaryLinks}>
        <Link href={paths.analysisLeaks()}>{t.allLeaks}</Link>
        <Link href={paths.analysisProgress()}>{t.progress}</Link>
      </p>
    </>
  );
}

function ChangeItem({ change, href, cost = false }: { change: LeakChange; href: string; cost?: boolean }) {
  const en = useDict().analysis;
  const t = en.summary;
  const { leak } = change;
  const title = en.leaks.title(leakKind(leak.attrs.taken, leak.attrs.best), leak.attrs);
  const context = en.leaks.fullContext(leak.attrs, leak.level, leak.partial);
  const name = en.leaks.name(title, context, leak.attrs.street);
  return (
    <li>
      <Link href={href} aria-label={t.openLeak(name)}>
        {title}
      </Link>
      <span className="muted">
        {context} · {en.leaks.streets[leak.attrs.street] ?? leak.attrs.street}
      </span>
      {cost ? <span>{t.cost(change.current.evLossBb, change.current.mistakes, change.current.spot)}</span> : null}
      <span>{t.rate(change.current.mistakes, change.current.spot, change.prior.mistakes, change.prior.spot)}</span>
      <span>
        <TrendTag trend={change.trend} /> <span className="muted">— {t.trendNotes[change.trend]}</span>
      </span>
    </li>
  );
}
