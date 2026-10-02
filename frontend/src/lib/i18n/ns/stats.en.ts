/**
 * Strings for the stats components, English. Spread into `en.ts` as `stats`;
 * `stats.hr.ts` is the same shape. See the header of `en.ts`.
 *
 * Stat abbreviations (VPIP, PFR, 3-bet, WTSD, bb/100…) are the same in every
 * language; they live here anyway so a label and its hint stay together.
 * Functions that take a count format it themselves, so the number and the
 * noun it governs are decided in one place.
 */

const num = (value: number) => value.toLocaleString("en-GB");
const hands = (count: number) => `${num(count)} ${count === 1 ? "hand" : "hands"}`;

export const statsEn = {
  common: {
    /** "1,234 hands". */
    hands,
    /** Column and field heading. */
    handsHead: "Hands",
    result: "Result",
    bb100: "bb/100",
    /** An amount already formatted, in big blinds: "+12.5 bb". */
    bb: (amount: string) => `${amount} bb`,
    winRate: "Win rate",
    tryAgain: "Try again",
    unknownStakes: "Unknown stakes",
  },

  /** Column headings and their tooltips, shared by the breakdown and opponents tables. */
  columns: {
    vpip: { head: "VPIP", title: "Voluntarily put money in pot" },
    pfr: { head: "PFR", title: "Preflop raise" },
    rfi: { head: "RFI", title: "Raised first in" },
    threeBet: { head: "3-bet", title: "3-bet facing one raise" },
    foldToThreeBet: { head: "F3B", title: "Fold to 3-bet after opening" },
    steal: { head: "Steal", title: "Steal attempt from CO, BTN or SB" },
    cbet: { head: "Cbet", title: "Flop continuation bet" },
    foldToCbet: { head: "FvCb", title: "Fold to a flop continuation bet" },
    af: { head: "AF", title: "Postflop (bets + raises) / calls" },
    wtsd: { head: "WTSD", title: "Went to showdown, having seen a flop" },
    wsd: { head: "W$SD", title: "Won money at showdown" },
  },

  tab: {
    heading: "Statistics",
    /** Next to the heading: "1,234 hands · v3". */
    sample: (count: number, version: string) => `${hands(count)} · ${version}`,
    signInHeading: "Sign in to see your statistics",
    signInBody:
      "Statistics are derived from the hands in your library, so they need an account to belong to. Converting, previewing and downloading never do.",
    signIn: "Sign in",
    notInstalledHeading: "Statistics are not set up on this database yet",
    /** Three pieces around two `<code>` spans: the table name, then the migration file. */
    notInstalledBody: {
      beforeTable: "Your hands are safe — this screen reads a separate table, ",
      beforeFile: ", which arrives with its own migration. Apply ",
      afterFile:
        " and reload. Nothing else on Rail is affected: uploading, browsing, replaying and sharing all work without it.",
    },
    loading: "Reading your hands…",
    emptyHeading: "No hands with statistics yet",
    emptyBody:
      "Statistics are derived from the hands in your library, on the server, as they are saved. Upload a hand history and this screen fills in.",
    winRateNote:
      "Cumulative big blinds, bucketed by hand count rather than by date — a break between sessions is not worth any of the x-axis.",
  },

  coverage: {
    /** `target` is 0 when the size of the job is not known. */
    running: (done: number, target: number) =>
      target > 0 ? `Updating statistics… ${num(done)} of ${hands(target)}` : `Updating statistics… ${hands(done)}`,
    failedRebuild: (message: string) => `Statistics could not be brought up to date: ${message}`,
    behind: (behind: number, total: number) => `${num(behind)} of ${hands(total)} are not in these numbers yet.`,
    unreadable: (count: number) => `${num(count)} could not be read — that is a converter bug, not your file.`,
    rebuild: "Rebuild statistics",
  },

  scope: {
    ariaLabel: "Which hands",
    allFormats: "All formats",
    formats: {
      cash: "Cash games",
      tournament: "Tournaments",
      "sit-and-go": "Sit & Go",
      spin: "Spins",
    },
    stakes: "Stakes",
    allStakes: "All stakes",
    /** One entry in the stakes picker: "$0.25/$0.50 · 1,234 hands". */
    stakeOption: (stake: string, count: number) => `${stake} · ${hands(count)}`,
  },

  tile: {
    confidence: {
      firm: "Tight sample — this number is stable.",
      loose: "Moderate sample — the shape is real, the decimal is not.",
      noise: "Small sample — read this as a hint, not a measurement.",
    },
    noOpportunities: "no opportunities",
    /** Bounds already formatted, without the percent sign. */
    interval: (low: string, high: string) => `95% confidence interval ${low}% to ${high}%`,
    noSample: "no sample",
  },

  hud: {
    mixedUnitKind:
      "This sample mixes tournament chips with cash. Chips are not money — their value is the payout structure — so there is no total to show. Filter to one game format.",
    noMoney: "No money figure for this sample.",
    provisional: (count: number, floor: number) =>
      `${hands(count)}. A win rate does not settle down until somewhere past ${num(floor)}, so read this as a direction rather than a number.`,
    currency: "Currency",
    inMoney: "In money",
    mixed: "mixed",
    mixedCurrency:
      "This sample spans more than one currency, so the cash total is withheld — adding dollars to euros gives a number with no unit. The big-blind figures above are unaffected: a big blind is a unit of the game, not of a currency, which is exactly what it is stored in.",
    preflop: "Preflop",
    postflop: "Postflop",
    showdown: "Showdown",
    /** Around an emphasised word. */
    postflopNote: {
      before: "The continuation-bet chain follows PokerTracker’s rule: a turn cbet counts only when the flop cbet was ",
      emphasis: "called",
      after: ", which is the definition that answers “do I barrel”.",
    },
    aggressionFactor: "Aggression factor",
    aggressionFrequency: "Aggression frequency",
    tiles: {
      vpip: { label: "VPIP", hint: "Money in voluntarily" },
      pfr: { label: "PFR", hint: "Raised preflop" },
      rfi: { label: "RFI", hint: "Opened an unopened pot" },
      threeBet: { label: "3-bet", hint: "Facing one raise" },
      foldToThreeBet: { label: "Fold to 3-bet", hint: "After opening" },
      fourBet: { label: "4-bet", hint: "Facing two raises" },
      squeeze: { label: "Squeeze", hint: "Raise over a raise and a caller" },
      coldCall: { label: "Cold call", hint: "Call a raise, no money in" },
      steal: { label: "Steal", hint: "CO / BTN / SB, folded to you" },
      foldToSteal: { label: "Fold to steal", hint: "In a blind, facing a steal" },
      cbetFlop: { label: "Cbet flop", hint: "As the preflop raiser" },
      cbetTurn: { label: "Cbet turn", hint: "After the flop cbet was called" },
      cbetRiver: { label: "Cbet river", hint: "Third barrel" },
      foldToCbet: { label: "Fold to cbet", hint: "On the flop" },
      raiseCbet: { label: "Raise cbet", hint: "On the flop" },
      donkBet: { label: "Donk bet", hint: "Into the previous aggressor" },
      checkRaise: { label: "Check-raise", hint: "On the flop" },
      sawFlop: { label: "Saw flop", hint: "Of all hands dealt" },
      wwsf: { label: "WWSF", hint: "Won when saw flop" },
      wtsd: { label: "WTSD", hint: "Went to showdown, having seen a flop" },
      wsd: { label: "W$SD", hint: "Won at showdown" },
    },
  },

  breakdown: {
    heading: "Breakdown",
    splitBy: "Split by",
    /** `label` is the button, `head` the first column's heading. */
    groups: {
      position: { label: "Position", head: "Position" },
      table_size: { label: "Table size", head: "Players" },
      stack_bb: { label: "Stack depth", head: "Stack (bb)" },
      stakes: { label: "Stakes", head: "Stakes" },
      site: { label: "Room", head: "Room" },
    },
    bb100Title: "Big blinds won per 100 hands",
    unknown: "Unknown",
    headsUp: "Heads-up",
    handed: (players: string) => `${players}-handed`,
    /** Tooltip on a bb/100 cell; `net` is already formatted. */
    moneyTitle: (net: string, count: number) => `${net} bb over ${hands(count)}`,
    opportunities: (count: number) => `${num(count)} ${count === 1 ? "opportunity" : "opportunities"}`,
    note: (thin: number) =>
      `Grey numbers rest on fewer than ${thin} opportunities, and a dotted win rate on fewer than 100 hands — a direction, not a reading.`,
  },

  matrix: {
    heading: "Starting hands",
    colourBy: "Colour by",
    metrics: {
      bb100: "Win rate",
      vpip: "VPIP",
      pfr: "PFR",
      hands: "Dealt",
    },
    position: "Position",
    everySeat: "Every seat",
    gridLabel: "Starting hands, thirteen by thirteen",
    /** A cell's accessible name; `count` is null for a class never dealt. */
    cellLabel: (handClass: string, count: number | null) =>
      `${handClass}: ${count === null ? "never dealt" : hands(count)}`,
    /** Amounts already formatted. */
    detailMoney: (net: string, bb100: string) => `${net} bb (${bb100} bb/100)`,
    neverDealt: "never dealt in this sample",
    hint: {
      bb100: "Win rate per hand, in bb per hand played. Pale cells are thin samples, not small results.",
      hands: "How often each hand was dealt, per combination — a flat grid is a fair deck.",
      played: "How often you played each hand. Select a cell for the numbers.",
    },
  },

  sessions: {
    heading: "Sessions",
    breakLongerThan: "A break longer than",
    gap: (minutes: number) =>
      minutes < 60 ? `${minutes} minutes` : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`,
    /** Followed by the total, in bold. */
    bankrollCaption: (sessions: number) => `Bankroll over ${num(sessions)} sessions:`,
    bankrollAria: (amount: string, sessions: number) => `Bankroll, ${amount} over ${sessions} sessions`,
    session: "Session",
    length: "Length",
    tables: "Tables",
    duration: (minutes: number) =>
      minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`,
    showLatest: "Show the latest only",
    showAll: (sessions: number) => `Show all ${num(sessions)} sessions`,
  },

  opponents: {
    heading: "Opponents",
    offBody:
      "A HUD on every regular you have played, and what you win or lose against each. It stores a row per opponent per hand — roughly six times the space your own statistics take — so it is off until you turn it on. Turning it off later deletes those rows; your hands and your own numbers are untouched either way.",
    turnOn: "Turn on opponent statistics",
    storageRefused: "This browser would not save the setting (private mode?).",
    reading: "Reading opponents from your hands…",
    removing: "Removing opponent statistics…",
    findPlayer: "Find a player",
    screenName: "Screen name",
    atLeast: "At least",
    anySample: "any sample",
    player: "Player",
    youVsThem: { head: "You vs them", title: "Your result in the hands they were dealt into" },
    addNote: "Add a private note",
    noteButton: "+ note",
    overHands: (count: number) => `over ${hands(count)}`,
    nobodyByThatName: "Nobody by that name in this scope.",
    noOpponents: "No opponents in this scope yet.",
    opaque: (count: number) =>
      `${num(count)} opponent-hands from rooms that hide names between sessions (GGPoker) are not listed — the same tag in two sessions may be two people.`,
    positional: "Rooms that label seats by position (Ignition) never record opponents.",
    turnOff: "Turn off and delete opponent statistics",
    note: {
      label: "Note (only you see it)",
      tags: "Tags, comma-separated",
      tagsPlaceholder: "nit, station, reg",
      save: "Save",
      delete: "Delete note",
      cancel: "Cancel",
    },
  },

  graph: {
    series: {
      total: { label: "Total", hint: "Everything won and lost" },
      showdown: { label: "Showdown", hint: "Hands that reached showdown" },
      nonShowdown: { label: "Non-showdown", hint: "Hands that ended before showdown" },
      allInEv: {
        label: "All-in EV",
        hint: (runouts: number) =>
          `Total, with ${num(runouts)} all-in ${runouts === 1 ? "runout" : "runouts"} paid at equity`,
      },
    },
    mixedUnitKind:
      "This sample mixes tournament chips with cash, so there is no win-rate graph to draw. Chips are not money — what they are worth is the payout structure — and a curve that added them to dollars would be a shape with no meaning. Filter to one game format.",
    notEnough:
      "Not enough hands yet to draw a curve. The graph needs at least a couple of buckets of play behind it; keep uploading.",
    ariaLabel: (count: number) =>
      `Cumulative win rate over ${hands(count)}, split into total, showdown and non-showdown big blinds won.`,
    axisLabel: "Hands played",
    noDates: "no dates on these hands",
    noAllIns: "no all-ins yet",
    notComputed: "not yet computed",
    noAllInsHint: "Appears once a hand in this sample has an all-in with cards to come",
    notComputedHint: "Needs equity over the runout",
    mixedCurrency:
      "This sample spans more than one currency, so the cash series is withheld and only the big-blind ones are drawn. Adding dollars to euros produces a curve with no unit; big blinds are a unit of the game and combine correctly.",
    showNumbers: "Show the numbers",
    from: "From",
    to: "To",
  },
} as const;
