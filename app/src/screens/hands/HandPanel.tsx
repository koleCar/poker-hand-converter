/**
 * The open hand: the shared replayer (`ReplayViewer`, the web's, drawn the
 * same way) fed by `useHand` over the app's `DataSource`, with the share link
 * beside full screen and the hand's tags and note behind a button in the
 * header (`HandNotes`), and Delete behind a confirmation (`DeleteHands`).
 * "Solver" opens the Solver tab at the hand's spot where the replayer stands
 * (`solver/handSpot.ts`); the globe opens the hand in the web's library at
 * the same point (`/analysis/hand?key=`, after it has synced). Tags and
 * notes stay on this computer.
 */
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useHand } from "@rail/ui/data";
import { Icon } from "@rail/ui/icon/Icon";
import { encodePosition, type ReplayPosition } from "@rail/ui/replayer/position";
import { ReplayViewer } from "@rail/ui/replayer/ReplayViewer";
import { useState } from "react";

import { DeleteHands } from "../../components/DeleteHands";
import { useT } from "../../i18n";
import { handAnalysisOf } from "../../analysis/service";
import { inApp, ipc, type HandAnnotations, type HandRow } from "../../lib/ipc";
import { hiddenDuringPlay } from "../../lib/duringPlay";
import { screenHref } from "../../lib/router";
import { handSpotOf } from "../../solver/handSpot";
import { useTablesOpen } from "../../lib/useTablesOpen";
import { viewParam } from "../analysis/view";
import { HandNotes } from "./HandNotes";
import styles from "./HandPanel.module.css";
import { ShareHand } from "./ShareHand";

interface HandPanelProps {
  handKey: string;
  /** The hand's list row, when it is loaded (for the room's name). */
  row: HandRow | null;
  /** Every tag in use, offered as the reader types one. */
  knownTags: string[];
  onClose: () => void;
  /** The note or tags changed: the list row shows it. */
  onAnnotated: (handKey: string, annotations: HandAnnotations) => void;
  /**
   * A link to another screen (the hand's analysis) goes here instead of
   * this page's address: the replayer window hands it to the main window.
   */
  onNavigate?: (href: string) => void;
  /** The hand was deleted (after its confirmation). */
  onDeleted?: (handKey: string) => void;
}

/** The Solver button: ready, finding the spot, or no spot for the hand where the replayer stands. */
type SolverButton = "idle" | "looking" | "none";

export function HandPanel({ handKey, row, knownTags, onClose, onAnnotated, onNavigate, onDeleted }: HandPanelProps) {
  const dict = useT();
  const t = dict.hands.panel;
  const [deleting, setDeleting] = useState(false);
  const state = useHand(handKey);
  const tablesOpen = useTablesOpen();
  // A10: no pot odds while a poker table is open.
  const noPotOdds = hiddenDuringPlay("potOdds", tablesOpen);
  // (R5.4) Nor the way into the hand's analysis.
  const noAnalysis = hiddenDuringPlay("analysis", tablesOpen);
  const noSolver = hiddenDuringPlay("solver", tablesOpen);
  const analysisHref = screenHref("analysis", viewParam({ kind: "hand", key: handKey, actionIndex: null, back: null }));
  /** Where the replayer stands (the Solver and the web open there), and the Solver button's state: this hand's only. */
  const [at, setAt] = useState<{ handKey: string; position: ReplayPosition | null; solver: SolverButton }>({
    handKey,
    position: null,
    solver: "idle",
  });
  const position = at.handKey === handKey ? at.position : null;
  const solver = at.handKey === handKey ? at.solver : "idle";
  const setSolver = (next: SolverButton) => setAt({ handKey, position, solver: next });
  const navigate = (href: string) => (onNavigate ? onNavigate(href) : (window.location.hash = href));

  const openSolver = async () => {
    if (state.status !== "ready" || solver === "looking") return;
    setSolver("looking");
    try {
      const result = await handAnalysisOf(handKey, state.hand as never);
      const spot = result ? handSpotOf(result.analysis.decisions, state.hand, position) : null;
      if (!spot) {
        setSolver("none");
        return;
      }
      setSolver("idle");
      navigate(screenHref("solver", spot.param));
    } catch {
      setSolver("none");
    }
  };

  return (
    <section className={styles.panel} aria-label={t.label}>
      <div className={styles.replayer}>
        {state.status === "ready" ? (
          <ReplayViewer
            key={handKey}
            hand={state.hand}
            site={row?.siteName ?? null}
            onClose={onClose}
            urlSync={false}
            potOdds={!noPotOdds}
            onPositionChange={(next) =>
              setAt((was) => ({
                handKey,
                position: next,
                solver: was.handKey === handKey && was.solver === "looking" ? "looking" : "idle",
              }))
            }
            headerEnd={<ShareHand handKey={handKey} hand={state.hand} />}
            headerExtra={
              <>
                {noAnalysis ? null : (
                  <a
                    className="btn btn--sm"
                    href={analysisHref}
                    title={dict.analysis.hand.openTitle}
                    onClick={
                      onNavigate
                        ? (event) => {
                            event.preventDefault();
                            onNavigate(analysisHref);
                          }
                        : undefined
                    }
                  >
                    {dict.analysis.hand.open}
                  </a>
                )}
                {noSolver ? null : (
                  <button
                    type="button"
                    className="btn btn--sm"
                    title={solver === "none" ? t.solverNone : solver === "looking" ? t.solverLooking : t.openInSolverTitle}
                    aria-busy={solver === "looking"}
                    disabled={solver === "none"}
                    onClick={() => void openSolver()}
                  >
                    {t.openInSolver}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--icon"
                  disabled={!inApp}
                  aria-label={t.openInWeb}
                  title={t.openInWebTitle}
                  onClick={() => void ipc.handWebOpen(handKey, position ? encodePosition(position) : null).catch(() => undefined)}
                >
                  <Icon name="globe" />
                </button>
                <HandNotes key={handKey} handKey={handKey} knownTags={knownTags} onAnnotated={onAnnotated} />
                {onDeleted ? (
                  <button
                    type="button"
                    className="btn btn--icon"
                    aria-label={dict.hands.actions.delete(1)}
                    title={dict.hands.actions.delete(1)}
                    onClick={() => setDeleting(true)}
                  >
                    <Icon name="trash" />
                  </button>
                ) : null}
              </>
            }
          />
        ) : state.status === "loading" ? (
          <RailLoader label={t.loading} showLabel centered />
        ) : (
          <p className={styles.status} role="status">
            {state.status === "missing" ? t.missing : t.failed(state.error.message)}
          </p>
        )}
      </div>
      {deleting && onDeleted ? (
        <DeleteHands
          handKeys={[handKey]}
          onClose={() => setDeleting(false)}
          onDone={() => {
            setDeleting(false);
            onDeleted(handKey);
          }}
        />
      ) : null}
      {noPotOdds ? (
        <p className={styles.hint} role="note">
          {t.potOddsHidden}
        </p>
      ) : null}
    </section>
  );
}
