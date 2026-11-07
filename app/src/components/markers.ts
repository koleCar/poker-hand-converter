/**
 * The ready-made hand markers (the hand lists' "Mark" menu). A marker is a
 * tag (`hand_tags`): the list's tag filter and its row mark show it, and a
 * custom marker is just a tag of the user's own.
 *
 * The presets are stored by these English names whatever the language (the
 * menu shows them translated), so a tool that reads the store finds them.
 * {@link REVIEW} is the one the solver's nightly run reads: a hand marked
 * Review has its spot solved first, unless that spot is solved already
 * (`rail-fullsolve-out/bin/ante-nightly.sh`, which builds its review queue
 * from the store's `hand_tags`).
 */

/** The marker whose hands are solved first. */
export const REVIEW = "Review";

/** The presets, in the menu's order. */
export const PRESET_MARKERS: readonly string[] = [REVIEW, "Mistake", "Cooler", "Bluff", "Hero call"];

/** Whether two markers are the same one ("review" and "Review"). */
export function sameMarker(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/** A marker as typed: trimmed, inner whitespace one space (as the store keeps tags). */
export function typedMarker(text: string): string {
  return text.trim().split(/\s+/).filter(Boolean).join(" ");
}

/**
 * The markers the menu offers: the presets, then every other tag in use (the
 * most used first), narrowed to those that contain `needle` (ignoring case).
 */
export function offeredMarkers(known: readonly string[], needle: string): string[] {
  const all = [...PRESET_MARKERS, ...known.filter((tag) => !PRESET_MARKERS.some((preset) => sameMarker(preset, tag)))];
  const typed = needle.trim().toLocaleLowerCase();
  return typed === "" ? all : all.filter((tag) => tag.toLocaleLowerCase().includes(typed));
}
