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
import { withKind } from "@rail/ui/hands/gameKind";
import type { PlayerRef } from "@rail/ui/hands/model";
import type { ShownKind } from "@rail/ui/players/model";

const PLAYER_FILTER_KEY = "rail.library.playerFilter";
/** A parked opponent is honoured for this long (the hand-off, not a later visit). */
const MAX_AGE_MS = 10 * 60 * 1000;

interface Parked extends PlayerRef {
  /** The profile's game kind: the library opens on it (cash and tournaments never together). */
  kind?: ShownKind;
  at: string;
}

/** Parks `player` for the library's next mount. Returns whether it stuck. */
export function parkPlayerFilter(player: PlayerRef, kind: ShownKind): boolean {
  try {
    const parked: Parked = { ...player, kind, at: new Date().toISOString() };
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
    const filter: FilterState = { ...EMPTY_FILTER, sites: [parked.site], playerName: parked.player };
    if (parked.kind === "cash") return withKind(filter, "cash", null);
    if (parked.kind === "chips") return withKind(filter, "tournament", null);
    return filter;
  } catch {
    return null;
  }
}
