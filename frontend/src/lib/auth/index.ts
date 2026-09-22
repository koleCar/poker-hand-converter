/**
 * Accounts.
 *
 * The app has three kinds of visitor and they are deliberately distinct:
 *
 *  * **Signed in.** Owns a library. `hands.owner_id` is their user id and RLS
 *    means every read and write is scoped to it — nobody else's hands are
 *    reachable, by the UI or by `curl`.
 *  * **Guest.** Has said "carry on without an account". Everything that runs in
 *    the browser works: converting, previewing, downloading, replaying a pasted
 *    hand. Nothing is stored, because there is no id to store it under. Asking
 *    to save is what turns a guest into a signed-in user.
 *  * **A stranger on a share link.** Needs no account at all and never sees the
 *    dialog. `resolve_share` is `security definer`, so a slug works regardless
 *    of who is holding it.
 */

export { AuthProvider } from "./AuthProvider";
export { useAuth, type AuthContextValue, type AuthStatus } from "./context";
export {
  AUTH_UNAVAILABLE_MESSAGE,
  isGoogleAuthOffered,
  type AuthUser,
  type SignUpOutcome,
} from "./session";
