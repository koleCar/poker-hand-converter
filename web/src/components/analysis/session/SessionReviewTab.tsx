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
 *
 * "Off your preflop charts" is graded against Rail's charts.
 */

"use client";

import { kindOf, pinFormats } from "@rail/ui/hands/gameKind";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { shippedChartDeviations, type SessionQuery } from "@rail/ui/review/model";
import { SessionReviewScreen, type HandLinkProps } from "@rail/ui/review/SessionReviewScreen";
import { useUiStrings } from "@rail/ui/i18n";
import { encodePosition } from "@rail/ui/replayer/position";
import { useAuth } from "../../../lib/auth";
import { DATABASE_NOT_CONFIGURED_MESSAGE, isDatabaseConfigured } from "../../../lib/db/client";
import { webSessionReviewSource } from "../../../lib/db/sessionReview";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import { AnalysisNav } from "../AnalysisNav";
import { useAnalysisKind } from "../analysisKind";
import { fromSessionQuery, parseSessionQuery, sessionQueryString } from "./sessionQuery";
import "../../../styles/stats.css";
import { KindSkeleton, SessionSkeleton, SkStatus } from "../ui/Skeleton";
import { Dismissible } from "@rail/ui/notice/Dismissible";

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
  const [asked, setQuery] = useState<SessionQuery>(() => parseSessionQuery(initialQuery));
  const signedIn = auth.isSignedIn;
  // One kind of game, never both (`analysisKind.ts`): the link's formats'
  // kind, else the visit's, else the one with more analysed hands. The query
  // the screen reads always names that kind's formats.
  const kinds = useAnalysisKind(kindOf(asked.filter.formats ?? []), isDatabaseConfigured && signedIn, refreshToken);
  const query = useMemo<SessionQuery | null>(
    () => (kinds.kind === null ? null : { ...asked, filter: { ...asked.filter, formats: pinFormats(asked.filter.formats, kinds.kind) } }),
    [asked, kinds.kind],
  );
  const onQuery = useCallback((next: SessionQuery) => {
    setQuery(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", paths.analysisSession(sessionQueryString(next)));
    }
  }, []);

  const renderHandLink = useCallback(
    ({ handId, actionIndex, sessionAt, label, className, children }: HandLinkProps) => {
      const back = fromSessionQuery({ ...(query ?? asked), at: sessionAt });
      const position = actionIndex === null ? "" : `t=${encodePosition({ kind: "action", actionIndex })}&`;
      return (
        <Link href={paths.analysisHand(handId, `${position}${back}`)} className={className} aria-label={label}>
          {children}
        </Link>
      );
    },
    [query, asked],
  );

  if (!isDatabaseConfigured) {
    return <Dismissible className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</Dismissible>;
  }

  if (!auth.isSignedIn) {
    return (
      <div className="stats">
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

  if (query === null) {
    return (
      <div className="stats">
        <AnalysisNav current="session" />
        <SkStatus label={ui.review.loading}>
          <KindSkeleton />
          <SessionSkeleton />
        </SkStatus>
      </div>
    );
  }

  return (
    <SessionReviewScreen
      kindCounts={kinds.counts}
      source={webSessionReviewSource}
      deviationSource={shippedChartDeviations}
      query={query}
      onQuery={onQuery}
      renderHandLink={renderHandLink}
      title={t.session}
      titleTag="h2"
      hideTitle
      intro={false}
      layout="table"
      notice={<AnalysisNav current="session" />}
      reloadToken={refreshToken}
      coverageAction={
        <Link href={paths.analysis()} className="btn btn--sm">
          {ui.review.coverage.run}
        </Link>
      }
      renderState={(kind, text) =>
        kind === "loading" ? (
          <SkStatus label={text}>
            <SessionSkeleton />
          </SkStatus>
        ) : (
          kind === "error" ? (
            <Dismissible as="div" className="notice notice--error" role="alert">
              {text}
            </Dismissible>
          ) : (
            <div className="card stats-empty" role="status">
              <p className="muted">{text}</p>
            </div>
          )
        )
      }
    />
  );
}
