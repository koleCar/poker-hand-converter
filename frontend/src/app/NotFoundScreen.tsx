"use client";

import Link from "next/link";
import { AppFrame } from "../components/shell/AppFrame";
import { en } from "../lib/i18n/en";
import { paths } from "../lib/routes";

/** Client half of the 404, so it gets the same bar and dialog as every screen. */
export function NotFoundScreen() {
  return (
    <AppFrame tab={null}>
      {() => (
        <section className="shell__notfound">
          <span className="shell__notfound-mark" aria-hidden="true">
            ♠
          </span>
          <h1>{en.notFound.heading}</h1>
          <p>{en.notFound.body}</p>
          <div className="shell__notfound-actions">
            <Link href={paths.convert()} className="btn btn--primary">
              {en.notFound.convertCta}
            </Link>
            <Link href={paths.library()} className="btn btn--ghost">
              {en.notFound.libraryCta}
            </Link>
          </div>
        </section>
      )}
    </AppFrame>
  );
}
