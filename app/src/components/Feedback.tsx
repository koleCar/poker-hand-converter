/**
 * "Feedback" (the sidebar's item, the palette's command): the shared dialog
 * (`@rail/ui/feedback`) for a bug report, a feature request or a question,
 * sent through `feedback_send` (`src-tauri/src/feedback.rs`) with the screen
 * it was opened on. Signed in, the report carries the account; signed out,
 * it is a visitor's with an optional reply email.
 */
import { useEffect, useState } from "react";
import { FeedbackDialog, type FeedbackError } from "@rail/ui/feedback/FeedbackDialog";

import { useLocale } from "../i18n";
import { inApp, ipc } from "../lib/ipc";
import { useRoute } from "../lib/router";
import { useAccount } from "../lib/useAccount";

const OPEN_EVENT = "rail:open-feedback";

/** Open the feedback dialog (the sidebar, the palette). */
export function openFeedback(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const CODES: ReadonlySet<string> = new Set<FeedbackError>([
  "invalid_request",
  "too_large",
  "rate_limited",
  "unavailable",
  "offline",
]);

/** Mounted once in the shell; shows the dialog while it is open. */
export function FeedbackHost() {
  const [open, setOpen] = useState(false);
  const route = useRoute();
  const locale = useLocale();
  const { account } = useAccount();

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  if (!open) return null;
  const signedInEmail = account?.state === "signedIn" ? account.email : null;
  return (
    <FeedbackDialog
      onClose={() => setOpen(false)}
      signedInEmail={signedInEmail}
      send={async (draft) => {
        if (!inApp) return "unavailable";
        try {
          await ipc.feedbackSend({ ...draft, page: route, locale });
          return null;
        } catch (error) {
          return typeof error === "string" && CODES.has(error) ? (error as FeedbackError) : "unavailable";
        }
      }}
    />
  );
}
