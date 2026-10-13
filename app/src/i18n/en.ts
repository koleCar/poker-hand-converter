/**
 * Every user-facing string of the desktop app, in English - the source
 * locale. `hr.ts` has the same shape, checked against `Dict` (`types.ts`), so
 * a key cannot exist in one language and not the other.
 *
 * The same pattern as the web's `frontend/src/lib/i18n/en.ts`, much smaller:
 * nested plain objects, `as const`; a string that takes an argument is a
 * function, so the argument is type-checked and a translator sees the whole
 * sentence. Components get the dictionary from `useT()` (`index.tsx`); the
 * lint rule in `eslint.config.js` rejects bare JSX text and bare
 * `title` / `aria-label` / `placeholder` / `alt` literals in `src/**`.
 *
 * The tray menu is drawn by the Rust side, which has its own copy of the
 * `tray` strings (`src-tauri/src/strings.rs`); keep the two in step.
 */
export const en = {
  brand: {
    name: "Rail",
  },

  nav: {
    label: "Main",
    today: "Today",
    hands: "Hands",
    reports: "Reports",
    players: "Players",
    hud: "HUD",
    settings: "Settings",
  },

  placeholder: "Not built yet.",

  screens: {
    today: {
      title: "Today",
      lead: "Your current session: result, hands played and import status.",
    },
    hands: {
      title: "Hands",
      lead: "Every hand, with filters, the replayer, tags and notes.",
    },
    reports: {
      title: "Reports",
      lead: "Winnings and all-in EV over time, results by position and situation.",
    },
    players: {
      title: "Players",
      lead: "Opponent profiles, notes and colour labels.",
    },
    hud: {
      title: "HUD",
      lead: "The HUD editor and its presets.",
    },
    settings: {
      title: "Settings",
      lead: "Folders, rooms, account and appearance.",
    },
  },

  /** The Today screen's import status: the local store's counts (R1.2). */
  today: {
    heading: "Your hands",
    loading: "Loading…",
    unavailable: "The hand store is only available inside the Rail app.",
    storeError: (reason: string) => `The hand store did not open: ${reason}`,
    empty: "No hands yet. Rail imports them from your hand-history folders once they are set up.",
    hands: "Hands stored",
    handsToday: "Imported today",
    files: "Files read",
    filesWithErrors: "Files with errors",
    folders: "Folders watched",
    quarantined: "Hands refused",
    unsupported: "Unsupported formats",
    outbox: "Waiting to sync",
    storeFile: "Stored in",
  },

  /** The Today screen's watcher status (R1.3). */
  watch: {
    heading: "Import",
    loading: "Loading…",
    unavailable: "Import status is only available inside the Rail app.",
    notRunning: (reason: string) => `Import is not running: ${reason}`,
    running: "Rail reads new hands from these folders as the rooms write them.",
    paused: "Import is paused. Changes are noted and read when you resume.",
    pause: "Pause import",
    resume: "Resume import",
    noFolders: "No folders are watched yet.",
    folder: "Folder",
    status: "Status",
    handsToday: "Today",
    hands: "Hands",
    lastImport: "Last import",
    issues: "Issues",
    never: "Never",
    none: "None",
    states: {
      watching: "Watching",
      polling: "Polling (network folder)",
      unavailable: "Not available",
      error: "Cannot be read",
      disabled: "Off",
    },
    quarantined: (count: number) => `${count} refused`,
    fileErrors: (count: number) => `${count} unreadable`,
    pending: (count: number) => `${count} waiting for the hand to finish`,
  },

  settings: {
    loading: "Loading…",
    saveFailed: (reason: string) => `Could not save the change: ${reason}`,
    unavailable: "Settings are only available inside the Rail app.",

    appearance: {
      heading: "Appearance",
      theme: "Theme",
      system: "Match the system",
      dark: "Dark",
      light: "Light",
    },

    startup: {
      heading: "Startup",
      startAtLogin: "Start Rail when you log in",
      startAtLoginHint: "Rail starts in the tray, ready to import, without opening this window.",
    },

    about: {
      heading: "About",
      version: "Version",
      core: "Core",
      handFormat: "Hand format",
      parsers: (count: number) => `${count} parsers`,
      sites: "Rooms in sites.json",
      sitesCount: (count: number, version: number) => `${count} (format version ${version})`,
      configError: (reason: string) => `sites.json did not load: ${reason}`,
      logs: "Log files",
      settingsFile: "Settings file",
      unknown: "Unknown",
    },
  },

  /** Debug builds only (`import.meta.env.DEV`); never shipped. */
  dev: {
    heading: "Developer: convert one file",
    note: "Debug builds only. Runs the Rust core on a file and shows what came out.",
    pick: "Choose a file…",
    running: "Converting…",
    file: "File",
    encoding: "Encoding",
    detected: "Detected",
    detectedAs: (parser: string, permille: number) => `${parser} (${permille} ‰)`,
    nothing: "None",
    hands: "Hands",
    refused: "Refused",
    byParser: "By parser",
    firstRefusals: "First refusals",
    unrecognized: "No parser claims this file (it would go to the unsupported-format registry).",
    problem: (kind: string) => `Not readable as text: ${kind}`,
    error: (message: string) => `The core threw: ${message}`,
    millis: (ms: number) => `${ms} ms`,
    time: "Time",
    addFolder: "Add a folder to watch…",
    addFolderNote:
      "Debug builds only: watches a folder (with its subfolders) until first-run setup and Settings, Folders exist.",
    adding: "Choosing…",
  },

  /** Mirrored in `src-tauri/src/strings.rs`; not used by the window. */
  tray: {
    tooltip: "Rail",
    statusIdle: "No folders watched yet",
    statusWatching: (folders: number, handsToday: number) =>
      `Watching ${folders === 1 ? "1 folder" : `${folders} folders`} · ${
        handsToday === 1 ? "1 hand today" : `${handsToday} hands today`
      }`,
    statusPaused: "Import paused",
    statusUnavailable: (folders: number) =>
      folders === 1 ? "1 folder cannot be read" : `${folders} folders cannot be read`,
    statusError: "Import is not running",
    open: "Open Rail",
    pauseImport: "Pause import",
    resumeImport: "Resume import",
    quit: "Quit Rail",
  },
} as const;
