/**
 * The Reports screen's words both surfaces show, English (`ReportsStrings`,
 * R4.5c): the summary, the graph's card, the statistics by group, the
 * breakdowns and the starting-hand grid. Moved from the desktop app's
 * dictionary (`app/src/i18n/en.ts` `reports`, which spreads this and keeps
 * its own messages). Data, like `hands.en.ts`; `reports.hr.ts` is the same
 * shape.
 */

const num = (value: number) => value.toLocaleString("en-GB");
/** "1 hand", "1,204 hands". */
const hands = (count: number) => (count === 1 ? "1 hand" : `${num(count)} hands`);

export const reportsUiEn = {
  loading: "Adding up your hands…",
  storeError: (reason: string) => `The report did not load: ${reason}`,
  noMatch: "None of your hands matches these filters.",
  count: (count: number) => hands(count),
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
      : `${num(count)} all-in hands are still being evaluated in the background; until then the EV line counts them at their result.`,
  graph: {
    heading: "Winnings",
    unit: "Show in",
    bigBlinds: "Big blinds",
    money: "Money",
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
};
