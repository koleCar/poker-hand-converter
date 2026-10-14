/**
 * The package's view of the hand model: PHF (`docs/PHF-SPEC.md`).
 *
 * `model/` is the only place `@rail/ui` reaches outside itself. The
 * pure-TypeScript library under `frontend/src/lib/` is the one TypeScript
 * implementation of the hand model, the replay frames, the cards and the
 * statistics definitions - `tests/`, the Rust parity vectors and both
 * surfaces build on the same files - so the package imports it here rather
 * than copying it. It is framework-free by lint rule (docs/WEB.md, "The
 * pure-TypeScript layer may not import the framework"), which is what makes it
 * safe to bundle into the desktop app too. When the web moves to `web/`
 * (R0.14), these four paths are the ones that change.
 */
export * from "../../../frontend/src/lib/phf/types";
