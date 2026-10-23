/**
 * A chart set against the hands the user played (R5.3): over a period, how
 * many preflop decisions the chart covers, how many it plays as the user
 * did, where they differ (situation, hand, action, how often) with the hands
 * behind each, and what those deviations cost by Rail's own charts' EVs.
 *
 * The counting is `compare.ts`'; the played cells and the example hands come
 * from the surface (`PreflopChartsSource.played` / `examples`).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { CardRow } from "../cards/PlayingCard";
import { errorText } from "../hands/model";
import { useUiStrings } from "../i18n";
import { dateFormat, numberFormat } from "../stats/format";
import { ChartGrid } from "./ChartGrid";
import { compareChart, type ChartComparison, type Deviation } from "./compare";
import { CLASS_NAMES, parseNodeKey, restActionOf, type ChartSet } from "./model";
import { COMPARE_PERIODS, type ComparePeriod, type CompareQuery, type ExampleHand, type PlayedData, type PreflopChartsSource } from "./source";
import styles from "./Charts.module.css";

export interface ChartHandLinkProps {
  handId: string;
  /** The decision to open at (`PhfAction.index`). */
  actionIndex: number;
  label: string;
  className: string;
  children: ReactNode;
}

export interface ChartCompareProps {
  set: ChartSet;
  source: PreflopChartsSource;
  renderHandLink: (props: ChartHandLinkProps) => ReactNode;
  /** Open the editor at a situation the chart leaves empty. */
  onFill?: (key: string) => void;
  period?: ComparePeriod;
  onPeriod?: (period: ComparePeriod) => void;
}

type Loaded = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; key: string; data: PlayedData };

export function queryOf(set: ChartSet, period: ComparePeriod): CompareQuery {
  return { period, gameFormat: set.gameFormat, tableSize: set.tableSize, stackMinBb: set.stackMinBb, stackMaxBb: set.stackMaxBb };
}

export function ChartCompare({ set, source, renderHandLink, onFill, period: periodProp, onPeriod }: ChartCompareProps) {
  const t = useUiStrings().charts;
  const [ownPeriod, setOwnPeriod] = useState<ComparePeriod>("90d");
  const period = periodProp ?? ownPeriod;
  const query = queryOf(set, period);
  const key = JSON.stringify(query);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    let live = true;
    const asked = JSON.parse(key) as CompareQuery;
    source.played(asked).then(
      (data) => {
        if (live) setLoaded({ status: "ready", key, data });
      },
      (error) => {
        if (live) setLoaded({ status: "error", message: errorText(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [key, source]);

  const comparison = useMemo(
    () => (loaded.status === "ready" ? compareChart(set, loaded.data.cells) : null),
    [loaded, set],
  );

  const choose = (next: ComparePeriod) => {
    setOwnPeriod(next);
    onPeriod?.(next);
  };

  return (
    <section
      className={styles.card}
      aria-labelledby="charts-compare"
      aria-busy={loaded.status === "loading" || (loaded.status === "ready" && loaded.key !== key)}
    >
      <h2 id="charts-compare" className={styles.cardTitle}>
        {t.compare.heading}
      </h2>
      <div className={styles.chips} role="group" aria-label={t.compare.period}>
        {COMPARE_PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            className={`btn btn--sm${p === period ? " btn--primary" : ""}`}
            aria-pressed={p === period}
            onClick={() => choose(p)}
          >
            {t.compare.periods[p]}
          </button>
        ))}
      </div>
      <p className={styles.muted}>{t.compare.scope}</p>
      {loaded.status === "loading" ? <p className={styles.muted}>{t.compare.loading}</p> : null}
      {loaded.status === "error" ? (
        <p className={styles.warning} role="alert">
          {t.error(loaded.message)}
        </p>
      ) : null}
      {loaded.status === "ready" && comparison ? (
        <CompareView
          set={set}
          data={loaded.data}
          comparison={comparison}
          query={query}
          source={source}
          renderHandLink={renderHandLink}
          onFill={onFill}
        />
      ) : null}
    </section>
  );
}

export interface CompareViewProps {
  set: ChartSet;
  data: PlayedData;
  comparison: ChartComparison;
  query: CompareQuery;
  source: PreflopChartsSource;
  renderHandLink: (props: ChartHandLinkProps) => ReactNode;
  onFill?: (key: string) => void;
}

/** The loaded comparison. Pure but for the examples it asks for (the tests render it). */
export function CompareView({ set, data, comparison, query, source, renderHandLink, onFill }: CompareViewProps) {
  const ui = useUiStrings();
  const t = ui.charts;
  const locale = ui.intlLocale;
  const pct = numberFormat(locale, { maximumFractionDigits: 1 });
  const bb = numberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const day = dateFormat(locale, { day: "numeric", month: "short", year: "numeric" });
  const [selected, setSelected] = useState<string | null>(comparison.nodes[0]?.key ?? null);
  const label = (key: string) => {
    const parsed = parseNodeKey(key);
    return parsed ? t.situation.label(parsed.scenario, parsed.hero, parsed.vs) : key;
  };
  const off = comparison.decisions - comparison.onChart;
  const node = comparison.nodes.find((n) => n.key === selected) ?? null;

  if (comparison.decisions === 0 && comparison.missing.length === 0) {
    return <p className={styles.muted}>{t.compare.nothing}</p>;
  }

  return (
    <div className={styles.compare}>
      {data.from && data.to ? (
        <p className={styles.muted}>{t.compare.periodNote(day.format(new Date(data.from)), day.format(new Date(data.to)))}</p>
      ) : null}
      <dl className={styles.tiles}>
        <div className={styles.tile}>
          <dt>{t.compare.tiles.decisions}</dt>
          <dd>{comparison.decisions.toLocaleString(locale)}</dd>
        </div>
        <div className={styles.tile}>
          <dt>{t.compare.tiles.followed}</dt>
          <dd>
            {comparison.decisions > 0
              ? t.compare.followedValue(pct.format((comparison.onChart / comparison.decisions) * 100))
              : "—"}
          </dd>
        </div>
        <div className={styles.tile}>
          <dt>{t.compare.tiles.off}</dt>
          <dd>{off.toLocaleString(locale)}</dd>
        </div>
        <div className={styles.tile}>
          <dt>{t.compare.tiles.cost}</dt>
          <dd>{t.compare.costValue(bb.format(comparison.offEvLossBb))}</dd>
          <dd className={styles.tileNote}>{t.compare.costNote}</dd>
        </div>
      </dl>

      {comparison.nodes.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.caption}>{t.compare.situations}</caption>
            <thead>
              <tr>
                <th scope="col">{t.compare.columns.situation}</th>
                <th scope="col">{t.compare.columns.decisions}</th>
                <th scope="col">{t.compare.columns.followed}</th>
                <th scope="col">{t.compare.columns.top}</th>
              </tr>
            </thead>
            <tbody>
              {comparison.nodes.map((n) => {
                const top = n.deviations[0];
                return (
                  <tr key={n.key} aria-selected={n.key === selected}>
                    <th scope="row">
                      <button
                        type="button"
                        className={`btn btn--sm btn--ghost${n.key === selected ? ` ${styles.rowSelected}` : ""}`}
                        aria-pressed={n.key === selected}
                        onClick={() => setSelected(n.key)}
                      >
                        {label(n.key)}
                      </button>
                    </th>
                    <td>{n.decisions.toLocaleString(locale)}</td>
                    <td>{t.compare.followedValue(pct.format((n.onChart / n.decisions) * 100))}</td>
                    <td>
                      {top ? t.compare.deviation(top.className, t.actions[top.action], top.decisions) : t.compare.noDeviation}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {comparison.missing.length > 0 ? (
        <div className={styles.missing}>
          <p className={styles.muted}>{t.compare.missing(comparison.missing.length)}</p>
          <ul className={styles.missingList}>
            {comparison.missing.slice(0, 12).map((m) => (
              <li key={m.key}>
                <span>{t.compare.missingItem(label(m.key), m.decisions)}</span>
                {onFill ? (
                  <button type="button" className="btn btn--sm" onClick={() => onFill(m.key)}>
                    {t.compare.fill}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {comparison.unnamed > 0 ? <p className={styles.muted}>{t.compare.unnamed(comparison.unnamed)}</p> : null}

      {node ? (
        <NodeDetail
          key={node.key}
          set={set}
          nodeKey={node.key}
          comparison={comparison}
          query={query}
          source={source}
          renderHandLink={renderHandLink}
          label={label(node.key)}
        />
      ) : null}
    </div>
  );
}

function NodeDetail({
  set,
  nodeKey,
  comparison,
  query,
  source,
  renderHandLink,
  label,
}: {
  set: ChartSet;
  nodeKey: string;
  comparison: ChartComparison;
  query: CompareQuery;
  source: PreflopChartsSource;
  renderHandLink: (props: ChartHandLinkProps) => ReactNode;
  label: string;
}) {
  const ui = useUiStrings();
  const t = ui.charts;
  const locale = ui.intlLocale;
  const pct = numberFormat(locale, { maximumFractionDigits: 1 });
  const bb = numberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const when = dateFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const n = comparison.nodes.find((x) => x.key === nodeKey)!;
  const chart = set.nodes.get(nodeKey) ?? null;
  const parsed = parseNodeKey(nodeKey);
  const rest = parsed ? restActionOf(parsed) : "fold";
  const [picked, setPicked] = useState<Deviation | null>(null);
  const [examples, setExamples] = useState<{ for: Deviation; hands: ExampleHand[] | null; error: string | null } | null>(null);

  const show = (d: Deviation) => {
    setPicked(d);
    setExamples({ for: d, hands: null, error: null });
    source.examples(query, d.key, d.cls, d.action, 5).then(
      (hands) => setExamples((current) => (current?.for === d ? { for: d, hands, error: null } : current)),
      (error) => setExamples((current) => (current?.for === d ? { for: d, hands: [], error: errorText(error) } : current)),
    );
  };

  return (
    <section className={styles.detail} aria-labelledby="charts-detail">
      <h3 id="charts-detail" className={styles.detailTitle}>
        {t.compare.detail.heading(label)}
      </h3>
      <p className={styles.fieldLabel}>{t.compare.detail.mix}</p>
      <ul className={styles.mix}>
        {n.mix.map((m) => (
          <li key={m.action}>
            <span className={`${styles.dot} ${styles[`dot_${m.action}`] ?? ""}`} aria-hidden="true" />
            {t.compare.detail.mixRow(
              t.actions[m.action],
              pct.format((m.played / n.decisions) * 100),
              pct.format((m.expected / n.decisions) * 100),
            )}
          </li>
        ))}
      </ul>
      <p className={styles.muted}>{t.compare.detail.grid}</p>
      <ChartGrid
        node={chart}
        rest={rest}
        label={t.grid.label(label)}
        marks={n.classes.map((c) => c.off)}
        selected={picked?.cls ?? null}
        onSelect={(cls) => {
          const first = n.deviations.find((d) => d.cls === cls);
          if (first) show(first);
        }}
      />
      <h4 className={styles.subTitle}>{t.compare.detail.deviations}</h4>
      {n.deviations.length === 0 ? <p className={styles.muted}>{t.compare.detail.none}</p> : null}
      {n.deviations.length > 0 ? (
        <ul className={styles.deviations}>
          {n.deviations.slice(0, 20).map((d) => (
            <li key={`${d.cls}-${d.action}`}>
              <button
                type="button"
                className={`btn btn--sm btn--ghost ${styles.deviation}`}
                aria-pressed={picked === d}
                onClick={() => show(d)}
              >
                <span>
                  {t.compare.detail.row(
                    d.className,
                    t.compare.detail.did[d.action],
                    d.decisions,
                    t.compare.detail.does[d.chartAction],
                    pct.format(d.chartPercent),
                  )}
                </span>
                {d.evLossBb >= 0.05 ? <span className={styles.loss}>{t.compare.detail.evLoss(bb.format(d.evLossBb))}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {examples ? (
        <div className={styles.examples} aria-live="polite">
          <h4 className={styles.subTitle}>
            {t.compare.detail.examples}: {t.compare.detail.examplesFor(CLASS_NAMES[examples.for.cls], t.compare.detail.did[examples.for.action])}
          </h4>
          {examples.error ? <p className={styles.warning}>{t.error(examples.error)}</p> : null}
          {examples.hands === null ? <p className={styles.muted}>{t.compare.loading}</p> : null}
          {examples.hands && examples.hands.length === 0 && !examples.error ? (
            <p className={styles.muted}>{t.compare.detail.noExamples}</p>
          ) : null}
          {examples.hands && examples.hands.length > 0 ? (
            <ol className={styles.exampleList}>
              {examples.hands.map((hand) => {
                const at = hand.playedAt ? when.format(new Date(hand.playedAt)) : "—";
                return (
                  <li key={hand.handId}>
                    {renderHandLink({
                      handId: hand.handId,
                      actionIndex: hand.actionIndex,
                      label: t.compare.detail.open(hand.heroCards.join(" "), at),
                      className: styles.example,
                      children: (
                        <>
                          {hand.heroCards.length > 0 ? <CardRow cards={hand.heroCards} size="xs" /> : null}
                          <span>{at}</span>
                          <span className={styles.muted}>{hand.stakesLabel ?? ""}</span>
                          {hand.evLossBb !== null && hand.evLossBb >= 0.05 ? (
                            <span className={styles.loss}>{t.compare.detail.evLoss(bb.format(hand.evLossBb))}</span>
                          ) : null}
                        </>
                      ),
                    })}
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
