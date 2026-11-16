"use client";

import { AppFrame } from "../../components/shell/AppFrame";
import { UploadTab } from "../../components/upload/UploadTab";

/**
 * Client half of `/convert`. The page next door owns the metadata and the
 * standing note about this route making no server requests.
 */
export function ConvertScreen() {
  return (
    <AppFrame tab="convert">
      {({ onHandsSaved }) => (
        <div className="stack">
          <UploadTab onHandsSaved={onHandsSaved} />
        </div>
      )}
    </AppFrame>
  );
}
