/**
 * One hand in, one replay out.
 *
 * This used to live on the replayer tab, which put the app's most common single
 * action — "I copied a hand out of a forum thread, show me what happened" —
 * behind a tab named after the thing you do *after* uploading. It belongs on the
 * front door next to the batch converter, and the two are now modes of the same
 * tab.
 *
 * It runs the same detection and conversion the batch path uses, so every
 * registered parser works here. Only the first hand is loaded: paste a session
 * and the batch drop zone below is what you want, and the notice says so rather
 * than silently dropping the rest.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import { isDatabaseConfigured } from "../../lib/db";
import { toParsedHand, type ParsedHand } from "../../lib/handParser";
import { saveSingleHand } from "../../lib/handStore";
import { convertAny, getParser } from "../../lib/phf";
import { FILE_ACCEPT, loadFile } from "../converter/inputs";
import { ReplayViewer } from "../replayer/ReplayViewer";
import { ShareHandButton } from "../share/ShareHandButton";

/** `standard` is our own re-import format, not a room, so it is not a label. */
function siteLabel(id: string): string | null {
  if (!id || id === "standard") {
    return null;
  }
  return getParser(id)?.name ?? id;
}

interface LoadedHand {
  hand: ParsedHand;
  storedId: string | null;
  sourceText: string | null;
  sourceFilename: string | null;
  siteId: string;
}

interface SingleHandPanelProps {
  /** Lets the shell refresh its stored-hand counter after a save. */
  onSaved?: () => void;
}

export function SingleHandPanel({ onSaved }: SingleHandPanelProps) {
  const auth = useAuth();
  const [loaded, setLoaded] = useState<LoadedHand | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadFromText = useCallback(async (raw: string, fileName: string | null) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await convertAny(raw, { sourceFilename: fileName, validate: true });
      const [first] = result.hands;
      if (!first) {
        // Every parser writes a human-readable reason; the first one is the
        // best guess at what the user actually needs to hear.
        setError(result.failures[0]?.message ?? "That is not a hand history we recognise.");
        setLoaded(null);
        return;
      }

      setLoaded({
        hand: toParsedHand(first),
        storedId: null,
        sourceText: raw,
        sourceFilename: fileName,
        siteId: first.meta.siteId,
      });
      // The box has done its job; leaving eight rows of raw text above the
      // table pushes the replayer off a phone screen entirely.
      setText("");

      if (result.hands.length > 1) {
        setNotice(
          `${result.hands.length} hands found — showing the first. Use the upload box below to convert them all.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "That could not be read.");
      setLoaded(null);
    } finally {
      setBusy(false);
    }
  }, []);

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
      auth.requestSignIn("Sign in to keep this hand. Only you will see it.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await saveSingleHand(loaded.hand, {
        source: loaded.siteId,
        sourceText: loaded.sourceText,
        sourceFilename: loaded.sourceFilename,
      });
      setLoaded({ ...loaded, storedId: result.id });
      setNotice(result.duplicate ? "Already in your library." : "Saved to your library.");
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Saving failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="card">
        <div className="single">
          <textarea
            className="single__area"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Paste a hand here"
            rows={6}
            spellCheck={false}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && text.trim()) {
                event.preventDefault();
                void loadFromText(text, null);
              }
            }}
          />
          <div className="single__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!text.trim() || busy}
              onClick={() => void loadFromText(text, null)}
            >
              {busy ? "Reading…" : "Replay it"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              Choose a file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={FILE_ACCEPT}
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setBusy(true);
                // Shared with the batch path so this gets the same UTF-16 and
                // Windows-1252 handling instead of `file.text()`, which would
                // turn an 8-bit export into mojibake.
                const [source] = await loadFile(file);
                if (!source || source.problem) {
                  setBusy(false);
                  setNotice(null);
                  setError(source?.problem ?? "That file could not be read.");
                  return;
                }
                await loadFromText(source.text, file.name);
              }}
            />
          </div>
        </div>

        {error ? <p className="notice notice--error">{error}</p> : null}
        {notice ? <p className="notice notice--info">{notice}</p> : null}
      </section>

      {loaded ? (
        <section className="card card--flush">
          <ReplayViewer
            key={loaded.hand.handKey}
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
                    aria-label="Save to my library"
                    title={saving ? "Saving…" : "Save to my library"}
                  >
                    💾
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
