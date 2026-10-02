"use client";

/**
 * A post's replayer and its thread, sharing one notion of "the spot".
 *
 * #34: a comment can be anchored to a moment in the hand. The replayer reports
 * where the reader has settled (`onPositionChange`, debounced); "Comment on
 * this spot" copies that into the composer; an anchored comment's chip seeks
 * the replayer back to it. The anchor is `PhfAction.index` — never a frame
 * number (see `replayer/position.ts`).
 *
 * Seeking remounts the replayer at the new position rather than reaching into
 * its internals: `initialPosition` is the one public way in, and it already
 * resolves a position lossy-tolerantly.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { PhfHand, Street } from "../../lib/phf/types";
import { anchorLabel } from "../../lib/forum/anchor";
import { useDict } from "../../lib/i18n/client";
import { ReplayViewer } from "../replayer/ReplayViewer";
import type { ReplayPosition } from "../replayer/position";
import styles from "./forum.module.css";

export interface Spot {
  actionIndex: number | null;
  street: Street | null;
  label: string;
}

interface SpotContextValue {
  hand: PhfHand | null;
  /** What the composer will attach, or null. */
  attached: Spot | null;
  clearAttached: () => void;
  seek: (actionIndex: number | null, street: string | null) => void;
}

const SpotContext = createContext<SpotContextValue>({
  hand: null,
  attached: null,
  clearAttached: () => {},
  seek: () => {},
});

export function useSpot(): SpotContextValue {
  return useContext(SpotContext);
}

function spotOf(hand: PhfHand, position: ReplayPosition): Spot | null {
  if (position.kind === "action") {
    const action = hand.actions.find((candidate) => candidate.index >= position.actionIndex);
    if (!action) return null;
    const label = anchorLabel(hand, { actionIndex: action.index, street: action.street });
    return { actionIndex: action.index, street: action.street, label: label ?? action.street };
  }
  if (position.kind === "street") {
    return { actionIndex: null, street: position.street, label: position.street };
  }
  return null;
}

export function PostDiscussion({
  hand,
  site,
  initialPosition,
  children,
}: {
  hand: PhfHand | null;
  site?: string | null;
  initialPosition?: ReplayPosition | null;
  children: ReactNode;
}) {
  const en = useDict();
  const [current, setCurrent] = useState<Spot | null>(null);
  const [attached, setAttached] = useState<Spot | null>(null);
  const [mount, setMount] = useState<{ key: number; position: ReplayPosition | null }>({
    key: 0,
    position: initialPosition ?? null,
  });

  const onPositionChange = useCallback(
    (position: ReplayPosition) => {
      if (hand) setCurrent(spotOf(hand, position));
    },
    [hand],
  );

  const seek = useCallback((actionIndex: number | null, street: string | null) => {
    const position: ReplayPosition | null =
      actionIndex !== null
        ? { kind: "action", actionIndex }
        : street
          ? { kind: "street", street: street as Street }
          : null;
    if (!position) return;
    setMount((previous) => ({ key: previous.key + 1, position }));
    document.getElementById("replay")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const value = useMemo<SpotContextValue>(
    () => ({ hand, attached, clearAttached: () => setAttached(null), seek }),
    [hand, attached, seek],
  );

  return (
    <SpotContext.Provider value={value}>
      {hand ? (
        <section id="replay" className={styles.replay} aria-label={en.forum.post.replayHeading}>
          <ReplayViewer
            key={mount.key}
            hand={hand}
            site={site}
            initialPosition={mount.position}
            onPositionChange={onPositionChange}
          />
          <div className={styles.spotBar}>
            <button
              type="button"
              className="btn btn--sm"
              disabled={!current}
              onClick={() => {
                if (current) {
                  setAttached(current);
                  document.getElementById("composer")?.scrollIntoView({ behavior: "smooth", block: "center" });
                }
              }}
            >
              {en.forum.post.commentOnSpot}
            </button>
            {current ? <small className="muted">{current.label}</small> : null}
          </div>
        </section>
      ) : null}
      {children}
    </SpotContext.Provider>
  );
}

/** The chip on an anchored comment. Seeks the replayer; does not navigate. */
export function AnchorChip({ actionIndex, street, label }: { actionIndex: number | null; street: string | null; label: string }) {
  const en = useDict();
  const { seek, hand } = useSpot();
  if (!hand) {
    return <span className={styles.chip}>{en.forum.comments.anchorChip(label)}</span>;
  }
  return (
    <button type="button" className={styles.chip} onClick={() => seek(actionIndex, street)}>
      {en.forum.comments.anchorChip(label)}
    </button>
  );
}
