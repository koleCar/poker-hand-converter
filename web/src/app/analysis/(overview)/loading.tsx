"use client";

import { AnalysisRouteLoading } from "../../../components/analysis/AnalysisRouteLoading";

/**
 * The Analysis list's wait. In a route group (`/analysis` unchanged) so the
 * boundary wraps the list alone, not `/analysis/h/…` or the concept pages,
 * which must still answer 404 for an unknown address (`RouteLoading`).
 * It draws the overview's own skeleton under the Analysis tabs
 * (`AnalysisRouteLoading`).
 */
export default function Loading() {
  return <AnalysisRouteLoading section="overview" />;
}
