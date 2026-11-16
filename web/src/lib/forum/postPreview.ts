/**
 * What a forum post will show, computed in the browser for the post preview
 * (`/submit/preview`). Display only: the server does the real work when the
 * hand is published (`scrub_phf`) and when a poll is read (`poll_phf`), and
 * nothing here is sent anywhere. These mirror those two SQL functions closely
 * enough that the preview shows the names and the spot the readers will get.
 *
 * Also the hand's hand-off from the share popover to the preview tab: a hand
 * that is not in the library yet travels through `localStorage`, under a
 * one-off key in the tab's URL, because the new tab has no other way to get it.
 */

import type { PhfAction, PhfHand } from "../phf/types";
import type { PublishMode } from "../db/publishing";

function escapeRegExp(value: string): string {
  // No `-`: outside a class it needs no escape, and `\-` is a syntax error in a `u` pattern.
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `phf_replace_names`: whole-name replacement, longest names first. */
function replaceNames(text: string, map: Map<string, string>): string {
  let out = text;
  const keys = [...map.keys()]
    .filter((key) => key !== "" && key !== map.get(key))
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const key of keys) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(key)}(?=$|[^\\p{L}\\p{N}_])`, "gu");
    out = out.replace(pattern, (_match, before: string) => `${before}${map.get(key)}`);
  }
  return out;
}

/** `scrub_phf`'s name map: Hero, then Villain1..n or positions, in seat order. */
function nameMap(hand: PhfHand, mode: PublishMode): Map<string, string> {
  const map = new Map<string, string>();
  if (mode === "as-imported") return map;
  const used = new Set<string>();
  let villain = 0;
  for (const player of [...hand.players].sort((a, b) => a.seat - b.seat)) {
    if (!player.name || map.has(player.name)) continue;
    let name: string;
    if (player.isHero) name = "Hero";
    else if (mode === "positions") name = player.position ?? `Seat${player.seat}`;
    else name = `Villain${++villain}`;
    if (used.has(name)) name = `${name}_${player.seat}`;
    used.add(name);
    map.set(player.name, name);
  }
  return map;
}

/** The hand with the names and provenance a published copy loses. */
export function previewScrub(hand: PhfHand, mode: PublishMode): PhfHand {
  const map = nameMap(hand, mode);
  const rename = (name: string) => map.get(name) ?? name;
  const text = (value: string) => replaceNames(value, map);
  return {
    ...hand,
    meta: { ...hand.meta, rawText: "", originalFilename: null, warnings: [], handId: "", handKey: "" },
    table: { ...hand.table, name: null },
    tournament: hand.tournament ? { ...hand.tournament, id: "" } : null,
    playedAt: null,
    game: hand.game.straddles
      ? { ...hand.game, straddles: hand.game.straddles.map((entry) => ({ ...entry, player: rename(entry.player) })) }
      : hand.game,
    players: hand.players.map((player) => ({ ...player, name: rename(player.name) })),
    actions: hand.actions.map((action) => ({
      ...action,
      player: rename(action.player),
      label: text(action.label),
      ...(typeof action.description === "string" ? { description: text(action.description) } : {}),
      rawLine: "",
      sourceLine: null,
    })),
    results: {
      ...hand.results,
      players: hand.results.players.map((entry) => ({
        ...entry,
        player: rename(entry.player),
        handDescription: entry.handDescription === null ? null : text(entry.handDescription),
        raw: null,
      })),
      winners: hand.results.winners.map((entry) => ({ ...entry, player: rename(entry.player) })),
    },
  };
}

const LATER: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3, showdown: 4 };

/** `poll_phf`: the hand up to (not including) the polled decision, as a reader sees it before voting. */
export function previewPoll(hand: PhfHand, stop: PhfAction, hideHeroCards: boolean): PhfHand {
  const street = LATER[stop.street] ?? 0;
  const run = hand.board.runouts[0];
  return {
    ...hand,
    actions: hand.actions.filter((action) => action.index < stop.index),
    players: hand.players.map((player) =>
      player.isHero && !hideHeroCards ? player : { ...player, holeCards: [], dealtCards: [] },
    ),
    board: {
      runouts: [
        {
          index: 0,
          flop: street >= 1 ? (run?.flop ?? null) : null,
          turn: street >= 2 ? (run?.turn ?? null) : null,
          river: street >= 3 ? (run?.river ?? null) : null,
          markerLabels: {},
          summaryCards: null,
        },
      ],
    },
    chipMovements: [],
    results: {
      ...hand.results,
      totalPot: 0,
      pots: [],
      players: [],
      winners: [],
      heroNet: null,
      wentToShowdown: false,
      streetReached: stop.street,
    },
  };
}

/* ------------------------------------------------- popover → preview tab - */

const DRAFT_PREFIX = "rail.postDraft.";
/** A draft older than this is somebody's abandoned tab. */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredDraft {
  at: number;
  hand: PhfHand;
}

/** Puts an unsaved hand where the preview tab can read it; returns the key, or null when storage is blocked. */
export function stashPostDraft(hand: PhfHand): string | null {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(DRAFT_PREFIX)) continue;
      const stored = JSON.parse(localStorage.getItem(key) ?? "null") as StoredDraft | null;
      if (!stored || now - stored.at > DRAFT_TTL_MS) localStorage.removeItem(key);
    }
    const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(DRAFT_PREFIX + id, JSON.stringify({ at: now, hand } satisfies StoredDraft));
    return id;
  } catch {
    return null;
  }
}

export function readPostDraft(id: string): PhfHand | null {
  try {
    const stored = JSON.parse(localStorage.getItem(DRAFT_PREFIX + id) ?? "null") as StoredDraft | null;
    return stored?.hand ?? null;
  } catch {
    return null;
  }
}

export function dropPostDraft(id: string): void {
  try {
    localStorage.removeItem(DRAFT_PREFIX + id);
  } catch {
    // Nothing to clean up in a browser that blocks storage.
  }
}

/* --------------------------------------------- desktop app → preview tab - */

/**
 * The desktop app opens the preview in the default browser with the hand in
 * the URL's fragment: `#text=<base64url of the gzipped standard text>`. A
 * fragment never leaves the browser, so the hand reaches no server until the
 * author presses Post (`app/src-tauri/src/share.rs`, `forum_preview_open`).
 */
export async function handTextFromFragment(hash: string): Promise<string | null> {
  const packed = new URLSearchParams(hash.replace(/^#/, "")).get("text");
  if (!packed || !/^[A-Za-z0-9_-]+$/.test(packed)) return null;
  try {
    const base64 = packed.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  } catch {
    return null;
  }
}
