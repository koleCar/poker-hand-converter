"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AppFrame } from "../../components/shell/AppFrame";
import { useAuth } from "../../lib/auth";
import { createPost, forumErrorMessage } from "../../lib/db/forum";
import type { Board } from "../../lib/forum/types";
import { en } from "../../lib/i18n/en";
import { useMyProfile } from "../../lib/profile/context";
import { paths } from "../../lib/routes";
import styles from "../../components/forum/forum.module.css";

export function SubmitScreen({
  boards,
  attached,
  initialBoard,
}: {
  boards: Board[];
  attached: { publicId: string; label: string; title: string | null } | null;
  initialBoard: string | null;
}) {
  return (
    <AppFrame tab="forum">
      {() => <SubmitForm boards={boards} attached={attached} initialBoard={initialBoard} />}
    </AppFrame>
  );
}

function SubmitForm({
  boards,
  attached,
  initialBoard,
}: {
  boards: Board[];
  attached: { publicId: string; label: string; title: string | null } | null;
  initialBoard: string | null;
}) {
  const auth = useAuth();
  const { profile } = useMyProfile();
  const router = useRouter();
  const [board, setBoard] = useState(
    boards.find((entry) => entry.slug === initialBoard)?.slug ?? boards[0]?.slug ?? "",
  );
  const [title, setTitle] = useState(attached?.title ?? "");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!auth.isSignedIn) {
    return (
      <section className="card stack">
        <h1 className={styles.postTitle}>{en.forum.submit.heading}</h1>
        <div>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn(en.forum.submit.signIn)}>
            {en.forum.submit.signIn}
          </button>
        </div>
      </section>
    );
  }

  const blocked = profile?.postingBlockReason ?? null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createPost({ board, title, body, hand: attached?.publicId ?? null });
      router.push(paths.post(result.board, result.publicId, result.slug));
    } catch (err) {
      setError(forumErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h1 className={styles.postTitle}>{en.forum.submit.heading}</h1>
      <form className={styles.composer} onSubmit={(event) => void submit(event)}>
        <label className="stack">
          <span>{en.forum.submit.board}</span>
          <select value={board} onChange={(event) => setBoard(event.target.value)}>
            {boards.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="stack">
          <span>{en.forum.submit.title}</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={en.forum.submit.titlePlaceholder}
            maxLength={300}
            required
          />
        </label>
        <div className="stack">
          <span>{en.forum.submit.hand}</span>
          <p className="muted">{attached ? en.forum.submit.handAttached(attached.label) : en.forum.submit.handHint}</p>
        </div>
        <label className="stack">
          <span>{en.forum.submit.body}</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={en.forum.submit.bodyPlaceholder}
            rows={8}
            maxLength={40000}
            required={!attached}
          />
        </label>
        {blocked ? <p className="notice notice--warn">{blocked}</p> : null}
        {error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <button type="submit" className="btn btn--primary" disabled={busy || Boolean(blocked)}>
            {busy ? en.forum.submit.submitting : en.forum.submit.submit}
          </button>
        </div>
      </form>
    </section>
  );
}
