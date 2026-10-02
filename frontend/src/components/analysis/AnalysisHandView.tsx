/**
 * One hand's analysis: the replayer, with a pip on the rail for every hero
 * decision and the Analysis sheet open on the loudest one (§6.0, §6.1).
 *
 * The stored analysis is read back (`analysis_hand`) when the hand has one at
 * the current version. When it does not — analysed under an older version, or
 * uploaded since the last run — the same pure function runs here instead and
 * the sheet says so: the reader gets the answer the run would store, without
 * being sent to press a button first.
 *
 * Private to the owner: the hand comes from `get_hand` and the analysis from
 * `analysis_hand`, both under RLS, so a guessed id is "not in your library"
 * whoever's it is.
 */

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { HandAnalysis } from "../../lib/analysis/types";
import { useAuth } from "../../lib/auth";
import { analyseHandNow, fetchHandAnalysis, getHand, isDatabaseConfigured, DATABASE_NOT_CONFIGURED_MESSAGE } from "../../lib/db";
import { useDict } from "../../lib/i18n/client";
import { getParser } from "../../lib/phf";
import type { PhfHand } from "../../lib/phf/types";
import { paths } from "../../lib/routes";
import { decodePosition, type ReplayPosition } from "../replayer/position";
import { ReplayViewer, type ReplayMark } from "../replayer/ReplayViewer";
import { AnalysisSheet, worstDecision } from "./AnalysisSheet";
import { AnalysisShareToggle } from "./AnalysisShareToggle";
import styles from "./analysis.module.css";
import { ANALYSIS_SHEET_ICON as SHEET_ICON, gradeMarks } from "./SharedAnalysis";
import { listQuery, parseListState } from "./listState";

type Loaded =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; hand: PhfHand; site: string | null; analysis: HandAnalysis; fresh: boolean };

interface AnalysisHandViewProps {
  handId: string;
  /** The page's `searchParams`: the list the reader came from, and `?t=`. */
  query: Record<string, string | string[] | undefined>;
}

export function AnalysisHandView({ handId, query }: AnalysisHandViewProps) {
  const t = useDict().analysis;
  const auth = useAuth();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [sheetOpen, setSheetOpen] = useState(true);
  const back = paths.analysis(listQuery(parseListState(query)));
  const linkedPosition = useMemo<ReplayPosition | null>(() => {
    const raw = query.t;
    return decodePosition(Array.isArray(raw) ? raw[0] : raw);
  }, [query]);

  useEffect(() => {
    if (!isDatabaseConfigured || !auth.isSignedIn) {
      return;
    }
    let live = true;
    void (async () => {
      try {
        const [record, stored] = await Promise.all([getHand(handId), fetchHandAnalysis(handId)]);
        if (!live) return;
        if (!record) {
          setLoaded({ status: "missing" });
          return;
        }
        const site = record.site && record.site !== "standard" ? (getParser(record.site)?.name ?? record.site) : null;
        // A structured clone: `analyzeHand` may label positions on the document
        // it is given, and the replayer must see the hand exactly as stored.
        // The fresh path loads the preflop charts first (once per page load).
        const analysis = stored ?? (await analyseHandNow(structuredClone(record.phf)));
        if (!live) return;
        setLoaded({ status: "ready", hand: record.phf, site, analysis, fresh: stored === null });
      } catch (error) {
        if (live) setLoaded({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [auth.isSignedIn, handId]);

  const marks = useMemo<ReplayMark[]>(
    () => (loaded.status === "ready" ? gradeMarks(loaded.analysis, t) : []),
    [loaded, t],
  );

  if (!isDatabaseConfigured) {
    return <p className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</p>;
  }

  const backLink = (
    <Link href={back} className={`btn btn--ghost btn--sm ${styles.back}`}>
      ← {t.hand.back}
    </Link>
  );

  if (!auth.isSignedIn) {
    return (
      <div className={styles.handPage}>
        {backLink}
        <div className="card stats-empty">
          <h3>{t.tab.signInHeading}</h3>
          <p className="muted">{t.tab.signInBody}</p>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
            {t.tab.signIn}
          </button>
        </div>
      </div>
    );
  }

  if (loaded.status !== "ready") {
    return (
      <div className={styles.handPage}>
        {backLink}
        {loaded.status === "loading" ? <p className="muted">{t.hand.loading}</p> : null}
        {loaded.status === "missing" ? <p className="notice notice--warn">{t.hand.notFound}</p> : null}
        {loaded.status === "error" ? <p className="notice notice--error">{loaded.message}</p> : null}
      </div>
    );
  }

  const worst = worstDecision(loaded.analysis);
  const opening: ReplayPosition | null =
    linkedPosition ?? (worst ? { kind: "action", actionIndex: worst.actionIndex } : null);

  return (
    <div className={styles.handPage}>
      {backLink}
      {/* Private by default (§8.4): the owner's one switch for every place this hand is public. */}
      <AnalysisShareToggle surface="hand" id={handId} />
      <section className="card card--flush">
        <ReplayViewer
          key={loaded.hand.meta.handKey}
          hand={loaded.hand}
          site={loaded.site}
          initialPosition={opening}
          marks={marks}
          sheet={{
            label: t.sheet.title,
            buttonTitle: t.sheet.toggleTitle,
            icon: SHEET_ICON,
            open: sheetOpen,
            onOpenChange: setSheetOpen,
            render: ({ frame, seek }) => (
              <AnalysisSheet
                analysis={loaded.analysis}
                frame={frame}
                seek={seek}
                fresh={loaded.fresh}
                hand={loaded.hand}
              />
            ),
          }}
        />
      </section>
    </div>
  );
}
