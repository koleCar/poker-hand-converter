/**
 * The hand lists' "Mark" submenu (`HandActions`): the markers, each one a
 * check that puts it on every chosen hand or takes it off them all (a dash
 * when only some have it), and a field for a marker of the user's own. The
 * menu stays open, so several markers go on in one go. Each change is told
 * to the windows (`hand-annotated`): the list rows and the replayer show it.
 */
import { useEffect, useState, type KeyboardEvent } from "react";

import { useT } from "../i18n";
import { emitHandAnnotated, errorText, ipc } from "../lib/ipc";
import styles from "./MarkPanel.module.css";
import { offeredMarkers, REVIEW, sameMarker, typedMarker } from "./markers";

/** The most markers listed at once (the field narrows them). */
const LISTED = 30;

export function MarkPanel({ handKeys }: { handKeys: readonly string[] }) {
  const t = useT().hands.actions.markers;
  const [known, setKnown] = useState<string[] | null>(null);
  const [tags, setTags] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    ipc
      .handsMarks([...handKeys])
      .then((marks) => {
        if (!current) return;
        setKnown(marks.known);
        setTags(new Map(marks.hands.map((hand) => [hand.handKey, hand.tags])));
      })
      .catch((reason: unknown) => {
        if (current) setError(errorText(reason));
      });
    return () => {
      current = false;
    };
  }, [handKeys]);

  /** The spelling of `marker` a hand has (its tags may say "review" for "Review"), if any. */
  const onHand = (key: string, marker: string) => tags.get(key)?.find((tag) => sameMarker(tag, marker));

  const apply = async (marker: string, on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      // Off: each spelling the hands have goes; on: the marker as listed.
      const jobs = new Map<string, string[]>();
      for (const key of handKeys) {
        const tag = on ? marker : onHand(key, marker);
        if (tag === undefined) continue;
        jobs.set(tag, [...(jobs.get(tag) ?? []), key]);
      }
      const next = new Map(tags);
      for (const [tag, keys] of jobs) {
        for (const hand of await ipc.handsMark(keys, tag, on)) {
          next.set(hand.handKey, hand.annotations.tags);
          emitHandAnnotated(hand);
        }
      }
      setTags(next);
      if (on && known !== null && !known.some((tag) => sameMarker(tag, marker))) setKnown([...known, marker]);
    } catch (reason) {
      setError(t.failed(errorText(reason)));
    } finally {
      setBusy(false);
    }
  };

  const typed = typedMarker(draft);
  const offered = known === null ? [] : offeredMarkers(known, typed).slice(0, LISTED);
  const exact = known === null ? undefined : offeredMarkers(known, "").find((tag) => sameMarker(tag, typed));

  const onField = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || typed === "" || busy || known === null) return;
    event.preventDefault();
    const marker = exact ?? typed;
    setDraft("");
    void apply(marker, true);
  };

  return (
    <div className={styles.panel} aria-busy={busy || known === null}>
      {known === null && error === null ? <p className={styles.quiet}>{t.loading}</p> : null}
      {offered.map((marker) => {
        const count = handKeys.filter((key) => onHand(key, marker) !== undefined).length;
        const all = count > 0 && count === handKeys.length;
        const some = count > 0 && !all;
        const label = t.presets[marker] ?? marker;
        return (
          <button
            key={marker}
            type="button"
            role="menuitemcheckbox"
            aria-checked={all ? true : some ? "mixed" : false}
            className={styles.item}
            disabled={busy}
            tabIndex={-1}
            title={marker === REVIEW ? t.reviewTitle : undefined}
            onClick={() => void apply(marker, !all)}
          >
            <span className={styles.check} aria-hidden="true">
              {all ? "✓" : some ? "–" : ""}
            </span>
            <span className={styles.name}>{label}</span>
          </button>
        );
      })}
      <div className={styles.field}>
        <input
          data-autofocus
          className={styles.input}
          value={draft}
          placeholder={t.placeholder}
          aria-label={t.placeholder}
          maxLength={40}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onField}
        />
        {typed !== "" && exact === undefined ? <p className={styles.quiet}>{t.add(typed)} ↵</p> : null}
      </div>
      {error !== null ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
