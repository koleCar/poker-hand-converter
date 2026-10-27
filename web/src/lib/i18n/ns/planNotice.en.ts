/**
 * The plan's refusals and the Free cap, as the reader meets them (Rail R6.4):
 * the one upgrade prompt for a refused Pro feature (`PlanRefusalPrompt`) and
 * the converter's notices near and at the Free hand cap. English, the source
 * locale.
 */
export const planNoticeEn = {
  prompt: {
    /** A Pro feature was refused (the feature's sentence follows, `plan.lock.body`). */
    heading: "This is a Pro feature",
    generic: "Your plan does not include this.",
    capHeading: "Your library is full",
    cap: (cap: string) => `The Free plan holds ${cap} hands. Upgrade to Pro to keep saving hands.`,
    upgrade: "Upgrade to Pro",
    dismiss: "Not now",
  },
  converter: {
    /** Before or while saving, with little room left. */
    capNear: (left: string, cap: string) => `Your library has room for ${left} more hands on the Free plan (it holds ${cap}).`,
    capFull: (cap: string) => `Your library is full: the Free plan holds ${cap} hands. New hands are not saved until you upgrade to Pro.`,
    /** The save was cut to what fit. */
    trimmed: "Only the hands that fit in your Free library were saved.",
    /** Paused at the cap: everything that fit was saved. */
    pausedCap: (cap: string) =>
      `Saving stopped: your library is full on the Free plan (${cap} hands). Every hand that fit was saved; the rest wait in this tab. Upgrade to Pro, then try again.`,
    pausedPlan: "Saving stopped: your plan does not allow it. Upgrade to Pro, then try again.",
    upgrade: "Upgrade to Pro",
  },
} as const;
