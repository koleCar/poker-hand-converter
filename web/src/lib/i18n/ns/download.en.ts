/**
 * `/download` and the bar's "Get the app": the Rail desktop app for macOS and
 * Windows. English, the source locale.
 */
export const downloadEn = {
  metaTitle: "Download the Rail app for macOS and Windows | Rail",
  metaDescription:
    "Rail's desktop tracker and HUD: imports every hand as you play, puts live stats on the table and syncs with your account. Free for macOS and Windows.",

  /** The link in the bar, and its name for a screen reader. */
  getApp: "Get the app",
  getAppLabel: "Download the Rail desktop app",

  heading: "Rail on your computer",
  lede: "A poker tracker and HUD that runs beside your poker room. Rail watches the room's hand-history folder, imports every hand as you play, shows live stats over the table and keeps your library in sync with rail on the web.",
  promoAlt:
    "The Rail desktop app: a poker table with HUD stats over every seat, a winnings graph and new hands being imported.",

  features: [
    {
      title: "Automatic import",
      body: "Point Rail at your poker room once. Every new hand lands in your library seconds after it ends, old hands included.",
    },
    {
      title: "Live HUD",
      body: "VPIP, PFR, 3-bet and more over every seat, in the rooms whose rules allow a HUD.",
    },
    {
      title: "Replayer, reports, analysis",
      body: "Step through any hand, filter results by stake, position and session, and see your leaks ranked by EV lost.",
    },
    {
      title: "Yours, offline too",
      body: "Hands are stored on your computer and work without a connection. Sign in to sync them with the web and share them to the forum.",
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
  free: "Free to download. Import, the library, the replayer and statistics work without an account.",
  allReleases: "All versions and release notes",

  firstOpen: {
    heading: "Opening it the first time",
    mac: "Rail is not notarised by Apple yet, so macOS stops it the first time it opens. Open System Settings, Privacy & Security, scroll to Rail and choose Open Anyway.",
    windows: "Windows SmartScreen may warn about an unknown publisher. Choose More info, then Run anyway.",
  },
} as const;
