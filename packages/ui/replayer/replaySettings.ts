import type { ReplayerStrings } from "../i18n";
import type { PhfHand } from "../model/phf";
import type { AmountUnit } from "./tableMath";

/**
 * How the cards on the felt are drawn (Settings -> Cards). Four colours is the
 * default and the deck the replayer always had; the others restyle the same
 * markup through `data-cards` on the replayer's root.
 *
 * - `four`: clubs green, diamonds blue.
 * - `classic`: two colours, diamonds red and clubs black.
 * - `big`: four colours with a bigger rank and a smaller suit.
 * - `dark`: dark card faces with light ink.
 */
export type CardFace = "four" | "classic" | "big" | "dark";

export const CARD_FACES: readonly CardFace[] = ["four", "classic", "big", "dark"];

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
  /** Pot odds printed on the felt above the hero's cards while hero decides. */
  showPotOdds: boolean;
  /** Card faces on the felt; see `CardFace`. */
  cardFace: CardFace;
}

export const DEFAULT_REPLAY_SETTINGS: ReplaySettings = {
  bigBlinds: false,
  showKnownCards: false,
  showHeroCards: true,
  anonymousNames: false,
  showPotOdds: true,
  cardFace: "four",
};

const SETTINGS_KEY = "phc.replayer.settings";
const BOOLEAN_KEYS = [
  "bigBlinds",
  "showKnownCards",
  "showHeroCards",
  "anonymousNames",
  "showPotOdds",
] as const satisfies ReadonlyArray<keyof ReplaySettings>;
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
      for (const key of BOOLEAN_KEYS) {
        const value = stored[key];
        if (typeof value === "boolean") {
          settings[key] = value;
        }
      }
      if (CARD_FACES.includes(stored.cardFace as CardFace)) {
        settings.cardFace = stored.cardFace as CardFace;
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

/** `t` supplies the neutral labels, in the reader's language. */
export function createNameMask(hand: PhfHand, anonymous: boolean, t: ReplayerStrings): NameMask {
  const tableName = hand.table.name;
  if (!anonymous) {
    return { seat: (name) => name, text: IDENTITY_TEXT, tableName };
  }

  const anonymousTable = t.settings.anonymousTable;
  const alias = new Map<string, string>();
  let counter = 0;
  for (const player of [...hand.players].sort((a, b) => a.seat - b.seat)) {
    alias.set(
      player.name,
      player.isHero ? t.settings.anonymousHero : t.settings.anonymousPlayer(++counter),
    );
  }
  if (tableName) {
    alias.set(tableName, anonymousTable);
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
    tableName: tableName ? anonymousTable : null,
  };
}
