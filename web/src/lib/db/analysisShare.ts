/**
 * Sharing a hand's analysis (A7.1, `20270222090000_analysis_share.sql`).
 *
 * A hand is named by a **surface**: `hand` (its own id, on the owner's
 * analysis page), `published` (`/p/<id>`), `post` (a forum thread or poll),
 * `share` (a `/h/<slug>` link). The owner's switch accepts any surface the
 * owner made; the public read accepts only the three public ones, and answers
 * only when the owner has shared the hand and the surface is visible to the
 * caller (a poll: once the caller has voted).
 */

import { ANALYSIS_VERSION, type HandAnalysis } from "../analysis";
import { withoutOwnerFacts } from "../analysis/share";
import { handAnalysisFromStored } from "./analysisRows";
import { currentUserId, isDatabaseConfigured, rpc } from "./client";

export type ShareSurface = "hand" | "published" | "post" | "share";
export type PublicSurface = Exclude<ShareSurface, "hand">;

export interface AnalysisShareState {
  handId: string;
  shared: boolean;
  /** Analysis versions stored for the hand; the current one must be here for there to be anything to show. */
  versions: string[];
}

function stateFrom(raw: unknown): AnalysisShareState | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.handId !== "string") return null;
  return {
    handId: row.handId,
    shared: row.shared === true,
    versions: Array.isArray(row.versions) ? row.versions.filter((v): v is string => typeof v === "string") : [],
  };
}

/** The caller's own switch for the hand behind `surface`; null when it is not the caller's (or nobody is signed in). */
export async function analysisShareState(surface: ShareSurface, id: string): Promise<AnalysisShareState | null> {
  if (!isDatabaseConfigured || !(await currentUserId())) return null;
  return stateFrom(await rpc<unknown>("analysis_share_state", { p_surface: surface, p_id: id }));
}

/** Turns the switch on or off. Throws the server's sentence when the hand is not the caller's. */
export async function setAnalysisShare(surface: ShareSurface, id: string, shared: boolean): Promise<AnalysisShareState> {
  const state = stateFrom(await rpc<unknown>("set_analysis_share", { p_surface: surface, p_id: id, p_shared: shared }));
  if (!state) throw new Error("set_analysis_share returned nothing");
  return state;
}

/**
 * The shared analysis behind a public surface, read as the signed-in viewer
 * (a poll's reference depends on whether *they* voted). Null when there is
 * none to show.
 */
export async function readSharedAnalysis(surface: PublicSurface, id: string): Promise<HandAnalysis | null> {
  if (!isDatabaseConfigured) return null;
  const raw = await rpc<unknown>("read_shared_analysis", { p_surface: surface, p_id: id, p_version: ANALYSIS_VERSION });
  return raw && typeof raw === "object" ? withoutOwnerFacts(handAnalysisFromStored(raw as Record<string, unknown>)) : null;
}
