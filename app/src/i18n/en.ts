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
import { handsUiEn } from "@rail/ui/strings/hands.en";
import { playersUiEn } from "@rail/ui/strings/players.en";
import { reportsUiEn } from "@rail/ui/strings/reports.en";
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
    analysis: "Analysis",
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
    analysis: {
      title: "Analysis",
      lead: "Your decisions graded after the session: the session review, your top leaks, your own charts.",
    },
    hud: {
      title: "HUD",
      lead: "What the HUD's panels show, at which tables, with a preview.",
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
      /** (R6.4) */
      plan: "Sync needs Rail Pro.",
      details: "Sync settings",
    },
    failedAction: (reason: string) => `That did not work: ${reason}`,
    /** (R6.4) The account's plan does not include desktop sync. */
    planRequired: (waiting: number) =>
      waiting === 0
        ? "Syncing with the web is part of Rail Pro. Your hands stay on this computer."
        : `Syncing with the web is part of Rail Pro. ${hands(waiting)} ${waiting === 1 ? "waits" : "wait"} on this computer, unsent, until your plan includes it.`,
  },

  /**
   * (R6.4) The plan: the lock in place of a Pro feature (the HUD, the
   * analysis, full reports, sync) and its lines in Settings, Account.
   */
  plan: {
    heading: "Part of Rail Pro",
    features: {
      hud: "The HUD at your poker tables is part of Rail Pro.",
      analysis: "The analysis of your hands - grades, leaks, session review and your own charts - is part of Rail Pro.",
      reportsFull:
        "Reports by situation and the Players screen are part of Rail Pro. Your basic statistics stay free: the summary, every statistic, the graph and the breakdowns by position, stake, room, table size and format.",
      desktopSync: "Syncing your hands with the web is part of Rail Pro.",
      learn: "Learn is part of Rail Pro.",
    },
    reasons: {
      signedOut:
        "Sign in with a Rail Pro account to use it. Without an account Rail keeps importing your hands, your library, the replayer and your basic statistics.",
      notChecked: "Rail checks your plan when it is online. Connect to the internet, or check again.",
      free: "Your account is on the Free plan.",
      graceExpired: (days: number) =>
        `Reconnect to keep Pro: Rail has not reached the server to check your plan for more than ${days} days.`,
    },
    signIn: "Sign in",
    upgrade: "Upgrade to Pro",
    checkAgain: "Check again",
    checking: "Checking…",
    settings: {
      heading: "Plan",
      loading: "Reading your plan…",
      open: "Everything in Rail is available.",
      pro: "Rail Pro.",
      proUntil: (date: string) =>
        `Rail Pro. It keeps working offline until ${date}; Rail checks again by itself whenever it is online.`,
      free: "Free: importing, your library, the replayer and basic statistics. The HUD, the analysis and full reports need Rail Pro.",
      handsStored: (count: number, total: number) => `${hands(count)} in your web library of ${n(total)} on the Free plan.`,
      lastChecked: (time: string) => `Plan last checked ${time}.`,
      offline: "The server could not be reached to check; Rail uses the last answer.",
    },
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
    // The list, the filter row and the saved filters: the shared screen's words
    // (R4.5b, `@rail/ui/strings/hands.en.ts`).
    ...handsUiEn,
    unavailable: "Your hands are only available inside the Rail app.",
    empty: "No hands yet. They appear here as Rail imports them from your hand-history folders.",
    rebuilding: (done: number, total: number) =>
      `Updating the hand list after an upgrade: ${n(done)} of ${hands(total)}. The list fills as it goes.`,
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

  /**
   * Players: the shared screen's words (`@rail/ui/strings/players.en.ts`,
   * R4.5c) and the app's own - only in the app, the empty list, the
   * rebuild and indexing lines, where the words are kept.
   */
  players: {
    ...playersUiEn,
    unavailable: "Players are only available inside the Rail app.",
    empty: "No opponents yet. They appear here as Rail imports hands from rooms that show screen names.",
    rebuilding: (done: number, total: number) =>
      `Updating the players after an upgrade: ${n(done)} of ${hands(total)}. The list fills as it goes.`,
    indexing: (count: number) =>
      `Rail is still sorting the opponents of ${count === 1 ? "1 recent hand" : `${n(count)} recent hands`}; until it has, “hands with this player” and the breakdown by position leave ${count === 1 ? "it" : "those hands"} out.`,
    profile: {
      ...playersUiEn.profile,
      localOnly: "Colours, labels and notes stay on this computer for now; they will sync with your player notes on the web later.",
    },
  },

  /** The command palette (Cmd/Ctrl + K; R2.7a: hands by id and the screens). */
  reports: {
    // The summary, the graph's card, the statistics and the breakdowns: the
    // shared screen's words (R4.5c, `@rail/ui/strings/reports.en.ts`).
    ...reportsUiEn,
    unavailable: "Reports are only available inside the Rail app.",
    empty: "No hands yet. Reports fill in as Rail imports your hand histories.",
    rebuilding: (done: number, total: number) =>
      `Updating the statistics after an upgrade: ${n(done)} of ${hands(total)}. The numbers grow as it goes.`,
    graph: {
      ...reportsUiEn.graph,
      notEnough: "Not enough hands yet to draw a curve.",
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

  /** The analysis (R5.4): its screen, the background run's status, a hand's grades. */
  analysis: {
    tabsLabel: "Analysis sections",
    tabs: { session: "Session review", leaks: "Top leaks", charts: "My charts" },
    unavailable: "The analysis is only available inside the Rail app.",
    loading: "Opening the analysis…",
    status: {
      label: "The analysis",
      starting: "The analysis starts shortly after Rail opens.",
      running: (done: number, total: number) => `Analysing your hands: ${n(done)} of ${hands(total)} done.`,
      idle: (total: number) => `Every hand is analysed (${hands(total)}).`,
      empty: "No hands to analyse yet.",
      waiting: {
        paused: "The analysis is paused.",
        tables: "The analysis waits while a poker table is open.",
        backfill: "The analysis waits while your folders are imported.",
        statistics: "The analysis waits for the statistics to be worked out.",
        store: "The hand store did not open.",
        plan: "The analysis is part of Rail Pro.",
      },
      offline: "The flop library cannot be reached: flops are graded without it for now, and those hands are analysed again once it answers.",
      pace: (perSecond: string) => `${perSecond} hands a second`,
      notAnalysable: (count: number) => `${hands(count)} cannot be analysed (another game, or no hero).`,
      error: (message: string) => `The last page did not finish: ${message}`,
      pause: "Pause",
      resume: "Resume",
    },
    session: {
      notAnalysed: "Analysed in the background",
    },
    hand: {
      title: "Hand analysis",
      open: "Analysis",
      openTitle: "Open this hand's decision-by-decision grades",
      back: "Open in Hands",
      backToList: "Back",
      loading: "Analysing the hand…",
      notFound: "This hand is not in your store.",
      notStored: "Analysed now; the background run stores it when it gets there.",
      failed: (message: string) => `The hand could not be analysed: ${message}`,
      notAnalysed: (reason: string) => `Not analysed: ${reason}.`,
      summary: (grade: string, evLoss: string) => `Worst grade ${grade}, ${evLoss} lost in all.`,
      noGrade: "No decision of this hand has a reference to grade it by.",
      decisions: "Your decisions",
      street: "Street",
      action: "You",
      best: "Best",
      grade: "Grade",
      evLoss: "EV lost",
      source: "Graded by",
      ungraded: "Not graded",
      skipped: (reason: string) => `Not analysed (${reason})`,
      options: "What the reference plays here",
      option: "Action",
      frequency: "How often",
      ev: "EV",
      notes: (count: number) => (count === 1 ? "1 note" : `${count} notes`),
      bb: (value: string) => `${value} bb`,
      streets: { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>,
      actions: { fold: "Fold", check: "Check", call: "Call", bet: "Bet", raise: "Raise" } as Record<string, string>,
      grades: { perfect: "Perfect", good: "Good", inaccurate: "Inaccurate", mistake: "Mistake", blunder: "Blunder" } as Record<
        string,
        string
      >,
      sources: {
        chart: "Rail's preflop charts",
        solver: "Rail's solver",
        heuristic: "Checks only",
        multiway: "Multiway checks",
        approx: "Approximate (multiway)",
        icm: "The push/fold game (tournament)",
      } as Record<string, string>,
      /** (R5.5) A tournament push/fold grade: what it was measured in, the stacks, the payouts, the matchups. */
      icm: {
        heading: "Tournament (push/fold)",
        modelIcm: "Prize equity (ICM)",
        modelChips: "Chip EV",
        chipsReasons: {
          "players-left-unknown": "the hand does not say how many players are left",
          "payouts-unknown": "neither the payouts nor the field size are known",
          "far-field": "more than 30 players are left",
        } as Record<string, string>,
        payouts: "Payouts",
        playersLeft: "Players left",
        stacks: "Stacks",
        you: "You",
        equity: "Prize equity",
        equityChips: "Share of the chips",
        option: "Option",
        evBb: "EV (bb)",
        fold: "Fold",
        push: "Push",
        call: "Call",
        player: "Player",
        calls: "Calls",
        bubbleFactor: "Bubble factor",
        riskPremium: "Risk premium",
        pushRange: (who: string, share: string) => `${who} pushes ${share} of hands`,
        sources: { standard: "standard", user: "yours", table: "everyone at this table" } as Record<string, string>,
        edit: "Payouts and players left",
        intro:
          "What the hand history does not say. Leave a field empty to keep the assumption. Saving sends this tournament's hands back to the analysis.",
        kind: "Kind",
        kindAuto: "As the hand reads",
        kinds: { sng: "Sit-and-go", spin: "Spin", mtt: "Multi-table" } as Record<string, string>,
        payoutsField: "Payouts, % per place",
        entrants: "Entrants",
        startingStack: "Starting stack (chips)",
        leftHere: "Players left at this hand",
        save: "Save",
        reset: "Back to the assumptions",
        saved: (count: number) => `Saved. ${count === 1 ? "1 hand goes" : `${count} hands go`} back to the analysis.`,
        cleared: "Your settings are gone; the hands are analysed again on the assumptions.",
        invalid: (code: string) => `Not saved: ${code}.`,
        unavailable: "Settings are kept by the Rail app.",
      },
    },
  },

  /** Compliance mode (R3.10): the HUD at the tables, and why it stays off where a room does not allow it. */
  hudStatus: {
    heading: "At the tables",
    loading: "Reading the HUD's status…",
    failed: (reason: string) => `The HUD's status could not be read: ${reason}`,
    unavailable: "The HUD's status is only available inside the Rail app.",
    off: "The HUD is not running.",
    offWhy: (reason: string) => `The HUD is not running: ${reason}`,
    starting: "The HUD is starting…",
    locked: "The HUD is part of Rail Pro: it does not start on this plan.",
    running: "The HUD is running.",
    noTables: "No table of a room Rail knows is open.",
    attached: (count: number) => (count === 1 ? "On 1 table:" : `On ${n(count)} tables:`),
    attachedLabel: "Tables with the HUD",
    tableAt: (room: string, table: string) => `${room} · ${table}`,
    untitled: "a table with no name in its title",
    waiting: "waiting for the table's first hand",
    refusedHeading: (count: number) => (count === 1 ? "1 table without the HUD" : `${n(count)} tables without the HUD`),
    refusedLabel: "Tables without the HUD",
    why: {
      prohibited: (room: string) => `${room}'s rules do not allow a HUD.`,
      withdrawn: (room: string) =>
        `${room}'s rules no longer allow a HUD: a re-check after this version of Rail was released switched it off.`,
      unknown: (room: string) => `${room}'s rules on HUDs are not established, and Rail treats unknown as no.`,
      notARoom: (room: string) =>
        `${room} is a network of rooms, not one room: each room's own rules decide, and none has been confirmed.`,
      unknownSite: "This window does not belong to a room Rail knows.",
    },
    policyLink: "Room's policy",
    policyPage: (room: string) => `The policy of ${room}, on its own site`,
    checked: (date: string) => `checked ${date}`,
    noOverride: "There is no switch to turn the HUD on here, by design: Rail only draws at tables whose room allows it.",
    explainSummary: "Why can't I enable the HUD here?",
    explain1:
      "Many poker rooms forbid HUDs or set rules for them, and breaking those rules can cost you your account. So Rail's HUD attaches to a table only when the room's own rules allow it: compliance mode, always on.",
    explain2:
      "For every room Rail keeps the rule it read on the room's own pages, the address of that page and the date it was read. A room whose rules forbid a HUD, or whose rules are not clear, gets no HUD: unknown counts as no.",
    explain3:
      "The list is checked again before every release, and between releases Rail picks up a corrected list from the web. An update can only switch a room off or add a restriction, never switch one on: that takes a new version of Rail.",
    explain4:
      "Statistics, reports and your hands work at every room either way. If a room's rules say otherwise than Rail does, tell us with a link to them.",
    roomsHeading: "Where the HUD may be used",
    allowedLead: "Allowed, within each room's rules:",
    notAllowedLead: (count: number) =>
      `Not allowed at ${count === 1 ? "1 room" : `${n(count)} rooms`}: forbidden, or the rules are not established`,
    noneAllowed: "No room: the list allows none.",
    listShipped: "Room list: the one this version of Rail came with.",
    listRemote: (date: string) => `Room list: updated from the web on ${date}. Updates can only make it stricter.`,
    lastUpdated: (time: string) => `Looked for an update ${time}: a newer list is in force.`,
    lastCurrent: (time: string) => `Looked for an update ${time}: none newer.`,
    lastRefused: (time: string) => `Looked for an update ${time}: the file was not valid and was not used; the list in force stays.`,
    lastFailed: (time: string) => `Looked for an update ${time}: not reached; the list in force stays.`,
    checkNow: "Look for an update now",
    checking: "Looking…",
    notes: "Not taken from the update, because it would have loosened the rules:",
    /** (R3.11) macOS: the Accessibility permission, which the HUD needs to see tables. */
    permission: {
      heading: "Rail needs the Accessibility permission to see your tables",
      why: "On a Mac, Rail's HUD finds a poker table by its window's title, and macOS lets an app read other apps' window titles only with the Accessibility permission. Rail reads the titles and where the windows are: nothing else.",
      not: "Rail does not record your screen, read what you type or click, or control other apps. It does not need Screen Recording or Input Monitoring.",
      steps:
        "Click the button: macOS asks about Rail and System Settings opens at Privacy & Security, Accessibility. Switch Rail on there. This screen notices by itself.",
      open: "Open System Settings",
      opening: "Opening…",
      waiting: "Waiting for the permission. Rail checks every few seconds.",
      failed: (reason: string) =>
        `System Settings did not open (${reason}). Open it yourself: Privacy & Security, Accessibility.`,
      stale:
        "Rail is already switched on in the list and this does not go away? Remove Rail from the list with the minus button and switch it on again: macOS can keep the permission for an older copy of Rail.",
      granted: "Accessibility permission granted: the HUD can see your tables.",
      noClient: "HUD on macOS: no supported poker client running.",
    },
    today: {
      off: "HUD: not running",
      starting: "HUD: starting…",
      locked: "HUD: needs Rail Pro",
      none: "HUD: no table open",
      permission: "HUD: needs the Accessibility permission",
      noClient: "HUD on macOS: no supported poker client running",
      tables: (count: number) => (count === 1 ? "HUD: on 1 table" : `HUD: on ${n(count)} tables`),
      refused: (count: number, rooms: string) =>
        `${count === 1 ? "1 table" : `${n(count)} tables`} without it (${rooms}: not allowed)`,
      details: "HUD details",
    },
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

  /** The HUD editor (R3.9): designs, presets, where each is used, a preview. */
  hudEditor: {
    loading: "Loading the HUD's designs…",
    failed: (reason: string) => `The HUD's designs could not be read: ${reason}`,
    designs: "Designs",
    designPicker: "Design to edit",
    presetsGroup: "Presets",
    yoursGroup: "Your designs",
    presetName: (name: string) => `${name} (preset)`,
    newFrom: "New design from",
    create: "Create",
    copyOf: (name: string) => `${name}, my copy`,
    name: "Name",
    format: "Made for",
    formats: { cash: "Cash", mtt: "Tournament", spin: "Spin" },
    presetReadOnly: "A preset cannot be changed: make your own copy to edit it.",
    makeCopy: "Make my copy",
    save: "Save",
    saving: "Saving…",
    saved: "Saved. The HUD draws it at once.",
    notSaved: "Not saved:",
    unsaved: "Unsaved changes",
    discard: "Discard changes",
    resetToPreset: (name: string) => `Reset to ${name}`,
    delete: "Delete design",
    deleteConfirm: (name: string) => `Delete ${name}? Tables it was used on go back to their preset.`,
    deleteYes: "Delete",
    cancel: "Cancel",
    deleted: "Deleted.",

    panel: "Panel",
    panelHint:
      "Drag a statistic from the list onto the panel, or press Add on it. Drag a cell to move it. With a cell focused: Alt+Left and Alt+Right move it, Delete removes it.",
    cellsLabel: "The panel's cells",
    cellsHeading: "Cells",
    cellLabel: (label: string, index: number) => `${label}, cell ${index}`,
    cellWhen: "by stack",
    dropHere: "Drop here",
    emptyPanel: "Drop a statistic here to start the panel.",
    columns: "Cells in a row",
    thresholds: "Colour by",
    thresholdsAll: "Every band of the definition",
    thresholdsN: (n: number) =>
      n === 0 ? "No colour" : n === 1 ? "1 threshold (low, normal)" : `At most ${n} thresholds`,
    legend: "Show the colour legend on the table",
    labels: "Show my colour tags, labels and note marks",
    labelsHint: "Where the room allows it: Winamax. Never on PokerStars or ACR, which forbid labelling players.",
    announceAdded: (label: string, index: number) => `${label} added as cell ${index}.`,
    announceMoved: (label: string, index: number) => `${label} moved to cell ${index}.`,
    announceRemoved: (label: string) => `${label} removed from the panel.`,
    full: (max: number) => `The panel holds at most ${max} cells.`,

    palette: "Statistics",
    paletteSearch: "Find a statistic",
    paletteHint: "Yours are marked; one that reads the cards is marked too: PokerStars does not allow it.",
    add: "Add",
    addNamed: (label: string) => `Add ${label} to the panel`,
    onPanel: "on the panel",
    yours: "yours",
    cards: "reads the cards",
    noMatch: "No statistic matches.",

    cell: "Cell",
    cellNone: "Pick a cell of the panel to change how it shows.",
    moveEarlier: "Move earlier",
    moveLater: "Move later",
    remove: "Remove from the panel",
    decimals: "Decimals",
    minSample: "Full colour from a sample of",
    asDefinition: (value: string) => `As the definition (${value})`,
    bands: "Colour bands",
    bandsOwn: "Use my own bands",
    bandsHint: "Values below each limit take its colour; the last band holds the rest. Limits go up.",
    bandBelow: (n: number) => `Band ${n}: below`,
    bandTone: (n: number) => `Band ${n}: colour`,
    removeBand: (n: number) => `Remove band ${n}`,
    addBand: "Add a band",
    tones: {
      "very-low": "Very low",
      low: "Low",
      normal: "Normal",
      high: "High",
      "very-high": "Very high",
    },
    stackLegend: "Stack depth",
    stack: "Show only at some stack depths",
    stackHint: "The panel then changes with the stack: PokerStars and Winamax do not allow that, ACR does.",
    stackBelow: "Below (big blinds)",
    stackAtLeast: "From (big blinds)",

    popup: "Popup",
    popupHint: "What a click on a panel shows, section by section.",
    section: (n: number) => `Section ${n}`,
    sectionTitle: "Title",
    sectionTitleDefault: "The group's name",
    addSection: "Add a section",
    removeSection: (n: number) => `Remove section ${n}`,
    addToSection: "Add a statistic",
    removeFromSection: (label: string) => `Remove ${label}`,
    moveUp: (label: string) => `Move ${label} up`,
    popupShipped: "The popup lists Rail's statistics; yours are on the panel.",

    preview: "Preview",
    previewHint: "Made-up players and numbers, laid out exactly as the HUD draws this design at this room's tables.",
    room: "Room",
    seats: "Seats",
    seatsN: (n: number) => (n === 2 ? "Heads-up" : `${n}-max`),
    previewFailed: (reason: string) => `No preview: ${reason}`,
    previewLabel: (room: string, seats: string) => `The design at a ${seats} ${room} table`,
    stackBb: (bb: number) => `${bb} bb`,
    dragged: (count: number) =>
      count === 1 ? "1 panel is where you dragged it at this table size." : `${count} panels are where you dragged them at this table size.`,
    resetDragged: "Put dragged panels back",
    resetDone: (count: number) => (count === 1 ? "1 panel is back in place." : `${count} panels are back in place.`),
    preferredSeat: "My client seats me at the bottom",
    preferredSeatAuto: "As the room's settings say",
    preferredSeatYes: "Yes, it turns the table",
    preferredSeatNo: "No, seats stay numbered",

    rooms: "Where it may be used",
    roomOk: (room: string) => `${room}: may be used.`,
    roomRefused: (room: string) => `${room}: may not be used -`,
    roomNotes: (room: string) => `${room}: may be used; there -`,

    assignments: "Which design each table gets",
    assignmentsHint:
      "Pick a design for a room and game, for every table size or one. The most specific choice wins: the room, then the game, then the size; nothing chosen is the game's preset.",
    allRooms: "Every room",
    sizeFilter: "Table size",
    allSizes: "Every size",
    assignTo: (room: string, format: string, size: string) => `Design for ${format} at ${room}, ${size}`,
    inherit: (name: string) => `Default: ${name}`,
    allFormats: "Every game",
    notSet: "Not set",
    assignedHere: "chosen here",
    assignRefused: (room: string) => `Not for ${room}:`,
    assignedProblems: (room: string) => `At ${room} the HUD leaves out:`,

    problems: {
      version: "This design was made by a newer Rail.",
      nameTooLong: "The name is too long.",
      noCells: "The panel needs at least one statistic.",
      tooManyCells: "The panel has too many cells.",
      columns: "Pick between 1 and 6 cells in a row.",
      tooManyPopup: "The popup has too many sections or statistics.",
      titleTooLong: "A section's title is too long.",
      labels: "your colour tags, labels and notes (the room forbids labelling players)",
      roomNotAllowed: "The room does not allow a HUD.",
      unknownStat: (stat: string) => `${stat} is not a statistic any more.`,
      duplicateStat: (stat: string) => `${stat} is on the panel twice.`,
      heroOnlyStat: (stat: string) => `${stat} is about your own hands only; a panel shows every player.`,
      moneyStat: (stat: string) => `${stat} is money: an opponent's money is never shown.`,
      badWhen: (stat: string) => `${stat}: the stack range is empty.`,
      badBands: (stat: string) => `${stat}: the band limits must go up, and the last band has none.`,
      badDecimals: (stat: string) => `${stat}: at most 2 decimals.`,
      badSample: (stat: string) => `${stat}: the sample is too large.`,
      cardSplit: (stat: string) => `${stat} reads the cards (the room forbids statistics split by the cards)`,
      gameStateSwitching: (stat: string) => `${stat} shows by stack depth (the room forbids a display that changes with the stack)`,
      colourThresholds: (stat: string, count: number, max: number) =>
        `${stat} is coloured by ${count} thresholds (the room allows ${max})`,
    },
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
    hudOff: "HUD off",
    hudStarting: "HUD starting…",
    hudTables: (attached: number, refused: number) =>
      `${attached === 0 ? "HUD: no table open" : attached === 1 ? "HUD: 1 table" : `HUD: ${attached} tables`}${
        refused === 0 ? "" : ` · ${refused} not allowed`
      }`,
    quit: "Quit Rail",
  },
} as const;
