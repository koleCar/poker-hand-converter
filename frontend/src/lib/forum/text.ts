/**
 * Post and comment bodies are plain text. This turns one into paragraphs and
 * link segments — data, not HTML, so the page renders it through React's
 * escaping and there is no path from a body to markup.
 *
 * Links: `http(s)://…` only, rendered `rel="nofollow ugc noopener"` by the
 * caller. Trailing punctuation that is almost never part of a URL (`.,;:!?)`)
 * is left outside it.
 */

export type TextSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; href: string; text: string }
  | { kind: "mention"; username: string; text: string };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

/**
 * `@username` — the same shape `fan_out_comment_notifications` matches, so what
 * renders as a mention is exactly what notified somebody: a username character
 * class, 3–24 long, not glued to a preceding word or `@`.
 */
const MENTION_PATTERN = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9][A-Za-z0-9_]{2,23})/g;

function mentionify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const start = (match.index ?? 0) + match[1].length;
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "mention", username: match[2], text: `@${match[2]}` });
    last = start + match[2].length + 1;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

export function linkify(line: string): TextSegment[] {
  return linkUrls(line).flatMap((segment) => (segment.kind === "text" ? mentionify(segment.text) : [segment]));
}

function linkUrls(line: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    let url = match[0];
    const trailing = url.match(/[.,;:!?)\]]+$/)?.[0] ?? "";
    if (trailing) {
      url = url.slice(0, -trailing.length);
    }
    const start = match.index ?? 0;
    if (start > last) {
      segments.push({ kind: "text", text: line.slice(last, start) });
    }
    segments.push({ kind: "link", href: url, text: url });
    last = start + url.length;
  }
  if (last < line.length) {
    segments.push({ kind: "text", text: line.slice(last) });
  }
  return segments;
}

/** Paragraphs split on blank lines; each paragraph is its lines, each linkified. */
export function toParagraphs(body: string | null | undefined): TextSegment[][][] {
  return (body ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => paragraph.split("\n").map(linkify));
}

/** A plain-text excerpt for descriptions and JSON-LD. */
export function excerpt(body: string | null | undefined, max = 200): string {
  const flat = (body ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
