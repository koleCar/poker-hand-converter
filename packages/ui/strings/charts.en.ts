/**
 * The user's own preflop charts' words, English (`ChartsStrings`, R5.3):
 * the library of chart sets, the editor and the comparison with played
 * hands. Data, like `review.en.ts`; `charts.hr.ts` is the same shape.
 */

const num = (value: number) => value.toLocaleString("en-GB");
const decisions = (count: number) => (count === 1 ? "1 decision" : `${num(count)} decisions`);

export const chartsUiEn = {
  title: "Your preflop charts",
  intro:
    "Build or import your own preflop ranges, situation by situation, and see how closely the hands you played follow them. Your charts are private to your account.",
  loading: "Loading your charts…",
  error: (reason: string) => `Your charts did not load: ${reason}`,
  hiddenDuringPlay: "Your charts are hidden while a poker table is open: studying them is for after you play.",

  library: {
    heading: "Chart sets",
    empty: "No chart set yet. Start a new one, or import a file exported from Rail.",
    create: "New chart set",
    newName: "My chart set",
    open: (name: string) => `Open ${name}`,
    summary: (format: string, table: string, from: number, to: number, nodes: number) =>
      `${format} · ${table} · ${num(from)}–${num(to)} bb · ${nodes === 1 ? "1 situation" : `${num(nodes)} situations`}`,
    updated: (when: string) => `Saved ${when}`,
    importHeading: "Import a chart set",
    importHelp: "A file exported from Rail (rail-preflop-charts JSON). Ranges from other tools go in situation by situation, in the editor.",
    importFile: "Choose a file",
    importPaste: "…or paste its text",
    importButton: "Import",
    imported: (name: string) => `Imported "${name}". Check it, then save.`,
    limit: (max: number) => `You have ${num(max)} chart sets, the most an account can keep. Delete one to make another.`,
  },

  tabs: { label: "Chart set", edit: "Edit", compare: "Compare with your hands" },
  back: "All your charts",

  game: {
    heading: "The game",
    name: "Name",
    format: "Format",
    formats: { cash: "Cash", tournament: "Tournament" } as Record<string, string>,
    table: "Table",
    tables: { 2: "Heads-up", 6: "6-max (3–6 players)", 9: "Full ring (7–9 players)" } as Record<number, string>,
    tablesShort: { 2: "Heads-up", 6: "6-max", 9: "Full ring" } as Record<number, string>,
    stackFrom: "Stacks from (bb)",
    stackTo: "to (bb)",
    tableChange: (count: number) =>
      `${count === 1 ? "1 situation does" : `${num(count)} situations do`} not exist at this table and will be dropped when you save.`,
  },

  situation: {
    heading: "Situation",
    scenario: "Spot",
    hero: "You are",
    villain: "Against",
    filled: "Filled in",
    none: "No situation filled in yet: pick one above and paint the grid.",
    scenarios: {
      rfi: "Open (first in)",
      "vs-limp": "Facing limpers",
      "vs-open": "Facing an open",
      squeeze: "Facing an open and a call",
      "vs-iso": "Your limp, facing a raise",
      "vs-3bet": "Your open, facing a 3-bet",
      "vs-4bet": "Your 3-bet, facing a 4-bet",
      "vs-allin": "Your 4-bet, facing a 5-bet",
    } as Record<string, string>,
    /** "CO opens", "BB vs BTN open". */
    label: (scenario: string, hero: string, villain: string | null) => {
      switch (scenario) {
        case "rfi":
          return `${hero} opens`;
        case "vs-limp":
          return `${hero} vs ${villain} limp`;
        case "vs-open":
          return `${hero} vs ${villain} open`;
        case "squeeze":
          return `${hero} vs ${villain} open and a call`;
        case "vs-iso":
          return `${hero} limps, vs ${villain} raise`;
        case "vs-3bet":
          return `${hero} opens, vs ${villain} 3-bet`;
        case "vs-4bet":
          return `${hero} 3-bets, vs ${villain} 4-bet`;
        default:
          return `${hero} 4-bets, vs ${villain} 5-bet`;
      }
    },
  },

  actions: { raise: "Raise", call: "Call", allin: "All-in", fold: "Fold", check: "Check" } as Record<string, string>,
  limp: "Limp",

  brush: {
    heading: "Brush",
    help: "Click or drag over the grid to paint the hands with this mix; what is left of 100 % folds (checks for the big blind facing limpers).",
    percent: (action: string) => `${action} %`,
    rest: (action: string, percent: number) => `${action} ${num(percent)} %`,
    presets: "Quick mixes",
    over: "The mix adds up to more than 100 %.",
  },

  grid: {
    label: (situation: string) => `Chart for ${situation}`,
    cell: (name: string, mix: string) => `${name}: ${mix}`,
    byRank: "Hands with",
    byRankHelp: "Tap a hand to paint it with the brush.",
    share: (action: string, percent: string) => `${action} ${percent} % of hands`,
  },

  tools: {
    undo: "Undo",
    clear: "Clear situation",
    copyFrom: "Copy from another situation",
    copy: "Copy",
    copyRail: "Start from Rail's chart",
    copyRailHelp: "Rail's own solver charts (not anyone else's). Choose a stack depth.",
    railSetLabel: "Rail's chart",
    railSet: (table: string, depth: number) => `${table} ${num(depth)} bb`,
    railMissing: "Rail's chart has no such situation at this depth.",
    copied: "Copied. Undo puts it back.",
    importText: "Paste ranges",
    importHelp:
      "One range per action, as PIO, GTO+, Flopzilla or Equilab write them: AA,AKs,A5s:0.5 · [50]KQo[/50] · AhKh:0.25 · one hand per line with a weight.",
    apply: "Apply to this situation",
    exportText: "Copy as text",
    exportFormat: "Format",
    exportFormats: { range: "Range (PIO, Flopzilla: AKs:0.5)", brackets: "GTO+ / Equilab ([50]…[/50])", combos: "Combos (AhKh:0.5)" } as Record<string, string>,
    save: "Save",
    saving: "Saving…",
    saved: "Saved.",
    unsaved: "Unsaved changes",
    download: "Download (Rail JSON)",
    delete: "Delete chart set",
    deleteConfirm: (name: string) => `Delete "${name}"? This cannot be undone.`,
    raiseSize: "Your raise size here (bb, optional)",
  },

  problems: {
    name: "Give the chart set a name (up to 80 characters).",
    "stack-range": "The stack range must run from 1 to 1,000 bb, low to high.",
    "too-many-nodes": "A chart set holds at most 300 situations.",
    "node-key": (detail: string) => `Not a situation of this table: ${detail}`,
    "action-not-allowed": (detail: string) => `Not an action of this situation: ${detail}`,
    percent: (detail: string) => `A percent is over 100: ${detail}`,
    "over-100": (detail: string) => `A hand's actions add up to more than 100 %: ${detail}`,
    "raise-size": (detail: string) => `A raise size must be between 0 and 1,000 bb: ${detail}`,
    "too-big": "The chart set is too large to save.",
    json: (detail: string) => `Not a JSON file: ${detail}`,
    format: "Not a Rail chart file (rail-preflop-charts).",
    version: (detail: string) => `A Rail chart file of a version this page does not read: ${detail}`,
    game: "The file's game (format, table size, stack range) is not one Rail charts.",
    duplicate: (detail: string) => `The file lists a situation twice: ${detail}`,
    range: (where: string, detail: string) => `${where}: cannot read ${detail}`,
    set: (detail: string) => detail,
  },

  compare: {
    heading: "Your hands against this chart",
    period: "Period",
    periods: { "30d": "30 days", "90d": "90 days", "365d": "A year", all: "All time" } as Record<string, string>,
    periodNote: (from: string, to: string) => `Your preflop decisions from ${from} to ${to}, counted back from the last one.`,
    loading: "Comparing…",
    nothing:
      "No analysed preflop decision of yours matches this chart's game yet. Analyse your hands on the Analysis page; tournament hands are not read by the analysis yet.",
    scope:
      "Compared: preflop decisions the analysis placed on Rail's chart tree (cash no-limit hold'em, 2–9 players, stacks it covers), in this chart's format, table size and stack range.",
    tiles: {
      decisions: "Decisions compared",
      followed: "Played as your chart",
      off: "Off your chart",
      cost: "EV of those, by Rail's charts",
    },
    followedValue: (percent: string) => `${percent} %`,
    costValue: (bb: string) => `−${bb} bb`,
    costNote: "Your chart has no EVs: this is what Rail's own charts say the deviations cost.",
    situations: "By situation",
    columns: { situation: "Situation", decisions: "Decisions", followed: "As your chart", top: "Most frequent deviation" },
    deviation: (hand: string, action: string, count: number) => `${hand} ${action} ×${num(count)}`,
    noDeviation: "—",
    missing: (count: number) =>
      `${count === 1 ? "1 situation you played is" : `${num(count)} situations you played are`} not in this chart:`,
    missingItem: (situation: string, count: number) => `${situation} (${decisions(count)})`,
    fill: "Fill it in",
    unnamed: (count: number) =>
      `${decisions(count)} came in spots charts do not name (a cold 4-bet, a re-raised pot with a caller, after an iso-raise) and are not compared.`,
    detail: {
      heading: (situation: string) => `${situation}: your play`,
      mix: "Your actions against the chart's, for the hands you held",
      mixRow: (action: string, played: string, chart: string) => `${action}: you ${played} %, the chart ${chart} %`,
      grid: "Hands off the chart are marked; the grid is your chart.",
      deviations: "Deviations",
      none: "Every decision here follows your chart.",
      /** "K9o: you raised ×4 - your chart folds (it plays your action 0 %)". */
      row: (hand: string, did: string, count: number, does: string, percent: string) =>
        `${hand}: you ${did} ×${num(count)} - your chart ${does} (it plays your action ${percent} %)`,
      did: { raise: "raised", call: "called", allin: "went all in", fold: "folded", check: "checked" } as Record<string, string>,
      does: { raise: "raises", call: "calls", allin: "goes all in", fold: "folds", check: "checks" } as Record<string, string>,
      examples: "Example hands",
      examplesFor: (hand: string, did: string) => `${hand}, ${did}`,
      noExamples: "No hand to show.",
      open: (cards: string, when: string) => `Open ${cards} from ${when} at the decision`,
      evLoss: (bb: string) => `−${bb} bb EV by Rail's charts`,
    },
  },
};
