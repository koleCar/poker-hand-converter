/**
 * My nodelocks' tree (`docs/NODELOCK.md` §7.1): the user's folders, the root
 * locks in them, and under each lock the locks built on it. A click opens a
 * solved lock beside the tree; the open one is the selected row.
 *
 * - Keys: Up / Down move, Shift extends, Right / Left open and close, Enter
 *   opens, F2 renames, Delete deletes.
 * - Cmd/Ctrl-click and Shift-click choose several rows.
 * - Drag (pointer, not HTML drag and drop: a webview may take that for
 *   files): onto a folder moves in, onto a row's edge reorders, onto the
 *   empty area moves to the top level. A child lock stays with its parent:
 *   the drop is refused and the row shakes.
 * - Right-click or the row's `⋯`: Open, Rename, New folder here, Move to…,
 *   Duplicate and edit, Delete. The toolbar: New folder, Search, Collapse all.
 * - The solve running shows on its row (a bar, its progress on hover); its
 *   menu also cancels it (and the solves waiting, when there are some). The
 *   solves waiting after it are listed under the tree.
 *
 * The pure part (the tree, search, drop rules) is `./model.ts`.
 */
import { ContextMenu, type MenuItem, type MenuPoint } from "@rail/ui/hands/ContextMenu";
import { Dialog } from "@rail/ui/dialog/Dialog";
import { Icon } from "@rail/ui/icon/Icon";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import { useT } from "../../../i18n";
import { go } from "../../../lib/router";
import { solverStyles, ToolButton } from "../../door";
import { nodelockData, onNodelocksChanged, type NodeLockFolder, type NodeLockRow } from "../data";
import { progressLine } from "../progress";
import { boardText, cancelAll, cancelSolve, editLock, LOCKS_PARAM, nodelockSession, openLock, parseRow, useNodelockSession } from "../session";
import { HoverCard } from "./HoverCard";
import {
  ancestors,
  boardCards,
  buildTree,
  canMove,
  deleteArgs,
  filterTree,
  folderChoices,
  folderHere,
  keyOf,
  locksUnder,
  planDrop,
  rangeKeys,
  refOf,
  topmost,
  visibleRows,
  type DropAt,
  type Landing,
  type Tree,
  type TreeNode,
} from "./model";
import { readOpen, writeOpen } from "./persist";
import styles from "./tree.module.css";

type Node = TreeNode<NodeLockRow, NodeLockFolder>;
type Loaded = { status: "loading" } | { status: "error" } | { status: "ready"; folders: NodeLockFolder[]; rows: NodeLockRow[] };

/** How far the pointer moves before a press becomes a drag. */
const DRAG_START_PX = 5;
/** A closed folder held under a drag this long opens. */
const OPEN_ON_HOLD_MS = 700;
const HOVER_DELAY_MS = 450;

const rowId = (key: string) => `nodelock-tree-${key.replace(":", "-")}`;

/**
 * What outlives the tree: the library shows it beside the open lock and
 * mounts it again with every lock opened, so the rows read last, the search
 * and the scroll stay as they were.
 */
const kept: { loaded: Loaded; searching: boolean; query: string; scrollTop: number } = {
  loaded: { status: "loading" },
  searching: false,
  query: "",
  scrollTop: 0,
};

/** What search matches: the name, the board (both ways of writing it), the line and the table. */
function searchText(node: Node): string {
  if (node.kind === "folder") return node.item.name;
  const row = node.item;
  const cards = boardCards(row);
  return [row.name, cards.join(""), boardText(cards), row.line, row.set_id, row.preset ?? ""].join(" ");
}

interface DragState {
  keys: string[];
  x: number;
  y: number;
  at: DropAt | null;
  landing: Landing | null;
}

export function NodelockTree({ openId, onHide }: { openId: string | null; onHide: () => void }) {
  const t = useT().nodelock;
  const tt = t.tree;
  const session = useNodelockSession();
  const [loaded, setLoaded] = useState<Loaded>(kept.loaded);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<Set<string>>(readOpen);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(openId ? [`l:${openId}`] : []));
  const [anchor, setAnchor] = useState<string | null>(openId ? `l:${openId}` : null);
  const [focus, setFocus] = useState<string | null>(openId ? `l:${openId}` : null);
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  const [searching, setSearching] = useState(kept.searching);
  const [query, setQuery] = useState(kept.query);
  const [menu, setMenu] = useState<{ at: MenuPoint; keys: string[] } | null>(null);
  const [deleting, setDeleting] = useState<{ keys: string[]; question: string; solving: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [shaking, setShaking] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<{ key: string; rect: DOMRect } | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ key: string; x: number; y: number; started: boolean } | null>(null);
  const suppressClick = useRef(false);
  const focusRow = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  // ---- data ---------------------------------------------------------------
  const read = useCallback(() => {
    Promise.all([nodelockData.list(), nodelockData.folders().catch(() => [] as NodeLockFolder[])]).then(
      ([rows, folders]) => setLoaded({ status: "ready", rows, folders }),
      () => setLoaded({ status: "error" }),
    );
  }, []);
  useEffect(() => {
    read();
    return onNodelocksChanged(read);
  }, [read, attempt]);
  // A solve starting or ending changes a row's status.
  useEffect(() => {
    read();
  }, [read, session.running?.id, session.notice?.id]);

  const tree: Tree<NodeLockRow, NodeLockFolder> = useMemo(
    () => (loaded.status === "ready" ? buildTree(loaded.folders, loaded.rows) : buildTree<NodeLockRow, NodeLockFolder>([], [])),
    [loaded],
  );
  const filtering = searching && query.trim() !== "";
  const roots = useMemo(() => (filtering ? filterTree(tree.roots, query, searchText) : tree.roots), [tree, filtering, query]);
  const rows = useMemo(() => visibleRows(roots, (key) => filtering || open.has(key)), [roots, filtering, open]);

  useEffect(() => writeOpen(open), [open]);
  useEffect(() => {
    kept.loaded = loaded;
    kept.searching = searching;
    kept.query = query;
  }, [loaded, searching, query]);
  // Back where it was scrolled to, once the rows are there.
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (scrolled.current || !list || loaded.status !== "ready") return;
    scrolled.current = true;
    list.scrollTop = kept.scrollTop;
  }, [loaded]);

  // The open lock is the selected row, its branch open (once per lock opened: it can be closed again).
  const [shown, setShown] = useState<{ id: string | null; revealed: boolean }>({ id: openId, revealed: false });
  if (shown.id !== openId) {
    setShown({ id: openId, revealed: false });
    if (openId) {
      const key = `l:${openId}`;
      setSelected(new Set([key]));
      setAnchor(key);
      setFocus(key);
    }
  } else if (openId && !shown.revealed && tree.byKey.has(`l:${openId}`)) {
    setShown({ id: openId, revealed: true });
    const up = ancestors(tree, `l:${openId}`);
    if (!up.every((key) => open.has(key))) setOpen(new Set([...open, ...up]));
  }

  // A solve that starts opens its branch once, so its row (and progress) shows under its parent.
  const runningId = session.running?.id ?? null;
  const revealedRun = useRef<string | null>(null);
  useEffect(() => {
    if (!runningId || revealedRun.current === runningId || !tree.byKey.has(`l:${runningId}`)) return;
    revealedRun.current = runningId;
    const up = ancestors(tree, `l:${runningId}`);
    setOpen((was) => (up.every((key) => was.has(key)) ? was : new Set([...was, ...up])));
  }, [runningId, tree]);

  // Keyboard moves bring the focused row into view and focus.
  useEffect(() => {
    if (!focusRow.current || !focus) return;
    focusRow.current = false;
    const node = document.getElementById(rowId(focus));
    node?.focus();
    node?.scrollIntoView({ block: "nearest" });
  }, [focus, rows]);

  // ---- actions ------------------------------------------------------------
  const toggleOpen = useCallback((key: string, next?: boolean) => {
    setOpen((was) => {
      const now = new Set(was);
      if (next ?? !now.has(key)) now.add(key);
      else now.delete(key);
      return now;
    });
  }, []);

  const select = (keys: string[], at: string) => {
    setSelected(new Set(keys));
    setFocus(at);
  };

  const openRow = async (node: Node) => {
    if (node.kind !== "lock" || node.item.status !== "solved") return;
    setError(null);
    if (!(await openLock(node.id))) setError(t.openError);
  };

  const startRename = (key: string) => {
    const node = tree.byKey.get(key);
    if (node) setRenaming({ key, name: node.item.name });
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { key, name: raw } = renaming;
    setRenaming(null);
    const node = tree.byKey.get(key);
    const name = raw.trim();
    if (!node || !name || name === node.item.name) return;
    try {
      if (node.kind === "lock") await nodelockData.rename(node.id, name);
      else await nodelockData.saveFolder({ id: node.id, name, parent_id: node.item.parent_id, sort: node.item.sort });
    } catch {
      setError(t.loadError);
    }
  };

  /** A new folder at the top of `parent` (null: the top level), named at once. */
  const newFolder = async (parent: string | null) => {
    const siblings = parent === null ? tree.roots : (tree.byKey.get(`f:${parent}`)?.children ?? []);
    const sort = siblings.length ? Math.min(...siblings.map((node) => node.item.sort)) - 1 : 0;
    try {
      const folder = await nodelockData.saveFolder({ name: tt.newFolderName, parent_id: parent, sort });
      if (parent !== null) toggleOpen(`f:${parent}`, true);
      const key = `f:${folder.id}`;
      setSearching(false);
      setQuery("");
      select([key], key);
      setAnchor(key);
      setRenaming({ key, name: folder.name });
    } catch {
      setError(t.loadError);
    }
  };

  /** Moves the keys (in the shown order) to where a drop or Move to… says. */
  const move = async (keys: string[], landing: Landing) => {
    const order = new Map(visibleRows(tree.roots, () => true).map((row, index) => [row.node.key, index]));
    const items = topmost(tree, keys)
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      .map(refOf);
    const moving = new Set(items.map(keyOf));
    const siblings = landing.folder_id === null ? tree.roots : (tree.byKey.get(`f:${landing.folder_id}`)?.children ?? []);
    const last = [...siblings].reverse().find((node) => !moving.has(node.key));
    try {
      const ok = await nodelockData.move(items, {
        folder_id: landing.folder_id,
        before: landing.before,
        atEnd: landing.atEnd,
        last: last ? refOf(last.key) : null,
      });
      if (!ok) shake(keys);
      else if (landing.folder_id !== null) toggleOpen(`f:${landing.folder_id}`, true);
    } catch {
      setError(t.loadError);
    }
  };

  const shake = (keys: string[]) => {
    setShaking(new Set(keys));
    setTimeout(() => setShaking(new Set()), 450);
  };

  const askDelete = async (keys: string[]) => {
    const { locks, folders } = deleteArgs(tree, keys);
    if (!locks.length && !folders.length) return;
    const going = locksUnder(tree, keys);
    const running = nodelockSession().running?.id ?? null;
    const solving = running !== null && going.some((row) => row.id === running);
    let counts: { folders: number; locks: number; descendants: number };
    try {
      counts = await nodelockData.deletePreview(locks, folders);
    } catch {
      // The store could not count: the tree can (it holds every row).
      const folderCount = topmost(tree, keys).reduce((sum, key) => {
        const node = tree.byKey.get(key);
        let count = 0;
        const walk = (n: Node) => {
          if (n.kind === "folder") count += 1;
          n.children.forEach(walk);
        };
        if (node) walk(node);
        return sum + count;
      }, 0);
      const roots = going.filter((row) => locks.includes(row.id) || row.parent_id === null).length;
      counts = { folders: folderCount, locks: roots, descendants: going.length - roots };
    }
    setDeleting({ keys, question: tt.deleteQuestion(counts.folders, counts.locks, counts.descendants), solving });
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    const { locks, folders } = deleteArgs(tree, deleting.keys);
    const going = new Set(locksUnder(tree, deleting.keys).map((row) => row.id));
    try {
      // A solving lock is cancelled first, and its ending saved, before its row goes.
      const running = nodelockSession().running?.id ?? null;
      if (running !== null && going.has(running)) {
        cancelSolve();
        const until = Date.now() + 15_000;
        while (nodelockSession().running?.id === running && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      await nodelockData.removeItems(locks, folders);
      setSelected(new Set());
      if (openId && going.has(openId)) go("solver", LOCKS_PARAM);
      setDeleting(null);
    } catch {
      setError(t.loadError);
    } finally {
      setBusy(false);
    }
  };

  // ---- the menu -----------------------------------------------------------
  const menuItems = (keys: string[]): MenuItem[] => {
    if (!keys.length) return [{ label: tt.newFolder, onSelect: () => void newFolder(null) }];
    const single = keys.length === 1 ? tree.byKey.get(keys[0]) : undefined;
    const movable = canMove(tree, keys);
    const choices = movable ? folderChoices(tree, keys) : [];
    // The solve running on this row is cancelled here (the sidebar only names it, #406).
    const solving = single?.kind === "lock" && session.running?.id === single.item.id;
    const cancel: MenuItem[] = solving
      ? [{ label: tt.cancelSolve, onSelect: cancelSolve }, ...(session.queue.length ? [{ label: tt.cancelQueue, onSelect: cancelAll }] : [])]
      : [];
    return [
      {
        label: t.open,
        disabled: !(single?.kind === "lock" && single.item.status === "solved"),
        onSelect: () => single && void openRow(single),
      },
      ...cancel,
      { label: t.rename, disabled: !single, onSelect: () => single && startRename(single.key) },
      { label: tt.newFolderHere, onSelect: () => void newFolder(folderHere(tree, keys[0])) },
      {
        label: tt.moveTo,
        disabled: !movable,
        submenu: (close) => (
          <div className={styles.picker}>
            {choices.map((choice) => (
              <button
                key={choice.id ?? ""}
                type="button"
                role="menuitem"
                className={styles.pickerItem}
                style={{ paddingInlineStart: `calc(var(--space-3) + ${choice.depth * 12}px)` }}
                onClick={() => {
                  close();
                  void move(keys, { folder_id: choice.id, before: null, atEnd: false });
                }}
              >
                <Icon name={choice.id === null ? "home" : "folder"} />
                <span>{choice.id === null ? tt.topLevel : choice.name}</span>
              </button>
            ))}
          </div>
        ),
      },
      {
        label: t.duplicate,
        disabled: !(single?.kind === "lock" && parseRow(single.item)),
        onSelect: () => single?.kind === "lock" && editLock(single.item, t.copyName(single.item.name)),
      },
      { label: t.delete, onSelect: () => void askDelete(keys) },
    ];
  };

  const openMenu = (at: MenuPoint, key: string | null) => {
    setHover(null);
    if (key === null) {
      setMenu({ at, keys: [] });
      return;
    }
    const keys = selected.has(key) ? [...selected] : [key];
    if (!selected.has(key)) select([key], key);
    setAnchor(key);
    setMenu({ at, keys });
  };

  // ---- pointer: click, drag -----------------------------------------------
  const onRowClick = (event: MouseEvent, node: Node) => {
    clearHoverTimer();
    setHover(null);
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (renaming?.key === node.key) return;
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(selected);
      if (next.has(node.key)) next.delete(node.key);
      else next.add(node.key);
      setSelected(next);
      setFocus(node.key);
      setAnchor(node.key);
      return;
    }
    if (event.shiftKey) {
      select(rangeKeys(rows, anchor, node.key), node.key);
      return;
    }
    select([node.key], node.key);
    setAnchor(node.key);
    if (node.kind === "folder") toggleOpen(node.key);
    else void openRow(node);
  };

  const onRowPointerDown = (event: ReactPointerEvent, node: Node) => {
    if (event.button !== 0 || renaming) return;
    if ((event.target as HTMLElement).closest("button, input")) return;
    press.current = { key: node.key, x: event.clientX, y: event.clientY, started: false };
  };

  const dropAt = useCallback(
    (x: number, y: number): DropAt | null => {
      const list = listRef.current;
      if (!list) return null;
      const box = list.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
      const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tree-key]");
      if (!hit || !list.contains(hit)) return { kind: "top" };
      const key = hit.dataset.treeKey!;
      const node = tree.byKey.get(key);
      if (!node) return null;
      const rect = hit.getBoundingClientRect();
      const share = (y - rect.top) / Math.max(1, rect.height);
      if (node.kind === "folder") {
        if (share < 0.25) return { kind: "before", key };
        if (share > 0.75 && !(hit.getAttribute("aria-expanded") === "true")) return { kind: "after", key };
        return { kind: "into", key };
      }
      return { kind: share < 0.5 ? "before" : "after", key };
    },
    [tree],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const at = press.current;
      if (!at) return;
      if (!at.started) {
        if (Math.hypot(event.clientX - at.x, event.clientY - at.y) < DRAG_START_PX) return;
        at.started = true;
        setHover(null);
        if (!selected.has(at.key)) {
          setSelected(new Set([at.key]));
          setFocus(at.key);
          setAnchor(at.key);
        }
      }
      const keys = selected.has(at.key) ? [...selected] : [at.key];
      const target = dropAt(event.clientX, event.clientY);
      const landing = target ? planDrop(tree, keys, target) : null;
      setDrag({ keys, x: event.clientX, y: event.clientY, at: target, landing });
      // Held over a closed folder: it opens.
      const hold = target?.kind === "into" ? target.key : null;
      if (holdTimer.current?.key !== hold) {
        if (holdTimer.current) clearTimeout(holdTimer.current.timer);
        holdTimer.current = hold ? { key: hold, timer: setTimeout(() => toggleOpen(hold, true), OPEN_ON_HOLD_MS) } : null;
      }
    };
    const end = (event: PointerEvent, cancelled: boolean) => {
      const at = press.current;
      press.current = null;
      if (holdTimer.current) {
        clearTimeout(holdTimer.current.timer);
        holdTimer.current = null;
      }
      if (!at?.started) return;
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setDrag(null);
      if (cancelled) return;
      const keys = selected.has(at.key) ? [...selected] : [at.key];
      const target = dropAt(event.clientX, event.clientY);
      if (!canMove(tree, keys)) {
        if (target) shake(keys);
        return;
      }
      const landing = target ? planDrop(tree, keys, target) : null;
      if (landing) void move(keys, landing);
    };
    const onUp = (event: PointerEvent) => end(event, false);
    const onCancel = (event: PointerEvent) => end(event, true);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && press.current?.started) {
        press.current = null;
        setDrag(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };
    // `move` and `shake` read the current tree through the closure: re-bound with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, selected, dropAt, toggleOpen]);

  // ---- hover card ---------------------------------------------------------
  const clearHoverTimer = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const onRowEnter = (event: ReactPointerEvent<HTMLElement>, node: Node) => {
    clearHoverTimer();
    if (node.kind !== "lock" || press.current || menu || renaming?.key === node.key) {
      if (hover && hover.key !== node.key) setHover(null);
      return;
    }
    const target = event.currentTarget;
    hoverTimer.current = setTimeout(() => setHover({ key: node.key, rect: target.getBoundingClientRect() }), hover ? 80 : HOVER_DELAY_MS);
  };
  const onRowLeave = () => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setHover(null), 160);
  };
  useEffect(() => clearHoverTimer, []);

  // ---- keys ---------------------------------------------------------------
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    const index = rows.findIndex((row) => row.node.key === focus);
    const row = index >= 0 ? rows[index] : null;
    const moveTo = (next: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (!target) return;
      focusRow.current = true;
      if (event.shiftKey) select(rangeKeys(rows, anchor, target.node.key), target.node.key);
      else {
        select([target.node.key], target.node.key);
        setAnchor(target.node.key);
      }
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveTo(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveTo(index < 0 ? 0 : index - 1);
        break;
      case "Home":
        event.preventDefault();
        moveTo(0);
        break;
      case "End":
        event.preventDefault();
        moveTo(rows.length - 1);
        break;
      case "ArrowRight":
        if (!row) break;
        event.preventDefault();
        if (row.node.children.length && !row.open) toggleOpen(row.node.key, true);
        else if (row.open) moveTo(index + 1);
        break;
      case "ArrowLeft": {
        if (!row) break;
        event.preventDefault();
        if (row.open && !filtering) toggleOpen(row.node.key, false);
        else if (row.node.parent) {
          const up = rows.findIndex((r) => r.node.key === row.node.parent);
          if (up >= 0) moveTo(up);
        }
        break;
      }
      case "Enter":
        if (!row) break;
        event.preventDefault();
        if (row.node.kind === "folder") toggleOpen(row.node.key);
        else void openRow(row.node);
        break;
      case "F2":
        if (!row) break;
        event.preventDefault();
        startRename(row.node.key);
        break;
      case "Delete":
      case "Backspace": {
        const keys = selected.size ? [...selected] : row ? [row.node.key] : [];
        if (!keys.length) break;
        event.preventDefault();
        void askDelete(keys);
        break;
      }
      case "ContextMenu": {
        if (!row) break;
        event.preventDefault();
        const box = document.getElementById(rowId(row.node.key))?.getBoundingClientRect();
        if (box) openMenu({ x: box.left + 24, y: box.bottom }, row.node.key);
        break;
      }
      default:
    }
  };

  // ---- render -------------------------------------------------------------
  const running = session.running;
  const hovered = hover ? tree.byKey.get(hover.key) : undefined;
  const dropKey = drag?.landing && drag.at && drag.at.kind !== "top" ? drag.at.key : null;
  const dropKind = drag?.landing && drag.at ? drag.at.kind : null;

  const renderRow = ({ node, depth, open: isOpen }: { node: Node; depth: number; open: boolean }) => {
    const isLock = node.kind === "lock";
    const row = isLock ? node.item : null;
    const solving = row !== null && running?.id === row.id;
    const nodes = row ? (parseRow(row)?.lockSet.nodes.length ?? 0) : 0;
    const isRenaming = renaming?.key === node.key;
    const status = row ? (solving ? "solving" : row.status) : null;
    return (
      <div
        key={node.key}
        id={rowId(node.key)}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected.has(node.key)}
        aria-expanded={node.children.length ? isOpen : undefined}
        tabIndex={focus === node.key || (focus === null && rows[0]?.node.key === node.key) ? 0 : -1}
        data-tree-key={node.key}
        data-drop={dropKey === node.key ? dropKind : undefined}
        className={[
          styles.row,
          selected.has(node.key) ? styles.selected : "",
          isLock && node.id === openId ? styles.opened : "",
          shaking.has(node.key) ? styles.shake : "",
          drag?.keys.includes(node.key) ? styles.dragged : "",
          row && row.status !== "solved" && !solving ? styles.unsolved : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ paddingInlineStart: `calc(var(--space-1) + ${depth * 14}px)` }}
        onClick={(event) => onRowClick(event, node)}
        onDoubleClick={() => startRename(node.key)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openMenu({ x: event.clientX, y: event.clientY }, node.key);
        }}
        onPointerDown={(event) => onRowPointerDown(event, node)}
        onPointerEnter={(event) => onRowEnter(event, node)}
        onPointerLeave={onRowLeave}
        onFocus={() => setFocus(node.key)}
      >
        {node.children.length ? (
          <button
            type="button"
            tabIndex={-1}
            className={`${styles.twisty} ${isOpen ? styles.twistyOpen : ""}`}
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              if (!filtering) toggleOpen(node.key);
            }}
          >
            <Icon name="chevronRight" />
          </button>
        ) : (
          <span className={styles.twisty} />
        )}
        <span className={styles.mark} title={status && status !== "solved" ? (t.status[status] ?? status) : undefined}>
          {node.kind === "folder" ? (
            <Icon name="folder" />
          ) : solving ? (
            <span className={styles.spinner} role="img" aria-label={tt.solving(running?.share ?? null)} />
          ) : status && status !== "solved" ? (
            <span className={styles.dot} data-status={status} />
          ) : null}
        </span>
        {isRenaming ? (
          <input
            className={styles.renameInput}
            autoFocus
            value={renaming.name}
            aria-label={t.renameLabel(node.item.name)}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setRenaming({ key: node.key, name: event.target.value })}
            onClick={(event) => event.stopPropagation()}
            onBlur={() => void commitRename()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                focusRow.current = true;
                void commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                focusRow.current = true;
                setRenaming(null);
              }
            }}
          />
        ) : (
          <span className={styles.name}>{node.item.name}</span>
        )}
        {row && !isRenaming ? (
          <span className={styles.meta}>
            {solving && running?.share !== null && running?.share !== undefined ? (
              <span className={styles.share}>{Math.floor(running.share * 100)}%</span>
            ) : null}
            <span className={styles.board}>{boardText(boardCards(row))}</span>
            {nodes > 0 ? (
              <span className={styles.locks} title={tt.lockedNodes(nodes)}>
                {nodes}
                <Icon name="lock" />
              </span>
            ) : null}
          </span>
        ) : null}
        {!isRenaming ? (
          <button
            type="button"
            tabIndex={-1}
            className={styles.more}
            title={t.actions(node.item.name)}
            aria-label={t.actions(node.item.name)}
            onClick={(event) => {
              event.stopPropagation();
              const box = event.currentTarget.getBoundingClientRect();
              openMenu({ x: box.left, y: box.bottom + 2 }, node.key);
            }}
          >
            <Icon name="more" />
          </button>
        ) : null}
        {solving && running ? (
          <span className={styles.rowBar} title={progressLine(t, running)} aria-hidden="true">
            <span
              className={running.share === null ? styles.rowFillBusy : styles.rowFill}
              style={running.share === null ? undefined : { inlineSize: `${running.share * 100}%` }}
            />
          </span>
        ) : null}
      </div>
    );
  };

  const empty = loaded.status === "ready" && !loaded.rows.length && !loaded.folders.length;

  return (
    <div className={styles.tree}>
      <div className={styles.toolbar}>
        <button type="button" className={styles.tool} title={tt.newFolder} aria-label={tt.newFolder} onClick={() => void newFolder(null)}>
          <Icon name="folderPlus" />
        </button>
        <button
          type="button"
          className={styles.tool}
          title={tt.search}
          aria-label={tt.search}
          aria-pressed={searching}
          onClick={() => {
            setSearching((was) => !was);
            setQuery("");
          }}
        >
          <Icon name="search" />
        </button>
        <button type="button" className={styles.tool} title={tt.collapseAll} aria-label={tt.collapseAll} onClick={() => setOpen(new Set())}>
          <Icon name="collapseAll" />
        </button>
        <span className={styles.toolbarGap} />
        <button type="button" className={styles.tool} title={tt.hide} aria-label={tt.hide} onClick={onHide}>
          <Icon name="sidebar" />
        </button>
      </div>
      {searching ? (
        <input
          type="search"
          className={styles.search}
          autoFocus
          value={query}
          placeholder={tt.search}
          aria-label={t.searchLabel}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setSearching(false);
              setQuery("");
            } else if (event.key === "ArrowDown" && rows.length) {
              event.preventDefault();
              focusRow.current = true;
              select([rows[0].node.key], rows[0].node.key);
              setAnchor(rows[0].node.key);
            }
          }}
        />
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div
        ref={listRef}
        className={`${styles.list} ${drag?.at?.kind === "top" && drag.landing ? styles.dropTop : ""}`}
        role="tree"
        aria-label={tt.label}
        aria-multiselectable="true"
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          kept.scrollTop = event.currentTarget.scrollTop;
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu({ x: event.clientX, y: event.clientY }, null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setSelected(new Set());
        }}
      >
        {loaded.status === "loading" ? null : loaded.status === "error" ? (
          <div className={styles.quiet}>
            <span>{t.loadError}</span>
            <ToolButton size="sm" onClick={() => setAttempt((n) => n + 1)}>
              {t.retry}
            </ToolButton>
          </div>
        ) : empty ? (
          <p className={styles.quiet}>{tt.none}</p>
        ) : rows.length ? (
          rows.map(renderRow)
        ) : (
          <p className={styles.quiet}>{tt.noMatch}</p>
        )}
      </div>
      {session.queue.length ? (
        <ul className={styles.queue} aria-label={tt.queued}>
          {session.queue.map((request, index) => (
            <li key={index} className={styles.queueRow} title={tt.queued}>
              <span className={styles.mark}>
                <span className={styles.dot} data-status="queued" />
              </span>
              <span className={styles.name}>{request.name}</span>
              <span className={styles.meta}>
                <span className={styles.board}>{boardText(request.at.board)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {drag ? (
        <div className={styles.ghost} style={{ top: drag.y + 12, left: drag.x + 12 }} data-refused={drag.at && !drag.landing ? "" : undefined}>
          {!canMove(tree, drag.keys)
            ? tt.childStays
            : drag.keys.length === 1
              ? (tree.byKey.get(drag.keys[0])?.item.name ?? "")
              : tt.menuMany(drag.keys.length)}
        </div>
      ) : null}

      {hovered?.kind === "lock" && hover && !drag && !menu ? (
        <HoverCard
          row={hovered.item}
          progress={running?.id === hovered.id ? progressLine(t, running) : null}
          anchor={hover.rect}
          onGo={() => {
            setHover(null);
            void openLock(hovered.id);
          }}
          onEnter={clearHoverTimer}
          onLeave={onRowLeave}
        />
      ) : null}

      {menu ? (
        <ContextMenu
          at={menu.at}
          label={menu.keys.length === 1 ? (tree.byKey.get(menu.keys[0])?.item.name ?? tt.label) : menu.keys.length ? tt.menuMany(menu.keys.length) : tt.label}
          items={menuItems(menu.keys)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {deleting ? (
        <Dialog title={deleting.question} onClose={() => (busy ? undefined : setDeleting(null))}>
          <p className={styles.dialogBody}>
            {tt.deleteBody}
            {deleting.solving ? ` ${tt.deleteSolving}` : ""}
          </p>
          <div className={styles.dialogActions}>
            <ToolButton disabled={busy} onClick={() => setDeleting(null)}>
              {t.keep}
            </ToolButton>
            <button type="button" className={`${solverStyles.toolButton} ${styles.danger}`} disabled={busy} onClick={() => void confirmDelete()}>
              {busy ? t.deleting : t.delete}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
