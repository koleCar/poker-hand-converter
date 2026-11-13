/**
 * The app's door to the web's Trainer (`web/src/components/trainer`), used
 * **in place** through the `@rail/web-trainer` alias, as the Solver library
 * is through `@rail/web-solver` (`src/solver/door.ts`). The components are
 * host-neutral (`host.tsx`): they take their words, their deal and grade,
 * the player's leaks and where settings are kept from the page, so nothing
 * of Next, the web's i18n or Supabase comes in. The worker's side (the pure
 * jobs) has its own door, `jobs.ts`, so the worker bundles no React. ESLint
 * keeps every other app file away from both aliases.
 */
export { Trainer } from "@rail/web-trainer/Trainer";
export { TrainerHostProvider, type FocusState, type TrainerDict, type TrainerHost } from "@rail/web-trainer/host";
export { parseSettings, settingsFields, type SpotRequest, type TrainerSettings } from "@rail/web-trainer/settings";
export { trainerEn } from "@rail/web-lib/i18n/ns/trainer.en";
export { trainerHr } from "@rail/web-lib/i18n/ns/trainer.hr";
export { focusAreas } from "@rail/web-lib/training/plan";
export type { GradedAnswer, PlayOptions, PlayStep, TrainerSpot, TrainingRequest, TrainingResponse } from "@rail/web-lib/training";
