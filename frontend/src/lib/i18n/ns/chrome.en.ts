/**
 * Strings for the app's chrome — the sign-in dialog, the account menu, the
 * share panel, the database chip — English. Spread into `en.ts` as `chrome`;
 * `chrome.hr.ts` is the same shape. See the header of `en.ts`.
 */
const liveNum = (value: number) => value.toLocaleString("en-GB");
const liveHands = (count: number) => (count === 1 ? "hand" : "hands");

export const chromeEn = {
  /** The tag `Intl` formats dates and numbers with, for this language. */
  intl: "en-GB",
  close: "Close",
  closeNamed: (what: string) => `Close ${what.toLowerCase()}`,
  auth: {
    titles: { "sign-in": "Sign in", "sign-up": "Create an account", reset: "Reset your password" },
    submit: { "sign-in": "Sign in", "sign-up": "Create account", reset: "Send reset link" },
    lead: "Your hands stay private to your account.",
    google: "Continue with Google",
    googleFailed: "Google sign-in failed.",
    or: "or",
    email: "Email",
    password: "Password",
    working: "Working…",
    robotFirst: "Complete the robot check first.",
    failed: "That did not work. Try again.",
    confirmSent: (email: string) => `Check ${email} for a confirmation link, then sign in.`,
    resetSent: (email: string) => `If ${email} has an account, a reset link is on its way.`,
    toSignUp: "Create an account",
    toReset: "Forgot your password?",
    toSignIn: "← Back to sign in",
    guest: "Continue without an account",
    guestNote: "Converting works. Saving and sharing need an account.",
    turnstileFailed: "The robot check did not load. Reload the page and try again.",
  },
  menu: {
    signIn: "Sign in",
    signOut: "Sign out",
    signingOut: "Signing out…",
  },
  share: {
    button: "Share hand",
    creating: "Creating link…",
    failed: "Could not create a share link.",
    signIn: "Sign in to create a share link. Anyone you send it to can open it without an account.",
    heading: "Share this hand",
    hint: "Anyone with this link can replay the hand — no account needed.",
    linkLabel: "Shareable link",
    copy: "Copy",
    open: "Open link",
    via: "Share via…",
    webShareTitle: "Poker hand replay",
    copied: "Link copied to clipboard.",
    copyBlocked: "Your browser blocked the clipboard. Select the link above and copy it manually.",
  },
  db: {
    offlineTitle: "No database configured. The converter works offline; saved hands and sharing are unavailable.",
    offline: "Offline — no database",
    offlineShort: "Offline",
    connected: "Database connected",
    stored: (count: string, n: number) => `${count} ${n === 1 ? "hand" : "hands"} stored`,
  },
  /** The shell's live strip (R4.3): uploads in the account's other tabs, the desktop app's sync, new hands. */
  live: {
    region: "Live activity",
    elsewhere: "In another tab or on another device",
    uploadSaving: (sent: number, total: number | null, estimated: boolean) =>
      total
        ? `Saving ${liveNum(sent)} of ${estimated ? "~" : ""}${liveNum(total)} ${liveHands(total)} from a web upload`
        : `Saving ${liveNum(sent)} ${liveHands(sent)} from a web upload`,
    uploadRetrying: (sent: number) =>
      `Web upload: connection trouble, trying again (${liveNum(sent)} ${liveHands(sent)} saved so far)`,
    uploadWaiting: (sent: number) =>
      `Web upload waiting for the account's upload budget (${liveNum(sent)} ${liveHands(sent)} saved so far)`,
    uploadPaused: (sent: number) =>
      `Web upload paused at ${liveNum(sent)} ${liveHands(sent)} — continue it in the tab that started it`,
    uploadDone: (inserted: number, duplicates: number) =>
      `Web upload finished: ${liveNum(inserted)} new ${liveHands(inserted)} saved${
        duplicates ? `, ${liveNum(duplicates)} already in your library` : ""
      }`,
    desktopSyncing: (hands: number) => `Desktop app syncing: ${liveNum(hands)} ${liveHands(hands)} so far`,
    newHands: (count: number) =>
      count > 0 ? `${liveNum(count)} new ${liveHands(count)} arrived — refresh` : "New hands arrived — refresh",
    /** Read out once by screen readers when something starts or ends, not on every count. */
    announceUpload: "A web upload is running in another tab.",
    announceDesktop: "The desktop app is syncing hands.",
  },
} as const;
