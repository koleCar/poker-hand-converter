/**
 * (T7) Table tiling's global hotkeys, the window's half: a key pressed
 * while recording turned into a binding (`Ctrl+Alt+Shift+Super+<code>`,
 * the modifiers in that order, then the `KeyboardEvent.code`), checked as
 * `rail_hud_ipc::hotkeys::check_keys` / `check` check it, shown with the
 * system's own key names, and set in or cleared from `TilingSettings`.
 * Pure, so the tests run it (`tests/test/appTableHotkeys.test.ts`).
 */
import type { HotkeyAction, HotkeyBinding, TilingSettings } from "../../lib/ipc";

/** An action this build runs (not a newer build's). */
export type KnownHotkeyAction = Exclude<HotkeyAction, "unknown">;

/** The actions the Hotkeys card lists, in order (`HotkeyAction::ALL`). */
export const HOTKEY_ACTIONS: readonly KnownHotkeyAction[] = ["retile", "nextLayout", "previousLayout", "toggleTiling", "rollRng"];

/** Bindings at most (`MAX_HOTKEYS`). */
export const MAX_HOTKEYS = 16;

/** The modifiers, in the order a binding names them. */
export const MODIFIERS = ["Ctrl", "Alt", "Shift", "Super"] as const;
type Modifier = (typeof MODIFIERS)[number];

const OTHER_KEYS: ReadonlySet<string> = new Set([
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "Delete",
  "Space",
  "Backquote",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
]);

/** The modifier keys themselves (`KeyboardEvent.code`): a recording waits past them. */
const MODIFIER_CODES: ReadonlySet<string> = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "CapsLock",
  "Fn",
]);

/** `F1` - `F24`: its number. */
function functionKey(code: string): number | null {
  const match = /^F([1-9]\d?)$/.exec(code);
  if (match === null) return null;
  const n = Number(match[1]);
  return n >= 1 && n <= 24 ? n : null;
}

/** A key a binding may end with (`key_allowed`). */
export function keyAllowed(code: string): boolean {
  return /^Key[A-Z]$/.test(code) || /^(Digit|Numpad)\d$/.test(code) || functionKey(code) !== null || OTHER_KEYS.has(code);
}

/** Why a binding's keys are refused (`check_keys`), or `null`. */
export type KeysProblem = "notAKey" | "needsModifier" | "reserved";

/** A binding's keys split, or `null` when they are not in the binding's form. */
export function parseKeys(keys: string): { modifiers: Modifier[]; key: string } | null {
  const parts = keys.split("+");
  const key = parts.pop();
  if (key === undefined || !keyAllowed(key)) return null;
  let last = -1;
  const modifiers: Modifier[] = [];
  for (const part of parts) {
    const place = (MODIFIERS as readonly string[]).indexOf(part);
    if (place <= last) return null;
    last = place;
    modifiers.push(MODIFIERS[place]);
  }
  return { modifiers, key };
}

/** What `check_keys` says of `keys`. */
export function keysProblem(keys: string): KeysProblem | null {
  const parsed = parseKeys(keys);
  if (parsed === null) return "notAKey";
  const { modifiers, key } = parsed;
  const has = (m: Modifier) => modifiers.includes(m);
  if (functionKey(key) === null && !(has("Ctrl") || has("Alt") || has("Super"))) return "needsModifier";
  const lone = modifiers.length === 1 && (has("Ctrl") || has("Super"));
  if (lone && ["KeyA", "KeyC", "KeyQ", "KeyS", "KeyV", "KeyW", "KeyX", "KeyY", "KeyZ"].includes(key)) return "reserved";
  if (modifiers.length === 1 && has("Alt") && key === "F4") return "reserved";
  return null;
}

/** The keys a recording's key-down makes, or `null` while only modifiers are down. */
export function keysFromEvent(event: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  if (event.code === "" || MODIFIER_CODES.has(event.code)) return null;
  const down: Modifier[] = [];
  if (event.ctrlKey) down.push("Ctrl");
  if (event.altKey) down.push("Alt");
  if (event.shiftKey) down.push("Shift");
  if (event.metaKey) down.push("Super");
  return [...down, event.code].join("+");
}

/** The settings' bindings (none in an older build's row). */
export function bindings(settings: TilingSettings): HotkeyBinding[] {
  return settings.hotkeys ?? [];
}

/** The keys bound to `action`, or `null`. */
export function bindingOf(settings: TilingSettings, action: HotkeyAction): string | null {
  return bindings(settings).find((b) => b.action === action)?.keys ?? null;
}

/** The other action already bound to `keys` (a newer build's counts too), or `null`. */
export function boundElsewhere(settings: TilingSettings, action: HotkeyAction, keys: string): HotkeyAction | null {
  return bindings(settings).find((b) => b.keys === keys && b.action !== action)?.action ?? null;
}

/** `action` bound to `keys`, or cleared (`null`); every other binding kept in its place. */
export function setBinding(settings: TilingSettings, action: HotkeyAction, keys: string | null): TilingSettings {
  const list = bindings(settings);
  const at = list.findIndex((b) => b.action === action);
  const next = list.filter((b) => b.action !== action);
  if (keys !== null) {
    next.splice(at === -1 ? next.length : at, 0, { action, keys });
  }
  return { ...settings, hotkeys: next };
}

/** Whether the window runs on a Mac (the key names it shows). */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MAC_MODIFIERS: Record<Modifier, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Super: "⌘" };
const PC_MODIFIERS: Record<Modifier, string> = { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Win" };

const KEY_NAMES: Record<string, string> = {
  NumpadAdd: "Num +",
  NumpadSubtract: "Num −",
  NumpadMultiply: "Num ×",
  NumpadDivide: "Num ÷",
  NumpadDecimal: "Num .",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "Page Up",
  PageDown: "Page Down",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** The key's name as a keyboard shows it. */
export function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  return KEY_NAMES[code] ?? code;
}

/** `keys` as the system names them: `⌃⌥R` on a Mac, `Ctrl+Alt+R` elsewhere. */
export function keysLabel(keys: string, mac: boolean = IS_MAC): string {
  const parsed = parseKeys(keys);
  if (parsed === null) return keys;
  const names = mac ? MAC_MODIFIERS : PC_MODIFIERS;
  const mods = parsed.modifiers.map((m) => names[m]);
  return mac ? [...mods, keyName(parsed.key)].join("") : [...mods, keyName(parsed.key)].join("+");
}
