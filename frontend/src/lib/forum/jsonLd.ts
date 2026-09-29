/**
 * Structured data for a thread: `DiscussionForumPosting` with its comments,
 * plus a `BreadcrumbList`. Google has a dedicated forum rich result for the
 * former, and it is the single biggest SEO lever in the plan (#36).
 *
 * Pure. The caller serialises with {@link jsonLdScript}, which is the only safe
 * way to put this in a `<script>`: a comment containing `</script>` must not be
 * able to end the tag.
 */

import type { ForumComment, ForumPost } from "./types";

export function discussionJsonLd(input: {
  post: ForumPost;
  comments: ForumComment[];
  url: string;
  profileUrl: (username: string) => string;
  boardUrl: string;
  homeUrl: string;
  text: string;
}) {
  const { post, comments, url, profileUrl } = input;
  const person = (author: { username: string } | null) =>
    author ? { "@type": "Person", name: author.username, url: profileUrl(author.username) } : { "@type": "Person", name: "[deleted]" };

  const posting = {
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    headline: post.title,
    text: input.text,
    url,
    datePublished: post.createdAt,
    ...(post.editedAt ? { dateModified: post.editedAt } : {}),
    author: person(post.author),
    interactionStatistic: [
      { "@type": "InteractionCounter", interactionType: "https://schema.org/LikeAction", userInteractionCount: post.upvotes },
      { "@type": "InteractionCounter", interactionType: "https://schema.org/CommentAction", userInteractionCount: post.commentCount },
    ],
    comment: comments
      .filter((comment) => comment.body && !comment.deleted && !comment.removed)
      .slice(0, 100)
      .map((comment) => ({
        "@type": "Comment",
        text: comment.body,
        datePublished: comment.createdAt,
        author: person(comment.author),
        url: `${url}#c-${comment.seq}`,
        interactionStatistic: {
          "@type": "InteractionCounter",
          interactionType: "https://schema.org/LikeAction",
          userInteractionCount: comment.upvotes,
        },
      })),
  };

  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Rail", item: input.homeUrl },
      { "@type": "ListItem", position: 2, name: post.board.name, item: input.boardUrl },
      { "@type": "ListItem", position: 3, name: post.title, item: url },
    ],
  };

  return [posting, breadcrumbs];
}

/** JSON for a `<script type="application/ld+json">`, with `<` escaped so no string can close the tag. */
export function jsonLdScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
