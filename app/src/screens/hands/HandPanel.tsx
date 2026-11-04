/**
 * The open hand: the shared replayer (`ReplayViewer`, the web's, drawn the
 * same way) fed by `useHand` over the app's `DataSource`, with the share link
 * beside full screen and the hand's tags and note behind a button in the
 * header (`HandNotes`). "Open on the web" is a placeholder until tags and
 * notes sync.
 */
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useHand } from "@rail/ui/data";
import { Icon } from "@rail/ui/icon/Icon";
import { ReplayViewer } from "@rail/ui/replayer/ReplayViewer";

import { useT } from "../../i18n";
import type { HandAnnotations, HandRow } from "../../lib/ipc";
import { hiddenDuringPlay } from "../../lib/duringPlay";
import { screenHref } from "../../lib/router";
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
}

export function HandPanel({ handKey, row, knownTags, onClose, onAnnotated, onNavigate }: HandPanelProps) {
  const dict = useT();
  const t = dict.hands.panel;
  const state = useHand(handKey);
  const tablesOpen = useTablesOpen();
  // A10: no pot odds while a poker table is open.
  const noPotOdds = hiddenDuringPlay("potOdds", tablesOpen);
  // (R5.4) Nor the way into the hand's analysis.
  const noAnalysis = hiddenDuringPlay("analysis", tablesOpen);
  const analysisHref = screenHref("analysis", viewParam({ kind: "hand", key: handKey, actionIndex: null, back: null }));

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
                <button
                  type="button"
                  className="btn btn--icon"
                  disabled
                  aria-label={t.openInWeb}
                  title={t.openInWebSoon}
                >
                  <Icon name="globe" />
                </button>
                <HandNotes key={handKey} handKey={handKey} knownTags={knownTags} onAnnotated={onAnnotated} />
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
      {noPotOdds ? (
        <p className={styles.hint} role="note">
          {t.potOddsHidden}
        </p>
      ) : null}
    </section>
  );
}
