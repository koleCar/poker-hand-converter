/**
 * `/auth/desktop`: signing the Rail desktop app in through this browser
 * (docs/RAIL-PLAN.md R1.7). English, the source locale.
 */
export const desktopEn = {
  metaTitle: "Sign in to the Rail app | Rail",
  metaDescription: "Sign the Rail desktop app on this computer in with your account.",
  heading: "Sign in to the Rail app",
  checking: "Checking your sign-in…",
  notConfigured: "Accounts are not available on this deployment, so the app cannot sign in here.",

  signedOut: {
    body: "The Rail app on this computer asked to sign in. Sign in here first, then confirm.",
    reason: "Sign in, then confirm signing in to the Rail app.",
    cta: "Sign in",
  },

  confirm: {
    account: (email: string) => `You are signed in as ${email}.`,
    question: "Sign in to the Rail app on this computer with this account?",
    detail:
      "The app gets a sign-in of its own; this browser stays signed in. Continue only if you just chose Sign in in the Rail app.",
    approve: "Sign in to Rail",
    working: "Signing in…",
    otherAccount: "Use a different account",
    cancel: "Cancel",
  },

  done: {
    heading: "Opening Rail…",
    body: "Your browser may ask whether to open Rail. Allow it, and the app finishes signing in.",
    openAgain: "Open Rail",
    close: "You can close this tab.",
  },

  cancelled: {
    heading: "Cancelled",
    body: "The Rail app was not signed in. You can close this tab.",
  },

  errors: {
    invalid: "This sign-in link is incomplete. Start again from the Rail app: Settings, Account, Sign in.",
    expired: "This sign-in link has expired (it works for ten minutes). Start again from the Rail app.",
    used: "This sign-in was already sent to the Rail app. If the app did not open, start again from the app.",
    unconfirmed: "Confirm your email address first: check your inbox for the link, then start again from the app.",
    unsupported: "This account cannot sign in to the Rail app.",
    rateLimited: "Too many sign-ins for this account in the last hour. Try again later.",
    notSignedIn: "Your sign-in here has expired. Sign in again, then confirm.",
    failed: "The Rail app could not be signed in just now. Try again in a minute.",
    unavailable: "Signing in to the Rail app is not available on this deployment yet.",
  },
} as const;
