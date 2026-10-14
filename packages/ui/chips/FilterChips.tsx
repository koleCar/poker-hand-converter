import { Chip } from "./Chip";
import styles from "./FilterChips.module.css";

export interface FilterChipOption<T extends string> {
  value: T;
  /** What the chip says, in the reader's language (or a label that is not prose, like "BTN"). */
  label: string;
}

export interface FilterChipsProps<T extends string> {
  /** The group's accessible name ("Position"). */
  label: string;
  options: readonly FilterChipOption<T>[];
  /** The values switched on; the order of `options` is kept on change. */
  selected: readonly T[];
  onChange: (next: T[]) => void;
  /** A last chip that clears the group while anything is on. Omit for none. */
  clearLabel?: string;
}

/**
 * One filter as a row of toggle chips (guideline §6: "filters as chips in one
 * row ... instead of long dialogs"): any number on, none on means "any". The
 * row stays one line and scrolls sideways when it does not fit, so a filter
 * bar made of several of these never wraps into a dialog.
 */
export function FilterChips<T extends string>({ label, options, selected, onChange, clearLabel }: FilterChipsProps<T>) {
  const on = new Set<T>(selected);
  const toggle = (value: T) => {
    const next = new Set(on);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    onChange(options.map((option) => option.value).filter((v) => next.has(v)));
  };

  return (
    <div role="group" aria-label={label} className={styles.row}>
      {options.map((option) => (
        <Chip key={option.value} pressed={on.has(option.value)} onClick={() => toggle(option.value)}>
          {option.label}
        </Chip>
      ))}
      {clearLabel !== undefined && selected.length > 0 ? (
        <Chip className={styles.clear} onClick={() => onChange([])}>
          {clearLabel}
        </Chip>
      ) : null}
    </div>
  );
}
