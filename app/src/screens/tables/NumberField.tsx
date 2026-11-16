import styles from "./Tables.module.css";

/** A whole number typed in, kept within `min` - `max`, saved when the field is left (or Enter). */
export function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const commit = (text: string) => {
    const n = Math.round(Number(text));
    if (!Number.isFinite(n) || text.trim() === "") return;
    const clamped = Math.min(max, Math.max(min, n));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      type="number"
      className={`${styles.input} ${styles.number}`}
      aria-label={label}
      defaultValue={value}
      min={min}
      max={max}
      step={1}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
