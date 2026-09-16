import { useMemo, useRef, useState } from "react";
import { convertCashWeplayFile, type ConvertedFile } from "../lib/converter";
import { saveHandsFromGgText, type SaveResult } from "../lib/handStore";
import { isSupabaseConfigured } from "../lib/supabase";

interface FileResult extends ConvertedFile {
  save?: SaveResult;
  saveError?: string;
  saving?: boolean;
}

function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

interface ConverterTabProps {
  onHandsSaved: () => void;
}

export function ConverterTab({ onHandsSaved }: ConverterTabProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<FileResult[]>([]);
  const [autoSave, setAutoSave] = useState(isSupabaseConfigured);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const totals = useMemo(() => {
    return results.reduce(
      (acc, file) => {
        acc.hands += file.handCount;
        acc.warnings += file.warningCount;
        if (file.status === "converted") acc.converted += 1;
        else acc.failed += 1;
        acc.saved += file.save?.saved ?? 0;
        acc.duplicates += file.save?.duplicates ?? 0;
        return acc;
      },
      { hands: 0, warnings: 0, converted: 0, failed: 0, saved: 0, duplicates: 0 },
    );
  }, [results]);

  function acceptFiles(incoming: FileList | null) {
    setError(null);
    setResults([]);
    const list = Array.from(incoming ?? []).filter((file) => /\.txt$/i.test(file.name));
    setFiles(list);
  }

  async function handleConvert() {
    if (!files.length) {
      setError("Odaberi barem jedan .txt file.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setResults([]);

    try {
      const converted: FileResult[] = await Promise.all(
        files.map(async (file) => {
          const text = await file.text();
          return { ...convertCashWeplayFile(file.name, text) } as FileResult;
        }),
      );
      setResults(converted);

      if (autoSave && isSupabaseConfigured) {
        const withSaves = [...converted];
        for (let i = 0; i < withSaves.length; i += 1) {
          const file = withSaves[i];
          if (file.status !== "converted") {
            continue;
          }
          withSaves[i] = { ...file, saving: true };
          setResults([...withSaves]);
          try {
            const save = await saveHandsFromGgText(file.outputText, {
              source: "weplay",
              sourceFilename: file.inputFileName,
            });
            withSaves[i] = { ...file, save, saving: false };
          } catch (err) {
            withSaves[i] = {
              ...file,
              saving: false,
              saveError: err instanceof Error ? err.message : "Greska pri spremanju.",
            };
          }
          setResults([...withSaves]);
        }
        onHandsSaved();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Neocekivana greska.");
    } finally {
      setIsLoading(false);
    }
  }

  function handleDownloadAll() {
    const converted = results.filter((file) => file.status === "converted");
    if (!converted.length) {
      return;
    }
    const combined = converted
      .map((file) =>
        [
          `===== FILE START: ${file.inputFileName} -> ${file.outputFileName} =====`,
          file.outputText,
          `===== FILE END: ${file.outputFileName} =====`,
        ].join("\n"),
      )
      .join("\n\n");
    downloadText("gg-converted-combined.txt", combined);
  }

  return (
    <div className="stack">
      <section className="card">
        <header className="card__head">
          <div>
            <h2>WePlay {"->"} GG konverzija</h2>
            <p className="muted">
              Ubaci jedan ili više WePlay <code>.txt</code> hand history fileova. Konverzija se
              radi lokalno u browseru; validni handovi se spremaju u bazu za replayer.
            </p>
          </div>
        </header>

        <div
          className={`dropzone ${dragging ? "is-dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            acceptFiles(event.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              inputRef.current?.click();
            }
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".txt"
            multiple
            hidden
            onChange={(event) => acceptFiles(event.target.files)}
          />
          <div className="dropzone__icon">⇪</div>
          <div className="dropzone__title">Povuci fileove ovdje ili klikni za odabir</div>
          <div className="dropzone__hint">
            {files.length
              ? `${files.length} file(ova) spremno`
              : "Podržani su WePlay .txt hand history fileovi"}
          </div>
        </div>

        {files.length > 0 ? (
          <ul className="file-chips">
            {files.map((file) => (
              <li key={file.name}>
                <span>{file.name}</span>
                <span className="muted">{(file.size / 1024).toFixed(0)} kB</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="card__actions">
          <button type="button" className="btn btn--primary" onClick={handleConvert} disabled={isLoading}>
            {isLoading ? "Konvertiram…" : "Konvertiraj"}
          </button>
          <label className={`switch ${!isSupabaseConfigured ? "is-disabled" : ""}`}>
            <input
              type="checkbox"
              checked={autoSave}
              disabled={!isSupabaseConfigured}
              onChange={(event) => setAutoSave(event.target.checked)}
            />
            <span>Spremi validne handove u bazu</span>
          </label>
          {files.length ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setFiles([]);
                setResults([]);
                setError(null);
              }}
            >
              Očisti
            </button>
          ) : null}
        </div>

        {!isSupabaseConfigured ? (
          <p className="notice notice--warn">
            Supabase nije konfiguriran (<code>VITE_SUPABASE_URL</code> /{" "}
            <code>VITE_SUPABASE_ANON_KEY</code>). Konverzija radi, spremanje u bazu ne.
          </p>
        ) : null}

        {error ? <p className="notice notice--error">{error}</p> : null}
      </section>

      {results.length > 0 ? (
        <section className="card">
          <header className="card__head">
            <h2>Rezultat</h2>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={handleDownloadAll}
              disabled={!totals.converted}
            >
              Download svih
            </button>
          </header>

          <div className="stat-row">
            <div className="stat">
              <span className="stat__value">{totals.converted}</span>
              <span className="stat__label">konvertiranih fileova</span>
            </div>
            <div className="stat">
              <span className="stat__value">{totals.hands}</span>
              <span className="stat__label">validnih handova</span>
            </div>
            <div className="stat stat--good">
              <span className="stat__value">{totals.saved}</span>
              <span className="stat__label">spremljeno u bazu</span>
            </div>
            <div className="stat">
              <span className="stat__value">{totals.duplicates}</span>
              <span className="stat__label">već postojalo</span>
            </div>
            <div className="stat stat--warn">
              <span className="stat__value">{totals.warnings}</span>
              <span className="stat__label">upozorenja</span>
            </div>
            {totals.failed ? (
              <div className="stat stat--bad">
                <span className="stat__value">{totals.failed}</span>
                <span className="stat__label">neuspjelih fileova</span>
              </div>
            ) : null}
          </div>

          <ul className="result-list">
            {results.map((file) => {
              const key = `${file.inputFileName}-${file.outputFileName}`;
              const isOpen = expanded === key;
              return (
                <li key={key} className={`result ${file.status === "converted" ? "is-ok" : "is-bad"}`}>
                  <div className="result__main">
                    <div className="result__title">
                      <span className={`dot dot--${file.status === "converted" ? "ok" : "bad"}`} />
                      <strong>{file.inputFileName}</strong>
                    </div>
                    <div className="result__tags">
                      <span className="tag">{file.handCount} handova</span>
                      {file.warningCount ? (
                        <span className="tag tag--warn">{file.warningCount} upozorenja</span>
                      ) : null}
                      {file.saving ? <span className="tag">spremam…</span> : null}
                      {file.save ? (
                        <span className="tag tag--good">
                          +{file.save.saved} spremljeno
                          {file.save.duplicates ? ` · ${file.save.duplicates} dupl.` : ""}
                        </span>
                      ) : null}
                      {file.saveError ? <span className="tag tag--bad">{file.saveError}</span> : null}
                      {file.message ? <span className="tag tag--bad">{file.message}</span> : null}
                    </div>
                  </div>
                  <div className="result__actions">
                    {file.warnings.length ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setExpanded(isOpen ? null : key)}
                      >
                        {isOpen ? "Sakrij log" : "Log"}
                      </button>
                    ) : null}
                    {file.status === "converted" ? (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => downloadText(file.outputFileName, file.outputText)}
                      >
                        Download
                      </button>
                    ) : null}
                  </div>
                  {isOpen ? (
                    <ul className="warning-log">
                      {file.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
