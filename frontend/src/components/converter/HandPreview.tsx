/**
 * A converted hand as the text a tracker would import, in an overlay.
 *
 * The point of the preview is trust: before someone downloads 6 000 hands and
 * imports them into Holdem Manager, they want to see that one of them came out
 * right. The text is rendered on demand rather than kept alongside every hand,
 * because 6 000 pre-rendered hands is another 7.5 MB in memory for something
 * the user opens twice.
 */

import { useEffect, useRef, useState } from "react";
import { toStandardText } from "../../lib/phf";
import type { PhfHand } from "../../lib/phf/types";
import { copyToClipboard, downloadText } from "./handoff";
import { toHandRow } from "./handSummary";

interface HandPreviewProps {
  hand: PhfHand;
  onClose(): void;
  onOpenInReplayer(hand: PhfHand, standardText: string): void;
}

export function HandPreview({ hand, onClose, onOpenInReplayer }: HandPreviewProps) {
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const text = toStandardText(hand);
  const row = toHandRow(hand);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    // Stop the page behind the overlay from scrolling under it on touch.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="conv-modal" role="presentation" onClick={onClose}>
      <div
        className="conv-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Hand ${row.handId}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="conv-modal__head">
          <div>
            <h3>Hand #{row.handId}</h3>
            <p className="muted">
              {row.siteName} · {row.stakes}
              {row.table ? ` · ${row.table}` : ""}
            </p>
          </div>
          <button ref={closeRef} type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </header>

        <pre className="conv-pre conv-modal__text">{text}</pre>

        <footer className="conv-modal__actions">
          <button type="button" className="btn btn--primary" onClick={() => onOpenInReplayer(hand, text)}>
            Open in replayer
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              setCopied(await copyToClipboard(text));
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied" : "Copy text"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => downloadText(`hand-${row.handId}.txt`, text)}
          >
            Download
          </button>
        </footer>
      </div>
    </div>
  );
}
