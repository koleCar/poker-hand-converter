/**
 * Reports (guideline §6 "Izvještaji": winnings and all-in EV graphs, results
 * by position and situation), on both surfaces (R4.5c). One filter row - the
 * Hands screen's chips, with the groups a report sums by, and Reports' own
 * saved filters where the surface keeps them - over:
 *
 * - the summary: hands, the result in money and in big blinds, bb/100 and
 *   the all-in EV bb/100;
 * - the win-rate graph (`stats/WinrateGraph`): total, showdown,
 *   non-showdown and all-in EV, cumulative over hands, in big blinds or in
 *   money;
 * - every displayed statistic (R2.4 definitions) by group, each with its
 *   reliability (R2.5), the user's own (R2.10, the desktop's) among them,
 *   marked;
 * - the breakdowns (`Breakdown.tsx`).
 *
 * Every number is the surface's `ReportSource`'s (the desktop's store, the
 * web's server summaries), in the R2.4 `Shown` shape; money is refused as
 * the web always refused it (chips with cash: no result; two currencies: big
 * blinds only). On a library that mixes game formats the report opens on
 * the format with the most hands.
 *
 * The desktop app's screen (R2.7b, `app/src/screens/Reports.tsx` before
 * R4.5c), lifted out of it: the filter, the tab and where they live (the
 * app's route and memory, the web's page state) are the surface's, and so
 * are the notices, the empty text and the states' look; the web adds its
 * own panels in the two slots (`afterSummary`, `footer`).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { FilterBar, REPORT_GROUPS } from "../hands/FilterBar";
import { EMPTY_FILTER, activeGroups, toQuery, type FilterState } from "../hands/filter";
import { bigBlindsIn, countIn, signedMoney, unitOf } from "../hands/format";
import type { HandFacets, HandFilter } from "../hands/model";
import { useUiStrings } from "../i18n";
import type { StatGroup as DefinitionGroup } from "../model/stats";
import { StatTable } from "../stats/StatTable";
import { StatValue } from "../stats/StatValue";
import { WinrateGraph, type WinrateGraphMoney } from "../stats/WinrateGraph";
import { Breakdown, isTab, needsBreakdowns, type Tab } from "./Breakdown";
import { shownOf, statRows, textLocale } from "./definitions";
import type { Definition, Report, ReportSource, Units } from "./model";
import styles from "./Reports.module.css";
import { useReport } from "./useReport";

export { isTab, type Tab };

const DEFINITION_GROUPS: DefinitionGroup[] = ["results", "preflop", "postflop", "showdown"];

/** The game format with the most hands, when the library holds more than one. */
export function biggestFormat(facets: HandFacets): string | null {
  const formats = facets.formats.filter((format) => format.value !== "" && format.count > 0);
  if (formats.length < 2) return null;
  return [...formats].sort((a, b) => b.count - a.count)[0]?.value ?? null;
}

/** The money view's currency, when the sample has one. */
function moneyOf(units: Units): WinrateGraphMoney | null {
  if (units.mixedKind || units.mixedCurrency || units.currency === null || units.minorUnits === null) {
    return null;
  }
  const unit = unitOf({ currency: units.currency, currencySymbol: units.symbol ?? "", minorUnits: units.minorUnits });
  const minorUnits = units.minorUnits;
  return { minorUnits, format: (amount: number) => signedMoney(unit, Math.round(amount * minorUnits)) };
}

export interface ReportsScreenProps {
  source: ReportSource;
  /** The definitions every `stats` list is matched to; `null` while they load. */
  definitions: readonly Definition[] | null;
  /** The reader's filter; `null` until they set one (the screen then opens on the biggest format). */
  chosen: FilterState | null;
  onChoose: (filter: FilterState) => void;
  tab: Tab;
  onTab: (tab: Tab) => void;
  /** The heading's words, and its level on the surface's page. */
  title: string;
  titleTag?: "h1" | "h2";
  /** Under the filters: the surface's lines (a recompute, a rebuild). */
  notice?: ReactNode;
  /** No hands at all, in the surface's words. */
  emptyText: string;
  /** The loading, empty and error states, in the surface's own look. */
  renderState: (kind: "loading" | "empty" | "error", text: string) => ReactNode;
  /** Hide the starting hands (the desktop while a poker table is open). */
  hideHandChart?: boolean;
  /** Between the summary and the graph: the surface's own panel (the web's HUD tiles). */
  afterSummary?: (report: Report) => ReactNode;
  /** After the breakdowns: the surface's own panels over the same filter (the web's sessions and opponents). */
  footer?: (query: HandFilter, report: Report | null) => ReactNode;
  /** A new value reads everything again (the web's rebuild finishing). */
  reloadToken?: unknown;
}

export function ReportsScreen({
  source,
  definitions,
  chosen,
  onChoose,
  tab,
  onTab,
  title,
  titleTag: Title = "h1",
  notice,
  emptyText,
  renderState,
  hideHandChart = false,
  afterSummary,
  footer,
  reloadToken = 0,
}: ReportsScreenProps) {
  const ui = useUiStrings();
  const r = ui.reports;
  const [facetsSeen, setFacetsSeen] = useState<HandFacets | null>(null);
  // A library with tournaments and cash opens on the format with the most
  // hands (the web's old `defaultScope`), and says so: the chips' counts decide.
  const defaultFormat = chosen === null && facetsSeen ? biggestFormat(facetsSeen) : null;
  const filter = useMemo(
    () => chosen ?? (defaultFormat ? { ...EMPTY_FILTER, formats: [defaultFormat] } : EMPTY_FILTER),
    [chosen, defaultFormat],
  );
  const query = useMemo(() => toQuery(filter), [filter]);
  // The first report waits for the counts that pick its format.
  const state = useReport(source, query, chosen !== null || facetsSeen !== null, reloadToken);
  const { report, facets, wantBreakdowns } = state;
  if (facets !== null && facetsSeen === null) {
    setFacetsSeen(facets);
  }
  const [unit, setUnit] = useState<"bb" | "money">("bb");

  useEffect(() => {
    if (needsBreakdowns(tab)) wantBreakdowns();
  }, [tab, wantBreakdowns]);

  const money = report ? moneyOf(report.units) : null;
  const shownUnit = unit === "money" && money ? "money" : "bb";
  const filtered = activeGroups(filter) > 0;

  let body;
  if (state.error !== null && report === null) {
    body = renderState("error", r.storeError(state.error));
  } else if (report === null || definitions === null) {
    body = renderState("loading", r.loading);
  } else if (report.summary.hands === 0 && report.graph.hands === 0) {
    body = renderState("empty", filtered ? r.noMatch : emptyText);
  } else {
    body = (
      <ReportBody
        report={report}
        definitions={definitions}
        unit={shownUnit}
        money={money}
        onUnit={setUnit}
        afterSummary={afterSummary}
      />
    );
  }

  return (
    <div className={styles.screen} aria-busy={state.loading}>
      <header className={styles.top}>
        <Title className={styles.title}>{title}</Title>
        {report ? (
          <span className={styles.count} aria-live="polite">
            {r.count(report.graph.hands)}
          </span>
        ) : null}
      </header>
      <FilterBar
        filter={filter}
        facets={facets}
        onChange={onChoose}
        groups={REPORT_GROUPS}
        screen="reports"
        saved={source.savedFilters}
      />
      {defaultFormat !== null ? (
        <p className={styles.notice}>
          {r.defaultFormat((ui.hands.filters.formats as Record<string, string>)[defaultFormat] ?? defaultFormat)}
        </p>
      ) : null}
      {notice}
      {report?.units.mixedKind ? <p className={styles.warning}>{r.units.mixedKind}</p> : null}
      {report && !report.units.mixedKind && report.units.mixedCurrency ? (
        <p className={styles.notice}>{r.units.mixedCurrency}</p>
      ) : null}
      {report && report.graph.allInEv.pending > 0 ? (
        <p className={styles.notice} role="status">
          {r.evPending(report.graph.allInEv.pending)}
        </p>
      ) : null}
      {body}
      {report && definitions && (report.summary.hands > 0 || report.graph.hands > 0) ? (
        <Breakdown
          report={report}
          breakdowns={state.breakdowns}
          loading={state.breakdownsLoading}
          definitions={definitions}
          facets={facets}
          tab={tab}
          onTab={onTab}
          hideHandChart={hideHandChart}
        />
      ) : null}
      {footer ? footer(query, report) : null}
    </div>
  );
}

function ReportBody({
  report,
  definitions,
  unit,
  money,
  onUnit,
  afterSummary,
}: {
  report: Report;
  definitions: readonly Definition[];
  unit: "bb" | "money";
  money: WinrateGraphMoney | null;
  onUnit: (unit: "bb" | "money") => void;
  afterSummary?: (report: Report) => ReactNode;
}) {
  const ui = useUiStrings();
  const r = ui.reports;
  const locale = textLocale(ui.intlLocale);
  const { summary, units } = report;
  const moneyUnit =
    units.currency !== null && units.minorUnits !== null
      ? unitOf({ currency: units.currency, currencySymbol: units.symbol ?? "", minorUnits: units.minorUnits })
      : null;
  const tone = (value: number | null) =>
    value === null || value === 0 ? "" : value > 0 ? styles.up : styles.down;
  // The user's own statistics (R2.10) are listed with the shipped ones of
  // their group, their names marked.
  const marked = definitions.map((definition) =>
    definition.custom
      ? {
          ...definition,
          name: { en: r.stats.yours(definition.name.en), hr: r.stats.yours(definition.name.hr) },
        }
      : definition,
  );
  const bb100 = shownOf(definitions, summary.stats, "bb_per_100", summary.ids);
  const ev100 = shownOf(definitions, summary.stats, "allin_ev_bb_per_100", summary.ids);

  return (
    <>
      <section className={styles.summary} aria-label={r.summary.label}>
        <dl className={styles.tiles}>
          <div className={styles.tile}>
            <dt>{r.summary.hands}</dt>
            <dd>{countIn(ui.intlLocale, summary.hands)}</dd>
          </div>
          <div className={styles.tile}>
            <dt>{r.summary.result}</dt>
            <dd className={tone(summary.net)}>
              {summary.net !== null && moneyUnit ? signedMoney(moneyUnit, summary.net) : "—"}
            </dd>
          </div>
          <div className={styles.tile}>
            <dt>{r.summary.netBb}</dt>
            <dd className={tone(summary.netBbMilli)}>
              {summary.netBbMilli !== null ? bigBlindsIn(ui.intlLocale, summary.netBbMilli) : "—"}
            </dd>
          </div>
          {bb100 ? (
            <div className={styles.tile}>
              <dt title={bb100.definition.description[locale]}>{r.summary.bb100}</dt>
              <dd className={tone(bb100.shown.value)}>
                <StatValue shown={bb100.shown} unit={bb100.definition.format.unit} />
              </dd>
            </div>
          ) : null}
          {ev100 ? (
            <div className={styles.tile}>
              <dt title={ev100.definition.description[locale]}>{r.summary.evBb100}</dt>
              <dd className={tone(ev100.shown.value)}>
                <StatValue shown={ev100.shown} unit={ev100.definition.format.unit} />
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      {afterSummary ? afterSummary(report) : null}

      <section className={styles.card} aria-labelledby="reports-graph">
        <div className={styles.cardHead}>
          <h2 id="reports-graph" className={styles.cardTitle}>
            {r.graph.heading}
          </h2>
          <div className={styles.toggle} role="group" aria-label={r.graph.unit}>
            <button
              type="button"
              className={`chip-btn${unit === "bb" ? " is-active" : ""}`}
              aria-pressed={unit === "bb"}
              onClick={() => onUnit("bb")}
            >
              {r.graph.bigBlinds}
            </button>
            <button
              type="button"
              className={`chip-btn${unit === "money" ? " is-active" : ""}`}
              aria-pressed={unit === "money"}
              disabled={money === null}
              onClick={() => onUnit("money")}
            >
              {r.graph.money}
            </button>
          </div>
        </div>
        <WinrateGraph graph={report.graph} unit={unit} money={money} />
      </section>

      <section className={styles.card} aria-labelledby="reports-stats">
        <div className={styles.cardHead}>
          <h2 id="reports-stats" className={styles.cardTitle}>
            {r.stats.heading}
          </h2>
        </div>
        <div className={styles.statGroups}>
          {DEFINITION_GROUPS.map((group) => (
            <StatTable
              key={group}
              caption={r.stats.groups[group]}
              showCaption
              rows={statRows(
                marked,
                summary.stats,
                locale,
                (definition) => definition.group === group,
                summary.ids,
              )}
            />
          ))}
        </div>
        <p className={styles.muted}>{r.stats.note}</p>
      </section>
    </>
  );
}
