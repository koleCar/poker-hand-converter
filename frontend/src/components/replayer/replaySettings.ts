import type { ParsedHand } from "../../lib/handParser";
import type { AmountUnit } from "./tableMath";

/**
 * Viewer preferences that change what the felt shows rather than where the
 * replay is. They live behind the gear in the replayer header and persist
 * across hands, so a coach who reviews with names hidden keeps them hidden.
 */
export interface ReplaySettings {
  /** Render every amount in big blinds instead of currency. */
  bigBlinds: boolean;
  /** Reveal cards the history knows about before they were turned over. */
  showKnownCards: boolean;
  /** Hero's own hole cards face up. Off is useful for blind-spot drills. */
  showHeroCards: boolean;
  /** Replace player and table names with neutral labels. */
  anonymousNames: boolean;
}

export const DEFAULT_REPLAY_SETTINGS: ReplaySettings = {
  bigBlinds: false,
  showKnownCards: false,
  showHeroCards: true,
  anonymousNames: false,
};

const SETTINGS_KEY = "phc.replayer.settings";
/** Pre-settings builds stored the unit on its own; honour it once. */
const LEGACY_UNIT_KEY = "phc.replayer.unit";

export function loadReplaySettings(): ReplaySettings {
  if (typeof window === "undefined") {
    return DEFAULT_REPLAY_SETTINGS;
  }
  const settings = { ...DEFAULT_REPLAY_SETTINGS };
  try {
    settings.bigBlinds = window.localStorage.getItem(LEGACY_UNIT_KEY) === "bb";
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Record<keyof ReplaySettings, unknown>>;
      for (const key of Object.keys(settings) as Array<keyof ReplaySettings>) {
        if (typeof stored[key] === "boolean") {
          settings[key] = stored[key] as boolean;
        }
      }
    }
  } catch {
    // Private mode, disabled storage or a hand-edited value: fall back to
    // whatever was resolved so far.
  }
  return settings;
}

export function saveReplaySettings(settings: ReplaySettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // The preference simply does not persist.
  }
}

export function unitOf(settings: ReplaySettings): AmountUnit {
  return settings.bigBlinds ? "bb" : "chips";
}

/**
 * Swaps real screen names for neutral ones. Seat plates take `seat()`, while
 * the action log and status line take `text()` because their sentences are
 * pre-built strings with the names already baked in.
 */
export interface NameMask {
  seat: (name: string) => string;
  text: (value: string) => string;
  tableName: string | null;
}

const IDENTITY_TEXT = (value: string) => value;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const ANONYMOUS_TABLE_NAME = "Table";

export function createNameMask(hand: ParsedHand, anonymous: boolean): NameMask {
  if (!anonymous) {
    return { seat: (name) => name, text: IDENTITY_TEXT, tableName: hand.tableName };
  }

  const alias = new Map<string, string>();
  let counter = 0;
  for (const seat of [...hand.seats].sort((a, b) => a.seatNo - b.seatNo)) {
    alias.set(seat.name, seat.isHero ? "Hero" : `Player ${++counter}`);
  }
  if (hand.tableName) {
    alias.set(hand.tableName, ANONYMOUS_TABLE_NAME);
  }

  const seatName = (name: string) => alias.get(name) ?? name;

  // Longest first so a name that contains another one ("Bob" inside "Bobby")
  // cannot be chewed up by the shorter match.
  const targets = [...alias.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  const pattern =
    targets.length > 0 ? new RegExp(targets.map(escapeRegExp).join("|"), "g") : null;

  return {
    seat: seatName,
    text: pattern ? (value) => value.replace(pattern, (match) => alias.get(match) ?? match) : IDENTITY_TEXT,
    tableName: hand.tableName ? ANONYMOUS_TABLE_NAME : null,
  };
}
