/**
 * Strings for the study plan (phase A8b), English: `/analysis/plan` and the
 * overview's plan card. Spread into `analysis.en.ts` as `analysis.plan`;
 * `analysisPlan.hr.ts` is the same shape.
 *
 * A focus area is named with the leak finder's own words (`analysis.leaks`:
 * its title, context and street), so a spot reads the same on Leaks and in
 * the plan. Every number is one `lib/training/plan.ts` computed; the
 * retrospective's trend words are A6's (`analysis.summary`), never stronger
 * than the sample.
 */

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const bb = (value: number) => `${num(value, Math.abs(value) < 10 ? 2 : 1)} bb`;
const count = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;
const moves = (n: number) => count(n, "graded move", "graded moves");
const decisions = (n: number) => count(n, "decision", "decisions");
const mistakes = (n: number) => count(n, "mistake", "mistakes");

/** "28 Sep – 4 Oct 2026": local days (a plan week), or UTC days (A6's windows). */
const dayRange = (from: string, toExclusive: string, utc = false) => {
  const last = new Date(Date.parse(toExclusive) - 1);
  const zone = utc ? { timeZone: "UTC" } : {};
  const short = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...zone });
  const long = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", ...zone });
  return `${short(new Date(from))} – ${long(last)}`;
};

const roles = { pfr: "as the preflop raiser", caller: "as the preflop caller" } as Record<string, string>;
const sides = { ip: "in position", oop: "out of position" } as Record<string, string>;
const pots = { srp: "single-raised pots", "3bp": "3-bet pots", limped: "limped pots" } as Record<string, string>;

export const planEn = {
  heading: "Study plan",
  intro:
    "What to work on this week, and how: the spots that cost you the most against the reference, each with what to read, what to play in the trainer, your drills and your own hands to review. A new plan is built from your latest analysis every Monday.",
  loading: "Reading your plan…",
  building: "Building this week's plan from your leaks…",
  failed: (message: string) => `The plan did not load: ${message}`,
  saveFailed: (message: string) => `The plan could not be saved: ${message}`,
  tickFailed: (message: string) => `That tick was not saved: ${message}`,
  tryAgain: "Try again",
  notInstalledHeading: "Study plans are not set up on this database yet",
  notInstalledBefore: "They arrive with ",
  notInstalledAfter: ". Apply it and reload.",

  week: (from: string, toExclusive: string) => `Week of ${dayRange(from, toExclusive)}`,
  daysLeft: (days: number) => (days <= 1 ? "Last day of the week" : `${num(days)} days left`),
  progressLabel: "This week's progress",
  progress: (done: number, total: number) => `${num(done)} of ${count(total, "task", "tasks")} done`,
  builtOn: (date: string) => `Built ${new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}.`,
  rebuild: "Rebuild from my latest analysis",
  rebuilding: "Rebuilding…",
  rebuildNote: "Tasks that stay in the plan keep their ticks.",
  staleVersion: (planVersion: string, current: string) =>
    `This plan was built from grades at ${planVersion}; your analysis is now ${current}. Rebuild it to plan from the new grades.`,
  autoNote:
    "Trainer spots and drills tick themselves as you play them this week; concepts and hands you tick yourself. You can tick anything by hand.",

  focusHeading: "This week's focus",
  focusIntro: (areas: number) =>
    areas === 1
      ? "The one spot your sample can point to with some confidence, and what to do about it."
      : `The ${num(areas)} spots that cost you the most EV, the ones your sample can vouch for first.`,
  area: {
    label: (index: number) => `Focus ${num(index)}`,
    why: "Why it matters",
    numbers: (ev: number, per100: number, mistakeCount: number, spot: number) =>
      `${bb(ev)} lost, ${bb(per100)} per 100 hands: ${mistakes(mistakeCount)} in your ${decisions(spot)} here.`,
    leak: (title: string, ev: number, mistakeCount: number) => `${title}: ${bb(ev)} (${mistakes(mistakeCount)})`,
    tentative: "Tentative",
    tentativeNote:
      "Few hands here: this may be a couple of bad hands rather than a leak. Review them before changing anything.",
    weeks: (weeks: number) => `Week ${num(weeks)} in focus`,
    openLeak: "See it on Leaks",
    checklist: "This week",
  },

  tasks: {
    read: "Read",
    train: (target: number, what: string) => `Play ${count(target, "trainer spot", "trainer spots")}: ${what}`,
    trainPreflop: (family: string, seat: string | null, vs: string | null) =>
      [family, seat ? `as ${seat}` : null, vs ? `against ${vs}'s raise` : null].filter(Boolean).join(", "),
    trainRiver: (role: string | null, side: string | null, pot: string | null) => {
      const parts = [role ? roles[role] : null, side ? sides[side] : null, pot ? `in ${pots[pot]}` : null].filter(Boolean);
      return parts.length > 0 ? `river, ${parts.join(", ")}` : "any river";
    },
    drill: (target: number) => `Clear ${count(target, "due drill", "due drills")} from this spot`,
    drillAll: (target: number) => `Clear ${count(target, "due drill", "due drills")}`,
    review: "Review your hand",
    reviewDetail: (cards: string, position: string | null, ev: number | null, date: string | null) =>
      [cards || null, position, ev !== null && ev > 0 ? `−${bb(ev)}` : null, date].filter(Boolean).join(" · "),
    reviewUnknown: "one of your hands",
    counted: (n: number, target: number) => `${num(Math.min(n, target))} of ${num(target)}`,
    dueNow: (n: number) => (n > 0 ? `${num(n)} due now` : "none due now"),
    play: "Play",
    openPage: "Open",
    drillLink: "Drill",
    openHand: "Open the hand",
    /** A task's link, named with its task: "Play — Play 10 trainer spots: …". */
    linkLabel: (action: string, task: string) => `${action} — ${task}`,
  },

  fundamentals: {
    heading: "Start with the fundamentals",
    none: "No graded hands yet, so there is no leak to plan around. Until there is, these are the basics every leak builds on.",
    few: (moveCount: number, needed: number) =>
      `Only ${moves(moveCount)} so far: too few to tell a leak from chance. Until you have ${num(needed)} or more, start with the basics.`,
    noLeaks: "No spot cost you enough to plan a week around. Keep the basics sharp.",
    goToAnalysis: "Analyse your hands",
  },

  retro: {
    heading: "Last week",
    finished: (done: number, total: number, from: string, toExclusive: string) =>
      `Last week's plan (${dayRange(from, toExclusive)}): ${num(done)} of ${count(total, "task", "tasks")} done.`,
    first: "This is your first plan, so there is no last week to look back on. Here is how your recent play compares instead.",
    planWeek: (from: string, toExclusive: string, current: number, prior: number) =>
      `Your graded play during last week's plan (${dayRange(from, toExclusive)}) against the week before: ${moves(current)} against ${num(prior)}.`,
    lastPlay: (from: string, toExclusive: string, current: number, prior: number, afterPlan: boolean) =>
      `${afterPlan ? "You played no graded hands during last week's plan, so here are " : ""}${
        afterPlan ? "your" : "Your"
      } last 7 days of play (${dayRange(from, toExclusive, true)}) against the 7 days before: ${moves(current)} against ${num(prior)}.`,
    anchorNote: "Counted back from the last day you played, not from today.",
    per100: (now: number | null, before: number | null) =>
      `EV lost here: ${now === null ? "—" : bb(now)} per 100 hands, against ${before === null ? "—" : bb(before)}.`,
    nothing: "No graded hands to compare yet.",
    areasHeading: (focusFromLastWeek: boolean) => (focusFromLastWeek ? "Last week's focus" : "This week's focus, recently"),
  },

  card: {
    heading: "This week's plan",
    none: "No plan for this week yet. It takes a moment to build from your leaks.",
    build: "Build this week's plan",
    open: "Open your plan",
    fundamentals: "The fundamentals",
    focus: (names: string) => `Focus: ${names}.`,
  },
};
