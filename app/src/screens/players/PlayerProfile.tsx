/**
 * One opponent (R2.7c): when you met, how many hands together, your result
 * against them (big blinds, cash and tournaments apart - never added), their
 * statistics over every hand of theirs the store has (the R2.4 definitions
 * for any player with R2.5 reliability; the hero-only all-in EV is not
 * theirs to show), their rows by position, stake, table size and game, and
 * the user's words - a colour, labels, a note - saved as they change. "Hands
 * with this player" opens Hands filtered to them.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { StatDefinition, StatGroup as DefinitionGroup } from "@rail/ui/model/stats";
import { StatTable } from "@rail/ui/stats/StatTable";

import { useLocale, useT } from "../../i18n";
import {
  PLAYER_COLOURS,
  errorText,
  ipc,
  type GameKind,
  type PlayerColour,
  type PlayerNotes,
  type PlayerProfile as Profile,
  type StatGroup,
  type Together,
} from "../../lib/ipc";
import { go } from "../../lib/router";
import { statRows, useStatDefinitions } from "../../lib/useStatDefinitions";
import { EMPTY_FILTER, FORMAT_ORDER, POSITION_ORDER, SIZE_ORDER, requestFilter } from "../hands/filter";
import { bigBlinds, count, playedAt, stakeLabel } from "../hands/format";
import { GroupTable } from "../reports/Breakdown";
import styles from "./Players.module.css";

const DEFINITION_GROUPS: DefinitionGroup[] = ["preflop", "postflop", "showdown", "results"];
const TABS = ["position", "stake", "size", "format"] as const;
type Tab = (typeof TABS)[number];
/** How long typing pauses before the note is saved. */
const NOTE_DEBOUNCE_MS = 700;

export function PlayerProfile({
  site,
  player,
  kind,
  onClose,
  onNotes,
}: {
  site: string;
  player: string;
  kind: GameKind;
  onClose: () => void;
  /** The colour, labels or note changed: the list shows it. */
  onNotes: (notes: PlayerNotes) => void;
}) {
  const t = useT().players.profile;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const definitions = useStatDefinitions();
  const headingId = useId();

  useEffect(() => {
    let current = true;
    ipc
      .playerProfile(site, player, kind)
      .then((value) => {
        if (!current) return;
        setProfile(value);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (current) setError(errorText(reason));
      });
    return () => {
      current = false;
    };
  }, [site, player, kind]);

  return (
    <section className={styles.profile} aria-labelledby={headingId}>
      <div className={styles.profileHead}>
        <div>
          <h2 id={headingId} className={styles.profileName}>
            {player}
          </h2>
          <p className={styles.muted}>{profile?.siteName ?? site}</p>
        </div>
        <button type="button" className="btn btn--icon" aria-label={t.close} title={t.close} onClick={onClose}>
          ×
        </button>
      </div>
      {error !== null ? (
        <p className={styles.errorText} role="alert">
          {t.failed(error)}
        </p>
      ) : profile === null || definitions === null ? (
        <p className={styles.muted} role="status">
          {t.loading}
        </p>
      ) : profile.seen === null ? (
        <p className={styles.muted}>{t.notOpponent}</p>
      ) : (
        <Body profile={profile} definitions={definitions} onNotes={onNotes} />
      )}
    </section>
  );
}

function Body({
  profile,
  definitions,
  onNotes,
}: {
  profile: Profile;
  definitions: StatDefinition[];
  onNotes: (notes: PlayerNotes) => void;
}) {
  const all = useT();
  const t = all.players.profile;
  const locale = useLocale();
  const seen = profile.seen;
  if (seen === null) return null;
  const together = seen.cash.hands + seen.chips.hands;
  const result = (label: string, kind: Together) => (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd className={kind.netBbMilli > 0 ? styles.up : kind.netBbMilli < 0 ? styles.down : ""}>
        {kind.moneyHands === 0 ? t.noHands : t.resultLine(bigBlinds(kind.netBbMilli), count(kind.moneyHands))}
      </dd>
    </div>
  );
  // Theirs to show: not the hero-only all-in EV, and no money (an
  // opponent's report is in big blinds, as the web's).
  const anyPlayer = (definition: StatDefinition) =>
    definition.players === "any" && definition.format.unit !== "money";

  return (
    <>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>{t.together}</dt>
          <dd>
            {count(together)}
            <span className={styles.muted}>
              {" "}
              {[
                seen.cash.hands > 0 ? t.togetherCash(count(seen.cash.hands)) : null,
                seen.chips.hands > 0 ? t.togetherChips(count(seen.chips.hands)) : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>{t.firstSeen}</dt>
          <dd>{playedAt(seen.firstPlayedAt)}</dd>
        </div>
        <div className={styles.fact}>
          <dt>{t.lastSeen}</dt>
          <dd>{playedAt(seen.lastPlayedAt)}</dd>
        </div>
      </dl>
      <div className={styles.resultBlock}>
        <h3 className={styles.subhead}>{t.result}</h3>
        <dl className={styles.facts}>
          {seen.cash.hands > 0 ? result(t.resultCash, seen.cash) : null}
          {seen.chips.hands > 0 ? result(t.resultChips, seen.chips) : null}
        </dl>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => {
          requestFilter({ ...EMPTY_FILTER, player: { site: profile.site, player: profile.player } });
          go("hands");
        }}
      >
        {t.handsWith(count(together))}
      </button>

      <Words profile={profile} onNotes={onNotes} />

      <div>
        <h3 className={styles.subhead}>{t.stats}</h3>
        <p className={styles.muted}>{t.sample(count(seen.hands))}</p>
        {profile.mixedKind ? <p className={styles.warning}>{t.mixedKind}</p> : null}
        <div className={styles.statGroups}>
          {DEFINITION_GROUPS.map((group) => (
            <StatTable
              key={group}
              caption={all.reports.stats.groups[group]}
              showCaption
              rows={statRows(
                definitions,
                profile.stats,
                locale,
                (definition) => definition.group === group && anyPlayer(definition),
              )}
            />
          ))}
        </div>
        <p className={styles.muted}>{t.statsNote}</p>
      </div>

      <Breakdown profile={profile} definitions={definitions} />
    </>
  );
}

/** The colour, the labels and the note. */
function Words({ profile, onNotes }: { profile: Profile; onNotes: (notes: PlayerNotes) => void }) {
  const p = useT().players;
  const t = p.profile;
  const { site, player } = profile;
  const [notes, setNotes] = useState(profile.notes);
  const [note, setNote] = useState(profile.notes.note);
  const [label, setLabel] = useState("");
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const savedNote = useRef(profile.notes.note);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<string | null>(null);
  const groupId = useId();

  const applied = (value: PlayerNotes) => {
    setNotes(value);
    setError(null);
    onNotes(value);
  };
  const failed = (reason: unknown) => setError(t.saveFailed(errorText(reason)));

  const saveNote = (text: string) => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (text === savedNote.current) return;
    setNoteState("saving");
    ipc
      .playerSetNote(site, player, text)
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
        ipc.playerSetNote(site, player, pending.current).catch(() => undefined);
      }
    },
    [site, player],
  );

  const setColour = (colour: PlayerColour | null) => {
    ipc.playerSetColour(site, player, colour).then(applied).catch(failed);
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
    ipc
      .playerAddLabel(site, player, value)
      .then((result) => {
        setLabel("");
        applied(result);
      })
      .catch(failed);
  };

  return (
    <div className={styles.words}>
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
                onClick={() => ipc.playerRemoveLabel(site, player, name).then(applied).catch(failed)}
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
      <p className={styles.footnote}>{t.localOnly}</p>
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
function Breakdown({ profile, definitions }: { profile: Profile; definitions: StatDefinition[] }) {
  const all = useT();
  const t = all.players.profile;
  const f = all.hands.filters;
  const [tab, setTab] = useState<Tab>("position");
  const panelId = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const columns = profile.columns.map((id) => definitions.find((definition) => definition.id === id) ?? null);

  const choose = (next: Tab) => setTab(next);
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
      choose(chosen);
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
    case "size":
      rows = [...profile.bySize].sort((a, b) => rank(SIZE_ORDER, a.key) - rank(SIZE_ORDER, b.key));
      label = (row) => (f.sizes as Record<string, string>)[row.key] ?? row.key;
      break;
    case "format":
      rows = [...profile.byFormat].sort((a, b) => rank(FORMAT_ORDER, a.key) - rank(FORMAT_ORDER, b.key));
      label = (row) => (f.formats as Record<string, string>)[row.key] ?? row.key;
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
            onClick={() => choose(entry)}
          >
            {t.tabs[entry]}
          </button>
        ))}
      </div>
      <div id={`${panelId}-panel`} role="tabpanel" aria-labelledby={`${panelId}-${tab}`}>
        {rows.length === 0 ? (
          <p className={styles.muted}>{t.empty}</p>
        ) : (
          <GroupTable head={t.heads[tab]} rows={rows} columns={columns} label={label} />
        )}
      </div>
    </div>
  );
}
