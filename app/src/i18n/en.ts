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
    account: "Account settings",
    session: {
      current: "Current session",
      last: "Last session",
      heading: "Session",
      loading: "Reading your session…",
      none: "No session yet. Your session shows up here with the first hand Rail imports.",
      error: (reason: string) => `The session did not load: ${reason}`,
      started: (time: string) => `Started ${time}`,
      range: (from: string, to: string) => `${from} – ${to}`,
      lasted: (duration: string) => `${duration} so far`,
      duration: (minutes: number) =>
        minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`,
      rule: (minutes: number) =>
        `A session is a run of hands with no break longer than ${minutes} minutes, across every table.`,
      result: "Result",
      resultBb: "In big blinds",
      hands: "Hands",
      perHour: "Hands per hour",
      tables: "Tables",
      perHourTitle: "Over the session's length so far",
      mixedKind: "This session mixes tournament chips with cash, so it has no result to add up.",
      mixedCurrency: "This session spans more than one currency: its result is in big blinds only.",
      stats: "Session statistics",
      statsNote: "Bomb pots are left out of the statistics, as everywhere; the result includes them.",
      pots: "Biggest pots",
      potsNote: "In big blinds. Open one in Hands.",
      potColumns: {
        time: "Time",
        stakes: "Stakes",
        cards: "Cards",
        pot: "Pot",
        result: "Result",
      },
      potBb: (bb: string) => `${bb} bb`,
      openHand: (id: string) => `Open hand #${id} in Hands`,
      reports: "All reports",
    },
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

  /** Folders discovery found, as the first-run screen and Settings list them. */
  foundFolders: {
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
  },

  /** "Import everything" or "Only new hands", wherever a folder is added. */
  importChoice: {
    importAll: "Import everything",
    importAllHint: "Every hand already there, then each new hand as you play.",
    onlyNew: "Only new hands",
    onlyNewHint: "Leave what is there now; import only hands played from now on.",
  },

  /** The first-run screen (R1.4; guideline §3 and §6). */
  firstRun: {
    title: "Welcome to Rail",
    lead: "Three steps to your first HUD: sign in, confirm your hand-history folders, open a table.",
    unavailable: "Setup is only available inside the Rail app.",
    skip: "Skip for now",

    signIn: {
      heading: "1. Sign in",
      useOffline: "Use offline",
      offlineChosen: "Rail works offline. You can sign in any time in Settings, Account.",
    },

    folders: {
      heading: "2. Confirm your hand-history folders",
      searching: "Looking for your poker rooms' folders…",
      found: (count: number) =>
        count === 1 ? "Rail found 1 folder on this computer." : `Rail found ${count} folders on this computer.`,
      lead: "Untick a folder to leave it out. You can change this later in Settings.",
      empty: "Rail did not find any hand-history folders on this computer.",
      lookedFor: (rooms: string) => `It looked in the default folders of: ${rooms}.`,
      noRooms: "No poker room's default folder is known for this system yet.",
      verifying:
        "We are checking each room's default folder on real installs, so this list grows with updates. If your room saves hand histories somewhere else, add the folder yourself.",
      addManually: "Add a folder manually…",
      choosing: "Choosing…",
      existingHeading: "Hands already in these folders",
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

  /** The desktop account (R1.7): Settings, Account; the first-run screen; Today. */
  account: {
    heading: "Account",
    loading: "Loading…",
    notConfigured:
      "This build of Rail has no account service. Everything works on this computer; nothing is synced.",
    signedOut:
      "Sign in to keep your hands in sync with the web. Rail opens the sign-in page in your browser, where your password manager and Google sign-in work as usual.",
    signIn: "Sign in in your browser",
    waiting: (time: string) => `Finish signing in in your browser (${time} left).`,
    waitingHint: "Already signed in on the web? Confirm there with Sign in to Rail.",
    openAgain: "Open the page again",
    cancel: "Cancel",
    signedInAs: (email: string) => `Signed in as ${email}`,
    online: "Connected.",
    offline: "Offline. Rail keeps working and reconnects by itself.",
    signOut: "Sign out",
    notSignedIn: "Not signed in: your hands stay on this computer.",
    signingInShort: "Signing in in your browser…",
    signingOut: "Signing out…",
    failed: (reason: string) => `That did not work: ${reason}`,
    notices: {
      cancelled: "Signing in was cancelled in the browser.",
      timedOut: "Signing in took longer than ten minutes. Start again.",
      notInProgress: "That sign-in link was for an earlier attempt, or Rail was restarted since. Start again.",
      invalidLink: "That sign-in link was not valid. Start again.",
      linkRejected: "That sign-in expired or was already used. Start again.",
      offline: "Rail could not reach the server to finish signing in. Check the connection and start again.",
      sessionEnded:
        "You were signed out: the session ended on the server (for example after a password change). Sign in again.",
      keychainUnavailable:
        "Rail could not use the system keychain, so it will ask you to sign in again after it restarts.",
      signedOutLocally: "Signed out on this computer. Rail could not reach the server to end the session there.",
      browserFailed: "Rail could not open your browser. Use Open the page again.",
    },
  },

  /** Sync with the web (R1.9): Settings, Account; Today; the tray. */
  sync: {
    heading: "Sync",
    loading: "Loading…",
    off: "Sync is not available in this build. Your hands stay on this computer.",
    starting: "Starting…",
    signedOut: (waiting: number) =>
      waiting === 0
        ? "Sign in to sync. Your hands stay on this computer until then."
        : `Sign in to sync. ${waiting} hands wait on this computer until then.`,
    paused: (waiting: number) =>
      waiting === 0 ? "Sync is paused." : `Sync is paused. ${waiting} hands wait to be sent.`,
    mismatch: (owner: string, email: string, hands: number) =>
      `This computer's ${hands} hands were synced to ${owner}. You are now signed in as ${email}.`,
    mismatchQuestion: (email: string) => `Upload them to ${email} too?`,
    mismatchHint:
      "Uploading copies them into this account's library; nothing is removed anywhere. Until you choose, nothing is sent or fetched.",
    upload: (email: string) => `Upload to ${email}`,
    keepApart: "Keep them apart",
    declined: (email: string) =>
      `Not syncing: this computer's hands stay apart from ${email}. Sign in with the other account to sync again.`,
    uploadInstead: (email: string) => `Upload them to ${email} instead`,
    anotherAccount: "another account",
    syncing: (sent: number, total: number) => `Syncing ${sent} of ${total} hands.`,
    speed: (hands: number, kb: number) => `About ${hands} hands a second (${kb} KB/s).`,
    capped: (limit: string) => `Upload limited to ${limit} while a large backlog syncs.`,
    upToDate: "Up to date.",
    lastSync: (time: string) => `Last synced ${time}.`,
    offline: (waiting: number) =>
      waiting === 0
        ? "Offline. Rail syncs again by itself when the connection is back."
        : `Offline. ${waiting} hands wait; Rail sends them by itself when the connection is back.`,
    rateLimited: (time: string) => `The account's sync limit is reached for now. Rail continues at ${time}.`,
    failed: (reason: string, time: string) => `Sync ran into a problem: ${reason}. Rail tries again at ${time}.`,
    retrying: (count: number) => `${count} hands will be tried again shortly.`,
    pulled: (count: number) => `${count} hands from the web and your other computers were added here.`,
    pullSkipped: (count: number) => `${count} hands from the web need a newer Rail to open.`,
    rejectedHeading: (count: number) => `The server refused ${count} hands`,
    rejectedHint: "Sending them again cannot help. After a Rail update, try again.",
    reasons: {
      shape: "Missing parts of the hand",
      schema: "Unknown hand format version",
      "hand-key": "Hand id does not match",
      "raw-text": "Contained the original text",
      "too-large": "Too large",
      invalid: "A value the server does not accept",
      unreadable: "Could not be read here",
    } as Record<string, string>,
    otherReason: (code: string) => `Other (${code})`,
    tryAgain: "Try again",
    syncNow: "Sync now",
    pause: "Pause sync",
    resume: "Resume sync",
    capLabel: "Upload speed while a large backlog syncs",
    caps: {
      slow: "256 KB/s",
      normal: "1 MB/s (default)",
      fast: "4 MB/s",
      none: "No limit",
    },
    today: {
      upToDate: "Synced with the web.",
      syncing: (sent: number, total: number) => `Syncing ${sent} of ${total} hands with the web.`,
      waiting: (count: number) => `${count} hands wait to sync.`,
      offline: "Offline: hands sync when the connection is back.",
      paused: "Sync is paused.",
      question: "Sync waits for your answer.",
      problem: "Sync has a problem.",
      details: "Sync settings",
    },
    failedAction: (reason: string) => `That did not work: ${reason}`,
  },

  settings: {
    loading: "Loading…",
    saveFailed: (reason: string) => `Could not save the change: ${reason}`,
    unavailable: "Settings are only available inside the Rail app.",

    /** Settings, Folders (R1.5; guideline §3 "Upravljanje mapama"). */
    folders: {
      heading: "Hand-history folders",
      body: "Rail reads new hands from these folders as your poker rooms write them.",
      loading: "Loading folders…",
      notRunning: (reason: string) => `Import is not running: ${reason}`,
      loadFailed: (reason: string) => `Could not load the folders: ${reason}`,
      empty: "No folders are watched yet. Add one, or let Rail look for your poker rooms' folders.",
      add: "Add a folder…",
      choosing: "Choosing…",
      findAgain: "Find folders again",
      setup: "Open the setup screen",
      list: "Watched folders",

      search: {
        heading: "Folders Rail found",
        searching: "Looking for your poker rooms' folders…",
        failed: (reason: string) => `Could not look for folders: ${reason}`,
        noneNew: "No new folders found: every folder Rail knows of is already watched.",
        found: (count: number) =>
          count === 1 ? "Rail found 1 folder that is not watched yet." : `Rail found ${count} folders that are not watched yet.`,
        existingHeading: "Hands already in these folders",
        confirm: (count: number) => (count === 1 ? "Watch 1 folder" : `Watch ${count} folders`),
        adding: "Adding…",
        added: (count: number) => (count === 1 ? "Rail is watching 1 more folder." : `Rail is watching ${count} more folders.`),
        close: "Close",
      },

      room: "Room",
      roomFound: (name: string) => `${name} (found by Rail)`,
      roomChosen: (name: string) => `${name} (chosen by you)`,
      roomDetected: "Detected per file",
      roomAuto: "Detect per file",
      roomHint:
        "Choose a room only if Rail does not recognise this folder's hands: every file in it is then read as that room's.",
      lastImport: "Last import",
      never: "Never",
      handsToday: "Hands today",
      hands: "Hands",
      files: "Files",
      problems: "Problems",
      noProblems: "None",
      fileErrors: (count: number) => (count === 1 ? "1 file cannot be read" : `${count} files cannot be read`),
      pending: (count: number) =>
        count === 1 ? "1 file is waiting for its hand to finish" : `${count} files are waiting for their hand to finish`,
      quarantined: (count: number) => (count === 1 ? "1 hand refused" : `${count} hands refused`),

      showRefused: (count: number) => (count === 1 ? "Show the refused hand" : `Show the ${count} refused hands`),
      hideRefused: "Hide refused hands",
      refusedHeading: (path: string) => `Refused hands in ${path}`,
      refusedLoading: "Loading refused hands…",
      refusedFailed: (reason: string) => `Could not load the refused hands: ${reason}`,
      refusedEmpty: "No refused hands.",
      refusedLead:
        "Rail could not read these hands. They are kept, so a later version can read them; the reason says why.",
      byReason: "By reason",
      refusedMore: (shown: number, total: number) => `Showing the ${shown} most recent of ${total}.`,

      settingsOf: (path: string) => `Settings for ${path}`,
      enabled: "Watch this folder",
      enabledHint: "Switched off, the folder is not read. Its hands stay in Rail.",
      recursive: "Include subfolders",
      pollOnly: "Check for changes by polling",
      pollOnlyHint: "For network folders, whose change notifications may not arrive: Rail looks every few seconds.",
      changePath: "Change folder…",
      remove: "Remove…",
      saved: "Saved.",
      roomSaved: (count: number) =>
        count === 0
          ? "Saved."
          : count === 1
            ? "Saved. 1 file is read again as this room's."
            : `Saved. ${count} files are read again as this room's.`,
      actionFailed: (reason: string) => `Could not change the folder: ${reason}`,

      folder: "Folder",
      cancel: "Cancel",
      addHeading: "Add a folder",
      addHint: "Any folder works, on this computer, an external drive or a network share.",
      addConfirm: "Watch this folder",
      adding: "Adding…",
      addedOne: (path: string) => `Rail is watching ${path}.`,
      addFailed: (reason: string) => `Could not add the folder: ${reason}`,
      existingHeading: "Hands already in this folder",

      moveHeading: "Change this folder",
      moveFrom: "Now",
      moveTo: "New folder",
      moveBody:
        "If the new folder holds the same files (you moved or copied it), Rail continues where it stopped. Otherwise it reads the new folder, and the hands already imported from the old one stay in Rail.",
      moveConfirm: "Use the new folder",
      moving: "Changing…",
      moved: (moved: number, detached: number) =>
        moved === 0
          ? "Done. Rail reads the new folder; the old folder's hands stay in Rail."
          : detached === 0
            ? `Done. ${moved === 1 ? "1 file continues" : `${moved} files continue`} where it stopped.`
            : `Done. ${moved === 1 ? "1 file continues" : `${moved} files continue`} where it stopped; ${
                detached === 1 ? "1 file was" : `${detached} files were`
              } not found there, and its hands stay in Rail.`,

      removeHeading: "Remove this folder?",
      removeBody: (hands: number) =>
        hands === 0
          ? "Rail stops watching it. Nothing in the folder is deleted."
          : `Rail stops watching it. The ${hands === 1 ? "hand" : `${hands} hands`} already imported from it stay in Rail, and nothing in the folder is deleted.`,
      removeConfirm: "Remove folder",
      removing: "Removing…",
      removed: (path: string) => `Rail no longer watches ${path}. Its hands stay.`,
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

  /** Debug builds: the background statistics pass (R2.3). */
  devStats: {
    heading: "Developer: statistics",
    note: "Debug builds only. The background pass that rebuilds the statistics and computes the all-in EV of preflop all-ins.",
    activity: "Doing",
    activities: {
      idle: "Nothing",
      rebuilding: "Rebuilding the statistics",
      indexing: "Sorting the opponents of new hands",
      computing: "Computing all-in EV",
      "paused-backfill": "Waiting for the import to finish",
      "paused-tables": "All-in EV waits while tables are open",
      stopped: "Stopped",
    },
    rebuild: "Rebuild",
    rebuildProgress: (done: number, total: number) => `${done} of ${total} hands`,
    none: "None",
    evPending: "Hands waiting for all-in EV",
    evComputed: "All-in EV computed",
    evTime: (n: number, ms: number) => `${n} hands in ${(ms / 1000).toFixed(1)} s`,
    rebuildButton: "Rebuild statistics",
    evButton: "Compute all-in EV again",
    rebuildStarted: (n: number) => `Rebuilding the statistics of ${n} hands.`,
    evQueued: (n: number) => `${n} hands queued for all-in EV.`,
  },

  /** A folder's backfill in progress, on Today and the folder cards (R1.6). */
  backfill: {
    of: (path: string) => `Importing the hands in ${path}`,
    title: (percent: number) => `Importing old hands: ${percent}%`,
    estimating: "Estimating the time left…",
    left: (seconds: number) =>
      seconds < 60
        ? "Less than a minute left"
        : seconds < 5400
          ? `About ${Math.round(seconds / 60)} min left`
          : `About ${Math.round(seconds / 3600)} h left`,
    detail: (mbDone: string, mbTotal: string, filesDone: string, filesTotal: string, hands: string) =>
      `${mbDone} of ${mbTotal} MB · ${filesDone} of ${filesTotal} files · ${hands} hands so far`,
  },

  /** Refused hands: the app-wide view in Settings, the raw text, "try again" (R1.6). */
  refused: {
    heading: "Refused hands",
    lead: "Hands Rail could not read, from every folder. They are kept with their text, so a later version can read them.",
    loading: "Loading refused hands…",
    loadFailed: (reason: string) => `Could not load the refused hands: ${reason}`,
    none: "No refused hands.",
    total: (count: number) => (count === 1 ? "1 hand was refused." : `${count} hands were refused.`),
    byReason: "By reason",
    pickReason: "Choose a reason to see its hands.",
    ofReason: (reason: string) => `Hands refused as ${reason}`,
    more: (shown: number, total: number) => `Showing the ${shown} most recent of ${total}.`,
    reason: "Reason",
    details: "Details",
    file: "File",
    seen: "Last seen",
    text: "Text",
    showText: "Show text",
    showTextOf: (file: string) => `Show the text of the refused hand in ${file}`,
    textHeading: "Refused hand",
    textLabel: "The hand as the room wrote it",
    textLoading: "Loading the text…",
    textFailed: (reason: string) => `Could not load the text: ${reason}`,
    gone: "This hand is no longer refused: it was read again.",
    parser: "Parser",
    parserVersion: (parser: string, version: string) => `${parser}, version ${version}`,
    noParser: "No parser recognised it",
    copy: "Copy the text",
    copied: "Copied.",
    copyFailed: "Could not copy. Select the text and copy it yourself.",
    close: "Close",
    retry: "Try again after an update",
    retrying: "Reading again…",
    retryHint: (hands: number, files: number) =>
      `${hands === 1 ? "1 hand was" : `${hands} hands were`} refused by an older version of ${
        hands === 1 ? "its parser" : "their parsers"
      } (${files === 1 ? "1 file" : `${files} files`}). This version may read ${hands === 1 ? "it" : "them"}.`,
    upToDate: "These hands were refused by this version's parsers.",
    retried: (files: number) =>
      files === 0 ? "Nothing to read again." : files === 1 ? "1 file is being read again." : `${files} files are being read again.`,
    retryFailed: (reason: string) => `Could not read them again: ${reason}`,
  },

  /** The Hands screen (R2.7a). */
  hands: {
    unavailable: "Your hands are only available inside the Rail app.",
    storeError: (reason: string) => `The hand list did not load: ${reason}`,
    loading: "Loading hands…",
    empty: "No hands yet. They appear here as Rail imports them from your hand-history folders.",
    noMatch: "No hand matches these filters.",
    rebuilding: (done: string, total: string) =>
      `Updating the hand list after an upgrade: ${done} of ${total} hands. The list fills as it goes.`,
    count: (shown: string) => `${shown} hands`,
    countOf: (matching: string, total: string) => `${matching} of ${total} hands`,
    loadingMore: "Loading more…",
    listLabel: "Hands, newest first",
    columns: {
      date: "Date",
      room: "Room",
      stakes: "Stakes",
      position: "Pos.",
      cards: "Cards",
      board: "Board",
      result: "Result",
      bigBlinds: "bb",
      marks: "Marks",
    },
    noCards: "—",
    preflop: "No flop",
    noHero: "—",
    handId: (id: string) => `#${id}`,
    rowLabel: (date: string, room: string, stakes: string, result: string) =>
      `${date}, ${room}, ${stakes}, ${result}`,
    allIn: "All in",
    allInEv: (ev: string) => `All in · EV ${ev} bb`,
    evShort: (ev: string) => `EV ${ev}`,
    allInPending: "All in · EV being computed",
    showdown: "Showdown",
    hasNote: "Has a note",
    filters: {
      label: "Filters",
      clearAll: "Clear all",
      clear: "Any",
      groupLabel: (group: string) => `Filter: ${group}`,
      summary: (group: string, values: string) => `${group}: ${values}`,
      more: (first: string, more: number) => `${first} +${more}`,
      groups: {
        date: "Date",
        site: "Room",
        format: "Game",
        variant: "Variant",
        limit: "Limit",
        size: "Table",
        stakes: "Stakes",
        position: "Position",
        potType: "Pot",
        result: "Result",
        stack: "Stack",
        allIn: "All-in",
        notes: "Notes",
        tags: "Tags",
        player: "Player",
      },
      dates: {
        today: "Today",
        week: "Last 7 days",
        month: "Last 30 days",
        year: "Last 12 months",
        custom: "Custom",
        from: "From",
        to: "To",
      },
      formats: {
        cash: "Cash",
        tournament: "Tournament",
        sng: "Sit & Go",
        spin: "Spin",
      },
      limits: {
        nl: "No limit",
        pl: "Pot limit",
        fl: "Fixed limit",
      },
      sizes: {
        hu: "Heads-up",
        "6max": "6-max",
        full: "Full ring",
      },
      potTypes: {
        walk: "Walk",
        bomb: "Bomb pot",
        limped: "Limped",
        "single-raised": "Single-raised",
        "3bet": "3-bet",
        "4bet+": "4-bet+",
      },
      results: {
        won: "Won",
        lost: "Lost",
        even: "Broke even",
      },
      stacks: {
        "0-40": "Under 40 bb",
        "40-80": "40–80 bb",
        "80-120": "80–120 bb",
        "120+": "120 bb and more",
      },
      allIn: {
        yes: "All in",
        no: "Not all in",
      },
      notes: {
        yes: "With a note",
        no: "Without a note",
      },
      chips: "Chips",
      removePlayer: (name: string) => `Player: ${name}. Remove this filter`,
      noTags: "No tags yet. Tag a hand in the panel beside the replayer.",
      count: (n: string) => n,
    },
    saved: {
      button: "Saved filters",
      title: "Saved filters",
      none: "No saved filters yet.",
      apply: (name: string) => `Apply “${name}”`,
      remove: (name: string) => `Delete “${name}”`,
      name: "Name",
      namePlaceholder: "e.g. BTN 3-bet pots",
      save: "Save current filters",
      saveFailed: (reason: string) => `The filter was not saved: ${reason}`,
    },
    panel: {
      label: "Hand",
      choose: "Choose a hand from the list to replay it here.",
      loading: "Loading the hand…",
      missing: "This hand is not in your hand store any more.",
      failed: (reason: string) => `The hand did not load: ${reason}`,
      close: "Close",
      openInWeb: "Open on the web",
      openInWebSoon: "Opening hands on the web comes with sync of tags and notes.",
      tags: "Tags",
      addTag: "Add a tag",
      tagPlaceholder: "Tag, then Enter",
      removeTag: (tag: string) => `Remove tag “${tag}”`,
      tagFailed: (reason: string) => `The tag was not saved: ${reason}`,
      note: "Note",
      notePlaceholder: "What happened, what to review…",
      noteSaved: "Saved",
      noteSaving: "Saving…",
      noteFailed: (reason: string) => `The note was not saved: ${reason}`,
      localOnly: "Tags and notes stay on this computer for now.",
    },
  },

  /** The Players screen (R2.7c). */
  players: {
    unavailable: "Players are only available inside the Rail app.",
    storeError: (reason: string) => `The players did not load: ${reason}`,
    loading: "Loading players…",
    empty: "No opponents yet. They appear here as Rail imports hands from rooms that show screen names.",
    noMatch: "No opponent matches.",
    count: (players: string) => `${players} opponents`,
    countOf: (matching: string, total: string) => `${matching} of ${total} opponents`,
    rebuilding: (done: string, total: string) =>
      `Updating the players after an upgrade: ${done} of ${total} hands. The list fills as it goes.`,
    indexing: (hands: string) =>
      `Rail is still sorting the opponents of ${hands} recent hands; until it has, “hands with this player” and the breakdown by position leave those hands out.`,
    search: "Search players",
    searchPlaceholder: "Name starts with…",
    kinds: {
      label: "Game",
      all: "All games",
      cash: "Cash",
      chips: "Tournaments",
    },
    room: "Room",
    anyRoom: "All rooms",
    colourFilter: "Colour",
    labelFilter: "Label",
    noted: "With a note",
    clearFilters: "Clear filters",
    defaultKind: (kind: string) =>
      `Showing ${kind} only: tournament chips and cash do not add up to one result. Change it with the Game buttons.`,
    mixedKind:
      "These hands mix tournament chips with cash, so your result against each opponent is not shown. Choose Cash or Tournaments.",
    hidden: (hands: string) =>
      `${hands} opponents' hands from rooms that hide screen names (such as GGPoker) count in your statistics but are not listed: a name there lasts one session, so it cannot be followed from one session to the next.`,
    listLabel: "Opponents, most hands together first",
    columns: {
      name: "Player",
      room: "Room",
      hands: "Hands together",
      result: "Your result (bb)",
      lastSeen: "Last seen",
    },
    showMore: "Show more",
    colours: {
      red: "Red",
      orange: "Orange",
      yellow: "Yellow",
      green: "Green",
      blue: "Blue",
      purple: "Purple",
    },
    noColour: "No colour",
    colourOf: (colour: string) => `Colour tag: ${colour}`,
    hasNote: "Has a note",
    profile: {
      label: "Player profile",
      close: "Close the profile",
      loading: "Loading the profile…",
      failed: (reason: string) => `The profile did not load: ${reason}`,
      notOpponent:
        "This name is not an opponent from a room that shows screen names, so it has no profile and takes no notes.",
      together: "Hands together",
      togetherCash: (hands: string) => `${hands} in cash games`,
      togetherChips: (hands: string) => `${hands} in tournaments`,
      firstSeen: "First seen",
      lastSeen: "Last seen",
      result: "Your result against them",
      resultCash: "Cash",
      resultChips: "Tournaments",
      resultLine: (bb: string, hands: string) => `${bb} bb over ${hands} hands`,
      perHundred: (value: string) => `${value} bb/100`,
      noHands: "No hands",
      handsWith: (hands: string) => `Hands with this player (${hands})`,
      stats: "Their statistics",
      sample: (hands: string) => `Over ${hands} of their hands, yours or not.`,
      statsNote:
        "These are the player's own numbers from every hand of theirs Rail has seen. All-in EV is computed for your hands only and is not shown here. A value fades while its sample is thin; hover it for the sample and its 95% interval.",
      mixedKind:
        "Their hands mix tournament chips with cash, so the numbers in big blinds are withheld. Choose Cash or Tournaments.",
      breakdown: "Breakdown",
      tabs: {
        position: "Position",
        stake: "Stakes",
        size: "Table size",
        format: "Game",
      },
      heads: {
        position: "Position",
        stake: "Stakes",
        size: "Table",
        format: "Game",
      },
      noPosition: "No position",
      empty: "No hands in this split.",
      colour: "Colour tag",
      labels: "Labels",
      addLabel: "Add a label",
      labelPlaceholder: "Label, then Enter",
      removeLabel: (label: string) => `Remove label “${label}”`,
      labelsHint: "Up to eight labels of 24 characters.",
      note: "Note",
      notePlaceholder: "How they play, reads, reminders…",
      noteSaved: "Saved",
      noteSaving: "Saving…",
      saveFailed: (reason: string) => `Not saved: ${reason}`,
      localOnly: "Colours, labels and notes stay on this computer for now; they will sync with your player notes on the web later.",
    },
  },

  /** The command palette (Cmd/Ctrl + K; R2.7a: hands by id and the screens). */
  reports: {
    unavailable: "Reports are only available inside the Rail app.",
    loading: "Adding up your hands…",
    storeError: (reason: string) => `The report did not load: ${reason}`,
    empty: "No hands yet. Reports fill in as Rail imports your hand histories.",
    noMatch: "None of your hands matches these filters.",
    count: (hands: string) => `${hands} hands`,
    rebuilding: (done: string, total: string) =>
      `Updating the statistics after an upgrade: ${done} of ${total} hands. The numbers grow as it goes.`,
    defaultFormat: (format: string) =>
      `Showing ${format} only: tournament chips and cash do not add up to one result. Change it with the Game chip.`,
    summary: {
      label: "Summary",
      hands: "Hands",
      result: "Result",
      netBb: "Big blinds",
      bb100: "bb/100",
      evBb100: "All-in EV bb/100",
    },
    units: {
      mixedKind:
        "These hands mix tournament chips with cash, so there is no result to add up and no graph to draw. Filter to one game format.",
      mixedCurrency:
        "These hands span more than one currency, so the money figures are withheld; big blinds add up correctly.",
    },
    evPending: (hands: string) =>
      `${hands} all-in hands are still being evaluated in the background; until then the EV line counts them at their result.`,
    graph: {
      heading: "Winnings",
      unit: "Show in",
      bigBlinds: "Big blinds",
      money: "Money",
      notEnough: "Not enough hands yet to draw a curve.",
    },
    stats: {
      heading: "Statistics",
      groups: {
        preflop: "Preflop",
        postflop: "Postflop",
        showdown: "Showdown",
        results: "Results",
      },
      note: "A value fades while its sample is thin; hover it for the sample and its 95% interval.",
    },
    breakdown: {
      heading: "Breakdown",
      splitBy: "Split by",
      computing: "Counting…",
      tabs: {
        position: "Position",
        stake: "Stakes",
        size: "Table size",
        site: "Room",
        format: "Game",
        potType: "Pot type",
        stack: "Stack depth",
        players: "Players",
        street: "Street reached",
        handClass: "Starting hands",
      },
      heads: {
        position: "Position",
        stake: "Stakes",
        size: "Table",
        site: "Room",
        format: "Game",
        potType: "Pot",
        stack: "Stack",
        players: "Players",
        street: "Street",
        handClass: "Hand",
      },
      unknown: "Unknown",
      noPosition: "No position",
      headsUp: "Heads-up",
      handed: (players: string) => `${players}-handed`,
      stacks: {
        "0-20": "Under 20 bb",
        "20-40": "20–40 bb",
        "40-70": "40–70 bb",
        "70-100": "70–100 bb",
        "100-150": "100–150 bb",
        "150-250": "150–250 bb",
        "250+": "250 bb and more",
      } as Record<string, string>,
      streets: {
        preflop: "Preflop",
        flop: "Flop",
        turn: "Turn",
        river: "River",
        showdown: "Showdown",
      } as Record<string, string>,
      empty: "No hands in this split.",
    },
    matrix: {
      colourBy: "Colour by",
      metrics: {
        bb_per_100: "Win rate",
        vpip: "VPIP",
        pfr: "PFR",
        hands: "Dealt",
      },
      gridLabel: "Starting hands, thirteen by thirteen",
      cellLabel: (handClass: string, hands: string | null) =>
        `${handClass}: ${hands === null ? "never dealt" : `${hands} hands`}`,
      neverDealt: "never dealt in this sample",
      notHoldem: "The grid is for Hold'em starting hands; these hands have none. The table lists every class.",
      selected: (handClass: string) => `${handClass} in this sample`,
    },
  },
  palette: {
    label: "Go to",
    placeholder: "Hand id, player or screen",
    empty: "Nothing found. Type a hand's number as the room printed it, or the start of a player's name.",
    screens: "Screens",
    hands: "Hands",
    reports: "Reports",
    report: (name: string) => `Report: ${name}`,
    searching: "Searching…",
    screen: (name: string) => name,
    hand: (id: string) => `Hand #${id}`,
    handDetail: (room: string, stakes: string, date: string) => `${room} · ${stakes} · ${date}`,
    players: "Players",
    player: (name: string) => `Player: ${name}`,
    playerDetail: (room: string, hands: string) => `${room} · ${hands} hands together`,
  },

  /** The words the shared UI package (`packages/ui`) needs besides the replayer's. */
  ui: {
    closeNamed: (what: string) => `Close ${what.toLowerCase()}`,
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
    statusImporting: (percent: number, hands: number) =>
      `Importing ${percent}% · ${hands === 1 ? "1 hand" : `${hands} hands`}`,
    open: "Open Rail",
    pauseImport: "Pause import",
    resumeImport: "Resume import",
    quit: "Quit Rail",
  },
} as const;
