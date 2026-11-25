/**
 * Training sessions (`docs/TRAINER.md` §7): a name and the Trainer's
 * settings, fixed for the session's life, and every answer given in it. The
 * player picks what to train once, trains it any day, and reviews its
 * history; a change of settings starts a new session.
 *
 * Each answer keeps the deal that gave its spot (`SpotRef`: the request and
 * the seed - the generators are pure in their seed), so a session can deal a
 * spot again ("repeat played spots") and show what the player answered then.
 *
 * Pure apart from {@link localSessionStore} (the app's and the web's
 * fallback store: this device's storage, which may fail - then the session
 * lives for the visit).
 */

import { GRADES, type DecisionAnalysis, type Grade } from "../../lib/analysis/types";
import type { TrainerSpot } from "../../lib/training";
import { ANALYTICS } from "../../lib/stats/analytics";
import type { TrainerDict } from "./host";
import { DEFAULT_SETTINGS, parseSettings, settingsFields, type Repeat, type SpotRequest, type TrainerSettings } from "./settings";

/** The deal that gives a spot again. */
export interface SpotRef {
  request: SpotRequest;
  seed: number;
}

/** One graded answer in a session. */
export interface SessionAnswer {
  /** ISO time. */
  at: string;
  street: "preflop" | "flop" | "turn" | "river";
  /** The hero's cards and the board, `Kd` each, concatenated. */
  cards: string;
  board: string;
  /** What makes two answers the same spot ({@link spotKey}). */
  spotKey: string;
  position: string | null;
  handClass: string | null;
  /** The answer as its button read, and the reference's best move. */
  move: string;
  best: string;
  grade: Grade;
  evLoss: number;
  score: number;
  /** Null for a whole hand's decision (not dealt again). */
  ref: SpotRef | null;
  /**
   * The answer's action (`fold`, `check`, `call`, `bet`, `raise`) and the
   * reference's frequency of each action for the hand: what the goal from
   * Analytics counts (`analytics.ts`, `drillGoal`). Kept on the device and
   * in the visit; the account keeps neither, so an answer read back from it
   * has none.
   */
  action?: string;
  mix?: Record<string, number>;
}

/** An answer's action and the reference's mix for the hand, from its graded decision. */
export function answerMix(decision: Pick<DecisionAnalysis, "action" | "chosen" | "options">): { action: string; mix: Record<string, number> } {
  const mix: Record<string, number> = {};
  for (const option of decision.options) mix[option.action] = Math.round(((mix[option.action] ?? 0) + option.freq) * 10_000) / 10_000;
  const chosen = decision.chosen !== null ? decision.options[decision.chosen] : undefined;
  return { action: chosen?.action ?? decision.action, mix };
}

export interface TrainerSession {
  id: string;
  name: string;
  /** The settings that differ from the defaults (`settingsFields`). */
  fields: Record<string, string>;
  archived: boolean;
  createdAt: string;
  playedAt: string;
  /** Answers counted (the store's sums; the session's own answers once loaded). */
  hands: number;
  today: number;
  scoreSum: number;
  evLoss: number;
  counts: Record<Grade, number>;
}

/** Where sessions live: the account (web) or this device (the app, a web without a database). */
export interface SessionStore {
  list(): Promise<TrainerSession[]>;
  /** Create or update (name, settings, archived). */
  save(session: Pick<TrainerSession, "id" | "name" | "fields" | "archived">): Promise<void>;
  /** The session's answers, oldest first. */
  answers(id: string): Promise<SessionAnswer[]>;
  /** Keep one answer (fire and forget: a failure is retried or dropped by the store). */
  record(id: string, answer: SessionAnswer): void;
}

/** One spot in this many comes back from the session's own. */
export const REPEAT_EVERY: Record<Repeat, number> = { off: 0, some: 6, often: 3 };
/** A spot answered this recently is not dealt again yet. */
const REPEAT_GAP = 12;

export function emptyCounts(): Record<Grade, number> {
  return Object.fromEntries(GRADES.map((g) => [g, 0])) as Record<Grade, number>;
}

export function newSessionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

/** The settings a session trains. */
export function sessionSettings(session: Pick<TrainerSession, "fields">): TrainerSettings {
  return parseSettings(session.fields);
}

/**
 * Whether two settings deal and train the same: every field but the panels
 * shown (strategy, range), which change nothing about the spots.
 */
export function sameTraining(a: TrainerSettings, b: TrainerSettings): boolean {
  const strip = (s: TrainerSettings) => {
    // Analytics' figures (your rate, the target, the cost) change with every new hand; the stat and the spot do not.
    const from = s.from ? { stat: s.from.stat, spot: s.from.spot, you: null, ref: null, cost: null } : null;
    const fields = settingsFields({ ...s, from, strategy: DEFAULT_SETTINGS.strategy, range: DEFAULT_SETTINGS.range });
    return JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k]]));
  };
  return strip(a) === strip(b);
}

/** The key two answers share when they were given on the same spot: the same node and the same cards. */
export function spotKey(spot: TrainerSpot): string {
  const cards = [...spot.cards].sort().join("");
  if (spot.kind === "preflop") return ["preflop", spot.set, spot.line || "-", spot.hero, cards].join("|");
  const node = spot.kind === "flop" ? `${spot.lineId}:${spot.path}` : `${spot.lineId}:${spot.facing?.kind ?? "x"}`;
  return [spot.kind, spot.set, node, spot.hero, cards, spot.board.join("")].join("|");
}

/** A key for a whole hand's decision: its street, the hero's seat, cards and board. */
export function handDecisionKey(street: string, hero: string, cards: readonly string[], board: readonly string[]): string {
  return ["hand", street, hero, [...cards].sort().join(""), board.join("")].join("|");
}

export const cardsText = (cards: readonly string[]) => cards.join("");
export const cardsOf = (text: string): string[] => text.match(/../g) ?? [];

/* ----------------------------------------------------------- figures - */

export interface SessionFigures {
  hands: number;
  /** Mean move score, 0–100; null before the first answer. */
  score: number | null;
  evLoss: number;
  counts: Record<Grade, number>;
  bestStreak: number;
  /** Spots answered more than once, and how many of their latest answers were right. */
  repeated: number;
  repeatedRight: number;
}

const RIGHT: readonly Grade[] = ["perfect", "good"];

export function figuresOf(answers: readonly SessionAnswer[]): SessionFigures {
  const counts = emptyCounts();
  let scoreSum = 0;
  let evLoss = 0;
  let streak = 0;
  let bestStreak = 0;
  const bySpot = new Map<string, SessionAnswer[]>();
  for (const a of answers) {
    counts[a.grade] += 1;
    scoreSum += a.score;
    evLoss += Math.max(0, a.evLoss);
    streak = RIGHT.includes(a.grade) ? streak + 1 : 0;
    bestStreak = Math.max(bestStreak, streak);
    const list = bySpot.get(a.spotKey);
    if (list) list.push(a);
    else bySpot.set(a.spotKey, [a]);
  }
  let repeated = 0;
  let repeatedRight = 0;
  for (const list of bySpot.values()) {
    if (list.length < 2) continue;
    repeated += 1;
    if (RIGHT.includes(list[list.length - 1].grade)) repeatedRight += 1;
  }
  return { hands: answers.length, score: answers.length ? scoreSum / answers.length : null, evLoss, counts, bestStreak, repeated, repeatedRight };
}

/** The answers given since local midnight. */
export function todayOf(answers: readonly SessionAnswer[], now = new Date()): SessionAnswer[] {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return answers.filter((a) => Date.parse(a.at) >= from);
}

/** A session's list figures from its answers (a store that keeps answers, not sums). */
export function sessionTotals(answers: readonly SessionAnswer[], now = new Date()): Pick<TrainerSession, "hands" | "today" | "scoreSum" | "evLoss" | "counts"> {
  const counts = emptyCounts();
  let scoreSum = 0;
  let evLoss = 0;
  for (const a of answers) {
    counts[a.grade] += 1;
    scoreSum += a.score;
    evLoss += Math.max(0, a.evLoss);
  }
  return { hands: answers.length, today: todayOf(answers, now).length, scoreSum, evLoss, counts };
}

/* ------------------------------------------------------------ repeats - */

/**
 * The spot to deal again, or null for a new one: about one deal in
 * `REPEAT_EVERY[repeat]`, a spot of the session's own whose latest answer was
 * worst (mistakes first), not answered in the last few deals. `roll` is a
 * number in [0, 1).
 */
export function pickRepeat(answers: readonly SessionAnswer[], repeat: Repeat, roll: number, pickRoll: number): SessionAnswer | null {
  const every = REPEAT_EVERY[repeat];
  if (!every || roll >= 1 / every) return null;
  const recent = new Set(answers.slice(-REPEAT_GAP).map((a) => a.spotKey));
  const latest = new Map<string, SessionAnswer>();
  for (const a of answers) if (a.ref) latest.set(a.spotKey, a);
  const candidates = [...latest.values()].filter((a) => !recent.has(a.spotKey));
  if (candidates.length === 0) return null;
  const rank = (g: Grade) => GRADES.indexOf(g);
  const worst = Math.max(...candidates.map((a) => rank(a.grade)));
  // Mistakes and worse first; when every latest answer was right, any of them.
  const pool = worst >= rank("inaccurate") ? candidates.filter((a) => rank(a.grade) >= rank("inaccurate")) : candidates;
  return pool[Math.min(pool.length - 1, Math.floor(pickRoll * pool.length))] ?? null;
}

/** The earlier answers on a spot, oldest first. */
export function earlierOn(answers: readonly SessionAnswer[], key: string): SessionAnswer[] {
  return answers.filter((a) => a.spotKey === key);
}

/* --------------------------------------------------------------- names - */

/** A session's name from its settings: "BB vs BTN open", "Flop · BTN vs BB · facing a bet". */
export function defaultName(s: TrainerSettings, t: TrainerDict): string {
  const n = t.sessions.names;
  const lang = t.lang === "hr" ? "hr" : "en";
  let name: string;
  const stat = s.from ? ANALYTICS.get(s.from.stat) : undefined;
  if (stat && s.mode !== "focus") {
    // From Analytics: "Flop · BB vs SB · Fold vs bet · 20–40%".
    const bucket = s.size ? ANALYTICS.file.sizeBuckets.find((b) => b.id === s.size) : undefined;
    const seats = s.seat ? (s.vs ? t.play.vs(s.seat, s.vs) : s.seat) : null;
    name = [t.modes[s.mode], seats, stat.label[lang], bucket?.label[lang]].filter(Boolean).join(" · ");
    return name.slice(0, 60);
  }
  if (s.mode === "focus") name = t.modes.focus;
  else if (s.mode === "preflop") {
    const seat = s.seat ?? n.anySeat;
    if (s.family === "rfi") name = n.firstIn(seat);
    else if (s.family === "random") name = s.seat || s.vs ? n.versus(seat, s.vs ?? t.any.toLowerCase(), "") : t.modes.preflop;
    else {
      // "vs open" after "BB vs BTN" reads "open": the family's own "vs" (or "protiv") is dropped.
      const what = s.family === "bvb" ? "" : (t.families[s.family] ?? s.family).replace(/^(vs|protiv)\s+/i, "").toLowerCase();
      name = n.versus(seat, s.vs ?? t.any.toLowerCase(), what);
    }
  } else {
    const parts: string[] = [t.modes[s.mode]];
    if (s.seat) parts.push(s.seat);
    if (s.pot !== "any") parts.push((t.pots[s.pot] ?? s.pot).toLowerCase());
    if (s.side !== "any") parts.push((t.sides[s.side] ?? s.side).toLowerCase());
    if (s.facing !== "any") parts.push(`${t.facing.toLowerCase()} ${(t.facings[s.facing] ?? s.facing).toLowerCase()}`);
    // A bet size chosen in the sheet (the catalogue's label, `20–40%`).
    const bucket = s.size ? ANALYTICS.file.sizeBuckets.find((b) => b.id === s.size) : undefined;
    if (bucket) parts.push(bucket.label[lang]);
    name = parts.join(" · ");
  }
  if (s.play === "hand") name += ` · ${t.play.hand.toLowerCase()}`;
  return name.slice(0, 60);
}

/* --------------------------------------------------------------- times - */

/** "Today 08:40", "Yesterday 21:12", "13 Nov". */
export function whenText(iso: string, t: TrainerDict, locale: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const time = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return t.sessions.when.today(time);
  if (days === 1) return t.sessions.when.yesterday(time);
  return at.toLocaleDateString(locale, { day: "numeric", month: "short", ...(at.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** The local day an answer was given, `YYYY-MM-DD`. */
export function dayOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The kind of preflop hand a class is, for the review's grouping. */
export function handType(handClass: string | null): string {
  if (!handClass) return "other";
  const [a, b] = [handClass[0], handClass[1]];
  if (a === b) return "pairs";
  if (a === "A") return "aces";
  const broad = "TJQK";
  if (broad.includes(a) && (broad.includes(b) || a === "K")) return "broadway";
  const order = "23456789TJQKA";
  if (handClass.endsWith("s") && Math.abs(order.indexOf(a) - order.indexOf(b)) <= 3) return "suited";
  return "other";
}

/* ----------------------------------------------------------- the store - */

const LIST_KEY = "rail.trainer.sessions";
const ANSWERS_KEY = "rail.trainer.session.";
/** Answers kept per session on a device, newest kept. */
export const LOCAL_ANSWERS_MAX = 1500;

interface StoredSession {
  id: string;
  name: string;
  fields: Record<string, string>;
  archived: boolean;
  createdAt: string;
  playedAt: string;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Answers read back from storage: anything malformed dropped. */
export function parseAnswers(raw: unknown): SessionAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is SessionAnswer =>
      Boolean(a) && typeof a.at === "string" && typeof a.spotKey === "string" && typeof a.cards === "string" && (GRADES as readonly string[]).includes(a.grade),
  );
}

/**
 * Sessions on this device (the app; the web without a database): the list
 * under one key, each session's answers under its own. Storage that fails
 * keeps them in memory for the visit.
 */
export function localSessionStore(): SessionStore {
  const memory = new Map<string, unknown>();
  const read = <T>(key: string, fallback: T): T => (memory.has(key) ? (memory.get(key) as T) : readJson(key, fallback));
  const write = (key: string, value: unknown) => {
    if (writeJson(key, value)) memory.delete(key);
    else memory.set(key, value);
  };
  const stored = () => read<StoredSession[]>(LIST_KEY, []).filter((s) => s && typeof s.id === "string" && typeof s.name === "string");
  const answersOf = (id: string) => parseAnswers(read<unknown>(ANSWERS_KEY + id, []));
  return {
    async list() {
      return stored()
        .map((s) => ({ ...s, fields: settingsFields(parseSettings(s.fields)), ...sessionTotals(answersOf(s.id)) }))
        .sort((a, b) => b.playedAt.localeCompare(a.playedAt));
    },
    async save(session) {
      const now = new Date().toISOString();
      const list = stored();
      const at = list.findIndex((s) => s.id === session.id);
      const next: StoredSession = {
        id: session.id,
        name: session.name.trim().slice(0, 60),
        fields: session.fields,
        archived: session.archived,
        createdAt: at >= 0 ? list[at].createdAt : now,
        playedAt: at >= 0 ? list[at].playedAt : now,
      };
      write(LIST_KEY, at >= 0 ? list.map((s, i) => (i === at ? next : s)) : [next, ...list]);
    },
    async answers(id) {
      return answersOf(id);
    },
    record(id, answer) {
      write(ANSWERS_KEY + id, [...answersOf(id), answer].slice(-LOCAL_ANSWERS_MAX));
      write(
        LIST_KEY,
        stored().map((s) => (s.id === id ? { ...s, playedAt: answer.at } : s)),
      );
    },
  };
}
