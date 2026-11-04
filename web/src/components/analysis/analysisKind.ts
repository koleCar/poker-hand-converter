/**
 * Which kind of game the Analysis screens show: cash, or every tournament
 * format together - one at a time, never both (the owner's rule, 2026-11-04;
 * the server's `gameKind`, `20271104090000_game_kind_filter.sql`).
 *
 * The kind is, in order: the address's (`?kind=`), the one last shown on an
 * Analysis screen in this visit (so moving from Leaks to the plan or the
 * trainer keeps it), else the kind with more analysed hands (cash on a tie,
 * or when the counts cannot be read). Every screen shows the same
 * Cash | Tournaments switch (`KindSwitch`); a kind with no hands is greyed out.
 */

"use client";

import { defaultKind, GAME_KINDS, type GameKind } from "@rail/ui/hands/gameKind";
import { useEffect, useState } from "react";
import { fetchAnalysisKindCounts } from "../../lib/db/analysis";

/** The address key. */
export const KIND_KEY = "kind";

type Source = URLSearchParams | Record<string, string | string[] | undefined>;

/** The address's kind, or null. */
export function parseKind(source: Source): GameKind | null {
  const raw = source instanceof URLSearchParams ? source.get(KIND_KEY) : source[KIND_KEY];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && (GAME_KINDS as readonly string[]).includes(value) ? (value as GameKind) : null;
}

/** The kind last shown in this visit (module state: it outlives a client-side navigation, not a reload). */
let lastShown: GameKind | null = null;

/** Remember the kind a screen shows, for the next Analysis screen. */
export function rememberKind(kind: GameKind): void {
  lastShown = kind;
}

/** Test seam: forget the visit's kind. */
export function forgetKind(): void {
  lastShown = null;
}

let counts: Promise<Record<GameKind, number> | null> | null = null;

/** The kinds' hands, read once per visit (an import between screens changes them little). */
function readCounts(fresh: boolean): Promise<Record<GameKind, number> | null> {
  if (counts === null || fresh) {
    counts = fetchAnalysisKindCounts().catch(() => null);
  }
  return counts;
}

export interface AnalysisKind {
  /** The kind to show; null only while the counts that decide it load. */
  kind: GameKind | null;
  /** Hands of each kind, once read. */
  counts: Record<GameKind, number> | null;
}

/**
 * The kind a screen shows. `asked` is the screen's own choice (its address or
 * its switch); without one, the visit's last kind, else the one with more hands.
 * `enabled` false (signed out) reads nothing and answers cash.
 */
export function useAnalysisKind(asked: GameKind | null, enabled = true, refreshToken = 0): AnalysisKind {
  const [read, setRead] = useState<{ counts: Record<GameKind, number> | null } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    readCounts(refreshToken > 0).then((next) => {
      if (live) setRead({ counts: next });
    });
    return () => {
      live = false;
    };
  }, [enabled, refreshToken]);

  const fallback = lastShown ?? (read === null ? null : read.counts === null ? "cash" : defaultKind(read.counts));
  const kind: GameKind | null = asked ?? (enabled ? fallback : "cash");

  useEffect(() => {
    if (kind !== null) rememberKind(kind);
  }, [kind]);

  return { kind, counts: read?.counts ?? null };
}
