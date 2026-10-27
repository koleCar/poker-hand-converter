/**
 * The exploit lab's locks and presets (Learn L4), apart from the lab itself
 * (`lab.ts`) so the catalogue, the review cards and the screens can name
 * them without importing the solver. Plain data, no imports.
 */

export const LAB_LOCKS = ["fold-to-bet", "never-raise", "air-bets"] as const;
export type LabLock = (typeof LAB_LOCKS)[number];

/**
 * The reads the lessons lock, each a lock and a value. For `fold-to-bet` the
 * value is a shift: points added to the baseline's fold share at each bet
 * size (a player who folds too much folds more than the baseline to every
 * size, not the same share to all of them). For the others it is the share
 * itself. A value is the learner's read of an opponent, not a fact about
 * anyone: the widget lets them set their own.
 */
export const LAB_PRESETS = {
  /** Folds 20 points more than the baseline to a river bet, at every size. */
  overfold: { lock: "fold-to-bet", value: 0.2 },
  /** Folds 25 points less than the baseline to a river bet, at every size. */
  station: { lock: "fold-to-bet", value: -0.25 },
  /** Never raises a river bet. */
  passive: { lock: "never-raise", value: 0 },
  /** Bets 5% of its air when first to act on the river. */
  underbluff: { lock: "air-bets", value: 0.05 },
  /** Bets 60% of its air when first to act on the river. */
  maniac: { lock: "air-bets", value: 0.6 },
} as const satisfies Record<string, { lock: LabLock; value: number }>;

/** Whether a lock's value is a shift from the baseline (`fold-to-bet`) rather than a share. */
export function isShift(lock: LabLock): boolean {
  return lock === "fold-to-bet";
}

/** The values a lock accepts: a shift of −1..1, or a share of 0..1. */
export function validValue(lock: LabLock, value: number): boolean {
  return Number.isFinite(value) && value <= 1 && value >= (isShift(lock) ? -1 : 0);
}

export type LabPreset = keyof typeof LAB_PRESETS;
export const LAB_PRESET_IDS = Object.keys(LAB_PRESETS) as LabPreset[];

export function isLabPreset(value: unknown): value is LabPreset {
  return typeof value === "string" && (LAB_PRESET_IDS as readonly string[]).includes(value);
}
