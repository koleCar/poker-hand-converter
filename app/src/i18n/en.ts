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
 * Numbers inside a sentence are formatted here (`countIn`), so each language
 * groups digits its own way and picks the noun's form from the number
 * (Croatian has three, `plural`); a count is passed as a number, not as text.
 *
 * The tray menu is drawn by the Rust side, which has its own copy of the
 * `tray` strings (`src-tauri/src/strings.rs`); keep the two in step.
 */
import { countIn } from "./format";

/** Counts in English digits ("1,204"), whatever the window's language. */
const n = countIn("en");

/** "1 hand", "1,204 hands". */
function hands(count: number): string {
  return count === 1 ? "1 hand" : `${n(count)} hands`;
}

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
    search: "Search…",
    searchLabel: "Search or run a command",
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
        : `Sign in to sync. ${hands(waiting)} wait on this computer until then.`,
    paused: (waiting: number) =>
      waiting === 0 ? "Sync is paused." : `Sync is paused. ${hands(waiting)} wait to be sent.`,
    mismatch: (owner: string, email: string, count: number) =>
      `This computer's ${count === 1 ? "hand was" : `${n(count)} hands were`} synced to ${owner}. You are now signed in as ${email}.`,
    mismatchQuestion: (email: string) => `Upload them to ${email} too?`,
    mismatchHint:
      "Uploading copies them into this account's library; nothing is removed anywhere. Until you choose, nothing is sent or fetched.",
    upload: (email: string) => `Upload to ${email}`,
    keepApart: "Keep them apart",
    declined: (email: string) =>
      `Not syncing: this computer's hands stay apart from ${email}. Sign in with the other account to sync again.`,
    uploadInstead: (email: string) => `Upload them to ${email} instead`,
    anotherAccount: "another account",
    syncing: (sent: number, total: number) => `Syncing ${n(sent)} of ${hands(total)}.`,
    speed: (perSecond: number, kb: number) => `About ${hands(perSecond)} a second (${n(kb)} KB/s).`,
    capped: (limit: string) => `Upload limited to ${limit} while a large backlog syncs.`,
    upToDate: "Up to date.",
    lastSync: (time: string) => `Last synced ${time}.`,
    offline: (waiting: number) =>
      waiting === 0
        ? "Offline. Rail syncs again by itself when the connection is back."
        : `Offline. ${hands(waiting)} ${waiting === 1 ? "waits" : "wait"}; Rail sends ${waiting === 1 ? "it" : "them"} by itself when the connection is back.`,
    rateLimited: (time: string) => `The account's sync limit is reached for now. Rail continues at ${time}.`,
    failed: (reason: string, time: string) => `Sync ran into a problem: ${reason}. Rail tries again at ${time}.`,
    retrying: (count: number) => `${hands(count)} will be tried again shortly.`,
    pulled: (count: number) =>
      `${hands(count)} from the web and your other computers ${count === 1 ? "was" : "were"} added here.`,
    pullSkipped: (count: number) => `${hands(count)} from the web ${count === 1 ? "needs" : "need"} a newer Rail to open.`,
    rejectedHeading: (count: number) => `The server refused ${hands(count)}`,
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
      syncing: (sent: number, total: number) => `Syncing ${n(sent)} of ${hands(total)} with the web.`,
      waiting: (count: number) => `${hands(count)} ${count === 1 ? "waits" : "wait"} to sync.`,
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

    /** Settings, Your statistics (R2.10; guideline §5 "Custom statistike"). */
    custom: {
      heading: "Your statistics",
      body: "Count what the standard statistics do not. A counter is a rule over every decision in your hands - when a decision is a chance, and what counts as taking it - and the statistic shows it through a formula, with its own label, colours and minimum sample. Rail counts a new counter over all your hands in the background; Reports lists the result with the other statistics.",
      loading: "Loading your statistics…",
      loadFailed: (reason: string) => `Could not load your statistics: ${reason}`,
      empty: "No statistics of your own yet.",
      list: "Your statistics",
      columns: {
        name: "Statistic",
        value: "All your hands",
        status: "Counted",
        actions: "Actions",
      },
      add: "New statistic",
      edit: "Edit",
      editNamed: (name: string) => `Edit ${name}`,
      delete: "Delete",
      deleteNamed: (name: string) => `Delete ${name}`,
      deleteHeading: "Delete this statistic?",
      deleteBody: (name: string) => `${name} and everything counted for it go. Your hands stay as they are.`,
      deleteConfirm: "Delete statistic",
      deleting: "Deleting…",
      deleteRefused: (reader: string) => `${reader} reads this statistic's counters. Change or delete that one first.`,
      counting: (done: number, total: number) => `Counting: ${n(done)} of ${hands(total)}`,
      counted: (total: number) => `Over ${hands(total)}`,
      formulaOnly: "From the standard counters",
      broken: "This version of Rail cannot show it:",
      form: {
        newHeading: "New statistic",
        editHeading: (name: string) => `Edit ${name}`,
        name: "Name",
        nameHint: "As tables and reports list it.",
        label: "Short label",
        labelHint: "What a HUD panel prints: a few characters.",
        description: "Description",
        descriptionHint: "One sentence; shown when the pointer rests on the name.",
        id: "Id",
        idHint: "Formulas name the counter by it: the id for the chances taken, id_opp for the chances. Lower case letters, digits and _.",
        group: "Group",
        groups: {
          preflop: "Preflop",
          postflop: "Postflop",
          showdown: "Showdown",
          results: "Results",
        },
        predicate: "Counter",
        predicateHint:
          "Empty: a formula over the standard counters only. Otherwise start with first, any or each; then when a decision is a chance; after => what counts as taking it. Example: first street = flop and facing_cbet => action = fold",
        formula: "Formula",
        formulaHint: (id: string) =>
          `Empty: pct(${id}, ${id}_opp), how often the chance was taken. Numbers, + - * /, pct(made, chances), sum(...), and every counter's name.`,
        unit: "Shown as",
        units: {
          percent: "Percent",
          ratio: "Ratio",
          count: "Count",
          bb: "Big blinds",
          bb_per_100: "bb/100",
          money: "Money",
        },
        decimals: "Decimals",
        sampleMin: "Full weight from",
        sampleMinHint: "Below this sample the value fades in tables and on the HUD.",
        sampleOf: "Sample",
        sampleOfHint: "A formula for the sample, needed when the formula is not pct(made, chances).",
        bands: "Colours",
        bandsHint: "A value below a limit takes that band's colour; the last band takes the rest. None: no colour.",
        below: "Below",
        rest: "The rest",
        remove: "Remove",
        addBand: "Add a band",
        removeBand: (index: number) => `Remove band ${index}`,
        tones: {
          "very-low": "Very low",
          low: "Low",
          normal: "Normal",
          high: "High",
          "very-high": "Very high",
        },
        save: "Save",
        saving: "Saving…",
        cancel: "Cancel",
        nameMissing: "Give it a name and a short label.",
        checking: "Checking…",
        problems: "What to fix",
        preview: "Preview",
        previewSample: (count: number) => `On your last ${hands(count)}`,
        previewAll: (count: number) => `Over all your hands (${hands(count)})`,
        previewCounts: (made: number, opp: number) => `Taken ${n(made)} times of ${n(opp)} chances`,
        noValue: "No value: no chance in these hands.",
        afterSave: "Once saved, Rail counts it over all your hands in the background.",
        saveFailed: (reason: string) => `Could not save: ${reason}`,
        reference: "Fields and examples",
        fields: "Fields a counter can read",
        fieldKinds: {
          bool: "yes or no",
          number: "number",
          choice: "one of",
        },
        examples: "Examples (click one to use it)",
        exampleNames: {
          cbet3bet: "Flop cbet in 3-bet pots",
          foldCbetMultiway: "Fold to a flop cbet, multiway",
          smallCbet: "Small flop cbet (40% of the pot or less)",
          bigOpen: "Open raise above 3 big blinds",
          shortShove: "Open shove with 15 big blinds or less",
          riverCallBig: "River call against a bet of the pot or more",
        },
      },
    },

    appearance: {
      heading: "Appearance",
      theme: "Theme",
      system: "Match the system",
      dark: "Dark",
      light: "Light",
      density: "Density",
      densityHint: "How tightly lists and tables are set: row height, spacing and their type size.",
      comfortable: "Comfortable",
      compact: "Compact",
      language: "Language",
      languageHint: "The window and the tray menu. Numbers and dates follow it.",
      languages: {
        en: "English",
        hr: "Hrvatski",
      },
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
      parsers: (count: number) => (count === 1 ? "1 parser" : `${n(count)} parsers`),
      sites: "Rooms in sites.json",
      sitesCount: (count: number, version: number) => `${n(count)} (format version ${version})`,
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
      rebuilding: "Recomputing the statistics",
      indexing: "Sorting the opponents of new hands",
      counting: "Counting your own statistics",
      computing: "Computing all-in EV",
      "recomputing-ev": "Recomputing all-in EV",
      "paused-backfill": "Waiting for the import to finish",
      "paused-tables": "Recomputing and all-in EV wait while tables are open",
      stopped: "Stopped",
    },
    rebuild: "Recompute",
    rebuildProgress: (done: number, total: number) => `${done} of ${total} hands`,
    evRecompute: "All-in EV again",
    none: "None",
    evPending: "Hands waiting for all-in EV",
    evComputed: "All-in EV computed",
    evTime: (n: number, ms: number) => `${n} hands in ${(ms / 1000).toFixed(1)} s`,
    rebuildButton: "Rebuild statistics",
    evButton: "Compute all-in EV again",
    rebuildStarted: (n: number) => `Recomputing the statistics of ${n} hands.`,
    evQueued: (n: number) => `Computing the all-in EV of ${n} hands again.`,
  },

  /**
   * A recompute after an upgrade (R2.11): the new numbers are worked out
   * beside the ones shown and replace them, whole, when done. On Reports,
   * Hands, Players and Settings.
   */
  recompute: {
    rows: (done: number, total: number) =>
      `Updating your statistics to this version of Rail: ${n(done)} of ${hands(total)}. You see the previous numbers until it is done.`,
    segments: (done: number, total: number) =>
      `Regrouping your statistics by game: ${n(done)} of ${hands(total)}. You see the previous grouping until it is done.`,
    ev: (done: number, total: number) =>
      `Computing all-in EV again: ${n(done)} of ${hands(total)}. You see the previous all-in EV until it is done.`,
    filling: (done: number, total: number) =>
      `Working out your statistics: ${n(done)} of ${hands(total)}. The numbers grow as it goes.`,
    pausedTables: "It waits while poker tables are open.",
    pausedImport: "It waits for the import to finish.",
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
    total: (count: number) => (count === 1 ? "1 hand was refused." : `${n(count)} hands were refused.`),
    byReason: "By reason",
    pickReason: "Choose a reason to see its hands.",
    ofReason: (reason: string) => `Hands refused as ${reason}`,
    more: (shown: number, total: number) => `Showing the ${n(shown)} most recent of ${n(total)}.`,
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
    rebuilding: (done: number, total: number) =>
      `Updating the hand list after an upgrade: ${n(done)} of ${hands(total)}. The list fills as it goes.`,
    count: (shown: number) => hands(shown),
    countOf: (matching: number, total: number) => `${n(matching)} of ${hands(total)}`,
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
      potOddsHidden: "Pot odds are hidden while a poker table is open: Rail gives no help during play.",
    },
  },

  /** The Players screen (R2.7c). */
  players: {
    unavailable: "Players are only available inside the Rail app.",
    storeError: (reason: string) => `The players did not load: ${reason}`,
    loading: "Loading players…",
    empty: "No opponents yet. They appear here as Rail imports hands from rooms that show screen names.",
    noMatch: "No opponent matches.",
    count: (players: number) => (players === 1 ? "1 opponent" : `${n(players)} opponents`),
    countOf: (matching: number, total: number) => `${n(matching)} of ${n(total)} opponents`,
    rebuilding: (done: number, total: number) =>
      `Updating the players after an upgrade: ${n(done)} of ${hands(total)}. The list fills as it goes.`,
    indexing: (count: number) =>
      `Rail is still sorting the opponents of ${count === 1 ? "1 recent hand" : `${n(count)} recent hands`}; until it has, “hands with this player” and the breakdown by position leave ${count === 1 ? "it" : "those hands"} out.`,
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
    hidden: (count: number) =>
      `${count === 1 ? "1 opponent's hand" : `${n(count)} opponents' hands`} from rooms that hide screen names (such as GGPoker) count in your statistics but are not listed: a name there lasts one session, so it cannot be followed from one session to the next.`,
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
      togetherCash: (count: number) => `${n(count)} in cash games`,
      togetherChips: (count: number) => `${n(count)} in tournaments`,
      firstSeen: "First seen",
      lastSeen: "Last seen",
      result: "Your result against them",
      resultCash: "Cash",
      resultChips: "Tournaments",
      resultLine: (bb: string, count: number) => `${bb} bb over ${hands(count)}`,
      perHundred: (value: string) => `${value} bb/100`,
      noHands: "No hands",
      handsWith: (count: number) => `Hands with this player (${n(count)})`,
      kind: "Game",
      kindHint: "Their numbers in cash games, in tournaments or in both; the list's choice until you pick one here.",
      stats: "Their statistics",
      sample: (count: number) =>
        count === 1 ? "Over 1 hand of theirs, yours or not." : `Over ${n(count)} of their hands, yours or not.`,
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
    count: (count: number) => hands(count),
    rebuilding: (done: number, total: number) =>
      `Updating the statistics after an upgrade: ${n(done)} of ${hands(total)}. The numbers grow as it goes.`,
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
    evPending: (count: number) =>
      count === 1
        ? "1 all-in hand is still being evaluated in the background; until then the EV line counts it at its result."
        : `${n(count)} all-in hands are still being evaluated in the background; until then the EV line counts them at their result.`,
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
      yours: (name: string) => `${name} (yours)`,
    },
    breakdown: {
      heading: "Breakdown",
      splitBy: "Split by",
      computing: "Counting…",
      handClassHidden:
        "Starting hands are hidden while a poker table is open: Rail shows no hand charts during play. They are back when the tables close.",
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
      cellLabel: (handClass: string, count: number | null) =>
        `${handClass}: ${count === null ? "never dealt" : hands(count)}`,
      neverDealt: "never dealt in this sample",
      notHoldem: "The grid is for Hold'em starting hands; these hands have none. The table lists every class.",
      selected: (handClass: string) => `${handClass} in this sample`,
    },
  },
  palette: {
    label: "Command palette",
    placeholder: "Hand number, player, screen or command",
    empty: "Nothing found. Type a hand's number as the room printed it, the start of a player's name, or a command.",
    results: (count: number) => (count === 0 ? "No results" : count === 1 ? "1 result" : `${n(count)} results`),
    recent: "Recent",
    screens: "Screens",
    hands: "Hands",
    reports: "Reports",
    report: (name: string) => `Report: ${name}`,
    searching: "Searching…",
    screen: (name: string) => name,
    goTo: "go to open screen",
    hand: (id: string) => `Hand #${id}`,
    handDetail: (room: string, stakes: string, date: string) => `${room} · ${stakes} · ${date}`,
    players: "Players",
    player: (name: string) => `Player: ${name}`,
    playerDetail: (room: string, count: number) => `${room} · ${hands(count)} together`,
    savedFilters: "Saved filters",
    savedFilter: (screen: string, name: string) => `${screen}: ${name}`,
    savedFilterDetail: "Apply the saved filter",
    settings: "Settings",
    section: (name: string) => `Settings: ${name}`,
    sections: {
      account: "Account and sync",
      folders: "Hand-history folders",
      refused: "Refused hands",
      statistics: "Your statistics",
      appearance: "Appearance and language",
      startup: "Startup",
      about: "About",
    },
    commands: "Commands",
    command: {
      pauseImport: "Pause import",
      resumeImport: "Resume import",
      syncNow: "Sync now",
      themeDark: "Use the dark theme",
      themeLight: "Use the light theme",
      themeSystem: "Match the system's theme",
      compact: "Compact lists and tables",
      comfortable: "Comfortable lists and tables",
      language: "Switch to Croatian (Hrvatski)",
      refused: "Show refused hands",
      current: "In use",
    },
    keywords: {
      import: "import watch folders pause resume start",
      sync: "sync upload web send",
      theme: "theme dark light mode appearance colours",
      density: "density compact comfortable rows spacing size",
      language: "language croatian hrvatski english jezik",
      refused: "refused quarantine errors unreadable",
      settings: "settings preferences options",
    },
    hints: {
      move: "move",
      open: "open",
      close: "close",
    },
  },

  /** A10 (R3.8): what the app hides while a poker table is open. */
  duringPlay: {
    hidden: "Hidden while a poker table is open: Rail gives no help during play. It is back when the tables close.",
  },

  /** The HUD popup (R3.8): a click on a player's panel at the table. */
  hudPopup: {
    label: (player: string) => `${player}: the HUD popup`,
    close: "Close (Esc)",
    loading: "Loading…",
    failed: (reason: string) => `Not loaded: ${reason}`,
    none: "Click a player's panel at a table to see their numbers here.",
    you: "You",
    tableAt: (room: string, table: string) => `${room} · ${table}`,
    opaque: "This room hides screen names: these numbers are from this session only, and the seat takes no notes.",
    sample: (count: number) => (count === 1 ? "Over 1 hand" : `Over ${hands(count)}`),
    ownHands: "Hands you played only, as this room's rules ask.",
    together: "Hands together",
    noTogether: "None yet",
    result: "Your result against them",
    resultCash: (bb: string, count: number) => `Cash: ${bb} bb over ${hands(count)}`,
    resultChips: (bb: string, count: number) => `Tournaments: ${bb} bb over ${hands(count)}`,
    stats: "Statistics",
    statsNote: "Past hands only, as on the table. A value fades while its sample is thin; hover it for the sample and its 95% interval.",
    legend: "Colours",
    legendNote: (thresholds: number) =>
      `What each colour means, statistic by statistic: the ${thresholds === 1 ? "threshold" : "thresholds"} in use at this room's tables. On the table: - low, = normal, + high.`,
    tones: {
      "very-low": "very low",
      low: "low",
      normal: "normal",
      high: "high",
      "very-high": "very high",
    },
    below: (value: string) => `below ${value}`,
    from: (value: string) => `from ${value}`,
    range: (low: string, high: string) => `${low} to ${high}`,
    byPosition: "By position",
    byPositionHidden: (room: string) =>
      `Not shown at ${room} tables: the room does not allow a HUD whose display changes with position.`,
    noPosition: "No position",
    note: "Note",
    wordsHidden: (room: string) =>
      `${room} does not allow labelling players at the table, so your notes, colours and labels for them stay in Rail's Players screen.`,
    openInApp: "Open in Rail",
    historical: "Statistics from past hands only: Rail gives no advice and shows nothing about the hand being played.",
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
