/**
 * Strings for the converter components, English. Spread into `en.ts` as `converter`;
 * `converter.hr.ts` is the same shape. See the header of `en.ts`.
 *
 * Covers the upload screen (single-hand paste box, batch drop zone, results,
 * failures, preview) and the hand-history library (list, filters, pager).
 *
 * Parser failure *messages* are not here: they come from `lib/parsers` /
 * `lib/phf` and stay in English. The reason *codes* the failure panel maps to
 * human sentences are (`failures.reasons`).
 */

const num = (value: number) => value.toLocaleString("en-GB");
const hands = (count: number) => (count === 1 ? "hand" : "hands");

export const converterEn = {
  /** `upload/UploadTab` and `upload/SingleHandPanel`. */
  upload: {
    or: "or",
    pastePlaceholder: "Paste a hand here",
    reading: "Reading…",
    replayIt: "Replay it",
    chooseFile: "Choose a file",
    notRecognised: "That is not a hand history we recognise.",
    couldNotRead: "That could not be read.",
    fileCouldNotRead: "That file could not be read.",
    manyFound: (count: number) =>
      `${num(count)} ${hands(count)} found — showing the first. Use the upload box below to convert them all.`,
  },

  /** Saving one loaded hand, from the paste box or from the library viewer. */
  save: {
    signInReason: "Sign in to keep this hand. Only you will see it.",
    alreadySaved: "Already in your library.",
    saved: "Saved to your library.",
    failed: "Saving failed.",
    button: "Save to my library",
    saving: "Saving…",
  },

  /** `converter/DropZone`. */
  drop: {
    veil: "Drop anywhere to convert",
    title: "Drop files or a whole export folder",
    chooseFiles: "Choose files",
    chooseFolder: "Choose a folder",
    moreSites: (listed: string, more: number) => `${listed} and ${num(more)} more`,
  },

  /** `ConverterTab`: the batch controls, the progress card and its notices. */
  batch: {
    unknownFormat: "Format we do not know yet",
    readFailed: "Those files could not be read.",
    pastedText: "Pasted text",
    pastedTextNumbered: (index: number) => `Pasted text ${index}`,
    autoSave: "Save to my library",
    autoSaveUnavailable: "Unavailable in this build.",
    autoSaveSignedOut: "Convert now, sign in after.",
    startOver: "Start over",
    dbNotConfigured:
      "Database is not connected. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to enable saving, browsing and sharing hands. Conversion and download work without it.",
    held: (count: number) =>
      `${num(count)} ${hands(count)} converted. Sign in to keep ${count === 1 ? "it" : "them"}.`,
    heldSignInReason: (count: number) =>
      `Sign in to save ${num(count)} converted ${hands(count)} to your library.`,
    signInAndSave: "Sign in and save",
    notNow: "Not now",
    readingFiles: "Reading your files…",
    convertingFile: (name: string) => `Converting ${name}`,
    converting: "Converting…",
    stop: "Stop",
    /** `files` is the number of runnable files; `fileIndex` is 1-based. */
    progressDetail: (handsDone: number, files: number, fileIndex: number, percent: number) =>
      `${num(handsDone)} ${hands(handsDone)} converted${
        files > 1 ? ` · file ${num(fileIndex)} of ${num(files)}` : ` · ${percent}%`
      }`,
    noWorker:
      "This browser would not start a background worker, so conversion ran on the page itself. Large files may have felt slow.",
    workerStopped: "The conversion worker stopped unexpectedly.",
  },

  /** Why a file never reached the converter (`converter/inputs`). */
  problems: {
    empty: "The file is empty.",
    noText: "The file has no text in it.",
    binary: "This looks like a binary file, not a hand history. Check you picked the right file.",
    notZip: "This is not a readable zip archive.",
    encryptedEntry: "Encrypted zip entries are not supported.",
    zip64: "Zip64 archives are not supported. Unzip it and drop the files in.",
    cannotUnzip: "This browser cannot unzip files. Unzip it yourself and drop the .txt files in.",
    unreadableEntry: "Could not read this archive entry.",
    emptyArchive: "The archive has no files in it.",
    tooLarge: (size: string) => `That file is ${size}. Hand histories are not that big — this one is skipped.`,
    unreadableFile: "Could not read this file.",
    nothingPasted: "There was nothing in the box.",
  },

  /** `converter/ResultsPanel`. */
  results: {
    heading: (count: number, stopped: boolean) =>
      `${num(count)} ${hands(count)} converted${stopped ? " so far" : ""}`,
    savingOffBuild: "Saving is off in this build — download the file to keep your hands.",
    savingSwitchedOff: "Saving is switched off. Your hands stay in this tab only.",
    savingProgress: (done: number, total: number) => `Saving to your library… ${num(done)} of ${num(total)}`,
    savedLine: (inserted: number, duplicates: number) =>
      `${num(inserted)} saved to your library${duplicates ? `, ${num(duplicates)} already there` : ""}.`,
    saveError: "Some hands could not be saved. Your converted file is still complete.",
    downloadAll: "Download all",
    /** Name of the combined download; `stamp` is the local date, YYYY-MM-DD. */
    downloadAllName: (stamp: string, count: number) => `pokerconverter ${stamp} - ${count} ${hands(count)}.txt`,
    /** Suffix of a per-file download: "session - converted.txt". */
    fileSuffix: "converted",
    /** Stem when the source name has nothing usable left in it. */
    fileStemFallback: "hands",
    writeRefused: "The database refused the write.",
    retrySave: "Try saving again",
    statHands: (count: number) => hands(count),
    statFiles: (total: number) => `of ${num(total)} ${total === 1 ? "file" : "files"}`,
    statSaved: "saved",
    statDuplicates: "already in your library",
    statFailed: "not converted",
    sitesDetected: "Sites detected",
    handsChip: (count: number) => `${num(count)} ${hands(count)}`,
    skippedChip: (count: number) => `${num(count)} skipped`,
    stopped: "stopped",
    download: "Download",
    detail: "Detail",
    hideDetail: "Hide detail",
    moreFailures: (count: number) => `${num(count)} more — see the panel below.`,
    convertedHands: "Converted hands",
    showMore: (left: number) => `Show more — ${num(left)} left`,
    players: (count: number) => `${num(count)} ${count === 1 ? "player" : "players"}`,
    pot: (amount: string) => `pot ${amount}`,
    preview: "Preview",
    replay: "Replay",
  },

  /** `converter/FailurePanel`. */
  failures: {
    heading: (count: number, refusedOnly: boolean) =>
      `${num(count)} ${hands(count)} we could not convert${refusedOnly ? "" : " yet"}`,
    downloadForCopy: "Download them below for your own copy.",
    notKeptNoDb: "Nothing left your browser — this build has no database.",
    notKeptSavingOff: "Nothing left your browser; saving is switched off.",
    keeping: "Keeping a copy so we can write a converter…",
    /**
     * What we did with the samples. Re-uploading the same unsupported file is
     * the common case, so "0 new" has to read as the non-event it is.
     */
    kept: (created: number, updated: number) => {
      if (created > 0 && updated > 0) {
        return `We kept ${num(created)} new ${hands(created)} and already had ${num(updated)}. They are the queue we write the next converters from.`;
      }
      if (created > 0) {
        return `We kept ${num(created)} new ${hands(created)}. They are the queue we write the next converters from.`;
      }
      if (updated > 0) {
        return `We already had ${updated === 1 ? "this one" : `all ${num(updated)} of these`} — your upload moved ${updated === 1 ? "it" : "them"} up the queue.`;
      }
      return "We could not keep a copy of these, so download them if you want us to see them.";
    },
    notSupported: "Not supported",
    showHand: "Show hand",
    hideHand: "Hide hand",
    copied: "Copied",
    copySample: "Copy sample",
    downloadCount: (count: number) => `Download ${num(count)}`,
    moreLikeThis: (count: number) => `${num(count)} more like this — download the group to see them all.`,
    /** Download name for one group; unsafe characters are replaced afterwards. */
    fileName: (site: string, reason: string) => `unconverted - ${site} - ${reason}.txt`,
    /** Rooms we have decided not to support, keyed by the panel's refusal id. */
    refusals: {
      "wpt-global":
        "This is a WPT Global hand. WPT Global removed hand-history export from its client in June 2026, so files like this one can no longer be produced and we are not adding a converter for them. Your file still downloads below.",
      pppoker:
        "This is a PPPoker hand. PPPoker has no hand-history export — whatever produced this file is not the client, so we cannot convert it reliably and are not adding a converter for it.",
    },
    /** What we are going to do about a failure, by pipeline stage. */
    stages: {
      detect: "Unsupported format",
      split: "Could not be split into hands",
      parse: "Could not be read",
      validate: "Did not pass our checks",
      serialize: "Could not be written out",
    },
    /**
     * A parser / validator reason code, for the person who uploaded the file.
     * Unknown codes fall back to the parser's own (English) message.
     */
    reasons: {
      "unknown-site": "We do not recognise this hand history format yet.",
      "no-hands": "We recognised the format but found no complete hands in the text.",
      "split-failed": "We could not split this file into individual hands.",
      "parser-error": "Our converter hit something it did not expect in this hand.",
      "tournament-in-cash-mode": "Tournament hand, skipped because the converter was set to cash games only.",
      "bomb-pot": "Bomb pot, skipped by request.",
      "chip-mismatch": "The chips in this hand do not add up, so converting it would give you wrong numbers.",
      "duplicate-card": "The same card appears twice in this hand.",
      "bb-only-walk": "Everyone folded to the big blind, so there is no hand to replay.",
      "uncalled-exceeds-commitment": "The returned uncalled bet is larger than what was actually bet.",
      "normalized-unparseable": "The hand cleaned up correctly but our reader still could not make sense of it.",
      "invalid-hand": "The converted hand failed our consistency checks.",
    },
  },

  /** `converter/HandPreview`. */
  preview: {
    dialogLabel: (handId: string) => `Hand ${handId}`,
    heading: (handId: string) => `Hand #${handId}`,
    close: "Close",
    openInReplayer: "Open in replayer",
    copied: "Copied",
    copyText: "Copy text",
    download: "Download",
    fileName: (handId: string) => `hand-${handId}.txt`,
  },

  /** `ReplayerTab`: the hand-history screen around the list. */
  library: {
    heading: "Hand history",
    noDatabase: "No database configured.",
    privateToAccount: "Private to your account.",
    count: (count: number) => `${num(count)} ${hands(count)}`,
    loadFailed: "Could not load hands.",
    parseFailed: "This hand could not be parsed.",
    loadHandFailed: "Could not load this hand.",
    fromConverter: "From the converter — not saved to your library.",
    signInPrompt: "Sign in to see the hands you have saved.",
    signInReason: "Sign in to open your hand library.",
    signIn: "Sign in",
    previous: "← Previous",
    next: "Next →",
    page: (page: number, pages: number) => `Page ${num(page)} of ${num(pages)}`,
  },

  /** `HandList`. */
  list: {
    loading: "Loading hands…",
    empty:
      "No hands match these filters. Convert your hand histories on the Converter tab, or upload a single hand above.",
    columns: {
      time: "Time",
      hero: "Hero",
      board: "Board",
      stakes: "Stakes",
      pot: "Pot",
      heroNet: "Hero P/L",
    },
    standardFormat: "Standard format",
    preflop: "preflop",
    anon: "ANON",
    anonTitle:
      "This room labels every seat by its position rather than naming the player, so the name filter cannot find this hand. Filter by position instead.",
    showdown: "SD",
    replay: "Replay",
  },

  /** `HandFiltersBar`. Position labels (UTG, BTN…) stay as poker writes them. */
  filters: {
    title: "Filters",
    activeCount: (count: number) => `${num(count)} active`,
    board: "Board",
    boardPlaceholder: "e.g. Ah Kd 2c  or  AhKd",
    boardMatches: "Hands whose board contains",
    boardHint: "Every card you enter must appear on the board",
    heroCards: "Hero hole cards",
    heroCardsPlaceholder: "e.g. AhKs  or  AKs  or  TT",
    handClass: (classes: string) => `Hand class: ${classes}`,
    exactly: "Exactly",
    heroCardsHint: "Exact cards (AhKs) or a hand class (AKs, AKo, AK, TT)",
    search: "Search",
    searching: "Searching…",
    reset: "Reset",
    moreFilters: "More filters",
    fewerFilters: "Fewer filters",
    quick: "Quick:",
    showdownOnly: "Showdown only",
    heroWon: "Hero in profit",
    biggestPots: "Biggest pots",
    heroPosition: "Hero position",
    winnerPosition: "Winner position",
    winnerHint:
      "Who took the pot, by seat. This is the only way to ask that question of a room that does not give you names.",
    clear: "Clear",
    player: "Player at the table",
    playerPlaceholder: "exact screen name",
    playerHint: "Exact screen name, as the room wrote it.",
    playerHintLossy: (count: number) =>
      `Exact screen name. ${num(count)} ${hands(count)} from rooms that label seats by position cannot match it.`,
    site: "Site",
    everyRoom: "Every room",
    siteOption: (name: string, count: number) => `${name} (${num(count)})`,
    game: "Game",
    gameAny: "Cash and tournament",
    gameCash: "Cash only",
    gameTournament: "Tournament only",
    table: "Table",
    tablePlaceholder: "e.g. NLHPurple",
    minPot: "Min pot",
    minPotChips: "In chips",
    minPotCurrency: "In the table currency",
    from: "From",
    to: "To",
    sortBy: "Sort by",
    sort: {
      played_desc: "Newest first",
      played_asc: "Oldest first",
      pot_desc: "Biggest pot",
      profit_desc: "Hero's biggest win",
      profit_asc: "Hero's biggest loss",
    },
    excluded: (count: number) => `${num(count)} ${hands(count)} ${count === 1 ? "is" : "are"} excluded by the name filter.`,
    positionalNote:
      "This room labels every seat by its position relative to the button, and the button moves every hand, so villain names are not people. Filter by position instead.",
  },
} as const;
