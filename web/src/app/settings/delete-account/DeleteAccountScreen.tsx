"use client";

import { useSyncExternalStore } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import {
  ACCOUNT_DELETED_FLAG,
  AccountDeletedNotice,
  DeleteAccountPanel,
} from "../../../components/account/DeleteAccountPanel";
import rows from "../../../components/account/rows.module.css";
import { AppFrame } from "../../../components/shell/AppFrame";
import { useAuth } from "../../../lib/auth";
import { useDict } from "../../../lib/i18n/client";
import { useMyProfile } from "../../../lib/profile/context";

/** Client half of `/settings/delete-account`. */
export function DeleteAccountScreen() {
  return <AppFrame tab={null}>{() => <DeleteAccountBody />}</AppFrame>;
}

const noSubscription = () => () => undefined;

function readDeletedFlag(): boolean {
  try {
    return window.sessionStorage.getItem(ACCOUNT_DELETED_FLAG) === "1";
  } catch {
    return false;
  }
}

function DeleteAccountBody() {
  const en = useDict();
  const auth = useAuth();
  const { status, profile } = useMyProfile();
  // Right after the deletion the session is gone: say it is done.
  const deleted = useSyncExternalStore(noSubscription, readDeletedFlag, () => false);

  if (!auth.isSignedIn) {
    return (
      <div className={rows.page}>
        {deleted ? (
          <AccountDeletedNotice t={en.yourData.delete} />
        ) : (
          <div className={rows.tile}>
            <span className={`${rows.avatar} ${rows.avatarEmpty}`} aria-hidden="true" />
            <span className={rows.value}>
              <h1 className={`${rows.strong} ${rows.text}`}>{en.settings.signedOut}</h1>
            </span>
            <span className={rows.actions}>
              <button type="button" className="btn btn--primary btn--sm" onClick={() => auth.requestSignIn()}>
                {en.settings.signInCta}
              </button>
            </span>
          </div>
        )}
      </div>
    );
  }

  if (status === "ready" && profile) {
    return <DeleteAccountPanel username={profile.username} />;
  }
  if (status === "loading") {
    return <RailLoader centered label={en.settings.loading} />;
  }
  return (
    <div className={rows.page}>
      <p className={rows.error}>{status === "unavailable" ? en.settings.unavailable : en.settings.loadFailed}</p>
    </div>
  );
}
