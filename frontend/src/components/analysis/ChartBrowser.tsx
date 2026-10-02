/**
 * The chart browser (`/analysis/charts`): pick a scenario and a spot, see the
 * reference's 13×13 chart for it.
 *
 * Public, like the concept library: it reads the chart set that ships with
 * the app (loaded on demand — it is ~630 KB of JSON) and nothing of anyone's
 * account. The spot and a highlighted hand live in the address bar
 * (`?line=…&hand=…`), so the hand view's Study link and a shared link both
 * land on the same chart.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { CHARTS_VERSION, type ChartSet } from "../../lib/charts";
import { preflopCharts } from "../../lib/chartSet";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./analysis.module.css";
import { ChartGrid } from "./ChartGrid";
import { SPOT_CATEGORIES, categoriesOf, lineSteps, nodesIn, type SpotCategory } from "./chartSpots";

type Loaded = { status: "loading" } | { status: "ready"; charts: ChartSet } | { status: "error"; message: string };

interface ChartBrowserProps {
  /** `?line=` — a line key, `-` for the UTG open. */
  initialLine: string | null;
  /** `?hand=` — a class to highlight. */
  initialHand: string | null;
}

export function ChartBrowser({ initialLine, initialHand }: ChartBrowserProps) {
  const t = useDict().analysis.charts;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [line, setLine] = useState<string>(initialLine === "-" ? "" : (initialLine ?? ""));
  const [category, setCategory] = useState<SpotCategory | null>(null);

  useEffect(() => {
    let live = true;
    preflopCharts()
      .then((charts) => {
        if (live) setLoaded({ status: "ready", charts });
      })
      .catch((error: unknown) => {
        if (live) setLoaded({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, []);

  const charts = loaded.status === "ready" ? loaded.charts : null;
  const node = charts ? (charts.nodes.get(line) ?? charts.nodes.get("") ?? null) : null;
  const shownCategory: SpotCategory = category ?? (node ? categoriesOf(node)[0] : "rfi");
  const spots = useMemo(() => (charts ? nodesIn(charts, shownCategory) : []), [charts, shownCategory]);
  const label = (actor: string, key: string) =>
    t.spotLabel(
      actor,
      lineSteps(key).map((step) => ({ position: step.position, verb: t.verbs[step.verb] ?? step.verb })),
    );

  const choose = (next: string) => {
    setLine(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", paths.analysisCharts(next, initialHand));
    }
  };

  return (
    <div className={styles.browser}>
      <div className={`notice notice--warn ${styles.reference}`}>
        <strong>{t.caveatTitle}</strong>
        <span>{t.caveat}</span>
      </div>

      {loaded.status === "loading" ? <p className="muted">{t.loading}</p> : null}
      {loaded.status === "error" ? <p className="notice notice--error">{t.failed(loaded.message)}</p> : null}

      {charts && node ? (
        <>
          <div className={styles.filters}>
            <label className="field">
              <span className="field__label">{t.category}</span>
              <select
                value={shownCategory}
                onChange={(event) => {
                  const next = event.target.value as SpotCategory;
                  setCategory(next);
                  const first = nodesIn(charts, next)[0];
                  if (first) choose(first.line);
                }}
              >
                {SPOT_CATEGORIES.map((id) => (
                  <option key={id} value={id}>
                    {t.categories[id]}
                  </option>
                ))}
              </select>
            </label>
            <label className={`field ${styles.spotField}`}>
              <span className="field__label">{t.spot}</span>
              <select value={node.line} onChange={(event) => choose(event.target.value)}>
                {(spots.some((spot) => spot.line === node.line) ? spots : [node, ...spots]).map((spot) => (
                  <option key={spot.line} value={spot.line}>
                    {label(spot.actor, spot.line)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ChartGrid key={`${node.line}|${initialHand ?? ""}`} node={node} highlight={initialHand} />
          <p className={styles.muted}>{t.set(charts.id, CHARTS_VERSION)}</p>
        </>
      ) : null}
    </div>
  );
}
