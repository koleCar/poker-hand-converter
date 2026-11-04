/**
 * One opponent (R2.7c): when you met, how many hands together, your result
 * against them (big blinds, cash and tournaments apart - never added), their
 * statistics over every hand of theirs the surface has (the R2.4 definitions
 * for any player with R2.5 reliability; the hero-only all-in EV is not
 * theirs to show), their rows by position, stake, table size and game, and
 * the user's words - a colour, labels (where the surface keeps them), a
 * note - saved as they change. "Hands with this player" asks the surface to
 * open its Hands filtered to them.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { POSITION_ORDER } from "../hands/filter";
import { handFormat, stakeLabel } from "../hands/format";
import type { PlayerRef } from "../hands/model";
import { useUiStrings } from "../i18n";
import { GroupTable } from "../reports/Breakdown";
import type { Definition, StatGroup } from "../reports/model";
import {
  PLAYER_COLOURS,
  reasonText,
  type GameKind,
  type PlayerColour,
  type PlayerNotes,
  type PlayerProfile as Profile,
  type PlayersSource,
  type Together,
} from "./model";
import { PlayerStats } from "./PlayerStats";
import styles from "./Players.module.css";

const TABS = ["position", "stake"] as const;
type Tab = (typeof TABS)[number];
/** How long typing pauses before the note is saved. */
const NOTE_DEBOUNCE_MS = 700;

type RenderState = (kind: "loading" | "empty" | "error", text: string, compact?: boolean) => ReactNode;

export function PlayerProfile({
  source,
  site,
  player,
  kind,
  definitions,
  notesFootnote,
  renderState,
  onClose,
  onHandsWith,
  onNotes,
}: {
  source: PlayersSource;
  site: string;
  player: string;
  kind: GameKind;
  definitions: readonly Definition[] | null;
  notesFootnote: string | null;
  renderState: RenderState;
  onClose: () => void;
  onHandsWith: (player: PlayerRef) => void;
  /** The colour, labels or note changed: the list shows it. */
  onNotes: (notes: PlayerNotes) => void;
}) {
  const players = useUiStrings().players;
  const t = players.profile;
  const [profile, setProfile] = useState<Profile | null>(null);
  // The game kind the profile shown is for: another one dims it while it loads.
  const [profileKind, setProfileKind] = useState<GameKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  // The profile's own game kind (R2.8): the list's until the reader picks
  // one here, for this player (a new player opens on the list's again).
  const [ownKind, setOwnKind] = useState<GameKind | null>(null);
  const shownKind = ownKind ?? kind;

  useEffect(() => {
    let current = true;
    source
      .profile(site, player, shownKind)
      .then((value) => {
        if (!current) return;
        setProfile(value);
        setProfileKind(shownKind);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (current) setError(reasonText(reason));
      });
    return () => {
      current = false;
    };
  }, [source, site, player, shownKind]);

  const kinds: GameKind[] = ["all", "cash", "chips"];
  const together = profile?.seen ? profile.seen.cash.hands + profile.seen.chips.hands : null;
  return (
    <section className={styles.profile} aria-labelledby={headingId} tabIndex={-1}>
      <div className={styles.profileHead}>
        <div className={styles.profileWho}>
          <h2 id={headingId} className={styles.profileName}>
            {player}
          </h2>
          <p className={styles.muted}>{profile?.siteName ?? site}</p>
        </div>
        <div className={styles.profileActions}>
          <div className={styles.segmented} role="group" aria-label={t.kind} title={t.kindHint}>
            {kinds.map((value) => (
              <button
                key={value}
                type="button"
                className={`chip-btn${shownKind === value ? " is-active" : ""}`}
                aria-pressed={shownKind === value}
                onClick={() => setOwnKind(value)}
              >
                {players.kinds[value]}
              </button>
            ))}
          </div>
          {together !== null ? (
            <button
              type="button"
              className={`btn btn--sm ${styles.handsWith}`}
              title={t.handsWith(together)}
              onClick={() => onHandsWith({ site, player })}
            >
              {t.handsButton(together)}
              <span aria-hidden="true"> →</span>
            </button>
          ) : null}
          <button type="button" className="btn btn--icon" aria-label={t.close} title={t.close} onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      {error !== null
        ? renderState("error", t.failed(error), true)
        : profile === null || definitions === null
          ? renderState("loading", t.loading, true)
          : profile.seen === null
            ? renderState("empty", t.notOpponent, true)
            : (
              <div className={`${styles.profileBody} rail-dims`} aria-busy={profileKind !== shownKind}>
                <ProfileBody
                  source={source}
                  profile={profile}
                  definitions={definitions}
                  notesFootnote={notesFootnote}
                  onNotes={onNotes}
                />
              </div>
            )}
    </section>
  );
}

/** A loaded opponent's profile under its heading (exported for the tests: a render needs no source call). */
export function ProfileBody({
  source,
  profile,
  definitions,
  notesFootnote,
  onNotes,
}: {
  source: PlayersSource;
  profile: Profile;
  definitions: readonly Definition[];
  notesFootnote: string | null;
  onNotes: (notes: PlayerNotes) => void;
}) {
  const all = useUiStrings();
  const t = all.players.profile;
  const { bigBlinds, count, playedAt } = useMemo(() => handFormat(all.intlLocale), [all.intlLocale]);
  const seen = profile.seen;
  if (seen === null) return null;
  const together = seen.cash.hands + seen.chips.hands;
  const result = (label: string, kind: Together) => (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd className={kind.netBbMilli > 0 ? styles.up : kind.netBbMilli < 0 ? styles.down : ""}>
        {kind.moneyHands === 0 ? t.noHands : `${bigBlinds(kind.netBbMilli)} bb`}
      </dd>
    </div>
  );
  const both = seen.cash.hands > 0 && seen.chips.hands > 0;

  return (
    <>
      <dl className={`${styles.facts} rail-stagger`}>
        <div className={styles.fact}>
          <dt>{t.together}</dt>
          <dd>
            {count(together)}
            {both ? (
              <span className={styles.muted}>
                {" "}
                {[t.togetherCash(seen.cash.hands), t.togetherChips(seen.chips.hands)].join(" · ")}
              </span>
            ) : null}
          </dd>
        </div>
        {seen.cash.hands > 0 ? result(both ? `${t.yourResult} · ${t.resultCash}` : t.yourResult, seen.cash) : null}
        {seen.chips.hands > 0 ? result(both ? `${t.yourResult} · ${t.resultChips}` : t.yourResult, seen.chips) : null}
        <div className={styles.fact}>
          <dt>{t.firstSeen}</dt>
          <dd>{playedAt(seen.firstPlayedAt)}</dd>
        </div>
        <div className={styles.fact}>
          <dt>{t.lastSeen}</dt>
          <dd>{playedAt(seen.lastPlayedAt)}</dd>
        </div>
      </dl>

      <WordsDisclosure
        source={source}
        profile={profile}
        notesFootnote={notesFootnote}
        onNotes={onNotes}
      />

      <div>
        <div className={styles.statsHead}>
          <h3 className={styles.subhead}>{t.stats}</h3>
          <span className={styles.muted}>{t.statsSample(seen.hands)}</span>
        </div>
        {profile.mixedKind ? <p className={styles.warning}>{t.mixedKind}</p> : null}
        <PlayerStats profile={profile} definitions={definitions} />
        <p className={styles.footnoteLine}>{t.statsLegend}</p>
      </div>

      <Breakdown profile={profile} definitions={definitions} />
    </>
  );
}

/**
 * The colour, labels and note behind a disclosure, closed by default: its
 * summary line shows what is there (the colour, the labels, the note's start)
 * so the words stay at hand without leading the profile.
 */
function WordsDisclosure({
  source,
  profile,
  notesFootnote,
  onNotes,
}: {
  source: PlayersSource;
  profile: Profile;
  notesFootnote: string | null;
  onNotes: (notes: PlayerNotes) => void;
}) {
  const p = useUiStrings().players;
  const t = p.profile;
  const [notes, setNotes] = useState(profile.notes);
  const empty = notes.colour === null && notes.labels.length === 0 && notes.note.trim() === "";
  return (
    <details className={styles.wordsDisclosure}>
      <summary className={styles.wordsSummary}>
        <span className={styles.wordsTitle}>{t.words}</span>
        {notes.colour !== null ? (
          <span className={styles.swatch} data-colour={notes.colour} title={p.colours[notes.colour]} aria-label={p.colourOf(p.colours[notes.colour])} />
        ) : null}
        {notes.labels.map((label) => (
          <span key={label} className={styles.label}>
            {label}
          </span>
        ))}
        <span className={styles.wordsPreview}>{empty ? t.wordsEmpty : notes.note.split("\n")[0]}</span>
      </summary>
      <PlayerWords
        source={source}
        site={profile.site}
        player={profile.player}
        initial={profile.notes}
        onNotes={(value) => {
          setNotes(value);
          onNotes(value);
        }}
        footnote={notesFootnote}
      />
    </details>
  );
}

/**
 * A player's words, saved as they change: the colour (an ARIA radio group)
 * and the labels where the surface keeps them, and the note. (R3.8) The
 * app's HUD popup shows it too, without the footnote, on rooms that allow
 * labelling players.
 */
export function PlayerWords({
  source,
  site,
  player,
  initial,
  onNotes,
  footnote = null,
}: {
  source: PlayersSource;
  site: string;
  player: string;
  initial: PlayerNotes;
  onNotes: (notes: PlayerNotes) => void;
  /** Where the words are kept, under them (none to say nothing). */
  footnote?: string | null;
}) {
  const p = useUiStrings().players;
  const t = p.profile;
  const { colours: hasColours, labels: hasLabels } = source.features;
  const [notes, setNotes] = useState(initial);
  const [note, setNote] = useState(initial.note);
  const [label, setLabel] = useState("");
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const savedNote = useRef(initial.note);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<string | null>(null);
  const groupId = useId();

  const applied = (value: PlayerNotes) => {
    setNotes(value);
    setError(null);
    onNotes(value);
  };
  const failed = (reason: unknown) => setError(t.saveFailed(reasonText(reason)));

  const saveNote = (text: string) => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (text === savedNote.current) return;
    setNoteState("saving");
    source
      .setNote(site, player, text)
      .then((value) => {
        savedNote.current = text;
        pending.current = null;
        setNoteState("saved");
        applied(value);
      })
      .catch((reason: unknown) => {
        setNoteState("idle");
        failed(reason);
      });
  };

  // A note being typed when the profile closes is saved, not lost.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending.current !== null && pending.current !== savedNote.current) {
        source.setNote(site, player, pending.current).catch(() => undefined);
      }
    },
    [source, site, player],
  );

  const setColour = (colour: PlayerColour | null) => {
    source.setColour(site, player, colour).then(applied).catch(failed);
  };

  // The colours as a radio group: arrow keys move and choose.
  const choices: (PlayerColour | null)[] = [null, ...PLAYER_COLOURS];
  const onColourKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = choices.indexOf(notes.colour);
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % choices.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + choices.length) % choices.length;
    if (next === null) return;
    event.preventDefault();
    const chosen = choices[next] ?? null;
    setColour(chosen);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };

  const addLabel = () => {
    const value = label.trim();
    if (!value) return;
    source
      .addLabel(site, player, value)
      .then((result) => {
        setLabel("");
        applied(result);
      })
      .catch(failed);
  };

  return (
    <div className={styles.words}>
      {hasColours ? (
        <div className={styles.wordsRow}>
          <span className={styles.wordsLabel} id={`${groupId}-colour`}>
            {t.colour}
          </span>
          <div role="radiogroup" aria-labelledby={`${groupId}-colour`} className={styles.swatches} onKeyDown={onColourKey}>
            {choices.map((colour) => {
              const checked = notes.colour === colour;
              const name = colour === null ? p.noColour : p.colours[colour];
              return (
                <button
                  key={colour ?? "none"}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={name}
                  title={name}
                  tabIndex={checked ? 0 : -1}
                  className={`${styles.swatchButton}${checked ? ` ${styles.swatchOn}` : ""}`}
                  onClick={() => setColour(colour)}
                >
                  <span className={styles.swatch} data-colour={colour ?? "none"} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {hasLabels ? (
        <div className={styles.wordsRow}>
          <span className={styles.wordsLabel} id={`${groupId}-labels`}>
            {t.labels}
          </span>
          <ul className={styles.labels} aria-labelledby={`${groupId}-labels`}>
            {notes.labels.map((name) => (
              <li key={name} className={styles.label}>
                {name}
                <button
                  type="button"
                  aria-label={t.removeLabel(name)}
                  title={t.removeLabel(name)}
                  onClick={() => source.removeLabel(site, player, name).then(applied).catch(failed)}
                >
                  ×
                </button>
              </li>
            ))}
            {notes.labels.length < 8 ? (
              <li>
                <input
                  className={styles.labelInput}
                  value={label}
                  maxLength={24}
                  placeholder={t.labelPlaceholder}
                  aria-label={t.addLabel}
                  title={t.labelsHint}
                  onChange={(event) => setLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addLabel();
                    }
                  }}
                />
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      <label className={styles.wordsRow}>
        <span className={styles.wordsLabel}>
          {t.note}
          <span className={styles.noteState} aria-live="polite">
            {noteState === "saving" ? t.noteSaving : noteState === "saved" ? t.noteSaved : null}
          </span>
        </span>
        <textarea
          className={styles.note}
          value={note}
          rows={3}
          maxLength={2000}
          placeholder={t.notePlaceholder}
          aria-label={t.note}
          onChange={(event) => {
            const text = event.target.value;
            setNote(text);
            setNoteState("idle");
            pending.current = text;
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => saveNote(text), NOTE_DEBOUNCE_MS);
          }}
          onBlur={() => saveNote(note)}
        />
      </label>
      {footnote ? <p className={styles.footnote}>{footnote}</p> : null}
      {error ? (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function rank(order: readonly string[], key: string): number {
  const index = order.indexOf(key);
  return index < 0 ? order.length : index;
}

/** Their rows by position, stake, table size or game: the Reports table. */
function Breakdown({ profile, definitions }: { profile: Profile; definitions: readonly Definition[] }) {
  const all = useUiStrings();
  const t = all.players.profile;
  const f = all.hands.filters;
  const [tab, setTab] = useState<Tab>("position");
  const panelId = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const columns = profile.columns.map((id) => definitions.find((definition) => definition.id === id) ?? null);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const chosen = TABS[next];
    if (chosen) {
      setTab(chosen);
      tabsRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
    }
  };

  let rows: StatGroup[];
  let label: (row: StatGroup) => string;
  switch (tab) {
    case "position":
      rows = [...profile.byPosition].sort((a, b) => rank(POSITION_ORDER, a.key) - rank(POSITION_ORDER, b.key));
      label = (row) => (row.key === "" ? t.noPosition : row.key);
      break;
    case "stake":
      rows = [...profile.byStake].sort((a, b) => b.hands - a.hands || a.key.localeCompare(b.key));
      label = (row) => {
        if (row.key === "chips") return f.chips;
        const sample = profile.stakes.find((stake) => stake.key === row.key);
        return (sample ? stakeLabel({ ...sample, value: sample.key, count: 0 }) : null) ?? row.key;
      };
      break;
  }

  return (
    <div>
      <h3 className={styles.subhead}>{t.breakdown}</h3>
      <div className={styles.tabs} role="tablist" aria-label={t.breakdown} ref={tabsRef} onKeyDown={onKey}>
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            id={`${panelId}-${entry}`}
            aria-selected={entry === tab}
            aria-controls={`${panelId}-panel`}
            tabIndex={entry === tab ? 0 : -1}
            className={`chip-btn${entry === tab ? " is-active" : ""}`}
            onClick={() => setTab(entry)}
          >
            {t.tabs[entry]}
          </button>
        ))}
      </div>
      <div id={`${panelId}-panel`} role="tabpanel" aria-labelledby={`${panelId}-${tab}`} className={styles.tableScroll}>
        {rows.length === 0 ? (
          <p className={styles.muted}>{t.empty}</p>
        ) : (
          <GroupTable head={t.heads[tab]} rows={rows} columns={columns} label={label} />
        )}
      </div>
    </div>
  );
}
