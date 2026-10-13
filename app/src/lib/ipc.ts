/**
 * The Rust commands, typed. Each type mirrors a `#[derive(Serialize)]` struct
 * in `src-tauri/src/commands.rs` or `dev.rs` (camelCase on both sides).
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

export type Theme = "system" | "dark" | "light";

export interface Settings {
  version: number;
  theme: Theme;
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
  /** ms since the epoch. */
  lastImportAt: number | null;
}

/** `watch::WatchStatus`: the watcher (R1.3). */
export interface WatchStatus {
  running: boolean;
  paused: boolean;
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
  /** ms since the epoch. */
  lastSeen: number;
}

/** `folder_settings::FolderQuarantine`. */
export interface FolderQuarantine {
  reasons: { reason: string; count: number }[];
  entries: RefusedHand[];
  /** More entries exist than are listed. */
  truncated: boolean;
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

/** False in a plain browser (`npm run dev` without Tauri). */
export const inApp = isTauri();

export const ipc = {
  coreInfo: () => invoke<CoreInfo>("core_info"),
  appInfo: () => invoke<AppInfo>("app_info"),
  getSettings: () => invoke<Settings>("get_settings"),
  setTheme: (theme: Theme) => invoke<Settings>("set_theme", { theme }),
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
  dev: {
    pickFile: () => invoke<string | null>("dev_pick_file"),
    convertFile: (path: string) => invoke<ConvertSummary>("convert_file", { path }),
  },
};

/** A rejected `invoke` carries the command's `Err(String)`. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
