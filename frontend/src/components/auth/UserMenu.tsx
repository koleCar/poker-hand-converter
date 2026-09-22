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

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";

export function UserMenu() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!auth.configured) {
    return null;
  }

  if (auth.status === "loading") {
    return <span className="usermenu__placeholder" aria-hidden="true" />;
  }

  if (!auth.isSignedIn) {
    return (
      <button
        type="button"
        className="btn btn--sm usermenu__signin"
        onClick={() => auth.requestSignIn()}
      >
        Sign in
      </button>
    );
  }

  const user = auth.user;
  const initial = (user?.displayName ?? "?").charAt(0).toUpperCase();

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
        <span className="usermenu__name">{user?.displayName}</span>
      </button>

      {open ? (
        <div className="usermenu__panel" role="menu">
          <div className="usermenu__who">
            <strong>{user?.displayName}</strong>
            {user?.email && user.email !== user.displayName ? (
              <small className="muted">{user.email}</small>
            ) : null}
            <small className="muted">Your hands are private to this account.</small>
          </div>
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
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
