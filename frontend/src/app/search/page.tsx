import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { ServerFrame } from "../../components/shell/ServerFrame";
import { en } from "../../lib/i18n/en";
import { paths } from "../../lib/routes";
import { searchForum } from "../../lib/server/forum";
import styles from "../../components/forum/forum.module.css";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function queryOf(params: Record<string, string | string[] | undefined>): string {
  const raw = Array.isArray(params.q) ? params.q[0] : params.q;
  return (raw ?? "").trim().slice(0, 200);
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const q = queryOf(await searchParams);
  return {
    title: en.forum.searchPage.metaTitle(q),
    // Search results pages are not content; indexing them invites a search
    // engine to index an unbounded space of near-duplicates.
    robots: { index: false, follow: true },
  };
}

/** `ts_headline` marks matches with `<<` `>>`. Split into plain and marked parts — data, not HTML. */
function highlightParts(text: string): Array<{ text: string; mark: boolean }> {
  const out: Array<{ text: string; mark: boolean }> = [];
  const pattern = /<<(.*?)>>/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start), mark: false });
    out.push({ text: match[1], mark: true });
    last = start + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: false });
  return out;
}

function Snippet({ text }: { text: string }) {
  return (
    <>
      {highlightParts(text).map((part, index) =>
        part.mark ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>,
      )}
    </>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const q = queryOf(await searchParams);
  const hits = q ? await searchForum(q) : [];

  return (
    <ServerFrame tab="forum">
      <section className="stack">
        <h1 className={styles.postTitle}>{en.forum.searchPage.heading}</h1>
        <form action={paths.search()} method="get" className={styles.searchForm} role="search">
          <input name="q" type="search" defaultValue={q} placeholder={en.forum.searchPlaceholder} aria-label={en.forum.search} />
          <button type="submit" className="btn btn--sm">
            {en.forum.searchPage.button}
          </button>
        </form>
        {q ? (
          <p className="muted">{hits.length ? en.forum.searchPage.results(hits.length, q) : en.forum.searchPage.none(q)}</p>
        ) : null}
        <ol className={styles.hits}>
          {hits.map((hit) => {
            const href =
              hit.type === "comment" && hit.seq
                ? paths.comment(hit.board, hit.publicId, hit.slug, hit.seq)
                : paths.post(hit.board, hit.publicId, hit.slug);
            return (
              <li key={`${hit.type}-${hit.publicId}-${hit.seq ?? 0}`} className={styles.card}>
                <div className={styles.cardBody}>
                  <p className={styles.cardTitle}>
                    {hit.type === "comment" ? `${en.forum.searchPage.commentOn} ` : null}
                    <Link href={href}>{hit.title}</Link>
                  </p>
                  <p className={styles.meta}>
                    <Snippet text={hit.snippet} />
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </ServerFrame>
  );
}
