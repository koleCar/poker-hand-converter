"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { FeedbackDialog } from "@rail/ui/feedback/FeedbackDialog";
import { Icon } from "@rail/ui/icon/Icon";
import { useUiStrings } from "@rail/ui/i18n";
import { useAuth } from "../../lib/auth/context";
import { sendFeedback } from "../../lib/db/feedback";
import { useLocale } from "../../lib/i18n/client";

/**
 * "Feedback": a small pill fixed to the bottom right of every page with the
 * shell, for visitors and members alike. It opens the shared dialog
 * (`packages/ui/feedback`): a bug, a feature request or a question, with up to
 * three screenshots. Nothing in a build without Supabase.
 */
export function FeedbackButton() {
  const t = useUiStrings().feedback;
  const auth = useAuth();
  const pathname = usePathname();
  const locale = useLocale();
  const [open, setOpen] = useState(false);

  if (!auth.configured) return null;

  return (
    <>
      <button type="button" className="feedback-fab" onClick={() => setOpen(true)} title={t.openTitle} aria-haspopup="dialog">
        <Icon name="megaphone" className="feedback-fab__icon" />
        <span className="feedback-fab__label">{t.open}</span>
      </button>
      {open ? (
        <FeedbackDialog
          onClose={() => setOpen(false)}
          signedInEmail={auth.isSignedIn ? (auth.user?.email ?? null) : null}
          send={(draft) => sendFeedback(draft, { page: pathname ?? "/", locale })}
        />
      ) : null}
    </>
  );
}
