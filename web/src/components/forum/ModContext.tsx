"use client";

/**
 * "May I moderate this post?", asked once per post page and shared by the post
 * tools and every comment. Only draws buttons: each power re-checks on the
 * server.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../../lib/auth";
import { canModeratePost } from "../../lib/db/moderation";

const ModContext = createContext(false);

export function useCanModerate(): boolean {
  return useContext(ModContext);
}

export function ModProvider({ post, children }: { post: string; children: ReactNode }) {
  const auth = useAuth();
  const [can, setCan] = useState(false);
  useEffect(() => {
    if (!auth.isSignedIn) return;
    let active = true;
    canModeratePost(post).then(
      (value) => {
        if (active) setCan(Boolean(value));
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [auth.isSignedIn, post]);
  return <ModContext.Provider value={auth.isSignedIn && can}>{children}</ModContext.Provider>;
}
