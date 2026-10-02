/**
 * Strings for the app's chrome — the sign-in dialog, the account menu, the
 * share panel, the database chip — English. Spread into `en.ts` as `chrome`;
 * `chrome.hr.ts` is the same shape. See the header of `en.ts`.
 */
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
} as const;
