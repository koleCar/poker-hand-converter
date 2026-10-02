/**
 * The trainer's keyboard map, written down once — the replayer's pattern
 * (`replayer/shortcuts.ts`): `useTrainerKeys` implements it and
 * `TrainerKeySheet` prints it.
 *
 * The keys listen on the page, not on one element, so a player can answer
 * without first tabbing to the buttons; they stay out of the way of
 * everything that has keys of its own: form fields, the replayer (its own
 * map, scoped to its root), and modifier combinations the browser owns.
 * Enter is only "next" when focus is not on something Enter already
 * activates.
 */

"use client";

import { useEffect, useRef } from "react";
import type { Dict } from "../../../lib/i18n/types";

export type TrainerKeyId = keyof Dict["analysis"]["train"]["keys"]["items"];

export interface TrainerShortcut {
  keys: string[];
  id: TrainerKeyId;
}

export const TRAINER_SHORTCUTS: TrainerShortcut[] = [
  { keys: ["1", "…", "9"], id: "options" },
  { keys: ["F"], id: "fold" },
  { keys: ["X"], id: "check" },
  { keys: ["C"], id: "call" },
  { keys: ["A"], id: "allin" },
  { keys: ["N", "Enter"], id: "next" },
  { keys: ["?"], id: "help" },
];

export interface TrainerKeyHandlers {
  /** Answers are open: digits and letters pick. */
  answering: boolean;
  /** Number of options; digit `n` picks option `n − 1`. */
  options: number;
  /** Index of the fold / check / call / all-in option, when there is one. */
  aliases: Partial<Record<"fold" | "check" | "call" | "allin", number>>;
  onPick: (index: number) => void;
  /** Null while there is nothing to go on to. */
  onNext: (() => void) | null;
  onHelp: () => void;
}

const LETTERS: Record<string, "fold" | "check" | "call" | "allin"> = { f: "fold", x: "check", c: "call", a: "allin" };

function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".rp, [role='dialog'], dialog")) return true;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/** Wires the map to `window` for as long as the component is mounted. */
export function useTrainerKeys(handlers: TrainerKeyHandlers): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (ownsKeys(event.target)) return;
      const h = latest.current;
      const key = event.key;
      if (key === "?") {
        event.preventDefault();
        h.onHelp();
        return;
      }
      if (h.answering) {
        if (/^[1-9]$/.test(key)) {
          const index = Number(key) - 1;
          if (index < h.options) {
            event.preventDefault();
            h.onPick(index);
          }
          return;
        }
        const alias = LETTERS[key.toLowerCase()];
        const index = alias ? h.aliases[alias] : undefined;
        if (index !== undefined) {
          event.preventDefault();
          h.onPick(index);
        }
        return;
      }
      if (!h.onNext) return;
      const interactive = event.target instanceof Element && event.target.closest("button, a, summary, [role='button']");
      if (key.toLowerCase() === "n" || (key === "Enter" && !interactive)) {
        event.preventDefault();
        h.onNext();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
