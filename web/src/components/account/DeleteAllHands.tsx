"use client";

/**
 * Settings -> Danger zone -> Delete all hands (20271119200000): every hand
 * of the library, after the word DELETE is typed; the server works in ~4 s
 * steps and the dialog shows how far it is. Forum posts stay.
 */

import { Icon } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useState } from "react";
import { countMyHands, deleteAllHands } from "../../lib/db";
import { notifyHandsChanged } from "../../lib/db/handsSource";
import { useEntitlements } from "../../lib/entitlements/context";
import { useDict } from "../../lib/i18n/client";
import { DeleteHandsDialog } from "../library/DeleteHandsDialog";
import rows from "./rows.module.css";

type State =
  | { kind: "idle" }
  | { kind: "counting" }
  | { kind: "confirm"; count: number }
  | { kind: "empty" }
  | { kind: "done"; deleted: number }
  | { kind: "failed"; message: string };

export function DeleteAllHands() {
  const en = useDict();
  const t = en.converter.library.delete;
  const { refresh } = useEntitlements();
  const [state, setState] = useState<State>({ kind: "idle" });

  async function open() {
    setState({ kind: "counting" });
    try {
      const count = await countMyHands();
      setState(count > 0 ? { kind: "confirm", count } : { kind: "empty" });
    } catch (error) {
      setState({ kind: "failed", message: t.failed(error instanceof Error ? error.message : String(error)) });
    }
  }

  return (
    <div className={rows.tile}>
      <span className={rows.dangerIcon} aria-hidden="true">
        <Icon name="trash" />
      </span>
      <span className={rows.value}>
        <span className={rows.strong}>{t.allTitle}</span>
        <span className={rows.muted}>{t.allHint}</span>
        {state.kind === "empty" ? <span className={rows.muted}>{t.allEmpty}</span> : null}
        {state.kind === "done" ? (
          <span className={rows.success} role="status">
            {t.allDone(state.deleted)}
          </span>
        ) : null}
        {state.kind === "failed" ? (
          <span className={rows.error} role="alert">
            {state.message}
          </span>
        ) : null}
      </span>
      <span className={rows.actions}>
        <button
          type="button"
          className={`btn btn--sm ${rows.dangerButton}`}
          disabled={state.kind === "counting"}
          onClick={() => void open()}
        >
          {state.kind === "counting" ? <RailLoader size="inline" label={t.allOpen} delay={0} /> : t.allOpen}
        </button>
      </span>
      {state.kind === "confirm" ? (
        <DeleteHandsDialog
          count={state.count}
          all
          run={(onProgress) => deleteAllHands(state.count, onProgress)}
          onClose={() => setState({ kind: "idle" })}
          onDone={(deleted) => {
            setState({ kind: "done", deleted });
            notifyHandsChanged();
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
