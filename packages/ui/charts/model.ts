/**
 * The user's own preflop charts (R5.3): what one is, how it is stored, how
 * it is checked. Pure and framework-free, so both surfaces and the tests run
 * it, and the database checks the same shape (`preflop_chart_sets`,
 * `20270811090000_preflop_charts.sql`).
 *
 * **A chart set** is the user's: a name, the game it is for (cash or
 * tournament, a table size, a range of stack depths) and, per **situation**
 * (a node), how often each of the 169 hand classes raises, calls and goes
 * all in. Whatever is left of a class's 100 % is the node's rest action:
 * fold, or check for the big blind facing limpers.
 *
 * **Situations use the shipped charts' vocabulary** (`docs/CHARTS.md` §6.1:
 * the scenarios `rfi`, `vs-limp`, `vs-open`, `squeeze`, `vs-iso`, `vs-3bet`,
 * `vs-4bet`, `vs-allin`, and the stats engine's seat names), keyed
 * `scenario:hero[:villain]` - `rfi:CO`, `vs-open:BB:BTN`, `vs-3bet:CO:BTN`.
 * The villain is the last raiser (the first limper for `vs-limp`). Where the
 * shipped tree has many lines per key (callers before a squeeze), the key
 * collapses them; lines the vocabulary does not name (a cold 4-bet, a 3-bet
 * pot with a caller, anything after an iso-raise but the limper's answer)
 * have no key, so they are compared against nothing ({@link ./nodeKey.ts}).
 *
 * **Frequencies are whole percents** (0-100 per action per class, an action's
 * sum over a class at most 100): what a person paints or types, and what an
 * imported weight (`AKs:0.33`, a combo list) rounds to. Stored as base64 of
 * 169 bytes per action, in the shipped charts' class order (row x 13 + column
 * of the 13 x 13 grid, ace first; pairs on the diagonal, suited above it).
 */

/** The stored format's version: a later change migrates rows by it. */
export const CHART_FORMAT_VERSION = 1;

export const RANKS = "AKQJT98765432";
export const CLASS_COUNT = 169;

/** Limits, held by the database too. */
export const LIMITS = {
  /** Chart sets per account. */
  sets: 50,
  /** Situations per set: a 9-max set has 252 possible keys. */
  nodes: 300,
  name: 80,
  /** Stack depths a set can cover, big blinds. */
  minBb: 1,
  maxBb: 1000,
  /** The stored nodes as JSON, bytes. */
  bytes: 409_600,
} as const;

/* ---------------------------------------------------------------- classes - */

/** The class at a grid cell: pairs on the diagonal, suited above it, offsuit below. */
export function classAt(row: number, col: number): string {
  const a = RANKS[row];
  const b = RANKS[col];
  if (row === col) return `${a}${a}`;
  return row < col ? `${a}${b}s` : `${b}${a}o`;
}

/** Every class in index order (`row * 13 + col`). */
export const CLASS_NAMES: readonly string[] = Array.from({ length: CLASS_COUNT }, (_, i) => classAt(Math.floor(i / 13), i % 13));

const CLASS_INDEX = new Map(CLASS_NAMES.map((name, i) => [name, i]));

/** Index of a class name (`AKs`, `AKo`, `77`); -1 when it is not one. `KAs` reads as `AKs`. */
export function classIndex(name: string): number {
  const direct = CLASS_INDEX.get(name);
  if (direct !== undefined) return direct;
  if (name.length === 3 && (name[2] === "s" || name[2] === "o")) {
    return CLASS_INDEX.get(`${name[1]}${name[0]}${name[2]}`) ?? -1;
  }
  return -1;
}

/** Combos of a class before card removal: 6 for a pair, 4 suited, 12 offsuit. */
export function combosOf(index: number): number {
  const row = Math.floor(index / 13);
  const col = index % 13;
  return row === col ? 6 : row < col ? 4 : 12;
}

/* ------------------------------------------------------------- positions - */

export type Position = "UTG" | "UTG+1" | "UTG+2" | "LJ" | "HJ" | "CO" | "BTN" | "SB" | "BB";
export type TableSize = 2 | 6 | 9;
export const TABLE_SIZES: readonly TableSize[] = [6, 9, 2];

/**
 * The seats in preflop action order, as the shipped sets name them: a 6-max
 * set reads 3-6 players, a 9-max set 7-9, heads-up two (the small blind is
 * the button and acts first preflop).
 */
export const TABLE_POSITIONS: Record<TableSize, readonly Position[]> = {
  2: ["SB", "BB"],
  6: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
  9: ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
};

export type GameFormat = "cash" | "tournament";

/* ------------------------------------------------------------------ nodes - */

export const SCENARIOS = ["rfi", "vs-limp", "vs-open", "squeeze", "vs-iso", "vs-3bet", "vs-4bet", "vs-allin"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface NodeKey {
  scenario: Scenario;
  hero: Position;
  /** The last raiser; the first limper for `vs-limp`; null for `rfi`. */
  vs: Position | null;
}

/** What a chart stores per class; the rest of 100 % is the node's rest action. */
export const CHART_ACTIONS = ["raise", "call", "allin"] as const;
export type ChartActionName = (typeof CHART_ACTIONS)[number];
export type RestAction = "fold" | "check";
/** What a played decision did, in the chart's words. */
export type PlayedAction = ChartActionName | RestAction;
export const PLAYED_ACTIONS: readonly PlayedAction[] = ["fold", "check", "call", "raise", "allin"];

export function formatNodeKey(key: NodeKey): string {
  return key.vs ? `${key.scenario}:${key.hero}:${key.vs}` : `${key.scenario}:${key.hero}`;
}

/**
 * Whether a key names a situation that can happen at this table: the seats
 * belong to it and act in an order the scenario allows (the villain of
 * `vs-open` acted before the hero; the 3-bettor of `vs-3bet` after the
 * opener; a squeeze has a seat between them for the caller).
 */
export function isPlausible(key: NodeKey, tableSize: TableSize): boolean {
  const seats = TABLE_POSITIONS[tableSize];
  const h = seats.indexOf(key.hero);
  if (h < 0) return false;
  if (key.scenario === "rfi") return key.vs === null && key.hero !== "BB";
  if (key.vs === null) return false;
  const v = seats.indexOf(key.vs);
  if (v < 0 || v === h) return false;
  switch (key.scenario) {
    case "vs-limp":
    case "vs-open":
    case "vs-4bet":
      // The villain acted first (limped or opened); the big blind cannot open.
      return v < h && key.vs !== "BB";
    case "squeeze":
      return v < h - 1 && key.vs !== "BB";
    case "vs-iso":
    case "vs-3bet":
    case "vs-allin":
      // The hero acted first (limped or opened); the villain raised behind.
      return h < v && key.hero !== "BB";
  }
}

const KEY_RE = /^([a-z0-9-]+):([A-Z0-9+]{2,5})(?::([A-Z0-9+]{2,5}))?$/;

/** A key's parts, or null when it is not one (for this table, when given). */
export function parseNodeKey(text: string, tableSize?: TableSize): NodeKey | null {
  const m = KEY_RE.exec(text);
  if (!m) return null;
  const scenario = m[1] as Scenario;
  if (!SCENARIOS.includes(scenario)) return null;
  const all = TABLE_POSITIONS[9] as readonly string[];
  if (!all.includes(m[2]) || (m[3] !== undefined && !all.includes(m[3]))) return null;
  const key: NodeKey = { scenario, hero: m[2] as Position, vs: (m[3] as Position | undefined) ?? null };
  if (tableSize !== undefined) return isPlausible(key, tableSize) ? key : null;
  return [2, 6, 9].some((size) => isPlausible(key, size as TableSize)) ? key : null;
}

/** Every situation of a table, in the order the editor lists them: by scenario, then hero, then villain. */
export function nodeKeysFor(tableSize: TableSize): NodeKey[] {
  const seats = TABLE_POSITIONS[tableSize];
  const out: NodeKey[] = [];
  for (const scenario of SCENARIOS) {
    for (const hero of seats) {
      if (scenario === "rfi") {
        const key: NodeKey = { scenario, hero, vs: null };
        if (isPlausible(key, tableSize)) out.push(key);
        continue;
      }
      for (const vs of seats) {
        const key: NodeKey = { scenario, hero, vs };
        if (isPlausible(key, tableSize)) out.push(key);
      }
    }
  }
  return out;
}

/** The action a class takes with what is left of its 100 %: check for the big blind facing limpers. */
export function restActionOf(key: NodeKey): RestAction {
  return key.scenario === "vs-limp" && key.hero === "BB" ? "check" : "fold";
}

/** The actions a node can store: the big blind facing limpers cannot call. */
export function actionsOf(key: NodeKey): ChartActionName[] {
  return restActionOf(key) === "check" ? ["raise", "allin"] : ["raise", "call", "allin"];
}

/* ------------------------------------------------------------- chart sets - */

export interface ChartNode {
  /** Per action, 169 whole percents. */
  freq: Record<ChartActionName, Uint8Array>;
  /** The raise size the user plays here, big blinds (informational). */
  raiseBb: number | null;
}

export interface ChartSetMeta {
  /** The database row's id; null before the first save. */
  id: string | null;
  name: string;
  gameFormat: GameFormat;
  tableSize: TableSize;
  stackMinBb: number;
  stackMaxBb: number;
  /** `CHART_FORMAT_VERSION` of the stored nodes. */
  version: number;
  updatedAt: string | null;
}

export interface ChartSet extends ChartSetMeta {
  /** By key (`formatNodeKey`). */
  nodes: Map<string, ChartNode>;
}

export function emptyNode(): ChartNode {
  return {
    freq: { raise: new Uint8Array(CLASS_COUNT), call: new Uint8Array(CLASS_COUNT), allin: new Uint8Array(CLASS_COUNT) },
    raiseBb: null,
  };
}

export function cloneNode(node: ChartNode): ChartNode {
  return {
    freq: { raise: node.freq.raise.slice(), call: node.freq.call.slice(), allin: node.freq.allin.slice() },
    raiseBb: node.raiseBb,
  };
}

export function newChartSet(meta: Partial<ChartSetMeta> = {}): ChartSet {
  return {
    id: null,
    name: "",
    gameFormat: "cash",
    tableSize: 6,
    stackMinBb: 80,
    stackMaxBb: 120,
    version: CHART_FORMAT_VERSION,
    updatedAt: null,
    ...meta,
    nodes: new Map(),
  };
}

/** A class's percent for an action at a node; the rest action is what is left. */
export function percentOf(node: ChartNode, action: PlayedAction, cls: number): number {
  if (action === "fold" || action === "check") {
    return 100 - node.freq.raise[cls] - node.freq.call[cls] - node.freq.allin[cls];
  }
  return node.freq[action][cls];
}

/** Share of all 1 326 combos a node puts into an action (each class by its combos). */
export function comboShare(node: ChartNode, action: PlayedAction): number {
  let sum = 0;
  for (let i = 0; i < CLASS_COUNT; i += 1) sum += (combosOf(i) * percentOf(node, action, i)) / 100;
  return sum / 1326;
}

/**
 * A node from a mix of actions (a shipped chart node: per option an action
 * name and `freq[option * 169 + class]`, 0-1), as whole percents. Fold and
 * check are the rest; each class's percents are rounded by largest remainder
 * so they never add up past 100.
 */
export function nodeFromMix(actions: readonly string[], freq: ArrayLike<number>): ChartNode {
  const node = emptyNode();
  for (let cls = 0; cls < CLASS_COUNT; cls += 1) {
    const parts: Array<{ action: ChartActionName | null; value: number }> = [
      { action: null, value: 0 },
      { action: "raise", value: 0 },
      { action: "call", value: 0 },
      { action: "allin", value: 0 },
    ];
    actions.forEach((name, a) => {
      const value = Math.max(0, freq[a * CLASS_COUNT + cls]) * 100;
      const slot = name === "raise" ? 1 : name === "call" ? 2 : name === "allin" ? 3 : 0;
      parts[slot].value += value;
    });
    const floors = parts.map((p) => Math.floor(p.value + 1e-9));
    let left = 100 - floors.reduce((sum, v) => sum + v, 0);
    const order = parts
      .map((p, i) => ({ i, r: p.value - floors[i] }))
      .sort((x, y) => y.r - x.r || x.i - y.i);
    for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) floors[order[k].i] += 1;
    for (let i = 1; i < 4; i += 1) node.freq[parts[i].action as ChartActionName][cls] = Math.min(100, floors[i]);
  }
  return node;
}

/* --------------------------------------------------------------- base64 - */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Standard base64 with padding (what Postgres' `decode(…, 'base64')` reads). */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

/** Null when it is not base64 of exactly `length` bytes. */
export function fromBase64(text: string, length: number): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 !== 0) return null;
  const out = new Uint8Array((text.length / 4) * 3);
  let size = 0;
  for (let i = 0; i < text.length; i += 4) {
    const pad = (text[i + 2] === "=" ? 1 : 0) + (text[i + 3] === "=" ? 1 : 0);
    if (pad > 0 && i + 4 !== text.length) return null;
    if (text[i + 2] === "=" && text[i + 3] !== "=") return null;
    let n = 0;
    for (let k = 0; k < 4; k += 1) {
      const c = text[i + k];
      const v = c === "=" ? 0 : B64_INDEX.get(c);
      if (v === undefined) return null;
      n = (n << 6) | v;
    }
    out[size++] = (n >> 16) & 255;
    if (pad < 2) out[size++] = (n >> 8) & 255;
    if (pad < 1) out[size++] = n & 255;
  }
  return size === length ? out.slice(0, size) : null;
}

/* ---------------------------------------------------------- stored shape - */

/** One node as the database stores it: an action left out is 0 everywhere. */
export interface StoredNode {
  raise?: string;
  call?: string;
  allin?: string;
  raiseBb?: number;
}

/** The row as the database holds it (`preflop_chart_sets`). */
export interface StoredChartSet {
  id: string | null;
  name: string;
  game_format: GameFormat;
  table_size: number;
  stack_min_bb: number;
  stack_max_bb: number;
  format_version: number;
  nodes: Record<string, StoredNode>;
  updated_at: string | null;
}

export function encodeNodes(nodes: ReadonlyMap<string, ChartNode>): Record<string, StoredNode> {
  const out: Record<string, StoredNode> = {};
  for (const [key, node] of nodes) {
    const stored: StoredNode = {};
    for (const action of CHART_ACTIONS) {
      if (node.freq[action].some((v) => v > 0)) stored[action] = toBase64(node.freq[action]);
    }
    if (node.raiseBb !== null) stored.raiseBb = node.raiseBb;
    out[key] = stored;
  }
  return out;
}

export function toStored(set: ChartSet): StoredChartSet {
  return {
    id: set.id,
    name: set.name.trim(),
    game_format: set.gameFormat,
    table_size: set.tableSize,
    stack_min_bb: set.stackMinBb,
    stack_max_bb: set.stackMaxBb,
    format_version: CHART_FORMAT_VERSION,
    nodes: encodeNodes(set.nodes),
    updated_at: set.updatedAt,
  };
}

export class ChartDataError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

/** A stored row back to a chart set; throws {@link ChartDataError} on anything malformed. */
export function fromStored(row: StoredChartSet): ChartSet {
  if (row.format_version !== CHART_FORMAT_VERSION) throw new ChartDataError("version", String(row.format_version));
  const tableSize = Number(row.table_size) as TableSize;
  if (!TABLE_SIZES.includes(tableSize)) throw new ChartDataError("table-size", String(row.table_size));
  const set = newChartSet({
    id: row.id,
    name: row.name,
    gameFormat: row.game_format === "tournament" ? "tournament" : "cash",
    tableSize,
    stackMinBb: Number(row.stack_min_bb),
    stackMaxBb: Number(row.stack_max_bb),
    version: row.format_version,
    updatedAt: row.updated_at,
  });
  const nodes = row.nodes && typeof row.nodes === "object" ? row.nodes : {};
  for (const [key, stored] of Object.entries(nodes)) {
    const parsed = parseNodeKey(key, tableSize);
    if (!parsed) throw new ChartDataError("node-key", key);
    const node = emptyNode();
    for (const action of CHART_ACTIONS) {
      const text = stored[action];
      if (text === undefined) continue;
      const bytes = fromBase64(text, CLASS_COUNT);
      if (!bytes) throw new ChartDataError("node-data", key);
      node.freq[action] = bytes;
    }
    if (typeof stored.raiseBb === "number" && Number.isFinite(stored.raiseBb)) node.raiseBb = stored.raiseBb;
    set.nodes.set(formatNodeKey(parsed), node);
  }
  const problems = validateChartSet(set);
  if (problems.length > 0) throw new ChartDataError(problems[0].code, problems[0].detail);
  return set;
}

/* ------------------------------------------------------------ validation - */

export interface ChartProblem {
  code:
    | "name"
    | "stack-range"
    | "too-many-nodes"
    | "node-key"
    | "action-not-allowed"
    | "percent"
    | "over-100"
    | "raise-size"
    | "too-big";
  detail: string;
}

/** Every problem with a set, the first of each kind; empty when it can be saved. */
export function validateChartSet(set: ChartSet): ChartProblem[] {
  const out: ChartProblem[] = [];
  const name = set.name.trim();
  if (name.length < 1 || name.length > LIMITS.name) out.push({ code: "name", detail: name });
  if (
    !Number.isFinite(set.stackMinBb) ||
    !Number.isFinite(set.stackMaxBb) ||
    set.stackMinBb < LIMITS.minBb ||
    set.stackMaxBb > LIMITS.maxBb ||
    set.stackMinBb > set.stackMaxBb
  ) {
    out.push({ code: "stack-range", detail: `${set.stackMinBb}-${set.stackMaxBb}` });
  }
  if (set.nodes.size > LIMITS.nodes) out.push({ code: "too-many-nodes", detail: String(set.nodes.size) });
  for (const [text, node] of set.nodes) {
    const key = parseNodeKey(text, set.tableSize);
    if (!key) {
      out.push({ code: "node-key", detail: text });
      continue;
    }
    const allowed = actionsOf(key);
    for (const action of CHART_ACTIONS) {
      if (!allowed.includes(action) && node.freq[action].some((v) => v > 0)) {
        out.push({ code: "action-not-allowed", detail: `${text} ${action}` });
      }
    }
    for (let i = 0; i < CLASS_COUNT; i += 1) {
      const r = node.freq.raise[i];
      const c = node.freq.call[i];
      const a = node.freq.allin[i];
      if (r > 100 || c > 100 || a > 100) {
        out.push({ code: "percent", detail: `${text} ${CLASS_NAMES[i]}` });
        break;
      }
      if (r + c + a > 100) {
        out.push({ code: "over-100", detail: `${text} ${CLASS_NAMES[i]}` });
        break;
      }
    }
    if (node.raiseBb !== null && !(node.raiseBb > 0 && node.raiseBb <= LIMITS.maxBb)) {
      out.push({ code: "raise-size", detail: `${text} ${node.raiseBb}` });
    }
  }
  if (out.length === 0 && JSON.stringify(encodeNodes(set.nodes)).length > LIMITS.bytes) {
    out.push({ code: "too-big", detail: "" });
  }
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(p.code) ? false : (seen.add(p.code), true)));
}
