/**
 * Strings for the Trainer (`components/trainer`), English. Spread into
 * `en.ts` as `trainer`; `trainer.hr.ts` is the same shape.
 *
 * Plain data and functions, like `solver.en.ts`: the desktop app takes this
 * file in place through its trainer door (`app/src/trainer/door.ts`), so it
 * may import only other plain word files. `words` are the analysis' own
 * (the grades, the option labels, the *why* sentences, the leak names), so a
 * trainer answer reads exactly like the same decision in a real hand.
 */

import { analysisEn } from "./analysis.en";
import { leaksEn } from "./analysisLeaks.en";
import { courseEn } from "./course.en";

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Big blinds, to one decimal when there is one. */
const bb = (value: number) => {
  const tenth = Math.round(value * 10) / 10;
  return `${num(tenth, tenth % 1 !== 0 ? 1 : 0)} bb`;
};
const pct = (value: number) => `${num(Math.round(value * 100))}%`;
/** An action class as a rate's name ("fold rate"). */
const ACTION_EN: Record<string, string> = { fold: "fold", call: "call", raise: "raise", bet: "bet", vpip: "VPIP", pfr: "PFR" };

export const trainerEn = {
  /** The language, for the catalogue's own labels (Analytics' size buckets and hand classes). */
  lang: "en" as "en" | "hr",
  modesLabel: "What to practise",
  modes: {
    focus: "For you",
    preflop: "Preflop",
    flop: "Flop",
    turn: "Turn",
    river: "River",
  } as Record<string, string>,
  modeHints: {
    focus: "Spots picked from your own leaks, costliest first",
    preflop: "Charts: open, defend, 3-bet, 4-bet",
    flop: "Heads-up flops from Rail's flop library",
    turn: "A turn solved on the spot",
    river: "A river solved on the spot",
  } as Record<string, string>,

  settings: "Settings",
  settingsTitle: "Trainer settings",
  close: "Close",
  reset: "Reset",
  sections: { spot: "Spot", play: "Training", show: "Show" },
  table: "Table",
  tableValue: (players: number, stack: number, straddle = false, ante = false) =>
    `${players === 2 ? "Heads-up" : `${players}-max`} ${num(stack)}bb${straddle ? " straddle" : ante ? " ante" : ""}`,
  family: "Situation",
  families: {
    random: "Any",
    rfi: "First in",
    "vs-open": "vs open",
    "vs-3bet": "vs 3-bet",
    squeeze: "Squeeze",
    bvb: "Blind vs blind",
    "vs-limp": "vs limp",
    "vs-4bet": "vs 4-bet",
  } as Record<string, string>,
  hero: "You",
  vs: "Against",
  any: "Any",
  pot: "Pot",
  pots: { any: "Any", srp: "Single-raised", "3bp": "3-bet", limped: "Limped" } as Record<string, string>,
  side: "Position",
  sides: { any: "Any", ip: "In position", oop: "Out of position" } as Record<string, string>,
  role: "Preflop",
  roles: { any: "Any", pfr: "You raised", caller: "You called" } as Record<string, string>,
  facing: "Facing",
  facings: { any: "Any", check: "Check", bet: "Bet", raise: "Raise" } as Record<string, string>,
  line: "Line",
  deal: "Hands",
  deals: { range: "As the range holds them", borderline: "Mostly close decisions" } as Record<string, string>,
  pause: "After an answer",
  pauses: { always: "Always wait", mistakes: "Wait only after a mistake" } as Record<string, string>,
  strategy: "Strategy for your hand",
  on: "On",
  off: "Off",

  rangePanel: "Range while answering",
  ranges: { range: "Range only", strategy: "Range and strategy" } as Record<string, string>,
  rangeHeading: "Your range here",
  rangeLoading: "Reading the range…",
  rangeNone: "No range for this spot.",
  /** How much of all two-card hands the range (or one action of it) holds. */
  rangeCombos: (combos: number, share: number) => `${num(Math.round(combos))} combos · ${pct(share)} of all hands`,
  rangeAll: "Whole range",
  rangeShow: "Show the hands that",
  tabs: {
    label: "More about this spot",
    range: "Range",
    strategy: "Strategy",
    facts: "Your hand",
    why: "Why",
    afterAnswer: "After you answer",
  },
  timebankLabel: "Time to answer",
  timebanks: { "0": "No clock", "7": "7 s", "15": "15 s", "25": "25 s" } as Record<string, string>,
  timeLeft: (seconds: number) => `${num(seconds)} s`,
  timeUp: "Out of time",
  buttonsLabel: "Buttons",
  buttonsValues: { all: "Every size", simple: "One per action" } as Record<string, string>,
  simpleBet: "Bet",
  simpleRaise: "Raise",
  inputLabel: "Answer with",
  inputs: { action: "One action", frequency: "A mix of actions" } as Record<string, string>,
  mixSubmit: "Answer",
  mixHint: "Split 100% across the actions: how often you would take each.",
  mixAccuracy: (share: number) => `Accuracy ${pct(share)}`,
  mixYours: "You",
  mixRef: "Solver",
  tablesLabel: "Tables",
  tablesNote: "One spot each; keys go to the first table waiting for an answer.",
  drills: {
    heading: "My drills",
    none: "No saved drills yet.",
    name: "Name",
    placeholder: "e.g. BB vs BTN, flop, facing a bet",
    save: "Save these settings",
    remove: (name: string) => `Delete ${name}`,
    open: (name: string) => `Open ${name}`,
  },
  history: {
    heading: "Recent answers",
    none: "Answers you give are kept here, on this computer.",
  },
  sessions: {
    newSession: "New session",
    sortLabel: "Sort sessions",
    sorts: { recent: "Recent", hands: "Hands", score: "Score" } as Record<string, string>,
    archived: "Archived",
    columns: { session: "Session", hands: "Hands", score: "Score", grades: "Grades", evLost: "EV lost", played: "Last played" },
    todayCount: (n: number) => `+${num(n)} today`,
    continue: "Continue",
    menu: (name: string) => `${name}: more`,
    review: "Review history",
    rename: "Rename",
    renameSave: "Save",
    fromThese: "New session from these settings",
    archive: "Archive",
    restore: "Restore",
    none: "Pick what to train, name it, and come back to it any time.",
    noneArchived: "No archived sessions.",
    loading: "Loading your sessions…",
    failed: (message: string) => `Your sessions could not be read: ${message}`,
    all: "All sessions",
    title: "New session",
    name: "Session name",
    nameAuto: "Named from the settings until you type your own.",
    nameOwn: "Your own name.",
    auto: "Auto",
    start: "Start session",
    startAnyway: "Start a new one anyway",
    cancel: "Cancel",
    changeNote: (name: string, hands: number) =>
      `Changed settings start a new session. ${name} stays as it is${hands > 0 ? `, with its ${num(hands)} hands` : ""}.`,
    duplicate: (name: string) => `You already train these settings in ${name}`,
    duplicateMeta: (hands: number, score: string) => `${num(hands)} hands · score ${score}`,
    continueIt: "Continue it",
    changeSettings: "Change settings",
    locked: "Settings are fixed for this session",
    periods: { today: "Today", all: "All" } as Record<string, string>,
    hands: "Hands",
    score: "Score",
    playedAgain: "Played again",
    spots: (n: number) => `${num(n)} ${n === 1 ? "spot" : "spots"}`,
    rightNow: (share: number) => `${pct(share)} right now`,
    mistakesFirst: "Spots you got wrong come back first.",
    repeatLabel: "Repeat played spots",
    repeats: { off: "Off", some: "Sometimes", often: "Often" } as Record<string, string>,
    repeatHints: {
      off: "Every spot is new.",
      some: "About one spot in six comes back from this session, your mistakes first. After the answer you see what you played then.",
      often: "About one spot in three comes back from this session, your mistakes first. After the answer you see what you played then.",
    } as Record<string, string>,
    seen: {
      title: "You have played this spot before",
      same: "same cards, same spot",
      better: "Better than last time",
      worse: "Worse than last time",
      unchanged: "Same as last time",
      now: "Now",
    },
    names: {
      anySeat: "Any seat",
      firstIn: (seat: string) => `${seat} first in`,
      versus: (seat: string, vs: string, what: string) => `${seat} vs ${vs}${what ? ` ${what}` : ""}`,
    },
    when: {
      today: (time: string) => `Today ${time}`,
      yesterday: (time: string) => `Yesterday ${time}`,
    },
    reviewing: {
      inDays: (days: number) => `in ${num(days)} ${days === 1 ? "day" : "days"}`,
      perHand: (bb: number) => `−${num(bb, 3)} bb a hand`,
      bestStreak: "Best streak",
      chart: "Score per 20 hands",
      chartRange: (hands: number) => `hand 1 → ${num(hands)}`,
      groups: { type: "Hand type", best: "Best move", seat: "Seat", street: "Street", day: "Day" } as Record<string, string>,
      groupLabel: "Group by",
      groupHint: "Hands · score · EV lost. Click a row to filter the hands.",
      filters: { all: "All", bad: "Mistakes and blunders", inaccurate: "Inaccurate", ok: "Perfect and good" } as Record<string, string>,
      again: "Played more than once",
      count: (n: number) => `${num(n)} ${n === 1 ? "hand" : "hands"}`,
      cols: { when: "When", hand: "Hand", move: "Your move", best: "Best", grade: "Grade", ev: "EV lost", times: "×" },
      every: "Every time you played it",
      playAgain: "Play it again",
      noMatch: "No hands match.",
      empty: "No answers in this session yet.",
      handTypes: {
        pairs: "Pairs",
        aces: "Ax",
        broadway: "Broadways and Kx",
        suited: "Suited connectors and gappers",
        other: "Other hands",
      } as Record<string, string>,
    },
  },
  dealing: "Dealing…",
  solving: "Solving…",
  loadingFlop: "Loading the flop…",
  grading: "Grading…",
  noSpot: "No spot matches these settings. Loosen one and try again.",
  unavailable: {
    flop: "Flop spots need a flop library solved on the GTO Wizard ranges; there is none yet.",
    set: "This table is not transcribed from GTO Wizard yet: nothing to deal from it. Pick another table in the settings.",
  },
  failed: (message: string) => `Something went wrong: ${message}`,
  retry: "Try again",

  potOf: (value: number) => `Pot ${bb(value)}`,
  /** Lost EV, signed: "−4.20 bb", "0.00 bb". */
  lostBb: (value: number) => `${value > 0 ? "−" : ""}${num(value, 2)} bb`,
  toCall: (value: number) => `${bb(value)} to call`,
  stack: (value: number) => `${bb(value)} behind`,
  yourMove: "Your move",
  board: { flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>,

  next: "Next hand",
  /** "Look up in Solver" after an answer (#420): the Solver at this spot; the session waits where it was. */
  solver: {
    open: "Look up in Solver",
    title: "Open the Solver at this spot. Back in the Trainer, the session goes on from here.",
    looking: "Finding the spot…",
    none: "The Solver has no spot here.",
  },
  autoNext: "Next hand in a moment…",
  stay: "Stay",
  you: (label: string) => `You: ${label}`,
  best: (label: string) => `Best: ${label}`,
  evLost: (value: number) => `−${num(value, 2)} bb`,
  noLoss: "No EV lost",
  inStrategy: (share: number) => `played ${pct(share)} of the time`,
  notInStrategy: "never played here",
  strategyHeading: "What the solver does with this hand",
  evHeading: "EV",
  whyHeading: "Why",
  ruleOfThumb: "Rule of thumb",
  /** Details (#424): the size against the other options, and a river bluff's blockers (`lib/training/details.ts`). */
  details: {
    /** `label` gives an option's label (`Bet 5.8 bb (33%)`) by its index. */
    sizing: (note: import("../../training/details").SizingNote, label: (index: number) => string): string => {
      const low = (index: number) => {
        const text = label(index);
        return text.charAt(0).toLowerCase() + text.slice(1);
      };
      const worth = (value: number) => `${num(value, 2)} bb`;
      const bet = note.raise ? "raise" : "bet";
      switch (note.kind) {
        case "size-better":
          return `${label(note.better)} is the better size: it earns ${worth(note.bb)} more than your ${low(note.chosen)}.`;
        case "size-best":
          return note.bb > 0
            ? `Your size is the best of the ${bet}s here: it earns ${worth(note.bb)} more than ${low(note.next)}.`
            : `Your size and ${low(note.next)} are worth the same here.`;
        case "passive-better":
          return `${label(note.passive)} beats ${note.sizes > 1 ? `every ${bet}` : `the ${bet}`} here: it earns ${worth(note.bb)} more than ${low(note.best)}${note.sizes > 1 ? ", the best size" : ""}.`;
        case "aggressive-better":
          return `${note.raise ? "Raising" : "Betting"} is better here: ${low(note.best)}${note.sizes > 1 ? ", the best size," : ""} earns ${worth(note.bb)} more than your ${low(note.chosen)}.`;
        case "passive-right":
          return note.bb > 0
            ? `${label(note.chosen)} is right here: the best ${bet}, ${low(note.best)}, earns ${worth(note.bb)} less.`
            : `${label(note.chosen)} and ${low(note.best)} are worth the same here.`;
      }
    },
    /** A river bluff's blockers: the good cards, the bad ones, then yours. */
    blockers: (b: import("../../training/details").BluffBlockers): string[] => {
      const suit = (code: string) => ({ s: "♠", h: "♥", d: "♦", c: "♣" })[code] ?? code;
      const card = (code: string) => `${code[0]}${suit(code[1])}`;
      const join = (items: string[], last: string) =>
        items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
      const group = (g: import("../../training/details").BlockerGroup) => {
        switch (g.kind) {
          case "flush":
            return `${join(g.cards.map(card), "or")} (the flushes)`;
          case "straight":
            return `${join(g.ranks, "or")} (the straight)`;
          case "top-pair":
            return `${join(g.ranks, "or")} (top pair)`;
          case "missed-flush":
            return `any ${suit(g.suit)} (the missed flush draws)`;
          case "missed-straight":
            return `${join(g.ranks, "or")} (the missed straight draws)`;
        }
      };
      const out: string[] = [];
      if (b.good.length > 0) out.push(`Good cards to bluff with take away hands that call: ${b.good.map(group).join("; ")}.`);
      if (b.bad.length > 0) out.push(`Bad ones take away hands that would fold: ${b.bad.map(group).join("; ")}.`);
      const good = join(b.mine.good.map(card), "and");
      const bad = join(b.mine.bad.map(card), "and");
      const goodIs = b.mine.good.length === 1 ? "is a good blocker" : "are good blockers";
      const badIs = b.mine.bad.length === 1 ? "is a bad blocker" : "are bad blockers";
      if (good && bad) out.push(`Your ${good} ${goodIs}, your ${bad} ${badIs}.`);
      else if (good) out.push(`Your ${good} ${goodIs}.`);
      else if (bad) out.push(`Your ${bad} ${badIs}.`);
      else out.push("Neither of your cards is one of them.");
      return out;
    },
    /** Anything but a river bluff: what the cards remove, as before. */
    blocks: (names: string[]) =>
      `Your cards block ${names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`}.`,
  },
  principles: {
    rfi: "First in, the fewer players left behind you, the wider you open: from the early seats only hands that stay strong against several ranges, from the button and the small blind far more. Suited, connected hands and pairs open before offsuit hands of the same rank, because they make strong hands and play well after the flop.",
    "vs-open": "Facing an open, the reference mostly 3-bets or folds and calls with a narrower band: hands that play well after the flop, more of them in position. Every seat still behind you can squeeze, and a flat call leaves you with a capped range.",
    "vs-open-sb": "The small blind plays close to 3-bet or fold: a call is out of position for the whole hand, invites the big blind to squeeze, and closes nothing. 3-bet the hands that want a pot and the ones that block the opener's best hands; let the rest go.",
    "vs-open-bb": "The big blind already has a blind in and closes the action: the price is good and no one can squeeze behind, so it defends wide, mostly by calling. Fold only what cannot realise its equity out of position; 3-bet the top and some suited blockers.",
    "vs-3bet": "Against a 3-bet, continue with hands that beat the 3-bettor's value or play well as a call (pairs, suited broadways, suited connectors in position). 4-bet the strongest and a few hands with an ace or king blocker; fold the offsuit hands that are dominated.",
    squeeze: "With an open and a caller in front, squeeze tighter than a plain 3-bet but polarised: strong hands for value and a few blockers as bluffs. The caller's range is capped and the opener is squeezed between two players, so the pot is often yours right away.",
    bvb: "Blind against blind the ranges are the widest of the game: nobody is left behind, so the small blind attacks with many hands and the big blind, in position, defends a lot. Hand strength matters less than position and playability here.",
    "vs-limp": "Against limpers, raise to isolate with hands that do well heads-up and in position; overlimp suited and connected hands that like a multiway pot; fold the offsuit hands that need fold equity you do not have.",
    "vs-4bet": "Facing a 4-bet, only the top of your range continues: jam the premium pairs and ace-king, call with the few hands that play well deep, and fold the rest, including most hands you 3-bet as bluffs.",
    "flop-cbet": "As the preflop raiser you usually hold the stronger range: on dry, high boards a small bet with most of your range wins a lot; on low, connected boards that hit the caller, check more and bet bigger with a polarised range.",
    "flop-check-to-raiser": "Out of position against the preflop raiser, check almost your whole range: the raiser has more strong hands on most flops. Leading out only makes sense on boards that clearly favour your range.",
    "flop-vs-bet": "Against a flop bet, defend enough that bluffs do not profit automatically (see minimum defence), with hands that can keep going on the turn: pairs, draws and good backdoors. Raise your strongest hands and your best draws; fold the hands with nothing to improve to.",
    "flop-vs-raise": "A flop raise is strong and polarised: continue with strong made hands and draws that can win big, and fold the one-pair hands that only beat bluffs.",
    "turn-barrel": "On the turn, keep betting on cards that improve your range (overcards, cards that complete draws you represent) and with hands that have equity; give up with air that missed. Value hands keep betting.",
    "turn-first": "As the caller on the turn, check most of your range to the raiser; bet out when the turn card shifts the advantage to you (it completes draws you call with, pairs low cards you hold).",
    "turn-vs-bet": "Facing a turn bet, the price and your equity still matter, but a draw has one card left: call with made hands that are ahead of enough bluffs and draws that get there often or get paid when they do.",
    "river-first": "On the river there is no more equity to fight for: bet for value with hands that worse hands call, bluff with hands that cannot win at showdown (best if they block the hands that call), and check the middle.",
    "river-vs-bet": "Facing a river bet you are a bluff-catcher: call when your hand beats enough of the bettor's bluffs to cover the pot odds. The best bluff-catchers block the bettor's value and do not block the bluffs.",
    "river-vs-raise": "River raises are rarely bluffs in practice and in theory are very polarised: continue with the hands near the top of your range and fold the rest.",
  } as Record<string, string>,
  notGraded: (reason: string) => `This answer could not be graded: ${reason}.`,
  learnMore: "Read more",

  play: {
    label: "How much of the hand",
    spot: "One spot",
    hand: "Whole hand",
    continue: "Continue",
    thinking: "The opponent is thinking…",
    starting: "Dealing a hand…",
    noHand: "No hand matches these settings. Loosen one and try again.",
    won: (bb: number) => `You won ${num(bb, 1)} bb`,
    lost: (bb: number) => `You lost ${num(bb, 1)} bb`,
    even: "You broke even",
    split: "Split pot",
    villainFolded: "The opponent folded",
    heroFolded: "You folded",
    showdown: "Showdown",
    noReference: "Rail has no reference for your next decision here, so the hand stops.",
    approximate: "Somewhere the opponent had no reference and checked or called instead.",
    summary: "This hand",
    evLostTotal: (bb: number) => `EV lost over the hand: ${num(bb, 2)} bb`,
    vs: (hero: string, villain: string) => `${hero} vs ${villain}`,
  },
  focus: {
    working: "Working on",
    costs: (per100: number) => `costs you ${num(per100, 2)} bb/100`,
    yourMistake: (taken: string, best: string) => `you ${taken} where ${best} is right`,
    nextArea: "Next leak",
    none: "No leaks in your analysed hands yet that the trainer can deal. Practising the spots most players misplay.",
    signIn: "Sign in and analyse your hands: the trainer then deals the spots where you lose the most.",
    loading: "Reading your leaks…",
    general: "Spots most players misplay",
  },

  /** The Trainer opened from Analytics (docs/ANALYTICS.md Step 9): the bar, the goal, the chips, a played hand. */
  analytics: {
    from: "From Analytics",
    back: "← Back to the stat",
    costs: (per100: number) => `costs you −${num(per100, 2)} bb/100`,
    approximate: "Rail cannot deal this exact spot, so it deals the nearest one.",
    /** The Hands chip: the classes the drill deals from. */
    hands: (action: string) => (action === "fold" ? "Hands you tend to fold" : "Hands from Analytics"),
    size: "Bet faced",
    facingSize: (size: string) => `Facing ${size} of the pot`,
    goal: "Goal from Analytics",
    rateHere: (action: string) => `Your ${ACTION_EN[action] ?? action} rate here`,
    target: "Solver",
    targetCharts: "Charts",
    drill: "This drill",
    drillRef: (value: string) => `reference ${value} on these hands`,
    few: "Answer a few hands",
    dealtFrom: (classes: string) => `Hands are dealt from the classes you got wrong: ${classes}.`,
    later: "Analytics shows whether the spot moved as new hands come in.",
    playIt: "Your hand, as you played it",
    playNote: "Dealt once from your own hand. The drill goes on after it.",
    playLoading: "Loading your hand…",
    playMissing: "This hand could not be loaded. The drill goes on.",
    playOn: "Go on with the drill",
  },

  session: {
    label: "This session",
    answers: "Hands",
    accuracy: "Correct",
    streak: "Streak",
    best: "Best",
    evLost: "EV lost",
    reset: "Reset",
  },
  keysHeading: "Shortcuts",
  keys: "1–6 answer · F fold · C call / check · A all-in · N next · S settings",

  /** The short why (`lib/training/brief.ts`): headline, what the play is worth, points, example hands. */
  brief: {
    roles: {
      value: "Value",
      thin: "Thin value",
      trap: "Value",
      "too-thin": "Too thin",
      showdown: "Showdown value",
      "bluff-catcher": "Bluff-catcher",
      bluff: "Bluff",
      "give-up": "No bluff",
      weak: "Too weak",
      protect: "Ahead, vulnerable",
      vulnerable: "Ahead, vulnerable",
      "semi-bluff": "Semi-bluff",
      draw: "Draw",
      medium: "Middling hand",
      open: "Open",
      "three-bet": "3-bet",
      "four-bet": "4-bet",
      defend: "Defend",
    } as Record<string, string>,
    plays: {
      "bet-small": "bet small",
      "bet-big": "bet big",
      raise: "raise",
      allin: "all-in",
      check: "check",
      call: "call",
      fold: "fold",
    } as Record<string, string>,
    head: (role: string | null, play: string | null) =>
      role && play ? `${role} — ${play}` : role ? role : play ? play.charAt(0).toUpperCase() + play.slice(1) : "",
    /** `best` and `other` are option labels (`Bet 3 bb (33%)`). */
    gain: (kind: "over-yours" | "found" | "equal", best: string, other: string, value: number) => {
      const low = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);
      const worth = `+${num(value, 2)} bb`;
      if (kind === "over-yours") return { before: `${best} earns `, value: worth, after: ` more than your ${low(other)}.` };
      if (kind === "found") return { before: `You found it: ${low(best)} earns `, value: worth, after: ` more than ${low(other)}.` };
      return { before: `${best} and ${low(other)} are worth the same here.`, value: "", after: "" };
    },
    point: (p: import("../../training/brief").BriefPoint): { lead: string; text: string } => {
      const names = (list: string[], words: Record<string, string>) => list.map((x) => words[x] ?? x).join(", ");
      switch (p.kind) {
        case "beats":
          return { lead: `Beats ${pct(p.beats)}`, text: "of their range." };
        case "price":
          return { lead: `You need ${pct(p.need)}`, text: p.have !== null ? `to call; you have ${pct(p.have)}.` : "to call." };
        case "equity":
          return { lead: `${pct(p.equity)} equity`, text: "against their range." };
        case "polar":
          return { lead: "Their range is polar:", text: `${pct(p.strong)} strong, ${pct(p.weak)} weak.` };
        case "merged":
          return { lead: "Their range is merged:", text: `${pct(p.medium)} middling hands.` };
        case "removes":
          return {
            lead: p.strong > p.weak ? "You block their strong hands:" : "You block their weak hands:",
            text: `${pct(p.strong)} of the strong, ${pct(p.weak)} of the weak.`,
          };
        case "blockers":
          return { lead: "You block", text: `${names(p.blockers, analysisEn.handFacts.blockers)}.` };
        case "rivers-weak":
          return { lead: `${pct(p.share)} of rivers`, text: "turn your hand into a loser." };
        case "rivers-strong":
          return { lead: `${pct(p.share)} of rivers`, text: "make your hand strong." };
        case "draws":
          return { lead: "Draws:", text: `${names(p.draws, analysisEn.handFacts.draws)}.` };
        case "spr":
          return { lead: `SPR ${num(p.spr, 1)}:`, text: "the next bet commits you." };
        case "capped":
          return { lead: "Capped at Mistake:", text: "the ranges are estimated." };
        case "estimate":
          return { lead: "An estimate:", text: "multiway, not solved." };
      }
    },
    groups: {
      value: "Value",
      thin: "Thin value",
      bluff: "Bluffs",
      raise: "Raise",
      bet: "Bet",
      call: "Call",
      check: "Check",
      fold: "Fold",
    } as Record<string, string>,
    showHand: (hand: string) => `Show ${hand} in the range`,
    evOf: (label: string) => `EV of ${label.charAt(0).toLowerCase() + label.slice(1)}`,
    details: "Details",
    examples: "Example hands",
  },
  /** The range grid's hover: a class, then its combos. */
  zoom: {
    combos: (n: number) => `${num(n)} ${n === 1 ? "combo" : "combos"}`,
    you: "you",
    actions: { bet: "Bet", raise: "Raise", allin: "All-in", check: "Check", call: "Call", fold: "Fold" } as Record<string, string>,
  },

  /** The analysis' own words, so a trainer answer reads like a graded decision of a real hand. */
  words: {
    grades: analysisEn.grades,
    option: analysisEn.sheet.option,
    chartAction: analysisEn.charts.action,
    details: analysisEn.details,
    reasons: analysisEn.reasons,
    handFacts: analysisEn.handFacts,
    lineName: courseEn.spot.lineName,
    leakTitle: leaksEn.title,
    leakContext: leaksEn.fullContext,
    leakActions: leaksEn.actions,
  },
};
