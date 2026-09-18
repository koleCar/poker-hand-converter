import {
  createShare as dbCreateShare,
  isDatabaseConfigured,
  resolveShare as dbResolveShare,
} from "../../lib/db";
import { sharedHandUrl } from "../../routes/routes";
import type {
  CreateShareRequest,
  CreateShareResponse,
  ResolveShareResult,
  ResolvedShare,
} from "./shareContract";

/**
 * Binds the share UI to the database layer.
 *
 * Slugs are generated server-side by `create_share()`; the `shares` table has no
 * anon policies at all, so `resolve_share()` is the only read path. Nothing here
 * needs to guard against enumeration — the schema already does.
 */

/** Sharing needs somewhere to put the hand, so it is off in an offline build. */
export const isShareBackendReady: boolean = isDatabaseConfigured;

export const SHARE_UNAVAILABLE_MESSAGE =
  "Sharing needs a database, and this build has none configured.";

/**
 * A hand that was never saved travels as a PHF document. The parser registry is
 * large and only this path needs it, so it is imported on demand — the shared
 * hand page never pays for it.
 */
async function derivePhf(handText: string): Promise<unknown> {
  const { convertAny } = await import("../../lib/parsers");
  const result = await convertAny(handText);
  const hand = result.hands[0];
  if (!hand) {
    throw new Error(
      "This hand could not be converted to the canonical format, so it cannot be shared.",
    );
  }
  return hand;
}

export async function createShare(request: CreateShareRequest): Promise<CreateShareResponse> {
  if (!isDatabaseConfigured) {
    throw new Error(SHARE_UNAVAILABLE_MESSAGE);
  }

  const phf =
    request.storedHandId || request.phf ? request.phf : await derivePhf(request.handText);

  const ref = await dbCreateShare({
    storedHandId: request.storedHandId,
    phf,
    handText: request.handText,
    title: request.preview.title,
  });

  return { slug: ref.slug, url: sharedHandUrl(ref.slug), reused: Boolean(ref.reused) };
}

export async function resolveShare(slug: string): Promise<ResolveShareResult> {
  if (!slug) {
    return { status: "not-found" };
  }
  if (!isDatabaseConfigured) {
    return { status: "unconfigured" };
  }

  try {
    const resolved = await dbResolveShare(slug);
    if (!resolved) {
      return { status: "not-found" };
    }

    const handText = resolved.handText || resolved.standardText || "";
    if (!handText) {
      // The row survived but the hand it pointed at did not.
      return { status: "gone" };
    }

    const share: ResolvedShare = {
      slug: resolved.slug,
      title: resolved.title,
      handText,
      phf: resolved.phf,
      preview: null,
      createdAt: resolved.createdAt,
      views: resolved.views,
      storedHandId: resolved.storedHandId,
    };
    return { status: "ok", share };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not load this hand.",
    };
  }
}

export type { CreateShareRequest, CreateShareResponse, ResolveShareResult, ResolvedShare };
