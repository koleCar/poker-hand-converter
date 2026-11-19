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
    /** The day's Free hands are saved (`daily_cap`). */
    dailyHeading: "Today's hands are saved",
    daily: (cap: string) => `${cap} hands saved today — the rest saves after the reset, or now with Pro.`,
    upgrade: "See Pro",
    dismiss: "Not now",
  },
  converter: {
    /** Before or while saving, with little room left. */
    capNear: (left: string, cap: string) => `Your library has room for ${left} more hands on the Free plan (it holds ${cap}).`,
    capFull: (cap: string) => `Your library is full (${cap} hands on Free).`,
    /** Today's Free hands are saved (before or while saving). */
    daily: (cap: string) => `${cap} hands saved today — the rest saves after the reset, or now with Pro.`,
    /** The save was cut to what fit. */
    trimmed: "Only the hands that fit in your Free library were saved.",
    /** Paused at the cap: everything that fit was saved. */
    pausedCap: (cap: string) => `Your library is full (${cap} hands on Free). Every hand that fit was saved.`,
    pausedPlan: "Saving stopped: your plan does not allow it.",
    upgrade: "See Pro",
  },
} as const;
