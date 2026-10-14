/**
 * The open hand: the shared replayer (`ReplayViewer`, the web's) fed by
 * `useHand` over the app's `DataSource`, and under it the hand's tags and
 * note. "Open on the web" is a placeholder until tags and notes sync.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useHand } from "@rail/ui/data";
import { Icon } from "@rail/ui/icon/Icon";
import { ReplayViewer } from "@rail/ui/replayer/ReplayViewer";

import { useT } from "../../i18n";
import { errorText, ipc, type HandAnnotations, type HandRow } from "../../lib/ipc";
import styles from "./HandPanel.module.css";

/** How long typing pauses before the note is saved. */
const NOTE_DEBOUNCE_MS = 700;

interface HandPanelProps {
  handKey: string;
  /** The hand's list row, when it is loaded (for the room's name). */
  row: HandRow | null;
  /** Every tag in use, offered as the reader types one. */
  knownTags: string[];
  onClose: () => void;
  /** The note or tags changed: the list row shows it. */
  onAnnotated: (handKey: string, annotations: HandAnnotations) => void;
}

export function HandPanel({ handKey, row, knownTags, onClose, onAnnotated }: HandPanelProps) {
  const t = useT().hands.panel;
  const state = useHand(handKey);

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
            headerExtra={
              <button
                type="button"
                className="btn btn--icon"
                disabled
                aria-label={t.openInWeb}
                title={t.openInWebSoon}
              >
                <Icon name="globe" />
              </button>
            }
          />
        ) : (
          <p className={styles.status} role="status">
            {state.status === "loading"
              ? t.loading
              : state.status === "missing"
                ? t.missing
                : t.failed(state.error.message)}
          </p>
        )}
      </div>
      <Annotations key={handKey} handKey={handKey} knownTags={knownTags} onAnnotated={onAnnotated} />
    </section>
  );
}

function Annotations({
  handKey,
  knownTags,
  onAnnotated,
}: {
  handKey: string;
  knownTags: string[];
  onAnnotated: (handKey: string, annotations: HandAnnotations) => void;
}) {
  const t = useT().hands.panel;
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [tag, setTag] = useState("");
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const savedNote = useRef("");
  const timer = useRef<number | undefined>(undefined);
  const listId = `tags-${handKey}`;

  useEffect(() => {
    let current = true;
    ipc
      .handAnnotations(handKey)
      .then((value) => {
        if (!current) return;
        setTags(value.tags);
        setNote(value.note ?? "");
        savedNote.current = value.note ?? "";
      })
      .catch((reason: unknown) => {
        if (current) setError(errorText(reason));
      });
    return () => {
      current = false;
    };
  }, [handKey]);

  const applied = (value: HandAnnotations) => {
    setTags(value.tags);
    setError(null);
    onAnnotated(handKey, value);
  };

  const saveNote = (text: string) => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (text === savedNote.current) return;
    setNoteState("saving");
    ipc
      .handSetNote(handKey, text)
      .then((value) => {
        savedNote.current = text;
        setNoteState("saved");
        applied(value);
      })
      .catch((reason: unknown) => {
        setNoteState("idle");
        setError(t.noteFailed(errorText(reason)));
      });
  };

  // A note being typed when the hand changes is saved, not lost.
  const pending = useRef<string | null>(null);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending.current !== null && pending.current !== savedNote.current) {
        ipc.handSetNote(handKey, pending.current).catch(() => undefined);
      }
    },
    [handKey],
  );

  const addTag = () => {
    const value = tag.trim();
    if (!value) return;
    ipc
      .handAddTag(handKey, value)
      .then((result) => {
        setTag("");
        applied(result);
      })
      .catch((reason: unknown) => setError(t.tagFailed(errorText(reason))));
  };

  const onTagKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addTag();
    }
  };

  return (
    <div className={styles.annotations}>
      <div className={styles.field}>
        <span className={styles.label} id={`${listId}-label`}>
          {t.tags}
        </span>
        <ul className={styles.tags} aria-labelledby={`${listId}-label`}>
          {tags.map((name) => (
            <li key={name} className={styles.tag}>
              {name}
              <button
                type="button"
                aria-label={t.removeTag(name)}
                title={t.removeTag(name)}
                onClick={() => {
                  ipc
                    .handRemoveTag(handKey, name)
                    .then(applied)
                    .catch((reason: unknown) => setError(t.tagFailed(errorText(reason))));
                }}
              >
                ×
              </button>
            </li>
          ))}
          <li>
            <input
              className={styles.tagInput}
              value={tag}
              list={listId}
              maxLength={40}
              placeholder={t.tagPlaceholder}
              aria-label={t.addTag}
              onChange={(event) => setTag(event.target.value)}
              onKeyDown={onTagKey}
            />
            <datalist id={listId}>
              {knownTags
                .filter((known) => !tags.includes(known))
                .map((known) => (
                  <option key={known} value={known} />
                ))}
            </datalist>
          </li>
        </ul>
      </div>
      <label className={styles.field}>
        <span className={styles.label}>
          {t.note}
          <span className={styles.noteState} aria-live="polite">
            {noteState === "saving" ? t.noteSaving : noteState === "saved" ? t.noteSaved : null}
          </span>
        </span>
        <textarea
          className={styles.note}
          value={note}
          rows={2}
          maxLength={10000}
          placeholder={t.notePlaceholder}
          aria-label={t.note}
          onChange={(event) => {
            const text = event.target.value;
            setNote(text);
            setNoteState("idle");
            pending.current = text;
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => saveNote(text), NOTE_DEBOUNCE_MS);
          }}
          onBlur={() => saveNote(note)}
        />
      </label>
      <p className={styles.footnote}>{t.localOnly}</p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
