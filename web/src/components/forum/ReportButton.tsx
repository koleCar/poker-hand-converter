"use client";

import { useState } from "react";
import { useAuth } from "../../lib/auth";
import { forumErrorMessage } from "../../lib/db/forum";
import { reportContent, type ReportReason, type ReportSubject } from "../../lib/db/moderation";
import { useDict } from "../../lib/i18n/client";
import styles from "./forum.module.css";
import { Dismissible } from "@rail/ui/notice/Dismissible";

const REASONS: ReportReason[] = ["spam", "harassment", "cheating", "off-topic", "hh-takedown", "other"];

/** "Report" and its small form. The report itself is a definer RPC; see #40. */
export function ReportButton({ subject, defaultReason = "spam" }: { subject: ReportSubject; defaultReason?: ReportReason }) {
  const en = useDict();
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>(defaultReason);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!auth.configured) return null;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const result = await reportContent(subject, reason, details);
      setMessage(result.alreadyReported ? en.moderation.alreadyReported : en.moderation.reported);
    } catch (err) {
      setError(forumErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="linkish"
        onClick={() => (auth.isSignedIn ? setOpen(true) : auth.requestSignIn(en.moderation.signIn))}
      >
        {en.moderation.report}
      </button>
    );
  }

  return (
    <div className={styles.reportBox} role="group" aria-label={en.moderation.reportHeading}>
      {message ? (
        <Dismissible className="notice notice--info">{message}</Dismissible>
      ) : (
        <>
          <strong>{en.moderation.reportHeading}</strong>
          {REASONS.map((value) => (
            <label key={value} className={styles.row}>
              <input type="radio" name={`reason-${JSON.stringify(subject)}`} checked={reason === value} onChange={() => setReason(value)} />
              <span>{en.moderation.reasons[value]}</span>
            </label>
          ))}
          <label className="stack">
            <span className="muted">{en.moderation.detailsLabel}</span>
            <textarea value={details} maxLength={1000} rows={2} onChange={(event) => setDetails(event.target.value)} />
          </label>
          {error ? <Dismissible className="notice notice--error">{error}</Dismissible> : null}
          <div className={styles.row}>
            <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => void send()}>
              {en.moderation.submitReport}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(false)}>
              {en.moderation.cancel}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
