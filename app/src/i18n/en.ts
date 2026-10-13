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
    findFolders: "Find hand-history folders…",
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

  /** The first-run screen (R1.4; guideline §3 and §6). */
  firstRun: {
    title: "Welcome to Rail",
    lead: "Three steps to your first HUD: sign in, confirm your hand-history folders, open a table.",
    unavailable: "Setup is only available inside the Rail app.",
    skip: "Skip for now",

    signIn: {
      heading: "1. Sign in",
      body: "Signing in will keep your hands in sync with the web. It comes in a later version; until then Rail works on this computer without an account.",
      later: "Coming soon",
    },

    folders: {
      heading: "2. Confirm your hand-history folders",
      searching: "Looking for your poker rooms' folders…",
      found: (count: number) =>
        count === 1 ? "Rail found 1 folder on this computer." : `Rail found ${count} folders on this computer.`,
      lead: "Untick a folder to leave it out. You can change this later in Settings.",
      room: "Room",
      folder: "Folder",
      files: "Files",
      lastHand: "Last hand",
      watch: (path: string) => `Watch ${path}`,
      atLeast: (count: string) => `${count}+`,
      noFiles: "None yet",
      unknown: "Unknown",
      watched: "Already watched",
      manual: "Added by you",
      unverified: "This default folder has not been confirmed on a real install yet.",
      notThisRoom: "The newest files here do not look like this room's hand histories.",
      empty: "Rail did not find any hand-history folders on this computer.",
      lookedFor: (rooms: string) => `It looked in the default folders of: ${rooms}.`,
      noRooms: "No poker room's default folder is known for this system yet.",
      verifying:
        "We are checking each room's default folder on real installs, so this list grows with updates. If your room saves hand histories somewhere else, add the folder yourself.",
      addManually: "Add a folder manually…",
      choosing: "Choosing…",
      existingHeading: "Hands already in these folders",
      importAll: "Import everything",
      importAllHint: "Every hand already there, then each new hand as you play.",
      onlyNew: "Only new hands",
      onlyNewHint: "Leave what is there now; import only hands played from now on.",
      confirm: (count: number) => (count === 1 ? "Watch 1 folder" : `Watch ${count} folders`),
      adding: "Adding…",
      added: (count: number) => (count === 1 ? "Rail is watching 1 folder." : `Rail is watching ${count} folders.`),
      discoverFailed: (reason: string) => `Could not look for folders: ${reason}`,
      addFailed: (reason: string) => `Could not add the folders: ${reason}`,
    },

    table: {
      heading: "3. Open a table",
      body: "Play as usual. Rail reads each hand as your poker room writes it, and Today shows them arriving.",
      done: "Go to Today",
    },
  },

  settings: {
    loading: "Loading…",
    saveFailed: (reason: string) => `Could not save the change: ${reason}`,
    unavailable: "Settings are only available inside the Rail app.",

    folders: {
      heading: "Hand-history folders",
      body: "Look for your poker rooms' folders again, or add one by hand.",
      open: "Find folders…",
    },

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
