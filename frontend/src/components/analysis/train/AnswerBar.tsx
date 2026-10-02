/**
 * The answers to a spot, as big buttons with their key: `1`…`9` in order,
 * plus the letter of a fold, check, call or all-in. The key is printed on the
 * button and announced through `aria-keyshortcuts`; the map itself lives in
 * `trainerKeys.ts`.
 */

"use client";

import { useDict } from "../../../lib/i18n/client";
import own from "./train.module.css";

export interface AnswerOption {
  label: string;
  /** Fold / check / call / all-in get a letter as well as their number. */
  alias?: "fold" | "check" | "call" | "allin" | null;
}

const LETTER: Record<string, string> = { fold: "F", check: "X", call: "C", allin: "A" };

interface AnswerBarProps {
  options: readonly AnswerOption[];
  /** The answer given, once it is. */
  picked: number | null;
  disabled: boolean;
  onPick: (index: number) => void;
}

export function AnswerBar({ options, picked, disabled, onPick }: AnswerBarProps) {
  const t = useDict().analysis.train;
  return (
    <div className={own.answers} role="group" aria-label={t.answersLabel}>
      {options.map((option, index) => {
        const keys = [String(index + 1), option.alias ? LETTER[option.alias] : null].filter(Boolean) as string[];
        return (
          <button
            key={index}
            type="button"
            className={`btn ${own.answer}`}
            data-picked={picked === index || undefined}
            aria-keyshortcuts={keys.join(" ")}
            disabled={disabled}
            onClick={() => onPick(index)}
          >
            <span className={own.answerLabel}>{option.label}</span>
            <span className={own.answerKeys} aria-hidden="true">
              {keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}
