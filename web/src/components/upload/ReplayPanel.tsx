/**
 * One pasted hand, replayed under the upload box.
 *
 * The box (`UploadBox`) owns the text; this panel gets a request to replay it,
 * runs the same detection and conversion the batch path uses (the WebAssembly
 * core, or the TypeScript parsers when it cannot load: `lib/wasm/engine.ts`),
 * and shows the first hand in the replayer, with Share and Save.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import { isDatabaseConfigured, saveHand } from "../../lib/db";
import { deriveNow } from "../../lib/db/derive";
import { useDict } from "../../lib/i18n/client";
import { getParser, toStandardText } from "../../lib/phf";
import { conversionEngine } from "../../lib/wasm/engine";
import type { PhfHand } from "../../lib/phf/types";
import { ReplayViewer } from "@rail/ui/replayer/ReplayViewer";
import { ShareHandButton } from "../share/ShareHandButton";
import { Icon } from "@rail/ui/icon/Icon";
import { Dismissible } from "@rail/ui/notice/Dismissible";

/** `standard` is our own re-import format, not a room, so it is not a label. */
function siteLabel(id: string): string | null {
  if (!id || id === "standard") {
    return null;
  }
  return getParser(id)?.name ?? id;
}

interface LoadedHand {
  hand: PhfHand;
  storedId: string | null;
  /**
   * Parser the hand came from, for the header label. Saving does not need it:
   * the hand carries its own site and filename.
   */
  siteId: string;
}

/** A text to replay; a new `id` replays it again. */
export interface ReplayRequest {
  id: number;
  text: string;
}

interface ReplayPanelProps {
  request: ReplayRequest | null;
  /** Lets the shell refresh its stored-hand counter after a save. */
  onSaved?: () => void;
}

export function ReplayPanel({ request, onSaved }: ReplayPanelProps) {
  const en = useDict();
  const t = en.converter.upload;
  const auth = useAuth();
  const [loaded, setLoaded] = useState<LoadedHand | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadFromText = useCallback(async (raw: string) => {
    setError(null);
    setNotice(null);
    try {
      const engine = await conversionEngine();
      const result = await engine.convert(raw, { validate: true });
      const [first] = result.hands;
      if (!first) {
        // Every parser writes a human-readable reason; the first one is the
        // best guess at what the user actually needs to hear. (Those reasons
        // are the parsers' own and stay in English.)
        setError(result.failures[0]?.message ?? t.notRecognised);
        setLoaded(null);
        return;
      }

      setLoaded({
        hand: first,
        storedId: null,
        siteId: first.meta.siteId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t.couldNotRead);
      setLoaded(null);
    }
  }, [t]);

  useEffect(() => {
    if (request) {
      void loadFromText(request.text);
    }
  }, [request, loadFromText]);

  /** Set when save was pressed with no session, so the click survives the dialog. */
  const wantsSaveRef = useRef(false);

  useEffect(() => {
    if (auth.isSignedIn && wantsSaveRef.current) {
      wantsSaveRef.current = false;
      void save();
    }
    // `save` closes over `loaded`, which has not changed across the sign-in;
    // depending on its identity would re-save on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.isSignedIn]);

  async function save() {
    if (!loaded || loaded.storedId) {
      return;
    }
    if (!auth.isSignedIn) {
      wantsSaveRef.current = true;
      auth.requestSignIn(en.converter.save.signInReason);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // The canonical document goes to the database, not a re-parse of the text
      // rendered from it: that round trip re-derives amounts through display
      // floats.
      const result = await saveHand(loaded.hand, toStandardText(loaded.hand));
      setLoaded({ ...loaded, storedId: result.id });
      setNotice(result.duplicate ? en.converter.save.alreadySaved : en.converter.save.saved);
      onSaved?.();
      if (!result.duplicate) {
        // Background, server-side; see ConverterTab.
        void deriveNow().catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : en.converter.save.failed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {error ? <Dismissible className="notice notice--error">{error}</Dismissible> : null}
      {notice ? <Dismissible className="notice notice--info">{notice}</Dismissible> : null}

      {loaded ? (
        <section className="card card--flush">
          <ReplayViewer
            fitToScreen
            phoneTakeover
            key={loaded.hand.meta.handKey}
            // A new paste opens at its start, not where the last hand stopped.
            urlSync={false}
            hand={loaded.hand}
            site={siteLabel(loaded.siteId)}
            onClose={() => setLoaded(null)}
            headerExtra={
              <>
                <ShareHandButton hand={loaded.hand} storedHandId={loaded.storedId} iconOnly />
                {/* Only while there is something to save — once the hand is in
                    the library the button has nothing left to say. */}
                {!loaded.storedId && isDatabaseConfigured ? (
                  <button
                    type="button"
                    className="btn btn--icon"
                    onClick={() => void save()}
                    disabled={saving}
                    aria-label={en.converter.save.button}
                    title={saving ? en.converter.save.saving : en.converter.save.button}
                  >
                    <Icon name="save" />
                  </button>
                ) : null}
              </>
            }
          />
        </section>
      ) : null}
    </>
  );
}
