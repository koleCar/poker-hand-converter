/**
 * Which kind of game the app's screens that keep it themselves show - Top
 * leaks and the session review: cash, or every tournament format together,
 * one at a time and never both (the owner's rule, 2026-11-04). Live decides
 * its own (the kind being played; `reports.rs` `build_today`).
 *
 * The kind is the screen's switch's, else the one last shown on such a
 * screen in this run of the app, else the one with more hands (cash on a
 * tie, or when the counts cannot be read). The counts are the Hands screen's
 * Game chip's (`hands_facets`), which also grey out a kind with none.
 */
import { defaultKind, kindCounts, type GameKind } from "@rail/ui/hands/gameKind";
import { useEffect, useState } from "react";

import { ipc } from "./ipc";

let lastShown: GameKind | null = null;

export interface AppKind {
  /** The kind to show; null only while the counts that decide it load. */
  kind: GameKind | null;
  counts: Record<GameKind, number> | null;
}

/** `asked`: the screen's own choice. `enabled` false reads nothing (a hidden screen). */
export function useAppKind(asked: GameKind | null, enabled: boolean, reload: unknown = 0): AppKind {
  const [read, setRead] = useState<{ counts: Record<GameKind, number> | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    ipc.handsFacets({}).then(
      (facets) => live && setRead({ counts: kindCounts(facets) }),
      () => live && setRead({ counts: null }),
    );
    return () => {
      live = false;
    };
  }, [enabled, reload]);
  const fallback = lastShown ?? (read === null ? null : read.counts === null ? "cash" : defaultKind(read.counts));
  const kind = asked ?? fallback;
  useEffect(() => {
    if (kind !== null) lastShown = kind;
  }, [kind]);
  return { kind, counts: read?.counts ?? null };
}
