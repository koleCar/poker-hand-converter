/**
 * Players (guideline §6 "Igrači": an opponent's profile, notes and colour
 * tags; R2.7c). The opponents of rooms that print real screen names, most
 * hands together first, searched by the start of a name; beside the list
 * the chosen opponent's profile (`players/PlayerProfile.tsx`): their
 * statistics, their rows by position and stake, your result against them,
 * a colour, labels and a note, and "hands with this player" into Hands.
 *
 * Who is listed is the store's rule (docs/DATABASE.md "Player identity and
 * anonymized rooms"): a positional room's seat labels never, an opaque
 * room's session tokens counted but not listed. Every number is the Rust
 * side's; the result is in big blinds only and withheld when the list mixes
 * tournament chips with cash, as the web's opponents report does - so on a
 * store with both the screen opens on the kind with more hands, as Reports
 * does. The open player is the route, `#/players/<site>:<name>`, which is
 * how the command palette opens one.
 */
import { useEffect, useMemo, useState } from "react";

import { useT } from "../i18n";
import {
  PLAYER_COLOURS,
  errorText,
  inApp,
  ipc,
  onWatcherChanged,
  type FacetCount,
  type GameKind,
  type PlayerList,
  type PlayerQuery,
  type PlayerSite,
  type StatsStatus,
} from "../lib/ipc";
import { replaceParam, useRouteParam } from "../lib/router";
import { count } from "./hands/format";
import { PlayerProfile } from "./players/PlayerProfile";
import { PlayerTable } from "./players/PlayerTable";
import { parsePlayerParam, playerParam } from "./players/param";
import styles from "./players/Players.module.css";

/** Rows asked for at first, and added by "show more" (the store's cap is 500). */
const PAGE = 200;
const MAX_ROWS = 500;
/** Typing pauses this long before the store is asked. */
const SEARCH_DEBOUNCE_MS = 120;
/** At most once per this many ms after an import. */
const ARRIVAL_THROTTLE_MS = 2000;

/** The query, kept while the app runs (leaving Players and coming back keeps it). */
let lastQuery: Required<Omit<PlayerQuery, "limit" | "kind">> & { kind: GameKind | null } = {
  search: "",
  site: null,
  kind: null,
  colours: [],
  labels: [],
  noted: null,
};

function useRebuild(): StatsStatus | null {
  const [status, setStatus] = useState<StatsStatus | null>(null);
  useEffect(() => {
    if (!inApp) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = () => {
      ipc
        .statsStatus()
        .then((value) => {
          if (stopped) return;
          setStatus(value);
          if (value.activity === "rebuilding" || value.activity === "indexing" || value.playersUnindexed > 0) {
            timer = window.setTimeout(poll, 3000);
          }
        })
        .catch(() => undefined);
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);
  return status;
}

export function Players() {
  const t = useT();
  const p = t.players;
  const param = useRouteParam();
  const selected = parsePlayerParam(param);
  const [query, setQuery] = useState(lastQuery);
  const [limit, setLimit] = useState(PAGE);
  const [defaultKind, setDefaultKind] = useState<GameKind | null>(null);
  const [list, setList] = useState<PlayerList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(inApp);
  const [sites, setSites] = useState<PlayerSite[]>([]);
  const [labels, setLabels] = useState<FacetCount[]>([]);
  const [arrivals, setArrivals] = useState(0);
  const [debounced, setDebounced] = useState(query.search);
  const rebuild = useRebuild();

  const update = (change: Partial<typeof query>) => {
    const next = { ...query, ...change };
    lastQuery = next;
    setQuery(next);
    setLimit(PAGE);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.search), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query.search]);

  useEffect(() => {
    if (!inApp) return;
    ipc.playerSites().then(setSites).catch(() => undefined);
    let last = 0;
    let timer: number | undefined;
    const stop = onWatcherChanged(() => {
      const wait = Math.max(0, last + ARRIVAL_THROTTLE_MS - Date.now());
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        last = Date.now();
        setArrivals((n) => n + 1);
      }, wait);
    });
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, []);

  // The kind shown: the reader's, else (a store with both) the bigger one.
  const kind: GameKind = query.kind ?? defaultKind ?? "all";
  const ask = useMemo<PlayerQuery>(
    () => ({
      search: debounced,
      site: query.site,
      kind,
      colours: query.colours,
      labels: query.labels,
      noted: query.noted,
      limit,
    }),
    [debounced, query.site, kind, query.colours, query.labels, query.noted, limit],
  );
  const askKey = JSON.stringify(ask);

  useEffect(() => {
    if (!inApp) return;
    let current = true;
    const asked = JSON.parse(askKey) as PlayerQuery;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new query starts loading
    setLoading(true);
    ipc
      .playersList(asked)
      .then((value) => {
        if (!current) return;
        // Chips and cash do not add up: open on the kind with more hands.
        if (asked.kind === "all" && value.mixedKind && query.kind === null && defaultKind === null) {
          setDefaultKind(value.cashHands >= value.chipsHands ? "cash" : "chips");
          return;
        }
        setList(value);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (current) setError(errorText(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    ipc.playerLabels().then((value) => current && setLabels(value)).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [askKey, arrivals, query.kind, defaultKind]);

  if (!inApp) {
    return (
      <div className={styles.screen}>
        <h1 className={styles.title}>{t.screens.players.title}</h1>
        <p className={styles.message}>{p.unavailable}</p>
      </div>
    );
  }

  const filtered =
    debounced.trim() !== "" || query.site !== null || query.colours.length > 0 || query.labels.length > 0 || query.noted !== null;
  let countLine: string | null = null;
  if (list) {
    countLine = filtered ? p.countOf(count(list.matching), count(list.players)) : p.count(count(list.players));
  }

  let body;
  if (error !== null && list === null) {
    body = <p className={styles.message}>{p.storeError(error)}</p>;
  } else if (list === null || list.rows.length === 0) {
    body = (
      <p className={styles.message} role="status">
        {list === null || loading ? p.loading : filtered ? p.noMatch : p.empty}
      </p>
    );
  } else {
    body = (
      <PlayerTable
        rows={list.rows}
        selected={selected}
        onSelect={(row) => replaceParam("players", playerParam(row.site, row.player))}
        more={list.matching > list.rows.length && limit < MAX_ROWS}
        onMore={() => setLimit((n) => Math.min(MAX_ROWS, n + PAGE))}
      />
    );
  }

  const kinds: GameKind[] = ["all", "cash", "chips"];
  return (
    <div className={styles.screen}>
      <header className={styles.top}>
        <h1 className={styles.title}>{t.screens.players.title}</h1>
        {countLine !== null ? (
          <span className={styles.count} aria-live="polite">
            {countLine}
          </span>
        ) : null}
      </header>

      <div className={styles.toolbar} role="toolbar" aria-label={t.hands.filters.label}>
        <input
          type="search"
          className={styles.search}
          value={query.search}
          placeholder={p.searchPlaceholder}
          aria-label={p.search}
          onChange={(event) => update({ search: event.target.value })}
        />
        <div className={styles.segmented} role="group" aria-label={p.kinds.label}>
          {kinds.map((value) => (
            <button
              key={value}
              type="button"
              className={`chip-btn${kind === value ? " is-active" : ""}`}
              aria-pressed={kind === value}
              onClick={() => update({ kind: value })}
            >
              {p.kinds[value]}
            </button>
          ))}
        </div>
        <label className={styles.select}>
          <span>{p.room}</span>
          <select
            value={query.site ?? ""}
            aria-label={p.room}
            onChange={(event) => update({ site: event.target.value || null })}
          >
            <option value="">{p.anyRoom}</option>
            {sites.map((site) => (
              <option key={site.value} value={site.value}>
                {site.name}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.swatches} role="group" aria-label={p.colourFilter}>
          {PLAYER_COLOURS.map((colour) => {
            const on = query.colours.includes(colour);
            return (
              <button
                key={colour}
                type="button"
                className={`${styles.swatchButton}${on ? ` ${styles.swatchOn}` : ""}`}
                aria-pressed={on}
                aria-label={p.colours[colour]}
                title={p.colours[colour]}
                onClick={() =>
                  update({
                    colours: on ? query.colours.filter((c) => c !== colour) : [...query.colours, colour],
                  })
                }
              >
                <span className={styles.swatch} data-colour={colour} aria-hidden="true" />
              </button>
            );
          })}
        </div>
        {labels.length > 0 ? (
          <label className={styles.select}>
            <span>{p.labelFilter}</span>
            <select
              value={query.labels[0] ?? ""}
              aria-label={p.labelFilter}
              onChange={(event) => update({ labels: event.target.value ? [event.target.value] : [] })}
            >
              <option value="">{t.hands.filters.clear}</option>
              {labels.map((label) => (
                <option key={label.value} value={label.value}>
                  {`${label.value} (${count(label.count)})`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          className={`chip-btn${query.noted ? " is-active" : ""}`}
          aria-pressed={query.noted === true}
          onClick={() => update({ noted: query.noted ? null : true })}
        >
          {p.noted}
        </button>
        {filtered ? (
          <button
            type="button"
            className={styles.clear}
            onClick={() => update({ search: "", site: null, colours: [], labels: [], noted: null })}
          >
            {p.clearFilters}
          </button>
        ) : null}
      </div>

      {query.kind === null && defaultKind !== null ? (
        <p className={styles.notice}>{p.defaultKind(p.kinds[defaultKind])}</p>
      ) : null}
      {list?.mixedKind ? <p className={styles.warning}>{p.mixedKind}</p> : null}
      {list && list.hiddenHands > 0 ? <p className={styles.notice}>{p.hidden(count(list.hiddenHands))}</p> : null}
      {rebuild?.activity === "rebuilding" && rebuild.rebuildTotal !== null ? (
        <p className={styles.notice} role="status">
          {p.rebuilding(count(rebuild.rebuildDone ?? 0), count(rebuild.rebuildTotal))}
        </p>
      ) : rebuild && rebuild.playersUnindexed > 0 && rebuild.activity !== "idle" ? (
        <p className={styles.notice} role="status">
          {p.indexing(count(rebuild.playersUnindexed))}
        </p>
      ) : null}

      <div className={selected === null ? styles.body : `${styles.body} ${styles.split}`}>
        <div className={styles.list}>{body}</div>
        {selected !== null ? (
          <div className={styles.panel}>
            <PlayerProfile
              key={playerParam(selected.site, selected.player)}
              site={selected.site}
              player={selected.player}
              kind={kind}
              onClose={() => replaceParam("players", null)}
              onNotes={(notes) =>
                setList((was) =>
                  was === null
                    ? was
                    : {
                        ...was,
                        rows: was.rows.map((row) =>
                          row.site === selected.site && row.player === selected.player
                            ? { ...row, colour: notes.colour, labels: notes.labels, hasNote: notes.note !== "" }
                            : row,
                        ),
                      },
                )
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
