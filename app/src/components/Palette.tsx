/**
 * The command palette (guideline §6: Cmd/Ctrl + K "to jump to a hand, a
 * player or a report"; R2.8: and to run a command). The shared
 * `CommandPalette` shell (`packages/ui/palette`) draws it; this file supplies
 * what it lists and what a choice does:
 *
 * - **hands** by the number the room printed (the store's `hands_find`, a
 *   prefix match, R2.7a) and **players** by the start of their name (the
 *   store's prefix search, most hands together first, R2.7c) - asked of the
 *   store as the reader types (debounced);
 * - **screens** (each with its Cmd/Ctrl + 1-6 shortcut), the **reports'**
 *   breakdowns (`#/reports/<tab>`, R2.7b), **saved filters** of Hands and
 *   Reports (applied to their screen), the **Settings sections**
 *   (`#/settings/<section>`, the refused hands among them) and the
 *   **commands**: pause or resume import, sync now, the theme, the density
 *   and the language - ranked by the package's fuzzy match (`rankItems`:
 *   "gtrep", "tamna", "compact" all find theirs), with words each command
 *   also answers to;
 * - the **recent** choices (the last five places opened from here, kept in
 *   `localStorage`, a per-reader convenience) when nothing is typed.
 *
 * Keys: Cmd/Ctrl + K opens and closes it from anywhere (the sidebar's search
 * button too), Cmd/Ctrl + 1-6 go to the screens without it; inside, the
 * shell's ↑/↓, Tab, Page Up/Down, Enter and Escape.
 */
import { useEffect, useMemo, useState } from "react";
import { CommandPalette, type PaletteItem } from "@rail/ui/palette/CommandPalette";
import { rankItems } from "@rail/ui/palette/fuzzy";

import { useT, type Dict } from "../i18n";
import { adoptSettings, getAppearance, setAppearance } from "../lib/appearance";
import { inApp, ipc, type Density, type HandRow, type PlayerRow, type SavedFilter, type Theme } from "../lib/ipc";
import { SCREENS, go, type Screen } from "../lib/router";
import { fromSaved, requestFilter, type FilterTarget } from "../screens/hands/filter";
import { playedAt, stakes } from "../screens/hands/format";
import { playerParam } from "../screens/players/param";
import { TABS } from "../screens/reports/Breakdown";
import type { Locale } from "../i18n/types";

/** Hands listed for a query. */
const HAND_RESULTS = 8;
/** Players listed for a query. */
const PLAYER_RESULTS = 6;
/** Typing pauses this long before the store is asked. */
const SEARCH_DEBOUNCE_MS = 120;
/** Recent choices kept. */
const RECENT_MAX = 5;
const RECENT_KEY = "rail.palette.recent";

/** The Settings sections the palette opens (`#/settings/<section>`; ids in `Settings.tsx`). */
export const SETTINGS_SECTIONS = ["account", "folders", "refused", "appearance", "startup", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The platform's modifier as a key cap: ⌘ on a Mac, Ctrl elsewhere. */
export const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";

const OPEN_EVENT = "rail:open-palette";

/** Open the palette (the sidebar's search button). */
export function openPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** A recent choice: its id and the raw words its label is built from (in the current language). */
interface Recent {
  id: string;
  /** A hand's number, a player's name, a saved filter's name. */
  name?: string;
  detail?: string;
}

function readRecent(): Recent[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value)
      ? value
          .filter((entry): entry is Recent => entry !== null && typeof entry === "object" && typeof entry.id === "string")
          .slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

function remember(entry: Recent): void {
  try {
    const next = [entry, ...readRecent().filter((old) => old.id !== entry.id)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // No storage: no recents.
  }
}

/** Mounted once by the app: listens for Cmd/Ctrl + K (and + 1-6) and opens the palette. */
export function Palette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setOpen((was) => !was);
        return;
      }
      const digit = Number(key);
      const screen = Number.isInteger(digit) && digit >= 1 ? SCREENS[digit - 1] : undefined;
      if (screen) {
        event.preventDefault();
        setOpen(false);
        go(screen);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);
  return open ? <PaletteDialog onClose={() => setOpen(false)} /> : null;
}

/** What the app looks like when the palette opens: which commands make sense now. */
interface Context {
  /** `null`: no watcher (outside the app, or it did not start). */
  importPaused: boolean | null;
  syncAvailable: boolean;
  saved: { target: FilterTarget; filter: SavedFilter }[];
}

function useContextOnOpen(): Context {
  const [context, setContext] = useState<Context>({ importPaused: null, syncAvailable: false, saved: [] });
  useEffect(() => {
    if (!inApp) return;
    let current = true;
    ipc
      .watcherStatus()
      .then((status) => {
        if (current && status.running && status.sources.length > 0) {
          setContext((was) => ({ ...was, importPaused: status.paused }));
        }
      })
      .catch(() => undefined);
    ipc
      .syncStatus()
      .then((status) => current && setContext((was) => ({ ...was, syncAvailable: status !== null })))
      .catch(() => undefined);
    Promise.all([ipc.savedFilters("hands"), ipc.savedFilters("reports")])
      .then(([hands, reports]) => {
        if (!current) return;
        setContext((was) => ({
          ...was,
          saved: [
            ...hands.map((filter) => ({ target: "hands" as const, filter })),
            ...reports.map((filter) => ({ target: "reports" as const, filter })),
          ],
        }));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return context;
}

const words = (text: string): string[] => text.split(" ").filter((word) => word !== "");

/** Every item that does not need the store: screens, reports, settings, saved filters, commands. */
function localItems(t: Dict, context: Context): PaletteItem[] {
  const p = t.palette;
  const appearance = getAppearance();
  const items: PaletteItem[] = SCREENS.map((screen, index) => ({
    id: `screen:${screen}`,
    label: p.screen(t.nav[screen]),
    group: p.screens,
    keywords: [t.screens[screen].lead, ...words(p.goTo)],
    shortcut: [MOD_KEY, String(index + 1)],
  }));
  for (const tab of TABS) {
    items.push({
      id: `report:${tab}`,
      label: p.report(t.reports.breakdown.tabs[tab]),
      group: p.reports,
      keywords: [t.nav.reports],
    });
  }
  for (const { target, filter } of context.saved) {
    items.push({
      id: `filter:${target}:${filter.id}`,
      label: p.savedFilter(t.nav[target], filter.name),
      detail: p.savedFilterDetail,
      group: p.savedFilters,
    });
  }
  const command = (id: string, label: string, keywords: string, detail?: string): PaletteItem => ({
    id: `cmd:${id}`,
    label,
    group: p.commands,
    keywords: words(keywords),
    ...(detail === undefined ? {} : { detail }),
  });
  if (context.importPaused !== null) {
    items.push(
      context.importPaused
        ? command("import:resume", p.command.resumeImport, p.keywords.import)
        : command("import:pause", p.command.pauseImport, p.keywords.import),
    );
  }
  if (context.syncAvailable) items.push(command("sync", p.command.syncNow, p.keywords.sync));
  const themes: [Theme, string][] = [
    ["dark", p.command.themeDark],
    ["light", p.command.themeLight],
    ["system", p.command.themeSystem],
  ];
  for (const [theme, label] of themes) {
    items.push(
      command(`theme:${theme}`, label, p.keywords.theme, appearance.theme === theme ? p.command.current : undefined),
    );
  }
  const density: Density = appearance.density === "compact" ? "comfortable" : "compact";
  items.push(command(`density:${density}`, p.command[density], p.keywords.density));
  const other: Locale = appearance.locale === "en" ? "hr" : "en";
  items.push(command(`locale:${other}`, p.command.language, p.keywords.language));
  items.push(command("refused", p.command.refused, p.keywords.refused));
  for (const section of SETTINGS_SECTIONS) {
    items.push({
      id: `settings:${section}`,
      label: p.section(p.sections[section]),
      group: p.settings,
      keywords: words(p.keywords.settings),
    });
  }
  return items;
}

/** A recent choice as an item, its label rebuilt in the current language. */
function recentItem(t: Dict, recent: Recent, local: readonly PaletteItem[]): PaletteItem | null {
  const p = t.palette;
  const [kind] = recent.id.split(":", 1);
  const label =
    kind === "hand" && recent.name !== undefined
      ? p.hand(recent.name)
      : kind === "player" && recent.name !== undefined
        ? p.player(recent.name)
        : (local.find((item) => item.id === recent.id)?.label ?? null);
  if (label === null) return null;
  return { id: recent.id, label, group: p.recent, ...(recent.detail === undefined ? {} : { detail: recent.detail }) };
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const p = t.palette;
  const context = useContextOnOpen();
  const [query, setQuery] = useState("");
  const [hands, setHands] = useState<{ query: string; rows: HandRow[] }>({ query: "", rows: [] });
  const [players, setPlayers] = useState<{ query: string; rows: PlayerRow[] }>({ query: "", rows: [] });
  const [recent] = useState(readRecent);

  const trimmed = query.trim();
  useEffect(() => {
    if (!inApp || trimmed.length === 0) return;
    let current = true;
    const timer = window.setTimeout(() => {
      ipc
        .handsFind(trimmed, HAND_RESULTS)
        .then((rows) => {
          if (current) setHands({ query: trimmed, rows });
        })
        .catch(() => undefined);
      ipc
        .playersList({ search: trimmed, limit: PLAYER_RESULTS })
        .then((list) => {
          if (current) setPlayers({ query: trimmed, rows: list.rows });
        })
        .catch(() => undefined);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [trimmed]);

  const local = useMemo(() => localItems(t, context), [t, context]);
  const busy = inApp && trimmed !== "" && (hands.query !== trimmed || players.query !== trimmed);

  const items = useMemo<PaletteItem[]>(() => {
    if (trimmed === "") {
      const recents = recent
        .map((entry) => recentItem(t, entry, local))
        .filter((item): item is PaletteItem => item !== null);
      const seen = new Set(recents.map((item) => item.id));
      // The screens and the commands; reports and settings are a word away.
      const rest = local.filter((item) => !seen.has(item.id) && (item.group === p.screens || item.group === p.commands));
      return [...recents, ...rest];
    }
    const found: PaletteItem[] =
      hands.query === trimmed
        ? hands.rows.map((row) => ({
            id: `hand:${row.handKey}`,
            label: p.hand(row.siteHandId),
            detail: p.handDetail(row.siteName, stakes(row), playedAt(row.playedAt)),
            group: p.hands,
          }))
        : [];
    const people: PaletteItem[] =
      players.query === trimmed
        ? players.rows.map((row) => ({
            id: `player:${playerParam(row.site, row.player)}`,
            label: p.player(row.player),
            detail: p.playerDetail(row.siteName, row.hands),
            group: p.players,
          }))
        : [];
    // A hand's number is what is typed most: its results first. The ranked
    // local items keep the order of their groups' best match.
    const ranked = rankItems(trimmed, local);
    const groupOrder: string[] = [];
    for (const item of ranked) if (item.group !== undefined && !groupOrder.includes(item.group)) groupOrder.push(item.group);
    const grouped = groupOrder.flatMap((group) => ranked.filter((item) => item.group === group));
    return [...found, ...people, ...grouped];
  }, [trimmed, hands, players, local, recent, t, p]);

  const select = (item: PaletteItem) => {
    const [kind = "", ...rest] = item.id.split(":");
    const value = rest.join(":");
    const keep = (entry: Recent) => remember(entry);
    switch (kind) {
      case "screen":
        go(value as Screen);
        keep({ id: item.id });
        break;
      case "hand": {
        go("hands", value);
        const row = hands.rows.find((r) => r.handKey === value);
        keep({ id: item.id, name: row?.siteHandId ?? value, ...(item.detail ? { detail: item.detail } : {}) });
        break;
      }
      case "player": {
        go("players", value);
        const row = players.rows.find((r) => playerParam(r.site, r.player) === value);
        keep({ id: item.id, name: row?.player ?? value.slice(value.indexOf(":") + 1), ...(item.detail ? { detail: item.detail } : {}) });
        break;
      }
      case "report":
        go("reports", value);
        keep({ id: item.id });
        break;
      case "settings":
        go("settings", value);
        keep({ id: item.id });
        break;
      case "filter": {
        const [target, id] = value.split(":") as [FilterTarget, string];
        const saved = context.saved.find((entry) => entry.target === target && String(entry.filter.id) === id);
        const filter = saved ? fromSaved(saved.filter.filter) : null;
        if (filter) {
          requestFilter(filter, target);
          go(target);
          keep({ id: item.id });
        }
        break;
      }
      case "cmd":
        runCommand(value);
        break;
      default:
    }
    onClose();
  };

  return (
    <CommandPalette
      onClose={onClose}
      label={p.label}
      placeholder={p.placeholder}
      emptyText={p.empty}
      items={items}
      query={query}
      onQueryChange={setQuery}
      onSelect={select}
      busy={busy}
      busyText={p.searching}
      resultsText={p.results}
      keyHints={[
        { keys: ["↑", "↓"], label: p.hints.move },
        { keys: ["↵"], label: p.hints.open },
        { keys: ["Esc"], label: p.hints.close },
      ]}
    />
  );
}

/** A command's effect. The settings ones save first and paint what was saved. */
function runCommand(command: string): void {
  const [what, value] = command.split(":");
  const apply = (change: Promise<Parameters<typeof adoptSettings>[0]>) => {
    change.then(adoptSettings).catch(() => undefined);
  };
  switch (what) {
    case "import":
      if (inApp) ipc.setImportPaused(value === "pause").catch(() => undefined);
      break;
    case "sync":
      if (inApp) ipc.syncNow().catch(() => undefined);
      break;
    case "theme":
      if (inApp) apply(ipc.setTheme(value as Theme));
      else setAppearance({ theme: value as Theme });
      break;
    case "density":
      if (inApp) apply(ipc.setDensity(value as Density));
      else setAppearance({ density: value as Density });
      break;
    case "locale":
      if (inApp) apply(ipc.setLocale(value as Locale));
      else setAppearance({ locale: value as Locale });
      break;
    case "refused":
      go("settings", "refused");
      break;
    default:
  }
}
