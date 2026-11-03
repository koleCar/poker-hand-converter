/**
 * "Post to the forum" inside the share popover: the hand plus the author's own
 * comment, as a thread everyone can read.
 *
 * Existing calls, one after the other: a hand not yet in the library is saved
 * first, because only a stored row can be published; `publish_hand` then
 * scrubs that row in SQL (so nothing this component holds is what gets
 * published), and `create_post` opens the thread about that publication.
 * Saving and publishing the same hand twice return the first row and the first
 * publication, so a retry after a failed post leaves no second copy behind.
 *
 * Screen names: the two safe modes only. "As imported" needs the publish
 * dialog's explicit warning and confirmation, which this compact form has no
 * room to do justice to.
 */

"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../../lib/auth";
import { saveHand } from "../../lib/db";
import { createPost, forumErrorMessage, listOpenBoards } from "../../lib/db/forum";
import { publishErrorMessage, publishHand, type PublishMode } from "../../lib/db/publishing";
import type { BoardRef } from "../../lib/forum/types";
import { useDict } from "../../lib/i18n/client";
import { toStandardText } from "../../lib/phf";
import type { PhfHand } from "../../lib/phf/types";
import { useMyProfile } from "../../lib/profile/context";
import { paths } from "../../lib/routes";
import { Icon } from "@rail/ui/icon/Icon";

const MODES: PublishMode[] = ["pseudonyms", "positions"];

export function ShareToForum({ hand, storedHandId }: { hand: PhfHand; storedHandId: string | null }) {
  const dict = useDict();
  const t = dict.chrome.share.forum;
  const auth = useAuth();
  const { profile } = useMyProfile();
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<BoardRef[] | null>(null);
  const [board, setBoard] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<PublishMode>("pseudonyms");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null>(null);

  // A different hand starts a different post.
  useEffect(() => {
    setOpen(false);
    setTitle("");
    setBody("");
    setError(null);
    setPosted(null);
  }, [hand.meta.handKey]);

  useEffect(() => {
    if (!open || boards) return;
    let live = true;
    listOpenBoards().then(
      (rows) => {
        if (!live) return;
        setBoards(rows);
        setBoard((current) => current || rows[0]?.slug || "");
      },
      (err) => {
        if (live) setError(forumErrorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [open, boards]);

  if (!auth.configured) return null;

  function start() {
    if (!auth.isSignedIn) {
      auth.requestSignIn(t.signIn);
      return;
    }
    setError(null);
    setOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    let publicId: string;
    try {
      const handId = storedHandId ?? (await saveHand(hand, toStandardText(hand))).id;
      if (!handId) throw new Error(t.notSaved);
      publicId = (await publishHand(handId, mode, title)).publicId;
    } catch (err) {
      setError(publishErrorMessage(err));
      setBusy(false);
      return;
    }
    try {
      const post = await createPost({ board, title, body, hand: publicId });
      setPosted(paths.post(post.board, post.publicId, post.slug));
    } catch (err) {
      setError(forumErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (posted) {
    return (
      <div className="share__forum">
        <p className="share__msg share__msg--ok" role="status">
          {t.done}
        </p>
        <div className="share__actions">
          <Link className="btn btn--primary btn--sm" href={posted}>
            {t.view}
          </Link>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="share__forum">
        <button type="button" className="btn btn--sm share__forum-open" onClick={start}>
          <Icon name="megaphone" />
          {t.button}
        </button>
      </div>
    );
  }

  const blocked = profile?.postingBlockReason ?? null;

  return (
    <form className="share__forum share__forum--open" onSubmit={(event) => void submit(event)}>
      <strong className="share__forum-heading">{t.heading}</strong>
      <p className="share__hint">{t.hint}</p>

      <label className="share__field">
        <span>{t.board}</span>
        <select value={board} onChange={(event) => setBoard(event.target.value)} disabled={!boards} required>
          {(boards ?? []).map((entry) => (
            <option key={entry.slug} value={entry.slug}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>

      <label className="share__field">
        <span>{t.title}</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t.titlePlaceholder}
          minLength={3}
          maxLength={140}
          required
        />
      </label>

      <label className="share__field">
        <span>{t.comment}</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={t.commentPlaceholder}
          rows={4}
          maxLength={40000}
        />
      </label>

      <fieldset className="share__field share__forum-modes">
        <legend>{t.names}</legend>
        {MODES.map((value) => (
          <label key={value} className="share__forum-mode">
            <input
              type="radio"
              name="share-forum-mode"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            <span>{dict.publish.modes[value].label}</span>
          </label>
        ))}
      </fieldset>

      {blocked ? <p className="share__msg share__msg--warn">{blocked}</p> : null}
      {error ? (
        <p className="share__msg share__msg--error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="share__actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !boards || Boolean(blocked)}>
          {busy ? t.submitting : t.submit}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)} disabled={busy}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}
