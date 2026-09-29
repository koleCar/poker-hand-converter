import "server-only";

import { cache } from "react";
import { getServerSupabase } from "../supabase/server";

/**
 * Reading a public profile, server-side, for `/u/[username]`.
 *
 * Two doors, both open to `anon`:
 *
 *  * `profiles_public` — the view whose column list is the public surface of an
 *    account. Anything not selected below is not in it, and anything not in it
 *    is none of a stranger's business. See the view's comment in
 *    `20261007090000_forum_identity.sql` before widening it.
 *  * `resolve_username()` — "what is this name called now", which is how a
 *    renamed account's old address keeps working for the year its name is held.
 *
 * `cache()` for the same reason as `readShare`: `generateMetadata` and the page
 * body both ask, supabase-js RPCs are POSTs, and Next does not dedupe a POST.
 */

const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_]{2,23}$/;

export interface PublicProfile {
  id: string;
  username: string;
  karma: number;
  /** `YYYY-MM-DD`, UTC. A date on purpose — see `profiles_public`. */
  joinedOn: string;
}

export type ProfileReadResult =
  | { status: "ok"; profile: PublicProfile }
  /** The name is an old or differently-capitalised one; send them here instead. */
  | { status: "redirect"; username: string }
  | { status: "not-found" }
  | { status: "unconfigured" }
  | { status: "error" };

export const readProfile = cache(async (username: string): Promise<ProfileReadResult> => {
  // Shape first: a malformed name and an unknown one are the same answer, and
  // the first costs no round trip.
  if (!username || !NAME_SHAPE.test(username)) {
    return { status: "not-found" };
  }

  const supabase = await getServerSupabase();
  if (!supabase) {
    return { status: "unconfigured" };
  }

  const { data, error } = await supabase
    .from("profiles_public")
    .select("id, username, karma, joined_on")
    .eq("username_lower", username.toLowerCase())
    .maybeSingle();

  if (error) {
    return { status: "error" };
  }

  if (data) {
    if (data.username !== username) {
      // Same account, other capitalisation. One spelling per profile, so links
      // and the canonical URL agree.
      return { status: "redirect", username: data.username as string };
    }
    return {
      status: "ok",
      profile: {
        id: String(data.id),
        username: String(data.username),
        karma: Number(data.karma ?? 0),
        joinedOn: String(data.joined_on),
      },
    };
  }

  const resolved = await supabase.rpc("resolve_username", { p_username: username });
  if (resolved.error) {
    return { status: "error" };
  }
  const target = (resolved.data as { username?: string } | null)?.username;
  return target ? { status: "redirect", username: target } : { status: "not-found" };
});
