/**
 * Every user-facing string on the App Router surfaces, in one place.
 *
 * ## Why, when the product is English-only
 *
 * Because Croatian is coming, and the difference between "add a locale" and
 * "refactor every component" is decided now, not then. A string that starts its
 * life inline gets copy-edited inline, reused inline, and concatenated inline,
 * and by the time a second language arrives the extraction is a week of work
 * with a regression in it. A string that starts here is a data change.
 *
 * The lint rule in `eslint.config.js` (`no-restricted-syntax`, "user-facing
 * literal") is what keeps this honest for `src/app/**`: bare JSX text and bare
 * `title` / `alt` / `placeholder` / `aria-label` attributes are errors there.
 *
 * ## What is deliberately NOT here
 *
 * The pre-existing components under `src/components/**` still carry their copy
 * inline — several hundred strings across the converter, the replayer and the
 * stats HUD. Hauling them through this file *during* a framework migration is
 * how you lose a comma in a sentence that explains a refusal reason, and the
 * migration's whole claim is that behaviour did not change. They are tracked as
 * follow-up; the lint rule is scoped so that no *new* file can add to the pile.
 *
 * ## Shape
 *
 * Nested plain objects, `as const`. No interpolation framework: the two places
 * that need a value take a function, so the argument order is type-checked and
 * a translator sees the whole sentence rather than three fragments.
 */

export const en = {
  brand: {
    name: "Rail",
    tagline: "Poker hands, replayed and discussed",
  },

  meta: {
    home: {
      title: "Rail — poker hand replayer & hand history converter",
      description:
        "Replay any poker hand action by action and share it with one link. Convert hand histories from any poker room to the standard Holdem Manager format. Free, no account.",
    },
    convert: {
      title: "Poker hand history converter — WePlay, PokerStars, GGPoker | Rail",
      description:
        "Convert hand histories from any poker room into the standard format Holdem Manager and PokerTracker import. Free, in your browser, nothing uploaded.",
    },
    library: {
      title: "Hand history | Rail",
      description:
        "Browse, filter and replay every poker hand you have saved, and share one with a single link.",
    },
    stats: {
      title: "Statistics | Rail",
      description:
        "VPIP, PFR, 3-bet, continuation bets and a showdown / non-showdown win-rate graph, over every hand you have saved.",
    },
    notFound: {
      title: "Page not found | Rail",
      description: "That address does not match anything on Rail.",
    },
    sharedHand: {
      fallbackTitle: "Shared poker hand | Rail",
      fallbackDescription:
        "Replay a shared poker hand action by action, free and without an account, on Rail.",
    },
  },

  nav: {
    sections: "Sections",
    convert: "Upload hand",
    library: "Hand history",
    stats: "Statistics",
  },

  home: {
    heading: "The feed is on its way",
    body: "Hands worth arguing about, posted and replayed in the thread. Until it opens, the two things Rail already does are one click away.",
    convertCta: "Convert a hand history",
    libraryCta: "Open your library",
    note: "Converting, previewing, downloading and replaying need no account.",
  },

  convert: {
    /**
     * The privacy line. This is UI copy, not a marketing claim: `/convert`
     * issues zero network requests for the conversion itself, and the assertion
     * is repeated as a comment in `app/convert/page.tsx` so that a future change
     * has to walk past it twice. See #24.
     */
    privacy: "Nothing is uploaded. Your hand histories are converted in this tab and never leave it.",
  },

  notFound: {
    heading: "Page not found",
    body: "That address does not match anything on Rail.",
    convertCta: "Go to the converter",
    libraryCta: "Open the replayer",
  },

  share: {
    ownHandsLink: "Replay your own hands",
    openAppCta: "Open the app",
    tryFreeCta: "Try it free",
    footerBlurb: "— convert hand histories from any poker room and replay any hand in your browser.",
    ctaHeading: "Replay and convert your own hands",
    ctaBody:
      "Drop in a hand history from any poker room and get a shareable replay like this one. Free, in the browser, no account.",
    ctaReplayer: "Open the replayer",
    ctaConvert: "Convert a hand history",
    loadingLabel: "Loading hand",
    sharedAt: (when: string) => `Shared ${when}`,
    views: (count: number) =>
      `${count.toLocaleString("en-GB")} ${count === 1 ? "view" : "views"}`,
    problems: {
      notFound: {
        title: "This hand link does not exist",
        body: "The link may have a typo, or the hand was never shared. Check the address and try again.",
      },
      gone: {
        title: "This hand is no longer available",
        body: "The person who shared it deleted the hand, or the link expired.",
      },
      unparseable: {
        title: "This hand could not be replayed",
        body: "The stored hand history is damaged or in a format we cannot read yet.",
      },
      unconfigured: {
        title: "Shared hands are unavailable right now",
        body: "This deployment has no database configured, so shared links cannot be opened. The converter and the uploader still work.",
      },
      error: {
        title: "Something went wrong loading this hand",
      },
    },
    problemReplayCta: "Replay your own hand",
    problemHomeCta: "Go to Rail",
  },

  shell: {
    offlineBanner:
      "No database configured — the library and sharing are off. Converting still works.",
  },

  auth: {
    callbackFailed: "That sign-in link did not work. Ask for a new one and try again.",
  },
} as const;

export type Strings = typeof en;
