/**
 * The Players screen's words both surfaces show, English (`PlayersStrings`,
 * R4.5c): the list, its filters, the profile, the user's words on a player.
 * Moved from the desktop app's dictionary (`app/src/i18n/en.ts` `players`,
 * which spreads this and keeps its own messages - "only in the app", the
 * rebuild and indexing lines, the empty list, the notes' footnote). Data,
 * like `hands.en.ts`; `players.hr.ts` is the same shape.
 */

const num = (value: number) => value.toLocaleString("en-GB");
/** "1 hand", "1,204 hands". */
const hands = (count: number) => (count === 1 ? "1 hand" : `${num(count)} hands`);

export const playersUiEn = {
  storeError: (reason: string) => `The players did not load: ${reason}`,
  loading: "Loading players…",
  noMatch: "No opponent matches.",
  count: (players: number) => (players === 1 ? "1 opponent" : `${num(players)} opponents`),
  countOf: (matching: number, total: number) => `${num(matching)} of ${num(total)} opponents`,
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
    `${count === 1 ? "1 opponent's hand" : `${num(count)} opponents' hands`} from rooms that hide screen names (such as GGPoker) count in your statistics but are not listed: a name there lasts one session, so it cannot be followed from one session to the next.`,
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
    togetherCash: (count: number) => `${num(count)} in cash games`,
    togetherChips: (count: number) => `${num(count)} in tournaments`,
    firstSeen: "First seen",
    lastSeen: "Last seen",
    result: "Your result against them",
    resultCash: "Cash",
    resultChips: "Tournaments",
    resultLine: (bb: string, count: number) => `${bb} bb over ${hands(count)}`,
    perHundred: (value: string) => `${value} bb/100`,
    noHands: "No hands",
    handsWith: (count: number) => `Hands with this player (${num(count)})`,
    kind: "Game",
    kindHint: "Their numbers in cash games, in tournaments or in both; the list's choice until you pick one here.",
    stats: "Their statistics",
    sample: (count: number) =>
      count === 1 ? "Over 1 hand of theirs, yours or not." : `Over ${num(count)} of their hands, yours or not.`,
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
  },
};
