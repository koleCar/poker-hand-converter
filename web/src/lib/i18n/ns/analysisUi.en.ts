/**
 * Strings for the redesigned Analysis screens (2026-11): the section tabs and
 * the overview's compact parts. Short on purpose — the screens are for
 * players who know the words. `analysisUi.hr.ts` is the same shape.
 */

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const uiEn = {
  nav: {
    label: "Analysis",
    overview: "Overview",
    session: "Sessions",
    leaks: "Leaks",
    progress: "Trends",
    reports: "Reports",
    train: "Train",
    charts: "Charts",
    concepts: "Concepts",
  },
  run: {
    behind: (count: number) => `${num(count)} new`,
    stale: (count: number) => `${num(count)} to update`,
    analyse: "Analyse",
    update: "Update",
    running: (done: number, total: number) => `Analysing ${num(done)} / ${num(total)}`,
    stop: "Stop",
    recent: (count: number) => `Latest ${num(count)}`,
    all: "All",
    failed: "Analysis failed",
  },
  scope: {
    position: "Seat",
    pot: "Pot",
    any: "All",
  },
  kpi: {
    outOf: "/100",
    score: "Score",
    evLost: "EV lost",
    per100: "bb/100",
    mistakes: "Mistakes",
    graded: "Graded moves",
    gradedOf: (hands: number) => `${num(hands)} hands`,
  },
  grades: {
    label: "Grades",
    clear: "Clear",
    filter: (grade: string, share: string) => `Show hands whose worst move is ${grade} (${share})`,
  },
  heat: {
    title: "Where the EV goes",
    rows: { position: "Position", pot: "Pot type" },
    metrics: { ev: "EV lost", score: "Score", mistakes: "Mistake %" },
    low: "Low",
    high: "High",
    hint: "Click a cell to filter the hands",
    decisions: (count: number) => `${num(count)} dec.`,
    cell: (row: string, street: string, ev: string, score: string, mistakes: string, graded: number) =>
      `${row} · ${street}: ${ev} bb/100 lost, score ${score}, ${mistakes} mistakes in ${num(graded)} graded moves`,
    none: "Nothing graded here yet",
  },
  hands: {
    title: "Hands",
    count: (count: number) => `${num(count)}`,
    cols: { hand: "Hand", pos: "Pos", spot: "Spot", line: "Line", worst: "Worst", evLost: "EV lost", result: "Result", when: "When" },
    more: "More filters",
    clear: "Clear",
    empty: "No hands here",
  },
  empty: { upload: "Upload hands" },
  charts: { label: "Whose charts", rail: "Rail", mine: "Mine" },
  side: {
    topLeaks: "Top leaks",
    allTime: "all time",
    allLeaks: "All leaks",
    drills: "Drills due",
    now: "now",
    train: "Train",
    week: "This week",
    tasks: (done: number, total: number) => `${done} / ${total}`,
    buildPlan: "Build this week's plan",
  },
};
