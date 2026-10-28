// A tutorial's script: what the video shows, step by step. The shots and
// their targets come from the capture (public/captures/<slug>/manifest.json);
// a script names them, and says what to say about each.

export interface Step {
  /** The shot (screenshot id in the manifest). */
  shot: string;
  /**
   * The target the camera frames (a name in the shot's `targets`). Omitted:
   * the whole shot (the top of a tall page, at the frame's width).
   */
  focus?: string;
  /**
   * How much of the frame the focus fills, 0-1 of the frame's width or height
   * (default 0.6). Lower shows more context around it.
   */
  fill?: number;
  /**
   * Never magnify further than this many video pixels per shot pixel
   * (default 1.35; shots are taken at device scale 2, so 1 is twice the
   * page's own size and still sharp).
   */
  maxZoom?: number;
  /** Draw the shot's layers (the HUD's overlay) - default true. */
  layers?: boolean;
  /** Fade the shot's layers in during this step. */
  reveal?: boolean;
  /** The target the cursor moves to (its centre), if any. */
  cursor?: string;
  /** A click ripple when the cursor arrives. */
  click?: boolean;
  /** Target(s) outlined with a highlight box (and the rest dimmed). */
  highlight?: string | string[];
  /** A callout label next to the (first) highlight. */
  callout?: string;
  /** The lower-third caption: what the step shows, in one or two sentences. */
  caption: string;
  /** How long the step stays on screen, in seconds (at least 2.5). */
  seconds: number;
}

export interface Chapter {
  /** A short heading shown with the step badge (e.g. "Filters"). */
  title: string;
  steps: Step[];
}

export interface Tutorial {
  /** The composition id: the feature's slug (docs/GUIDE.md uses the same). */
  slug: string;
  /** The captures it reads, when another tutorial's (a part split off). */
  captures?: string;
  /** The title card. */
  title: string;
  subtitle: string;
  /** Where the feature lives, shown on the title card (a path or a screen). */
  where: string;
  chapters: Chapter[];
  /** The outro's pointer to the next tutorial (a slug), if any. */
  next?: string;
}

/** Seconds of the title card and of the outro. */
export const TITLE_SECONDS = 3.5;
export const OUTRO_SECONDS = 4;
export const FPS = 30;

export function tutorialSeconds(t: Tutorial): number {
  const steps = t.chapters.flatMap((c) => c.steps);
  return TITLE_SECONDS + steps.reduce((sum, s) => sum + s.seconds, 0) + OUTRO_SECONDS;
}
