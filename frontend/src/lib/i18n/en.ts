/**
 * Every user-facing string on the App Router surfaces, in English — the source
 * locale. `hr.ts` is the same shape, checked against `Dict` (`types.ts`), so a
 * key cannot exist in one language and not the other.
 *
 * ## How a component gets its strings
 *
 *   * client components: `const en = useDict()` (`client.tsx`), from the
 *     provider the root layout mounts with the request's locale;
 *   * server pages, metadata and route handlers: `const en = await getDict()`
 *     (`server.ts`);
 *   * components that render on both sides (`HandSummary`, `CommentThread`,
 *     `PostCard`, `Feed`, `EmbedFrame`, `OgCard`): a `t` prop from the caller.
 *
 * The variable keeps the name `en` at call sites only so the switch to
 * dictionaries did not have to rewrite every line; it holds whichever language
 * the reader chose.
 *
 * The locale is a cookie (`rail.locale`), else the browser's
 * `Accept-Language`, else English — see `types.ts`. URLs do not change.
 *
 * The lint rule in `eslint.config.js` (`no-restricted-syntax`, "user-facing
 * literal") keeps `src/app/**` honest: bare JSX text and bare `title` / `alt` /
 * `placeholder` / `aria-label` attributes are errors there.
 *
 * ## Shape
 *
 * Nested plain objects, `as const`. No interpolation framework: a value that
 * needs an argument is a function, so the argument order is type-checked and a
 * translator sees the whole sentence rather than three fragments — and can
 * apply the plural rules of their own language (`plural()` in `hr.ts`).
 */

import { analysisEn } from "./ns/analysis.en";
import { chromeEn } from "./ns/chrome.en";
import { converterEn } from "./ns/converter.en";
import { learnEn } from "./ns/learn.en";
import { replayerEn } from "./ns/replayer.en";
import { statsEn } from "./ns/stats.en";

export const en = {
  // The component namespaces, one file each (`ns/`).
  stats: statsEn,
  analysis: analysisEn,
  learn: learnEn,
  replayer: replayerEn,
  converter: converterEn,
  chrome: chromeEn,

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
    analysis: {
      title: "Hand analysis | Rail",
      description:
        "Every decision in your saved hands, with the board, your hand, the price and the checks that hold whatever the strategy.",
    },
    analysisHand: {
      title: "Hand analysis — one hand | Rail",
      description: "One of your hands, decision by decision, in the replayer.",
    },
    learn: {
      title: "Learn poker strategy: pot odds, ranges, MDF, SPR and more | Rail",
      description:
        "Free poker concepts explained with worked examples and interactive calculators: pot odds, equity realisation, ranges, board texture, MDF, SPR, bet sizing, 3-bets and more.",
    },
    learnConcept: (title: string) => `${title} — poker concepts | Rail`,
    charts: {
      title: "Preflop charts: 6-max 100bb cash, every hand's mix and EV | Rail",
      description:
        "Rail's own preflop charts for 6-max 100 bb cash: opens, 3-bets, 4-bets, squeezes and blind versus blind, with the frequency and EV of every action for all 169 hands.",
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

  language: {
    label: "Language",
    hint: "Rail remembers your choice in this browser.",
  },

  nav: {
    sections: "Sections",
    forum: "Forum",
    convert: "Upload hand",
    library: "Hand history",
    stats: "Statistics",
    analysis: "Analysis",
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

  account: {
    menuProfile: "Your profile",
    menuSettings: "Settings",
  },

  profile: {
    metaTitle: (username: string) => `${username} | Rail`,
    metaDescription: (username: string) => `${username} on Rail — poker hands, replayed and discussed.`,
    joined: (date: string) => `Joined ${date}`,
    karma: (count: number) => `${count.toLocaleString("en-GB")} karma`,
    yours: "This is your profile.",
    editCta: "Change username",
    emptyHeading: "Nothing posted yet",
    emptyBody: "Hands this player publishes will be listed here.",
    publishedHeading: "Published hands",
    untitledHand: (stakes: string) => `${stakes} hand`,
    unavailable: {
      heading: "Profiles are unavailable right now",
      body: "This deployment has no database configured, so profiles cannot be shown.",
    },
    homeCta: "Go to Rail",
  },

  handSummary: {
    seats: "Seats",
    seat: "Seat",
    player: "Player",
    position: "Position",
    stack: "Stack",
    board: "Board",
    noFlop: "No flop was dealt.",
    action: "Action",
    streets: {
      preflop: "Preflop",
      flop: "Flop",
      turn: "Turn",
      river: "River",
      showdown: "Showdown",
    } as Record<string, string>,
    result: "Result",
    revealResult: "Show how the hand ended",
    pot: (amount: string) => `Pot ${amount}`,
    net: (player: string, amount: string) => `${player} ${amount}`,
    handText: "Hand history (text)",
    hero: "Hero",
  },

  published: {
    metaTitleFallback: "Poker hand | Rail",
    headline: (stakes: string, game: string, hero: string | null) =>
      hero ? `${stakes} ${game} — hero ${hero}` : `${stakes} ${game}`,
    facts: {
      site: (name: string) => name,
      handed: (count: number) => `${count}-handed`,
      playedOn: (date: string) => `played ${date}`,
      by: "published by",
      anonymous: "a deleted account",
    },
    modeNote: {
      pseudonyms: "Opponent names are replaced with Villain1, Villain2… by the player who published this hand.",
      positions: "Opponent names are replaced with their table positions by the player who published this hand.",
      "as-imported": "Screen names are shown as the poker room printed them, at the publisher's choice.",
    },
    replayHeading: "Replay",
    poll: {
      heading: "This hand is a poll",
      body: "Its author asks what you would do at one of their decisions. Answer it, and the whole hand opens.",
      cta: "Answer the poll",
    },
    gone: {
      deleted: {
        heading: "This hand was removed by the person who published it",
        body: "It is no longer available.",
      },
      removed: {
        heading: "This hand was removed by a moderator",
        body: "It is no longer available.",
      },
      unavailable: {
        heading: "Published hands are unavailable right now",
        body: "This deployment has no database configured.",
      },
    },
    homeCta: "Go to Rail",
    convertCta: "Replay your own hands",
  },

  og: {
    poll: "Poll",
    pollTitle: "What would you do?",
    pollFacts: "Answer to see the rest of the hand",
    handEyebrow: "Hand",
    handFallback: "A poker hand on Rail",
    forumEyebrow: "Forum",
    threadFallback: "A thread on Rail",
    handed: (count: number) => `${count}-handed`,
    hero: (position: string) => `hero ${position}`,
    by: (username: string) => `by ${username}`,
    comments: (count: number) => `${count} ${count === 1 ? "comment" : "comments"}`,
  },

  embed: {
    title: "Hand replayer | Rail",
    credit: "Replay on Rail",
    gone: "This hand is no longer available.",
    button: "Embed",
    heading: "Embed this hand",
    hint: "Paste this where the hand should appear — a forum post, a blog, a docs page. It sizes to the width it is given.",
    copy: "Copy code",
    copied: "Copied",
  },

  forum: {
    metaHomeTitle: "Rail — poker hands, replayed and discussed",
    metaHomeDescription:
      "Poker hands posted by the people who played them, replayed action by action and argued about in the thread. Free, and no account needed to read.",
    metaBoardTitle: (name: string) => `${name} — poker hands and strategy | Rail`,
    metaBoardDescription: (name: string, description: string | null) =>
      description ?? `${name} hands and discussion on Rail.`,
    allBoards: "All boards",
    sorts: { hot: "Hot", new: "New", top: "Top" } as Record<string, string>,
    newPost: "New post",
    search: "Search",
    searchPlaceholder: "Search posts and comments",
    empty: "Nothing here yet. Post the first hand.",
    next: "Older posts",
    first: "Back to the first page",
    commentCount: (count: number) => `${count} ${count === 1 ? "comment" : "comments"}`,
    points: (score: number) => `${score} ${Math.abs(score) === 1 ? "point" : "points"}`,
    by: "by",
    in: "in",
    deletedAuthor: "[deleted]",
    edited: "edited",
    pinned: "Pinned",
    locked: "Locked",
    upvote: "Upvote",
    downvote: "Downvote",
    anchorAfter: (where: string, what: string) => `${where}, after ${what}`,
    handBadge: "Hand",
    postDate: (date: string) => date,

    poll: {
      badge: (votes: number) => `Poll · ${votes} ${votes === 1 ? "answer" : "answers"}`,
      heading: "What would you do?",
      intro: (votes: number) =>
        votes === 0
          ? "Nobody has answered yet. Answer to see the rest of the hand and the discussion."
          : `${votes} ${votes === 1 ? "person has" : "people have"} answered. Answer to see the rest of the hand, how they voted, and the discussion.`,
      cardsHidden: "The author hid their cards: this one is about the range.",
      size: "Size (of the pot)",
      sizeNone: "No size",
      vote: "Answer",
      voting: "Answering…",
      signIn: "Sign in to answer",
      results: "How people answered",
      hero: "what happened",
      votes: (count: number) => `${count} ${count === 1 ? "vote" : "votes"}`,
      median: (pct: number) => `median ${pct}% pot`,
      yours: "your answer",
      authorNote: "Your poll. Readers see the hand stopped at your decision until they answer; you see all of it.",
      handGone: "The hand behind this poll has been unpublished.",
      discussionLocked: "The discussion opens once you have answered.",
    },
    post: {
      replayHeading: "Replay",
      commentOnSpot: "Comment on this spot",
      spotAttached: (label: string) => `Commenting on: ${label}`,
      clearSpot: "Remove",
      edit: "Edit",
      delete: "Delete",
      deleteConfirm: "Delete this post? The thread stays readable, but your post will say it was deleted.",
      save: "Save",
      cancel: "Cancel",
      removed: {
        heading: "This post was removed by a moderator",
        body: "It is no longer available.",
      },
      deleted: {
        heading: "This post was deleted by its author",
        body: "It is no longer available.",
      },
      unavailable: {
        heading: "The forum is unavailable right now",
        body: "This deployment has no database configured.",
      },
      viewerOnly:
        "Only you and the moderators can see this post: it is held for review or was removed. Everyone else gets “not found”.",
      backToBoard: (name: string) => `Back to ${name}`,
    },

    comments: {
      heading: (count: number) => `${count} ${count === 1 ? "comment" : "comments"}`,
      sort: { best: "Best", new: "New", top: "Top" } as Record<string, string>,
      placeholder: "Add to the discussion",
      replyPlaceholder: "Write a reply",
      submit: "Comment",
      submitting: "Posting…",
      reply: "Reply",
      delete: "Delete",
      deleted: "[deleted]",
      removed: "[removed]",
      signIn: "Sign in to comment.",
      locked: "This thread is locked.",
      permalink: "Link",
      anchorChip: (label: string) => `at ${label}`,
    },

    submit: {
      metaTitle: "New post | Rail",
      heading: "New post",
      board: "Board",
      title: "Title",
      titlePlaceholder: "What is the question?",
      body: "Text",
      bodyPlaceholder: "What happened, what you were thinking, what you are unsure about.",
      hand: "Hand",
      handAttached: (label: string) => `Attached: ${label}`,
      handHint: "To post a hand, publish it from your library first — it opens here with the hand attached.",
      submit: "Post",
      submitting: "Posting…",
      signIn: "Sign in to post.",
      poll: {
        toggle: "Ask readers what they would do",
        toggleHint:
          "Readers see the hand up to your decision, vote, and only then see the rest — and the comments. The hand stays hidden everywhere else until they answer.",
        spot: "Stop at",
        spotLabel: (street: string, facing: boolean, did: string) =>
          `${street[0].toUpperCase()}${street.slice(1)}, ${facing ? "facing a bet" : "no bet to you"} — you ${did.toLowerCase()}`,
        options: "Answers to offer",
        optionLocked: "what you did",
        hideCards: "Hide my cards (ask about the range, not the hand)",
        noSpots: "This hand has no decision of yours to ask about.",
      },
    },

    searchPage: {
      metaTitle: (query: string) => (query ? `“${query}” — search | Rail` : "Search | Rail"),
      heading: "Search",
      results: (count: number, query: string) => `${count} ${count === 1 ? "result" : "results"} for “${query}”`,
      none: (query: string) => `Nothing matches “${query}”.`,
      inPost: "in",
      commentOn: "Comment on",
      button: "Search",
    },
  },

  social: {
    bell: (count: number) => (count ? `Notifications, ${count} unread` : "Notifications"),
    notificationsTitle: "Notifications | Rail",
    notificationsHeading: "Notifications",
    markAllRead: "Mark all as read",
    noNotifications: "Nothing yet. Replies to you and mentions of you will show up here.",
    kinds: {
      comment_reply: (actor: string) => `${actor} replied to your comment`,
      post_reply: (actor: string) => `${actor} commented on your post`,
      mention: (actor: string) => `${actor} mentioned you`,
      thread: (actor: string) => `${actor} commented in a thread you follow`,
    },
    someone: "Someone",
    savedTitle: "Saved | Rail",
    savedHeading: "Saved posts",
    noSaved: "Nothing saved. Use Save on any post to keep it here.",
    save: "Save",
    saved: "Saved",
    watch: "Follow thread",
    watching: "Following",
    mute: "Mute",
    muted: "Muted",
    unmute: "Unmute",
    signIn: "Sign in to see your notifications.",
    newComments: (count: number) => `${count} new ${count === 1 ? "comment" : "comments"} — show`,
    menuSaved: "Saved posts",
    menuNotifications: "Notifications",
  },

  moderation: {
    report: "Report",
    reportHeading: "Report this",
    reasons: {
      spam: "Spam or advertising",
      harassment: "Harassment or abuse",
      cheating: "Cheating, collusion or ghosting",
      "off-topic": "Off-topic",
      "hh-takedown": "My hand history — please take it down",
      other: "Something else",
    } as Record<string, string>,
    detailsLabel: "Anything a moderator should know (optional)",
    submitReport: "Send report",
    reported: "Thanks — a moderator will look at it.",
    alreadyReported: "You already reported this. A moderator will look at it.",
    cancel: "Cancel",
    signIn: "Sign in to report something.",
    tools: "Moderation",
    remove: "Remove",
    restore: "Restore",
    approve: "Approve",
    lock: "Lock",
    unlock: "Unlock",
    pin: "Pin",
    unpin: "Unpin",
    editTitle: "Edit title",
    save: "Save",
    reasonPrompt: "Reason (goes into the audit log)",
    edited: "edited",
    revisions: "Edit history",
    revisionAt: (date: string) => `Before the edit of ${date}`,
    modTitle: "Moderation | Rail",
    modHeading: "Moderation",
    notModerator: "This page is for moderators.",
    tabs: { reports: "Reports", spam: "Spam", users: "Accounts", admin: "Admin" } as Record<string, string>,
    noReports: "No open reports.",
    noSpam: "Nothing held as spam.",
    reportedBy: (who: string) => `reported by ${who}`,
    open: "Open",
    dismiss: "Dismiss",
    actioned: "Mark actioned",
    lookup: "Look up",
    usernamePlaceholder: "username",
    ban: "Ban",
    banDays: "Days (empty = permanent, admin only)",
    unban: "Lift ban",
    shadowban: "Shadowban",
    unshadowban: "Lift shadowban",
    overlap: "Votes in step with",
    noOverlap: "No account votes in step with this one.",
    setRole: "Set role",
    createBoard: "Create board",
    boardSlug: "slug",
    boardName: "Name",
    boardMod: "Board moderator",
    grant: "Grant",
    revoke: "Revoke",
    done: "Done.",
    takedownTitle: "Hand history takedown | Rail",
    takedownHeading: "Taking a hand history down",
    takedownBody: [
      "If a hand published on Rail involves you or your poker room and you want it removed, report it with the reason “My hand history — please take it down”. You need an account to report; it takes a minute and asks for nothing but an email address.",
      "A moderator responds within 48 hours. A hand removed this way is taken off its page, out of every thread and out of the sitemap; the removal is recorded in the moderation log.",
      "Published hands never contain the poker room’s raw text, the table name, the hand number or the exact time, and opponents’ screen names are replaced by default.",
    ],
    menuMod: "Moderation",
    roles: { member: "member", moderator: "moderator", admin: "admin" } as Record<string, string>,
    userLine: (role: string, karma: number) => ` · ${role} · ${karma} karma`,
    facts: {
      joined: (date: string) => `joined ${date}`,
      posts: (count: number) => `· ${count} posts`,
      comments: (count: number) => `· ${count} comments`,
      reports: (count: number) => `· ${count} reports`,
      bannedUntil: (date: string) => `· banned until ${date}`,
      shadowbanned: "· shadowbanned",
    },
  },

  publish: {
    button: "Publish hand",
    publishedButton: "Published — view",
    heading: "Publish this hand",
    lead: "You are publishing a hand you played. Opponent names are replaced by default.",
    titleLabel: "Title (optional)",
    titlePlaceholder: "What is the question?",
    modeLabel: "Names",
    modes: {
      pseudonyms: {
        label: "Villain1, Villain2… (recommended)",
        hint: "You are Hero; opponents get numbered names.",
      },
      positions: {
        label: "Table positions",
        hint: "You are Hero; opponents are shown by position — BTN, SB, BB…",
      },
      "as-imported": {
        label: "Screen names as the room printed them",
        hint: "Everyone at the table, you included, is shown by their real screen name.",
      },
    },
    asImportedWarning:
      "Most poker rooms forbid publishing other players' screen names. Only choose this if everyone at the table agreed.",
    asImportedConfirm: "I understand, show the real screen names",
    alwaysRemoved:
      "In every mode the room's raw text, the table name, the hand number and the exact time are removed.",
    submit: "Publish",
    submitting: "Publishing…",
    cancel: "Cancel",
    done: "Published. Anyone with the link — and search engines — can see it.",
    already: "You published this hand already. Here it is.",
    view: "Open the published hand",
    discuss: "Start a thread about it",
    notStored: "Save the hand to your library first — only stored hands can be published.",
    signIn: "Sign in to publish a hand.",
  },

  settings: {
    metaTitle: "Settings | Rail",
    metaDescription: "Your Rail username and account.",
    heading: "Settings",
    signedOut: "Sign in to change your username and account settings.",
    signInCta: "Sign in",
    loading: "Loading your account…",
    unavailable:
      "Account settings are not set up on this database yet. Everything else keeps working.",
    loadFailed: "Your account could not be loaded. Reload the page to try again.",

    username: {
      heading: "Username",
      label: "Username",
      hint: "3–24 characters: letters, numbers and underscores. It is your public name and your profile address.",
      provisional:
        "You are on the name you were given at signup. Choose your own — the first change is free.",
      rules:
        "You can change it once every 30 days. Your old name stays reserved for you for a year, and links to it keep working.",
      nextChange: (date: string) => `Your next change is possible on ${date}.`,
      save: "Save username",
      saving: "Saving…",
      saved: (username: string) => `Saved. You are now ${username}.`,
      unchanged: "That is already your username.",
      tooShort: "Usernames are at least 3 characters.",
      tooLong: "Usernames are at most 24 characters.",
      badCharacters: "Usernames can use only letters, numbers and underscores.",
      badStart: "Usernames start with a letter or a number.",
      viewProfile: "View your profile",
    },

    posting: {
      heading: "Posting",
      ok: "Your account can post.",
      blocked: "Your account cannot post yet.",
      resend: "Resend the confirmation email",
      resending: "Sending…",
      resent: (email: string) => `A new confirmation link is on its way to ${email}.`,
    },
  },
} as const;

export type Strings = typeof en;
