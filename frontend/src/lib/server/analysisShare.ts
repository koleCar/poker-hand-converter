import "server-only";

import { cache } from "react";
import { ANALYSIS_VERSION } from "../analysis/types";
import { getAnonServerSupabase } from "../supabase/server";

/**
 * A hand's shared analysis for a public page's server render (A7.1). Read as
 * `anon`, like the forum: the HTML is the same for everybody, and a surface
 * whose answer depends on the reader — a poll's reference after *they* voted —
 * is read again in the browser (`lib/db/analysisShare.ts`).
 *
 * Returns the stored row as the database projected it (named keys, no ids);
 * the client island maps it with `handAnalysisFromStored`. Null when the owner
 * has not shared it, the surface is not public, or the hand has no analysis
 * at the current version.
 */
export const readSharedAnalysisAnon = cache(
  async (surface: "published" | "post" | "share", id: string): Promise<Record<string, unknown> | null> => {
    const supabase = getAnonServerSupabase();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc("read_shared_analysis", {
      p_surface: surface,
      p_id: id,
      p_version: ANALYSIS_VERSION,
    });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  },
);
