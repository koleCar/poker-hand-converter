import type { Metadata } from "next";
import { PlayersPage } from "./PlayersPage";
import { getDict } from "../../lib/i18n/server";
import { paths } from "../../lib/routes";

/**
 * Players (R4.5c): the shared Players screen over this account's opponents.
 *
 * Not behind the `redirectWhenEmpty` gate, as `/stats` is not: the tab waits
 * in the bar until there is a library, but a typed `/players` renders and
 * explains itself - sign in, opponent statistics off, nothing yet.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.players.title,
    description: en.meta.players.description,
    alternates: { canonical: paths.players() },
    robots: { index: false, follow: true },
  };
}

export default function Page() {
  return <PlayersPage />;
}
