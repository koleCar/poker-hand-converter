/**
 * The Trainer screen: the web's Trainer (`/analysis/train`) in the app - a
 * spot on a table, the moves as buttons, the grade, the strategy for the
 * hand and why; "For you" deals the spots of your own biggest leaks from
 * this computer's analysed hands. A Pro feature (`ROUTE_FEATURE`), and a
 * screen that helps with play: hidden while a poker table is open (A10).
 *
 * From Analytics (docs/ANALYTICS.md Step 9) the screen's route parameter is
 * the Trainer's query (`#/trainer/<from=analytics&stat=…>`): that spot's
 * session opens straight away, and the parameter is dropped once it has
 * (a reload then continues the session, it does not deal "Play it" again).
 */
import { useEffect, useState } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";

import { useT } from "../i18n";
import { useAppKind } from "../lib/gameKind";
import { replaceParam, useRouteParam } from "../lib/router";
import { analyticsLink, Trainer as WebTrainer, TrainerHostProvider, type AnalyticsLink } from "../trainer/door";
import { storedSettings, useAppTrainerHost, useOutboxFlush } from "../trainer/host";

/** An Analytics link in the route parameter, or null. */
export function linkOfParam(param: string | null, set: string): AnalyticsLink | null {
  if (!param) return null;
  return analyticsLink(new URLSearchParams(param), set);
}

export function Trainer() {
  const t = useT();
  const [initial] = useState(storedSettings);
  const param = useRouteParam();
  // A link read once per arrival: a new one (another "Practise") opens its session anew.
  const readLink = (value: string | null) => {
    const read = linkOfParam(value, initial.set);
    return read && value ? { param: value, link: read } : null;
  };
  const [seen, setSeen] = useState(param);
  const [link, setLink] = useState<{ param: string; link: AnalyticsLink } | null>(() => readLink(param));
  if (param !== seen) {
    setSeen(param);
    const read = readLink(param);
    if (read) setLink(read);
  }
  // Once read, the link leaves the address.
  useEffect(() => {
    if (link) replaceParam("trainer", null);
  }, [link]);
  // "For you" deals the leaks of the kind of game chosen in the sidebar.
  const kinds = useAppKind();
  const host = useAppTrainerHost(kinds.kind);
  useOutboxFlush();
  // "For you" reads one kind of game's leaks: wait for the kind (a moment, once).
  if (kinds.kind === null) return <RailLoader size="page" centered label={t.analysis.loading} />;
  return (
    <TrainerHostProvider host={host}>
      <WebTrainer key={link?.param ?? ""} initial={initial} analytics={link?.link ?? null} />
    </TrainerHostProvider>
  );
}
