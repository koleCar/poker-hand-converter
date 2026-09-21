/**
 * The input surface: drop target, file picker, and paste box.
 *
 * Three ways in, because there are three kinds of user. Someone exporting from
 * their tracker drags a folder. Someone on a laptop picks files. Someone who
 * just copied a hand out of a forum thread pastes it — that last one is the
 * majority on a phone, where drag and drop does not exist at all, which is why
 * the buttons are real buttons rather than hints inside a drop box.
 */

import { useEffect, useId, useRef, useState } from "react";
import { FILE_ACCEPT, filesFromDrop } from "./inputs";

interface DropZoneProps {
  /** Files picked, dropped, or found inside a dropped folder. */
  onFiles(files: File[]): void;
  /** Text from the paste box or from a page-level paste. */
  onText(text: string): void;
  /** Disables the inputs while a conversion is running. */
  busy: boolean;
  /** Registered parser names, e.g. ["WePlay", "PokerConverter standard"]. */
  siteNames: string[];
}

/** Below this, a paste is a stray copy rather than a hand history. */
const MIN_PASTE_LENGTH = 40;

/**
 * Names to print before the list turns into noise.
 *
 * The list comes from the parser registry and grows every time someone adds a
 * site, so the copy has to degrade on its own rather than be rewritten.
 */
const MAX_LISTED_SITES = 5;

function listSites(names: string[]): string {
  if (names.length <= MAX_LISTED_SITES) {
    return names.join(", ");
  }
  return `${names.slice(0, MAX_LISTED_SITES).join(", ")} and ${names.length - MAX_LISTED_SITES} more`;
}

export function DropZone({ onFiles, onText, busy, siteNames }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const dragDepth = useRef(0);
  const pasteId = useId();

  // `webkitdirectory` is set imperatively: it is a non-standard attribute that
  // React's DOM typings do not carry, and the feature test is "did the browser
  // keep it?" rather than a user-agent guess.
  const [canPickFolder, setCanPickFolder] = useState(false);
  useEffect(() => {
    const input = folderRef.current;
    if (!input) {
      return;
    }
    input.setAttribute("webkitdirectory", "");
    setCanPickFolder(input.hasAttribute("webkitdirectory") && "webkitdirectory" in input);
  }, []);

  // Ctrl/Cmd+V anywhere on the page opens the paste box with the text already
  // in it. A user who has a hand on the clipboard should not have to find a
  // button first.
  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (busy) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) {
        return;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text.trim().length < MIN_PASTE_LENGTH) {
        return;
      }
      event.preventDefault();
      setPasteOpen(true);
      setPasteText(text);
      requestAnimationFrame(() => pasteRef.current?.focus());
    }
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [busy]);

  /**
   * The whole page accepts a dropped file, not just the box.
   *
   * Without this the default browser behaviour applies outside the box:
   * Chrome *navigates to the dropped file*, which throws away the page, the
   * results and anything still converting. Since a near-miss on the drop
   * target is the single easiest mistake to make here, the page catches it
   * instead of punishing it — and the overlay says so while the file is in
   * flight, so the box never looks like the only landing spot.
   *
   * `types.includes("Files")` keeps dragged text and links on their normal
   * behaviour; only a real file drag is intercepted.
   */
  const [pageDragging, setPageDragging] = useState(false);
  useEffect(() => {
    const isFileDrag = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    let depth = 0;

    function onEnter(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      depth += 1;
      setPageDragging(true);
    }
    function onOver(event: DragEvent) {
      if (!isFileDrag(event)) return;
      // Required every frame: without it the drop event never fires and the
      // browser falls back to navigating.
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

  // Dragging over a child element fires dragleave on the parent, so the
  // highlight has to be reference-counted or it flickers on every nested node.
  function handleDragEnter(event: React.DragEvent) {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function handleDragLeave(event: React.DragEvent) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setDragging(false);
    }
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    // Stops the window-level handler above from taking the same drop a second
    // time and queueing every file twice.
    event.stopPropagation();
    dragDepth.current = 0;
    setPageDragging(false);
    setDragging(false);
    if (busy) {
      return;
    }
    const text = event.dataTransfer.getData("text/plain");
    const files = await filesFromDrop(event.dataTransfer);
    if (files.length > 0) {
      onFiles(files);
    } else if (text.trim().length >= MIN_PASTE_LENGTH) {
      // Some clients drag a selection rather than a file.
      onText(text);
    }
  }

  function submitPaste() {
    if (!pasteText.trim()) {
      return;
    }
    onText(pasteText);
    setPasteText("");
    setPasteOpen(false);
  }

  return (
    <div className="conv-input">
      {/* Only when the file is not already over the box, so the page and the
          box never light up at the same time. */}
      {pageDragging && !dragging ? (
        <div className="conv-dropveil" aria-hidden="true">
          <span>Drop anywhere to convert</span>
        </div>
      ) : null}
      <div
        className={`conv-drop ${dragging ? "is-dragging" : ""} ${busy ? "is-busy" : ""}`}
        onDragEnter={handleDragEnter}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={(event) => {
          // Mouse affordance only; the buttons below carry the keyboard path.
          if (busy || (event.target as HTMLElement).closest("button, label, a")) {
            return;
          }
          inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={FILE_ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []);
            if (picked.length) {
              onFiles(picked);
            }
            // Reset so picking the same file twice in a row still fires.
            event.target.value = "";
          }}
        />

        {/* Second input rather than a toggled attribute: switching
            `webkitdirectory` on a live input leaves Chrome showing the previous
            picker mode until the next paint. */}
        <input
          ref={folderRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []);
            if (picked.length) {
              onFiles(picked);
            }
            event.target.value = "";
          }}
        />

        <div className="conv-drop__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M12 16V4" strokeLinecap="round" />
            <path d="m7.5 8.5 4.5-4.5 4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" />
          </svg>
        </div>

        <p className="conv-drop__title">Add your hand histories</p>
        <p className="conv-drop__drag-hint">
          Drag files or a whole export folder anywhere on this page
        </p>

        <div className="conv-drop__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            Choose files
          </button>
          {/* A whole HandHistory folder is how trackers export, and dragging
              one only works with a mouse. On desktop the picker can do it too. */}
          {canPickFolder ? (
            <button
              type="button"
              className="btn conv-drop__folder"
              disabled={busy}
              onClick={() => folderRef.current?.click()}
            >
              Choose a folder
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            aria-expanded={pasteOpen}
            aria-controls={pasteId}
            onClick={() => {
              setPasteOpen((open) => !open);
              if (!pasteOpen) {
                requestAnimationFrame(() => pasteRef.current?.focus());
              }
            }}
          >
            {pasteOpen ? "Hide paste box" : "Paste a hand"}
          </button>
        </div>

        <p className="conv-drop__hint">
          Any poker room. We work out the site for you — {listSites(siteNames)} convert today, and
          anything we cannot convert yet is kept so we can add it.
        </p>
      </div>

      {pasteOpen ? (
        <div className="conv-paste" id={pasteId}>
          <label className="conv-paste__label" htmlFor={`${pasteId}-area`}>
            Paste hand history text
          </label>
          <textarea
            id={`${pasteId}-area`}
            ref={pasteRef}
            className="conv-paste__area"
            value={pasteText}
            spellCheck={false}
            placeholder={"Paste one hand or a whole session here…"}
            onChange={(event) => setPasteText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                submitPaste();
              }
            }}
          />
          <div className="conv-paste__actions">
            <button type="button" className="btn btn--primary" disabled={busy || !pasteText.trim()} onClick={submitPaste}>
              Add pasted text
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => { setPasteText(""); setPasteOpen(false); }}>
              Cancel
            </button>
            <span className="conv-paste__hint">⌘/Ctrl + Enter</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
