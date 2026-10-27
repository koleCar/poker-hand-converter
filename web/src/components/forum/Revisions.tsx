"use client";

import { useState } from "react";
import { getRevisions } from "../../lib/db/moderation";
import { useDict } from "../../lib/i18n/client";
import { formatPostDate } from "./format";
import { PostText } from "./PostText";
import styles from "./forum.module.css";

/**
 * "edited" that opens into the edit history. Public, from `content_revisions`:
 * on a poker forum a story rewritten after the result is a thing, and a
 * verifiable history beats a badge.
 */
export function Revisions({ post, seq }: { post: string; seq?: number }) {
  const en = useDict();
  const [items, setItems] = useState<Array<{ title: string | null; body: string | null; createdAt: string }> | null>(null);
  const [open, setOpen] = useState(false);

  async function toggle() {
    if (!open && items === null) {
      try {
        setItems(await getRevisions(post, seq));
      } catch {
        setItems([]);
      }
    }
    setOpen((value) => !value);
  }

  return (
    <>
      <button type="button" className="linkish" onClick={() => void toggle()} aria-expanded={open}>
        {en.moderation.edited}
      </button>
      {open && items ? (
        <div className={styles.revisions} aria-label={en.moderation.revisions}>
          {items.map((item, index) => (
            <div key={index} className={styles.revision}>
              <small className="muted">{en.moderation.revisionAt(formatPostDate(item.createdAt, en.chrome.intl))}</small>
              {item.title ? <strong>{item.title}</strong> : null}
              <PostText body={item.body} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
