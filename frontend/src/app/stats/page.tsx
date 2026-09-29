import type { Metadata } from "next";
import { StatsScreen } from "./StatsScreen";
import { en } from "../../lib/i18n/en";
import { paths } from "../../lib/routes";

/**
 * Statistics.
 *
 * Deliberately *not* behind the `redirectWhenEmpty` gate the library uses. The
 * tab stays hidden from the bar until there is a library behind it, but a typed
 * or bookmarked `/stats` renders the screen and lets it explain itself — "sign
 * in", "nothing saved yet", "statistics are not set up on this database".
 * Bouncing someone to the converter would answer a question they asked by
 * pretending they did not.
 *
 * That honest-degradation behaviour is a property worth keeping across the
 * framework move, so it is verified in a running app rather than reasoned about.
 */
export const metadata: Metadata = {
  title: en.meta.stats.title,
  description: en.meta.stats.description,
  alternates: { canonical: paths.stats() },
  robots: { index: false, follow: true },
};

export default function StatsPage() {
  return <StatsScreen />;
}
