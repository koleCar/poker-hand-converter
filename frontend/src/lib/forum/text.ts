/**
 * Post and comment bodies are plain text. This turns one into paragraphs and
 * link segments — data, not HTML, so the page renders it through React's
 * escaping and there is no path from a body to markup.
 *
 * Links: `http(s)://…` only, rendered `rel="nofollow ugc noopener"` by the
 * caller. Trailing punctuation that is almost never part of a URL (`.,;:!?)`)
 * is left outside it.
 */

export type TextSegment = { kind: "text"; text: string } | { kind: "link"; href: string; text: string };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

export function linkify(line: string): TextSegment[] {
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
