/**
 * The Trainer's answers on their way to the account: each graded answer is
 * put here first (this computer's storage), then sent in calls of at most
 * fifty (`trainer_results_record`, Rust, `record_trainer_results` with the
 * account's token) - so an answer given offline, signed out or over the
 * rate limit is kept and goes the next time: after the next answer, when
 * the Trainer opens, or when the account signs in.
 *
 * A refusal that will not change (a row the server would refuse, a bug) is
 * dropped with its batch rather than sent forever; a wait (signed out, the
 * plan, the rate limit, no account in this build, offline) keeps the rows.
 */
import { errorText, inApp, ipc, TRAINER_SYNC_WAIT, type TrainerResultDto } from "../lib/ipc";

const KEY = "rail.trainer.outbox";
/** Answers kept waiting at most (the oldest go first when it is full). */
export const OUTBOX_MAX = 1000;
const PER_CALL = 50;

export function readOutbox(): TrainerResultDto[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? (raw as TrainerResultDto[]).slice(-OUTBOX_MAX) : [];
  } catch {
    return [];
  }
}

function writeOutbox(rows: readonly TrainerResultDto[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rows.slice(-OUTBOX_MAX)));
  } catch {
    // A webview without storage: the answer is not kept.
  }
}

export function enqueue(row: TrainerResultDto): void {
  writeOutbox([...readOutbox(), row]);
}

/** Whether a failure is a wait (keep the rows) rather than a refusal (drop the batch). */
export function isWait(message: string): boolean {
  // A code from Rust, or the bridge itself failing (an IPC error, not the server's answer).
  return (TRAINER_SYNC_WAIT as readonly string[]).includes(message) || /not reachable|offline|timed out|ipc|invoke/i.test(message);
}

let flushing: Promise<void> | null = null;

/** Sends what waits, a batch at a time; one flush at a time. */
export function flushOutbox(): Promise<void> {
  if (!inApp) return Promise.resolve();
  flushing ??= (async () => {
    try {
      for (let rounds = 0; rounds < OUTBOX_MAX / PER_CALL; rounds += 1) {
        const rows = readOutbox();
        if (rows.length === 0) return;
        const batch = rows.slice(0, PER_CALL);
        try {
          await ipc.trainerResultsRecord(batch);
        } catch (error) {
          if (isWait(errorText(error))) return;
          // Refused for good: these rows would be refused again.
        }
        // Drop what was sent (or refused), keeping anything queued meanwhile.
        writeOutbox(readOutbox().slice(batch.length));
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}
