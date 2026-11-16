/**
 * The app's front door: one box for a pasted hand or dropped files.
 *
 * `ConverterTab` owns the box (`UploadBox`) and the batch conversion; a pasted
 * hand the user replays is shown right under the box by `ReplayPanel`.
 */

"use client";

import { useCallback, useState } from "react";
import { ConverterTab } from "../ConverterTab";
import { ReplayPanel, type ReplayRequest } from "./ReplayPanel";

interface UploadTabProps {
  /** Lets the shell refresh its stored-hand counter. */
  onHandsSaved?: () => void;
}

export function UploadTab({ onHandsSaved }: UploadTabProps) {
  const [request, setRequest] = useState<ReplayRequest | null>(null);
  const replay = useCallback((text: string) => {
    setRequest((current) => ({ id: (current?.id ?? 0) + 1, text }));
  }, []);

  return (
    <ConverterTab
      onHandsSaved={onHandsSaved}
      onReplay={replay}
      replay={<ReplayPanel request={request} onSaved={onHandsSaved} />}
    />
  );
}
