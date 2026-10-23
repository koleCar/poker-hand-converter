/**
 * `/analysis/my-charts` (R5.3): the shared charts screen
 * (`@rail/ui/charts/ChartsScreen`) over the web's data
 * (`lib/db/preflopCharts.ts`), inside the Analysis tab.
 *
 * What is the web's: the address (`myChartsQuery.ts`, written with
 * `replaceState` as the reader moves, so a reload and a hand's Back link land
 * where they were), the sign-in gate, and how a hand opens (its analysis at
 * `/analysis/h/<id>`, at the decision, with a Back link to the chart).
 */

"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ChartsScreen } from "@rail/ui/charts/ChartsScreen";
import type { ChartHandLinkProps } from "@rail/ui/charts/ChartCompare";
import { encodePosition } from "@rail/ui/replayer/position";
import { useAuth } from "../../../lib/auth";
import { DATABASE_NOT_CONFIGURED_MESSAGE, isDatabaseConfigured } from "../../../lib/db/client";
import { webPreflopChartsSource } from "../../../lib/db/preflopCharts";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import { AnalysisNav } from "../AnalysisNav";
import { myChartsQueryString, parseMyChartsQuery, type MyChartsQuery } from "./myChartsQuery";
import "../../../styles/stats.css";

export function MyChartsTab({ initialQuery }: { initialQuery: Record<string, string | string[] | undefined> }) {
  const dict = useDict();
  const t = dict.learn.nav;
  const tab = dict.analysis.tab;
  const auth = useAuth();
  const [query, setQuery] = useState<MyChartsQuery>(() => parseMyChartsQuery(initialQuery));

  const onNavigate = useCallback((next: MyChartsQuery) => {
    setQuery(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", paths.analysisMyCharts(myChartsQueryString(next)));
    }
  }, []);

  const renderHandLink = useCallback(
    ({ handId, actionIndex, label, className, children }: ChartHandLinkProps) => {
      const back = myChartsQueryString(query);
      const position = `t=${encodePosition({ kind: "action", actionIndex })}`;
      return (
        <Link
          href={paths.analysisHand(handId, `${position}&from=my-charts${back ? `&${back}` : ""}`)}
          className={className}
          aria-label={label}
        >
          {children}
        </Link>
      );
    },
    [query],
  );

  if (!isDatabaseConfigured) {
    return <p className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</p>;
  }

  if (!auth.isSignedIn) {
    return (
      <div className="stats">
        <header className="stats__head">
          <h2>{t.myCharts}</h2>
        </header>
        <AnalysisNav current="my-charts" />
        <div className="card stats-empty">
          <h3>{tab.signInHeading}</h3>
          <p className="muted">{tab.signInBody}</p>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
            {tab.signIn}
          </button>
        </div>
      </div>
    );
  }

  return (
    <ChartsScreen
      source={webPreflopChartsSource}
      title={t.myCharts}
      titleTag="h2"
      notice={<AnalysisNav current="my-charts" />}
      selected={query.selected}
      view={query.view}
      situation={query.situation}
      period={query.period}
      onNavigate={(to) =>
        onNavigate({ selected: to.selected, view: to.view, situation: to.situation ?? null, period: to.period ?? query.period })
      }
      renderHandLink={renderHandLink}
      renderState={(kind, text) => (
        <div
          className={kind === "error" ? "notice notice--error" : "card stats-empty"}
          role={kind === "error" ? "alert" : "status"}
        >
          {kind === "error" ? text : <p className="muted">{text}</p>}
        </div>
      )}
    />
  );
}
