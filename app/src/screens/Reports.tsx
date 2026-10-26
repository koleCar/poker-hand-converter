/**
 * Reports (guideline §6 "Izvještaji"; R2.7b). Since R4.5c the screen itself
 * is the shared package's (`@rail/ui/reports/ReportsScreen`), which the web's
 * `/stats` renders too; this is the app's side of it: the store as its
 * `ReportSource`, the definitions (the shipped ones and the user's own), the
 * tab in the address (`#/reports/<tab>`, which is how the command palette
 * opens one), the filter kept while the app runs and the one the palette
 * hands over, the recompute notice, and the starting hands hidden while a
 * poker table is open (A10).
 */
import { useEffect, useState } from "react";
import { ReportsScreen, isTab, type Tab } from "@rail/ui/reports/ReportsScreen";
import styles from "@rail/ui/reports/Reports.module.css";

import { ProLockView } from "../components/ProLock";
import { RecomputeNotice, useRecompute } from "../components/RecomputeNotice";
import { StateMessage } from "../components/StateMessage";
import { useT } from "../i18n";
import { hiddenDuringPlay } from "../lib/duringPlay";
import { inApp } from "../lib/ipc";
import { storeReportSource } from "../lib/reportSource";
import { replaceParam, useRouteParam } from "../lib/router";
import { useEntitlements } from "../lib/useEntitlements";
import { useStatDefinitions } from "../lib/useStatDefinitions";
import { useTablesOpen } from "../lib/useTablesOpen";
import { onFilterRequested, takeRequestedFilter, type FilterState } from "./hands/filter";

/** The filter, kept while the app runs (leaving Reports and coming back keeps it). */
let lastFilter: FilterState | null = null;

export function Reports() {
  const t = useT();
  const r = t.reports;
  const param = useRouteParam();
  const tab: Tab = isTab(param) ? param : "position";
  /** The reader's filter; `null` until they set one (this run of the app). */
  const [chosen, setChosen] = useState<FilterState | null>(() => {
    // A saved filter chosen in the palette (R2.8) replaces the kept one.
    const handed = takeRequestedFilter("reports");
    if (handed) lastFilter = handed;
    return lastFilter;
  });
  const choose = (next: FilterState) => {
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
  const definitions = useStatDefinitions();
  const rebuild = useRecompute();
  const tablesOpen = useTablesOpen();
  // (R6.4) The breakdowns by situation are full reports (Pro); the rest of
  // the screen is the basic statistics, free on every plan.
  const plan = useEntitlements();
  const situationsLock =
    plan.status !== null && plan.locked("reportsFull") ? (
      <ProLockView
        feature="reportsFull"
        status={plan.status}
        onSignIn={plan.signIn}
        onUpgrade={plan.upgrade}
        onCheck={plan.checkNow}
        checking={plan.checking}
        compact
      />
    ) : undefined;

  if (!inApp) {
    return (
      <div className={styles.screen}>
        <h1 className={styles.title}>{t.screens.reports.title}</h1>
        <p className={styles.message}>{r.unavailable}</p>
      </div>
    );
  }

  return (
    <ReportsScreen
      source={storeReportSource}
      definitions={definitions}
      chosen={chosen}
      onChoose={choose}
      tab={tab}
      onTab={(next) => replaceParam("reports", next)}
      title={t.screens.reports.title}
      notice={<RecomputeNotice status={rebuild} filling={r.rebuilding} className={styles.notice} />}
      emptyText={r.empty}
      renderState={(kind, text) => <StateMessage kind={kind}>{text}</StateMessage>}
      hideHandChart={hiddenDuringPlay("handChart", tablesOpen)}
      situationsLock={situationsLock}
    />
  );
}
