"use client";

/**
 * The signed-in visitor's own votes, fetched once per page for every post or
 * comment on it.
 *
 * This is the rule that keeps forum pages shareable (#35): **per-user state is
 * never in the server-rendered payload.** The HTML carries the counts as of
 * render; this island fills in "which arrow is mine" after hydration, in one
 * call, for everyone on the page.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../../lib/auth";
import { myCommentVotes, myPostVotes } from "../../lib/db/forum";

type VoteMap = Record<string, number>;

interface MyVotesValue {
  posts: VoteMap;
  comments: VoteMap;
}

const MyVotesContext = createContext<MyVotesValue>({ posts: {}, comments: {} });

export function useMyVotes(): MyVotesValue {
  return useContext(MyVotesContext);
}

export function MyVotesProvider({
  postIds,
  commentsOf,
  children,
}: {
  postIds: string[];
  /** A post's public id, to also load my votes on its comments. */
  commentsOf?: string;
  children: ReactNode;
}) {
  const auth = useAuth();
  const [value, setValue] = useState<MyVotesValue>({ posts: {}, comments: {} });
  const key = postIds.join(",");

  useEffect(() => {
    if (!auth.isSignedIn) {
      return;
    }
    let active = true;
    const ids = key ? key.split(",") : [];
    Promise.all([
      ids.length ? myPostVotes(ids).catch(() => ({})) : Promise.resolve({}),
      commentsOf ? myCommentVotes(commentsOf).catch(() => ({})) : Promise.resolve({}),
    ]).then(([posts, comments]) => {
      if (active) setValue({ posts, comments });
    });
    return () => {
      active = false;
    };
  }, [auth.isSignedIn, key, commentsOf]);

  return <MyVotesContext.Provider value={value}>{children}</MyVotesContext.Provider>;
}
