import "server-only";

import { excerpt } from "../forum/text";
import type { ForumPost } from "../forum/types";
import { canonicalUrl, paths } from "../routes";

/**
 * RSS 2.0 for the forum (#55): the newest threads, everywhere or per board.
 *
 * Built by hand rather than with a library: it is one template, and every
 * value in it goes through `xml()`. Read as `anon` by the callers, like the
 * feed page, so a feed reader sees exactly what a signed-out visitor does —
 * and a poll's hand is not in the item, because the card that would show it
 * reads null for a sealed hand.
 */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Characters XML 1.0 cannot carry at all; a feed with one is unreadable.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

export function rssDocument(options: { title: string; description: string; selfPath: string; linkPath: string; posts: ForumPost[] }): string {
  const items = options.posts
    .map((post) => {
      const url = canonicalUrl(paths.post(post.board.slug, post.publicId, post.slug));
      const summary = post.poll ? `What would you do? ${excerpt(post.body, 400)}` : excerpt(post.body, 400);
      return [
        "<item>",
        `<title>${xml(post.title)}</title>`,
        `<link>${xml(url)}</link>`,
        `<guid isPermaLink="true">${xml(url)}</guid>`,
        `<pubDate>${new Date(post.createdAt).toUTCString()}</pubDate>`,
        post.author ? `<dc:creator>${xml(post.author.username)}</dc:creator>` : "",
        `<category>${xml(post.board.name)}</category>`,
        summary ? `<description>${xml(summary)}</description>` : "",
        "</item>",
      ]
        .filter(Boolean)
        .join("");
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>${xml(options.title)}</title>
<link>${xml(canonicalUrl(options.linkPath))}</link>
<description>${xml(options.description)}</description>
<language>en</language>
<atom:link href="${xml(canonicalUrl(options.selfPath))}" rel="self" type="application/rss+xml"/>
${items}
</channel>
</rss>
`;
}

export const RSS_HEADERS = {
  "content-type": "application/rss+xml; charset=utf-8",
  "cache-control": "public, max-age=600, stale-while-revalidate=3600",
};
