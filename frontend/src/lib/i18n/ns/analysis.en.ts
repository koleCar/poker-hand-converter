/**
 * Strings for the Analysis tab and the replayer's Analysis sheet, English.
 * Spread into `en.ts` as `analysis`; `analysis.hr.ts` is the same shape.
 *
 * ## The explanations are templates, not prose
 *
 * `docs/ANALYSIS-PLAN.md` §4: every decision gets a short *why*, built only
 * from facts the engine computed (`SpotFacts`, the flags and their params).
 * `explain()` below turns one decision into sentences, keyed by flag, street
 * and reason. Templates rather than free text because they are testable, they
 * translate, and they cannot invent a reason the numbers do not support: every
 * number in a sentence is a number in the record.
 *
 * The engine's vocabulary (`top-pair`, `two-tone`, `vs-3bet`) is mapped to
 * words here and nowhere else, so the stored record stays language-free.
 */

import type { DecisionAnalysis, Flag, SpotFacts } from "../../analysis/types";

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const hands = (count: number) => `${num(count)} ${count === 1 ? "hand" : "hands"}`;
const decisions = (count: number) => `${num(count)} ${count === 1 ? "decision" : "decisions"}`;
const pct = (value: number) => `${num(Math.round(value * 100))}%`;
/** Big blinds, to one decimal when there is one: "2.5 bb", "37 bb", "152.5 bb". */
const bb = (value: number) => {
  const tenth = Math.round(value * 10) / 10;
  return `${num(tenth, tenth % 1 !== 0 ? 1 : 0)} bb`;
};

const streets = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>;
const streetsLower = { preflop: "preflop", flop: "on the flop", turn: "on the turn", river: "on the river" } as Record<
  string,
  string
>;

const made = {
  "straight-flush": "a straight flush",
  quads: "four of a kind",
  "full-house": "a full house",
  flush: "a flush",
  straight: "a straight",
  set: "a set",
  trips: "trips",
  "two-pair": "two pair",
  overpair: "an overpair",
  "top-pair": "top pair",
  "pocket-pair-below-top": "a pocket pair below the top card",
  "second-pair": "second pair",
  "weak-pair": "a weak pair",
  underpair: "an underpair",
  "ace-high": "ace high",
  "high-card": "no pair",
  board: "the board (you play it)",
} as Record<string, string>;

const kicker = { top: "top kicker", good: "a good kicker", weak: "a weak kicker" } as Record<string, string>;

const draws = {
  "flush-draw": "a flush draw",
  "nut-flush-draw": "the nut flush draw",
  oesd: "an open-ended straight draw",
  gutshot: "a gutshot",
  "backdoor-flush": "a backdoor flush draw",
  "backdoor-straight": "a backdoor straight draw",
  overcards: "two overcards",
} as Record<string, string>;

const blockers = {
  "nut-flush": "the nut flush",
  "second-nut-flush": "the second-nut flush",
  "nut-straight": "the nut straight",
  "top-pair": "top pair",
  set: "sets",
} as Record<string, string>;

const preflopScenarios = {
  unopened: "Unopened pot",
  "vs-limp": "Facing limpers",
  "bb-option": "Big blind option",
  "vs-open": "Facing an open",
  squeeze: "Squeeze spot",
  "vs-3bet": "Facing a 3-bet after opening",
  "vs-3bet-cold": "Facing a 3-bet, cold",
  "vs-4bet": "Facing a 4-bet or more",
} as Record<string, string>;

const roles = { pfr: "Preflop raiser", caller: "Preflop caller", limped: "Limped pot" } as Record<string, string>;
const facing = { first: "first to bet", "vs-bet": "facing a bet", "vs-raise": "facing a raise" } as Record<string, string>;

/** "Preflop raiser, in position, facing a bet" / "Facing an open". */
function scenarioLabel(facts: Pick<SpotFacts, "preflopScenario" | "role" | "facing" | "inPosition" | "scenario">): string {
  if (facts.preflopScenario) return preflopScenarios[facts.preflopScenario] ?? facts.scenario;
  const where = facts.inPosition === null ? "" : facts.inPosition ? ", in position" : ", out of position";
  return `${roles[facts.role ?? ""] ?? facts.scenario}${where}, ${facing[facts.facing ?? ""] ?? ""}`.replace(/, $/, "");
}

/** "open:BTN" → "a BTN open". */
const lines = {
  open: (pos: string) => `a ${pos} open`,
  iso: (pos: string) => `an isolation raise from ${pos}`,
  limp: (pos: string) => `a ${pos} limp`,
  call: (pos: string) => `a ${pos} call`,
  "3bet": (pos: string) => `a ${pos} 3-bet`,
  "call-3bet": (pos: string) => `a ${pos} call of a 3-bet`,
  "4bet": (pos: string) => `a ${pos} 4-bet`,
  "call-4bet": (pos: string) => `a ${pos} call of a 4-bet`,
  check: (pos: string) => `a ${pos} check`,
  unknown: () => "any two cards",
} as Record<string, (pos: string) => string>;

function rangeLabel(key: string): string {
  const [line, position] = key.split(":");
  const label = lines[line] ?? lines.unknown;
  return label(position && position !== "?" ? position : "seat");
}

function handPhrase(facts: SpotFacts): string {
  if (!facts.made) return facts.handClass ?? facts.holeCards.join("");
  const base = made[facts.made.class] ?? facts.made.class;
  return facts.made.kicker ? `${base} with ${kicker[facts.made.kicker]}` : base;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const textureWords = {
  suits: { rainbow: "rainbow", "two-tone": "two-tone", monotone: "monotone" } as Record<string, string>,
  connectedness: {
    disconnected: "disconnected",
    "semi-connected": "semi-connected",
    connected: "connected",
  } as Record<string, string>,
  dynamism: { static: "static", medium: "medium", dynamic: "dynamic" } as Record<string, string>,
  highCard: { ace: "ace-high", broadway: "broadway", middle: "middling", low: "low" } as Record<string, string>,
};

function textureLabel(facts: SpotFacts): string | null {
  const texture = facts.texture;
  if (!texture) return null;
  const words = [
    textureWords.highCard[texture.highCard],
    texture.trips ? "trips" : texture.paired ? "paired" : null,
    textureWords.suits[texture.suits],
    textureWords.connectedness[texture.connectedness],
    texture.dynamism ? textureWords.dynamism[texture.dynamism] : null,
  ].filter((word): word is string => Boolean(word));
  return words.join(", ");
}

/** One flag as a sentence. Keyed by code; the street picks the variant where it matters. */
function flagSentence(flag: Flag, facts: SpotFacts): string {
  const p = flag.params;
  switch (flag.code) {
    case "fold-nuts":
      return facts.street === "river"
        ? "You folded the nuts: no hand the opponent could hold beats yours on this board."
        : "You folded a hand that cannot lose: no holding and no card to come beats it.";
    case "free-fold":
      return "You folded when checking was free. Folding gave up the pot for nothing; a check keeps every option.";
    case "call-beats-nothing":
      return flag.severity === "inaccurate"
        ? "This call beats nothing: no hand the opponent could hold is worse than yours."
        : `This call beats nothing in ${rangeLabel(String(p.range))} range — the placeholder range, before any narrowing.`;
    case "call-without-odds":
      return `The call needed ${num(Number(p.needed))}% equity and your hand had about ${num(Number(p.equity))}% against ${rangeLabel(String(p.range))} range, with no cards to come.`;
    case "fold-with-odds":
      return facts.street === "river"
        ? `The call needed ${num(Number(p.needed))}% and your hand had about ${num(Number(p.equity))}% even against the stronger half of ${rangeLabel(String(p.range))} range.`
        : `The call needed ${num(Number(p.needed))}% and your hand had about ${num(Number(p.equity))}% against ${rangeLabel(String(p.range))} range, with nothing left to decide.`;
    case "check-back-nuts":
      return "You checked back the nuts on the river. There can be a reason — a blocker, a merged range — but it is worth a look: nothing here beats a bet.";
    case "thin-stack-behind":
      return `Your bet left ${bb(Number(p.behind))} behind against a ${bb(Number(p.pot))} pot if called: committed in all but name. All-in usually plays the same and gives away less.`;
    case "committed-fold":
      return `You folded with ${num(Number(p.invested))}% of your stack already in, to a price that needed only ${num(Number(p.needed))}% equity.`;
    default:
      return "";
  }
}

/**
 * The *why* for one decision, as sentences: the spot, the price, the equity,
 * the geometry, then each flag. Built only from the record — nothing here
 * computes a number the engine did not.
 */
function explain(decision: DecisionAnalysis): string[] {
  const facts = decision.facts;
  const out: string[] = [];
  if (decision.status === "not-analysed") {
    out.push(
      decision.reason === "multiway"
        ? "Not analysed: three or more players were still in after the flop, and nothing here models three ranges at once. Saying nothing beats saying something wrong."
        : "Not analysed.",
    );
  }

  const spot = scenarioLabel(facts);
  if (facts.street === "preflop") {
    out.push(`${spot} in ${facts.position ?? "your seat"} with ${facts.handClass ?? facts.holeCards.join("")}, ${bb(facts.effStackBb)} effective.`);
  } else {
    const texture = textureLabel(facts);
    const drawText = facts.draws.length > 0 ? `, plus ${list(facts.draws.map((d) => draws[d] ?? d))}` : "";
    out.push(`${streets[facts.street]}: ${spot}. You hold ${handPhrase(facts)}${drawText}${texture ? ` on a ${texture} board` : ""}.`);
  }

  if (facts.potOdds !== null) {
    const mdf = facts.mdf !== null ? ` Against this bet the minimum defence is ${pct(facts.mdf)}.` : "";
    out.push(`Calling ${bb(facts.toCallBb)} into ${bb(facts.potBb)} needs ${pct(facts.potOdds)} equity.${mdf}`);
  }
  if (facts.equity) {
    const strong =
      facts.equity.strong !== null && facts.equity.strong !== undefined
        ? ` (${pct(facts.equity.strong)} against its stronger half)`
        : "";
    out.push(
      `Against ${rangeLabel(facts.equity.range)} range — a placeholder, not narrowed by later betting — your hand has about ${pct(facts.equity.value)}${strong}.`,
    );
  }
  if (facts.betPot !== null && (decision.action === "bet" || decision.action === "raise")) {
    out.push(`You ${decision.action === "bet" ? "bet" : "raised"} ${pct(facts.betPot)} of the pot${facts.allIn ? ", all in" : ""}.`);
  }
  if (facts.spr !== null && facts.spr <= 3 && facts.street !== "river") {
    out.push(`SPR ${num(facts.spr, 1)}: the stacks are short next to the pot, so the next bet commits them.`);
  }
  if (facts.blockers.length > 0) {
    out.push(`Your cards block ${list(facts.blockers.map((b) => blockers[b] ?? b))}.`);
  }
  for (const flag of decision.flags) {
    out.push(flagSentence(flag, facts));
  }
  return out.filter(Boolean);
}

export const analysisEn = {
  tab: {
    heading: "Analysis",
    /** Next to the heading: "1,234 hands · analysis/1". */
    sample: (count: number, version: string) => `${hands(count)} · ${version}`,
    signInHeading: "Sign in to analyse your hands",
    signInBody:
      "The analysis reads the hands in your library, so it needs an account to belong to. It is private to you.",
    signIn: "Sign in",
    notInstalledHeading: "Analysis is not set up on this database yet",
    /** Around the migration file name, shown in `<code>`. */
    notInstalledBefore: "Your hands are safe — this screen reads its own tables, which arrive with ",
    notInstalledAfter: ". Apply it and reload.",
    loading: "Reading your analysis…",
    tryAgain: "Try again",
    emptyHeading: "Nothing analysed yet",
    emptyBody:
      "The analysis walks every decision you made in your saved hands: the board, your hand, the price, and the checks that hold whatever the strategy. It runs in this browser tab.",
    noHandsHeading: "No hands in your library yet",
    noHandsBody: "Upload a hand history first; the analysis reads the hands you have saved.",
  },

  /** The line above everything about what the analysis can and cannot say yet. */
  reference: {
    title: "No reference strategy yet",
    body:
      "Grades — Perfect to Blunder — arrive with the preflop charts. Until then every decision shows its facts and the checks that are true whatever the strategy. A flag is a note, never a grade.",
  },

  run: {
    button: "Run analysis",
    again: "Analyse new hands",
    update: "Bring it up to date",
    stop: "Stop",
    running: (done: number, target: number) =>
      target > 0 ? `Analysing… ${num(Math.min(done, target))} of ${hands(target)}` : `Analysing… ${hands(done)}`,
    finished: (count: number) => `Analysed ${hands(count)}.`,
    stopped: "Stopped. Run it again to carry on where it left off.",
    failed: (message: string) => `The analysis stopped: ${message}`,
    unreadable: (count: number) => `${num(count)} could not be read — a converter bug, not your file.`,
    missing: (count: number, total: number) => `${num(count)} of ${hands(total)} are not analysed yet.`,
    versionChanged: (count: number, version: string) =>
      `The analysis has changed since ${hands(count)} were analysed (now ${version}). Run it again to bring them up to date.`,
    note: "Runs in this tab. Your hands are read from your library and the results saved back to it, as you.",
  },

  overview: {
    coverage: "Coverage",
    full: { label: "Fully analysed", hint: "Every decision has its facts and checks" },
    partial: { label: "Partly analysed", hint: "Some decisions were skipped — see below" },
    notAnalysed: { label: "Not analysed", hint: "Outside what the analysis covers" },
    hands,
    decisions,
    analysedDecisions: (analysed: number, total: number) => `${num(analysed)} of ${decisions(total)} analysed`,
    reasonsHeading: "Why hands were not analysed",
    skippedHeading: "Why decisions were skipped",
    flagsHeading: "Flags",
    flagsNote: "Checks that hold whatever the strategy. Notes, not grades — read them with the hand open.",
    noFlags: "Nothing flagged in this sample.",
    flaggedHands: (count: number) => `${hands(count)} with a flag`,
    streetsHeading: "By street",
    defenceNote:
      "Defended: how often you continued (called or raised) when facing a bet, against the mean MDF of those bets. One sample of your own hands — a direction, not a verdict.",
    approximationsHeading: "Approximations",
  },

  reasons: {
    "no-hero": "No hero seat (an observed table)",
    variant: "Not Hold'em",
    "hi-lo": "Hi/Lo split pot",
    limit: "Not No-Limit",
    tournament: "Tournament (ICM not modelled)",
    "bomb-pot": "Bomb pot",
    "hero-cards-unknown": "Your cards are unknown",
    "no-decisions": "You had no decision",
    multiway: "Multiway after the flop",
  } as Record<string, string>,

  approximations: {
    heuristic: "Heuristic checks only, no reference strategy",
    "placeholder-range": "Equities against default placeholder ranges",
    antes: "Antes in the pot",
    straddle: "A straddle moved the blinds",
    "stack-depth": "Stacks outside 100 bb ±20%",
    "table-size": "Not a six-handed table",
  } as Record<string, string>,

  severity: { note: "Note", inaccurate: "Inaccurate" } as Record<string, string>,

  flags: {
    "fold-nuts": "Folded the nuts",
    "free-fold": "Folded when a check was free",
    "call-beats-nothing": "Called with a hand that beats nothing",
    "call-without-odds": "Called without the odds",
    "fold-with-odds": "Folded with the odds",
    "check-back-nuts": "Checked back the nuts",
    "thin-stack-behind": "Bet left too little behind",
    "committed-fold": "Folded when committed",
  } as Record<string, string>,

  grades: {
    perfect: "Perfect",
    good: "Good",
    inaccurate: "Inaccurate",
    mistake: "Mistake",
    blunder: "Blunder",
  } as Record<string, string>,

  streets,
  actions: { fold: "Fold", check: "Check", call: "Call", bet: "Bet", raise: "Raise" } as Record<string, string>,
  /** One letter per action, for the coloured action strips. */
  letters: { fold: "F", check: "X", call: "C", bet: "B", raise: "R" } as Record<string, string>,

  table: {
    street: "Street",
    decisions: "Decisions",
    analysed: "Analysed",
    flagged: "Flagged",
    facingBet: "Facing a bet",
    defended: "Defended",
    mdf: "MDF",
    hands: "Hands",
    count: "Count",
    flag: "Flag",
  },

  breakdown: {
    heading: "Breakdown",
    splitBy: "Split by",
    groups: {
      street: "Street",
      position: "Position",
      pot_type: "Pot type",
      scenario: "Spot",
    } as Record<string, string>,
    unknown: "Unknown",
    scenario: (key: string) => {
      if (preflopScenarios[key]) return preflopScenarios[key];
      const [role, where, ...rest] = key.split("-");
      const facingKey = rest.join("-");
      return `${roles[role] ?? role}, ${where === "ip" ? "IP" : "OOP"}, ${facing[facingKey] ?? facingKey}`;
    },
  },

  filters: {
    ariaLabel: "Filter the analysed hands",
    format: "Game",
    street: "Street",
    anyStreet: "Any street",
    flag: "Flag",
    anyFlag: "Any",
    flaggedOnly: "Any flag",
    status: "Coverage",
    anyStatus: "Any",
    position: "Position",
    anyPosition: "Any",
    potType: "Pot",
    anyPot: "Any",
    sort: "Sort",
    sorts: {
      recent: "Newest first",
      oldest: "Oldest first",
      flags: "Most flagged",
      ev_loss: "Most EV lost",
      score: "Lowest score",
      result: "Biggest loss",
    } as Record<string, string>,
    clear: "Clear filters",
  },

  list: {
    heading: "Hands",
    total: (count: number) => hands(count),
    when: "Played",
    hand: "Hand",
    position: "Pos",
    pot: "Pot",
    actions: "Decisions",
    flags: "Flags",
    result: "Result",
    open: (cards: string) => `Open the analysis of ${cards}`,
    empty: "No analysed hands match these filters.",
    previous: "Previous",
    next: "Next",
    page: (from: number, to: number, total: number) => `${num(from)}–${num(to)} of ${num(total)}`,
    noDate: "—",
    /** The coloured strip's accessible name: "Preflop raise, flop bet — note". */
    stripLabel: (parts: string[]) => parts.join(", "),
    decisionLabel: (street: string, action: string, mark: string | null) =>
      `${street} ${action.toLowerCase()}${mark ? ` — ${mark.toLowerCase()}` : ""}`,
    notAnalysed: "not analysed",
  },

  sheet: {
    title: "Analysis",
    toggle: "Analysis",
    toggleTitle: "Show the analysis of this hand",
    notGraded: "Not graded",
    notGradedHint: "No reference strategy yet — facts and checks only.",
    evLoss: "EV loss",
    score: "Score",
    approximate: "Approximate",
    decisionsHeading: "Your decisions",
    noDecisions: "You made no decision in this hand.",
    factsHeading: "The spot",
    flagsHeading: "Flags",
    whyHeading: "Why",
    noFlags: "Nothing flagged: every check that holds whatever the strategy passed.",
    skipped: "Skipped",
    /** The pip on the replayer rail. */
    mark: (street: string, action: string, note: string | null) =>
      `${street} ${action.toLowerCase()}${note ? `: ${note.toLowerCase()}` : ""}`,
    chip: (street: string, action: string) => `${street}: ${action}`,
    facts: {
      pot: "Pot",
      toCall: "To call",
      potOdds: "Equity needed",
      mdf: "MDF",
      spr: "SPR",
      betPot: "Bet size",
      effStack: "Effective stack",
      hand: "Your hand",
      board: "Board",
      draws: "Draws",
      blockers: "Blocks",
      equity: "Equity (estimate)",
      position: "Position",
      spot: "Spot",
    },
    bb,
    pct,
    /** A ratio such as SPR, to one decimal in the reader's notation. */
    ratio: (value: number) => num(value, 1),
    ofPot: (value: number) => `${pct(value)} of pot`,
    equityValue: (value: number, range: string) => `${pct(value)} vs ${rangeLabel(range)}`,
    handValue: (facts: SpotFacts) => handPhrase(facts),
    drawsValue: (facts: SpotFacts) => list(facts.draws.map((d) => draws[d] ?? d)),
    blockersValue: (facts: SpotFacts) => list(facts.blockers.map((b) => blockers[b] ?? b)),
    textureValue: (facts: SpotFacts) => textureLabel(facts) ?? "",
    spotValue: (facts: SpotFacts) => scenarioLabel(facts),
    streetLower: (street: string) => streetsLower[street] ?? street,
  },

  hand: {
    back: "Back to analysis",
    loading: "Loading the hand…",
    notFound: "This hand is not in your library.",
    fresh:
      "This hand has not been analysed at the current version yet, so this is a fresh analysis computed in your browser. Run the analysis to save it.",
  },

  explain,
} as const;
