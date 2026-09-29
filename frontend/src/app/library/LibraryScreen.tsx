"use client";

import { AppFrame } from "../../components/shell/AppFrame";
import { ReplayerTab } from "../../components/ReplayerTab";

/**
 * Client half of `/library`.
 *
 * `redirectWhenEmpty` is the gate that used to live in `AppPage`: a visitor
 * with no saved hands and no hand parked by the converter is sent to
 * `/convert`, because the tab is hidden for them and the address has to agree
 * with the bar.
 */
export function LibraryScreen() {
  return (
    <AppFrame tab="library" redirectWhenEmpty>
      {({ refreshToken, onHandsSaved }) => (
        <ReplayerTab refreshToken={refreshToken} onHandsSaved={onHandsSaved} />
      )}
    </AppFrame>
  );
}
