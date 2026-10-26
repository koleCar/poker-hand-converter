/**
 * The small Markdown the legal documents use (`docs/legal/`, R6.5), rendered
 * to React: headings, paragraphs, lists, block quotes, tables; bold, inline
 * code and links inside them. Nothing else - no HTML passes through (every
 * piece of text is a React text node), and a link goes only to a path on this
 * site or an `https://` address.
 *
 * No library: the documents are ours, the subset is fixed, and a full
 * Markdown parser would be the largest thing on two static pages.
 */

import type { ReactNode } from "react";

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** Splits a document into blocks. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2].trim() });
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const parts: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        parts.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: parts.join(" ") });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^#{1,3}\s/.test(lines[i])) {
        if (/^\s*[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        } else if (items.length > 0) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
        }
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(cells(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    const parts: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !lines[i].startsWith(">") &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith("|")
    ) {
      parts.push(lines[i].trim());
      i++;
    }
    blocks.push({ kind: "paragraph", text: parts.join(" ") });
  }
  return blocks;
}

/** A link target this page may render: a path here, or https. */
function safeHref(href: string): string | null {
  if (/^\/(?!\/)/.test(href)) return href;
  if (/^https:\/\/[^\s]+$/.test(href)) return href;
  return null;
}

/** Bold, inline code and links; everything else is text. */
export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];
    const key = `${keyPrefix}-${n++}`;
    if (token.startsWith("**")) {
      out.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith("`")) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = link ? safeHref(link[2]) : null;
      out.push(
        link && href ? (
          <a key={key} href={href}>
            {link[1]}
          </a>
        ) : (
          (link?.[1] ?? token)
        ),
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The document as React, one element per block. `skipTitle` drops the first
 * `#` heading (the page shows its own); `tableClass` is the box a table
 * scrolls in on a narrow screen.
 */
export function renderMarkdown(
  source: string,
  options: { skipTitle?: boolean; tableClass?: string } = {},
): ReactNode[] {
  let blocks = parseBlocks(source);
  if (options.skipTitle && blocks[0]?.kind === "heading" && blocks[0].level === 1) {
    blocks = blocks.slice(1);
  }
  return blocks.map((block, index) => {
    const key = `b${index}`;
    switch (block.kind) {
      case "heading": {
        const Tag = block.level === 1 ? "h1" : block.level === 2 ? "h2" : "h3";
        return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
      }
      case "paragraph":
        return <p key={key}>{renderInline(block.text, key)}</p>;
      case "quote":
        return <blockquote key={key}>{renderInline(block.text, key)}</blockquote>;
      case "list":
        return (
          <ul key={key}>
            {block.items.map((item, i) => (
              <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
            ))}
          </ul>
        );
      case "table":
        return (
          <div key={key} className={options.tableClass}>
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, i) => (
                    <th key={i} scope="col">
                      {renderInline(cell, `${key}-h${i}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c}>{renderInline(cell, `${key}-${r}-${c}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}
