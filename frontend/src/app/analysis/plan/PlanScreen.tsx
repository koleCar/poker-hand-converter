"use client";

import { AppFrame } from "../../../components/shell/AppFrame";
import { PlanTab } from "../../../components/analysis/plan/PlanTab";

/** Client half of `/analysis/plan`: the shell, with the Analysis tab selected. */
export function PlanScreen() {
  return <AppFrame tab="analysis">{({ refreshToken }) => <PlanTab refreshToken={refreshToken} />}</AppFrame>;
}
