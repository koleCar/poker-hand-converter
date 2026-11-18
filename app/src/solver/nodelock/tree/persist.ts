/**
 * What My nodelocks' tree remembers on this computer (§7.1): the open
 * folders and locks, the column's width, and whether it is hidden. A webview
 * without storage forgets them; nothing else depends on them.
 */

const OPEN_KEY = "rail.nodelockTree.open";
const WIDTH_KEY = "rail.nodelockTree.width";
const HIDDEN_KEY = "rail.nodelockTree.hidden";

export const TREE_WIDTH = { min: 200, max: 520, initial: 260 };

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // No storage: kept for this window only.
  }
}

export function readOpen(): Set<string> {
  try {
    const value: unknown = JSON.parse(read(OPEN_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeOpen(open: ReadonlySet<string>): void {
  write(OPEN_KEY, JSON.stringify([...open]));
}

export function clampWidth(width: number): number {
  return Math.round(Math.min(TREE_WIDTH.max, Math.max(TREE_WIDTH.min, width)));
}

export function readWidth(): number {
  const width = Number(read(WIDTH_KEY));
  return Number.isFinite(width) && width > 0 ? clampWidth(width) : TREE_WIDTH.initial;
}

export function writeWidth(width: number): void {
  write(WIDTH_KEY, String(clampWidth(width)));
}

export function readHidden(): boolean {
  return read(HIDDEN_KEY) === "1";
}

export function writeHidden(hidden: boolean): void {
  write(HIDDEN_KEY, hidden ? "1" : "0");
}
