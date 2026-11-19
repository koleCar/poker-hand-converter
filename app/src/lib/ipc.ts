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
import { emit, listen } from "@tauri-apps/api/event";

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
  /** Settings, Updates: look for a newer Rail by itself (`updates.rs`). */
  checkForUpdates: boolean;
}

/** `updates::Stage`: which update step failed. */
export type UpdateStage = "check" | "download" | "install";

/** `updates::FailKind`. */
export type UpdateFailKind = "network" | "noRelease" | "noBuild" | "signature" | "other";

/** `updates::Phase`: where the update stands. */
export type UpdatePhase =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate" }
  | { state: "available"; version: string; notes: string | null; dateMs: number | null }
  | { state: "downloading"; version: string; downloaded: number; total: number | null }
  | { state: "ready"; version: string; notes: string | null }
  | { state: "installing"; version: string }
  | { state: "failed"; stage: UpdateStage; kind: UpdateFailKind; reason: string; version: string | null };

/** `updates::InstallBlocker`: why this copy cannot install an update itself. */
export type UpdateInstallBlocker = "devBuild" | "readOnlyLocation";

/** `updates::UpdateStatus`. */
export interface UpdateStatus {
  /** This build's version. */
  current: string;
  phase: UpdatePhase;
  /** The last check that got an answer, ms since the epoch. */
  lastCheckedMs: number | null;
  /** The setting: check by itself. */
  automatic: boolean;
  installBlocker: UpdateInstallBlocker | null;
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
  /** (R6.5) The local store's folder: what removing the local data means. */
  dataDir: string | null;
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
  /** The room's name for `detectedSite` ("WePlay"), when a parser recognised it. */
  siteName: string | null;
  /** When the hand was played, as its header wrote it; `null` when unreadable. */
  handTime: HandTime | null;
  /** The version of the parser that refused it (`0`: none did). */
  parserVersion: string;
  /** ms since the epoch. */
  lastSeen: number;
}

/** `hand_time::HandTime`: a refused hand's date and time on the room's own clock. */
export interface HandTime {
  /** `YYYY-MM-DDTHH:MM`, as the room wrote it (not converted). */
  at: string;
  /** The zone the header names ("UTC", "ET"), if any. */
  zone: string | null;
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

/** `quarantine::QuarantineList`: one page of refused hands. */
export interface QuarantineList {
  entries: RefusedHand[];
  /** More match than are listed (after this page). */
  truncated: boolean;
  /** How many match the filter, on every page. */
  total: number;
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
  | { state: "failed"; message: string; retryAtMs: number }
  /** (R6.4) The account's plan does not include desktop sync; hands wait, unsent. */
  | { state: "planRequired"; feature: string }
  /** (Free tier) Today's hands are synced (`cap` a UTC day); the rest goes after `resetsAtMs`. */
  | { state: "dailyCap"; cap: number | null; resetsAtMs: number }
  /** (Free tier) The web library is full (`cap` hands); nothing more is sent until it has room. */
  | { state: "libraryFull"; cap: number | null };

/** (R6.4) `rail_sync::entitlements::Features`. */
export interface PlanFeatures {
  desktopSync: boolean;
  hud: boolean;
  reportsFull: boolean;
  analysis: boolean;
  learn: boolean;
  /** (Free tier) Every solver flop (Free: a few a day). */
  solverUnlimited: boolean;
  nodelock: boolean;
}

/** (R6.4) A Pro feature of the app. */
export type PlanFeature = keyof PlanFeatures;

/** (R6.4) `rail_sync::entitlements::Effective`: what the app may use now, and why. */
export interface EffectivePlan {
  /** `open`: enforcement off (or never heard of) - everything is available. */
  plan: "open" | "pro" | "free";
  reason: "enforcementUnknown" | "notEnforced" | "signedOut" | "notChecked" | "pro" | "free" | "graceExpired";
  enforcement: "unknown" | "off" | "on";
  features: PlanFeatures;
  /** Pro holds offline until then (ms). */
  proUntilMs: number | null;
  checkedAtMs: number | null;
}

/** (R6.4) `entitlements::EntitlementsDto`. */
export interface EntitlementsStatus {
  effective: EffectivePlan;
  check: { attemptedAtMs: number | null; succeededAtMs: number | null; failing: boolean };
  handsStored: number | null;
  handCap: number | null;
  serverReason: string | null;
  offlineGraceDays: number | null;
  /** (Free tier) The day's caps (null: unlimited or not known) and usage, from the account's last answer. */
  dailyHandCap: number | null;
  handsToday: number | null;
  dailyFlopCap: number | null;
  /** Today's solver flops (canonical keys, `Ks7d2c`), while the day lasts. */
  flopsToday: string[];
  /** When the day's counts start again (00:00 UTC, ms). */
  dayResetsAtMs: number | null;
  /** "See Pro": the web's pricing page. */
  upgradeUrl: string;
}

/** (Free tier) `entitlements::FlopGate`: may a flop's strategy show? */
export interface FlopGate {
  /** `offline`: a new flop, and the server cannot be reached to count it. */
  verdict: "open" | "refused" | "signIn" | "offline";
  flop: string;
  flops: string[];
  cap: number | null;
  resetsAtMs: number | null;
}

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
  /** Hands the server still has to delete for a "delete every hand" asked here. */
  deleting: number | null;
}

/** (R6.5) The web pages the app opens (`account::web_page_path`). */
export type WebPage = "your-data" | "delete-account" | "privacy";

/** The account's public name (`my_profile()`): chosen once; `provisional` until then. */
export interface AccountProfile {
  username: string;
  provisional: boolean;
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
/** The hands' kinds of game (`cash`, `tournament`): not the Players screen's `GameKind`. */
import type { GameKind as HandsGameKind } from "@rail/ui/hands/gameKind";

/** `hands::CursorDto`: where the next page starts. */
export interface HandCursor {
  playedAt: string;
  handKey: string;
  /** Another order than the newest first: the rows read so far. */
  offset?: number;
}

export interface HandPage {
  rows: HandRow[];
  next: HandCursor | null;
}

export interface HandAnnotations {
  note: string | null;
  tags: string[];
}

/** A hand list's "Mark" menu (`hands_marks`): the tags in use, the most used first, and the chosen hands' own. */
export interface HandMarks {
  known: string[];
  hands: { handKey: string; tags: string[] }[];
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
/** One kind of game's latest session, as Live's switch sees it. */
export interface KindSide {
  hands: number;
  current: boolean;
}

/** What Live reads: the kind shown, both kinds' sides, and the shown kind's session. */
export interface Today {
  kind: HandsGameKind;
  kinds: Record<HandsGameKind, KindSide>;
  session: Session | null;
}

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

/** `design::Cell`: a statistic in a slot of the panel's grid. */
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

/**
 * `design::HudDesign`: what a panel and its popup show. The panel is a grid
 * of `rows` x `columns` slots, row by row; `null` is an empty slot (blank
 * at the table). Fewer slots than the grid: the rest are empty.
 */
export interface HudDesign {
  version: number;
  name: string;
  preset?: string;
  format: GameFormat;
  columns: number;
  rows: number;
  cells: (DesignCell | null)[];
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
    maxRows: number;
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
  panels: {
    slot: number;
    rect: PreviewRect;
    stats: string[];
    /** Where each statistic is drawn (a click there opens its settings). */
    cells: { stat: string; rect: PreviewRect }[];
    placedByUser: boolean;
    stackBb: number;
  }[];
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
  /** `off`, `not-installed`, `starting`, `running`, `backoff`, `stopped`; (R6.4) `locked`: the plan does not include the HUD. */
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
  /** (T3, T5) Table tiling as the HUD last said; `null`: not since it connected. */
  tiling: TilingStatus | null;
}

/** `rail_hud_ipc::protocol::ScreenRect`: physical pixels, the primary monitor's top-left the origin. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `rail_hud_ipc::protocol::MonitorInfo` (T5): a monitor as tiling sees it. */
export interface MonitorInfo {
  /** Its place in the order layouts name monitors: 0 the primary, then left to right. */
  index: number;
  primary: boolean;
  bounds: ScreenRect;
  /** Without the taskbar, menu bar or Dock. */
  workArea: ScreenRect;
  scalePermille: number;
}

/** `rail_hud_ipc::protocol::TiledTable` (T5): a table tiling manages, at its outer rect (frame included). */
export interface TiledTable {
  site: string;
  table?: string | null;
  rect: ScreenRect;
  /** `MonitorInfo.index`. */
  monitor: number;
  /** Shares its slot with another table. */
  stacked?: boolean;
  /** Moved by hand: left where it is until "Re-tile". */
  pinned?: boolean;
}

/** `hud::TilingStatusDto` (T3, T5): what the HUD last said about tiling. */
export interface TilingStatus {
  enabled: boolean;
  tables: number;
  /** `auto` or a user layout's id; `null` while off or before a table. */
  layout: string | null;
  monitors: MonitorInfo[];
  windows: TiledTable[];
}

/** `rail_hud_ipc::settings::SlotRect`: thousandths of a monitor's work area. */
export interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `rail_hud_ipc::settings::Slot`. */
export interface TilingSlot {
  id: string;
  monitor: number;
  rect: SlotRect;
  /** (T7) `action`: an Action Required slot; `other`: a newer build's kind (never given a table). */
  kind: "play" | "lobby" | "action" | "other";
  rooms: string[] | null;
  stack: boolean;
}

/** `rail_hud_ipc::settings::AutoSwitch`. */
export interface AutoSwitch {
  minTables: number;
  layoutId: string;
}

/** `rail_hud_ipc::settings::Layout`: a user layout. */
export interface TilingLayout {
  id: string;
  name: string;
  slots: TilingSlot[];
  autoSwitch: AutoSwitch[];
}

/** `rail_hud_ipc::settings::LayoutRef`. */
export type LayoutRef = { kind: "auto" } | { kind: "custom"; id: string };

/** `rail_hud_ipc::settings::TilingSettings` (T3). */
export interface TilingSettings {
  enabled: boolean;
  active: LayoutRef;
  layouts: TilingLayout[];
  autoSwitch: AutoSwitch[];
  closeGaps: boolean;
  /** A room not listed is on. */
  perRoom: Record<string, boolean>;
  /** (T7) The global hotkeys; none by default. Absent from an older build's row. */
  hotkeys?: HotkeyBinding[];
}

/**
 * `rail_hud_ipc::hotkeys::HotkeyAction` (T7): what a global hotkey does.
 * A newer build's action reads as `unknown` on the Rust side.
 */
export type HotkeyAction = "retile" | "nextLayout" | "previousLayout" | "toggleTiling" | "rollRng" | "unknown";

/** `rail_hud_ipc::hotkeys::HotkeyBinding`: `keys` as `Ctrl+Alt+Shift+Super+KeyR` (modifiers in that order, then a `KeyboardEvent.code`). */
export interface HotkeyBinding {
  action: HotkeyAction;
  keys: string;
}

/** `hotkeys::HotkeyStatusDto` (T7): a binding and how it stands with the system. */
export interface HotkeyStatus {
  action: HotkeyAction;
  keys: string;
  /** `taken`: another program holds the keys; `failed`: the system refused them; `paused`: while a key is recorded. */
  state: "active" | "taken" | "failed" | "paused";
}

/**
 * `rail_hud_ipc::settings::RngSettings`: the RNG box's switch (2026-11-16)
 * and its look and place (2026-11-17). Sizes are points; colours `#rrggbb`,
 * absent: the theme's; no position: the primary monitor's top-right corner.
 */
export interface RngSettings {
  enabled: boolean;
  /** The box, `RNG_BOX_MIN` - `RNG_BOX_MAX`. */
  width: number;
  height: number;
  /** The number, `RNG_NUMBER_MIN` - `RNG_NUMBER_MAX`. */
  numberSize: number;
  background?: string | null;
  color?: string | null;
  /** The box's top-left corner on the screen, points. */
  position?: { x: number; y: number } | null;
  /** Locked: not dragged or resized (a click still rolls). */
  locked: boolean;
}

/** The bounds `rail_hud_ipc::settings` checks (`RNG_BOX_*`, `RNG_NUMBER_*`). */
export const RNG_BOX = { min: 32, max: 480, initial: 56 } as const;
export const RNG_NUMBER = { min: 10, max: 320, initial: 20 } as const;

/** `rng_box::RngFrame`: the box's place and size now, points. */
export interface RngFrame {
  x: number;
  y: number;
  width: number;
  height: number;
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
  /** (T5) The client is closed. */
  closed: boolean;
  /** (T0, T5) Table tiling's policy, separate from the HUD's. */
  tiling: ToolPolicy;
  /** (T7) The Action Required slot's: `permitted` only with tiling allowed and a turn signal for this system. */
  actionSlot: ToolPolicy;
}

/** `policy::ToolPolicyDto` (T5): a room's word on tiling or the RNG, decided on the Rust side. */
export interface ToolPolicy {
  allowed: boolean | null;
  /** A room, allowed: what the HUD acts on. */
  permitted: boolean;
  /** Prohibited until the room approves Rail (Winamax). */
  needsApproval: boolean;
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

/** `analysis::GateDto` (R5.4): whether the analysis may run now, and why not. */
export interface AnalysisGate {
  run: boolean;
  /** (R6.4) `plan`: enforcement on and the plan without the analysis. */
  reason: "paused" | "tables" | "backfill" | "statistics" | "store" | "plan" | null;
  paused: boolean;
}

/** `analysis::PendingDto`: a hand for the analysis runner. */
export interface PendingHandDto {
  handKey: string;
  /** '' for a hand without a date. */
  playedAt: string;
  /** The PHF as JSON text. */
  phf: string;
}

/** `analysis::CountsDto`: how far the analysis is at a version. */
export interface AnalysisCounts {
  hands: number;
  current: number;
  stale: number;
  missing: number;
  offline: number;
  notAnalysable: number;
}

/** `analysis::VillainRowDto`: an opponent's counters (the web's `villain_counters`). */
export interface VillainRowDto {
  site: string;
  player: string;
  hands: number;
  vpipOpp: number;
  vpip: number;
  pfr: number;
}

/** A chart set as the store keeps it (`analysis::ChartSetDto`, the web's row). */
export interface StoredChartSetDto {
  id: string | null;
  name: string;
  game_format: "cash" | "tournament";
  table_size: number;
  stack_min_bb: number;
  stack_max_bb: number;
  format_version: number;
  nodes: Record<string, { raise?: string; call?: string; allin?: string; raiseBb?: number }>;
  updated_at: string | null;
}

/** `rail_store::NodeLockStreet` (docs/NODELOCK.md §3). */
export type NodeLockStreet = "flop" | "turn" | "river";

/** `rail_store::NodeLockStatus`: a row still `solving` when the app starts becomes `cancelled`. */
export type NodeLockStatus = "draft" | "solving" | "solved" | "failed" | "cancelled";

import type { LockSet } from "../solver/nodelock/contract";

/** The lock a row holds (`lock_json`): §1's `LockSet` (`web/src/lib/solver/nodelock.ts`). */
export type NodeLockSet = LockSet;

/**
 * `nodelock_store::NodeLockDto`: one `node_locks` row, column for column (snake_case, as the table),
 * with `lock_json` and `summary_json` parsed. Kept on this computer only; never synced.
 */
export interface NodeLockRow {
  /** uuid v4. */
  id: string;
  name: string;
  /** Unix ms. */
  created_at: number;
  updated_at: number;
  set_id: string;
  line: string;
  flop: string;
  turn: string | null;
  river: string | null;
  street: NodeLockStreet;
  /** The first locked node, for the list. */
  node_path: string;
  lock_json: NodeLockSet;
  lock_hash: string;
  /** The suggestion it started from, if any. */
  preset: string | null;
  status: NodeLockStatus;
  engine: string | null;
  threads: number | null;
  iterations: number | null;
  exploitability_pct: number | null;
  seconds: number | null;
  peak_mb: number | null;
  /** The list's headline numbers (JSON), or null. */
  summary_json: unknown;
  /** The locked solve's chunk size in bytes; null: no chunk. Not a column: `length(result)`. */
  result_size: number | null;
  /** (§7.5) A root lock's folder; null: the top level (always null for a child). */
  folder_id: string | null;
  /** (§7.4) The lock this one is built on; null: solved on the library. Never changes. */
  parent_id: string | null;
  /** Its place among its siblings, ascending (a folder's subfolders and root locks share one list). */
  sort: number;
}

/** A row with its chunk (`nodelock_get`). */
export interface NodeLock extends NodeLockRow {
  result: Uint8Array | null;
}

/**
 * What `nodelockSave` takes: the whole row (an upsert replaces it, the chunk included). No `id`
 * (or an empty one) makes a new row; the times are the store's. The place in the tree is the first
 * save's: `parent_id` (must exist) or, for a root, `folder_id` (unknown: the top level); the new row
 * goes to the top of its list. Later saves keep the place (moves go through `nodelockMove`).
 */
export type NodeLockInput = Omit<
  NodeLockRow,
  "id" | "created_at" | "updated_at" | "result_size" | "folder_id" | "parent_id" | "sort"
> & {
  id?: string | null;
  parent_id?: string | null;
  folder_id?: string | null;
};

/** (§7.5) `rail_store::NodeLockFolder`: a folder of My nodelocks, nested to any depth. */
export interface NodeLockFolder {
  id: string;
  name: string;
  /** The folder it sits in; null: the top level. */
  parent_id: string | null;
  /** Its place among its folder's subfolders and root locks, ascending. */
  sort: number;
  created_at: number;
  updated_at: number;
}

/** What `nodelockFolderSave` takes: no `id` makes a folder; no `sort`: the top of its list (or where it was). */
export interface NodeLockFolderInput {
  id?: string;
  name: string;
  parent_id: string | null;
  sort?: number;
}

/** A tree item: a lock or a folder (`rail_store::NodeLockItem`). */
export interface NodeLockItem {
  kind: "lock" | "folder";
  id: string;
}

/**
 * Where `nodelockMove` puts its items: into `folder_id` (null: the top level), just before `before`,
 * else just after `after`, else at the top. The anchor must be an item of that folder.
 */
export interface NodeLockPlace {
  folder_id: string | null;
  before?: NodeLockItem | null;
  after?: NodeLockItem | null;
}

/** What a folder delete took: folders (subfolders included) and every lock row (branches included). */
export interface NodeLockDeleted {
  folders: number;
  locks: number;
}

/**
 * What a delete would take: `folders` (subfolders included), `locks` (each deleted lock whose parent
 * stays) and `descendants` (the deleted locks built on another deleted one). `locks + descendants`
 * is every lock row that goes.
 */
export interface NodeLockDeletePreview {
  folders: number;
  locks: number;
  descendants: number;
}

/** A Solver-library spot, as the history filters by it. */
export interface NodeLockSpot {
  set_id: string;
  line: string;
  flop: string;
}

/** `nodelock_store::SavedDto`. */
export interface NodeLockSaved {
  id: string;
  created_at: number;
  updated_at: number;
}

/**
 * A nodelock row and its chunk as one frame (`nodelock_store::frame`): the row's JSON length (u32,
 * little-endian), the JSON (UTF-8), the chunk's bytes. The chunk never crosses as a JSON array.
 */
export function nodeLockFrame(row: object, result: Uint8Array | null): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(row));
  const out = new Uint8Array(4 + json.length + (result?.length ?? 0));
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  if (result) out.set(result, 4 + json.length);
  return out;
}

/** `nodelock_get`'s frame back into the row and its chunk; no bytes: no such row. */
export function nodeLockUnframe(buffer: ArrayBuffer): NodeLock | null {
  if (buffer.byteLength === 0) return null;
  const length = new DataView(buffer).getUint32(0, true);
  const row = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as NodeLockRow;
  const result = row.result_size === null ? null : new Uint8Array(buffer.slice(4 + length));
  return { ...row, result };
}

/** `analysis::ChartSummaryDto`. */
export interface ChartSetSummaryDto {
  id: string;
  name: string;
  gameFormat: "cash" | "tournament";
  tableSize: number;
  stackMinBb: number;
  stackMaxBb: number;
  nodes: number;
  /** ms since the epoch. */
  updatedAt: number;
}

/** `review::PreflopDto`: a session's preflop decision on the shipped tree (R5.4). */
export interface SessionPreflopDto {
  handId: string;
  ord: number;
  actionIndex: number;
  playedAt: string;
  key: string;
  cls: number;
  action: "fold" | "check" | "call" | "raise" | "allin";
  scenario: string;
  position: string | null;
  gameFormat: string;
  tableSize: number;
  depthBandBb: number | null;
  evLossBb: number | null;
}

/** `review::CompareDto`. */
export interface CompareDto {
  period: string;
  gameFormat: string;
  tableSize: number;
  stackMinBb: number;
  stackMaxBb: number;
}

/** `review::CellDto`. */
export interface CompareCellDto {
  key: string;
  cls: number;
  action: "fold" | "check" | "call" | "raise" | "allin";
  decisions: number;
  evLossBb: number;
}

/** `review::ExampleDto`. */
export interface ChartExampleDto {
  handId: string;
  actionIndex: number;
  playedAt: string;
  heroCards: string[];
  site: string;
  currency: string;
  currencySymbol: string;
  minorUnits: number;
  smallBlind: number;
  bigBlind: number;
  evLossBb: number | null;
}

/** `review::LeakFiltersDto` (R5.4): the top three's scope. */
export interface LeakFiltersDto {
  gameFormat?: string | null;
  /** One kind of game: cash, or every tournament format. */
  gameKind?: HandsGameKind | null;
  position?: string | null;
  potType?: string | null;
}

/** `review::SpotSumsDto`: one finest spot's sums, as summed. */
export interface SpotSumsDto {
  key: string;
  /** Preflop: a chart grade's set; flop, turn, river: the hand's table (rail-store migration 20). */
  set: string | null;
  /** A postflop spot in a 3-bet (`3bp`) or 4-bet+ (`4bp`) pot; absent otherwise. */
  pot?: string | null;
  decisions: number;
  nonPerfect: number;
  mistakes: number;
  evLossBb: number;
  evLossPot: number;
  scoreSum: number;
  scoreSq: number;
}

/** `review::TopLeaksDto`. */
export interface TopLeaksDto {
  last: string | null;
  current: { from: string; to: string } | null;
  prior: { from: string; to: string } | null;
  sample: { hands: number; graded: number; rows: SpotSumsDto[] };
  now: { hands: number; graded: number; rows: SpotSumsDto[] };
  was: { hands: number; graded: number; rows: SpotSumsDto[] };
}

/** `review::LeakExampleDto`. */
export interface LeakExampleDto {
  handId: string;
  ord: number;
  actionIndex: number;
  playedAt: string | null;
  site: string;
  currency: string;
  currencySymbol: string;
  minorUnits: number;
  smallBlind: number;
  bigBlind: number;
  heroCards: string[];
  handClass: string | null;
  spotKey: string;
  grade: string;
  evLossBb: number;
  evLossPot: number;
}

/** `manual_import::Phase`: where the Import screen's import stands. */
export type ManualImportPhase = "idle" | "finding" | "importing" | "done" | "cancelled" | "failed";

/** `manual_import::ImportStatus`: the current (or last) import by hand. */
export interface ManualImportStatus {
  phase: ManualImportPhase;
  files: number;
  filesDone: number;
  bytes: number;
  bytesDone: number;
  /** Hands new to the store. */
  inserted: number;
  /** Hands the store already had. */
  duplicates: number;
  /** Hands refused (quarantine). */
  refused: number;
  /** Files no parser reads. */
  unrecognized: number;
  /** Files read to their end before. */
  unchanged: number;
  /** The first paths that could not be read, with why. */
  errors: string[];
  errorCount: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Call `onChange` whenever the Import screen's import changed (at most every 200 ms while it runs). */
export function onManualImportChanged(onChange: () => void): () => void {
  return onAppEvent("manual-import-changed", onChange);
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
  /** The Import screen: the system file picker, several files; `null` when cancelled. */
  pickImportFiles: () => invoke<string[] | null>("pick_import_files"),
  /** Read files and folders (with their subfolders) into the store once. */
  manualImportStart: (paths: string[]) => invoke<null>("manual_import_start", { paths }),
  manualImportStatus: () => invoke<ManualImportStatus>("manual_import_status"),
  manualImportCancel: () => invoke<null>("manual_import_cancel"),
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
  quarantineEntries: (sourceId: number | null, reason: string | null, page?: { offset: number; limit: number }) =>
    invoke<QuarantineList>("quarantine_entries", { sourceId, reason, offset: page?.offset ?? null, limit: page?.limit ?? null }),
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
  /** (R6.5) The web's data export, account deletion or privacy policy, in the default browser. */
  accountOpenWebPage: (page: WebPage) => invoke<null>("account_open_web_page", { page }),
  /**
   * The signed-in account's public name; `null` when the server has none.
   * Errors: `signedOut`, `unavailable`, `unreachable`.
   */
  accountProfile: () => invoke<AccountProfile | null>("account_profile"),
  /**
   * Choose the public name, once. Errors: the codes above, or the server's
   * sentence (taken, not available, already chosen, ...).
   */
  accountSetUsername: (username: string) => invoke<string>("account_set_username", { username }),
  /** Sync with the web (R1.9). `null`: sync is off in this build. */
  syncStatus: () => invoke<SyncStatus | null>("sync_status"),
  syncNow: () => invoke<SyncStatus>("sync_now"),
  syncSetPaused: (paused: boolean) => invoke<SyncStatus>("sync_set_paused", { paused }),
  /** Upload this computer's hands to the account signed in now, or keep them apart. */
  syncAnswerAccount: (upload: boolean) => invoke<SyncStatus>("sync_answer_account", { upload }),
  syncRetryRejected: () => invoke<SyncStatus>("sync_retry_rejected"),
  /** Settings, Updates: where it stands; check; download (progress as events); install and restart. */
  updateStatus: () => invoke<UpdateStatus>("update_status"),
  updateCheck: () => invoke<UpdateStatus>("update_check"),
  updateDownload: () => invoke<UpdateStatus>("update_download"),
  /** Answers only with an error: on success the app restarts (macOS) or exits for the installer (Windows). */
  updateInstall: () => invoke<null>("update_install"),
  setCheckForUpdates: (enabled: boolean) => invoke<UpdateStatus>("set_check_for_updates", { enabled }),
  /** The web's /download page in the default browser. */
  updateOpenDownloadPage: () => invoke<null>("update_open_download_page"),
  /** (R6.4) The plan: what the app may use, the last check; check again; the web's upgrade page. */
  entitlementsStatus: () => invoke<EntitlementsStatus>("entitlements_status"),
  entitlementsCheckNow: () => invoke<void>("entitlements_check_now"),
  entitlementsOpenUpgrade: () => invoke<void>("entitlements_open_upgrade"),
  entitlementsOpenManage: () => invoke<void>("entitlements_open_manage"),
  /** (Free tier) Before a flop's strategy shows: the server counts it (preflop never asks). */
  solverOpenFlop: (flop: string) => invoke<FlopGate>("solver_open_flop", { flop }),
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
  /**
   * Save hands as one hand-history .txt (`export.rs`) where the reader picks
   * in the system's dialog; `null` when it was cancelled.
   */
  handsExport: (handKeys: string[], fileName: string) =>
    invoke<HandsExported | null>("hands_export", { handKeys, fileName }),
  /** "Go to hand": by the room's id (a prefix of it) or the hand key. */
  handsFind: (query: string, limit: number) => invoke<HandRow[]>("hands_find", { query, limit }),
  /** A hand's PHF as JSON text; `null` when the store has no such hand. */
  handPhf: (handKey: string) => invoke<string | null>("hand_phf", { handKey }),
  /** A web share link for the hand (`share.rs`); errors as `ShareErrorCode`s or a sentence. */
  handShare: (handKey: string, title: string | null) => invoke<HandShare>("hand_share", { handKey, title }),
  /** (Trainer) Keep graded answers in the account (`record_trainer_results`, at most 50); how many were kept. */
  trainerResultsRecord: (rows: TrainerResultDto[]) => invoke<number>("trainer_results_record", { rows }),
  /** Send a bug report, feature request or question (`feedback.rs`); errors are the function's codes or `offline`. */
  feedbackSend: (input: FeedbackInput) => invoke<null>("feedback_send", { input }),
  /** Open a share link made here in the default browser. */
  shareOpen: (slug: string) => invoke<null>("share_open", { slug }),
  /** The owner's names switch on a link made here; the state the server kept. */
  shareSetNames: (slug: string, show: boolean) => invoke<boolean>("share_set_names", { slug, show }),
  /** The web's post preview for a hand in the store, in the default browser (`share.rs`). */
  forumPreviewOpen: (handKey: string) => invoke<null>("forum_preview_open", { handKey }),
  handAnnotations: (handKey: string) => invoke<HandAnnotations>("hand_annotations", { handKey }),
  handSetNote: (handKey: string, note: string) => invoke<HandAnnotations>("hand_set_note", { handKey, note }),
  handAddTag: (handKey: string, tag: string) => invoke<HandAnnotations>("hand_add_tag", { handKey, tag }),
  handRemoveTag: (handKey: string, tag: string) => invoke<HandAnnotations>("hand_remove_tag", { handKey, tag }),
  handsMarks: (handKeys: string[]) => invoke<HandMarks>("hands_marks", { handKeys }),
  /**
   * Delete hands here and (by sync) from the account (`delete.rs`); how many
   * went. A big selection reports its progress ({@link onHandsDeleteProgress}).
   */
  handsDelete: (handKeys: string[]) => invoke<number>("hands_delete", { handKeys }),
  /** Delete every hand here and (by sync) from the account; how many went here. */
  handsDeleteAll: () => invoke<number>("hands_delete_all"),
  /** How many hands the store holds. */
  handsCount: () => invoke<number>("hands_count"),
  /** Put a tag on every hand of `handKeys` (`on`) or take it off; each hand's note and tags after. */
  handsMark: (handKeys: string[], tag: string, on: boolean) =>
    invoke<HandAnnotated[]>("hands_mark", { handKeys, tag, on }),
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
  /** Live: one kind of game's latest session (`kind` null: the one being played, else the one with more hands). */
  today: (kind: HandsGameKind | null) => invoke<Today>("today", { kind }),
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
  /** (T3, T5) Table tiling and the RNG: the user's settings, "Re-tile", and the slots of the tables' places now. */
  getTilingSettings: () => invoke<TilingSettings>("get_tiling_settings"),
  setTilingSettings: (settings: TilingSettings) => invoke<null>("set_tiling_settings", { settings }),
  getRngSettings: () => invoke<RngSettings>("get_rng_settings"),
  setRngSettings: (settings: RngSettings) => invoke<null>("set_rng_settings", { settings }),
  /** The RNG box (`rng_box.rs`): the number it shows, and a new one (a click). */
  rngBoxNumber: () => invoke<number>("rng_box_number"),
  rngBoxRoll: () => invoke<number>("rng_box_roll"),
  /** (2026-11-17) Dragging and resizing the box: where it is, moving it (not saved), saving where it ended. */
  rngBoxFrame: () => invoke<RngFrame>("rng_box_frame"),
  rngBoxPlace: (frame: RngFrame) => invoke<null>("rng_box_place", { ...frame }),
  rngBoxSaveFrame: () => invoke<RngSettings>("rng_box_save_frame"),
  /** Settings' "Reposition": the box in the middle of the primary monitor, unlocked. */
  rngBoxReposition: () => invoke<RngSettings>("rng_box_reposition"),
  /** Settings' RNG section on screen: the box shows to be styled and placed. */
  rngBoxPreview: (on: boolean) => invoke<null>("rng_box_preview", { on }),
  /** A right-click on the box: its panel (lock, reposition, look) opens beside it, or closes. */
  rngPanelToggle: () => invoke<null>("rng_panel_toggle"),
  rngPanelClose: () => invoke<null>("rng_panel_close"),
  retileTables: () => invoke<boolean>("retile_tables"),
  captureTilingLayout: () => invoke<TilingSlot[]>("capture_tiling_layout"),
  /** (T7) The global hotkeys: how each binding stands, and letting every key go while one is recorded. */
  hotkeyStatus: () => invoke<HotkeyStatus[]>("hotkey_status"),
  hotkeysPause: (paused: boolean) => invoke<null>("hotkeys_pause", { paused }),
  /** The HUD popup (R3.8): what it shows (`null`: none open), close it, open the player in Rail. */
  hudPopup: () => invoke<HudPopup | null>("hud_popup"),
  hudPopupClose: () => invoke<null>("hud_popup_close"),
  /**
   * The replayer's own window (`replayer.rs`): show a hand there, building
   * the window the first time; `focus` brings it forward with the keyboard.
   */
  replayerOpen: (handKey: string, focus: boolean) => invoke<null>("replayer_open", { handKey, focus }),
  /** Replay several hands: the first, with the list in the window's sidebar. */
  replayerOpenList: (handKeys: string[], focus: boolean) =>
    invoke<null>("replayer_open_list", { handKeys, focus }),
  /** The hand the replayer window should show and its list, if one was chosen. */
  replayerHand: () => invoke<ReplayerShow | null>("replayer_hand"),
  /** Close the replayer window (its close button). */
  replayerClose: () => invoke<null>("replayer_close"),
  /** From the replayer window: the main window comes forward on this screen (`#/...`). */
  replayerOpenInMain: (href: string) => invoke<null>("replayer_open_in_main", { href }),
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
  /** A panel dragged in the preview: its centre, thousandths of the table's client area. */
  hudSetSeatPosition: (site: string, size: number, slot: number, x: number, y: number) =>
    invoke<null>("hud_set_seat_position", { site, size, slot, x, y }),
  /** R3.6's: dragged panels back to the layout's places (`size` null: every size). */
  hudResetSeatPositions: (site: string, size: number | null) =>
    invoke<number>("hud_reset_seat_positions", { site, size }),
  /** R3.6's: the user's client rotates the table (`null`: as `sites.json` says). */
  hudSetPreferredSeat: (site: string, preferred: boolean | null) =>
    invoke<null>("hud_set_preferred_seat", { site, preferred }),
  /** The hand analysis (R5.4). The runner asks the gate before every page. */
  analysisGate: () => invoke<AnalysisGate>("analysis_gate"),
  analysisSetPaused: (paused: boolean) => invoke<boolean>("analysis_set_paused", { paused }),
  analysisPending: (version: string, after: { playedAt: string; handKey: string } | null, limit: number) =>
    invoke<PendingHandDto[]>("analysis_pending", { version, after, limit }),
  analysisOffline: (version: string, limit: number) => invoke<PendingHandDto[]>("analysis_offline", { version, limit }),
  /** Rows in `rail_store::HandAnalysisIn`'s shape (`analysis/rows.ts`). */
  analysisSave: (rows: unknown[]) => invoke<{ saved: number; missing: number }>("analysis_save", { rows }),
  analysisCounts: (version: string) => invoke<AnalysisCounts>("analysis_counts", { version }),
  /** The counts month by month (`played_at`'s UTC `YYYY-MM`), newest first. */
  analysisMonths: (version: string) =>
    invoke<{ month: string; hands: number; current: number }[]>("analysis_months", { version }),
  /** A hand's stored analysis in the web's `analysis_hand` shape; `null` when none. */
  handAnalysis: (handKey: string) => invoke<Record<string, unknown> | null>("hand_analysis", { handKey }),
  analysisVillains: (players: { site: string; player: string }[], minHands: number) =>
    invoke<VillainRowDto[]>("analysis_villains", { players, minHands }),
  analysisClear: () => invoke<number>("analysis_clear"),
  /** One flop library file's bytes; rejects with `absent`, `transient:<status>` or `offline`. */
  flopLibraryFile: (path: string) => invoke<ArrayBuffer>("flop_library_file", { path }),
  flopLibraryReachable: () => invoke<boolean>("flop_library_reachable"),
  flopLibraryUsage: () => invoke<{ bytes: number; files: number }>("flop_library_usage"),
  /** The user's own preflop charts (R5.3), kept in the store only. */
  chartSetsList: () => invoke<ChartSetSummaryDto[]>("chart_sets_list"),
  chartSetLoad: (id: string) => invoke<StoredChartSetDto | null>("chart_set_load", { id }),
  chartSetSave: (set: StoredChartSetDto) => invoke<{ id: string; updatedAt: string }>("chart_set_save", { set }),
  chartSetDelete: (id: string) => invoke<boolean>("chart_set_delete", { id }),
  /** (docs/NODELOCK.md §3) The user's nodelocks: newest change first, without chunks; `spot` keeps one spot's. */
  nodelockList: (spot: NodeLockSpot | null = null) => invoke<NodeLockRow[]>("nodelock_list", { spot }),
  /** One nodelock with its chunk; null when there is none of that id. */
  nodelockGet: async (id: string): Promise<NodeLock | null> =>
    nodeLockUnframe(await invoke<ArrayBuffer>("nodelock_get", { id })),
  /** Insert or replace a nodelock, the chunk (`result`) included: a save without one clears it. */
  nodelockSave: (row: NodeLockInput, result: Uint8Array | null = null) =>
    invoke<NodeLockSaved>(
      "nodelock_save",
      nodeLockFrame({ ...row, id: row.id ?? "", result_size: result ? result.length : null }, result),
    ),
  /** Whether it was there. */
  nodelockRename: (id: string, name: string) => invoke<boolean>("nodelock_rename", { id, name }),
  /** Deletes each with every lock built on it (its branch); how many rows went (unknown ids are skipped). */
  nodelockDelete: (ids: string[]) => invoke<number>("nodelock_delete", { ids }),
  /** (§7.5) Every folder of My nodelocks. */
  nodelockFolders: () => invoke<NodeLockFolder[]>("nodelock_folders"),
  /** Creates (no id) or updates a folder; rejects a parent that is unknown, the folder itself or inside it. */
  nodelockFolderSave: (f: NodeLockFolderInput) => invoke<NodeLockFolder>("nodelock_folder_save", { folder: f }),
  /** Deletes folders with their subfolders and every lock (and branch) in them. */
  nodelockFolderDelete: (ids: string[]) => invoke<NodeLockDeleted>("nodelock_folder_delete", { ids }),
  /**
   * Moves root locks and folders (in this order, together; a lock's children go with it). False,
   * nothing moved: a child lock, a folder into its own subtree, an unknown item or anchor.
   */
  nodelockMove: (items: NodeLockItem[], to: NodeLockPlace) => invoke<boolean>("nodelock_move", { items, to }),
  /** What deleting these locks (with branches) and folders (with contents) would take; changes nothing. */
  nodelockDeletePreview: (locks: string[], folders: string[]) =>
    invoke<NodeLockDeletePreview>("nodelock_delete_preview", { locks, folders }),
  /** (R5.5) The user's settings per tournament (`site:id` keys), kept in the store only; a save or delete re-queues its hands. */
  tournamentSettingsList: () =>
    invoke<{ key: string; settings: Record<string, unknown>; updatedAt: string }[]>("tournament_settings_list"),
  tournamentSettingsSave: (key: string, settings: Record<string, unknown>) =>
    invoke<number>("tournament_settings_save", { key, settings }),
  tournamentSettingsDelete: (key: string) => invoke<boolean>("tournament_settings_delete", { key }),
  /** (R5.4) The session review over the store: `SessionReview`'s shape, each hand with its `smallBlind`. */
  sessionReview: (version: string, at: string | null, gapMinutes: number, limit: number, kind: HandsGameKind | null) =>
    invoke<Record<string, unknown>>("session_review", { version, at, gapMinutes, limit, kind }),
  reviewSessions: (gapMinutes: number, since: string | null, limit: number, kind: HandsGameKind | null) =>
    invoke<{ startedAt: string; endedAt: string; hands: number; tables: number; netBbMilli: number | null }[]>(
      "review_sessions",
      { gapMinutes, since, limit, kind },
    ),
  sessionPreflop: (version: string, startedAt: string, endedAt: string) =>
    invoke<SessionPreflopDto[]>("session_preflop", { version, startedAt, endedAt }),
  reviewHands: (version: string, keys: string[]) => invoke<Record<string, Record<string, unknown>>>("review_hands", { version, keys }),
  /** (R5.4) The own charts against the hands played. */
  chartPlayed: (version: string, query: CompareDto) =>
    invoke<{ from: string | null; to: string | null; cells: CompareCellDto[] }>("chart_played", { version, query }),
  chartExamples: (version: string, query: CompareDto, key: string, cls: number, action: string, limit: number) =>
    invoke<ChartExampleDto[]>("chart_examples", { version, query, key, cls, action, limit }),
  /** (R5.4) The leak finder's top three: three samples of spot sums, and a leak's costliest decisions. */
  topLeaks: (version: string, filters: LeakFiltersDto, period: string) =>
    invoke<TopLeaksDto>("top_leaks", { version, filters, period }),
  /** A leak's examples on its table (`hu`, `9max`, `other`) and pot (`3bp`, `4bp`, `other`); null: every one. */
  leakExamples: (
    version: string,
    filters: LeakFiltersDto,
    days: { from: string; to: string } | null,
    keys: string[],
    limit: number,
    table: string | null = null,
    pot: string | null = null,
  ) => invoke<LeakExampleDto[]>("leak_examples", { version, filters, days, keys, table, pot, limit }),
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

/** A big delete's progress (`hands_delete`): hands done of the total. */
export function onHandsDeleteProgress(onChange: (progress: { done: number; total: number }) => void): () => void {
  return onAppEvent("hands-delete-progress", onChange);
}

/** Call `onChange` whenever the sync status changed (R1.9; at most once a second). */
export function onSyncChanged(onChange: () => void): () => void {
  return onAppEvent("sync-changed", onChange);
}

/** Call `onChange` whenever the account's status changed (R1.7). */
export function onAccountChanged(onChange: () => void): () => void {
  return onAppEvent("account-changed", onChange);
}

/** (R6.4) Call `onChange` whenever what the plan allows changed. */
export function onEntitlementsChanged(onChange: () => void): () => void {
  return onAppEvent("entitlements-changed", onChange);
}

/** The sidebar's update card: the update's status, on every change (download progress at most a few times a second). */
export function onUpdatesChanged(onChange: (status: UpdateStatus) => void): () => void {
  return onAppEvent<UpdateStatus>("updates-changed", onChange);
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

/** (T3) A sync brought another computer's tiling or RNG settings. */
export function onTilingSettingsChanged(onChange: () => void): () => void {
  return onAppEvent("tiling-settings-changed", onChange);
}

/** The RNG box's number changed outside it (the "Roll the RNG" hotkey). */
export function onRngBoxRolled(onRoll: (n: number) => void): () => void {
  return onAppEvent<number>("rng-box-rolled", onRoll);
}

/** The RNG settings were saved; `from` is the window that saved them ("main", "rng-panel", "rng-box"). */
export function onRngSettingsSaved(onSaved: (from: string) => void): () => void {
  return onAppEvent<{ from: string }>("rng-settings-changed", (payload) => onSaved(payload.from));
}

/** The RNG box's look or place changed (Settings saved, a sync pull). */
export function onRngBoxStyle(onStyle: (settings: RngSettings) => void): () => void {
  return onAppEvent<RngSettings>("rng-box-style", onStyle);
}

/** (T7) A hotkey was bound, found taken, or paused: ask `hotkeyStatus` again. */
export function onHotkeysChanged(onChange: () => void): () => void {
  return onAppEvent("hotkeys-changed", onChange);
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

/**
 * What the replayer window shows: a hand, and the hands it steps through
 * (empty, or two or more with the hand among them).
 */
export interface ReplayerShow {
  hand: string;
  list: string[];
}

/** An export written (`handsExport`). */
export interface HandsExported {
  path: string;
  hands: number;
  /** Asked for but no longer in the store: left out. */
  missing: number;
}

/** The replayer window: show this hand (from `replayerOpen` / `replayerOpenList`). */
export function onReplayerHand(onHand: (show: ReplayerShow) => void): () => void {
  return onAppEvent<ReplayerShow>("replayer-hand", onHand);
}

/** The main window: the replayer window now shows this hand. */
export function onReplayerShowing(onHand: (handKey: string) => void): () => void {
  return onAppEvent<string>("replayer-showing", onHand);
}

/** The main window: go to this screen (a link in the replayer window). */
export function onOpenRoute(onRoute: (href: string) => void): () => void {
  return onAppEvent<string>("open-route", onRoute);
}

/** The main window: the replayer window closed. */
export function onReplayerClosed(onClosed: () => void): () => void {
  return onAppEvent("replayer-closed", onClosed);
}

/** A hand's tags or note changed in the replayer window (the list shows it). */
export interface HandAnnotated {
  handKey: string;
  annotations: HandAnnotations;
}

export function emitHandAnnotated(change: HandAnnotated): void {
  if (inApp) emit("hand-annotated", change).catch(() => undefined);
}

export function onHandAnnotated(onChange: (change: HandAnnotated) => void): () => void {
  return onAppEvent<HandAnnotated>("hand-annotated", onChange);
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
/** One graded trainer answer as the account keeps it (`rail_sync::ingest::TrainerResultRow`). */
export interface TrainerResultDto {
  mode: "preflop" | "flop" | "river" | "drill";
  family: string;
  spot: string;
  position: string | null;
  hand_class: string | null;
  grade: string;
  ev_loss_bb: number;
  ev_loss_pot: number;
  score: number;
}

/** The errors `trainer_results_record` answers with a code: the answers wait and go later. */
export const TRAINER_SYNC_WAIT = ["signedOut", "rateLimited", "plan", "unavailable", "unreachable"] as const;

/** A feedback report as `feedback_send` takes it (`src-tauri/src/feedback.rs`). */
export interface FeedbackInput {
  kind: "bug" | "feature" | "question";
  message: string;
  email: string | null;
  website: string;
  /** Data URLs. */
  images: string[];
  /** The screen it was sent from. */
  page: string;
  locale: string;
}

/** A share link made by `hand_share`. */
export interface HandShare {
  slug: string;
  url: string;
}

/** The errors `hand_share` answers with a code rather than a sentence. */
export type ShareErrorCode = "signedOut" | "rateLimited" | "unavailable" | "missing";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
