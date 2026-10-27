/**
 * The Players screen's data (R4.5c): what a surface answers with, and the
 * `PlayersSource` it implements - the desktop app over its local store
 * (`rail_store::players`, `app/src/lib/playersSource.ts`), the web over its
 * server summaries (`players_list` / `player_profile`,
 * `web/src/lib/db/playersSource.ts`). The shapes are the app's
 * commands' DTOs (`app/src-tauri/src/players.rs`), which the app's `ipc.ts`
 * re-exports.
 *
 * What a surface does not keep it declares (`PlayersFeatures`) and the
 * screen leaves out: the web keeps no colours and no labels (the owner's
 * decision, 2026-10-23: they stay the app's, no sync).
 */
import type { FacetCount, PlayerRef } from "../hands/model";
import type { Shown } from "../model/stats";
import type { StatGroup } from "../reports/model";

export type { PlayerRef };

/** The colour tags, in the order the screen offers them (`rail_store::players::COLOURS`). */
export const PLAYER_COLOURS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
export type PlayerColour = (typeof PLAYER_COLOURS)[number];

/** Which hands a players list counts: all, cash games, tournament chips. */
export type GameKind = "all" | "cash" | "chips";

/** `players::PlayerQueryDto`. */
export interface PlayerQuery {
  /** A prefix of the name, any case. */
  search?: string;
  site?: string | null;
  kind?: GameKind;
  colours?: string[];
  labels?: string[];
  noted?: boolean | null;
  limit?: number;
}

/** `players::PlayerRowDto`: one opponent in the list. */
export interface PlayerRow {
  site: string;
  siteName: string;
  player: string;
  /** Hands together in the list's kind. */
  hands: number;
  /** The hero's result against them, thousandths of a big blind; null when the list mixes chips with cash. */
  netBbMilli: number | null;
  moneyHands: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  colour: PlayerColour | null;
  labels: string[];
  hasNote: boolean;
}

/** `players::PlayerListDto`. */
export interface PlayerList {
  rows: PlayerRow[];
  /** Players the query matches (`rows` are the first of them). */
  matching: number;
  /** Players of the room and kind, before the search and the words. */
  players: number;
  cashHands: number;
  chipsHands: number;
  mixedKind: boolean;
  /** Opponents' hands of rooms that hide names: counted, not listed. */
  hiddenHands: number;
}

/** `players::TogetherDto`: the hero's hands with an opponent and result against them, one kind. */
export interface Together {
  hands: number;
  moneyHands: number;
  netBbMilli: number;
}

/** `players::SeenDto`. */
export interface PlayerSeen {
  /** Their hands counted in the statistics. */
  hands: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  cash: Together;
  chips: Together;
}

/** `players::NotesDto`: the user's words on a player. */
export interface PlayerNotes {
  colour: PlayerColour | null;
  note: string;
  labels: string[];
}

/** A stake's label parts (a hand of that stake). */
export interface StakeSample {
  key: string;
  currency: string;
  currencySymbol: string;
  minorUnits: number;
  smallBlind: number;
  bigBlind: number;
}

/** `players::ProfileDto`: one opponent. */
export interface PlayerProfile {
  site: string;
  siteName: string;
  player: string;
  /** null: not an opponent of a room with real names. */
  seen: PlayerSeen | null;
  notes: PlayerNotes;
  /** The profile's sample mixes chips with cash: big-blind statistics withheld. */
  mixedKind: boolean;
  /** Every definition, in the definitions' order; hero-only ones withheld. */
  stats: Shown[];
  columns: string[];
  byPosition: StatGroup[];
  byStake: StatGroup[];
  bySize: StatGroup[];
  byFormat: StatGroup[];
  stakes: StakeSample[];
  lastPlayedAt: string | null;
}

/** `players::SiteDto`. */
export interface PlayerSite {
  value: string;
  name: string;
}

/** What a surface keeps of the user's words on a player (a note always). */
export interface PlayersFeatures {
  /** A colour tag per player (the app's). */
  colours: boolean;
  /** Labels (the app's). */
  labels: boolean;
}

/** Where a surface's Players screen reads and writes. */
export interface PlayersSource {
  features: PlayersFeatures;
  list(query: PlayerQuery): Promise<PlayerList>;
  profile(site: string, player: string, kind: GameKind): Promise<PlayerProfile>;
  /** The rooms of the listed opponents, by name (the room filter). */
  sites(): Promise<PlayerSite[]>;
  /** Labels in use and how many players have each (none where `features.labels` is off). */
  labels(): Promise<FacetCount[]>;
  /** Each write answers with the player's words as saved. */
  setNote(site: string, player: string, note: string): Promise<PlayerNotes>;
  setColour(site: string, player: string, colour: PlayerColour | null): Promise<PlayerNotes>;
  addLabel(site: string, player: string, label: string): Promise<PlayerNotes>;
  removeLabel(site: string, player: string, label: string): Promise<PlayerNotes>;
  /** New hands arrived: the list reads again (at most once per throttle). Returns the unsubscribe. */
  onChanged?(listener: () => void): () => void;
}

/** A failure's words. */
export function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** `site:player`, a row's key (a site key never holds a colon; a name may). */
export function playerKey(ref: PlayerRef): string {
  return `${ref.site}:${ref.player}`;
}
