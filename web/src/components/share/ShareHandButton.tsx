import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../../lib/auth";
import { useDict } from "../../lib/i18n/client";
import { SignInRequiredError } from "../../lib/db";
import { toStandardText } from "../../lib/phf";
import type { PhfHand } from "../../lib/phf/types";
import { buildSharePreview } from "./preview";
import { SHARE_UNAVAILABLE_MESSAGE, createShare, isShareBackendReady } from "./shareClient";
import { AnalysisShareToggle } from "../analysis/AnalysisShareToggle";
import { ShareNamesToggle } from "./ShareNamesToggle";
import { loadShareNamesPreference } from "@rail/ui/share/namesPreference";
import { ShareToForum } from "./ShareToForum";
import { Icon } from "@rail/ui/icon/Icon";

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
  /** The link made here, for its names switch (R4.5); none for a preset URL. */
  const [slug, setSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** The popover lives in a portal, placed under the trigger: a replayer pane's overflow cannot clip it. */
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const auth = useAuth();

  // A new hand invalidates the previous link.
  useEffect(() => {
    setUrl(presetUrl ?? null);
    setSlug(null);
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
      const target = event.target as Node;
      if (panelRef.current && !panelRef.current.contains(target) && !popRef.current?.contains(target)) {
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

  useLayoutEffect(() => {
    if (!open) return;
    function measure() {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(344, window.innerWidth - 28);
      // Right-aligned to the trigger, kept on screen.
      const left = Math.max(14, Math.min(rect.right - width, window.innerWidth - width - 14));
      setPlace({ top: rect.bottom + 8, left, width });
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  async function handleShare() {
    setOpen(true);
    setError(null);

    if (url) {
      setCopyState((await copyToClipboard(url, inputRef.current)) ? "copied" : "failed");
      return;
    }
    if (auth.configured && !auth.isSignedIn) {
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
        // A stored hand's document goes along: the server needs it when the
        // row is stored as text (20271114090000).
        phf: storedHandId ? hand : undefined,
        handKey: hand.meta.handKey,
        handText: toStandardText(hand),
        preview: buildSharePreview(hand),
        // The owner's last answer on the names switch, so a fresh link made
        // after reopening the hand does not quietly hide the names again.
        showNames: loadShareNamesPreference(),
      });
      setUrl(result.url);
      setSlug(result.slug);
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
  // Making a link stores the hand, so it needs an account; say so in the
  // popover instead of opening it on an error.
  const needsSignIn = auth.configured && !auth.isSignedIn && !presetUrl && !url;

  async function copy(link: string) {
    setCopyState((await copyToClipboard(link, inputRef.current)) ? "copied" : "failed");
  }

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
        <Icon name="link" />
        {iconOnly ? null : busy ? t.creating : label}
      </button>

      {open && place ? createPortal(
        <div ref={popRef} className="share__panel" role="dialog" aria-label={t.heading} style={place}>
          {needsSignIn ? (
            <>
              <p className="share__hint">{t.signInLine}</p>
              <div>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => auth.requestSignIn(t.signIn)}>
                  {t.signInButton}
                </button>
              </div>
            </>
          ) : (
            <>
              {error ? <p className="share__msg share__msg--error">{error}</p> : null}

              {url || busy ? (
                <div className="share__link">
                  {url ? (
                    <input
                      ref={inputRef}
                      className="share__url"
                      value={url}
                      readOnly
                      spellCheck={false}
                      onFocus={(event) => event.currentTarget.select()}
                      aria-label={t.linkLabel}
                    />
                  ) : (
                    <span className="share__shim" role="status" aria-label={t.creating} />
                  )}
                  {url ? (
                    <a className="share__icon" href={url} target="_blank" rel="noreferrer" aria-label={t.open} title={t.open}>
                      <Icon name="external" />
                    </a>
                  ) : null}
                  {url && canWebShare ? (
                    <button
                      type="button"
                      className="share__icon"
                      aria-label={t.via}
                      title={t.via}
                      onClick={() => {
                        void navigator.share({ title: t.webShareTitle, url }).catch(() => undefined);
                      }}
                    >
                      <Icon name="shareOut" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`share__copy${copyState === "copied" ? " is-ok" : ""}`}
                    disabled={!url}
                    onClick={() => (url ? void copy(url) : undefined)}
                  >
                    {copyState === "copied" ? <Icon name="check" /> : null}
                    <span role="status">{copyState === "copied" ? t.copiedShort : t.copy}</span>
                  </button>
                </div>
              ) : null}

              {copyState === "failed" ? (
                <p className="share__msg share__msg--warn" role="status">
                  {t.copyBlocked}
                </p>
              ) : null}

              {/* R4.5: the link hides the players' names unless this is on. */}
              {slug ? <ShareNamesToggle slug={slug} compact /> : null}
              {/* A7.1: a stored hand's analysis stays private unless this is on. */}
              {storedHandId && !presetUrl ? <AnalysisShareToggle surface="hand" id={storedHandId} compact /> : null}

              {/* The post's settings and a preview of it, in a new tab. */}
              {!presetUrl ? (
                <>
                  <div className="share__sep" />
                  <ShareToForum hand={hand} storedHandId={storedHandId} />
                </>
              ) : null}
            </>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
