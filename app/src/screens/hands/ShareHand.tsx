/**
 * "Share hand" beside the replayer's full-screen button: the web's share
 * link (`ShareHandButton` there), made by the app from the hand in the local
 * store (`hand_share`, src-tauri/src/share.rs). The link opens without an
 * account; making one needs the app to be signed in.
 *
 * The panel is portalled to the body and placed under the button: the
 * replayer clips its own box (`overflow: clip`), and a panel inside it would
 * be cut off at the felt's edge.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import type { PhfHand } from "@rail/ui/model/phf";
import { stakesLabel } from "@rail/ui/replayer/handFacts";

import { useT } from "../../i18n";
import { errorText, ipc, type HandShare, type ShareErrorCode } from "../../lib/ipc";
import styles from "./ShareHand.module.css";

type CopyState = "idle" | "copied" | "failed";

/** The web's title for a link without spoilers (`buildSharePreview`). */
function shareTitle(hand: PhfHand): string {
  const game = hand.game.label.replace(/\s*\([^)]*\)\s*$/, "").trim() || "Poker";
  return `${stakesLabel(hand)} ${game} — ${hand.players.length}-handed | Rail`;
}

async function copyText(text: string, input: HTMLInputElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // A webview that only lets a click copy: select the link instead.
  }
  try {
    if (input) {
      input.focus();
      input.select();
      return document.execCommand("copy");
    }
  } catch {
    // The caller says so.
  }
  return false;
}

export function ShareHand({ handKey, hand }: { handKey: string; hand: PhfHand }) {
  const words = useT().hands.panel;
  const t = words.share;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<HandShare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [copy, setCopy] = useState<CopyState>("idle");
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Under the button, right edges aligned.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const place = () => {
      const box = buttonRef.current?.getBoundingClientRect();
      if (box) setAt({ top: box.bottom + 4, right: Math.max(8, window.innerWidth - box.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // Escape, or a press outside the panel and the button, closes it.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  useEffect(() => {
    if (copy === "idle") return;
    const timer = window.setTimeout(() => setCopy("idle"), 4000);
    return () => window.clearTimeout(timer);
  }, [copy]);

  const share = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setError(null);
    setSignedOut(false);
    if (link) {
      setCopy((await copyText(link.url, inputRef.current)) ? "copied" : "failed");
      return;
    }
    setBusy(true);
    try {
      const made = await ipc.handShare(handKey, shareTitle(hand));
      setLink(made);
      // Straight into the clipboard when the webview allows it this long
      // after the click; when it does not, the Copy button is right there.
      if (await copyText(made.url, null)) setCopy("copied");
    } catch (reason: unknown) {
      const code: ShareErrorCode | (string & {}) = errorText(reason);
      if (code === "signedOut") setSignedOut(true);
      else if (code === "rateLimited") setError(t.rateLimited);
      else if (code === "unavailable") setError(t.unavailable);
      else if (code === "missing") setError(words.missing);
      else setError(t.failed(code));
    } finally {
      setBusy(false);
    }
  };

  const panel =
    open && at
      ? createPortal(
          <div
            ref={panelRef}
            className={styles.panel}
            style={{ top: at.top, right: at.right }}
            role="dialog"
            aria-label={t.heading}
          >
            <div className={styles.head}>
              <strong>{t.heading}</strong>
              <button
                type="button"
                className="btn btn--icon btn--sm"
                onClick={() => setOpen(false)}
                aria-label={t.close}
                title={t.close}
              >
                <Icon name="close" />
              </button>
            </div>
            {busy ? <RailLoader size="small" showLabel label={t.creating} /> : null}
            {signedOut ? (
              <>
                <p className={styles.hint}>{t.signedOut}</p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => {
                      ipc.accountSignIn().catch((reason: unknown) => setError(errorText(reason)));
                    }}
                  >
                    {t.signIn}
                  </button>
                </div>
              </>
            ) : null}
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            {link ? (
              <>
                <p className={styles.hint}>{t.hint}</p>
                <div className={styles.row}>
                  <input
                    ref={inputRef}
                    className={styles.url}
                    value={link.url}
                    readOnly
                    spellCheck={false}
                    aria-label={t.linkLabel}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      void copyText(link.url, inputRef.current).then((done) =>
                        setCopy(done ? "copied" : "failed"),
                      );
                    }}
                  >
                    {t.copy}
                  </button>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      ipc.shareOpen(link.slug).catch((reason: unknown) => setError(errorText(reason)));
                    }}
                  >
                    <Icon name="globe" />
                    {t.open}
                  </button>
                </div>
                {copy !== "idle" ? (
                  <p
                    className={copy === "copied" ? styles.ok : styles.warn}
                    role="status"
                  >
                    {copy === "copied" ? t.copied : t.copyFailed}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`btn btn--icon ${open ? "is-active" : ""}`.trim()}
        onClick={() => void share()}
        disabled={busy}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t.button}
        title={t.button}
      >
        <Icon name="link" />
      </button>
      {panel}
    </>
  );
}
