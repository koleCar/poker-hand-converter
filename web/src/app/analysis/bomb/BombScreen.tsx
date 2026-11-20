"use client";

import { AppFrame } from "../../../components/shell/AppFrame";
import { BombPotsTab } from "../../../components/analysis/potKinds/PotKindTabs";

/** Client half of `/analysis/bomb`: the shell, with the Analysis tab selected. */
export function BombScreen() {
  return (
    <AppFrame tab="analysis" live="notify">
      {({ refreshToken }) => <BombPotsTab refreshToken={refreshToken} />}
    </AppFrame>
  );
}
