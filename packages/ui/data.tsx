"use client";

/**
 * Where the package's components get data they have to fetch.
 *
 * Most components take their data as props (the replayer takes a `PhfHand`, a
 * stat table its rows). The few that fetch for themselves go through this
 * interface, and each surface implements it over its own backend: the web over
 * Supabase (`frontend/src/lib/db/dataSource.ts`), the desktop app over Tauri
 * commands into its local store. `@rail/ui` imports neither - a lint rule
 * keeps `@supabase/*` and `@tauri-apps/*` out of the package.
 *
 * Small on purpose: a method is added when a shared component needs it, with
 * both implementations in the same change.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PhfHand } from "./model/phf";

export interface DataSource {
  /**
   * One stored hand, as PHF. Null when the id is unknown or is not the
   * reader's - on the web, RLS makes the two indistinguishable, and a guessed
   * id should get the same answer as a missing one.
   */
  hand(id: string): Promise<PhfHand | null>;
}

const DataSourceContext = createContext<DataSource | null>(null);

/** Mount once per surface, above any component that fetches. */
export function DataSourceProvider({ source, children }: { source: DataSource; children: ReactNode }) {
  return <DataSourceContext.Provider value={source}>{children}</DataSourceContext.Provider>;
}

export function useDataSource(): DataSource {
  const source = useContext(DataSourceContext);
  if (source === null) {
    throw new Error("@rail/ui: mount a DataSourceProvider above this component (packages/ui/data.tsx).");
  }
  return source;
}

export type HandState =
  | { status: "loading" }
  | { status: "ready"; hand: PhfHand }
  | { status: "missing" }
  | { status: "failed"; error: Error };

/**
 * One hand by id through the surface's `DataSource`, for a screen that opens a
 * hand in the replayer. A later id supersedes an earlier one still in flight.
 * The words for loading, missing and failed are the surface's.
 */
export function useHand(id: string): HandState {
  const source = useDataSource();
  const [state, setState] = useState<{ id: string; value: HandState }>({ id, value: { status: "loading" } });

  useEffect(() => {
    let current = true;
    source.hand(id).then(
      (hand) => {
        if (current) setState({ id, value: hand ? { status: "ready", hand } : { status: "missing" } });
      },
      (error: unknown) => {
        if (current) {
          setState({ id, value: { status: "failed", error: error instanceof Error ? error : new Error(String(error)) } });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [source, id]);

  // Until the effect for a new id answers, that id is loading.
  return state.id === id ? state.value : { status: "loading" };
}
