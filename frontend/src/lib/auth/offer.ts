/**
 * Whether the sign-in dialog has already been offered in this browser session.
 *
 * The app offers it unprompted once, to a signed-out visitor who has not
 * answered it yet (`components/shell/AppFrame.tsx`). Every route mounts its own
 * `AppFrame`, so a latch kept in the component reopened the dialog on every
 * link a visitor followed after closing it. This one lives in
 * `sessionStorage`: once per tab session, across navigations and reloads,
 * whatever the visitor did with it. Choosing "continue without an account"
 * is still remembered for good (`isGuest`, in `localStorage`).
 *
 * The module variable covers a browser with storage blocked, for as long as
 * the page's JavaScript lives.
 */

const OFFERED_KEY = "rail.signInOffered";

let offeredInMemory = false;

export function wasSignInOffered(): boolean {
  if (offeredInMemory) return true;
  try {
    return sessionStorage.getItem(OFFERED_KEY) === "yes";
  } catch {
    return false;
  }
}

export function markSignInOffered(): void {
  offeredInMemory = true;
  try {
    sessionStorage.setItem(OFFERED_KEY, "yes");
  } catch {
    // Storage blocked: the module variable still holds for this page.
  }
}
