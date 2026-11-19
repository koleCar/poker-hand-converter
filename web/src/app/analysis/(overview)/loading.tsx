"use client";

import { AnalysisNav } from "../../../components/analysis/AnalysisNav";
import { OverviewSkeleton } from "../../../components/analysis/overview/OverviewSkeleton";
import styles from "../../../components/analysis/ui/an.module.css";
import { AppFrame } from "../../../components/shell/AppFrame";
import { useDict } from "../../../lib/i18n/client";

/**
 * The Analysis list's wait. In a route group (`/analysis` unchanged) so the
 * boundary wraps the list alone, not `/analysis/h/…` or the concept pages,
 * which must still answer 404 for an unknown address (`RouteLoading`).
 *
 * Unlike the other boundaries it draws the overview's own skeleton under the
 * Analysis tabs rather than the Rail loader: the screen's first load shows the
 * same skeleton, so the wait reads as one wait and the page never jumps from a
 * centred mark to a full grid. The frame never holds for the plan, as in
 * `RouteLoading`.
 */
export default function Loading() {
  const label = useDict().loading.route.analysis;
  return (
    <AppFrame tab="analysis" feature={null}>
      {() => (
        <div className={styles.page}>
          <AnalysisNav current="overview" />
          <OverviewSkeleton label={label} />
        </div>
      )}
    </AppFrame>
  );
}
