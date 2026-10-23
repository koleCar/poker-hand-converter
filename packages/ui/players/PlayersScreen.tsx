/**
 * Players (guideline §6 "Igrači": an opponent's profile, notes and colour
 * tags; R2.7c), on both surfaces (R4.5c). The opponents of rooms that print
 * real screen names, most hands together first, searched by the start of a
 * name; beside the list the chosen opponent's profile (`PlayerProfile.tsx`):
 * their statistics, their rows by position and stake, your result against
 * them, the user's words, and "hands with this player" into Hands.
 *
 * Who is listed is the surface's store's rule (docs/DATABASE.md "Player
 * identity and anonymized rooms"): a positional room's seat labels never, an
 * opaque room's session tokens counted but not listed. The result is in big
 * blinds only and withheld when the list mixes tournament chips with cash,
 * so on a library with both the screen opens on the kind with more hands, as
 * Reports does.
 *
 * The desktop app's screen (R2.7c, `app/src/screens/Players.tsx` before
 * R4.5c), lifted out of it: the open player and where it lives (the app's
 * route, the web's page state), the notices, the empty text, the states'
 * look and "hands with this player" are the surface's; what the surface does
 * not keep (`PlayersSource.features`: the web has no colours or labels) the
 * screen leaves out.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { countIn } from "../hands/format";
import type { FacetCount, PlayerRef } from "../hands/model";
import { useUiStrings } from "../i18n";
import type { Definition } from "../reports/model";
import {
  PLAYER_COLOURS,
  playerKey,
  reasonText,
  type GameKind,
  type PlayerList,
  type PlayerQuery,
  type PlayerSite,
  type PlayersSource,
} from "./model";
import { PlayerProfile } from "./PlayerProfile";
import { PlayerTable } from "./PlayerTable";
import styles from "./Players.module.css";

/** Rows asked for at first, and added by "show more" (the stores' cap is 500). */
const PAGE = 200;
const MAX_ROWS = 500;
/** Typing pauses this long before the store is asked. */
const SEARCH_DEBOUNCE_MS = 120;
/** At most once per this many ms after an import. */
const ARRIVAL_THROTTLE_MS = 2000;

type Query = Required<Omit<PlayerQuery, "limit" | "kind">> & { kind: GameKind | null };

/** The query, kept while the surface runs (leaving Players and coming back keeps it). */
let lastQuery: Query = {
  search: "",
  site: null,
  kind: null,
  colours: [],
  labels: [],
  noted: null,
};

export interface PlayersScreenProps {
  source: PlayersSource;
  /** The definitions the profile's statistics are matched to; `null` while they load. */
  definitions: readonly Definition[] | null;
  /** The open player (the app's route, the web's page state). */
  selected: PlayerRef | null;
  onSelect: (player: PlayerRef | null) => void;
  /** "Hands with this player": the surface opens its Hands on them. */
  onHandsWith: (player: PlayerRef) => void;
  /** The heading's words, and its level on the surface's page. */
  title: string;
  titleTag?: "h1" | "h2";
  /** Under the filters: the surface's lines (a rebuild, the opponents still being indexed). */
  notice?: ReactNode;
  /** No opponents at all: the surface says where they come from. */
  emptyText: string;
  /** Under the user's words on a player: where they are kept (none to say nothing). */
  notesFootnote: string | null;
  /** The states (loading, empty, error) in the surface's look. */
  renderState: (kind: "loading" | "empty" | "error", text: string, compact?: boolean) => ReactNode;
  /** Changes when the surface knows the opponents changed (the web's arrivals). */
  reloadToken?: unknown;
  /** Fill the surface's main area (the desktop) or size to the page (the web). */
  fill?: boolean;
  /** Changes when the surface changes the row height without resizing the list (the desktop's density). */
  densityKey?: unknown;
}

export function PlayersScreen({
  source,
  definitions,
  selected,
  onSelect,
  onHandsWith,
  title,
  titleTag: Title = "h1",
  notice,
  emptyText,
  notesFootnote,
  renderState,
  reloadToken,
  fill = false,
  densityKey,
}: PlayersScreenProps) {
  const strings = useUiStrings();
  const p = strings.players;
  const f = strings.hands.filters;
  const [query, setQuery] = useState(lastQuery);
  const [limit, setLimit] = useState(PAGE);
  const [defaultKind, setDefaultKind] = useState<GameKind | null>(null);
  const [list, setList] = useState<PlayerList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<PlayerSite[]>([]);
  const [labels, setLabels] = useState<FacetCount[]>([]);
  const [arrivals, setArrivals] = useState(0);
  const [debounced, setDebounced] = useState(query.search);
  const panelRef = useRef<HTMLDivElement>(null);
  const { colours: hasColours, labels: hasLabels } = source.features;

  const update = (change: Partial<Query>) => {
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
    source
      .sites()
      .then(setSites)
      .catch(() => undefined);
  }, [source, reloadToken]);

  useEffect(() => {
    if (!source.onChanged) return;
    let last = 0;
    let timer: number | undefined;
    const stop = source.onChanged(() => {
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
  }, [source]);

  // The kind shown: the reader's, else (a library with both) the bigger one.
  const kind: GameKind = query.kind ?? defaultKind ?? "all";
  const ask = useMemo<PlayerQuery>(
    () => ({
      search: debounced,
      site: query.site,
      kind,
      colours: hasColours ? query.colours : [],
      labels: hasLabels ? query.labels : [],
      noted: query.noted,
      limit,
    }),
    [debounced, query.site, kind, query.colours, query.labels, query.noted, limit, hasColours, hasLabels],
  );
  const askKey = JSON.stringify(ask);

  useEffect(() => {
    let current = true;
    const asked = JSON.parse(askKey) as PlayerQuery;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new query starts loading
    setLoading(true);
    source
      .list(asked)
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
        if (current) setError(reasonText(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    if (hasLabels) {
      source
        .labels()
        .then((value) => current && setLabels(value))
        .catch(() => undefined);
    }
    return () => {
      current = false;
    };
  }, [source, askKey, arrivals, reloadToken, query.kind, defaultKind, hasLabels]);

  const filtered =
    debounced.trim() !== "" ||
    query.site !== null ||
    (hasColours && query.colours.length > 0) ||
    (hasLabels && query.labels.length > 0) ||
    query.noted !== null;
  let countLine: string | null = null;
  if (list) {
    countLine = filtered ? p.countOf(list.matching, list.players) : p.count(list.players);
  }

  let body;
  if (error !== null && list === null) {
    body = renderState("error", p.storeError(error));
  } else if (list === null || list.rows.length === 0) {
    body =
      list === null || loading ? renderState("loading", p.loading) : renderState("empty", filtered ? p.noMatch : emptyText);
  } else {
    body = (
      <PlayerTable
        rows={list.rows}
        selected={selected}
        showColours={hasColours}
        densityKey={densityKey}
        onSelect={(row) => onSelect({ site: row.site, player: row.player })}
        onOpen={() =>
          // Enter on a row: into the profile (rendered by then, or on the next frame).
          window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("section")?.focus())
        }
        more={list.matching > list.rows.length && limit < MAX_ROWS}
        onMore={() => setLimit((n) => Math.min(MAX_ROWS, n + PAGE))}
      />
    );
  }

  const kinds: GameKind[] = ["all", "cash", "chips"];
  return (
    <div className={`${styles.screen} ${fill ? styles.fill : styles.page}`}>
      <header className={styles.top}>
        <Title className={styles.title}>{title}</Title>
        {countLine !== null ? (
          <span className={styles.count} aria-live="polite">
            {countLine}
          </span>
        ) : null}
      </header>

      <div className={styles.toolbar} role="toolbar" aria-label={f.label}>
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
        {hasColours ? (
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
        ) : null}
        {hasLabels && labels.length > 0 ? (
          <label className={styles.select}>
            <span>{p.labelFilter}</span>
            <select
              value={query.labels[0] ?? ""}
              aria-label={p.labelFilter}
              onChange={(event) => update({ labels: event.target.value ? [event.target.value] : [] })}
            >
              <option value="">{f.clear}</option>
              {labels.map((label) => (
                <option key={label.value} value={label.value}>
                  {`${label.value} (${countIn(strings.intlLocale, label.count)})`}
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
      {list && list.hiddenHands > 0 ? <p className={styles.notice}>{p.hidden(list.hiddenHands)}</p> : null}
      {notice}

      <div className={selected === null ? styles.body : `${styles.body} ${styles.split}`}>
        <div className={styles.list}>{body}</div>
        {selected !== null ? (
          <div className={styles.panel} ref={panelRef}>
            <PlayerProfile
              key={playerKey(selected)}
              source={source}
              site={selected.site}
              player={selected.player}
              kind={kind}
              definitions={definitions}
              notesFootnote={notesFootnote}
              renderState={renderState}
              onClose={() => onSelect(null)}
              onHandsWith={onHandsWith}
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
