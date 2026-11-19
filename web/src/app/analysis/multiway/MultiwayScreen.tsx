"use client";

import { AppFrame } from "../../../components/shell/AppFrame";
import { MultiwayTab } from "../../../components/analysis/potKinds/PotKindTabs";

/** Client half of `/analysis/multiway`: the shell, with the Analysis tab selected. */
export function MultiwayScreen() {
  return (
    <AppFrame tab="analysis" live="notify">
      {({ refreshToken }) => <MultiwayTab refreshToken={refreshToken} />}
    </AppFrame>
  );
}
