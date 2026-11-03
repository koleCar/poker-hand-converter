"use client";

import { useState } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
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
    // Opens at once, with the loader in it until the history arrives.
    setOpen((value) => !value);
    if (!open && items === null) {
      try {
        setItems(await getRevisions(post, seq));
      } catch {
        setItems([]);
      }
    }
  }

  return (
    <>
      <button type="button" className="linkish" onClick={() => void toggle()} aria-expanded={open}>
        {en.moderation.edited}
      </button>
      {open && !items ? <RailLoader size="inline" label={en.loading.generic} /> : null}
      {open && items ? (
        <div className={`${styles.revisions} rail-enter`} aria-label={en.moderation.revisions}>
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
