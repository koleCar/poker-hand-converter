/**
 * `/download` and the bar's "Get the app": the Rail desktop app for macOS and
 * Windows. English, the source locale.
 */
export const downloadEn = {
  metaTitle: "Download the Rail app for macOS and Windows | Rail",
  metaDescription:
    "Rail's desktop tracker, HUD and study tools: imports every hand as you play, puts live stats on the table, tiles your tables, and brings a solver, nodelocks and a trainer to your own hands. Part of Rail Pro, for macOS and Windows.",

  /** The link in the bar, and its name for a screen reader. */
  getApp: "Get the app",
  getAppLabel: "Download the Rail desktop app",

  heading: "Rail on your computer",
  lede: "A poker tracker, HUD and study tool that runs beside your poker room. Rail imports every hand as you play, shows live stats over your tables, and puts a solver and a trainer next to your own hands, in sync with rail on the web.",
  promoAlt:
    "The Rail desktop app: a solver strategy with a locked node, four tiled tables with HUD stats and an RNG box, a graded trainer spot, leaks ranked by EV lost and new hands being imported.",

  features: [
    {
      title: "Import and live HUD",
      body: "Point Rail at your poker room once. Every hand lands in your library seconds after it ends, with VPIP, PFR, 3-bet and more over every seat in rooms that allow a HUD.",
    },
    {
      title: "Tiled tables and an RNG",
      body: "Rail lays your tables out on any monitor, re-tiles them on a hotkey and keeps an RNG box in the corner you can drag, resize and lock.",
    },
    {
      title: "Solver and nodelocks",
      body: "Open any flop from the solver library and see every combo's frequency and EV. Lock how a player really plays and re-solve the spot on your own computer.",
    },
    {
      title: "Trainer",
      body: "Play single spots or whole hands against the solver, graded with the strategy and why. “For you” deals the spots where you lose the most.",
    },
    {
      title: "Analysis and review",
      body: "Leaks ranked by EV lost, EV for every option in a hand, and one filter row across Hands, Reports and Analysis. Mark hands for review and step through them in the replayer.",
    },
    {
      title: "Yours, offline too",
      body: "Hands are stored on your computer and work without a connection. Sign in to sync them with the web and post them to the forum.",
    },
  ],

  mac: {
    name: "macOS",
    cta: "Download for macOS",
    detail: "macOS 11 or later · Apple silicon and Intel · .dmg",
  },
  windows: {
    name: "Windows",
    cta: "Download for Windows",
    detail: "Windows 10 or 11 · 64-bit · installer, no admin rights",
  },
  included: "Part of Rail Pro. Once installed, import, the library and the replayer work offline too.",

  /** In place of the installers until the account's plan allows them. */
  gate: {
    checking: "Checking your plan…",
    signIn: "Sign in to download",
    signInReason: "Sign in with your Rail Pro account to download the desktop app.",
    signInDetail: "The desktop app comes with Rail Pro.",
    proBody: "Your plan doesn't include the desktop app. Upgrade to Pro to download it.",
    error: "We couldn't check your plan, so the download is not available right now.",
    retry: "Try again",
  },

  firstOpen: {
    heading: "Opening it the first time",
    mac: "Rail is not notarised by Apple yet, so macOS stops it the first time it opens. Open System Settings, Privacy & Security, scroll to Rail and choose Open Anyway.",
    windows: "Windows SmartScreen may warn about an unknown publisher. Choose More info, then Run anyway.",
  },
} as const;
