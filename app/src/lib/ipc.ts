/**
 * The Rust commands, typed. Each type mirrors a `#[derive(Serialize)]` struct
 * in `src-tauri/src/commands.rs` or `dev.rs` (camelCase on both sides).
 */
import type {
  Shown,
  StatDefinition,
  StatGroup as DefinitionGroup,
  StatText,
  StatTone,
  StatUnit,
} from "@rail/ui/model/stats";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { Locale } from "../i18n/types";

export type Theme = "system" | "dark" | "light";

/** `settings::Density` (R2.8). */
export type Density = "comfortable" | "compact";

export interface Settings {
  version: number;
  theme: Theme;
  /** R2.8: lists and tables. */
  density: Density;
  /** R2.8: the window's and the tray's language. */
  locale: Locale;
  startAtLogin: boolean;
  /** The first-run screen was finished or skipped (R1.4). */
  firstRunDone: boolean;
}

/** `folders::FoundFolder`: a room's default folder found here (R1.4). */
export interface FoundFolder {
  /** `sites.json` id of the room. */
  site: string;
  name: string;
  path: string;
  /** Hand-history files; a lower bound when `complete` is false. */
  files: number;
  complete: boolean;
  /** The newest file's mtime, ms since the epoch. */
  newestMs: number | null;
  /** The folder template was seen on a real install. */
  verified: boolean;
  /** Room file names unknown: files sampled, and how many are the room's. */
  sampleLooked: number | null;
  sampleClaimed: number | null;
  /** Watched already. */
  watched: boolean;
}

/** `folders::RoomLookedFor`. */
export interface RoomLookedFor {
  site: string;
  name: string;
  verified: boolean;
}

/** `folders::Discovery`. */
export interface Discovery {
  os: "macos" | "windows" | null;
  folders: FoundFolder[];
  rooms: RoomLookedFor[];
}

/** `folders::ConfirmedFolder`. */
export interface ConfirmedFolder {
  path: string;
  /** The room it was found for; `null` for a folder added by hand. */
  site: string | null;
}

/** `folders::AddedFolder`. */
export interface AddedFolder {
  path: string;
  id: number;
  /** Files marked as read without importing ("only new hands"). */
  marked: number;
}

export interface CoreInfo {
  coreVersion: string;
  phfSchema: string;
  parsers: string[];
  configVersion: number;
  sites: number | null;
  configError: string | null;
}

export interface AppInfo {
  version: string;
  identifier: string;
  logDir: string | null;
  settingsFile: string;
  debug: boolean;
}

/** `commands::StoreStatus`: the local store's counts (R1.2). */
export interface StoreStatus {
  path: string;
  /** Set when the store did not open or the counts failed. */
  error: string | null;
  schemaVersion: number;
  hands: number;
  handsToday: number;
  files: number;
  filesWithErrors: number;
  sources: number;
  quarantined: number;
  unsupported: number;
  outbox: number;
}

/** `watch::BackfillDto`: a folder's backfill in progress (R1.6). */
export interface Backfill {
  /** Bytes read and committed of `bytesTotal`. */
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  /** Hands stored by this backfill. */
  hands: number;
  /** ms since the epoch. */
  startedAt: number;
  /** At the pace so far; `null` until there is a pace to go by. */
  secondsLeft: number | null;
}

/** `watch::WatchSource`: one watched folder (R1.3). */
export interface WatchSource {
  id: number;
  path: string;
  /** Switched on (a disabled folder keeps its hands). */
  enabled: boolean;
  /** The room it is the default folder of (`sites.json` id), if known. */
  site: string | null;
  /** That room's name in `sites.json`. */
  siteName: string | null;
  /** The room chosen by hand: a parser id forced for every file (R1.5). */
  siteOverride: string | null;
  state: "watching" | "polling" | "unavailable" | "error" | "disabled";
  /** Why the folder cannot be read or watched. */
  error: string | null;
  recursive: boolean;
  /** Read by polling only (a network folder). */
  pollOnly: boolean;
  files: number;
  hands: number;
  handsToday: number;
  quarantined: number;
  /** Files whose last read failed. */
  fileErrors: number;
  /** Files ending in a hand that is not complete yet. */
  pending: number;
  /** A backfill in progress (R1.6), when there is one worth showing. */
  backfill: Backfill | null;
  /** ms since the epoch. */
  lastImportAt: number | null;
}

/** `watch::WatchStatus`: the watcher (R1.3). */
export interface WatchStatus {
  running: boolean;
  paused: boolean;
  /** Import threads, and how many may run at once now (R1.6). */
  threads: number;
  threadsAllowed: number;
  /** Set when the watcher is not running, and why. */
  error: string | null;
  sources: WatchSource[];
}

/** `folder_settings::AddedFolder`: a folder added by hand (R1.5). */
export interface AddedOneFolder {
  id: number;
  path: string;
  marked: number;
}

/** `folder_settings::FolderMoved`: what a new path did to a folder's files. */
export interface FolderMoved {
  /** Found again under the new path: they continue from their offsets. */
  moved: number;
  /** Files of the new folder read before: they keep their own offsets. */
  adopted: number;
  /** Not in the new folder: their hands stay, without a folder. */
  detached: number;
  /** Marked as read ("only new hands"). */
  marked: number;
}

/** `folder_settings::RoomChoice`: a room a folder can be set to. */
export interface RoomChoice {
  /** The parser id (`sources.site_override`). */
  parser: string;
  name: string;
}

/** `folder_settings::RefusedHand`: one refused hand of a folder. */
export interface RefusedHand {
  id: number;
  file: string;
  stage: string;
  /** The machine reason code (`chip-mismatch`, ...). */
  reason: string;
  message: string;
  detectedSite: string | null;
  /** The version of the parser that refused it (`0`: none did). */
  parserVersion: string;
  /** ms since the epoch. */
  lastSeen: number;
}

/** `quarantine::Retryable`: refused by an older parser version (R1.6). */
export interface Retryable {
  hands: number;
  files: number;
}

/** `quarantine::QuarantineSummary`: refused hands per reason (R1.6). */
export interface QuarantineSummary {
  reasons: { reason: string; count: number }[];
  total: number;
  retryable: Retryable;
}

/** `quarantine::QuarantineList`. */
export interface QuarantineList {
  entries: RefusedHand[];
  /** More match than are listed. */
  truncated: boolean;
}

/** `folder_settings::FolderQuarantine`. */
export interface FolderQuarantine {
  reasons: { reason: string; count: number }[];
  entries: RefusedHand[];
  /** More entries exist than are listed. */
  truncated: boolean;
  /** Refused by an older parser version: "Try again after an update" (R1.6). */
  retryable: Retryable;
}

/** `dev::ConvertSummary`; debug builds only. */
export interface ConvertSummary {
  fileName: string;
  bytes: number;
  encoding: string;
  problem: string | null;
  detected: [parser: string, permille: number] | null;
  hands: number;
  refused: number;
  byParser: [parser: string, hands: number][];
  firstRefusals: string[];
  unrecognized: boolean;
  error: string | null;
  millis: number;
}

/** `rail_sync::auth::Notice`: something to tell the user once (R1.7). */
export type AccountNotice =
  | "cancelled"
  | "timedOut"
  | "notInProgress"
  | "invalidLink"
  | "linkRejected"
  | "offline"
  | "sessionEnded"
  | "keychainUnavailable"
  | "signedOutLocally"
  | "browserFailed";

/** `rail_sync::worker::SyncPhase`: what sync is doing (R1.9). */
export type SyncPhase =
  | { state: "starting" }
  /** No account signed in: hands stay on this computer. */
  | { state: "signedOut" }
  | { state: "paused" }
  /** Signed in as another account than the one this computer's hands sync to. */
  | { state: "accountMismatch"; ownerEmail: string | null; email: string; localHands: number }
  /** The user kept this computer's hands apart from the signed-in account. */
  | { state: "declined"; ownerEmail: string | null; email: string; localHands: number }
  | { state: "syncing" }
  | { state: "upToDate" }
  /** Not an error: the server cannot be reached; retried by itself. */
  | { state: "offline"; retryAtMs: number }
  | { state: "rateLimited"; retryAtMs: number }
  | { state: "failed"; message: string; retryAtMs: number };

/** `rail_sync::worker::SyncStatus`. */
export interface SyncStatus {
  phase: SyncPhase;
  paused: boolean;
  /** Hands waiting to be sent; `live` of them queued in the last minutes. */
  outbox: number;
  live: number;
  retrying: number;
  /** "Syncing `sent` of `total`", since the outbox was last empty. */
  sent: number;
  total: number;
  /** Hands the server refused, per reason code. */
  rejected: { reason: string; count: number }[];
  pulled: number;
  pullSkipped: number;
  lastSyncAt: number | null;
  handsPerSecond: number | null;
  bytesPerSecond: number | null;
  /** The cap chosen for a large backlog, and the one in force now (bytes/s). */
  cap: number | null;
  capNow: number | null;
  tablesOpen: boolean;
}

/** `rail_sync::auth::AccountStatus`: the desktop account (R1.7). */
export type AccountStatus =
  /** This build has no account service: Rail works on this computer only. */
  | { state: "notConfigured" }
  | { state: "signedOut"; notice: AccountNotice | null }
  /** Waiting for the browser; `url` is the page, to open again. */
  | { state: "signingIn"; url: string; secondsLeft: number; notice: AccountNotice | null }
  /** `online`: the last refresh reached the server. */
  | { state: "signedIn"; email: string; userId: string; online: boolean; notice: AccountNotice | null };

/** `stats::StatsStatusDto`: the background statistics pass (R2.3). */
export interface StatsStatus {
  activity:
    | "idle"
    | "rebuilding"
    | "indexing"
    | "counting"
    | "computing"
    | "recomputing-ev"
    | "paused-backfill"
    | "paused-tables"
    | "stopped";
  /** A recompute's rows job in progress (R2.11): hands done, of hands to do... */
  rebuildDone: number | null;
  rebuildTotal: number | null;
  /** ...which job... */
  rebuildJob: "rows" | "segments" | null;
  /** ...and whether it fills a store that had no statistics (the screens grow as it goes). */
  rebuildFills: boolean;
  /** A recompute's EV job in progress: hands evaluated, of hands to do. */
  evRecomputeDone: number | null;
  evRecomputeTotal: number | null;
  /** Hands waiting for their all-in EV. */
  evPending: number;
  /** Hands whose opponents are not indexed yet (R2.7c). */
  playersUnindexed: number;
  /** EV rows computed since the app started, and the time it took. */
  evComputed: number;
  evMillis: number;
  lastError: string | null;
}

/* ------------------------------------------------------- Hands (R2.7a) - */

/**
 * The Hands screen's shapes (`hands::FilterDto`, `HandRowDto`, `FacetsDto`)
 * are the shared screen's since R4.5b (`@rail/ui/hands/model`): the store's
 * DTOs, with the web-only fields optional.
 */
export type {
  FacetCount,
  HandFacets,
  HandFilter,
  HandRow,
  PlayerRef,
  SiteFacet,
  StakeFacet,
} from "@rail/ui/hands/model";
import type { FacetCount, HandFacets, HandFilter, HandRow } from "@rail/ui/hands/model";

/** `hands::CursorDto`: where the next page starts. */
export interface HandCursor {
  playedAt: string;
  handKey: string;
}

export interface HandPage {
  rows: HandRow[];
  next: HandCursor | null;
}

export interface HandAnnotations {
  note: string | null;
  tags: string[];
}

export interface SavedFilter {
  id: number;
  name: string;
  /** The filter as saved (JSON of `HandFilter`). */
  filter: string;
}

/* ------------------------------------------------ Today, Reports (R2.7b) - */

/**
 * The Reports screen's shapes (`reports::UnitsDto`, `GroupDto`, `BucketDto`,
 * `GraphDto`, `ReportDto`, `BreakdownsDto`) are the shared screen's since
 * R4.5c (`@rail/ui/reports/model`).
 */
export type { Breakdowns, Graph, GraphBucket, Report, StatGroup, Units } from "@rail/ui/reports/model";
import type { Breakdowns, Report, StatGroup, Units } from "@rail/ui/reports/model";

/** `reports::SessionDto`: the latest session. */
export interface Session {
  startedAt: string;
  endedAt: string;
  /** The newest hand is within the session gap of now. */
  current: boolean;
  gapMinutes: number;
  hands: number;
  tables: number | null;
  net: number | null;
  netBbMilli: number | null;
  units: Units;
  /** Every definition over the session, in `statDefinitions()`' order. */
  stats: Shown[];
  biggestPots: HandRow[];
}

/* ------------------------------------------------------ Players (R2.7c) - */

/**
 * The Players screen's shapes (`players::*Dto`) are the shared screen's since
 * R4.5c (`@rail/ui/players/model`).
 */
export { PLAYER_COLOURS } from "@rail/ui/players/model";
export type {
  GameKind,
  PlayerColour,
  PlayerList,
  PlayerNotes,
  PlayerProfile,
  PlayerQuery,
  PlayerRow,
  PlayerSeen,
  PlayerSite,
  StakeSample,
  Together,
} from "@rail/ui/players/model";
import type {
  GameKind,
  PlayerColour,
  PlayerList,
  PlayerNotes,
  PlayerProfile,
  PlayerQuery,
  PlayerSeen,
  PlayerSite,
} from "@rail/ui/players/model";

/** The screens with saved filters. */
export type FilterScreen = "hands" | "reports";

/* ------------------------------------------------- The HUD (R3.2, R3.8) - */

/* ------------------------------------------------ The HUD editor (R3.9) - */

/** `rail_hud::design::GameFormat`: what a design is assigned by. `mtt`: tournaments and sit-and-gos. */
export type GameFormat = "cash" | "mtt" | "spin";

/** A colour band as a design overrides it (`rail_config::stats::Band`). */
export interface DesignBand {
  below?: number;
  tone: StatTone;
}

/** `design::StackWhen`: a cell shown only at these stack depths (whole big blinds). */
export interface StackWhen {
  belowBb?: number;
  atLeastBb?: number;
}

/** `design::Cell`. */
export interface DesignCell {
  stat: string;
  when?: StackWhen;
}

/** `design::StatOverride`: the user's layer over a definition, by id. */
export interface StatOverride {
  bands?: DesignBand[];
  decimals?: number;
  minSample?: number;
}

/** `design::PopupSection`. */
export interface PopupSection {
  group?: DefinitionGroup;
  title?: string;
  stats: string[];
}

/** `design::HudDesign`: what a panel and its popup show. */
export interface HudDesign {
  version: number;
  name: string;
  preset?: string;
  format: GameFormat;
  columns: number;
  cells: DesignCell[];
  overrides?: Record<string, StatOverride>;
  popup: PopupSection[];
  legend: boolean;
  playerLabels: boolean;
  maxColourThresholds: number | null;
}

/** `design::Problem`: what a design cannot do, anywhere or on a room. */
export type DesignProblem =
  | { code: "version" | "nameTooLong" | "noCells" | "tooManyCells" | "columns" | "tooManyPopup" | "titleTooLong" }
  | { code: "labels" | "roomNotAllowed" }
  | {
      code:
        | "unknownStat"
        | "duplicateStat"
        | "heroOnlyStat"
        | "moneyStat"
        | "badWhen"
        | "badBands"
        | "badDecimals"
        | "badSample"
        | "cardSplit"
        | "gameStateSwitching";
      stat: string;
    }
  | { code: "colourThresholds"; stat: string; count: number; max: number };

/** `sites.json` `hud.restrictions` (`rail_config::model::HudRestrictions`). */
export interface HudRestrictions {
  ownHandsOnly: boolean;
  rawCountsOnly: boolean;
  maxColourThresholds: number | null;
  noCardSplitStats: boolean;
  noGameStateSwitching: boolean;
  noTendencySwitching: boolean;
  noPlayerLabels: boolean;
  noHandCharts: boolean;
  noGraphs: boolean;
  noHandInPlay: boolean;
  noOverlapTableGraphics: boolean;
}

/** `hud_editor::RoomDto`: a room whose HUD is allowed. */
export interface HudRoom {
  id: string;
  name: string;
  restrictions: HudRestrictions;
}

/** `hud_editor::StatDto`: a statistic a design may name. */
export interface HudStat {
  id: string;
  label: StatText;
  name: StatText;
  description: StatText;
  group: DefinitionGroup;
  unit: StatUnit;
  decimals: number;
  minSample: number;
  bands: DesignBand[];
  hud: "panel" | "popup" | "none";
  custom: boolean;
  cardSplit: boolean;
  heroOnly: boolean;
  money: boolean;
}

export interface HudPreset {
  id: string;
  name: StatText;
  description: StatText;
  design: HudDesign;
}

export interface HudUserDesign {
  id: string;
  design: HudDesign;
  updatedAt: number;
}

/** `hud_editor::CheckDto`. */
export interface HudCheck {
  problems: DesignProblem[];
  rooms: Record<string, DesignProblem[]>;
}

export interface HudAssignment {
  site: string;
  size: number | null;
  format: GameFormat | null;
  layout: string;
  refused: Record<string, DesignProblem[]>;
}

export interface HudResolved {
  site: string;
  size: number | null;
  format: GameFormat;
  layout: string;
  assigned: boolean;
}

/** `hud_editor::EditorStateDto`. */
export interface HudEditorState {
  presets: HudPreset[];
  defaults: Record<GameFormat, string>;
  designs: HudUserDesign[];
  assignments: HudAssignment[];
  resolved: HudResolved[];
  rooms: HudRoom[];
  stats: HudStat[];
  checks: Record<string, HudCheck>;
  positions: { site: string; size: number; panels: number }[];
  roomSettings: { site: string; preferredSeat: boolean | null }[];
  limits: {
    maxCells: number;
    maxColumns: number;
    maxDecimals: number;
    maxPopupSections: number;
    maxPopupStats: number;
  };
}

export interface HudSaved {
  id: string | null;
  problems: DesignProblem[];
  refused: Record<string, DesignProblem[]>;
}

export interface HudAssigned {
  ok: boolean;
  refused: Record<string, DesignProblem[]>;
}

export interface PreviewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One thing the HUD's renderer paints (`rail_hud::scene::Item`). */
export type PreviewItem =
  | { kind: "fill"; rect: PreviewRect; radius: number; color: [number, number, number, number] }
  | {
      kind: "text";
      rect: PreviewRect;
      text: string;
      px: number;
      color: [number, number, number, number];
      bold: boolean;
      align: "center";
    };

/** `hud_editor::PreviewDto`. */
export interface HudPreview {
  width: number;
  height: number;
  size: number;
  plates: PreviewRect[];
  board: PreviewRect;
  heroSlot: number;
  items: PreviewItem[];
  panels: { slot: number; rect: PreviewRect; stats: string[]; placedByUser: boolean; stackBb: number }[];
  legend: PreviewRect | null;
  problems: DesignProblem[];
}

/** `rail_hud_ipc::protocol::RefusalReason`: why compliance mode refused a window (R3.2, R3.10). */
export type RefusalReason = "prohibited" | "unknown" | "not-a-room" | "unknown-site";

/** `hud::TableDto` (R3.10): a table the HUD is attached to. */
export interface HudTable {
  site: string;
  window: number;
  /** The table's name from the window's title. */
  table: string | null;
  /** No hand of this table yet. */
  waiting: boolean;
}

/** `hud::RefusedDto` (R3.10): a window that looked like a table, refused, still open. */
export interface HudRefused {
  site: string;
  window: number;
  table: string | null;
  reason: RefusalReason;
}

/** `hud::HudStatusDto`, the part the window reads: the HUD process and its tables. */
export interface HudStatus {
  /** `off`, `not-installed`, `starting`, `running`, `backoff`, `stopped`. */
  phase: string;
  /** Why the HUD is off (`off` only). */
  error: string | null;
  tablesOpen: number;
  tablesWaiting: number;
  /** (R3.10) The tables attached. */
  tables: HudTable[];
  /** (R3.10) The windows compliance mode refused. */
  refused: HudRefused[];
  /** (R3.10) The HUD's policy has the remote room list merged in. */
  remotePolicy: boolean;
  /**
   * (R3.11) A system permission the HUD needs to find tables and does not
   * have: `accessibility` on macOS (window titles) - only when granting it
   * would find tables now (a supported client runs, or the simulator's
   * test entry is on). `null`: none missing, or nothing to gain.
   */
  permissionNeeded: string | null;
  /** (R3.11) Missing, but no supported poker client runs: say so, ask nothing. */
  permissionDeferred: string | null;
}

/** `rail_config::model::SiteKind`. */
export type SiteKind = "room" | "network" | "format";

/** `policy::RoomPolicyDto` (R3.10): one entry's HUD policy. */
export interface RoomPolicy {
  id: string;
  name: string;
  kind: SiteKind;
  /** `true` allowed, `false` prohibited, `null` unknown (which counts as no). */
  allowed: boolean | null;
  /** Compliance mode's decision: a room, allowed. */
  permitted: boolean;
  /** The room's own page the policy was read from (or a note in Rail's repository). */
  source: string | null;
  /** `YYYY-MM-DD`. */
  checkedAt: string | null;
  notes: string;
  restrictions: HudRestrictions | null;
  /** An update of the room list made it stricter than this version's own copy. */
  stricterThanShipped: boolean;
}

/** `rail_sync::policy::Outcome`: how the last look for a new room list went. */
export type PolicyOutcome =
  | { kind: "updated" }
  | { kind: "current" }
  | { kind: "refused"; error: string }
  | { kind: "failed"; error: string };

/** `policy::PolicyDto` (R3.10): the room list in force. */
export interface HudPolicy {
  rooms: RoomPolicy[];
  /** An update from the web is merged in (else: this version's own list). */
  remote: boolean;
  url: string | null;
  /** When the update in force was downloaded, Unix seconds. */
  fetchedAt: number | null;
  lastCheck: { at: number; outcome: PolicyOutcome } | null;
  /** What the update would have loosened and was not taken, one line each. */
  notes: string[];
}

/** `popup::PopupRules`: what the room's HUD rules let the popup show. */
export interface PopupRules {
  ownHandsOnly: boolean;
  /** Colour by at most this many thresholds. */
  colourThresholds: number | null;
  /** Rows by position (not where the display may not switch with game state: PokerStars, Winamax). */
  byPosition: boolean;
  /** The user's words - colour tag, labels, note (not where labelling players is banned: PokerStars, ACR). */
  words: boolean;
}

/** `popup::BandDto`: one colour band in use, `below` its upper threshold (none: the rest). */
export interface PopupBand {
  below: number | null;
  tone: StatTone;
}

/** `popup::PopupDto`: what the HUD popup shows (R3.8). */
export interface HudPopup {
  site: string;
  siteName: string;
  /** The site the player's words are kept under. */
  storeSite: string;
  table: string | null;
  player: string;
  hero: boolean;
  /** An opaque-id seat: one session's token, not a name. */
  opaque: boolean;
  rules: PopupRules;
  /** Hands their statistics count. */
  hands: number;
  /** The statistics shown, by definition id. */
  ids: string[];
  stats: Shown[];
  /** Each statistic's thresholds in use. */
  legend: { id: string; bands: PopupBand[] }[];
  together: PlayerSeen | null;
  notes: PlayerNotes | null;
  columns: string[];
  byPosition: StatGroup[] | null;
  /** (R3.9) The table's design's sections; `null`: by group. */
  sections: { group: DefinitionGroup | null; title: string | null; ids: string[] }[] | null;
}

/* ------------------------------------------- Custom statistics (R2.10) - */

/** `reports::DefinitionDto`: a shipped definition, or the user's own (`custom`). */
export interface Definition extends StatDefinition {
  custom: boolean;
}

/** `rail_stats::custom::CustomProblem`: what is wrong, and where (byte offsets into the predicate or a formula). */
export interface CustomProblem {
  part: "id" | "predicate" | "formula" | "sample" | "other";
  offset: number | null;
  length: number | null;
  message: string;
}

/** `custom_stats::FieldDto`: a field of the predicate language. */
export interface CustomField {
  name: string;
  kind: "bool" | "number" | "choice";
  choices: string[];
}

/** `custom_stats::CustomStatDto`: a saved statistic. */
export interface CustomStat {
  definition: StatDefinition;
  predicate: string | null;
  /** Why this build cannot show it; empty when fine. */
  problems: CustomProblem[];
  /** Hands the background pass has still to count, of `total` (null: no counter). */
  remaining: number | null;
  total: number | null;
  /** Over every hero hand counted so far. */
  shown: Shown | null;
}

/** `custom_stats::CustomListDto`. */
export interface CustomList {
  stats: CustomStat[];
  fields: CustomField[];
  /** The shipped definitions' ids (taken). */
  shipped: string[];
  previewHands: number;
}

/** `custom_stats::CheckDto`: a draft's problems, or its preview. */
export interface CustomCheck {
  problems: CustomProblem[];
  preview: {
    shown: Shown;
    made: number | null;
    opp: number | null;
    hands: number;
    /** true: the last `previewHands` hands; false: every hand. */
    sample: boolean;
  } | null;
}

/** What the editor sends: the definition and its predicate. */
export interface CustomDraft {
  definition: StatDefinition;
  predicate: string | null;
}

/** False in a plain browser (`npm run dev` without Tauri). */
export const inApp = isTauri();

export const ipc = {
  coreInfo: () => invoke<CoreInfo>("core_info"),
  appInfo: () => invoke<AppInfo>("app_info"),
  getSettings: () => invoke<Settings>("get_settings"),
  setTheme: (theme: Theme) => invoke<Settings>("set_theme", { theme }),
  setDensity: (density: Density) => invoke<Settings>("set_density", { density }),
  /** Also relabels the tray. */
  setLocale: (locale: Locale) => invoke<Settings>("set_locale", { locale }),
  setStartAtLogin: (enabled: boolean) => invoke<Settings>("set_start_at_login", { enabled }),
  setFirstRunDone: (done: boolean) => invoke<Settings>("set_first_run_done", { done }),
  storeStatus: () => invoke<StoreStatus>("store_status"),
  watcherStatus: () => invoke<WatchStatus>("watcher_status"),
  setImportPaused: (paused: boolean) => invoke<null>("set_import_paused", { paused }),
  discoverFolders: () => invoke<Discovery>("discover_folders"),
  addFolders: (folders: ConfirmedFolder[], onlyNew: boolean) =>
    invoke<AddedFolder[]>("add_folders", { folders, onlyNew }),
  /** The system folder picker; `null` when cancelled. */
  pickFolder: () => invoke<string | null>("pick_folder"),
  /** Settings, Folders (R1.5). `pollOnly: null` decides by the volume. */
  addFolder: (path: string, onlyNew: boolean, recursive: boolean, pollOnly: boolean | null) =>
    invoke<AddedOneFolder>("add_folder", { path, onlyNew, recursive, pollOnly }),
  setFolderPath: (id: number, path: string, onlyNew: boolean) =>
    invoke<FolderMoved>("set_folder_path", { id, path, onlyNew }),
  /** `parser: null` detects the room per file. Returns the files read again. */
  setFolderRoom: (id: number, parser: string | null) => invoke<number>("set_folder_room", { id, parser }),
  setFolderEnabled: (id: number, enabled: boolean) => invoke<null>("set_folder_enabled", { id, enabled }),
  setFolderRecursive: (id: number, recursive: boolean) => invoke<null>("set_folder_recursive", { id, recursive }),
  setFolderPollOnly: (id: number, pollOnly: boolean) => invoke<null>("set_folder_poll_only", { id, pollOnly }),
  removeFolder: (id: number) => invoke<null>("remove_folder", { id }),
  folderRooms: () => invoke<RoomChoice[]>("folder_rooms"),
  folderQuarantine: (id: number) => invoke<FolderQuarantine>("folder_quarantine", { id }),
  /** Refused hands per reason, app-wide (`sourceId: null`) or of one folder (R1.6). */
  quarantineSummary: (sourceId: number | null) => invoke<QuarantineSummary>("quarantine_summary", { sourceId }),
  quarantineEntries: (sourceId: number | null, reason: string | null) =>
    invoke<QuarantineList>("quarantine_entries", { sourceId, reason }),
  /** A refused hand's raw text; `null` when it is gone (read again meanwhile). */
  quarantineRawText: (id: number) => invoke<string | null>("quarantine_raw_text", { id }),
  /** Read again what an older parser refused. Returns the files read again. */
  retryRefused: (sourceId: number | null) => invoke<number>("retry_refused", { sourceId }),
  /** The account (R1.7). Signing in opens the web's sign-in page in the default browser. */
  accountStatus: () => invoke<AccountStatus>("account_status"),
  accountSignIn: () => invoke<AccountStatus>("account_sign_in"),
  accountOpenSignInPage: () => invoke<AccountStatus>("account_open_sign_in_page"),
  accountCancelSignIn: () => invoke<AccountStatus>("account_cancel_sign_in"),
  accountSignOut: () => invoke<AccountStatus>("account_sign_out"),
  /** Sync with the web (R1.9). `null`: sync is off in this build. */
  syncStatus: () => invoke<SyncStatus | null>("sync_status"),
  syncNow: () => invoke<SyncStatus>("sync_now"),
  syncSetPaused: (paused: boolean) => invoke<SyncStatus>("sync_set_paused", { paused }),
  /** Bytes a second while a large backlog syncs; `null`: no limit. */
  syncSetCap: (cap: number | null) => invoke<SyncStatus>("sync_set_cap", { cap }),
  /** Upload this computer's hands to the account signed in now, or keep them apart. */
  syncAnswerAccount: (upload: boolean) => invoke<SyncStatus>("sync_answer_account", { upload }),
  syncRetryRejected: () => invoke<SyncStatus>("sync_retry_rejected"),
  /** The statistics pass (R2.3). */
  statsStatus: () => invoke<StatsStatus>("stats_status"),
  /** Rebuild every hand's statistics in the background; returns the hands to go through. */
  statsRebuild: () => invoke<number>("stats_rebuild"),
  /** Compute every hero hand's all-in EV again; returns the hands queued. */
  statsRecomputeEv: () => invoke<number>("stats_recompute_ev"),
  /** The Hands screen (R2.7a). */
  handsPage: (filter: HandFilter, after: HandCursor | null, limit: number) =>
    invoke<HandPage>("hands_page", { filter, after, limit }),
  handsFacets: (filter: HandFilter) => invoke<HandFacets>("hands_facets", { filter }),
  handsByKey: (keys: string[]) => invoke<HandRow[]>("hands_by_key", { keys }),
  /** "Go to hand": by the room's id (a prefix of it) or the hand key. */
  handsFind: (query: string, limit: number) => invoke<HandRow[]>("hands_find", { query, limit }),
  /** A hand's PHF as JSON text; `null` when the store has no such hand. */
  handPhf: (handKey: string) => invoke<string | null>("hand_phf", { handKey }),
  handAnnotations: (handKey: string) => invoke<HandAnnotations>("hand_annotations", { handKey }),
  handSetNote: (handKey: string, note: string) => invoke<HandAnnotations>("hand_set_note", { handKey, note }),
  handAddTag: (handKey: string, tag: string) => invoke<HandAnnotations>("hand_add_tag", { handKey, tag }),
  handRemoveTag: (handKey: string, tag: string) => invoke<HandAnnotations>("hand_remove_tag", { handKey, tag }),
  savedFilters: (screen: FilterScreen = "hands") => invoke<SavedFilter[]>("saved_filters", { screen }),
  saveFilter: (name: string, filter: string, screen: FilterScreen = "hands") =>
    invoke<SavedFilter[]>("save_filter", { name, filter, screen }),
  deleteSavedFilter: (id: number, screen: FilterScreen = "hands") =>
    invoke<SavedFilter[]>("delete_saved_filter", { id, screen }),
  /** Today and Reports (R2.7b). Every shipped statistic definition, in file order. */
  statDefinitions: () => invoke<Definition[]>("stat_definitions"),
  /** The user's own statistics (R2.10). */
  customStatsList: () => invoke<CustomList>("custom_stats_list"),
  customStatCheck: (draft: CustomDraft, replacing: string | null) =>
    invoke<CustomCheck>("custom_stat_check", { draft, replacing }),
  customStatSave: (draft: CustomDraft, replacing: string | null) =>
    invoke<{ problems: CustomProblem[]; list: CustomList | null }>("custom_stat_save", { draft, replacing }),
  customStatDelete: (id: string) =>
    invoke<{ deleted: boolean; readBy: string | null; list: CustomList }>("custom_stat_delete", { id }),
  /** The report over a filter (the Hands filter's report groups); `points`: the graph's buckets. */
  report: (filter: HandFilter, points: number) => invoke<Report>("report", { filter, points }),
  reportBreakdowns: (filter: HandFilter) => invoke<Breakdowns>("report_breakdowns", { filter }),
  today: () => invoke<{ session: Session | null }>("today"),
  /** Players (R2.7c). */
  playersList: (query: PlayerQuery) => invoke<PlayerList>("players_list", { query }),
  playerProfile: (site: string, player: string, kind: GameKind) =>
    invoke<PlayerProfile>("player_profile", { site, player, kind }),
  playerSites: () => invoke<PlayerSite[]>("player_sites"),
  playerLabels: () => invoke<FacetCount[]>("player_labels"),
  playerSetNote: (site: string, player: string, note: string) =>
    invoke<PlayerNotes>("player_set_note", { site, player, note }),
  playerSetColour: (site: string, player: string, colour: PlayerColour | null) =>
    invoke<PlayerNotes>("player_set_colour", { site, player, colour }),
  playerAddLabel: (site: string, player: string, label: string) =>
    invoke<PlayerNotes>("player_add_label", { site, player, label }),
  playerRemoveLabel: (site: string, player: string, label: string) =>
    invoke<PlayerNotes>("player_remove_label", { site, player, label }),
  /** The HUD process (R3.2): its tables (A10: analysis hides while one is open). */
  hudStatus: () => invoke<HudStatus>("hud_status"),
  /**
   * (R3.11) The user's click: the HUD asks macOS for its prompt, and System
   * Settings opens where `permission` (`accessibility`) is granted.
   */
  hudRequestPermission: (permission: string) => invoke<null>("hud_request_permission", { permission }),
  /** (R3.10) Compliance mode: every room's HUD policy, where the list came from, a look for a new one, a room's policy page. */
  hudPolicy: () => invoke<HudPolicy>("hud_policy"),
  hudPolicyCheck: () => invoke<HudPolicy>("hud_policy_check"),
  hudOpenPolicySource: (site: string) => invoke<null>("hud_open_policy_source", { site }),
  /** The HUD popup (R3.8): what it shows (`null`: none open), close it, open the player in Rail. */
  hudPopup: () => invoke<HudPopup | null>("hud_popup"),
  hudPopupClose: () => invoke<null>("hud_popup_close"),
  hudPopupOpenInApp: () => invoke<null>("hud_popup_open_in_app"),
  /** The HUD editor (R3.9). */
  hudEditorState: () => invoke<HudEditorState>("hud_editor_state"),
  hudDesignCheck: (design: HudDesign) => invoke<HudCheck>("hud_design_check", { design }),
  hudDesignSave: (id: string | null, design: HudDesign) => invoke<HudSaved>("hud_design_save", { id, design }),
  hudDesignDelete: (id: string) => invoke<boolean>("hud_design_delete", { id }),
  hudAssign: (site: string, size: number | null, format: GameFormat | null, layout: string | null) =>
    invoke<HudAssigned>("hud_assign", { site, size, format, layout }),
  hudPreview: (design: HudDesign, site: string, size: number) =>
    invoke<HudPreview>("hud_preview", { design, site, size }),
  /** R3.6's: dragged panels back to the layout's places (`size` null: every size). */
  hudResetSeatPositions: (site: string, size: number | null) =>
    invoke<number>("hud_reset_seat_positions", { site, size }),
  /** R3.6's: the user's client rotates the table (`null`: as `sites.json` says). */
  hudSetPreferredSeat: (site: string, preferred: boolean | null) =>
    invoke<null>("hud_set_preferred_seat", { site, preferred }),
  dev: {
    pickFile: () => invoke<string | null>("dev_pick_file"),
    convertFile: (path: string) => invoke<ConvertSummary>("convert_file", { path }),
  },
};

/**
 * Call `onChange` whenever the watcher's status changed (an import, a
 * folder's state, backfill progress; at most once a second). Returns the
 * function that stops listening. Outside the app it does nothing.
 */
export function onWatcherChanged(onChange: () => void): () => void {
  return onAppEvent("watcher-changed", onChange);
}

/**
 * Call `onChange` whenever the statistics the screens show may have changed:
 * hands arrived (`watcher-changed`), or a recompute swapped new statistics in
 * (R2.11, `stats-changed`).
 */
export function onStatsDataChanged(onChange: () => void): () => void {
  const watcher = onWatcherChanged(onChange);
  const stats = onAppEvent("stats-changed", onChange);
  return () => {
    watcher();
    stats();
  };
}

/** Call `onChange` whenever the sync status changed (R1.9; at most once a second). */
export function onSyncChanged(onChange: () => void): () => void {
  return onAppEvent("sync-changed", onChange);
}

/** Call `onChange` whenever the account's status changed (R1.7). */
export function onAccountChanged(onChange: () => void): () => void {
  return onAppEvent("account-changed", onChange);
}

/** (R3.8) The HUD popup was moved to another panel: read it again. */
export function onHudPopupChanged(onChange: () => void): () => void {
  return onAppEvent("hud-popup-changed", onChange);
}

/** (R3.9) A sync brought another computer's HUD designs or layouts. */
export function onHudLayoutsChanged(onChange: () => void): () => void {
  return onAppEvent("hud-layouts-changed", onChange);
}

/** (R3.10) The HUD's tables or refused windows changed. */
export function onHudStatusChanged(onChange: () => void): () => void {
  return onAppEvent("hud-status-changed", onChange);
}

/** (R3.10) The room list in force changed (an update from the web). */
export function onHudPolicyChanged(onChange: () => void): () => void {
  return onAppEvent("hud-policy-changed", onChange);
}

/** (R3.8, A10) Whether the HUD has any table open, on each change. */
export function onTablesOpen(onChange: (open: boolean) => void): () => void {
  return onAppEvent<boolean>("hud-tables-open", onChange);
}

/** `hud::OpenPlayer`: "show this player" from the HUD popup. */
export interface OpenPlayer {
  site: string;
  name: string;
  scope: string;
}

/** (R3.8) The HUD popup's "Open in Rail". */
export function onOpenPlayer(onOpen: (player: OpenPlayer) => void): () => void {
  return onAppEvent<OpenPlayer>("hud-open-player", onOpen);
}

function onAppEvent<T = unknown>(name: string, onChange: (payload: T) => void): () => void {
  if (!inApp) {
    return () => undefined;
  }
  let stop: (() => void) | null = null;
  let stopped = false;
  listen<T>(name, (event) => onChange(event.payload))
    .then((unlisten) => {
      if (stopped) {
        unlisten();
      } else {
        stop = unlisten;
      }
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    stop?.();
  };
}

/** A rejected `invoke` carries the command's `Err(String)`. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
