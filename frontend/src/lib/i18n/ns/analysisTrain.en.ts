/**
 * Strings for the trainer (phase A7), English: `/analysis/train` — the
 * preflop trainer, the river spot trainer and drills of your own mistakes —
 * plus the drill counts on the overview and on Leaks. Spread into
 * `analysis.en.ts` as `analysis.train`; `analysisTrain.hr.ts` is the same
 * shape. Seats stay UTG, HJ, CO, BTN, SB, BB in both languages.
 */

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const bb = (value: number) => `${num(value, Math.abs(value) < 10 ? 2 : 1)} bb`;
const pct = (value: number) => {
  const p = value * 100;
  return p > 0 && p < 10 ? `${num(Math.round(p * 10) / 10, 1)}%` : `${num(Math.round(p))}%`;
};
const drills = (count: number) => `${num(count)} ${count === 1 ? "drill" : "drills"}`;
const days = (count: number) => `${num(count)} ${count === 1 ? "day" : "days"}`;

const potNames: Record<string, string> = {
  srp: "Single-raised pot",
  "3bp": "3-bet pot",
  limped: "Limped pot",
};

export const trainEn = {
  heading: "Train",
  intro:
    "Practise against the reference your hands are graded by: the preflop charts, river solves, and your own mistakes, until they are right. Every answer is graded exactly as the analysis would grade it.",
  modesLabel: "What to practise",
  modes: { preflop: "Preflop", river: "River", drills: "Your mistakes" } as Record<string, string>,

  settings: {
    label: "Trainer settings",
    family: "Spot",
    families: {
      random: "Any spot",
      rfi: "First in (RFI)",
      "vs-open": "Facing an open",
      "vs-3bet": "Facing a 3-bet",
      squeeze: "Squeeze",
      bvb: "Blind vs blind",
      "vs-4bet": "Facing a 4-bet",
    } as Record<string, string>,
    seat: "Your seat",
    anySeat: "Any seat",
    deal: "Hands",
    deals: { range: "As the range holds them", borderline: "Mostly the close ones" } as Record<string, string>,
    table: "Table",
    tableValue: (players: number, stack: number) => `${players}-max · ${num(stack)} bb · cash`,
    pot: "Pot",
    pots: { any: "Any pot", ...potNames } as Record<string, string>,
    side: "Your position",
    sides: { any: "Either", ip: "In position", oop: "Out of position" } as Record<string, string>,
  },

  dealing: "Dealing…",
  solving: "Solving the river…",
  grading: "Grading…",
  failed: (message: string) => `The trainer could not deal a spot: ${message}`,
  noSpot: "No spot matches these settings. Try another seat or spot.",
  retry: "Try again",

  spotHeading: "The spot",
  yourHand: "Your hand",
  question: "What do you do?",
  preflopSpot: (spot: string) => `${spot}.`,
  riverSpot: (pot: string, hero: string, villain: string, inPosition: boolean) =>
    `${potNames[pot] ?? pot}, ${hero} against ${villain}. You are ${inPosition ? "in position" : "out of position"}.`,
  riverFacing: (villain: string, kind: string, toBb: number, sizePot: number) =>
    kind === "allin" ? `${villain} goes all-in for ${bb(toBb)}.` : `${villain} bets ${bb(toBb)} (${pct(sizePot)} of the pot).`,
  riverChecked: (villain: string) => `${villain} checks to you.`,
  riverFirst: "You are first to act on the river.",
  potLine: (pot: number, toCall: number, behind: number) =>
    toCall > 0 ? `Pot ${bb(pot)} · ${bb(toCall)} to call · ${bb(behind)} effective` : `Pot ${bb(pot)} · ${bb(behind)} effective`,
  rangesNote:
    "Ranges: the charts' preflop ranges, narrowed on the flop and turn by a heuristic model — an approximation, the same one your river grades rest on.",
  placeholderNote: "One of the preflop ranges is a labelled placeholder: the charts have no node for that line.",

  answersLabel: "Your options",
  keyHint: (key: string) => `key ${key}`,

  result: {
    heading: "How it went",
    youChose: (label: string) => `You chose: ${label}`,
    evLost: (loss: number, pot: number) => `EV lost ${bb(loss)} (${pct(pot)} of the pot)`,
    noLoss: "No EV lost",
    best: (label: string) => `Best: ${label}`,
    next: "Next spot",
    optionsHeading: "Every option, for your hand",
    chartHeading: "The whole chart",
    rangeHeading: "The whole range at this node",
    whyHeading: "Why",
    approximate: "Approximations",
    notGraded: (reason: string) => `This answer could not be graded: ${reason}`,
    saved: "Kept in your trainer history.",
    signInToKeep: "Sign in to keep your results and to drill your own mistakes.",
  },

  session: {
    heading: "This session",
    answers: (count: number) => `${num(count)} ${count === 1 ? "answer" : "answers"}`,
    score: "Score",
    accuracy: "Played as the reference",
    streak: "Streak",
    best: "Best streak",
    evLost: "EV lost",
    bb,
    pct,
    none: "No answers yet.",
    reset: "Start over",
    distribution: "Answers by class",
  },

  history: {
    heading: (days: number) => `Your trainer, last ${num(days)} days`,
    row: (answers: number, score: number | null, evLoss: number) =>
      `${num(answers)} ${answers === 1 ? "answer" : "answers"}${score === null ? "" : ` · score ${num(score, 1)}`} · ${bb(evLoss)} lost`,
    none: "No trainer answers kept yet.",
    modes: { preflop: "Preflop", river: "River", drill: "Your mistakes" } as Record<string, string>,
  },

  drills: {
    heading: "Your mistakes, until they are right",
    intro:
      "Every decision of yours graded Mistake or Blunder comes back here as “what would you do?”. A wrong answer returns in ten minutes; a right one after a day, then six days, then further apart each time.",
    syncing: "Collecting your mistakes…",
    loading: "Loading the hand…",
    counts: {
      due: "Due now",
      dueToday: "Due today",
      items: "Drills",
      learning: "Relearning",
      mature: "Learnt (3+ weeks)",
    },
    includeInaccurate: "Include Inaccurate moves",
    practiseAll: "Practise all, not only what is due",
    leak: (spots: number) => `Drilling one leak (${num(spots)} ${spots === 1 ? "spot" : "spots"}).`,
    allDrills: "All drills",
    empty: "Nothing is due right now. Come back later, or practise all of them.",
    emptyLeak: "No drills for this leak: none of its decisions was graded Mistake or worse.",
    noneYet: "No drills yet: analyse your hands, and your Mistakes and Blunders will appear here.",
    goToAnalysis: "Go to your analysis",
    fromHand: (date: string) => `From your hand of ${date}`,
    fromHandUndated: "From one of your hands",
    youPlayed: (label: string, grade: string) => `When you played it: ${label} — ${grade}.`,
    backIn: (count: number) => `Back in ${days(count)}.`,
    backSoon: "Wrong for now: back in ten minutes.",
    reviews: (count: number) => (count === 0 ? "First time" : `Answered ${num(count)} ${count === 1 ? "time" : "times"} before`),
    handGone: "This hand is no longer in your library.",
    notAnalysed: "This decision has no analysis at the current version. Run the analysis, then drill it.",
    openHand: "Open the hand",
    skip: "Skip",
    done: (count: number) => `Done: ${drills(count)} answered.`,
    notInstalledHeading: "Drills are not set up on this database",
    notInstalledBefore: "Apply ",
    notInstalledAfter: " to store drills and trainer results.",
  },

  keys: {
    button: "Keys",
    title: "Trainer keys",
    note: "These work anywhere on the page except inside the replayer and form fields; the replayer has its own keys (press ? on it).",
    items: {
      options: "Pick the option with that number",
      fold: "Fold",
      check: "Check",
      call: "Call",
      allin: "All-in",
      next: "Next spot (after answering)",
      help: "This list",
    },
  },

  overview: {
    heading: "Drills",
    due: (due: number, today: number) =>
      due > 0 ? `${drills(due)} due now${today > due ? `, ${num(today)} today` : ""}.` : today > 0 ? `${drills(today)} due later today.` : "Nothing due today.",
    candidates: (count: number) => `${num(count)} new ${count === 1 ? "mistake" : "mistakes"} to drill.`,
    train: "Train",
  },

  leak: {
    drill: "Drill this",
    due: (due: number, items: number) =>
      items === 0 ? "No Mistakes here to drill." : `${num(due)} of ${drills(items)} due today.`,
    badge: (due: number) => `${num(due)} due`,
  },
};
