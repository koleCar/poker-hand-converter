/**
 * The loader's words — what a `RailLoader` says while something is on its way
 * (screen readers hear it; page loaders also show it under the mark). Spread
 * into `en.ts` as `loading`; `loading.hr.ts` is the same shape.
 *
 * `route` is one word per screen, for the `loading.tsx` boundaries
 * (`components/shell/RouteLoading.tsx` picks it from the address). The rest
 * belong to pieces of the shell, the forum and the account screens that load
 * on their own.
 */
export const loadingEn = {
  generic: "Loading…",
  comments: "Loading comments…",
  route: {
    feed: "Loading the feed…",
    thread: "Loading the thread…",
    search: "Searching…",
    submit: "Opening the editor…",
    convert: "Opening the converter…",
    library: "Loading your hands…",
    stats: "Loading statistics…",
    players: "Loading players…",
    analysis: "Loading analysis…",
    solver: "Loading the solver library…",
    learn: "Loading the course…",
    settings: "Loading settings…",
    saved: "Loading saved posts…",
    notifications: "Loading notifications…",
    mod: "Loading the moderation queue…",
    profile: "Loading the profile…",
    billing: "Loading your plan…",
    hand: "Loading the hand…",
  },
} as const;
