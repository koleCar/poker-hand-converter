/**
 * The account control in the app bar.
 *
 * Signed out it is a single "Sign in" button; signed in it is the account's
 * name with a small menu behind it. The one non-obvious case is `loading`,
 * which renders a fixed-width placeholder rather than the signed-out button:
 * reading the stored session is async, and a "Sign in" button that appears for
 * 200 ms and then turns into somebody's email on every reload is worse than a
 * brief blank.
 */

"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../lib/auth";
import { useDict } from "../../lib/i18n/client";
import { useMyProfile } from "../../lib/profile/context";
import { paths } from "../../lib/routes";
import { BusyLabel } from "../shell/BusyLabel";
import { RailLoader } from "@rail/ui/loader/RailLoader";

export function UserMenu() {
  const en = useDict();
  const auth = useAuth();
  const { profile } = useMyProfile();
  const pathname = usePathname();
  // The address the menu was opened on: it is open only while that is still
  // the address, so it closes by itself when a menu link's page arrives. Until
  // then it stays open and the item shows that it is opening.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn !== null && openOn === pathname;
  const setOpen = (value: boolean | ((was: boolean) => boolean)) =>
    setOpenOn(() => ((typeof value === "function" ? value(open) : value) ? pathname : null));
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenOn(null);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenOn(null);
      }
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A link to the page already shown navigates nowhere: close the menu.
  const closeIfHere = (href: string) => {
    if (href === pathname) setOpen(false);
  };

  if (!auth.configured) {
    return null;
  }

  if (auth.status === "loading") {
    return (
      <span className="usermenu__placeholder">
        <RailLoader size="inline" label={en.loading.generic} />
      </span>
    );
  }

  if (!auth.isSignedIn) {
    return (
      <button
        type="button"
        className="btn btn--sm usermenu__signin"
        onClick={() => auth.requestSignIn()}
      >
        {en.chrome.menu.signIn}
      </button>
    );
  }

  const user = auth.user;
  // The public name once the profile has loaded; the provider's name (or the
  // email's local part) until then, and on a database without profiles. Only
  // the account itself ever sees the fallback, so it leaks nothing.
  const name = profile?.username ?? user?.displayName ?? "";
  const initial = (name || "?").charAt(0).toUpperCase();

  return (
    <div className="usermenu" ref={rootRef}>
      <button
        type="button"
        className="usermenu__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {user?.avatarUrl ? (
          <img className="usermenu__avatar" src={user.avatarUrl} alt="" width={24} height={24} />
        ) : (
          <span className="usermenu__avatar usermenu__avatar--initial" aria-hidden="true">
            {initial}
          </span>
        )}
        <span className="usermenu__name">{name}</span>
      </button>

      {open ? (
        <div className="usermenu__panel" role="menu">
          <div className="usermenu__who">
            <strong>{name}</strong>
            {user?.email && user.email !== name ? (
              <small className="muted">{user.email}</small>
            ) : null}
          </div>
          <Link href={paths.settings()} className="usermenu__item" role="menuitem" onClick={() => closeIfHere(paths.settings())}>
            <PendingLabel busyLabel={en.account.opening}>{en.account.menuProfile}</PendingLabel>
          </Link>
          <Link href={paths.saved()} className="usermenu__item" role="menuitem" onClick={() => closeIfHere(paths.saved())}>
            <PendingLabel busyLabel={en.account.opening}>{en.social.menuSaved}</PendingLabel>
          </Link>
          {profile && profile.role !== "member" ? (
            <Link href={paths.mod()} className="usermenu__item" role="menuitem" onClick={() => closeIfHere(paths.mod())}>
              <PendingLabel busyLabel={en.account.opening}>{en.moderation.menuMod}</PendingLabel>
            </Link>
          ) : null}
          {profile?.role === "admin" ? (
            <Link href={paths.admin()} className="usermenu__item" role="menuitem" onClick={() => closeIfHere(paths.admin())}>
              <PendingLabel busyLabel={en.account.opening}>{en.admin.menu}</PendingLabel>
            </Link>
          ) : null}
          <button
            type="button"
            className="usermenu__item"
            role="menuitem"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await auth.signOut();
                setOpen(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            <BusyLabel busy={busy} busyLabel={en.chrome.menu.signingOut}>
              {en.chrome.menu.signOut}
            </BusyLabel>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A menu item's words, or a spinner and "Opening…" while its page loads
 * (`useLinkStatus` answers only inside a `<Link>`). Without it a click on a
 * slow page looked like nothing happened.
 */
function PendingLabel({ busyLabel, children }: { busyLabel: string; children: ReactNode }) {
  const { pending } = useLinkStatus();
  if (!pending) return <>{children}</>;
  return (
    <span className="usermenu__pending" role="status">
      <RailLoader size="inline" label={busyLabel} />
      {busyLabel}
    </span>
  );
}
