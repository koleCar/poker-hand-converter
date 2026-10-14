/**
 * The statistics words both surfaces show, English: the statistic tile's
 * (`StatTileStrings`), the statistics table's (`StatTableStrings`) and the
 * win-rate graph's (`WinrateGraphStrings`, with the three `stats.common`
 * words it reads). Data, like `replayer.en.ts`: the web's
 * `lib/i18n/ns/stats.en.ts` takes these blocks from here (R2.7b moved them;
 * the text is unchanged) and the desktop app hands them to
 * `UiStringsProvider`. `stats.hr.ts` is the same shape.
 */

const num = (value: number) => value.toLocaleString("en-GB");
/** "1,234 hands". */
const hands = (count: number) => `${num(count)} ${count === 1 ? "hand" : "hands"}`;

export const statsUiEn = {
  hands,
  /** Column and field heading. */
  handsHead: "Hands",
  /** An amount already formatted, in big blinds: "+12.5 bb". */
  bb: (amount: string) => `${amount} bb`,
  /** A figure without an interval: its sample, already formatted (the web's `stats.hud.sample`). */
  sampleOnly: (n: string) => `n = ${n}`,

  tile: {
    /** By the shared reliability level (`lib/stats/reliability.ts`): the sample against the statistic's minimum. */
    reliability: {
      ok: "Enough sample — this number is stable.",
      low: "Moderate sample — the shape is real, the decimal is not.",
      insufficient: "Small sample — read this as a hint, not a measurement.",
    },
    noOpportunities: "no opportunities",
    /** Bounds already formatted, without the percent sign. */
    interval: (low: string, high: string) => `95% confidence interval ${low}% to ${high}%`,
    /** A value's tooltip: the sample and the interval, all already formatted. */
    sample: (n: string, low: string, high: string) => `n = ${n}, 95% CI ${low}–${high}%`,
    noSample: "no sample",
  },

  table: {
    statistic: "Statistic",
    value: "Value",
    sample: "Sample",
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
