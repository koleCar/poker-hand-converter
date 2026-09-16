import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { ConverterTab } from "./components/ConverterTab";
import { ReplayerTab } from "./components/ReplayerTab";
import { countHands } from "./lib/handStore";
import { isSupabaseConfigured } from "./lib/supabase";

type TabId = "converter" | "replayer";

const TABS: Array<{ id: TabId; label: string; hint: string }> = [
  { id: "converter", label: "Converter", hint: "WePlay → GG" },
  { id: "replayer", label: "Hand Replayer", hint: "baza + upload" },
];

function App() {
  const [tab, setTab] = useState<TabId>("converter");
  const [refreshToken, setRefreshToken] = useState(0);
  const [storedCount, setStoredCount] = useState<number | null>(null);

  const refreshCount = useCallback(() => {
    if (!isSupabaseConfigured) {
      return;
    }
    void countHands().then(setStoredCount);
  }, []);

  useEffect(refreshCount, [refreshCount, refreshToken]);

  const handleHandsSaved = useCallback(() => {
    setRefreshToken((current) => current + 1);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__inner">
          <div className="brand">
            <span className="brand__mark">♠</span>
            <div>
              <span className="brand__name">PokerConverter</span>
              <span className="brand__sub">WePlay → GG converter &amp; hand replayer</span>
            </div>
          </div>

          <nav className="tabs" role="tablist">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                className={`tab ${tab === entry.id ? "is-active" : ""}`}
                onClick={() => setTab(entry.id)}
              >
                <span className="tab__label">{entry.label}</span>
                <span className="tab__hint">{entry.hint}</span>
              </button>
            ))}
          </nav>

          <div className="topbar__status">
            {isSupabaseConfigured ? (
              <span className="status status--ok">
                <span className="status__dot" />
                {storedCount === null ? "baza spojena" : `${storedCount} handova u bazi`}
              </span>
            ) : (
              <span className="status status--off">
                <span className="status__dot" />
                baza nije spojena
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="content">
        {tab === "converter" ? (
          <ConverterTab onHandsSaved={handleHandsSaved} />
        ) : (
          <ReplayerTab refreshToken={refreshToken} />
        )}
      </main>
    </div>
  );
}

export default App;
