/**
 * The chart browser (`/analysis/charts`): pick a scenario and a spot, see the
 * reference's 13×13 chart for it.
 *
 * Public, like the concept library: it reads the chart sets that ship with
 * the app (one per table and depth, each loaded on demand — 0.25 to 2 MB of
 * JSON) and nothing of anyone's account. The set, the spot and a highlighted
 * hand live in the address bar (`?set=…&line=…&hand=…`), so the hand view's
 * Study link and a shared link both land on the same chart.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { CHART_SETS, CHARTS_VERSION, DEFAULT_CHART_SET, type ChartSet } from "../../lib/charts";
import { preflopChartSet } from "../../lib/chartSet";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "./analysis.module.css";
import { ChartGrid } from "./ChartGrid";
import { SPOT_CATEGORIES, categoriesOf, lineSteps, nodesIn, type SpotCategory } from "./chartSpots";

/** What the effect last loaded, for which set: another set's result reads as "loading". */
type Loaded = { id: string } & ({ status: "loading" } | { status: "ready"; charts: ChartSet } | { status: "error"; message: string });

interface ChartBrowserProps {
  /** `?set=` — a chart set id; unknown or absent is the default set. */
  initialSet?: string | null;
  /** `?line=` — a line key, `-` for the UTG open. */
  initialLine: string | null;
  /** `?hand=` — a class to highlight. */
  initialHand: string | null;
}

export function ChartBrowser({ initialSet = null, initialLine, initialHand }: ChartBrowserProps) {
  const t = useDict().analysis.charts;
  const [result, setLoaded] = useState<Loaded>({ id: "", status: "loading" });
  const [setId, setSetId] = useState<string>(
    initialSet && CHART_SETS.some((spec) => spec.id === initialSet) ? initialSet : DEFAULT_CHART_SET,
  );
  const [line, setLine] = useState<string>(initialLine === "-" ? "" : (initialLine ?? ""));
  const [category, setCategory] = useState<SpotCategory | null>(null);

  useEffect(() => {
    let live = true;
    preflopChartSet(setId)
      .then((charts) => {
        if (!live) return;
        setLoaded(charts ? { id: setId, status: "ready", charts } : { id: setId, status: "error", message: setId });
      })
      .catch((error: unknown) => {
        if (live) setLoaded({ id: setId, status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [setId]);

  const loaded: Loaded = result.id === setId ? result : { id: setId, status: "loading" };
  const charts = loaded.status === "ready" ? loaded.charts : null;
  const node = charts ? (charts.nodes.get(line) ?? charts.nodes.get("") ?? null) : null;
  const shownCategory: SpotCategory = category ?? (node ? categoriesOf(node)[0] : "rfi");
  const spots = useMemo(() => (charts ? nodesIn(charts, shownCategory) : []), [charts, shownCategory]);
  const label = (actor: string, key: string) =>
    t.spotLabel(
      actor,
      lineSteps(key, charts?.game.positions).map((step) => ({ position: step.position, verb: t.verbs[step.verb] ?? step.verb })),
    );

  const navigate = (nextSet: string, next: string) => {
    if (typeof window !== "undefined") {
      const set = nextSet === DEFAULT_CHART_SET ? null : nextSet;
      window.history.replaceState(window.history.state, "", paths.analysisCharts(next, initialHand, set));
    }
  };
  const choose = (next: string) => {
    setLine(next);
    navigate(setId, next);
  };
  const chooseSet = (next: string) => {
    // The same spot when the other set has it (same table), else its first.
    setSetId(next);
    setCategory(null);
    navigate(next, line);
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
              <span className="field__label">{t.table}</span>
              <select value={setId} onChange={(event) => chooseSet(event.target.value)}>
                {CHART_SETS.map((spec) => (
                  <option key={spec.id} value={spec.id}>
                    {t.setOption(spec.players, spec.stackBb)}
                  </option>
                ))}
              </select>
            </label>
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
          <p className={styles.muted}>{t.set(charts.id, `${charts.version} · ${CHARTS_VERSION}`)}</p>
        </>
      ) : null}
    </div>
  );
}
