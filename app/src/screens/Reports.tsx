/**
 * Reports (guideline §6 "Izvještaji": winnings and all-in EV graphs, results
 * by position and situation; R2.7b). One filter row - the Hands screen's
 * chips, with the groups a report sums by, and Reports' own saved filters -
 * over:
 *
 * - the summary: hands, the result in money and in big blinds, bb/100 and
 *   the all-in EV bb/100;
 * - the win-rate graph shared with the web (`@rail/ui/stats/WinrateGraph`):
 *   total, showdown, non-showdown and all-in EV, cumulative over hands, in
 *   big blinds or in money;
 * - every displayed statistic (R2.4 definitions) by group, each with its
 *   reliability (R2.5);
 * - the breakdowns (`reports/Breakdown.tsx`).
 *
 * Every number is the Rust side's (`report`, `report_breakdowns`), the web's
 * arithmetic; money is refused as the web refuses it (chips with cash: no
 * result; two currencies: big blinds only). On a store that mixes game
 * formats the report opens on the format with the most hands, as the web's
 * statistics do.
 */
import { useEffect, useMemo, useState } from "react";
import type { StatGroup as DefinitionGroup } from "@rail/ui/model/stats";
import { StatTable } from "@rail/ui/stats/StatTable";
import { StatValue } from "@rail/ui/stats/StatValue";
import { WinrateGraph, type WinrateGraphMoney } from "@rail/ui/stats/WinrateGraph";

import { StateMessage } from "../components/StateMessage";
import { useLocale, useT } from "../i18n";
import { inApp, ipc, type HandFacets, type Report, type StatsStatus, type Units } from "../lib/ipc";
import { replaceParam, useRouteParam } from "../lib/router";
import { shownOf, statRows, useStatDefinitions } from "../lib/useStatDefinitions";
import {
  EMPTY_FILTER,
  activeGroups,
  onFilterRequested,
  takeRequestedFilter,
  toQuery,
  type FilterState,
} from "./hands/filter";
import { FilterBar, REPORT_GROUPS } from "./hands/FilterBar";
import { bigBlinds, count, signedMoney, unitOf } from "./hands/format";
import { Breakdown, isTab, needsBreakdowns, type Tab } from "./reports/Breakdown";
import styles from "./reports/Reports.module.css";
import { useReport } from "./reports/useReport";

/** The filter, kept while the app runs (leaving Reports and coming back keeps it). */
let lastFilter: FilterState | null = null;

const DEFINITION_GROUPS: DefinitionGroup[] = ["results", "preflop", "postflop", "showdown"];

/** While the statistics rebuild after an upgrade, the report grows as it goes. */
function useRebuild(): StatsStatus | null {
  const [status, setStatus] = useState<StatsStatus | null>(null);
  useEffect(() => {
    if (!inApp) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = () => {
      ipc
        .statsStatus()
        .then((value) => {
          if (stopped) return;
          setStatus(value);
          if (value.activity === "rebuilding") timer = window.setTimeout(poll, 3000);
        })
        .catch(() => undefined);
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);
  return status;
}

/** The game format with the most hands, when the store holds more than one. */
function biggestFormat(facets: HandFacets): string | null {
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

export function Reports() {
  const t = useT();
  const r = t.reports;
  const locale = useLocale();
  const param = useRouteParam();
  const tab: Tab = isTab(param) ? param : "position";
  /** The reader's filter; `null` until they set one (this run of the app). */
  const [chosen, setChosen] = useState<FilterState | null>(() => {
    // A saved filter chosen in the palette (R2.8) replaces the kept one.
    const handed = takeRequestedFilter("reports");
    if (handed) lastFilter = handed;
    return lastFilter;
  });
  const [facetsSeen, setFacetsSeen] = useState<HandFacets | null>(null);
  // A store with tournaments and cash opens on the format with the most
  // hands (the web's `defaultScope`), and says so: the chips' counts decide.
  const defaultFormat = chosen === null && facetsSeen ? biggestFormat(facetsSeen) : null;
  const filter = useMemo(
    () => chosen ?? (defaultFormat ? { ...EMPTY_FILTER, formats: [defaultFormat] } : EMPTY_FILTER),
    [chosen, defaultFormat],
  );
  const setFilter = (next: FilterState) => {
    lastFilter = next;
    setChosen(next);
  };
  useEffect(
    () =>
      onFilterRequested((target) => {
        if (target !== "reports") return;
        const next = takeRequestedFilter("reports");
        if (next) {
          lastFilter = next;
          setChosen(next);
        }
      }),
    [],
  );
  const query = useMemo(() => toQuery(filter), [filter]);
  // The first report waits for the counts that pick its format.
  const state = useReport(query, chosen !== null || facetsSeen !== null);
  const { report, facets, wantBreakdowns } = state;
  if (facets !== null && facetsSeen === null) {
    setFacetsSeen(facets);
  }
  const definitions = useStatDefinitions();
  const rebuild = useRebuild();
  const [unit, setUnit] = useState<"bb" | "money">("bb");

  useEffect(() => {
    if (needsBreakdowns(tab)) wantBreakdowns();
  }, [tab, wantBreakdowns]);

  if (!inApp) {
    return (
      <div className={styles.screen}>
        <h1 className={styles.title}>{t.screens.reports.title}</h1>
        <p className={styles.message}>{r.unavailable}</p>
      </div>
    );
  }

  const money = report ? moneyOf(report.units) : null;
  const shownUnit = unit === "money" && money ? "money" : "bb";
  const filtered = activeGroups(filter) > 0;

  let body;
  if (state.error !== null && report === null) {
    body = <StateMessage kind="error">{r.storeError(state.error)}</StateMessage>;
  } else if (report === null || definitions === null) {
    body = <StateMessage kind="loading">{r.loading}</StateMessage>;
  } else if (report.summary.hands === 0 && report.graph.hands === 0) {
    body = <StateMessage kind="empty">{filtered ? r.noMatch : r.empty}</StateMessage>;
  } else {
    body = (
      <ReportBody
        report={report}
        definitions={definitions}
        locale={locale}
        unit={shownUnit}
        money={money}
        onUnit={setUnit}
      />
    );
  }

  return (
    <div className={styles.screen} aria-busy={state.loading}>
      <header className={styles.top}>
        <h1 className={styles.title}>{t.screens.reports.title}</h1>
        {report ? (
          <span className={styles.count} aria-live="polite">
            {r.count(report.graph.hands)}
          </span>
        ) : null}
      </header>
      <FilterBar filter={filter} facets={facets} onChange={setFilter} groups={REPORT_GROUPS} screen="reports" />
      {defaultFormat !== null ? (
        <p className={styles.notice}>
          {r.defaultFormat((t.hands.filters.formats as Record<string, string>)[defaultFormat] ?? defaultFormat)}
        </p>
      ) : null}
      {rebuild?.activity === "rebuilding" && rebuild.rebuildTotal !== null ? (
        <p className={styles.notice} role="status">
          {r.rebuilding(rebuild.rebuildDone ?? 0, rebuild.rebuildTotal)}
        </p>
      ) : null}
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
          onTab={(next) => replaceParam("reports", next)}
        />
      ) : null}
    </div>
  );
}

function ReportBody({
  report,
  definitions,
  locale,
  unit,
  money,
  onUnit,
}: {
  report: Report;
  definitions: NonNullable<ReturnType<typeof useStatDefinitions>>;
  locale: ReturnType<typeof useLocale>;
  unit: "bb" | "money";
  money: WinrateGraphMoney | null;
  onUnit: (unit: "bb" | "money") => void;
}) {
  const t = useT();
  const r = t.reports;
  const { summary, units } = report;
  const moneyUnit =
    units.currency !== null && units.minorUnits !== null
      ? unitOf({ currency: units.currency, currencySymbol: units.symbol ?? "", minorUnits: units.minorUnits })
      : null;
  const tone = (value: number | null) =>
    value === null || value === 0 ? "" : value > 0 ? styles.up : styles.down;
  const bb100 = shownOf(definitions, summary.stats, "bb_per_100");
  const ev100 = shownOf(definitions, summary.stats, "allin_ev_bb_per_100");

  return (
    <>
      <section className={styles.summary} aria-label={r.summary.label}>
        <dl className={styles.tiles}>
          <div className={styles.tile}>
            <dt>{r.summary.hands}</dt>
            <dd>{count(summary.hands)}</dd>
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
              {summary.netBbMilli !== null ? bigBlinds(summary.netBbMilli) : "—"}
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
              rows={statRows(definitions, summary.stats, locale, (definition) => definition.group === group)}
            />
          ))}
        </div>
        <p className={styles.muted}>{r.stats.note}</p>
      </section>
    </>
  );
}
