/**
 * `/analysis/session` (R5.1): the shared session review
 * (`@rail/ui/review/SessionReviewScreen`) over the web's data
 * (`lib/db/sessionReview.ts`), inside the Analysis tab.
 *
 * What is the web's: the address (`sessionQuery.ts`: the session, the break,
 * the Statistics filter's groups, written with `replaceState` as the reader
 * walks from session to session, so a reload, a bookmark and a hand's Back
 * link land on the same session), the sign-in gate, how a hand opens (its
 * analysis at `/analysis/h/<id>`, at the decision the list names, with a
 * Back link to this session) and where to analyse hands the analysis has not
 * seen yet (the overview's run button). The web cannot see poker tables, so
 * A10 is the screen's default instead: the latest session that has ended.
 */

"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { SessionQuery } from "@rail/ui/review/model";
import { SessionReviewScreen, type HandLinkProps } from "@rail/ui/review/SessionReviewScreen";
import { useUiStrings } from "@rail/ui/i18n";
import { encodePosition } from "@rail/ui/replayer/position";
import { useAuth } from "../../../lib/auth";
import { DATABASE_NOT_CONFIGURED_MESSAGE, isDatabaseConfigured } from "../../../lib/db/client";
import { webSessionReviewSource } from "../../../lib/db/sessionReview";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import { AnalysisNav } from "../AnalysisNav";
import { fromSessionQuery, parseSessionQuery, sessionQueryString } from "./sessionQuery";
import "../../../styles/stats.css";

interface SessionReviewTabProps {
  initialQuery: Record<string, string | string[] | undefined>;
  refreshToken?: number;
}

export function SessionReviewTab({ initialQuery, refreshToken = 0 }: SessionReviewTabProps) {
  const dict = useDict();
  const t = dict.learn.nav;
  const tab = dict.analysis.tab;
  const ui = useUiStrings();
  const auth = useAuth();
  const [query, setQuery] = useState<SessionQuery>(() => parseSessionQuery(initialQuery));

  const onQuery = useCallback((next: SessionQuery) => {
    setQuery(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", paths.analysisSession(sessionQueryString(next)));
    }
  }, []);

  const renderHandLink = useCallback(
    ({ handId, actionIndex, sessionAt, label, className, children }: HandLinkProps) => {
      const back = fromSessionQuery({ ...query, at: sessionAt });
      const position = actionIndex === null ? "" : `t=${encodePosition({ kind: "action", actionIndex })}&`;
      return (
        <Link href={paths.analysisHand(handId, `${position}${back}`)} className={className} aria-label={label}>
          {children}
        </Link>
      );
    },
    [query],
  );

  if (!isDatabaseConfigured) {
    return <p className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</p>;
  }

  if (!auth.isSignedIn) {
    return (
      <div className="stats">
        <header className="stats__head">
          <h2>{t.session}</h2>
        </header>
        <AnalysisNav current="session" />
        <div className="card stats-empty">
          <h3>{tab.signInHeading}</h3>
          <p className="muted">{tab.signInBody}</p>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
            {tab.signIn}
          </button>
        </div>
      </div>
    );
  }

  return (
    <SessionReviewScreen
      source={webSessionReviewSource}
      query={query}
      onQuery={onQuery}
      renderHandLink={renderHandLink}
      title={t.session}
      titleTag="h2"
      notice={<AnalysisNav current="session" />}
      reloadToken={refreshToken}
      coverageAction={
        <Link href={paths.analysis()} className="btn btn--sm">
          {ui.review.coverage.run}
        </Link>
      }
      renderState={(kind, text) => (
        <div
          className={kind === "error" ? "notice notice--error" : "card stats-empty"}
          role={kind === "error" ? "alert" : "status"}
        >
          {kind === "error" ? text : <p className="muted">{text}</p>}
        </div>
      )}
    />
  );
}
