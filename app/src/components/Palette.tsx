/**
 * The command palette (guideline §6: Cmd/Ctrl + K "to jump to a hand, a
 * player or a report"). R2.7a wires the shared `CommandPalette` shell to the
 * screens and to "go to hand" by the number the room printed (the local
 * store's `hands_find`: an index on the room's id, a prefix match); the
 * reports' breakdowns are listed by name (R2.7b: `#/reports/<tab>`); players
 * join it with their screen, the rest of its features in R2.8.
 */
import { useEffect, useMemo, useState } from "react";
import { CommandPalette, type PaletteItem } from "@rail/ui/palette/CommandPalette";

import { useT } from "../i18n";
import { inApp, ipc, type HandRow } from "../lib/ipc";
import { SCREENS, go, type Screen } from "../lib/router";
import { playedAt, stakes } from "../screens/hands/format";
import { TABS } from "../screens/reports/Breakdown";

/** Hands listed for a query. */
const HAND_RESULTS = 8;
/** Typing pauses this long before the store is asked. */
const SEARCH_DEBOUNCE_MS = 120;

/** Mounted once by the app: listens for Cmd/Ctrl + K and opens the palette. */
export function Palette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((was) => !was);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return open ? <PaletteDialog onClose={() => setOpen(false)} /> : null;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [hands, setHands] = useState<{ query: string; rows: HandRow[] }>({ query: "", rows: [] });

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
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [trimmed]);

  const items = useMemo<PaletteItem[]>(() => {
    const needle = trimmed.toLowerCase();
    const screens: PaletteItem[] = SCREENS.map((screen) => ({ screen, name: t.nav[screen] }))
      .filter(({ name }) => needle === "" || name.toLowerCase().includes(needle))
      .map(({ screen, name }) => ({ id: `screen:${screen}`, label: t.palette.screen(name), group: t.palette.screens }));
    const found: PaletteItem[] =
      hands.query === trimmed && trimmed !== ""
        ? hands.rows.map((row) => ({
            id: `hand:${row.handKey}`,
            label: t.palette.hand(row.siteHandId),
            detail: t.palette.handDetail(row.siteName, stakes(row), playedAt(row.playedAt)),
            group: t.palette.hands,
          }))
        : [];
    const reports: PaletteItem[] =
      needle === ""
        ? []
        : TABS.map((tab) => ({ tab, name: t.reports.breakdown.tabs[tab] }))
            .filter(({ name }) => name.toLowerCase().includes(needle) || t.nav.reports.toLowerCase().includes(needle))
            .map(({ tab, name }) => ({ id: `report:${tab}`, label: t.palette.report(name), group: t.palette.reports }));
    // A hand's number is what is typed most: its results first.
    return found.concat(screens, reports);
  }, [trimmed, hands, t]);

  const select = (item: PaletteItem) => {
    if (item.id.startsWith("screen:")) {
      go(item.id.slice("screen:".length) as Screen);
    } else if (item.id.startsWith("hand:")) {
      go("hands", item.id.slice("hand:".length));
    } else if (item.id.startsWith("report:")) {
      go("reports", item.id.slice("report:".length));
    }
    onClose();
  };

  return (
    <CommandPalette
      onClose={onClose}
      label={t.palette.label}
      placeholder={t.palette.placeholder}
      emptyText={t.palette.empty}
      items={items}
      query={query}
      onQueryChange={setQuery}
      onSelect={select}
    />
  );
}
