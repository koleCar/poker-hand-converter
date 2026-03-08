import { useMemo, useState } from "react";
import "./App.css";
import { convertCashWeplayFile, type ConvertedFile } from "./lib/converter";

function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ConvertedFile[]>([]);

  const convertedCount = useMemo(() => {
    return results.filter((file) => file.status === "converted").length;
  }, [results]);

  function handleFilesSelected(event: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    setResults([]);
    setFiles(Array.from(event.target.files ?? []));
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
      const converted = await Promise.all(
        files.map(async (file) => {
          const text = await file.text();
          return convertCashWeplayFile(file.name, text);
        }),
      );
      setResults(converted);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Neocekivana greska.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  function downloadConvertedFile(file: ConvertedFile) {
    if (file.status !== "converted") {
      return;
    }
    const blob = new Blob([file.outputText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.outputFileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  function handleDownloadAll() {
    const converted = results.filter((file) => file.status === "converted");
    if (!converted.length) {
      return;
    }

    const combinedText = converted
      .map((file) => {
        return [
          `===== FILE START: ${file.inputFileName} -> ${file.outputFileName} =====`,
          file.outputText,
          `===== FILE END: ${file.outputFileName} =====`,
        ].join("\n");
      })
      .join("\n\n");

    const blob = new Blob([combinedText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "gg-converted-combined.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="container">
      <h1>PokerConverter</h1>
      <p className="subtitle">Cash-only lokalni converter: WePlay {"->"} GG (bez backenda).</p>

      <section className="panel">
        <input type="file" accept=".txt" multiple onChange={handleFilesSelected} />
        <div className="actions">
          <button type="button" onClick={handleConvert} disabled={isLoading}>
            {isLoading ? "Konvertiram..." : "Konvertiraj u GG format"}
          </button>
        </div>
        <p className="helper">{files.length ? `${files.length} file(ova) spremno` : "Nema odabranih fileova"}</p>
      </section>

      {error ? <p className="error">{error}</p> : null}

      {results.length > 0 ? (
        <section className="panel">
          <h2>Rezultat</h2>
          <p>
            Uspjesno: {convertedCount} / {results.length}
          </p>
          <button type="button" className="download-link" onClick={handleDownloadAll} disabled={!convertedCount}>
            Download kombinirani file
          </button>
          <ul className="result-list">
            {results.map((file) => (
              <li key={`${file.inputFileName}-${file.outputFileName}`}>
                <strong>{file.inputFileName}</strong> - {file.status} - hands: {file.handCount} - warnings:{" "}
                {file.warningCount}
                {file.message ? ` - ${file.message}` : ""}
                {file.status === "converted" ? (
                  <>
                    {" "}
                    -{" "}
                    <button type="button" onClick={() => downloadConvertedFile(file)}>
                      Download
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

export default App;
