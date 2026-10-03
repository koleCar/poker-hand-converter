/**
 * Strings for leaks and progress (phase A6), English: the leak finder
 * (`/analysis/leaks`), the progress charts (`/analysis/progress`) and the
 * overview's "what improved / what to work on" card. Spread into
 * `analysis.en.ts` as `analysis.leaks`, `analysis.progress` and
 * `analysis.summary`; `analysisLeaks.hr.ts` is the same shape.
 *
 * Every sentence is a template over numbers `lib/analysis/leaks.ts` computed
 * (§4 of the plan: testable, translatable, unable to invent a reason). A leak
 * is described from its parts — what was done, what the reference does, the
 * street, the scenario, the seats — and a part merging dropped is left out of
 * the sentence rather than guessed. Seats stay as players write them (UTG, HJ,
 * CO, BTN, SB, BB) in both languages.
 */

import type { Confidence, LeakKind, Mix, Trend } from "../../analysis/leaks";

/** Merging's "any" and a genuinely absent part (`ANY` / `NONE` in `leaks.ts`). */
const ANY = "*";
const NONE = "-";

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const hands = (count: number) => `${num(count)} ${count === 1 ? "hand" : "hands"}`;
const moves = (count: number) => `${num(count)} graded ${count === 1 ? "move" : "moves"}`;
const decisions = (count: number) => `${num(count)} ${count === 1 ? "decision" : "decisions"}`;
const mistakes = (count: number) => `${num(count)} ${count === 1 ? "mistake" : "mistakes"}`;
/** A share: one decimal under 10%, whole above. */
const pct = (value: number) => {
  const p = value * 100;
  return p > 0 && p < 10 ? `${num(Math.round(p * 10) / 10, 1)}%` : `${num(Math.round(p))}%`;
};
/** Big blinds, two decimals under 10, one above: "0.35 bb", "12.4 bb". */
const bb = (value: number) => `${num(value, Math.abs(value) < 10 ? 2 : 1)} bb`;
const score = (value: number) => num(value, 1);
const signed = (value: number, digits = 1) => {
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  return `${sign}${num(Math.abs(rounded), digits)}`;
};

const streets = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>;
const streetsIn = { preflop: "preflop", flop: "on the flop", turn: "on the turn", river: "on the river" } as Record<string, string>;
const actionWords = { fold: "Fold", check: "Check", call: "Call", bet: "Bet", raise: "Raise" } as Record<string, string>;

const kinds: Record<LeakKind, string> = {
  "fold-too-much": "Folding too much",
  "call-too-wide": "Calling too wide",
  "call-not-raise": "Calling instead of raising",
  "raise-too-wide": "Raising too wide",
  "raise-not-call": "Raising instead of calling",
  "check-not-bet": "Checking instead of betting",
  "bet-not-check": "Betting instead of checking",
  "check-not-raise": "Checking instead of raising",
  "wrong-size": "Betting the wrong size",
  "fold-free-check": "Folding when you could check",
  other: "Leaving the reference",
};

interface Where {
  street: string;
  scenario: string;
  family: string;
  hero: string;
  villain: string;
  /** `"9max"`: a full-ring chart spot (A2d), named with its table. */
  table?: string;
}

const known = (part: string) => part !== ANY && part !== NONE;

/** "Folding too much", with the preflop special cases players actually say. */
function title(kind: LeakKind, where: Where): string {
  if (where.street === "preflop") {
    if (kind === "raise-too-wide" && (where.scenario === "unopened" || where.family === "first-in")) return "Opening too wide";
    if (kind === "fold-too-much" && where.scenario === "unopened") return "Opening too tight";
    if (kind === "raise-too-wide") return "3-betting too wide";
    if (kind === "raise-not-call") return "Re-raising instead of calling";
    if (kind === "wrong-size") return "Raising the wrong size";
  } else if (kind === "raise-too-wide" && where.family === "first") {
    return "Betting too often";
  }
  return kinds[kind];
}

const roleWords = { pfr: "as the preflop raiser", caller: "as the preflop caller", limped: "in a limped pot" } as Record<string, string>;
const facingWords = { first: "first to act", "vs-bet": "facing a bet", "vs-raise": "facing a raise" } as Record<string, string>;

/** "BB vs BTN open", "CO first in"; a full-ring spot says so: "UTG first in (9-max)". */
function context(where: Where): string {
  const text = spotContext(where);
  return where.table === "9max" && known(where.hero) ? `${text} (9-max)` : text;
}

/** "BB vs BTN open", "CO first in", "as the preflop raiser, in position, first to act". */
function spotContext(where: Where): string {
  const hero = known(where.hero) ? where.hero : null;
  const villain = known(where.villain) ? where.villain : null;
  if (where.street === "preflop") {
    const who = hero ?? "";
    switch (where.scenario) {
      case "unopened":
        return hero ? `${hero} first in` : "First in";
      case "vs-open":
        return `${who ? `${who} ` : ""}vs ${villain ? `${villain} open` : "an open"}`.replace(/^vs/, "Vs");
      case "squeeze":
        return `${who ? `${who} ` : ""}vs ${villain ? `${villain} open` : "an open"} and a call`.replace(/^vs/, "Vs");
      case "vs-3bet":
        return `${who ? `${who} open ` : "Open "}vs ${villain ? `${villain} 3-bet` : "a 3-bet"}`;
      case "vs-3bet-cold":
        return `${who ? `${who} ` : ""}vs ${villain ? `${villain} 3-bet` : "a 3-bet"}, cold`.replace(/^vs/, "Vs");
      case "vs-4bet":
        return `${who ? `${who} ` : ""}vs ${villain ? `${villain} 4-bet` : "a 4-bet"}`.replace(/^vs/, "Vs");
      case "bb-option":
        return villain && villain !== "SB" ? `BB option after ${villain} limps` : "BB option after limps";
      case "vs-limp":
        return `${who ? `${who} ` : ""}vs ${villain ? `${villain} limp` : "limpers"}`.replace(/^vs/, "Vs");
      default:
        break;
    }
    if (where.family === "first-in") return "First in";
    if (where.family === "vs-raise") return "Facing an open";
    if (where.family === "vs-reraise") return "Facing a 3-bet or more";
    return "Any spot";
  }
  const match = /^(pfr|caller|limped)-(ip|oop)-(first|vs-bet|vs-raise)$/.exec(where.scenario);
  if (match) {
    const parts = [roleWords[match[1]], match[2] === "ip" ? "in position" : "out of position", facingWords[match[3]]];
    const text = parts.join(", ");
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}${hero ? ` (${hero})` : ""}`;
  }
  if (known(where.family)) {
    const text = facingWords[where.family] ?? where.family;
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  }
  return "Any spot";
}

/** "Fold 54% · Call 35% · Raise 12%", most frequent first, zeros left out. */
function mix(value: Mix): string {
  const total = Object.values(value).reduce((sum, n) => sum + n, 0);
  if (total === 0) return "—";
  return (Object.entries(value) as Array<[string, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([action, n]) => `${actionWords[action] ?? action} ${pct(n / total)}`)
    .join(" · ");
}

const confidence: Record<Confidence, string> = { low: "Low confidence", medium: "Medium confidence", high: "High confidence" };

const trends: Record<Trend, string> = {
  better: "Better",
  "leaning-better": "Leaning better",
  steady: "No clear change",
  "leaning-worse": "Leaning worse",
  worse: "Worse",
  "too-few": "Too few to tell",
};

/** What a trend word means, in a sentence: the honest part. */
const trendNotes: Record<Trend, string> = {
  better: "a change bigger than chance alone usually makes.",
  "leaning-better": "in the right direction, but chance alone could do this.",
  steady: "within what chance alone does.",
  "leaning-worse": "in the wrong direction, but chance alone could do this.",
  worse: "a change bigger than chance alone usually makes.",
  "too-few": "too few decisions in one of the periods to say.",
};

const dateRange = (from: string, to: string) => {
  const format = (iso: string) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${format(from)} – ${format(to)}`;
};

export const leaksEn = {
  heading: "Leaks",
  intro:
    "The spots that cost you the most EV against the reference: your graded decisions grouped by street, spot, seat and what you did instead of the reference's best move, the costliest first.",
  loading: "Finding your leaks…",
  notInstalledHeading: "Leaks are not set up on this database yet",
  notInstalledBefore: "They arrive with ",
  notInstalledAfter: ". Apply it and reload.",
  emptyHeading: "Nothing graded yet",
  emptyBody:
    "Leaks are built from graded decisions: preflop against our charts, the river against our solver. Run the analysis on your hands first.",
  goToAnalysis: "Go to your analysis",
  noneInScope: "No graded decision matches these filters.",
  noLeaks: "No spot in this sample cost more than a rounding error. Widen the filters, or play more hands.",
  sample: (graded: number, handCount: number) => `${moves(graded)} in ${hands(handCount)}`,
  total: (ev: number, per100: number, count: number) =>
    `${bb(ev)} lost in ${num(count)} ${count === 1 ? "leak" : "leaks"} — ${bb(per100)} per 100 hands.`,

  how: {
    toggle: "How leaks are found",
    title: "How leaks are found",
    spot: "A spot is a street, a scenario (first in, facing an open, the preflop raiser out of position facing a bet…), your seat and, preflop, the player you faced. A leak is one wrong turn in it: what you did where the reference's best move was something else — or the right move at the wrong size.",
    frequency:
      "Times in spot counts every graded decision you made there, right or wrong; mistakes are the ones graded worse than Perfect. EV lost is the sum of their EV loss against the reference's best move.",
    merge:
      "Spots you were in fewer than 10 times are merged into the next coarser spot — first the opponent's seat is dropped, then yours, then the exact scenario — so a handful of hands does not become a leak of its own. A merged row says so.",
    confidence:
      "Confidence is the sample: high needs 50 decisions in the spot and 5 mistakes, medium 20 and 2. A low-confidence leak may be one bad hand.",
    reference:
      "The reference is our 6-max 100 bb charts preflop and our solver on the river (on ranges narrowed by a model). Flop and turn decisions are not graded yet, so they cannot show up here.",
  },

  controls: {
    street: "Street",
    anyStreet: "Every street",
    sort: "Rank by",
    sorts: {
      ev: "Total EV lost",
      "per-spot": "EV lost per time in spot",
      mistakes: "Mistakes",
    } as Record<string, string>,
  },

  streets,
  streetsIn,
  actions: actionWords,
  kinds,
  title,
  context,
  /** "Folding too much — BB vs BTN open · Preflop" as one accessible name. */
  name: (titleText: string, contextText: string, street: string) => `${titleText} — ${contextText} · ${streets[street] ?? street}`,
  /** The context line, with what a partial merge gathers: "BB vs an open · other opponents", "Other spots". */
  fullContext: (where: Where, level: number, partial: boolean) =>
    !partial
      ? context(where)
      : level >= 4
        ? "Other spots"
        : `${context(where)} · ${level <= 1 ? "other opponents" : level === 2 ? "other seats" : "other spots"}`,

  columns: {
    leak: "Leak",
    evLost: "EV lost",
    per100: "per 100 hands",
    spot: "Times in spot",
    mistakes: "Mistakes",
    perMistake: "per mistake",
    confidence: "Confidence",
  },
  bb,
  pct,
  rank: (index: number) => `${num(index)}.`,
  evLost: (ev: number) => `${bb(ev)} lost`,
  per100: (value: number) => `${bb(value)} / 100 hands`,
  spotTimes: (mistakeCount: number, spotCount: number) => `${mistakes(mistakeCount)} in ${decisions(spotCount)}`,
  perMistake: (value: number) => `${bb(value)} per mistake`,
  confidence,
  confidenceHint: (spotCount: number, mistakeCount: number) =>
    `${decisions(spotCount)} in this spot, ${mistakes(mistakeCount)}`,
  showAll: (count: number) => `Show all ${num(count)} leaks`,
  showFewer: "Show fewer",
  expand: (name: string) => `Show details: ${name}`,

  detail: {
    /** The plain-language sentence a leak opens with. */
    describe: (contextText: string, streetIn: string, mistakeCount: number, spotCount: number, ev: number) =>
      `${contextText}, ${streetIn}: you left the reference's best move in ${num(mistakeCount)} of your ${decisions(spotCount)} here, losing ${bb(ev)}.`,
    youDid: "What you did here",
    referenceDoes: "What the reference does with your hands",
    mixNote:
      "Over every decision you made in this spot: your actions, and the reference's best move for the hand you held each time — the fair comparison, since your hands are not dealt from its range.",
    mix,
    best: (action: string) => `The reference's best move in this leak: ${actionWords[action] ?? action}.`,
    merged: (count: number) =>
      `Merged from ${num(count)} smaller ${count === 1 ? "spot" : "spots"}, each under 10 decisions on its own.`,
    partial: "Spots with enough hands of their own have their own row; this one gathers the rest.",
    numbers: "Numbers",
    seriousNote: (count: number) => `${num(count)} of them Inaccurate or worse.`,
    per100: (value: number) => `${bb(value)} per 100 hands`,
    perSpot: (value: number) => `${bb(value)} per time in the spot`,
    perMistake: (value: number) => `${bb(value)} per mistake`,
    lowNote: "Low confidence: a few hands, maybe one. Open them before changing anything.",
    drill: "Drill this",
  },

  hands: {
    heading: "Your hands in this spot",
    note: "Most EV lost first. Open one to replay it with the analysis on that decision.",
    loading: "Loading the hands…",
    empty: "No hand to show.",
    failed: (message: string) => `The hands did not load: ${message}`,
    open: (what: string) => `Open the hand: ${what}`,
    took: (action: string, best: string) => `${action}, best ${best}`,
    evLoss: (value: number) => `−${bb(value)}`,
    more: "More hands",
    total: (count: number) => `${hands(count)} in this leak`,
  },
};

export const progressEn = {
  heading: "Progress",
  intro:
    "Your score and the EV you lose per 100 hands over time, with how many moves were graded in each stretch — split by street, seat or pot type if you like. A stretch with few graded moves swings by chance; its points are hollow.",
  loading: "Reading your progress…",
  emptyHeading: "Nothing graded yet",
  emptyBody: "Progress is drawn from graded decisions. Run the analysis on your hands first.",
  goToAnalysis: "Go to your analysis",
  noneInScope: "No graded decision with a date matches these filters.",
  notEnough: "Two stretches with graded moves are needed to draw a line. Try a shorter bucket, or wider filters.",
  sample: (graded: number, buckets: number, bucketWord: string) => `${moves(graded)} in ${num(buckets)} ${bucketWord}`,

  controls: {
    bucket: "Group by",
    buckets: { week: "Week", month: "Month", session: "Session" } as Record<string, string>,
    bucketsPlural: { week: "weeks", month: "months", session: "sessions" } as Record<string, string>,
    group: "Split by",
    groups: { all: "Nothing", street: "Street", position: "Seat", pot_type: "Pot type" } as Record<string, string>,
    metric: "Show",
    metrics: { score: "Score", ev: "EV lost / 100 hands", off: "Moves off the reference" } as Record<string, string>,
  },
  sessionNote: (minutes: number) => `A session is hands no more than ${num(minutes)} minutes apart, across tables — the statistics screen's rule.`,

  charts: {
    score: "Score",
    scoreHint: "Mean over graded moves, 0–100, with its 95% interval",
    ev: "EV lost per 100 hands",
    evHint: "Against the reference's best move, in big blinds",
    off: "Moves off the reference",
    offHint: "Share of graded moves worse than Perfect",
    volume: "Graded moves",
    thin: (min: number) => `Hollow points: fewer than ${num(min)} graded moves.`,
    aria: (name: string, count: number) => `${name}, ${num(count)} points. The numbers are in the table below.`,
    keys: "Use the left and right arrow keys to move between points.",
    showNumbers: "Show the numbers",
    when: "When",
    moves: "Moves",
    hands: "Hands",
    interval: (low: number, high: number) => `95%: ${score(low)}–${score(high)}`,
  },
  score,
  /** A y-axis label: whole numbers bare, the rest to one decimal. */
  tick: (value: number) => num(value, Number.isInteger(value) ? 0 : 1),
  bb,
  pct,
  moves,
  dateRange,
  unknown: "Unknown",
  smallMultiplesNote: "One chart per group, the biggest first. Groups under 20 graded moves in all are left out.",
  left: (count: number) => `${num(count)} smaller ${count === 1 ? "group" : "groups"} left out.`,
};

export const summaryEn = {
  heading: "What changed",
  period: "Compare",
  periods: { 7: "Last 7 days", 30: "Last 30 days" } as Record<string, string>,
  loading: "Comparing…",
  failed: (message: string) => `The comparison did not load: ${message}`,
  none: "Nothing graded to compare yet.",
  /** "Your last 7 days of play (15 Feb – 21 Feb 2026) against the 7 days before: 512 graded moves against 372." */
  window: (days: number, from: string, to: string, current: number, prior: number) =>
    `Your last ${num(days)} days of play (${dateRange(from, to)}) against the ${num(days)} days before: ${moves(current)} against ${num(prior)}.`,
  anchorNote: "Counted back from the last day you played, not from today.",
  thin: (count: number) =>
    `Only ${moves(count)} in this period: read every line here as a hint, not a verdict.`,
  overall: (now: number, before: number) => `Score ${score(now)} against ${score(before)} (${signed(now - before)})`,
  street: (name: string, now: number | null, before: number | null) =>
    now !== null && before !== null
      ? `${name}: ${score(now)} against ${score(before)}`
      : `${name}: ${now !== null ? score(now) : "—"} against ${before !== null ? score(before) : "—"}`,
  trends,
  trendNotes,
  improvedHeading: "What improved",
  improvedNone: "Nothing improved clearly enough to call it. That is normal over a short stretch.",
  workHeading: "What to work on",
  workNone: "No leak cost anything worth naming in this period.",
  /** "Mistakes in 2% of spots (1 of 47), down from 7% (3 of 42)." */
  rate: (nowMade: number, nowN: number, beforeMade: number, beforeN: number) =>
    `Mistakes in ${nowN > 0 ? pct(nowMade / nowN) : "—"} of your decisions here (${num(nowMade)} of ${num(nowN)}), against ${
      beforeN > 0 ? pct(beforeMade / beforeN) : "—"
    } (${num(beforeMade)} of ${num(beforeN)}) before.`,
  cost: (ev: number, made: number, spot: number) => `${bb(ev)} lost, ${mistakes(made)} in ${decisions(spot)}.`,
  openLeak: (name: string) => `Open the leak: ${name}`,
  allLeaks: "All leaks",
  progress: "Progress over time",
};
