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

  /** Paying for Pro (R6.3): the Plan panel's checkout and portal, and the pages Stripe returns to. */
  billing: {
    notEnforcedOnSale:
      "Rail is in early access: every feature is open to every account, and no limit applies. You can already subscribe to Pro.",
    choose: "Billing period",
    monthly: "Monthly",
    yearly: "Yearly",
    perMonth: (price: string) => `${price} / month`,
    perYear: (price: string) => `${price} / year`,
    withDiscount: (price: string, percent: number) => `${price} with your ${percent}% early-user discount`,
    vatIncluded: "Prices include VAT.",
    vatAdded: "VAT is added at checkout where it applies.",
    vatNote: "Tax is worked out from your billing address at checkout; a business can add its VAT number.",
    earlyAccessNote: "Subscribing now starts Pro billing today. Everything stays open while Rail is in early access.",
    continue: "Continue to payment",
    /**
     * The two checkboxes before Checkout (R6.3 addendum; EU consumer law,
     * Directive 2011/83/EU art. 16(m), the Croatian ZZP). LEGAL TEXT - A DRAFT:
     * the owner's and the lawyer's review is needed before launch. Any change
     * to `termsBefore` / `termsLink` / `immediate` (here or in
     * `plan.hr.ts`) is a new wording: bump `CHECKOUT_CONSENT_VERSION`
     * (`lib/billing/checkout.ts`) and add it to the server's `CONSENT_TEXTS`
     * (`supabase/functions/_shared/billing/consent.ts`) - Vitest
     * `checkoutConsent` fails until both are done. Not legal advice.
     */
    consent: {
      legend: "Before you pay",
      termsBefore: "I agree to the ",
      termsLink: "Terms of Use",
      immediate:
        "I ask for Rail Pro to start immediately and I acknowledge that I thereby lose my right of withdrawal once it has started.",
      required: "Tick both boxes to continue to payment.",
    },
    working: "Opening the payment page…",
    manage: "Manage subscription",
    manageHint: "Change your card, switch between monthly and yearly, download invoices or cancel.",
    opening: "Opening…",
    pastDue: "Your last payment did not go through. Update your payment method to keep Pro.",
    pastDueUntil: (date: string) =>
      `Your last payment did not go through. Pro stays on until ${date}; update your payment method to keep it.`,
    canceledUntil: (date: string) =>
      `Your subscription is canceled. Pro stays on until ${date}; you can renew it before then.`,
    ended: (date: string) => `Your subscription ended on ${date}.`,
    errors: {
      not_signed_in: "Sign in again, then try once more.",
      invalid_request: "That did not work. Reload the page and try again.",
      email_unconfirmed: "Confirm your email address first: the receipt is sent there.",
      account_not_supported: "This account cannot subscribe. Sign in with an email account.",
      rate_limited: "Too many tries in a short time. Wait a little and try again.",
      unavailable: "Payments are not available right now. Try again later.",
      already_subscribed: "You already have a subscription. Use Manage subscription to change it.",
      no_customer: "There is no subscription to manage yet.",
      failed: "Something went wrong. Nothing was charged. Try again.",
      consent_required: "Tick both boxes before you continue to payment.",
      consent_outdated: "The wording on this page has changed. Reload the page, read it again and tick both boxes.",
    },
    success: {
      metaTitle: "Payment received | Rail",
      heading: "Thank you",
      body: "Your payment went through. Pro switches on as soon as Stripe confirms it, usually within seconds.",
      /** The confirmation of the consent (R6.3 addendum). LEGAL TEXT - a draft for the owner's and the lawyer's review. */
      confirmation:
        "As you asked, Pro starts now. You agreed to the Terms of Use and acknowledged that you lose your right of withdrawal once Pro has started. This is recorded with your account - it is in your data download (Settings, Your data) - and the receipt Stripe emails you repeats it.",
      waiting: "Waiting for the confirmation…",
      active: "Pro is on for your account.",
      slow: "The confirmation is taking longer than usual. Your plan updates by itself; you can leave this page.",
      back: "Back to your plan",
    },
    cancel: {
      metaTitle: "Checkout canceled | Rail",
      heading: "Checkout canceled",
      body: "Nothing was charged. You can subscribe whenever you like.",
      back: "Back to your plan",
    },
  },

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
