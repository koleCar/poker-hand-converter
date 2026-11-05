/**
 * The date's session picker reads the hero's latest sessions through the
 * screen's source (`HandsSource.sessions`); a source without them has none,
 * and the picker is not drawn.
 */
import { createContext, useContext } from "react";

import type { HandSession } from "./model";

export type LoadSessions = (kind: "cash" | "tournament" | null) => Promise<HandSession[]>;

export const HandSessionsContext = createContext<LoadSessions | null>(null);

export function useHandSessions(): LoadSessions | null {
  return useContext(HandSessionsContext);
}
