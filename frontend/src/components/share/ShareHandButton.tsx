import { useEffect, useRef, useState } from "react";
import type { ParsedHand } from "../../lib/handParser";
import { buildSharePreview } from "./preview";
import { SHARE_UNAVAILABLE_MESSAGE, createShare, isShareBackendReady } from "./shareClient";

interface ShareHandButtonProps {
  hand: ParsedHand;
  /** `hands.id` when the hand is already in the database. */
  storedHandId?: string | null;
  /**
   * Skip creating a share and copy this URL instead. Used on the shared-hand
   * page, where the link already exists and is the page you are looking at.
   */
  presetUrl?: string;
  label?: string;
  className?: string;
}

type CopyState = "idle" | "copied" | "failed";

async function copyToClipboard(text: string, input: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied, or a browser that blocks the async API.
  }
  // Legacy path: select the visible fallback input and let the browser copy it.
  try {
    if (input) {
      input.focus();
      input.select();
      input.setSelectionRange(0, text.length);
      if (document.execCommand("copy")) {
        return true;
      }
    }
  } catch {
    // Ignore; the caller shows the manual-copy message.
  }
  return false;
}

/**
 * "Share hand" -> creates a share server-side, then copies the link. The URL is
 * always rendered in a visible, selectable input so a browser that blocks the
 * clipboard API never leaves the user stuck.
 */
export function ShareHandButton({
  hand,
  storedHandId = null,
  presetUrl,
  label = "Share hand",
  className,
}: ShareHandButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(presetUrl ?? null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // A new hand invalidates the previous link.
  useEffect(() => {
    setUrl(presetUrl ?? null);
    setOpen(false);
    setError(null);
    setCopyState("idle");
  }, [hand.handKey, presetUrl]);

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }
    const timer = window.setTimeout(() => setCopyState("idle"), 4000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    function onPointer(event: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  async function handleShare() {
    setOpen(true);
    setError(null);

    if (url) {
      setCopyState((await copyToClipboard(url, inputRef.current)) ? "copied" : "failed");
      return;
    }
    if (!isShareBackendReady) {
      setError(SHARE_UNAVAILABLE_MESSAGE);
      return;
    }

    setBusy(true);
    try {
      const result = await createShare({
        storedHandId,
        handKey: hand.handKey,
        handText: hand.rawText,
        preview: buildSharePreview(hand),
      });
      setUrl(result.url);
      setCopyState((await copyToClipboard(result.url, inputRef.current)) ? "copied" : "failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a share link.");
    } finally {
      setBusy(false);
    }
  }

  const canWebShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className={`share ${className ?? ""}`} ref={panelRef}>
      <button
        type="button"
        className="btn btn--primary btn--sm share__trigger"
        onClick={() => void handleShare()}
        disabled={busy}
        aria-expanded={open}
        title={isShareBackendReady || presetUrl ? undefined : SHARE_UNAVAILABLE_MESSAGE}
      >
        <span aria-hidden="true">🔗</span>
        {busy ? "Creating link…" : label}
      </button>

      {open ? (
        <div className="share__panel" role="dialog" aria-label="Share this hand">
          <div className="share__panel-head">
            <strong>Share this hand</strong>
            <button
              type="button"
              className="share__close"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {error ? <p className="share__msg share__msg--error">{error}</p> : null}

          {url ? (
            <>
              <p className="share__hint">
                Anyone with this link can replay the hand — no account needed.
              </p>
              <div className="share__row">
                <input
                  ref={inputRef}
                  className="share__url"
                  value={url}
                  readOnly
                  spellCheck={false}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="Shareable link"
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={async () =>
                    setCopyState((await copyToClipboard(url, inputRef.current)) ? "copied" : "failed")
                  }
                >
                  Copy
                </button>
              </div>

              <div className="share__actions">
                <a className="btn btn--ghost btn--sm" href={url} target="_blank" rel="noreferrer">
                  Open link
                </a>
                {canWebShare ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      void navigator
                        .share({ title: "Poker hand replay", url })
                        .catch(() => undefined);
                    }}
                  >
                    Share via…
                  </button>
                ) : null}
              </div>

              {copyState === "copied" ? (
                <p className="share__msg share__msg--ok" role="status">
                  Link copied to clipboard.
                </p>
              ) : null}
              {copyState === "failed" ? (
                <p className="share__msg share__msg--warn" role="status">
                  Your browser blocked the clipboard. Select the link above and copy it manually.
                </p>
              ) : null}
            </>
          ) : busy ? (
            <p className="share__hint">Creating link…</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
