import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Dialog } from "../dialog/Dialog";
import { Icon } from "../icon/Icon";
import { useUiStrings } from "../i18n";
import { prepareImage } from "./image";
import styles from "./Feedback.module.css";
import { Dismissible } from "../notice/Dismissible";

export type FeedbackKind = "bug" | "feature" | "question";
const KINDS: readonly FeedbackKind[] = ["bug", "feature", "question"];
export const MAX_FEEDBACK_IMAGES = 3;
const MAX_MESSAGE = 4000;

/** What the dialog hands its surface to send; the surface adds where it came from. */
export interface FeedbackDraft {
  kind: FeedbackKind;
  message: string;
  /** A visitor's reply address; null when signed in or left empty. */
  email: string | null;
  /** The honeypot: empty unless a bot filled it in. */
  website: string;
  /** Data URLs (`data:image/…;base64,…`), at most three. */
  images: string[];
}

/** The `feedback` function's refusals, and the surface's own "no connection". */
export type FeedbackError = "invalid_request" | "too_large" | "rate_limited" | "unavailable" | "offline";

/**
 * Report a bug, request a feature or ask a question, with up to three
 * screenshots (dropped, pasted or picked). Shared by the web's floating
 * button and the app's sidebar item; each surface sends the draft its own
 * way (`send`) and resolves with null when it was stored.
 */
export function FeedbackDialog({
  onClose,
  send,
  signedInEmail,
}: {
  onClose: () => void;
  send: (draft: FeedbackDraft) => Promise<FeedbackError | null>;
  /** The account's email when signed in: no email field then. */
  signedInEmail: string | null;
}) {
  const t = useUiStrings().feedback;
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"editing" | "sending" | "sent">("editing");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);

  const addFiles = async (files: Iterable<File>) => {
    const list = Array.from(files).filter((file) => file.size > 0);
    if (list.length === 0) return;
    setError(null);
    let room = MAX_FEEDBACK_IMAGES - images.length;
    if (room <= 0) {
      setError(t.errors.tooMany);
      return;
    }
    const added: string[] = [];
    for (const file of list) {
      if (room <= 0) {
        setError(t.errors.tooMany);
        break;
      }
      const prepared = await prepareImage(file);
      if (prepared === "imageType" || prepared === "imageRead") {
        setError(t.errors[prepared]);
        continue;
      }
      added.push(prepared);
      room -= 1;
    }
    if (added.length > 0) {
      setImages((was) => [...was, ...added].slice(0, MAX_FEEDBACK_IMAGES));
    }
  };

  const submit = async () => {
    if (state === "sending") return;
    if (message.trim().length === 0) {
      setError(t.errors.empty);
      messageInput.current?.focus();
      return;
    }
    setError(null);
    setState("sending");
    const failed = await send({
      kind,
      message: message.trim(),
      email: signedInEmail ? null : email.trim() || null,
      website,
      images,
    }).catch((): FeedbackError => "unavailable");
    if (failed) {
      setError(t.errors[failed]);
      setState("editing");
      return;
    }
    setState("sent");
  };

  const reset = () => {
    setMessage("");
    setImages([]);
    setError(null);
    setState("editing");
  };

  // `showModal` focuses the first control (the kind); the description is where typing starts.
  useEffect(() => {
    messageInput.current?.focus();
  }, []);

  // While the dialog is open it owns every file drag, drop and image paste
  // on the page: caught on the window before anything else sees it (the
  // converter's page-wide drop and paste would otherwise take a screenshot
  // as a hand file), and dropped anywhere, it is added here.
  const latest = useRef({ addFiles, editing: state === "editing" });
  useEffect(() => {
    latest.current = { addFiles, editing: state === "editing" };
  });
  useEffect(() => {
    const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    let depth = 0;
    const onDrag = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "dragenter") depth += 1;
      if (event.type === "dragleave") depth = Math.max(0, depth - 1);
      if (event.type === "dragover" && event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragging(event.type !== "drop" && depth > 0);
      if (event.type === "drop") {
        depth = 0;
        if (latest.current.editing && event.dataTransfer) void latest.current.addFiles(event.dataTransfer.files);
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      // Text pastes go where the caret is; nothing behind the dialog gets them.
      event.stopPropagation();
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (files.length > 0 && latest.current.editing) {
        event.preventDefault();
        void latest.current.addFiles(files);
      }
    };
    const kinds = ["dragenter", "dragover", "dragleave", "drop"] as const;
    for (const kind of kinds) window.addEventListener(kind, onDrag, true);
    window.addEventListener("paste", onPaste, true);
    return () => {
      for (const kind of kinds) window.removeEventListener(kind, onDrag, true);
      window.removeEventListener("paste", onPaste, true);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  if (state === "sent") {
    return (
      <Dialog title={t.title} onClose={onClose}>
        <div className={styles.sent} role="status">
          <span className={styles.sentMark} aria-hidden="true">
            <Icon name="check" />
          </span>
          <p>{t.sent}</p>
        </div>
        <div className={styles.actions}>
          <button type="button" className="btn btn--ghost" onClick={reset}>
            {t.sendAnother}
          </button>
          <button type="button" className="btn btn--primary" onClick={onClose} autoFocus>
            {t.close}
          </button>
        </div>
      </Dialog>
    );
  }

  const sending = state === "sending";
  return (
    <Dialog title={t.title} onClose={onClose}>
      <form
        className={dragging ? `${styles.form} ${styles.dragging}` : styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={onKeyDown}
        aria-busy={sending}
      >
        <div className={styles.kinds} role="radiogroup" aria-label={t.kindLabel}>
          {KINDS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={kind === option}
              className={kind === option ? `${styles.kind} ${styles.kindOn}` : styles.kind}
              onClick={() => setKind(option)}
              disabled={sending}
            >
              {t.kinds[option]}
            </button>
          ))}
        </div>

        <textarea
          ref={messageInput}
          className={styles.message}
          aria-label={t.messageLabel}
          placeholder={t.placeholder[kind]}
          value={message}
          maxLength={MAX_MESSAGE}
          rows={5}
          disabled={sending}
          onChange={(event) => setMessage(event.target.value)}
        />

        <div className={styles.images} aria-label={t.images} role="group">
          {images.map((src, index) => (
            <figure key={src.slice(-40) + index} className={styles.thumb}>
              <img src={src} alt={t.imageAlt(index + 1)} />
              <button
                type="button"
                className={styles.remove}
                aria-label={t.removeImage(index + 1)}
                title={t.removeImage(index + 1)}
                onClick={() => setImages((was) => was.filter((_, at) => at !== index))}
                disabled={sending}
              >
                <Icon name="close" />
              </button>
            </figure>
          ))}
          {images.length < MAX_FEEDBACK_IMAGES ? (
            <button
              type="button"
              className={styles.add}
              onClick={() => fileInput.current?.click()}
              disabled={sending}
              title={t.dropHint}
            >
              <Icon name="upload" />
              <span>{images.length === 0 ? t.dropHint : t.addImage}</span>
            </button>
          ) : null}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              const files = event.target.files;
              if (files) void addFiles(files);
              event.target.value = "";
            }}
          />
        </div>

        {signedInEmail ? (
          <p className={styles.note}>{t.signedInAs(signedInEmail)}</p>
        ) : (
          <label className={styles.field}>
            <span className={styles.label}>{t.emailLabel}</span>
            <input
              type="email"
              className={styles.input}
              placeholder={t.emailPlaceholder}
              autoComplete="email"
              maxLength={320}
              value={email}
              disabled={sending}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        )}

        {/* The honeypot: hidden from people and assistive tech, filled in by bots. */}
        <input
          className={styles.trap}
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />

        {error ? (
          <Dismissible className={styles.error} role="alert">
            {error}
          </Dismissible>
        ) : null}

        <div className={styles.actions}>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t.cancel}
          </button>
          <button type="submit" className="btn btn--primary" disabled={sending}>
            {sending ? t.sending : t.send}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
