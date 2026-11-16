/**
 * "Post to the forum" in the share popover. It no longer grows into a form
 * there: it opens the post preview (`/submit/preview`) in a new tab, where the
 * author picks the settings and sees the post as readers will.
 *
 * A library hand goes by its row id. A hand that is not saved yet goes as a
 * local draft (`stashPostDraft`), and the preview saves it when it is posted —
 * the same order as before: save, publish, post.
 */

"use client";

import { useAuth } from "../../lib/auth";
import { stashPostDraft } from "../../lib/forum/postPreview";
import { useDict } from "../../lib/i18n/client";
import type { PhfHand } from "../../lib/phf/types";
import { paths } from "../../lib/routes";
import { Icon } from "@rail/ui/icon/Icon";

function Label({ text }: { text: string }) {
  return (
    <>
      <Icon name="megaphone" />
      {text}
      <span className="share__forum-ext">
        <Icon name="external" />
      </span>
    </>
  );
}

export function ShareToForum({ hand, storedHandId }: { hand: PhfHand; storedHandId: string | null }) {
  const t = useDict().chrome.share.forum;
  const auth = useAuth();

  if (!auth.configured) return null;

  if (storedHandId && auth.isSignedIn) {
    return (
      <a
        className="share__forum"
        href={paths.postPreview({ hand: storedHandId })}
        target="_blank"
        rel="noopener"
        title={t.newTab}
      >
        <Label text={t.button} />
      </a>
    );
  }

  function open() {
    if (!auth.isSignedIn) {
      auth.requestSignIn(t.signIn);
      return;
    }
    const draft = stashPostDraft(hand);
    if (draft) window.open(paths.postPreview({ draft }), "_blank", "noopener");
  }

  return (
    <button type="button" className="share__forum" title={t.newTab} onClick={open}>
      <Label text={t.button} />
    </button>
  );
}
