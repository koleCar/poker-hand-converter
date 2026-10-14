/**
 * The Rust commands, typed. Each type mirrors a `#[derive(Serialize)]` struct
 * in `src-tauri/src/commands.rs` or `dev.rs` (camelCase on both sides).
 */
import type { Shown, StatDefinition } from "@rail/ui/model/stats";
import type { WinrateGraphBucket, WinrateGraphData } from "@rail/ui/stats/WinrateGraph";
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
  activity: "idle" | "rebuilding" | "indexing" | "computing" | "paused-backfill" | "paused-tables" | "stopped";
  /** A rebuild in progress: hands done, of hands to do. */
  rebuildDone: number | null;
  rebuildTotal: number | null;
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

/** `hands::FilterDto`: every group "any" when empty or absent. */
export interface HandFilter {
  sites?: string[];
  formats?: string[];
  variants?: string[];
  limits?: string[];
  /** `hu`, `6max`, `full`. */
  sizes?: string[];
  /** `USD:200`, `chips`. */
  stakes?: string[];
  positions?: string[];
  potTypes?: string[];
  /** `won`, `lost`, `even`. */
  results?: string[];
  /** `0-40`, `40-80`, `80-120`, `120+` (big blinds). */
  stacks?: string[];
  allIn?: boolean | null;
  hasNote?: boolean | null;
  tags?: string[];
  /** ISO instants: from (inclusive), to (exclusive). */
  from?: string | null;
  to?: string | null;
  /** Hands this opponent was dealt into (R2.7c): their room's site key and name. */
  player?: PlayerRef | null;
}

/** An opponent of a room with real screen names (R2.7c). */
export interface PlayerRef {
  site: string;
  player: string;
}

/** `hands::CursorDto`: where the next page starts. */
export interface HandCursor {
  playedAt: string;
  handKey: string;
}

/** `hands::HandRowDto`: one row of the list. Money in minor units. */
export interface HandRow {
  handKey: string;
  site: string;
  siteName: string;
  siteHandId: string;
  playedAt: string | null;
  gameFormat: string;
  variant: string;
  limitType: string;
  currency: string;
  currencySymbol: string;
  minorUnits: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  maxSeats: number;
  tableName: string | null;
  heroPosition: string | null;
  heroCards: string[];
  board: string[];
  heroNet: number | null;
  /** Thousandths of a big blind. */
  heroNetBbMilli: number | null;
  /** All in with cards to come. */
  allIn: boolean;
  /** The all-in EV result where it differs from the result. */
  evNet: number | null;
  evNetBbMilli: number | null;
  /** Waiting for the background EV pass. */
  evPending: boolean;
  potType: string;
  totalPot: number;
  showdown: boolean;
  hasNote: boolean;
  tags: string[];
}

export interface HandPage {
  rows: HandRow[];
  next: HandCursor | null;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface SiteFacet extends FacetCount {
  name: string;
}

export interface StakeFacet extends FacetCount {
  currency: string | null;
  currencySymbol: string | null;
  minorUnits: number | null;
  smallBlind: number | null;
  bigBlind: number | null;
}

/** `hands::FacetsDto`: each group counted as if its own selection were left out. */
export interface HandFacets {
  total: number;
  sites: SiteFacet[];
  formats: FacetCount[];
  variants: FacetCount[];
  limits: FacetCount[];
  sizes: FacetCount[];
  stakes: StakeFacet[];
  positions: FacetCount[];
  potTypes: FacetCount[];
  results: FacetCount[];
  stacks: FacetCount[];
  allIn: FacetCount[];
  /** Every tag in use, with its hands. */
  tags: FacetCount[];
  /** Hands with a note. */
  noted: number;
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

/** `reports::UnitsDto`: what a sample's money can be summed in (the web's refusals). */
export interface Units {
  /** Tournament chips with cash: no money and no big blinds. */
  mixedKind: boolean;
  /** Two currencies or more: big blinds only. */
  mixedCurrency: boolean;
  currency: string | null;
  symbol: string | null;
  /** Minor units per unit (100 for cents). */
  minorUnits: number | null;
}

/** `reports::GroupDto`: a group of the hero's hands (a position, a stake, a pot type...). */
export interface StatGroup {
  key: string;
  /** A room's name, for the rows by room. */
  label: string | null;
  hands: number;
  moneyHands: number;
  /** Minor units; null when refused. */
  net: number | null;
  /** Thousandths of a big blind; null when refused. */
  netBbMilli: number | null;
  /** `Report.columns`, in that order. */
  stats: Shown[];
}

/** `reports::BucketDto`: the shared graph's `WinrateGraphBucket`. */
export interface GraphBucket extends WinrateGraphBucket {
  moneyHands: number;
  cumMoneyHands: number;
}

/** `reports::GraphDto`. */
export interface Graph extends WinrateGraphData {
  moneyHands: number;
  buckets: GraphBucket[];
  allInEv: { allInHands: number; pending: number };
}

/** `reports::ReportDto`: what opening Reports shows. */
export interface Report {
  units: Units;
  summary: {
    hands: number;
    moneyHands: number;
    net: number | null;
    netBbMilli: number | null;
    evNetBbMilli: number | null;
    /** Every definition, in `statDefinitions()`' order: the shipped ones, then the user's own (R2.10). */
    stats: Shown[];
    /** The definition id of each of `stats` (match by id: the user's statistics change while the app runs). */
    ids: string[];
  };
  graph: Graph;
  /** The definition ids of every group row's `stats`. */
  columns: string[];
  byPosition: StatGroup[];
  byStake: StatGroup[];
  bySite: StatGroup[];
  bySize: StatGroup[];
  byFormat: StatGroup[];
}

/** `reports::BreakdownsDto`: the breakdowns by situation. */
export interface Breakdowns {
  columns: string[];
  potType: StatGroup[];
  stack: StatGroup[];
  handClass: StatGroup[];
  players: StatGroup[];
  street: StatGroup[];
}

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

/** `players::NotesDto`: the user's words on a player (local only for now). */
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
  /** Every definition, in `statDefinitions()`' order; hero-only ones withheld. */
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

/** The screens with saved filters. */
export type FilterScreen = "hands" | "reports";

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

/** Call `onChange` whenever the sync status changed (R1.9; at most once a second). */
export function onSyncChanged(onChange: () => void): () => void {
  return onAppEvent("sync-changed", onChange);
}

/** Call `onChange` whenever the account's status changed (R1.7). */
export function onAccountChanged(onChange: () => void): () => void {
  return onAppEvent("account-changed", onChange);
}

function onAppEvent(name: string, onChange: () => void): () => void {
  if (!inApp) {
    return () => undefined;
  }
  let stop: (() => void) | null = null;
  let stopped = false;
  listen(name, onChange)
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
