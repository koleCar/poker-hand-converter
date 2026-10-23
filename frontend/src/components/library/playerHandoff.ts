/**
 * "Hands with this player" (R4.5c): the Players screen hands the library an
 * opponent, the library opens filtered to the hands they were dealt into, in
 * their room.
 *
 * Parked in `sessionStorage`, as the converter parks a hand
 * (`converter/handoff.ts`), and for the same reasons; and not in the address,
 * because an opponent's screen name does not belong in a URL (history,
 * logs, a link pasted somewhere). Parking and navigating are two calls: the
 * Players page parks, then routes.
 */
import { EMPTY_FILTER, type FilterState } from "@rail/ui/hands/filter";
import type { PlayerRef } from "@rail/ui/hands/model";

const PLAYER_FILTER_KEY = "rail.library.playerFilter";
/** A parked opponent is honoured for this long (the hand-off, not a later visit). */
const MAX_AGE_MS = 10 * 60 * 1000;

interface Parked extends PlayerRef {
  at: string;
}

/** Parks `player` for the library's next mount. Returns whether it stuck. */
export function parkPlayerFilter(player: PlayerRef): boolean {
  try {
    const parked: Parked = { ...player, at: new Date().toISOString() };
    sessionStorage.setItem(PLAYER_FILTER_KEY, JSON.stringify(parked));
    return true;
  } catch {
    return false;
  }
}

/** The library's filter for a parked opponent, once (the key is cleared); null when there is none. */
export function takePlayerFilter(): FilterState | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PLAYER_FILTER_KEY);
    sessionStorage.removeItem(PLAYER_FILTER_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parked = JSON.parse(raw) as Partial<Parked>;
    if (typeof parked.site !== "string" || typeof parked.player !== "string" || parked.player === "") return null;
    const age = Date.now() - Date.parse(parked.at ?? "");
    if (!Number.isFinite(age) || age > MAX_AGE_MS) return null;
    // The web's library filters on a name at the table (`library_page`'s
    // `player`, exact) and the room.
    return { ...EMPTY_FILTER, sites: [parked.site], playerName: parked.player };
  } catch {
    return null;
  }
}
