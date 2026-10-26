/**
 * The three biggest leaks in the app (R5.2's card, R5.4): the web's own
 * ranking and words over the store's sums (`lib/leaksSource.ts`). Each leak
 * with its EV lost per 100 hands and its 95% range, how often and how sure,
 * the target, the last 30 days against the 30 before, and up to five
 * example hands that open the hand's grades at the decision. A period
 * toggle (the last 30 days of play, or all time). The web's card also links
 * to its full leak report, which the app does not have.
 */
import { useEffect, useMemo, useState } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";

import { StateMessage } from "../../components/StateMessage";
import { useLocale, useT } from "../../i18n";
import { liveDateFormat } from "../../i18n/format";
import {
  EXAMPLES_FETCH,
  leakKind,
  leakSize,
  leaksEn,
  leaksHr,
  pickExamples,
  summaryEn,
  summaryHr,
  TOP_PERIODS,
  topLeaksEn,
  topLeaksHr,
  type TopPeriod,
  type Trend,
} from "../../analysis/leakWords";
import { fetchLeakExamples, fetchTopLeaks, topOf, type LeakExampleRow, type TopLeaksReport, type TopLeakView } from "../../lib/leaksSource";
import { screenHref } from "../../lib/router";
import styles from "./Analysis.module.css";
import { viewParam } from "./view";

const TREND_GLYPH: Record<Trend, string> = {
  better: "▲",
  "leaning-better": "△",
  steady: "–",
  "leaning-worse": "▽",
  worse: "▼",
  "too-few": "·",
};
const CONFIDENCE_GLYPH = { low: "●○○", medium: "●●○", high: "●●●" } as const;
const WHEN = liveDateFormat({ day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "UTC" });

/** The web's words for the leaks, in the app's language. */
function useLeakWords() {
  const locale = useLocale();
  return locale === "hr"
    ? { top: topLeaksHr, leaks: leaksHr, summary: summaryHr }
    : { top: topLeaksEn, leaks: leaksEn, summary: summaryEn };
}

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; key: string; report: TopLeaksReport; top: TopLeakView[]; examples: Map<string, LeakExampleRow[]> | null };

export function TopLeaks({
  hidden,
  reload,
  period,
  onPeriod,
}: {
  hidden: boolean;
  reload: number;
  period: TopPeriod;
  onPeriod: (period: TopPeriod) => void;
}) {
  const w = useLeakWords();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const key = `${period}|${reload}`;

  useEffect(() => {
    if (hidden) return;
    let live = true;
    void (async () => {
      try {
        const report = await fetchTopLeaks({}, period);
        const top = topOf(report);
        if (live) setLoaded({ status: "ready", key, report, top, examples: null });
        const examples = await fetchLeakExamples(
          {},
          top.map(({ leak }) => ({ id: leak.id, keys: leak.keys })),
          period === "30d" ? report.current : null,
          EXAMPLES_FETCH,
        );
        if (live) setLoaded({ status: "ready", key, report, top, examples });
      } catch (error) {
        if (live) setLoaded({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [hidden, period, key]);

  return (
    <section className={styles.leaks} aria-labelledby="top-leaks">
      <div className={styles.leaksHead}>
        <h2 id="top-leaks" className={styles.subheading}>
          {w.top.heading}
        </h2>
        <div className={styles.periods} role="group" aria-label={w.top.period}>
          {TOP_PERIODS.map((value) => (
            <button
              key={value}
              type="button"
              className={styles.button}
              aria-pressed={period === value}
              onClick={() => onPeriod(value)}
            >
              {w.top.periods[value]}
            </button>
          ))}
        </div>
      </div>
      {loaded.status === "loading" ? (
        <StateMessage kind="loading" compact>
          {w.top.loading}
        </StateMessage>
      ) : loaded.status === "error" ? (
        <StateMessage kind="error" compact>
          {w.top.failed(loaded.message)}
        </StateMessage>
      ) : (
        <TopLeaksBody report={loaded.report} top={loaded.top} examples={loaded.examples} period={period} />
      )}
    </section>
  );
}

/** The card's body for one answer (exported for the tests). */
export function TopLeaksBody({
  report,
  top,
  examples,
  period,
}: {
  report: TopLeaksReport;
  top: readonly TopLeakView[];
  examples: Map<string, LeakExampleRow[]> | null;
  period: TopPeriod;
}) {
  const w = useLeakWords();
  const sample = report.sample;
  const window = period === "30d" ? report.current : null;
  return (
    <>
      <p className={styles.summary}>
        {sample.graded > 0 ? w.top.sample(sample.graded, sample.hands) : w.top.noneInPeriod}{" "}
        {window ? <span className={styles.muted}>{w.top.window(window.from, window.to)}</span> : null}
      </p>
      <p className={styles.muted}>{w.top.rule}</p>
      {sample.graded > 0 && top.length === 0 ? <p className={styles.muted}>{w.top.none}</p> : null}
      {top.length > 0 ? (
        <ol className={styles.decisions}>
          {top.map((entry) => (
            <TopLeakItem key={entry.leak.id} entry={entry} examples={examples?.get(entry.leak.id) ?? null} loading={!examples} period={period} />
          ))}
        </ol>
      ) : null}
    </>
  );
}

function TopLeakItem({
  entry,
  examples,
  loading,
  period,
}: {
  entry: TopLeakView;
  examples: LeakExampleRow[] | null;
  loading: boolean;
  period: TopPeriod;
}) {
  const w = useLeakWords();
  const t = useT();
  const { leak, rank, tentative, trend } = entry;
  const title = w.leaks.title(leakKind(leak.attrs.taken, leak.attrs.best), leak.attrs);
  const context = w.leaks.fullContext(leak.attrs, leak.level, leak.partial);
  const name = w.leaks.name(title, context, leak.attrs.street);
  const size = leakSize(leak);
  const picked = useMemo(() => (examples ? pickExamples(examples) : []), [examples]);
  return (
    <li className={styles.decision} aria-label={name}>
      <h3 className={styles.leakTitle}>
        <span className={styles.muted}>{w.top.rank(rank)}</span> {title}{" "}
        <span className={styles.muted}>
          {context} · {w.leaks.streets[leak.attrs.street] ?? leak.attrs.street}
        </span>
        {tentative ? <span className={styles.statusWarn}> {w.top.tentative}</span> : null}
      </h3>
      <p>
        <strong>{w.top.per100(leak.per100)}</strong>
        {size ? <span className={styles.muted}> {w.top.per100Range(size.per100Interval.low, size.per100Interval.high)}</span> : null}
        <span className={styles.muted}> · {w.top.total(leak.evLossBb)}</span>
      </p>
      <p>
        {size ? w.top.how(leak.mistakes, leak.spotDecisions, size.rate, size.rateInterval.low, size.rateInterval.high) : null}{" "}
        <span className={styles.muted}>
          <span aria-hidden="true">{CONFIDENCE_GLYPH[leak.confidence]}</span> {w.leaks.confidence[leak.confidence]}
        </span>
      </p>
      {tentative ? <p className={styles.note}>{w.top.tentativeNote}</p> : null}
      <p>
        <strong>{w.top.target(leak.attrs.best)}</strong>
      </p>
      <p>
        <span className={styles.muted}>{w.top.you}: </span>
        {w.leaks.detail.mix(leak.taken)}
      </p>
      <p>
        <span className={styles.muted}>{w.top.reference}: </span>
        {w.leaks.detail.mix(leak.best)}
      </p>
      <p>
        <span className={styles.muted}>{w.top.trendLabel}: </span>
        {w.top.trend(trend.now.mistakes, trend.now.spot, trend.was.mistakes, trend.was.spot)}{" "}
        <span>
          <span aria-hidden="true">{TREND_GLYPH[trend.trend]}</span> {w.summary.trends[trend.trend]}
        </span>
      </p>
      <h4 className={styles.examplesHead}>{w.top.examples}</h4>
      {loading ? <p className={styles.muted}>{w.top.examplesLoading}</p> : null}
      {!loading && picked.length === 0 ? <p className={styles.muted}>{w.top.examplesNone}</p> : null}
      {picked.length > 0 ? (
        <>
          <p className={styles.muted}>{w.top.examplesNote}</p>
          <ul className={styles.examples}>
            {picked.map((row) => (
              <li key={`${row.handId}-${row.ord}`} className={styles.example}>
                <a
                  className={styles.link}
                  href={screenHref(
                    "analysis",
                    viewParam({ kind: "hand", key: row.handId, actionIndex: row.actionIndex, back: viewParam({ kind: "leaks", period }) }),
                  )}
                  aria-label={w.top.openHand(row.heroCards.join(" ") || row.handClass || row.handId, name)}
                >
                  {row.heroCards.length > 0 ? <CardRow cards={row.heroCards} size="xs" /> : (row.handClass ?? "")}
                </a>
                <span className={styles.muted}>{row.position ?? ""}</span>
                <span>{w.leaks.hands.took(w.leaks.actions[row.taken] ?? row.taken, w.leaks.actions[row.best] ?? row.best)}</span>
                {row.grade ? <span className={`${styles.grade} ${styles[`grade-${row.grade}`] ?? ""}`}>{t.analysis.hand.grades[row.grade] ?? row.grade}</span> : null}
                {row.evLossBb !== null && row.evLossBb > 0 ? <span>{w.top.evLoss(row.evLossBb)}</span> : null}
                <span className={styles.muted}>{row.playedAt ? WHEN.format(new Date(row.playedAt)) : ""}</span>
                {row.stakesLabel ? <span className={styles.muted}>{row.stakesLabel}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </li>
  );
}
