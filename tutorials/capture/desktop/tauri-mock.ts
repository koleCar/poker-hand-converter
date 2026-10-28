// The desktop app without Tauri: an init script that makes `@tauri-apps/api`
// believe it runs inside the app and answers the IPC commands the screens
// call with the demo data of `mock-data.ts`.
//
// How `@tauri-apps/api` 2 reaches the Rust side (app/node_modules/@tauri-apps/
// api/core.js, event.js): `isTauri()` reads `globalThis.isTauri`; `invoke()`
// calls `window.__TAURI_INTERNALS__.invoke(cmd, args)`; `listen()` turns the
// handler into a callback id (`__TAURI_INTERNALS__.transformCallback`) and
// invokes `plugin:event|listen`; unlistening calls
// `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener` and
// `plugin:event|unlisten`. The app checks `isTauri()` once
// (`app/src/lib/ipc.ts` `inApp`), so the script must run before the app's
// modules: Playwright's `addInitScript` does.
//
// The page gets `window.__railMock`: `scene(name)` switches what the commands
// answer (first run, after the import, the HUD at tables...) and announces
// the change the way the Rust side does (`watcher-changed`, `account-changed`,
// ...); `set(patch)` changes one part; `emit(event, payload)` sends an event;
// `unknown` lists the commands nobody answered (logged as `[rail-mock]`).
//
// The mock lives here, never in `app/src`: the app is captured as it ships.

import type { BrowserContext } from 'playwright';

import { buildMockData, type MockData, type SceneName } from './mock-data.ts';
import type {
  AccountStatus,
  DesignProblem,
  HudCheck,
  HudDesign,
  HudPreview,
  HudRestrictions,
  PreviewItem,
  PreviewRect,
  StatTone,
} from './ipc-types.ts';

export interface MockOptions {
  /** The scene the page starts in. */
  scene: SceneName;
  /** The data; built once per capture run (`buildMockData()`). */
  data?: MockData;
}

/** The page's `window.__railMock`. */
export interface RailMock {
  scene(name: SceneName): void;
  set(patch: Record<string, unknown>): void;
  emit(event: string, payload?: unknown): void;
  unknown: string[];
  calls: string[];
}

/** Install the mock in every page of `context` (before any of the app's code runs). */
export async function addTauriMock(context: BrowserContext, options: MockOptions): Promise<MockData> {
  const data = options.data ?? buildMockData();
  await context.addInitScript(installTauriMock, { data, scene: options.scene });
  return data;
}

/**
 * Runs in the page, serialised by Playwright: self-contained, nothing from
 * this module's scope. (Node strips the types before Playwright reads the
 * function's source, so it arrives as plain JavaScript.)
 */
export function installTauriMock({ data, scene: firstScene }: { data: MockData; scene: SceneName }): void {
  type Json = unknown;
  const w = window as unknown as Record<string, unknown>;
  const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

  // The theme the settings hold, painted before the first frame (`public/appearance.js` reads this copy).
  try {
    localStorage.setItem('rail.appearance', JSON.stringify({ theme: 'dark', density: 'comfortable', locale: 'en' }));
  } catch {
    /* no storage */
  }

  /* ---------------------------------------------------------- state - */

  let sceneName: SceneName = firstScene;
  const state = {
    scene: clone(data.scenes[firstScene]),
    watched: new Set<string>(),
    importPaused: false,
    syncPaused: false,
    designs: clone(data.hudEditor.designs),
    assignments: clone(data.hudEditor.assignments),
    notes: clone(data.annotations),
    words: {} as Record<string, { colour: string | null; note: string; labels: string[] }>,
  };

  /* --------------------------------------------------------- events - */

  const callbacks = new Map<number, (payload: unknown) => void>();
  let nextCallback = 1;
  const listeners = new Map<string, { eventId: number; handler: number }[]>();
  let nextEvent = 1;

  const emit = (event: string, payload: unknown = null) => {
    for (const listener of listeners.get(event) ?? []) {
      callbacks.get(listener.handler)?.({ event, id: listener.eventId, payload });
    }
  };

  /* --------------------------------------------------------- the HUD - */

  const rulesOf = (site: string): HudRestrictions | null =>
    data.hudEditor.rooms.find((room) => room.id === site)?.restrictions ?? null;
  const statOf = (id: string) => data.hudEditor.stats.find((stat) => stat.id === id);

  const checkForRoom = (design: HudDesign, rules: HudRestrictions): DesignProblem[] => {
    const out: DesignProblem[] = [];
    if (rules.noGameStateSwitching) {
      for (const cell of design.cells) if (cell.when) out.push({ code: 'gameStateSwitching', stat: cell.stat });
    }
    if (rules.maxColourThresholds !== null) {
      for (const cell of design.cells) {
        const stat = statOf(cell.stat);
        if (!stat) continue;
        const bands = design.overrides?.[cell.stat]?.bands ?? stat.bands;
        const count = Math.min(Math.max(0, bands.length - 1), design.maxColourThresholds ?? Infinity);
        if (count > rules.maxColourThresholds) {
          out.push({ code: 'colourThresholds', stat: cell.stat, count, max: rules.maxColourThresholds });
        }
      }
    }
    if (rules.noPlayerLabels && design.playerLabels) out.push({ code: 'labels' });
    return out;
  };

  const designProblems = (design: HudDesign): DesignProblem[] => {
    const out: DesignProblem[] = [];
    if (design.cells.length === 0) out.push({ code: 'noCells' });
    if (design.cells.length > data.hudEditor.limits.maxCells) out.push({ code: 'tooManyCells' });
    if (design.name.length > 60) out.push({ code: 'nameTooLong' });
    return out;
  };

  const check = (design: HudDesign): HudCheck => {
    const rooms: Record<string, DesignProblem[]> = {};
    for (const room of data.hudEditor.rooms) {
      const problems = checkForRoom(design, room.restrictions);
      if (problems.length > 0) rooms[room.id] = problems;
    }
    return { problems: designProblems(design), rooms };
  };

  // `rail_hud::layout`'s simulator table: seat slots in thousandths of the client area.
  const SLOTS: Record<number, [number, number][]> = {
    2: [[500, 840], [500, 240]],
    3: [[500, 840], [145, 390], [855, 390]],
    4: [[500, 840], [90, 540], [500, 240], [910, 540]],
    5: [[500, 840], [110, 633], [259, 297], [741, 297], [890, 633]],
    6: [[500, 840], [145, 690], [145, 390], [500, 240], [855, 390], [855, 690]],
    7: [[500, 840], [179, 727], [100, 473], [322, 270], [678, 270], [900, 473], [821, 727]],
    8: [[500, 840], [210, 752], [90, 540], [210, 328], [500, 240], [790, 328], [910, 540], [790, 752]],
    9: [[500, 840], [236, 770], [96, 592], [145, 390], [360, 258], [640, 258], [855, 390], [904, 592], [764, 770]],
    10: [[500, 840], [259, 783], [110, 633], [110, 447], [259, 297], [500, 240], [741, 297], [890, 447], [890, 633], [741, 783]],
  };
  const PANEL: [number, number, number, number] = [16, 20, 26, 224];
  const TONES: Record<StatTone | 'none', [number, number, number, number]> = {
    'very-low': [76, 140, 255, 255],
    low: [120, 186, 255, 255],
    normal: [236, 239, 243, 255],
    high: [255, 176, 84, 255],
    'very-high': [255, 104, 104, 255],
    none: [160, 168, 180, 255],
  };

  /** The design at a made-up table: the HUD renderer's scene, approximated (`hud_editor::preview`). */
  const preview = (design: HudDesign, site: string, size: number): HudPreview => {
    const width = 800;
    const height = 600;
    const rules = rulesOf(site);
    const slots = SLOTS[Math.min(10, Math.max(2, size))] ?? SLOTS[6]!;
    const plateW = 136;
    const plateH = 48;
    const plates: PreviewRect[] = slots.map(([x, y]) => ({
      x: Math.round((x * width) / 1000 - plateW / 2),
      y: Math.round((y * height) / 1000 - plateH / 2),
      w: plateW,
      h: plateH,
    }));
    const board = { x: 400 - 129, y: Math.round(0.54 * height - 36), w: 258, h: 93 };
    const max =
      rules?.maxColourThresholds !== null && rules?.maxColourThresholds !== undefined
        ? Math.min(rules.maxColourThresholds, design.maxColourThresholds ?? Infinity)
        : design.maxColourThresholds;
    const collapse = (tone: StatTone | null): StatTone | null => {
      if (tone === null || max === null || max >= 4) return tone;
      if (max >= 2) return tone === 'very-low' ? 'low' : tone === 'very-high' ? 'high' : tone;
      if (max === 1) return tone === 'very-low' || tone === 'low' ? 'low' : 'normal';
      return 'normal';
    };
    const switching = rules?.noGameStateSwitching ?? false;
    const row = 20;
    const pad = 5;
    const cellW = 34;
    const wide = 42;
    const items: PreviewItem[] = [];
    const panels: HudPreview['panels'] = [];
    const stackOf = (seat: number) => (seat % 2 === 0 ? 12 : 60);
    const gap = 5;
    const graphics: PreviewRect[] = [...plates, board];
    const taken: PreviewRect[] = [];
    const meets = (a: PreviewRect, b: PreviewRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const placeBeside = ([sxT, syT]: [number, number], plate: PreviewRect, pw: number, ph: number): PreviewRect => {
      const sx = (sxT * width) / 1000;
      const sy = (syT * height) / 1000;
      const cx = width / 2;
      const cy = (540 * height) / 1000;
      const above = plate.y - gap - ph;
      const below = plate.y + plate.h + gap;
      const left = plate.x - gap - pw;
      const right = plate.x + plate.w + gap;
      const [outY, inY] = sy > cy ? [below, above] : [above, below];
      const [outX, inX] = sx < cx ? [left, right] : [right, left];
      const xOut = sx < cx ? -1 : 1;
      const yOut = sy > cy ? 1 : -1;
      const step = Math.max(1, Math.floor(ph / 8));
      const slides = (reach: number, outward: number) => {
        const out = [0];
        for (let k = step; k <= reach; k += step) out.push(k * outward, -k * outward);
        return out;
      };
      const fit = (x: number, y: number) => ({
        x: Math.round(Math.min(Math.max(x, 0), width - pw)),
        y: Math.round(Math.min(Math.max(y, 0), height - ph)),
        w: pw,
        h: ph,
      });
      const candidates: PreviewRect[] = [];
      for (const y of [outY, inY]) for (const dx of slides((pw + plate.w) / 2 - 1, xOut)) candidates.push(fit(sx - pw / 2 + dx, y));
      for (const x of [outX, inX]) for (const dy of slides((ph + plate.h) / 2 - 1, yOut)) candidates.push(fit(x, sy - ph / 2 + dy));
      const inside = (r: PreviewRect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height;
      return (
        candidates.find((c) => inside(c) && !graphics.some((g) => meets(c, g)) && !taken.some((t) => meets(c, t))) ??
        candidates[0]!
      );
    };
    slots.forEach((_, slot) => {
      const seat = slot + 1;
      const cells = design.cells.filter((cell) => {
        if (!cell.when) return true;
        if (switching) return false;
        const stack = stackOf(seat);
        return (cell.when.belowBb === undefined || stack < cell.when.belowBb) && (cell.when.atLeastBb === undefined || stack >= cell.when.atLeastBb);
      });
      if (cells.length === 0) return;
      const columns = Math.max(1, Math.min(design.columns, cells.length));
      const rows = Math.ceil(cells.length / columns);
      const w = 2 * pad + columns * cellW + wide;
      const h = 2 * pad + rows * row;
      const plate = plates[slot]!;
      // `rail_hud::layout::place_panels`: the first side of the plate (outward
      // first, then sliding along it) clear of the table and of the panels placed.
      const rect = placeBeside(slots[slot]!, plate, w, h);
      const { x, y } = rect;
      taken.push(rect);
      items.push({ kind: 'fill', rect, radius: 5, color: PANEL });
      const fade = seat === 3 ? 0.7 : 1;
      cells.forEach((cell, index) => {
        const stat = statOf(cell.stat);
        const bands = design.overrides?.[cell.stat]?.bands ?? stat?.bands ?? [];
        const decimals = design.overrides?.[cell.stat]?.decimals ?? 0;
        // A made-up value inside one of the bands (`hud_editor::made_up`).
        const limits = bands.map((b) => b.below).filter((b): b is number => b !== undefined);
        const low = limits[0] ?? 10;
        const high = limits[limits.length - 1] ?? 60;
        const value = low + (((seat * 37 + index * 53) % 100) / 100) * (high - low) * 1.15 - (high - low) * 0.05;
        const band = bands.find((b) => b.below === undefined || value < b.below);
        const tone = collapse(band ? band.tone : null);
        const color = TONES[tone ?? 'none'];
        const c = index % columns;
        const r = Math.floor(index / columns);
        items.push({
          kind: 'text',
          rect: { x: x + pad + c * cellW, y: y + pad + r * row, w: cellW, h: row },
          text: value.toFixed(decimals),
          px: 14,
          color: [color[0], color[1], color[2], Math.round(255 * fade)],
          bold: false,
          align: 'center',
        });
      });
      items.push({
        kind: 'text',
        rect: { x: x + pad + columns * cellW, y: y + pad, w: wide, h: row },
        text: String(40 + seat * 173),
        px: 12,
        color: TONES.none,
        bold: false,
        align: 'center',
      });
      panels.push({ slot, rect, stats: cells.map((c) => c.stat), placedByUser: false, stackBb: stackOf(seat) });
    });
    return {
      width,
      height,
      size: slots.length,
      plates,
      board,
      heroSlot: 0,
      items,
      panels,
      legend: null,
      problems: rules ? checkForRoom(design, rules) : [{ code: 'roomNotAllowed' }],
    };
  };

  /* -------------------------------------------------------- answers - */

  const scene = () => state.scene;
  const watcher = () => {
    const status = clone(scene().watcher);
    status.paused = state.importPaused;
    return status;
  };
  const sync = () => {
    const status = clone(scene().sync);
    if (status && state.syncPaused) {
      status.paused = true;
      status.phase = { state: 'paused' };
    }
    return status;
  };
  const editorState = () => ({ ...clone(data.hudEditor), designs: clone(state.designs), assignments: clone(state.assignments) });

  type HandsFilter = {
    sites?: string[];
    positions?: string[];
    potTypes?: string[];
    results?: string[];
    player?: { site: string; player: string } | null;
  };
  /** The rows a filter keeps: rooms, seats, pots, results; a player's hands are every third of their room's. */
  const matching = (raw: unknown) => {
    const filter = (raw ?? {}) as HandsFilter;
    const result = (net: number | null) => (net === null ? null : net > 0 ? 'won' : net < 0 ? 'lost' : 'even');
    return data.rows.filter(
      (row, index) =>
        (!filter.sites?.length || filter.sites.includes(row.site)) &&
        (!filter.positions?.length || (row.heroPosition !== null && filter.positions.includes(row.heroPosition))) &&
        (!filter.potTypes?.length || filter.potTypes.includes(row.potType)) &&
        (!filter.results?.length || filter.results.includes(result(row.heroNet) ?? '')) &&
        (!filter.player || (row.site === filter.player.site && index % 3 === 0)),
    );
  };

  const handlers: Record<string, (args: Record<string, unknown>) => Json> = {
    core_info: () => data.coreInfo,
    app_info: () => data.appInfo,
    get_settings: () => scene().settings,
    set_theme: (a) => Object.assign(scene().settings, { theme: a.theme }),
    set_density: (a) => Object.assign(scene().settings, { density: a.density }),
    set_locale: (a) => Object.assign(scene().settings, { locale: a.locale }),
    set_start_at_login: (a) => Object.assign(scene().settings, { startAtLogin: a.enabled }),
    set_first_run_done: (a) => Object.assign(scene().settings, { firstRunDone: a.done }),
    store_status: () => scene().store,
    watcher_status: () => watcher(),
    set_import_paused: (a) => {
      state.importPaused = Boolean(a.paused);
      return null;
    },
    discover_folders: () => {
      const discovery = clone(data.discovery);
      for (const folder of discovery.folders) folder.watched = state.watched.has(folder.path);
      return discovery;
    },
    pick_folder: () => data.pickFolder,
    add_folders: (a) => {
      const folders = (a.folders as { path: string }[]) ?? [];
      return folders.map((folder, index) => {
        state.watched.add(folder.path);
        return { path: folder.path, id: index + 1, marked: a.onlyNew ? 120 : 0 };
      });
    },
    add_folder: (a) => ({ id: 9, path: a.path, marked: 0 }),
    set_folder_path: () => ({ moved: 0, adopted: 0, detached: 0, marked: 0 }),
    set_folder_room: () => 0,
    set_folder_enabled: () => null,
    set_folder_recursive: () => null,
    set_folder_poll_only: () => null,
    remove_folder: () => null,
    folder_rooms: () => data.rooms,
    folder_quarantine: () => ({ ...data.quarantine, entries: [], truncated: false }),
    quarantine_summary: () => (scene().store.quarantined > 0 ? data.quarantine : { reasons: [], total: 0, retryable: { hands: 0, files: 0 } }),
    quarantine_entries: () => data.quarantineEntries,
    quarantine_raw_text: () => null,
    retry_refused: () => 0,

    account_status: () => scene().account,
    account_sign_in: () => {
      scene().account = { state: 'signingIn', url: 'https://rail.test/auth/desktop', secondsLeft: 597, notice: null };
      return scene().account;
    },
    account_open_sign_in_page: () => scene().account,
    account_cancel_sign_in: () => {
      scene().account = { state: 'signedOut', notice: null };
      return scene().account;
    },
    account_sign_out: () => {
      scene().account = { state: 'signedOut', notice: null };
      return scene().account;
    },
    account_open_web_page: () => null,
    sync_status: () => sync(),
    sync_now: () => sync(),
    sync_set_paused: (a) => {
      state.syncPaused = Boolean(a.paused);
      return sync();
    },
    sync_set_cap: (a) => {
      const status = scene().sync;
      if (status) status.cap = (a.cap as number | null) ?? null;
      return sync();
    },
    sync_answer_account: () => sync(),
    sync_retry_rejected: () => sync(),
    entitlements_status: () => data.entitlements,
    entitlements_check_now: () => null,
    entitlements_open_upgrade: () => null,

    stats_status: () => data.statsStatus,
    stats_rebuild: () => 0,
    stats_recompute_ev: () => 0,
    stat_definitions: () => data.definitions,
    custom_stats_list: () => data.customStats,
    custom_stat_check: () => ({ problems: [], preview: null }),

    hands_page: (a) => ({ rows: a.after ? [] : matching(a.filter).slice(0, Number(a.limit) || 100), next: null }),
    hands_facets: (a) => {
      // The groups' counts stay the library's; the total follows the filter (a player: their hands with you).
      const filter = (a.filter ?? {}) as HandsFilter;
      const facets = clone(data.facets);
      if (filter.player) {
        facets.total = data.players.find((p) => p.site === filter.player?.site && p.player === filter.player.player)?.hands ?? 0;
      } else {
        facets.total = Math.round((matching(filter).length / data.rows.length) * data.facets.total);
      }
      return facets;
    },
    hands_by_key: (a) => data.rows.filter((row) => ((a.keys as string[]) ?? []).includes(row.handKey)),
    hands_find: (a) =>
      data.rows.filter((row) => row.siteHandId.startsWith(String(a.query ?? '').replace(/^#/, ''))).slice(0, Number(a.limit) || 8),
    hand_phf: (a) => {
      const hand = data.phf[String(a.handKey)];
      return hand ? JSON.stringify(hand) : null;
    },
    hand_annotations: (a) => state.notes[String(a.handKey)] ?? { note: null, tags: [] },
    hand_set_note: (a) => {
      const key = String(a.handKey);
      state.notes[key] = { tags: state.notes[key]?.tags ?? [], note: String(a.note) || null };
      return state.notes[key];
    },
    hand_add_tag: (a) => {
      const key = String(a.handKey);
      const entry = (state.notes[key] ??= { note: null, tags: [] });
      if (!entry.tags.includes(String(a.tag))) entry.tags.push(String(a.tag));
      return entry;
    },
    hand_remove_tag: (a) => {
      const key = String(a.handKey);
      const entry = (state.notes[key] ??= { note: null, tags: [] });
      entry.tags = entry.tags.filter((tag) => tag !== a.tag);
      return entry;
    },
    hand_analysis: () => null,
    saved_filters: (a) => (a.screen === 'reports' ? data.reportSavedFilters : data.savedFilters),
    save_filter: () => data.savedFilters,
    delete_saved_filter: () => data.savedFilters,
    report: (a) => {
      const filter = (a.filter ?? {}) as HandsFilter;
      return filter.sites?.length === 1 && filter.sites[0] === 'pokerstars' ? data.reportStars : data.report;
    },
    report_breakdowns: (a) => {
      const filter = (a.filter ?? {}) as HandsFilter;
      return filter.sites?.length === 1 && filter.sites[0] === 'pokerstars' ? data.breakdownsStars : data.breakdowns;
    },
    today: () => scene().today,

    players_list: (a) => {
      const query = (a.query ?? {}) as { search?: string; site?: string | null; limit?: number };
      const search = (query.search ?? '').toLowerCase();
      const rows = data.players.filter(
        (row) => (!search || row.player.toLowerCase().startsWith(search)) && (!query.site || row.site === query.site),
      );
      return {
        rows: rows.slice(0, query.limit ?? 200).map((row) => {
          const own = state.words[`${row.site}:${row.player}`];
          return own ? { ...row, colour: own.colour as typeof row.colour, labels: own.labels, hasNote: own.note !== '' } : row;
        }),
        matching: rows.length,
        players: data.players.length,
        cashHands: 48_210,
        chipsHands: 0,
        mixedKind: false,
        hiddenHands: 0,
      };
    },
    player_profile: (a) => {
      const key = `${String(a.site)}:${String(a.player)}`;
      const profile = clone(data.profiles[key]);
      if (profile && state.words[key]) Object.assign(profile.notes, state.words[key]);
      return profile ?? null;
    },
    player_sites: () => data.playerSites,
    player_labels: () => data.playerLabels,
    player_set_note: (a) => words(a, (notes) => (notes.note = String(a.note))),
    player_set_colour: (a) => words(a, (notes) => (notes.colour = (a.colour as string | null) ?? null)),
    player_add_label: (a) => words(a, (notes) => notes.labels.includes(String(a.label)) || notes.labels.push(String(a.label))),
    player_remove_label: (a) => words(a, (notes) => (notes.labels = notes.labels.filter((l) => l !== a.label))),

    hud_status: () => scene().hud,
    hud_request_permission: () => null,
    hud_policy: () => data.hudPolicy,
    hud_policy_check: () => data.hudPolicy,
    hud_open_policy_source: () => null,
    hud_popup: () => data.popup,
    hud_popup_close: () => null,
    hud_popup_open_in_app: () => null,
    hud_editor_state: () => editorState(),
    hud_design_check: (a) => check(a.design as HudDesign),
    hud_design_save: (a) => {
      const design = a.design as HudDesign;
      const problems = designProblems(design);
      if (problems.length > 0) return { id: null, problems, refused: {} };
      const id = (a.id as string | null) ?? `design-${state.designs.length + 1}`;
      state.designs = [...state.designs.filter((d) => d.id !== id), { id, design, updatedAt: Date.now() }];
      return { id, problems: [], refused: {} };
    },
    hud_design_delete: (a) => {
      state.designs = state.designs.filter((d) => d.id !== a.id);
      return true;
    },
    hud_assign: (a) => {
      const site = String(a.site);
      const layout = a.layout as string | null;
      state.assignments = state.assignments.filter((x) => !(x.site === site && x.size === a.size && x.format === a.format));
      if (layout !== null) {
        state.assignments.push({ site, size: (a.size as number | null) ?? null, format: (a.format as never) ?? null, layout, refused: {} });
      }
      return { ok: true, refused: {} };
    },
    hud_preview: (a) => preview(a.design as HudDesign, String(a.site), Number(a.size)),
    hud_reset_seat_positions: () => 1,
    hud_set_preferred_seat: () => null,

    // The hand analysis stays idle (its runner asks the gate before anything).
    // A day of use: the background run may go (it finds nothing left to do). Elsewhere it stays paused.
    analysis_gate: () =>
      sceneName === 'daily' ? { run: true, reason: null, paused: false } : { run: false, reason: 'paused', paused: true },
    analysis_set_paused: (a) => Boolean(a.paused),
    analysis_pending: () => [],
    analysis_offline: () => [],
    analysis_save: () => ({ saved: 0, missing: 0 }),
    analysis_counts: () =>
      sceneName === 'daily'
        ? { hands: 48_210, current: 47_630, stale: 0, missing: 0, offline: 0, notAnalysable: 580 }
        : { hands: 48_210, current: 0, stale: 0, missing: 0, offline: 0, notAnalysable: 0 },
    session_review: () => data.analysis.review,
    analysis_villains: () => [],
    analysis_clear: () => 0,
    flop_library_reachable: () => false,
    flop_library_usage: () => ({ bytes: 0, files: 0 }),
    chart_sets_list: () => [],
    chart_set_load: () => null,
    tournament_settings_list: () => [],
    review_sessions: () => data.analysis.sessions,
    session_preflop: () => [],
    review_hands: () => ({}),
    top_leaks: () => data.analysis.topLeaks,
    leak_examples: () => data.analysis.examples,
    dev_pick_file: () => null,
  };

  function words(a: Record<string, unknown>, change: (notes: { colour: string | null; note: string; labels: string[] }) => unknown) {
    const key = `${String(a.site)}:${String(a.player)}`;
    const base = data.profiles[key]?.notes ?? { colour: null, note: '', labels: [] };
    const notes = (state.words[key] ??= clone(base));
    change(notes);
    return clone(notes);
  }

  const unknown: string[] = [];
  const calls: string[] = [];

  const invoke = (cmd: string, args: Record<string, unknown> = {}): Promise<Json> => {
    calls.push(cmd);
    if (cmd === 'plugin:event|listen') {
      const event = String(args.event);
      const eventId = nextEvent++;
      const list = listeners.get(event) ?? [];
      list.push({ eventId, handler: Number(args.handler) });
      listeners.set(event, list);
      return Promise.resolve(eventId);
    }
    if (cmd === 'plugin:event|unlisten') {
      const event = String(args.event);
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l.eventId !== args.eventId));
      return Promise.resolve(null);
    }
    if (cmd.startsWith('plugin:')) return Promise.resolve(null);
    const handler = handlers[cmd];
    if (!handler) {
      if (!unknown.includes(cmd)) unknown.push(cmd);
      console.warn(`[rail-mock] no answer for ${cmd}`, JSON.stringify(args).slice(0, 200));
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(clone(handler(args)));
    } catch (error) {
      console.error(`[rail-mock] ${cmd} failed`, error);
      return Promise.reject(String(error));
    }
  };

  /* ---------------------------------------------- what the API reads - */

  w.isTauri = true;
  w.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(callback: (payload: unknown) => void, once = false) {
      const id = nextCallback++;
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id);
        callback(payload);
      });
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc(path: string) {
      return path;
    },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, eventId: number) {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l.eventId !== eventId));
    },
  };

  const announce = () => {
    for (const event of ['watcher-changed', 'account-changed', 'sync-changed', 'hud-status-changed', 'stats-changed']) emit(event);
    emit('hud-tables-open', scene().hud.tablesOpen > 0);
  };
  const mock = {
    get sceneName() {
      return sceneName;
    },
    scene(name: SceneName) {
      sceneName = name;
      state.scene = clone(data.scenes[name]);
      announce();
    },
    set(patch: Record<string, unknown>) {
      Object.assign(state.scene, clone(patch));
      announce();
    },
    account(next: AccountStatus) {
      state.scene.account = clone(next);
      emit('account-changed');
    },
    emit,
    unknown,
    calls,
  };
  w.__railMock = mock;
}
