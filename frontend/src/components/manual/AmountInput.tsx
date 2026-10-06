"use client";

import { useState } from "react";
import type { Amount, CurrencyUnit } from "../../lib/phf/types";
import { amountText, parseAmountText, type AmountMode } from "./editorState";
import styles from "./manual.module.css";

interface AmountInputProps {
  value: Amount;
  onChange: (value: Amount) => void;
  mode: AmountMode;
  unit: CurrencyUnit;
  bigBlind: Amount;
  label?: string;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
}

/**
 * A number field for an amount, in big blinds or in the game's unit.
 *
 * While the field has focus it shows exactly what was typed (so "2." or an
 * empty field survives a keystroke); otherwise it shows the stored amount,
 * which is the only state there is. No effect syncs the two.
 */
export function AmountInput({ value, onChange, mode, unit, bigBlind, label, id, disabled, invalid }: AmountInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const suffix = mode === "bb" && bigBlind > 0 ? "bb" : unit.symbol || unit.code.toLowerCase();
  return (
    <span className={`${styles.amount} ${invalid ? styles.amountInvalid : ""}`}>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        value={draft ?? amountText(value, mode, unit, bigBlind)}
        onFocus={(event) => {
          setDraft(event.target.value);
          event.target.select();
        }}
        onBlur={() => setDraft(null)}
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = parseAmountText(event.target.value, mode, unit, bigBlind);
          if (parsed !== null) onChange(parsed);
        }}
      />
      <span className={styles.amountSuffix} aria-hidden="true">
        {suffix}
      </span>
    </span>
  );
}
