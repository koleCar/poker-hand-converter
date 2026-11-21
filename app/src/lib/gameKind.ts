/**
 * The app's one kind of game: cash, or every tournament format together.
 * Chosen once, in the sidebar (`components/SidebarKind.tsx`), and every
 * screen shows only that kind's hands - Live, Hands, Reports, Players,
 * Analysis and the Trainer; none has a Cash / Tournaments choice of its own
 * (the owner's rule, 2026-11-20; one kind at a time, never both, since
 * 2026-11-04).
 *
 * The kind is the reader's choice, kept across starts; until they make one,
 * the kind with more hands (cash on a tie, or when the counts cannot be
 * read), decided once per run so the screens do not change kind under the
 * reader as hands arrive. The counts are the Hands screen's Game chip's
 * (`hands_facets`), read again whenever hands arrive; they grey out a kind
 * with no hands in the sidebar.
 */
import { defaultKind, kindCounts, type GameKind } from "@rail/ui/hands/gameKind";
import { useSyncExternalStore } from "react";

import { inApp, ipc, onStatsDataChanged } from "./ipc";

const STORAGE_KEY = "rail.gameKind";

export interface AppKind {
  /** The kind every screen shows; null only while the counts that decide it load. */
  kind: GameKind | null;
  /** Hands of each kind; null until read. */
  counts: Record<GameKind, number> | null;
}

function readStored(): GameKind | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "cash" || value === "tournament" ? value : null;
  } catch {
    return null;
  }
}

function writeStored(kind: GameKind): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, kind);
  } catch {
    // A webview without storage: the next start opens on the kind with more hands.
  }
}

/** The reader's choice (kept), else the kind decided from the counts this run. */
let chosen: GameKind | null = readStored();
let decided: GameKind | null = null;
let counts: Record<GameKind, number> | null = null;
let state: AppKind = { kind: chosen, counts };
const listeners = new Set<() => void>();
let started = false;

function emit(): void {
  state = { kind: chosen ?? decided, counts };
  for (const listener of listeners) listener();
}

function readCounts(): void {
  if (!inApp) {
    decided ??= "cash";
    emit();
    return;
  }
  ipc.handsFacets({}).then(
    (facets) => {
      counts = kindCounts(facets);
      decided ??= defaultKind(counts);
      emit();
    },
    () => {
      decided ??= "cash";
      emit();
    },
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) {
    // The main window lives as long as the app: this is never let go.
    started = true;
    readCounts();
    onStatsDataChanged(readCounts);
  }
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => state;

/** The reader picks a kind (the sidebar): every screen follows, and it is kept. */
export function setAppKind(kind: GameKind): void {
  writeStored(kind);
  if (state.kind === kind && chosen === kind) return;
  chosen = kind;
  emit();
}

/** The app's kind of game and both kinds' hands. */
export function useAppKind(): AppKind {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
