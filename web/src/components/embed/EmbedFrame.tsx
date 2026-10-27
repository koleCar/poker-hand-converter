import type { ReactNode } from "react";
import { RailMark } from "../brand/RailMark";
import type { Dict } from "../../lib/i18n/types";
import "../../styles/embed.css";

/**
 * The chrome of an embedded replayer (#52): the replayer, and one line under it
 * that says where it came from.
 *
 * Nothing else. No shell, no sign-in, no navigation — this is a guest in
 * somebody else's page, and everything it renders is something that page did
 * not ask for. The one link is the point of the exercise: every embed on a
 * forum or a blog is a backlink, and it opens in a new tab so the host page is
 * not navigated away from under its reader.
 */
export function EmbedFrame({ href, children, t: en }: { href: string; children: ReactNode; t: Dict }) {
  return (
    <div className="embed">
      <div className="embed__body">{children}</div>
      <a className="embed__credit" href={href} target="_blank" rel="noopener">
        <RailMark size={16} />
        <span>{en.embed.credit}</span>
      </a>
    </div>
  );
}

/** What an embed says when the hand behind it is gone. Short: it sits in a box. */
export function EmbedGone({ href, t: en }: { href: string; t: Dict }) {
  return (
    <EmbedFrame href={href} t={en}>
      <p className="embed__gone">{en.embed.gone}</p>
    </EmbedFrame>
  );
}

