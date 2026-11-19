/**
 * Free and Pro as the reader meets them: the pricing page (`/pricing`), its
 * confirmation before Stripe Checkout, the pages Checkout returns to, and the
 * Free-tier touch points (the locks, the bar's Upgrade, the solver's flops a
 * day). English, the source locale.
 */
export const pricingEn = {
  metaTitle: "Pricing — Free and Pro | Rail",
  metaDescription:
    "Rail is free: upload, convert, replay and share hands, basic statistics and the solver's preflop charts. Pro adds full reports, analysis, the HUD and unlimited flops.",

  periods: { month: "Monthly", half_year: "6 months", year: "Yearly" },
  /** The period switch's label, for screen readers. */
  periodLabel: "Billing period",
  youAreOn: (plan: string) => `You are on ${plan}.`,
  free: "Free",
  pro: "Pro",
  zero: "$0",
  forever: "forever",
  perMonth: " / month",
  bill: {
    month: "Billed monthly",
    half_year: (price: string) => `${price} every 6 months`,
    year: (price: string) => `${price} once a year`,
  },
  currentPlan: "Current plan",
  upgrade: "Upgrade to Pro",
  soon: "Paid plans open soon",
  manage: "Manage subscription",
  plansLabel: "Plans",
  included: "Included",
  notIncluded: "Not included",

  groups: { hands: "Hands", statistics: "Statistics", desktop: "Desktop app", study: "Study" },
  rows: {
    upload: { label: "Upload, convert and replay", note: "Every supported room, manual entry too" },
    perDay: { label: "Hands saved per day", note: "Web upload and desktop sync together" },
    library: { label: "Hand library" },
    deleteHands: { label: "Delete hands", note: "One, a selection or all of them" },
    share: { label: "Share hands, forum, polls" },
    graph: { label: "Results graph and basic statistics" },
    reports: { label: "Full reports", note: "Situations, sessions, opponents" },
    players: { label: "Players", note: "Profiles of everyone you played" },
    desktopImport: { label: "Import and hands on your computer" },
    sync: { label: "Sync with the web" },
    tiling: { label: "Table tiling and RNG" },
    hud: { label: "HUD" },
    solver: { label: "Solver", note: "Any turn and river on the flops you open; preflop charts always open" },
    nodelock: { label: "Nodelock", note: "Lock a strategy and solve again" },
    analysis: { label: "Analysis", note: "Leaks, session review, plan, progress, your charts" },
    trainer: { label: "Trainer", note: "Drills from your own spots" },
    review: { label: "Review queue", note: "Hands you mark are solved first" },
  },
  cells: {
    hands: (count: string) => count,
    library: (count: string) => `${count} hands`,
    flops: (count: string) => `${count} flops a day`,
    unlimited: "Unlimited",
  },
  foot: {
    cancel: "Cancel any time",
    keep: "Your hands stay if you go back to Free",
    tax: "Prices in USD, tax at checkout",
  },

  /** The sign-in dialog's line when a signed-out visitor picks Pro. */
  signInReason: (period: string, price: string) => `Sign in to get Pro · ${period} · ${price}`,

  confirm: {
    title: "Rail Pro",
    today: "Today",
    then: {
      month: (price: string) => `Then ${price} every month until you cancel.`,
      half_year: (price: string) => `Then ${price} every 6 months until you cancel.`,
      year: (price: string) => `Then ${price} every year until you cancel.`,
    },
    tax: "Tax from your billing address is added on the next page.",
    pay: "Continue to payment",
    cancel: "Not now",
  },

  success: {
    waiting: "Turning on Pro…",
    waitingNote: "Usually a few seconds.",
    slow: "This is taking longer than usual. Your plan updates by itself; you can leave this page.",
    done: "You're on Pro",
    openAnalysis: "Open Analysis",
    getApp: "Get the desktop app",
    receipt: "Receipt sent to your email.",
  },
  cancel: {
    heading: "No payment was made",
    back: "Back to pricing",
  },

  /** The Free-tier touch points. */
  bar: { upgrade: "Upgrade", pricing: "Pricing" },
  lock: {
    see: "See Pro",
    /** One line per locked screen, under the Pro badge. */
    line: {
      analysis: "Find your leaks from your own hands",
      reports_full: "Every situation, session and opponent in your hands",
      learn: "Learn is part of Pro",
      desktop_sync: "Sync the desktop app with the web",
      hud: "Stats on your tables while you play",
      solver_unlimited: "Every flop, every day",
      nodelock: "Lock a strategy and solve again",
    },
    /** A locked control's tooltip: `X is part of Pro.` */
    tip: (what: string) => `${what} is part of Pro.`,
  },
  solver: {
    today: "Today's flops",
    count: (used: number, cap: number) => `${used} / ${cap}`,
    left: (n: number) => `${n} left`,
    open: (flop: string) => `Open ${flop}`,
    otherLine: "Not solved on this line",
    refused: (cap: number, time: string) =>
      `You've opened today's ${cap} flops. They stay open, with any turn and river, until ${time}. Every flop with Pro.`,
    signIn: (cap: number) => `Sign in to open flops. A free account opens ${cap} a day.`,
    signInButton: "Sign in",
    signInReason: "Sign in to open flops",
    nodelock: "Nodelock",
  },
} as const;
