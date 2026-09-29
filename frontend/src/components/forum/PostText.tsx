/**
 * A post or comment body: plain text, as paragraphs, with http(s) links. Built
 * from `toParagraphs` segments rendered through React, so there is no path from
 * a body to markup. Links are `nofollow ugc` — user content should not pass
 * this site's ranking to whatever it links.
 */

import { Fragment } from "react";
import { toParagraphs } from "../../lib/forum/text";
import styles from "./forum.module.css";

export function PostText({ body }: { body: string | null }) {
  const paragraphs = toParagraphs(body);
  if (!paragraphs.length) {
    return null;
  }
  return (
    <div className={styles.text}>
      {paragraphs.map((lines, p) => (
        <p key={p}>
          {lines.map((segments, l) => (
            <Fragment key={l}>
              {l > 0 ? <br /> : null}
              {segments.map((segment, s) =>
                segment.kind === "link" ? (
                  <a key={s} href={segment.href} rel="nofollow ugc noopener" target="_blank">
                    {segment.text}
                  </a>
                ) : (
                  <Fragment key={s}>{segment.text}</Fragment>
                ),
              )}
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}
