/**
 * Plans and entitlements (Rail R6.2): Settings -> Plan, the Pro badge and the
 * lock on a Pro feature. English, the source locale.
 */
export const planEn = {
  heading: "Plan",
  loading: "Loading your plan…",
  unavailable: "Plans are not set up on this database yet. Everything keeps working.",
  loadFailed: "Your plan could not be loaded. Reload the page to try again.",

  name: { free: "Free", pro: "Pro" },
  badge: "Pro",

  current: (plan: string) => `Your plan: ${plan}`,
  notEnforced:
    "Rail is in early access: every feature is open to every account, and no limit applies. Paid plans are not on sale yet.",
  billedMonthly: "Billed monthly",
  billedYearly: "Billed yearly",
  status: {
    active: "Active",
    trialing: "Trial",
    past_due: "Payment overdue",
    canceled: "Canceled",
  },
  renews: (date: string) => `Renews on ${date}.`,
  endsOn: (date: string) => `Pro ends on ${date}.`,
  graceUntil: (date: string) => `The last payment did not go through. Pro stays on until ${date}.`,
  granted: "Pro, granted to this account.",

  usageHeading: "Your library",
  usage: (stored: string, cap: string) => `${stored} of ${cap} hands stored`,
  usageUnlimited: (stored: string) => `${stored} hands stored, no limit`,
  freeHolds: (cap: string) => `The Free plan holds ${cap} hands.`,
  full: "Your library is full. Upgrade to Pro to keep saving hands.",

  includedHeading: "What each plan includes",
  freeIncludes: "Free: the converter, the replayer, sharing, a library of up to the hand limit, basic statistics.",
  proIncludes:
    "Pro: an unlimited library, the desktop HUD and sync, full reports, analysis (session review, leaks, your own charts) and Learn.",

  early: (percent: number) =>
    `You joined early: you keep a ${percent}% lifetime discount on Pro for as long as you stay subscribed.`,

  upgrade: "Upgrade to Pro",
  upgradeSoon: "Paid plans open soon.",

  lock: {
    heading: "This is a Pro feature",
    body: {
      analysis: "Analysis - session review, leaks, your own charts and drills - is part of Pro.",
      learn: "Learn is part of Pro.",
      reports_full: "Full reports - situations, sessions, opponents and players - are part of Pro.",
      desktop_sync: "Syncing with the desktop app is part of Pro.",
      hud: "The desktop HUD is part of Pro.",
    },
    seePlan: "See your plan",
  },
} as const;
