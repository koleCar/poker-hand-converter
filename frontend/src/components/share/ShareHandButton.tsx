import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useDict } from "../../lib/i18n/client";
import { SignInRequiredError } from "../../lib/db";
import { toStandardText } from "../../lib/phf";
import type { PhfHand } from "../../lib/phf/types";
import { buildSharePreview } from "./preview";
import { SHARE_UNAVAILABLE_MESSAGE, createShare, isShareBackendReady } from "./shareClient";

interface ShareHandButtonProps {
  hand: PhfHand;
  /** `hands.id` when the hand is already in the database. */
  storedHandId?: string | null;
  /**
   * Skip creating a share and copy this URL instead. Used on the shared-hand
   * page, where the link already exists and is the page you are looking at.
   */
  presetUrl?: string;
  label?: string;
  /** Renders as a single icon button, sized like the replayer's other icons. */
  iconOnly?: boolean;
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
  label: labelProp,
  iconOnly = false,
  className,
}: ShareHandButtonProps) {
  const dict = useDict();
  const t = dict.chrome.share;
  const label = labelProp ?? t.button;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(presetUrl ?? null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const auth = useAuth();

  // A new hand invalidates the previous link.
  useEffect(() => {
    setUrl(presetUrl ?? null);
    setOpen(false);
    setError(null);
    setCopyState("idle");
  }, [hand.meta.handKey, presetUrl]);

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
        handKey: hand.meta.handKey,
        handText: toStandardText(hand),
        preview: buildSharePreview(hand),
      });
      setUrl(result.url);
      setCopyState((await copyToClipboard(result.url, inputRef.current)) ? "copied" : "failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : t.failed);
      // Creating a link stores the hand, so it needs an account — but opening
      // one never does, which is what the dialog's copy says. The message is
      // set either way: on the shared-hand page there is no dialog to open.
      if (err instanceof SignInRequiredError) {
        auth.requestSignIn(t.signIn);
      }
    } finally {
      setBusy(false);
    }
  }

  const canWebShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className={`share ${className ?? ""}`} ref={panelRef}>
      <button
        type="button"
        className={
          iconOnly ? "btn btn--icon share__trigger" : "btn btn--primary btn--sm share__trigger"
        }
        onClick={() => void handleShare()}
        disabled={busy}
        aria-expanded={open}
        aria-label={iconOnly ? label : undefined}
        title={
          isShareBackendReady || presetUrl
            ? iconOnly
              ? label
              : undefined
            : SHARE_UNAVAILABLE_MESSAGE
        }
      >
        <span aria-hidden="true">🔗</span>
        {iconOnly ? null : busy ? t.creating : label}
      </button>

      {open ? (
        <div className="share__panel" role="dialog" aria-label={t.heading}>
          <div className="share__panel-head">
            <strong>{t.heading}</strong>
            <button
              type="button"
              className="share__close"
              onClick={() => setOpen(false)}
              aria-label={dict.chrome.close}
            >
              ✕
            </button>
          </div>

          {error ? <p className="share__msg share__msg--error">{error}</p> : null}

          {url ? (
            <>
              <p className="share__hint">
                {t.hint}
              </p>
              <div className="share__row">
                <input
                  ref={inputRef}
                  className="share__url"
                  value={url}
                  readOnly
                  spellCheck={false}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label={t.linkLabel}
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={async () =>
                    setCopyState((await copyToClipboard(url, inputRef.current)) ? "copied" : "failed")
                  }
                >
                  {t.copy}
                </button>
              </div>

              <div className="share__actions">
                <a className="btn btn--ghost btn--sm" href={url} target="_blank" rel="noreferrer">
                  {t.open}
                </a>
                {canWebShare ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      void navigator
                        .share({ title: t.webShareTitle, url })
                        .catch(() => undefined);
                    }}
                  >
                    {t.via}
                  </button>
                ) : null}
              </div>

              {copyState === "copied" ? (
                <p className="share__msg share__msg--ok" role="status">
                  {t.copied}
                </p>
              ) : null}
              {copyState === "failed" ? (
                <p className="share__msg share__msg--warn" role="status">
                  {t.copyBlocked}
                </p>
              ) : null}
            </>
          ) : busy ? (
            <p className="share__hint">{t.creating}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
