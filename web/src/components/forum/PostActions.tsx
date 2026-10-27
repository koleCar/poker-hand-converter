"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deletePost, editPost, forumErrorMessage } from "../../lib/db/forum";
import { useDict } from "../../lib/i18n/client";
import { useMyProfile } from "../../lib/profile/context";
import { paths } from "../../lib/routes";
import styles from "./forum.module.css";

/** Edit and delete, on your own post. Decided client-side, after hydration. */
export function PostActions({
  publicId,
  board,
  author,
  title,
  body,
}: {
  publicId: string;
  board: string;
  author: string | null;
  title: string;
  body: string;
}) {
  const en = useDict();
  const { profile } = useMyProfile();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftBody, setDraftBody] = useState(body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!profile || !author || profile.username !== author) {
    return null;
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await editPost(publicId, draftTitle, draftBody);
      setEditing(false);
      router.replace(paths.post(board, publicId, result.slug));
      router.refresh();
    } catch (err) {
      setError(forumErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(en.forum.post.deleteConfirm)) return;
    try {
      await deletePost(publicId);
      router.refresh();
    } catch (err) {
      setError(forumErrorMessage(err));
    }
  }

  if (editing) {
    return (
      <div className={styles.composer}>
        <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} maxLength={300} />
        <textarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} rows={8} maxLength={40000} />
        {error ? <p className="notice notice--error">{error}</p> : null}
        <div className={styles.row}>
          <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void save()}>
            {en.forum.post.save}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
            {en.forum.post.cancel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.row}>
      <button type="button" className="linkish" onClick={() => setEditing(true)}>
        {en.forum.post.edit}
      </button>
      <button type="button" className="linkish" onClick={() => void remove()}>
        {en.forum.post.delete}
      </button>
      {error ? <small className="notice notice--error">{error}</small> : null}
    </div>
  );
}
