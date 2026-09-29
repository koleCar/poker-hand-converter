"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useAuth } from "../../lib/auth";
import { createComment, forumErrorMessage } from "../../lib/db/forum";
import { en } from "../../lib/i18n/en";
import { useMyProfile } from "../../lib/profile/context";
import { useSpot } from "./PostDiscussion";
import styles from "./forum.module.css";

function scrollWhenPresent(id: string, attempts = 20) {
  const element = document.getElementById(id);
  if (element) {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (attempts > 0) {
    window.setTimeout(() => scrollWhenPresent(id, attempts - 1), 150);
  }
}

/**
 * Writes a comment, then asks the server for the page again.
 *
 * `router.refresh()` rather than splicing the comment into client state: the
 * thread is server HTML, ordered and tombstoned by `get_post_comments`, and
 * re-deriving any of that here is how the two views start to disagree.
 */
export function CommentComposer({
  post,
  parentSeq = null,
  locked = false,
  autoFocus = false,
  onDone,
}: {
  post: string;
  parentSeq?: number | null;
  locked?: boolean;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const auth = useAuth();
  const { profile } = useMyProfile();
  const router = useRouter();
  const spot = useSpot();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (locked) {
    return <p className="muted">{en.forum.comments.locked}</p>;
  }

  if (!auth.isSignedIn) {
    return (
      <button type="button" className="btn btn--sm" onClick={() => auth.requestSignIn(en.forum.comments.signIn)}>
        {en.forum.comments.signIn}
      </button>
    );
  }

  // Only a top-level composer carries the spot; a reply is about its parent.
  const anchor = parentSeq === null ? spot.attached : null;
  const blocked = profile?.postingBlockReason ?? null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createComment({
        post,
        body,
        parentSeq,
        anchorActionIndex: anchor?.actionIndex ?? null,
        anchorStreet: anchor?.street ?? null,
      });
      setBody("");
      spot.clearAttached();
      onDone?.();
      // No `history.replaceState` for the new `#c-<seq>`: writing history
      // behind the App Router's back discards the refresh it is running. The
      // new comment is scrolled to once the refreshed tree contains it.
      router.refresh();
      scrollWhenPresent(`c-${result.seq}`);
    } catch (err) {
      setError(forumErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id={parentSeq === null ? "composer" : undefined} className={styles.composer} onSubmit={(event) => void submit(event)}>
      {anchor ? (
        <p className={styles.attached}>
          {en.forum.post.spotAttached(anchor.label)}{" "}
          <button type="button" className="linkish" onClick={spot.clearAttached}>
            {en.forum.post.clearSpot}
          </button>
        </p>
      ) : null}
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={parentSeq === null ? en.forum.comments.placeholder : en.forum.comments.replyPlaceholder}
        rows={parentSeq === null ? 4 : 3}
        maxLength={10000}
        required
        autoFocus={autoFocus}
      />
      {blocked ? <p className="notice notice--warn">{blocked}</p> : null}
      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !body.trim() || Boolean(blocked)}>
          {busy ? en.forum.comments.submitting : en.forum.comments.submit}
        </button>
      </div>
    </form>
  );
}
