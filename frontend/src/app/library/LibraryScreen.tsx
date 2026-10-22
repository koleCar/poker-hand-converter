"use client";

import { AppFrame } from "../../components/shell/AppFrame";
import { LibraryHands } from "../../components/library/LibraryHands";

/**
 * Client half of `/library`.
 *
 * `redirectWhenEmpty` is the gate that used to live in `AppPage`: a visitor
 * with no saved hands and no hand parked by the converter is sent to
 * `/convert`, because the tab is hidden for them and the address has to agree
 * with the bar.
 *
 * `live`: hands synced by the desktop app (or saved in another tab) show up
 * without a reload (Rail R1.10).
 *
 * The screen is the shared package's Hands screen since R4.5b
 * (`components/library/LibraryHands.tsx`).
 */
export function LibraryScreen() {
  return (
    <AppFrame tab="library" redirectWhenEmpty live>
      {({ refreshToken, onHandsSaved, arrival }) => (
        <LibraryHands refreshToken={refreshToken} onHandsSaved={onHandsSaved} arrival={arrival} />
      )}
    </AppFrame>
  );
}
