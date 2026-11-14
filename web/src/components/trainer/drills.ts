/**
 * Saved drills (T4): the player's own presets of the Trainer's settings,
 * named ("BB vs BTN, flop, facing a bet"), kept in this browser or this
 * computer's app and opened from the settings sheet - GTO Wizard's *My
 * drills*, for one device. Pure apart from the storage, which may fail
 * (private mode): then nothing is kept and nothing breaks.
 */

import { parseSettings, settingsFields, type TrainerSettings } from "./settings";

export interface Drill {
  id: string;
  name: string;
  /** The settings that differ from the default (`settingsFields`). */
  fields: Record<string, string>;
}

const KEY = "rail.trainer.drills";
export const MAX_DRILLS = 30;

export function parseDrills(raw: unknown): Drill[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is Drill => Boolean(d) && typeof d.id === "string" && typeof d.name === "string" && typeof d.fields === "object" && d.fields !== null)
    .map((d) => ({ id: d.id, name: d.name.slice(0, 60), fields: settingsFields(parseSettings(d.fields)) }))
    .slice(0, MAX_DRILLS);
}

export function readDrills(): Drill[] {
  try {
    return parseDrills(JSON.parse(window.localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function write(drills: readonly Drill[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(drills));
  } catch {
    // No storage: the list lives for the visit.
  }
}

/** The list with a drill for these settings saved first (a drill of the same name replaced). */
export function withDrill(drills: readonly Drill[], name: string, settings: TrainerSettings, id: string): Drill[] {
  const clean = name.trim().slice(0, 60);
  if (!clean) return [...drills];
  const drill: Drill = { id, name: clean, fields: settingsFields(settings) };
  return [drill, ...drills.filter((d) => d.name !== clean)].slice(0, MAX_DRILLS);
}

export function saveDrills(drills: readonly Drill[]): void {
  write(drills);
}

/** A drill's settings over the player's own (how it trains - pause, panels - comes with the drill too). */
export function drillSettings(drill: Drill): TrainerSettings {
  return parseSettings(drill.fields);
}
