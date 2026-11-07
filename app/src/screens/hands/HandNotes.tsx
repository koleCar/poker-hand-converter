/**
 * The hand's tags and note, behind one button in the replayer's header (top
 * right) instead of a block under the table. The button shows how many tags
 * the hand has (a dot for a note alone); it opens a small panel where a tag
 * is picked from the ones already in use (what the Hands filter offers) or
 * typed as a new one, and the note is free text, saved as it is typed.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@rail/ui/icon/Icon";
import { Popover } from "@rail/ui/hands/Popover";

import { useT } from "../../i18n";
import { errorText, ipc, onHandAnnotated, type HandAnnotations } from "../../lib/ipc";
import styles from "./HandNotes.module.css";

/** How long typing pauses before the note is saved. */
const NOTE_DEBOUNCE_MS = 700;

/** How many of the tags in use are offered at once (the input narrows them). */
const OFFERED = 24;

interface HandNotesProps {
  handKey: string;
  /** Every tag in use, offered to pick from. */
  knownTags: string[];
  /** The note or tags changed: the list row shows it. */
  onAnnotated: (handKey: string, annotations: HandAnnotations) => void;
}

export function HandNotes({ handKey, knownTags, onAnnotated }: HandNotesProps) {
  const t = useT().hands.panel;
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState("");
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const savedNote = useRef("");
  const timer = useRef<number | undefined>(undefined);
  // The note as last typed, saved on the way out if it has not been yet.
  const pending = useRef<string | null>(null);

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

  // Marked from a hand list's menu while open here: the tags follow.
  useEffect(
    () =>
      onHandAnnotated((change) => {
        if (change.handKey === handKey) setTags(change.annotations.tags);
      }),
    [handKey],
  );

  // A note being typed when the hand changes or the window closes is saved,
  // not lost.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending.current !== null && pending.current !== savedNote.current) {
        ipc.handSetNote(handKey, pending.current).catch(() => undefined);
      }
    },
    [handKey],
  );

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

  const addTag = (name: string) => {
    const value = name.trim();
    if (!value || tags.includes(value)) {
      setDraft("");
      return;
    }
    ipc
      .handAddTag(handKey, value)
      .then((result) => {
        setDraft("");
        applied(result);
      })
      .catch((reason: unknown) => setError(t.tagFailed(errorText(reason))));
  };

  const removeTag = (name: string) => {
    ipc
      .handRemoveTag(handKey, name)
      .then(applied)
      .catch((reason: unknown) => setError(t.tagFailed(errorText(reason))));
  };

  const typed = draft.trim();
  const needle = typed.toLowerCase();
  const offered = knownTags
    .filter((known) => !tags.includes(known) && known.toLowerCase().includes(needle))
    .slice(0, OFFERED);
  // Enter takes the tag in use that matches what was typed, ignoring case,
  // so "River" does not become a second "river".
  const exact = knownTags.find((known) => known.toLowerCase() === needle);
  const isNew = typed !== "" && exact === undefined;

  const onTagKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addTag(exact ?? typed);
    }
  };

  const hasNote = note.trim() !== "";
  const summary = t.notesSummary(tags.length, hasNote);

  return (
    <span ref={anchor} className={styles.anchor}>
      <button
        type="button"
        className={`btn btn--icon ${open ? "is-active" : ""}`.trim()}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t.notes}: ${summary}`}
        title={`${t.notes} · ${summary}`}
      >
        <Icon name="tag" />
        {tags.length > 0 ? (
          <span className={styles.count} aria-hidden="true">
            {tags.length}
          </span>
        ) : hasNote ? (
          <span className={styles.dot} aria-hidden="true" />
        ) : null}
      </button>
      {open ? (
        <Popover anchor={anchor} label={t.notes} onClose={() => setOpen(false)}>
          {/* The replayer's keys (space, arrows, letters) are not for this
              panel; Escape is the panel's own and goes on to close it. */}
          <div
            className={styles.body}
            onKeyDown={(event) => {
              if (event.key !== "Escape") event.stopPropagation();
            }}
          >
            <div className={styles.section}>
              <span className={styles.label} id={`${handKey}-tags`}>
                {t.tags}
              </span>
              <input
                className={styles.input}
                value={draft}
                maxLength={40}
                placeholder={t.tagPlaceholder}
                aria-label={t.addTag}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onTagKey}
              />
              {tags.length > 0 ? (
                <ul className={styles.tags} aria-labelledby={`${handKey}-tags`}>
                  {tags.map((name) => (
                    <li key={name} className={styles.tag}>
                      {name}
                      <button
                        type="button"
                        aria-label={t.removeTag(name)}
                        title={t.removeTag(name)}
                        onClick={() => removeTag(name)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {offered.length > 0 || isNew ? (
                <div className={styles.offered} role="group" aria-label={t.knownTags}>
                  {isNew ? (
                    <button type="button" className={`${styles.pick} ${styles.pickNew}`} onClick={() => addTag(typed)}>
                      {t.newTag(typed)}
                    </button>
                  ) : null}
                  {offered.map((known) => (
                    <button key={known} type="button" className={styles.pick} onClick={() => addTag(known)}>
                      {known}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <label className={styles.section}>
              <span className={styles.label}>
                {t.note}
                <span className={styles.noteState} aria-live="polite">
                  {noteState === "saving" ? t.noteSaving : noteState === "saved" ? t.noteSaved : null}
                </span>
              </span>
              <textarea
                className={styles.note}
                value={note}
                rows={4}
                maxLength={10000}
                placeholder={t.notePlaceholder}
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
        </Popover>
      ) : null}
    </span>
  );
}
