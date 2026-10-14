import type { ButtonHTMLAttributes } from "react";

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "aria-pressed"> {
  /**
   * A toggle chip's state: `aria-pressed` and the active look (`is-active`).
   * Leave it out for an action chip ("clear"), which has no state.
   */
  pressed?: boolean | undefined;
  /** Modifiers from the surface, after the base class: `chip-btn--pos`. */
  className?: string | undefined;
}

/**
 * One chip: the pill-shaped toggle of a filter row and of the replayer's
 * transport (street, speed, log). The look is the global `.chip-btn` family in
 * `styles/controls.css`, so the markup is exactly what the web wrote by hand
 * before the package existed: `<button type="button" class="chip-btn
 * [modifiers] [is-active]" aria-pressed>`.
 */
export function Chip({ pressed, className, children, ...rest }: ChipProps) {
  const classes = ["chip-btn", className, pressed ? "is-active" : null].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} aria-pressed={pressed} {...rest}>
      {children}
    </button>
  );
}
