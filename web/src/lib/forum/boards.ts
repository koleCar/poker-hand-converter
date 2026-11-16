/**
 * Forum v2: each board's colour, used for its dot in the sidebar, its chip on a
 * post card and the glow behind its header. A board the list does not know
 * gets the neutral one, so a new board needs no code to appear.
 */
const BOARD_HUES: Record<string, string> = {
  nlhe: "#3ea6ff",
  mtt: "#a78bfa",
  plo: "#f472b6",
  general: "#22d3ee",
};

export const NEUTRAL_HUE = "#9fb0c4";

export function boardHue(slug: string): string {
  return BOARD_HUES[slug] ?? NEUTRAL_HUE;
}

const FACE_HUES = ["#3ea6ff", "#a78bfa", "#35c48a", "#e8b23a", "#f472b6", "#22d3ee", "#f08a4b", "#8fd6b6"];

/** A stable colour per username, for the initial-letter avatars. */
export function faceHue(username: string): string {
  let hash = 0;
  for (let index = 0; index < username.length; index += 1) {
    hash = (hash * 31 + username.charCodeAt(index)) | 0;
  }
  return FACE_HUES[Math.abs(hash) % FACE_HUES.length];
}
