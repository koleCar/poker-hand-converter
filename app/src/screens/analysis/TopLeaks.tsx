/**
 * The three biggest leaks in the app (R5.2's card, R5.4): the web's own
 * ranking and words over the store's sums (`lib/leaksSource.ts`).
 *
 * One card a leak: its rank, name and spot, the EV it costs per 100 hands
 * (its 95% range under it), four figures (how often you went wrong there,
 * what it cost in all, how sure the sample is, the last 30 days against the
 * 30 before), your actions in the spot against the target's as two bars,
 * and up to five example hands as a table whose rows open the hand in the
 * replayer's window. A period toggle (the last 30 days of play, or all
 * time), and the Cash | Tournaments switch: one kind of game's leaks at a
 * time, never both (`lib/gameKind.ts`). The web's longer explanations are
 * the elements' titles.
 */
import type { GameKind } from "@rail/ui/hands/gameKind";
import { KindSwitch } from "@rail/ui/hands/KindSwitch";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import table from "@rail/ui/review/SpotTable.module.css";

import { StateMessage } from "../../components/StateMessage";
import { useLocale, useT } from "../../i18n";
import { liveDateFormat, liveNumberFormat } from "../../i18n/format";
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
  type Leak,
  type TopPeriod,
  type Trend,
} from "../../analysis/leakWords";
import { useAppKind } from "../../lib/gameKind";
import { fetchLeakExamples, fetchTopLeaks, topOf, type LeakExampleRow, type TopLeaksReport, type TopLeakView } from "../../lib/leaksSource";
import { screenHref } from "../../lib/router";
import styles from "./Analysis.module.css";
import { openInReplayer } from "./openHand";

const TREND_GLYPH: Record<Trend, string> = {
  better: "▲",
  "leaning-better": "△",
  steady: "–",
  "leaning-worse": "▽",
  worse: "▼",
  "too-few": "·",
};
const TREND_TONE: Partial<Record<Trend, string>> = {
  better: "up",
  "leaning-better": "up",
  "leaning-worse": "down",
  worse: "down",
};
const CONFIDENCE_GLYPH = { low: "●○○", medium: "●●○", high: "●●●" } as const;
const GRADE_GLYPHS: Record<string, string> = { perfect: "★", good: "✓", inaccurate: "?!", mistake: "?", blunder: "??" };
/** The order the mix bars stack in: passive to aggressive. */
const MIX_ORDER = ["fold", "check", "call", "bet", "raise"] as const;
const WHEN = liveDateFormat({ day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "UTC" });
const BB = liveNumberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ONE = liveNumberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1 });
const COUNT = liveNumberFormat();
const PCT = liveNumberFormat({ style: "percent", maximumFractionDigits: 0 });
/** The examples' columns: date, stakes, position, cards, decision, grade, EV lost. */
const EXAMPLE_COLUMNS = {
  "--spot-columns": "5.5rem 6.5rem 3rem 5.25rem minmax(12rem, 1fr) 7rem 5rem",
  "--spot-min": "44rem",
} as CSSProperties;

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
  const [askedKind, setAskedKind] = useState<GameKind | null>(null);
  const kinds = useAppKind(askedKind, !hidden, reload);
  const gameKind = kinds.kind;
  const key = `${period}|${gameKind ?? ""}|${reload}`;

  useEffect(() => {
    if (hidden || gameKind === null) return;
    let live = true;
    void (async () => {
      try {
        const report = await fetchTopLeaks({ gameKind }, period);
        const top = topOf(report);
        if (live) setLoaded({ status: "ready", key, report, top, examples: null });
        const examples = await fetchLeakExamples(
          { gameKind },
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
  }, [hidden, period, gameKind, key]);

  return (
    <section className={styles.leaks} aria-label={w.top.heading}>
      <div className={styles.leaksHead}>
        <KindSwitch kind={gameKind} counts={kinds.counts} onChange={setAskedKind} />
        <div className={styles.segmented} role="group" aria-label={w.top.period}>
          {TOP_PERIODS.map((value) => (
            <button key={value} type="button" className={styles.segment} aria-pressed={period === value} onClick={() => onPeriod(value)}>
              {w.top.periods[value]}
            </button>
          ))}
        </div>
        {loaded.status === "ready" ? <SampleLine report={loaded.report} period={period} /> : null}
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
        // Another period or kind on its way: the previous list stays, dimmed
        // (rows written by the background run read again without dimming).
        <div className={`${styles.leaksBody} rail-dims`} aria-busy={!loaded.key.startsWith(`${period}|${gameKind ?? ""}|`)}>
          <TopLeaksBody report={loaded.report} top={loaded.top} examples={loaded.examples} period={period} />
        </div>
      )}
    </section>
  );
}

/** What the ranking is read from, in one line; the rule and the window are its title. */
function SampleLine({ report, period }: { report: TopLeaksReport; period: TopPeriod }) {
  const w = useLeakWords();
  const t = useT().analysis.leaks;
  const sample = report.sample;
  const window = period === "30d" ? report.current : null;
  if (sample.graded === 0) return null;
  const title = [window ? w.top.window(window.from, window.to) : null, w.top.rule].filter(Boolean).join("\n\n");
  return (
    <p className={styles.sampleLine} title={title}>
      {t.sample(COUNT.format(sample.graded), COUNT.format(sample.hands))}
    </p>
  );
}

/** The leaks for one answer (exported for the tests). */
export function TopLeaksBody({
  report,
  top,
  examples,
}: {
  report: TopLeaksReport;
  top: readonly TopLeakView[];
  examples: Map<string, LeakExampleRow[]> | null;
  /** The period shown (the card reads the same either way). */
  period: TopPeriod;
}) {
  const w = useLeakWords();
  const sample = report.sample;
  if (sample.graded === 0) return <p className={styles.muted}>{w.top.noneInPeriod}</p>;
  if (top.length === 0) return <p className={styles.muted}>{w.top.none}</p>;
  return (
    <ol className={`${styles.leakList} rail-stagger`}>
      {top.map((entry) => (
        <TopLeakItem key={entry.leak.id} entry={entry} examples={examples?.get(entry.leak.id) ?? null} loading={!examples} />
      ))}
    </ol>
  );
}

function TopLeakItem({
  entry,
  examples,
  loading,
}: {
  entry: TopLeakView;
  examples: LeakExampleRow[] | null;
  loading: boolean;
}) {
  const w = useLeakWords();
  const t = useT().analysis.leaks;
  const { leak, rank, tentative, trend } = entry;
  const title = w.leaks.title(leakKind(leak.attrs.taken, leak.attrs.best), leak.attrs);
  const context = w.leaks.fullContext(leak.attrs, leak.level, leak.partial);
  const street = w.leaks.streets[leak.attrs.street] ?? leak.attrs.street;
  const name = w.leaks.name(title, context, leak.attrs.street);
  const size = leakSize(leak);
  const picked = useMemo(() => (examples ? pickExamples(examples) : []), [examples]);
  const tone = TREND_TONE[trend.trend];
  return (
    <li className={styles.leakCard} aria-label={name}>
      <header className={styles.leakHeader}>
        <span className={styles.leakRank} aria-label={w.top.rank(rank)}>
          {rank}
        </span>
        <div className={styles.leakName}>
          <h3 className={styles.leakTitle}>
            {title}
            {tentative ? (
              <span className={styles.tentative} title={w.top.tentativeNote}>
                {w.top.tentative}
              </span>
            ) : null}
          </h3>
          <p className={styles.leakContext}>
            <span className={styles.streetChip}>{street}</span>
            {context}
          </p>
        </div>
        <div className={styles.leakCost}>
          <span className={styles.leakCostValue}>
            −{BB.format(leak.per100)}
            <span className={styles.leakCostUnit}> {t.per100}</span>
          </span>
          {size ? (
            <span className={styles.leakCostRange}>
              {t.range(BB.format(size.per100Interval.low), BB.format(size.per100Interval.high))}
            </span>
          ) : null}
        </div>
      </header>

      <dl className={styles.leakStats}>
        <div className={styles.leakStat}>
          <dt>{t.mistakes}</dt>
          <dd>
            {size
              ? t.mistakesValue(COUNT.format(leak.mistakes), COUNT.format(leak.spotDecisions), PCT.format(size.rate))
              : COUNT.format(leak.mistakes)}
          </dd>
        </div>
        <div className={styles.leakStat}>
          <dt>{t.total}</dt>
          <dd className={styles.lossText}>−{t.bb(ONE.format(leak.evLossBb))}</dd>
        </div>
        <div className={styles.leakStat}>
          <dt>{t.confidence}</dt>
          <dd title={w.leaks.confidence[leak.confidence]}>
            <span aria-hidden="true" className={styles.confidenceDots}>
              {CONFIDENCE_GLYPH[leak.confidence]}
            </span>{" "}
            {t.confidenceLevels[leak.confidence] ?? leak.confidence}
          </dd>
        </div>
        <div className={styles.leakStat}>
          <dt>{t.trend}</dt>
          <dd
            className={tone === "up" ? styles.upText : tone === "down" ? styles.lossText : undefined}
            title={`${w.top.trendLabel}: ${w.top.trend(trend.now.mistakes, trend.now.spot, trend.was.mistakes, trend.was.spot)}`}
          >
            <span aria-hidden="true">{TREND_GLYPH[trend.trend]}</span> {w.summary.trends[trend.trend]}
          </dd>
        </div>
      </dl>

      <div className={styles.mixes}>
        <MixRow label={t.you} mix={leak.taken} />
        <MixRow label={t.target} mix={leak.best} title={w.top.target(leak.attrs.best)} />
      </div>

      <div className={styles.examplesBlock}>
        <h4 className={styles.examplesHead}>{t.examples}</h4>
        {loading ? <RailLoader size="inline" label={w.top.examplesLoading} showLabel /> : null}
        {!loading && picked.length === 0 ? <p className={styles.muted}>{w.top.examplesNone}</p> : null}
        {picked.length > 0 ? <ExampleTable rows={picked} name={name} /> : null}
      </div>
    </li>
  );
}

/** One side's actions in the spot as a stacked bar, with the words beside it. */
function MixRow({ label, mix, title }: { label: string; mix: Leak["taken"]; title?: string }) {
  const w = useLeakWords();
  const total = MIX_ORDER.reduce((sum, action) => sum + (mix[action] ?? 0), 0);
  return (
    <div className={styles.mixRow} title={title}>
      <span className={styles.mixLabel}>{label}</span>
      <span className={styles.mixBar} aria-hidden="true">
        {total > 0
          ? MIX_ORDER.filter((action) => (mix[action] ?? 0) > 0).map((action) => (
              <span
                key={action}
                className={`${styles.mixPart} ${styles[`mix_${action}`] ?? ""}`}
                style={{ flexGrow: mix[action] ?? 0 }}
              />
            ))
          : null}
      </span>
      <span className={styles.mixWords}>{w.leaks.detail.mix(mix)}</span>
    </div>
  );
}

/** The leak's example hands: the Hands screen's table, each row opening the hand in the replayer. */
function ExampleTable({ rows, name }: { rows: readonly LeakExampleRow[]; name: string }) {
  const w = useLeakWords();
  const dict = useT();
  const t = dict.analysis.leaks;
  const c = t.columns;
  const action = (value: string) => w.leaks.actions[value] ?? value;
  return (
    <div className={table.table} style={EXAMPLE_COLUMNS}>
      <div className={`${table.row} ${table.head}`} aria-hidden="true">
        <span>{c.date}</span>
        <span>{c.stakes}</span>
        <span>{c.position}</span>
        <span>{c.cards}</span>
        <span>{c.decision}</span>
        <span>{c.grade}</span>
        <span className={table.num}>{c.evLoss}</span>
      </div>
      <div className={table.body}>
        {rows.map((row) => (
          <a
            key={`${row.handId}-${row.ord}`}
            className={table.row}
            href={screenHref("hands", row.handId)}
            aria-label={w.top.openHand(row.heroCards.join(" ") || row.handClass || row.handId, name)}
            onClick={(event) => {
              event.preventDefault();
              openInReplayer(row.handId);
            }}
          >
            <span className={table.secondary}>{row.playedAt ? WHEN.format(new Date(row.playedAt)) : "—"}</span>
            <span className={table.secondary}>{row.stakesLabel ?? ""}</span>
            <span className={table.strong}>{row.position ?? ""}</span>
            <span>
              {row.heroCards.length > 0 ? <CardRow cards={row.heroCards} size="xs" /> : <span className={table.dim}>{row.handClass ?? "—"}</span>}
            </span>
            <span>{t.took(action(row.taken), action(row.best))}</span>
            <span>
              {row.grade ? (
                <span className={`${table.grade} ${table[`grade_${row.grade}`] ?? ""}`}>
                  <span aria-hidden="true">{GRADE_GLYPHS[row.grade] ?? ""}</span>
                  {dict.analysis.hand.grades[row.grade] ?? row.grade}
                </span>
              ) : (
                <span className={table.dim}>—</span>
              )}
            </span>
            <span className={`${table.num} ${row.evLossBb !== null && row.evLossBb > 0 ? table.lost : table.dim}`}>
              {row.evLossBb !== null && row.evLossBb > 0 ? `−${BB.format(row.evLossBb)}` : "—"}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
