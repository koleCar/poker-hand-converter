/**
 * (T7) The Tables screen's Hotkeys card, its pure half
 * (`app/src/screens/tables/hotkeys.ts`): a recorded key-down becomes the
 * binding `rail_hud_ipc::hotkeys` accepts, refused as `check_keys` refuses
 * it, shown with the system's key names, and set in or cleared from the
 * tiling settings without touching the other bindings.
 */
import { describe, expect, it } from "vitest";

import type { TilingSettings } from "../../app/src/lib/ipc.js";
import {
  HOTKEY_ACTIONS,
  bindingOf,
  boundElsewhere,
  keyAllowed,
  keysFromEvent,
  keysLabel,
  keysProblem,
  parseKeys,
  setBinding,
} from "../../app/src/screens/tables/hotkeys.js";

const settings = (hotkeys?: TilingSettings["hotkeys"]): TilingSettings => ({
  enabled: true,
  active: { kind: "auto" },
  layouts: [],
  autoSwitch: [],
  closeGaps: false,
  perRoom: {},
  ...(hotkeys === undefined ? {} : { hotkeys }),
});

const press = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe("recording a key", () => {
  it("names the modifiers in order, then the key's code", () => {
    expect(keysFromEvent(press("KeyR", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+KeyR");
    expect(keysFromEvent(press("Digit1", { metaKey: true, shiftKey: true, ctrlKey: true, altKey: true }))).toBe(
      "Ctrl+Alt+Shift+Super+Digit1",
    );
    expect(keysFromEvent(press("F5"))).toBe("F5");
  });

  it("waits past a modifier pressed alone", () => {
    for (const code of ["ControlLeft", "AltRight", "ShiftLeft", "MetaLeft", ""]) {
      expect(keysFromEvent(press(code, { ctrlKey: true }))).toBeNull();
    }
  });
});

describe("checking keys as check_keys does", () => {
  it("accepts", () => {
    for (const keys of ["Ctrl+Alt+KeyR", "Alt+Shift+Digit1", "Super+ArrowRight", "F5", "Shift+F13", "Ctrl+KeyR", "Ctrl+Shift+KeyC", "Ctrl+F4", "Alt+NumpadAdd"]) {
      expect(keysProblem(keys), keys).toBeNull();
    }
  });

  it("refuses", () => {
    expect(keysProblem("KeyR")).toBe("needsModifier");
    expect(keysProblem("Shift+KeyR")).toBe("needsModifier");
    expect(keysProblem("Ctrl+KeyC")).toBe("reserved");
    expect(keysProblem("Super+KeyQ")).toBe("reserved");
    expect(keysProblem("Alt+F4")).toBe("reserved");
    for (const keys of ["", "Ctrl+Alt+Escape", "Ctrl+Alt+Tab", "Alt+Ctrl+KeyR", "Ctrl+Ctrl+KeyR", "Ctrl+Alt+F25", "Ctrl+Alt+F05", "Meta+KeyR", "Ctrl+Alt"]) {
      expect(keysProblem(keys), keys).toBe("notAKey");
    }
    expect(keyAllowed("Escape")).toBe(false);
    expect(parseKeys("Ctrl+Shift+F2")).toEqual({ modifiers: ["Ctrl", "Shift"], key: "F2" });
  });
});

describe("showing keys", () => {
  it("as a Mac and a PC name them", () => {
    expect(keysLabel("Ctrl+Alt+Shift+Super+KeyR", true)).toBe("⌃⌥⇧⌘R");
    expect(keysLabel("Ctrl+Alt+Shift+Super+KeyR", false)).toBe("Ctrl+Alt+Shift+Win+R");
    expect(keysLabel("Alt+ArrowRight", false)).toBe("Alt+→");
    expect(keysLabel("Ctrl+Numpad3", false)).toBe("Ctrl+Num 3");
    expect(keysLabel("F5", true)).toBe("F5");
  });
});

describe("the settings' bindings", () => {
  it("are none in an older row and set, replaced and cleared in place", () => {
    const old = settings();
    expect(bindingOf(old, "retile")).toBeNull();
    const one = setBinding(old, "retile", "Ctrl+Alt+KeyR");
    expect(one.hotkeys).toEqual([{ action: "retile", keys: "Ctrl+Alt+KeyR" }]);
    const kept = settings([
      { action: "retile", keys: "F5" },
      { action: "unknown", keys: "F9" },
      { action: "toggleTiling", keys: "F6" },
    ]);
    const changed = setBinding(kept, "retile", "F7");
    expect(changed.hotkeys?.map((b) => b.action)).toEqual(["retile", "unknown", "toggleTiling"]);
    expect(bindingOf(changed, "retile")).toBe("F7");
    expect(setBinding(kept, "toggleTiling", null).hotkeys).toEqual([
      { action: "retile", keys: "F5" },
      { action: "unknown", keys: "F9" },
    ]);
    expect(boundElsewhere(kept, "nextLayout", "F9")).toBe("unknown");
    expect(boundElsewhere(kept, "retile", "F5")).toBeNull();
    expect(boundElsewhere(kept, "nextLayout", "F5")).toBe("retile");
    expect(HOTKEY_ACTIONS).toEqual(["retile", "nextLayout", "previousLayout", "toggleTiling", "rollRng"]);
  });
});
