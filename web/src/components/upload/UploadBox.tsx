/**
 * The upload page's one box: paste a hand into it, or drop files on it.
 *
 * There used to be two segments - a paste box, "or", and a drop zone below.
 * They are one gesture with two kinds of payload, so the page now has one
 * target that tells which arrived:
 *
 *  * **Text** stays in the box and is read as it is typed or pasted: the
 *    footer names the room, the number of hands and the stakes, and offers
 *    Replay (the first hand) or, for several, Convert all (the batch path).
 *  * **Files**, a zip or a folder - dropped on the box, anywhere on the page,
 *    or picked - go straight to the batch conversion; while it runs the box
 *    shows its progress (`status`).
 *
 * A paste anywhere on the page that is not into another field lands here too,
 * and a dropped file anywhere is caught rather than letting the browser
 * navigate to it and throw the page away.
 */

"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useDict } from "../../lib/i18n/client";
import { getParser } from "../../lib/phf";
import { conversionEngine } from "../../lib/wasm/engine";
import { stakesLabelOf } from "../../lib/db/mapping";
import { FILE_ACCEPT, filesFromDrop, pickedFile, skipReason, type PickedFile } from "../converter/inputs";
import "../../styles/upload.css";

interface UploadBoxProps {
  /** Files picked, dropped, or found inside a dropped folder. */
  onFiles(files: PickedFile[]): void;
  /** Pasted text with several hands, sent to the batch conversion. */
  onConvertText(text: string): void;
  /** Pasted text: replay its first hand. */
  onReplay(text: string): void;
  /** A batch is converting or saving: the inputs wait. */
  busy: boolean;
  /** The batch's progress, shown inside the box instead of the text area. */
  status?: ReactNode;
  /** Left of the line under the box (the save switch). */
  controls?: ReactNode;
  /** Right of the line under the box (manual entry, start over). */
  links?: ReactNode;
  /** Registered parser names, for the rooms hint. */
  siteNames: string[];
}

interface Detection {
  /** The text it describes; a newer text makes it stale. */
  text: string;
  hands: number;
  site: string | null;
  stakes: string | null;
  /** Set when nothing in the text is a hand. */
  problem: string | null;
}

/** Below this a dragged selection is a stray copy rather than a hand history. */
const MIN_DRAGGED_TEXT = 40;
/** Wait after the last keystroke before reading the box. */
const DETECT_DELAY_MS = 220;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

export function UploadBox({ onFiles, onConvertText, onReplay, busy, status, controls, links, siteNames }: UploadBoxProps) {
  const t = useDict().converter.upload;
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [boxDragging, setBoxDragging] = useState(false);
  const [pageDragging, setPageDragging] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const boxDepth = useRef(0);

  // `webkitdirectory` is non-standard (React's typings do not carry it), so
  // it is set on the element itself. Every desktop browser supports it; on a
  // phone the folder button is hidden (upload.css).
  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  // Read the box shortly after it changes: which room, how many hands.
  useEffect(() => {
    const raw = text;
    if (!raw.trim()) {
      return;
    }
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const engine = await conversionEngine();
        const result = await engine.convert(raw, { validate: true });
        if (stale) {
          return;
        }
        const [first] = result.hands;
        const siteId = first?.meta.siteId ?? null;
        setDetection({
          text: raw,
          hands: result.hands.length,
          site: siteId && siteId !== "standard" ? (getParser(siteId)?.name ?? siteId) : null,
          stakes: first ? stakesLabelOf(first) : null,
          problem: first ? null : t.notRecognised,
        });
      } catch {
        if (!stale) {
          setDetection({ text: raw, hands: 0, site: null, stakes: null, problem: t.couldNotRead });
        }
      }
    }, DETECT_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [text, t]);

  const clear = useCallback(() => {
    setText("");
    setDetection(null);
  }, []);

  const replay = useCallback(() => {
    if (!text.trim() || busy) {
      return;
    }
    onReplay(text);
    // The box has done its job; raw text above the table pushes the replayer
    // off a phone screen.
    setText("");
    setDetection(null);
  }, [busy, onReplay, text]);

  // A paste anywhere on the page that is not meant for another field.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (busy || isEditable(event.target)) {
        return;
      }
      const pasted = event.clipboardData?.getData("text/plain") ?? "";
      if (!pasted.trim()) {
        return;
      }
      event.preventDefault();
      setText(pasted);
      areaRef.current?.focus();
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [busy]);

  // Files dropped anywhere on the page: caught, never navigated to. Only real
  // file drags; dragged text and links keep their usual behaviour.
  useEffect(() => {
    const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    let depth = 0;
    function onEnter(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      depth += 1;
      setPageDragging(true);
    }
    function onOver(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function onLeave(event: DragEvent) {
      if (!isFileDrag(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setPageDragging(false);
    }
    async function onDrop(event: DragEvent) {
      if (!isFileDrag(event) || !event.dataTransfer) return;
      event.preventDefault();
      depth = 0;
      setPageDragging(false);
      if (busy) return;
      const files = await filesFromDrop(event.dataTransfer);
      if (files.length > 0) {
        onFiles(files);
      }
    }
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [busy, onFiles]);

  // Nested elements fire dragleave on the box: count, or it flickers.
  function handleDragEnter(event: React.DragEvent) {
    event.preventDefault();
    boxDepth.current += 1;
    setBoxDragging(true);
  }
  function handleDragLeave(event: React.DragEvent) {
    event.preventDefault();
    boxDepth.current = Math.max(0, boxDepth.current - 1);
    if (boxDepth.current === 0) {
      setBoxDragging(false);
    }
  }
  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    // The window handler would take the same drop a second time.
    event.stopPropagation();
    boxDepth.current = 0;
    setBoxDragging(false);
    setPageDragging(false);
    if (busy) {
      return;
    }
    const dragged = event.dataTransfer.getData("text/plain");
    const files = await filesFromDrop(event.dataTransfer);
    if (files.length > 0) {
      onFiles(files);
    } else if (dragged.trim().length >= MIN_DRAGGED_TEXT) {
      setText(dragged);
    }
  }

  const hasText = text.trim().length > 0;
  const current = detection && detection.text === text ? detection : null;
  const dragging = boxDragging || pageDragging;
  const showStatus = Boolean(status) && !dragging;
  const boxClass = [
    "upbox",
    dragging ? "is-dragging" : focused && !showStatus ? "is-focused" : hasText || showStatus ? "is-filled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="upload">
      {pageDragging && !boxDragging ? (
        <div className="conv-dropveil" aria-hidden="true">
          <span>{t.veil}</span>
        </div>
      ) : null}

      <div
        className={boxClass}
        onDragEnter={handleDragEnter}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={fileRef}
          type="file"
          accept={FILE_ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []).map(pickedFile);
            if (picked.length) {
              onFiles(picked);
            }
            event.target.value = "";
          }}
        />
        {/* A second input rather than a toggled attribute: Chrome keeps the
            previous picker mode until the next paint. */}
        <input
          ref={folderRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []).map(pickedFile).filter((f) => !skipReason(f.path));
            if (picked.length) {
              onFiles(picked);
            }
            event.target.value = "";
          }}
        />

        {dragging ? (
          <div className="upbox__hint">
            <span className="upbox__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3v12" strokeLinecap="round" />
                <path d="m7 10 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" strokeLinecap="round" />
              </svg>
            </span>
            <span className="upbox__title">{t.dropToConvert}</span>
            <span className="upbox__sub">{t.dropHint}</span>
          </div>
        ) : showStatus ? (
          <div className="upbox__status">{status}</div>
        ) : (
          <div className="upbox__field">
            <textarea
              ref={areaRef}
              className="upbox__area"
              aria-label={t.areaLabel}
              value={text}
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  replay();
                }
              }}
            />
            {!hasText && !focused ? (
              <div className="upbox__hint">
                <span className="upbox__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 15V3" strokeLinecap="round" />
                    <path d="m7 8 5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" strokeLinecap="round" />
                  </svg>
                </span>
                <span className="upbox__title">{t.title}</span>
                <span className="upbox__sub">{t.hint}</span>
                <span className="upbox__actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
                    {t.chooseFiles}
                  </button>
                  <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => folderRef.current?.click()}>
                    {t.chooseFolder}
                  </button>
                </span>
              </div>
            ) : null}
          </div>
        )}

        {hasText && !dragging && !showStatus ? (
          <div className="upbox__foot">
            {current === null ? (
              <span className="upbox__detect">
                <i className="is-wait" aria-hidden="true" />
                {t.reading}
              </span>
            ) : current.problem ? (
              <span className="upbox__detect">
                <i className="is-bad" aria-hidden="true" />
                {current.problem}
              </span>
            ) : (
              <span className="upbox__detect">
                <i aria-hidden="true" />
                {current.site ? <strong>{current.site}</strong> : null}
                <span>{t.handCount(current.hands)}</span>
                {current.stakes ? <span className="upbox__dim">· {current.stakes}</span> : null}
              </span>
            )}
            <span className="upbox__grow" />
            <button type="button" className="btn btn--ghost" onClick={clear}>
              {t.clear}
            </button>
            {current && current.hands > 1 ? (
              <button type="button" className="btn" disabled={busy} onClick={() => {
                onConvertText(text);
                clear();
              }}>
                {t.convertAll(current.hands)}
              </button>
            ) : null}
            {current && current.hands > 0 ? (
              <button type="button" className="btn btn--primary" disabled={busy} onClick={replay}>
                {t.replay}
                <kbd className="upbox__kbd">⌘ ⏎</kbd>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="upload__under">
        {controls}
        <span className="upbox__grow" />
        {links}
        <span className="upload__rooms" title={siteNames.join(", ")}>
          {t.rooms(siteNames.length)}
        </span>
      </div>
    </div>
  );
}
