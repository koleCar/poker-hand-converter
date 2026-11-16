/**
 * The Trainer's sessions in the account (`20271116090000_trainer_sessions.sql`):
 * the web's `SessionStore` (`components/trainer/sessions.ts`). Sessions are
 * written by `save_trainer_session`, answers by
 * `record_trainer_session_answers` (fifty at a time, after the session's own
 * save, retried with the next answer when a call fails), the list with its
 * figures read by `trainer_session_list`, a session's answers from the table
 * (RLS keeps them the caller's).
 */

import { GRADES, type Grade } from "../analysis/types";
import { parseSettings, settingsFields, type SpotRequest } from "../../components/trainer/settings";
import { emptyCounts, type SessionAnswer, type SessionStore, type TrainerSession } from "../../components/trainer/sessions";
import { requireDb, rpc } from "./client";

type Row = Record<string, unknown>;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const isGrade = (value: unknown): value is Grade => typeof value === "string" && (GRADES as readonly string[]).includes(value);
/** The answers a session reads back, newest kept. */
const ANSWERS_MAX = 5000;
const BATCH = 50;

function sessionOf(row: Row): TrainerSession {
  const counts = emptyCounts();
  const raw = (row.counts ?? {}) as Row;
  for (const g of GRADES) counts[g] = num(raw[g]);
  const settings = typeof row.settings === "object" && row.settings !== null ? (row.settings as Record<string, unknown>) : {};
  return {
    id: text(row.id),
    name: text(row.name),
    fields: settingsFields(parseSettings(settings)),
    archived: row.archived === true,
    createdAt: text(row.created_at),
    playedAt: text(row.played_at),
    hands: num(row.hands),
    today: num(row.today),
    scoreSum: num(row.score_sum),
    evLoss: num(row.ev_loss),
    counts,
  };
}

function answerOf(row: Row): SessionAnswer | null {
  if (!isGrade(row.grade)) return null;
  const street = text(row.street);
  if (street !== "preflop" && street !== "flop" && street !== "turn" && street !== "river") return null;
  const ref = row.spot_ref as { request?: SpotRequest; seed?: unknown } | null;
  return {
    at: text(row.created_at),
    street,
    cards: text(row.cards),
    board: text(row.board),
    spotKey: text(row.spot_key),
    position: text(row.position) || null,
    handClass: text(row.hand_class) || null,
    move: text(row.move),
    best: text(row.best),
    grade: row.grade,
    evLoss: num(row.ev_loss_bb),
    score: num(row.score),
    ref: ref && typeof ref === "object" && ref.request && typeof ref.seed === "number" ? { request: ref.request, seed: ref.seed } : null,
  };
}

/** Within the table's checks: a value the table would refuse is clipped, never sent to fail the batch. */
function rowOf(answer: SessionAnswer): Row {
  const position = answer.position && /^[A-Z0-9+]{1,8}$/.test(answer.position) ? answer.position : null;
  const handClass = answer.handClass && /^[2-9TJQKA]{2}[so]?$/.test(answer.handClass) ? answer.handClass : null;
  return {
    at: answer.at,
    street: answer.street,
    cards: answer.cards,
    board: answer.board,
    spot_key: answer.spotKey.slice(0, 300),
    position,
    hand_class: handClass,
    move: answer.move.slice(0, 60) || "?",
    best: answer.best.slice(0, 60),
    grade: answer.grade,
    ev_loss_bb: Math.max(0, Math.min(1000, answer.evLoss)),
    score: Math.max(0, Math.min(100, answer.score)),
    spot_ref: answer.ref,
  };
}

export function accountSessionStore(): SessionStore {
  // A session's save in flight: its answers wait for it (the answers' session must exist).
  const saving = new Map<string, Promise<unknown>>();
  // Answers not kept yet, per session; sent in order, fifty at a time.
  const outbox = new Map<string, Row[]>();
  const sending = new Set<string>();

  const flush = async (id: string): Promise<void> => {
    if (sending.has(id)) return;
    sending.add(id);
    try {
      await saving.get(id)?.catch(() => undefined);
      for (;;) {
        const queue = outbox.get(id) ?? [];
        if (queue.length === 0) break;
        const batch = queue.slice(0, BATCH);
        await rpc("record_trainer_session_answers", { p_session: id, p_rows: batch });
        outbox.set(id, (outbox.get(id) ?? []).slice(batch.length));
      }
    } catch {
      // Kept for the next answer's try.
    } finally {
      sending.delete(id);
    }
  };

  return {
    async list() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const payload = await rpc<unknown>("trainer_session_list", { p_today_from: today.toISOString() });
      return (Array.isArray(payload) ? (payload as Row[]) : []).map(sessionOf).filter((s) => s.id);
    },
    async save(session) {
      const call = rpc("save_trainer_session", {
        p_id: session.id,
        p_name: session.name.trim().slice(0, 60),
        p_settings: session.fields,
        p_archived: session.archived,
      });
      const before = saving.get(session.id);
      saving.set(session.id, before ? before.then(() => call, () => call) : call);
      await call;
    },
    async answers(id) {
      const { data, error } = await requireDb()
        .from("trainer_session_answers")
        .select("created_at, street, cards, board, spot_key, position, hand_class, move, best, grade, ev_loss_bb, score, spot_ref")
        .eq("session_id", id)
        .order("created_at", { ascending: false })
        .limit(ANSWERS_MAX);
      if (error) throw new Error(error.message);
      return (data ?? [])
        .map((row) => answerOf(row as Row))
        .filter((a): a is SessionAnswer => a !== null)
        .reverse();
    },
    record(id, answer) {
      outbox.set(id, [...(outbox.get(id) ?? []), rowOf(answer)]);
      void flush(id);
    },
  };
}
