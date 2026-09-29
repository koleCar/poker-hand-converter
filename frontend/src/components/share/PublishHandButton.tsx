/**
 * "Publish hand" — the one way a hand becomes public, indexable content.
 *
 * Only for a hand already in the library: `publish_hand` takes the stored
 * row's id and scrubs that row in SQL, so there is no document for this
 * component to send, and no way for it to send the wrong one.
 *
 * The ToS posture (#31) lives in this dialog as defaults rather than as a
 * policy page: pseudonyms are pre-selected, and "as imported" needs a second,
 * explicit confirmation under a warning.
 */

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  myPublishedHandIds,
  publishErrorMessage,
  publishHand,
  type PublishMode,
} from "../../lib/db/publishing";
import { en } from "../../lib/i18n/en";
import { useMyProfile } from "../../lib/profile/context";
import { paths } from "../../lib/routes";
import styles from "./PublishHandButton.module.css";

const MODES: PublishMode[] = ["pseudonyms", "positions", "as-imported"];

export function PublishHandButton({ storedHandId }: { storedHandId: string | null | undefined }) {
  const auth = useAuth();
  const { profile } = useMyProfile();
  const [open, setOpen] = useState(false);
  const [publishedId, setPublishedId] = useState<string | null>(null);
  const [mode, setMode] = useState<PublishMode>("pseudonyms");
  const [confirmed, setConfirmed] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Whether this hand is already out there, so the button can say so.
  useEffect(() => {
    if (!storedHandId || !auth.isSignedIn) {
      return;
    }
    let active = true;
    myPublishedHandIds([storedHandId]).then(
      (map) => {
        if (active) setPublishedId(map[storedHandId] ?? null);
      },
      () => {
        // A database without the publishing migration: the button still opens,
        // and the publish call itself explains what is missing.
      },
    );
    return () => {
      active = false;
    };
  }, [storedHandId, auth.isSignedIn]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!storedHandId || !auth.configured) {
    return null;
  }

  function openDialog() {
    if (!auth.isSignedIn) {
      auth.requestSignIn(en.publish.signIn);
      return;
    }
    setError(null);
    setNotice(null);
    setOpen(true);
  }

  async function submit() {
    if (!storedHandId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await publishHand(storedHandId, mode, title);
      setPublishedId(result.publicId);
      setNotice(result.alreadyPublished ? en.publish.already : en.publish.done);
    } catch (err) {
      setError(publishErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const blocked = profile?.postingBlockReason ?? null;
  const needsConfirm = mode === "as-imported" && !confirmed;

  return (
    <>
      <button
        type="button"
        className="btn btn--icon"
        onClick={openDialog}
        aria-label={publishedId ? en.publish.publishedButton : en.publish.button}
        title={publishedId ? en.publish.publishedButton : en.publish.button}
      >
        {publishedId ? "🌐" : "📣"}
      </button>

      {open ? (
        <div
          className={styles.scrim}
          onPointerDown={(event) => {
            if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
          }}
        >
          <div className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="publish-title" ref={panelRef}>
            <h2 id="publish-title" className={styles.heading}>
              {en.publish.heading}
            </h2>

            {publishedId && notice ? (
              <>
                <p className="notice notice--info" role="status">
                  {notice}
                </p>
                <div className={styles.actions}>
                  <Link href={paths.publishedHand(publishedId)} className="btn btn--primary">
                    {en.publish.view}
                  </Link>
                  <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
                    {en.publish.cancel}
                  </button>
                </div>
              </>
            ) : publishedId ? (
              <>
                <p className="muted">{en.publish.already}</p>
                <div className={styles.actions}>
                  <Link href={paths.publishedHand(publishedId)} className="btn btn--primary">
                    {en.publish.view}
                  </Link>
                  <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
                    {en.publish.cancel}
                  </button>
                </div>
              </>
            ) : (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <p className={styles.lead}>{en.publish.lead}</p>

                <label className={styles.field}>
                  <span>{en.publish.titleLabel}</span>
                  <input
                    value={title}
                    maxLength={140}
                    placeholder={en.publish.titlePlaceholder}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>

                <fieldset className={styles.modes}>
                  <legend>{en.publish.modeLabel}</legend>
                  {MODES.map((value) => (
                    <label key={value} className={styles.mode}>
                      <input
                        type="radio"
                        name="publish-mode"
                        value={value}
                        checked={mode === value}
                        onChange={() => {
                          setMode(value);
                          setConfirmed(false);
                        }}
                      />
                      <span>
                        <strong>{en.publish.modes[value].label}</strong>
                        <small className="muted">{en.publish.modes[value].hint}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>

                {mode === "as-imported" ? (
                  <div className="notice notice--warn">
                    <p>{en.publish.asImportedWarning}</p>
                    <label className={styles.confirm}>
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      <span>{en.publish.asImportedConfirm}</span>
                    </label>
                  </div>
                ) : null}

                <p className={`muted ${styles.small}`}>{en.publish.alwaysRemoved}</p>

                {blocked ? <p className="notice notice--warn">{blocked}</p> : null}
                {error ? (
                  <p className="notice notice--error" role="alert">
                    {error}
                  </p>
                ) : null}

                <div className={styles.actions}>
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={busy || needsConfirm || Boolean(blocked)}
                  >
                    {busy ? en.publish.submitting : en.publish.submit}
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
                    {en.publish.cancel}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
