/**
 * The replayer's own window (`src-tauri/src/replayer.rs`): the hand chosen
 * on the Hands screen, in the web's replayer at the web's width, with its
 * tags and note behind a header button (`HandPanel`). It asks for its hand when it loads and is told each new one
 * after that; the hand's row (for the room's name) and the tags in use are
 * read here. Its close button closes the window; a tag or note changed here
 * is told to the main window, whose list shows it.
 */
import { useEffect, useState } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";

import { useT } from "../i18n";
import { emitHandAnnotated, inApp, ipc, onReplayerHand, type HandRow } from "../lib/ipc";
import { EMPTY_FILTER, toQuery } from "../screens/hands/filter";
import { HandPanel } from "../screens/hands/HandPanel";
import styles from "./ReplayerWindow.module.css";

/** How long to keep looking for the replayer to give it the keyboard, ms. */
const FOCUS_FOR_MS = 2000;

export function ReplayerWindow() {
  const t = useT().hands.panel;
  const [handKey, setHandKey] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [row, setRow] = useState<HandRow | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);

  // The hand: asked for once, then each new one as it is chosen.
  useEffect(() => {
    if (!inApp) return;
    ipc
      .replayerHand()
      .then((key) => {
        if (key !== null) setHandKey((current) => current ?? key);
      })
      .catch(() => undefined)
      .finally(() => setAsked(true));
    return onReplayerHand(setHandKey);
  }, []);

  // Its row, and the tags in use (read again per hand: a tag may be new).
  useEffect(() => {
    if (handKey === null) return;
    let live = true;
    ipc
      .handsByKey([handKey])
      .then((rows) => {
        if (live) setRow(rows[0] ?? null);
      })
      .catch(() => undefined);
    ipc
      .handsFacets(toQuery(EMPTY_FILTER))
      .then((facets) => {
        if (live) setKnownTags(facets.tags.map((tag) => tag.value));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [handKey]);

  // The replayer's keys (←/→, space, Home/End) work once it has focus; it
  // appears when the hand has loaded.
  useEffect(() => {
    if (handKey === null) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const replayer = document.querySelector<HTMLElement>(".rp");
      if (replayer) replayer.focus();
      if (replayer || Date.now() - started > FOCUS_FOR_MS) window.clearInterval(timer);
    }, 50);
    return () => window.clearInterval(timer);
  }, [handKey]);

  return (
    <main className={styles.window}>
      {handKey !== null ? (
        <HandPanel
          handKey={handKey}
          // The previous hand's row until this one's arrives: not shown.
          row={row?.handKey === handKey ? row : null}
          knownTags={knownTags}
          onClose={() => {
            ipc.replayerClose().catch(() => undefined);
          }}
          onAnnotated={(key, annotations) => emitHandAnnotated({ handKey: key, annotations })}
          onNavigate={(href) => {
            ipc.replayerOpenInMain(href).catch(() => undefined);
          }}
        />
      ) : asked ? (
        <p className={styles.empty}>{t.choose}</p>
      ) : (
        <RailLoader label={t.loading} centered />
      )}
    </main>
  );
}
