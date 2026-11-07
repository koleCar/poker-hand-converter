import styles from "./Settings.module.css";

/**
 * A switch: a real checkbox (`role="switch"`), so the keyboard, the label
 * and a screen reader treat it as one; `Settings.module.css` draws it.
 */
export function Toggle({
  id,
  checked,
  disabled = false,
  label,
  onChange,
}: {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  /** Its name, when no `<label htmlFor={id}>` gives it one. */
  label?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      className={styles.switch}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
