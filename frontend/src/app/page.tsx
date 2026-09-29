import type { Metadata } from "next";
import { HomeScreen } from "./HomeScreen";
import { en } from "../lib/i18n/en";
import { paths } from "../lib/routes";

/**
 * The feed. Placeholder, for now.
 *
 * `/` used to be the converter. Moving it to `/convert` is a product decision
 * as much as a technical one (#27): the thing this product is becoming is a
 * place where hands get posted and argued about, and the landing page is where
 * that claim gets made. Until the feed exists, this screen says so plainly and
 * points at the two things that do work, rather than pretending.
 *
 * `/upload` and `/converter` 308 to `/convert`, and `/convert` itself was
 * already an alias in the old matcher — so every address anyone has ever been
 * given for the converter still resolves to it. `/` is deliberately absent from
 * the redirect table: redirecting it would make the feed unreachable.
 */
export const metadata: Metadata = {
  title: en.meta.home.title,
  description: en.meta.home.description,
  alternates: { canonical: paths.home() },
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // `/auth/callback` sends a failed exchange here with `?auth=failed` rather
  // than rendering an error page — see that route for why the auth server's own
  // message is deliberately not carried across.
  const params = await searchParams;
  return <HomeScreen authFailed={params.auth === "failed"} />;
}
