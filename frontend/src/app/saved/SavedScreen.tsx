"use client";

import { useEffect, useState } from "react";
import { MyVotesProvider } from "../../components/forum/MyVotes";
import { PostCard } from "../../components/forum/PostCard";
import { AppFrame } from "../../components/shell/AppFrame";
import { useAuth } from "../../lib/auth";
import { mySavedPosts } from "../../lib/db/social";
import type { ForumPost } from "../../lib/forum/types";
import { en } from "../../lib/i18n/en";
import styles from "../../components/forum/forum.module.css";

/** Client half of `/saved`: private bookmarks, read through a select-own policy. */
export function SavedScreen() {
  return <AppFrame tab={null}>{() => <SavedList />}</AppFrame>;
}

function SavedList() {
  const auth = useAuth();
  const [posts, setPosts] = useState<ForumPost[] | null>(null);

  useEffect(() => {
    if (!auth.isSignedIn) return;
    let active = true;
    mySavedPosts().then(
      (rows) => {
        if (active) setPosts(rows);
      },
      () => {
        if (active) setPosts([]);
      },
    );
    return () => {
      active = false;
    };
  }, [auth.isSignedIn]);

  if (!auth.isSignedIn) {
    return (
      <section className="card stack">
        <h1 className={styles.postTitle}>{en.social.savedHeading}</h1>
        <div>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
            {en.settings.signInCta}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="stack">
      <h1 className={styles.postTitle}>{en.social.savedHeading}</h1>
      {posts === null ? null : posts.length === 0 ? (
        <p className="muted">{en.social.noSaved}</p>
      ) : (
        <MyVotesProvider postIds={posts.map((post) => post.publicId)}>
          <div className={styles.feed}>
            {posts.map((post) => (
              <PostCard key={post.publicId} post={post} />
            ))}
          </div>
        </MyVotesProvider>
      )}
    </section>
  );
}
