/**
 * Strings for sharing a hand's analysis (A7.1), English: the owner's switch,
 * the read-only Analysis sheet a stranger sees on a published hand, a thread
 * or a share link, and the reference answer beside a poll's votes. Spread
 * into `analysis.en.ts` as `analysis.share`; `analysisShare.hr.ts` is the
 * same shape.
 */

export const shareEn = {
  toggle: {
    label: "Share this hand's analysis",
    explain:
      "Off by default. When it is on, anyone who can see this hand on Rail also sees its grades, the reference's options and the explanations: on its published page, in its forum thread, in a “What would you do?” poll once they have answered, and through share links you made. Only this hand: your other hands, your stats and your reports stay private.",
    pollNote: "In a poll, readers see the reference answer only after they vote.",
    notAnalysed:
      "This hand has no saved analysis at the current version, so there is nothing to show yet. Run the analysis on the Analysis tab.",
    saving: "Saving…",
    shared: "Shared: the analysis shows wherever this hand is public.",
    private: "Private: only you see this analysis.",
    failed: (message: string) => `Could not save: ${message}`,
  },

  /** The read-only sheet on a public page. */
  sheet: {
    note: "Shared by the player who posted this hand. The explanations speak to them as “you”.",
    heroMove: "Hero's move",
    decisionsHeading: "The hero's decisions",
    noDecisions: "The hero made no decision in this hand.",
    heroHand: "Hero's hand",
    /** The shared row is from an earlier analysis version: the owner has not re-run it since (A5a). */
    stale: (version: string) =>
      `Analysed with an earlier version (${version}); the player has not brought it up to date yet, so newer grades (such as the turn's) are missing.`,
  },

  /** A poll's reference answer, after the reveal. */
  poll: {
    heading: "The reference answer",
    intro: "How the reference plays this spot with the hero's hand, beside how readers answered.",
    heroGraded: "The hero's move:",
    reference: (freq: string, ev: string) => `Reference ${freq} · EV ${ev}`,
    bestSize: (label: string) => `best: ${label}`,
    notInReference: "The reference has no such option here",
    notGraded: "The polled decision was not graded, so there is no reference answer to show.",
    authorHint: "Share this hand's analysis to show the reference answer here, to readers who have answered.",
  },
};
