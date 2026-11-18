/**
 * (2026-11-18) Whether the user hid the analysis progress under the
 * Analysis tabs: kept in this window's storage, the same for every tab.
 * Hidden, the tabs row keeps one small button that shows it again.
 */
import { useSyncExternalStore } from "react";

const KEY = "rail.analysis.progressHidden";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let hidden = typeof window === "undefined" ? false : read();

export function setProgressHidden(value: boolean): void {
  hidden = value;
  try {
    window.localStorage.setItem(KEY, value ? "1" : "0");
  } catch {
    // Not kept: hidden for this run only.
  }
  for (const listener of listeners) listener();
}

export function useProgressHidden(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => hidden,
    () => false,
  );
}
