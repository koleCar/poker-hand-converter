import { useEffect } from "react";

export interface DocumentMeta {
  title: string;
  description: string;
  /** App-relative path or absolute URL; used for canonical + og:url. */
  canonicalPath?: string;
  image?: string;
  /** Share pages should not be indexed until they are known-good content. */
  noIndex?: boolean;
}

const MANAGED = "data-route-meta";

function upsert(selector: string, create: () => HTMLElement, apply: (el: HTMLElement) => void) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = create();
    el.setAttribute(MANAGED, "");
    document.head.appendChild(el);
  }
  apply(el);
}

function meta(attr: "name" | "property", key: string, content: string) {
  upsert(`meta[${attr}="${key}"]`, () => {
    const el = document.createElement("meta");
    el.setAttribute(attr, key);
    return el;
  }, (el) => el.setAttribute("content", content));
}

/**
 * Client-side title/meta per route. Crawlers that do not run JS are served
 * pre-rendered tags by `api/share-meta` (see frontend/vercel.json).
 */
export function useDocumentMeta({
  title,
  description,
  canonicalPath,
  image,
  noIndex,
}: DocumentMeta): void {
  useEffect(() => {
    const url =
      canonicalPath === undefined
        ? window.location.href
        : canonicalPath.startsWith("http")
          ? canonicalPath
          : `${window.location.origin}${canonicalPath}`;
    const imageUrl = image
      ? image.startsWith("http")
        ? image
        : `${window.location.origin}${image}`
      : `${window.location.origin}/og-default.png`;

    document.title = title;

    meta("name", "description", description);
    meta("name", "robots", noIndex ? "noindex, follow" : "index, follow");

    meta("property", "og:type", "website");
    meta("property", "og:site_name", "PokerConverter");
    meta("property", "og:title", title);
    meta("property", "og:description", description);
    meta("property", "og:url", url);
    meta("property", "og:image", imageUrl);
    meta("property", "og:image:width", "1200");
    meta("property", "og:image:height", "630");

    meta("name", "twitter:card", "summary_large_image");
    meta("name", "twitter:title", title);
    meta("name", "twitter:description", description);
    meta("name", "twitter:image", imageUrl);

    upsert(
      'link[rel="canonical"]',
      () => {
        const el = document.createElement("link");
        el.setAttribute("rel", "canonical");
        return el;
      },
      (el) => el.setAttribute("href", url),
    );
  }, [title, description, canonicalPath, image, noIndex]);
}
