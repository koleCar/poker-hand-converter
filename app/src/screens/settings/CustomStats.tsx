/**
 * Settings, Your statistics (docs/RAIL-PLAN.md R2.10; guideline §5
 * "Custom statistike: editor u sučelju gradi definiciju iz formule i odmah
 * pokazuje vrijednost na korisnikovim rukama").
 *
 * The list of the user's own statistics - each with its value over all their
 * hands as far as the background pass has counted it - and the editor: a
 * counter (the predicate language over decision events,
 * docs/STATS-SPEC.md §14) and a formula, each checked by the Rust side as the
 * user types (`custom_stat_check`) with what is wrong underlined in place,
 * and a live preview of the value on the user's last hands. Labels, format,
 * colour bands and the minimum sample are the R2.4 definition's. Nothing is
 * computed here (guideline §14): every number and every problem is the Rust
 * side's.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@rail/ui/dialog/Dialog";
import type { StatDefinition, StatGroup, StatTone, StatUnit } from "@rail/ui/model/stats";
import { StatValue } from "@rail/ui/stats/StatValue";

import { RecomputeNotice, useRecompute } from "../../components/RecomputeNotice";
import { useLocale, useT } from "../../i18n";
import {
  errorText,
  ipc,
  type CustomCheck,
  type CustomDraft,
  type CustomList,
  type CustomProblem,
  type CustomStat,
} from "../../lib/ipc";
import { refreshStatDefinitions } from "../../lib/useStatDefinitions";
import styles from "./CustomStats.module.css";

const GROUPS: readonly StatGroup[] = ["preflop", "postflop", "showdown", "results"];
const UNITS: readonly StatUnit[] = ["percent", "ratio", "count", "bb", "bb_per_100", "money"];
const TONES: readonly StatTone[] = ["very-low", "low", "normal", "high", "very-high"];

/** How long typing pauses before the draft is checked. */
const CHECK_DEBOUNCE_MS = 250;
/** How often the list is read again while the pass counts. */
const PROGRESS_POLL_MS = 2000;

/** The examples the editor offers (their names are in the dictionary). */
const EXAMPLES = {
  cbet3bet:
    "first street = flop and first_on_street and preflop_aggressor and facing = none and preflop_raises = 2 => action = bet",
  foldCbetMultiway: "first street = flop and facing_cbet and multiway => action = fold",
  smallCbet:
    "first street = flop and first_on_street and preflop_aggressor and facing = none => action = bet and size_pot <= 40",
  bigOpen:
    "first street = preflop and first_on_street and facing = none and not bomb_pot => action = raise and size_bb > 3",
  shortShove:
    "first street = preflop and first_on_street and facing = none and stack_bb <= 15 and not bomb_pot => action = raise and all_in",
  riverCallBig: "first street = river and facing = bet and facing_size_pot >= 100 => action = call",
} as const;
type ExampleKey = keyof typeof EXAMPLES;

/** One colour band as the form holds it: the limit as typed; the last band has none. */
interface BandForm {
  below: string;
  tone: StatTone;
}

interface Form {
  id: string;
  /** The id was typed, not derived from the name. */
  idTouched: boolean;
  name: string;
  label: string;
  description: string;
  group: StatGroup;
  predicate: string;
  formula: string;
  unit: StatUnit;
  decimals: number;
  sampleMin: number;
  sampleOf: string;
  bands: BandForm[];
}

const EMPTY_FORM: Form = {
  id: "",
  idTouched: false,
  name: "",
  label: "",
  description: "",
  group: "postflop",
  predicate: "",
  formula: "",
  unit: "percent",
  decimals: 1,
  sampleMin: 50,
  sampleOf: "",
  bands: [],
};

/** An id from a name: lower-case ASCII, digits and `_`, starting with a letter. */
export function idFrom(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 56);
  if (slug === "") return "";
  return /^[a-z]/.test(slug) ? slug : `my_${slug}`;
}

function formOf(stat: CustomStat): Form {
  const d = stat.definition;
  const own = `pct(${d.id}, ${d.id}_opp)`;
  return {
    id: d.id,
    idTouched: true,
    name: d.name.en,
    label: d.label.en,
    description: d.description.en === d.name.en ? "" : d.description.en,
    group: d.group,
    predicate: stat.predicate ?? "",
    formula: stat.predicate !== null && d.formula === own ? "" : d.formula,
    unit: d.format.unit,
    decimals: d.format.decimals,
    sampleMin: d.sample.min,
    sampleOf: d.sample.of ?? "",
    bands: d.bands.map((band) => ({ below: band.below === undefined ? "" : String(band.below), tone: band.tone })),
  };
}

/** The definition the form describes (the user's words in every language). */
function draftOf(form: Form): CustomDraft {
  const words = (text: string) => ({ en: text, hr: text });
  const name = form.name.trim();
  const predicate = form.predicate.trim() === "" ? null : form.predicate;
  const formula = form.formula.trim() !== "" ? form.formula : predicate !== null ? `pct(${form.id}, ${form.id}_opp)` : "";
  const definition: StatDefinition = {
    id: form.id,
    group: form.group,
    players: "any",
    label: words(form.label.trim()),
    name: words(name),
    description: words(form.description.trim() || name),
    formula,
    format: { unit: form.unit, decimals: form.unit === "count" ? 0 : form.decimals },
    sample: form.sampleOf.trim() === "" ? { min: form.sampleMin } : { of: form.sampleOf, min: form.sampleMin },
    bands: form.bands.map((band, index) =>
      index === form.bands.length - 1 || band.below.trim() === ""
        ? { tone: band.tone }
        : { below: Number(band.below.replace(",", ".")), tone: band.tone },
    ),
    hud: "none",
  };
  return { definition, predicate };
}

/** The UTF-16 index of byte `offset` of `text`'s UTF-8 (the Rust side counts bytes). */
export function indexOfByte(text: string, offset: number): number {
  let bytes = 0;
  let i = 0;
  while (i < text.length && bytes < offset) {
    const point = text.codePointAt(i) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    i += point > 0xffff ? 2 : 1;
  }
  return i;
}

/** A code field (the counter, a formula): a textarea with what is wrong underlined behind it. */
function CodeField({
  label,
  hint,
  value,
  onChange,
  problems,
  rows,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  problems: CustomProblem[];
  rows: number;
  placeholder?: string;
}) {
  const id = useId();
  const backdrop = useRef<HTMLDivElement>(null);
  const spans = problems.filter((p) => p.offset !== null);
  // The text with the first problem's span marked; a span at the very end
  // marks a space so its underline shows.
  let marked: ReactNode = value;
  const first = spans[0];
  if (first && first.offset !== null) {
    const start = indexOfByte(value, first.offset);
    const end = indexOfByte(value, first.offset + (first.length ?? 0));
    marked = (
      <>
        {value.slice(0, start)}
        <mark className={styles.mark}>{end > start ? value.slice(start, end) : " "}</mark>
        {value.slice(end)}
      </>
    );
  }
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <div className={styles.code}>
        <div ref={backdrop} className={styles.backdrop} aria-hidden="true">
          {marked}
          {"\n"}
        </div>
        <textarea
          id={id}
          className={styles.textarea}
          rows={rows}
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={placeholder}
          aria-invalid={problems.length > 0}
          aria-describedby={`${id}-hint ${id}-problems`}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            if (backdrop.current) backdrop.current.scrollTop = event.currentTarget.scrollTop;
          }}
        />
      </div>
      <span id={`${id}-hint`} className={styles.hint}>
        {hint}
      </span>
      <ul id={`${id}-problems`} className={styles.problems} aria-live="polite">
        {problems.map((problem, index) => (
          <li key={index}>{problem.message}</li>
        ))}
      </ul>
    </div>
  );
}

/** A plain input with its label and hint. */
function TextField({
  label,
  hint,
  value,
  onChange,
  problems = [],
  maxLength,
  mono = false,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  problems?: CustomProblem[];
  maxLength?: number;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <input
        id={id}
        className={mono ? `${styles.input} ${styles.mono}` : styles.input}
        value={value}
        maxLength={maxLength}
        spellCheck={!mono}
        aria-invalid={problems.length > 0}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <span id={`${id}-hint`} className={styles.hint}>
          {hint}
        </span>
      ) : null}
      {problems.length > 0 ? (
        <ul className={styles.problems}>
          {problems.map((problem, index) => (
            <li key={index}>{problem.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Editor({
  list,
  editing,
  onSaved,
  onCancel,
}: {
  list: CustomList;
  /** The statistic being edited, or `null` for a new one. */
  editing: CustomStat | null;
  onSaved: (list: CustomList) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const f = t.settings.custom.form;
  const headingId = useId();
  const [form, setForm] = useState<Form>(() => (editing ? formOf(editing) : EMPTY_FORM));
  const [check, setCheck] = useState<CustomCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveProblems, setSaveProblems] = useState<CustomProblem[] | null>(null);
  const replacing = editing?.definition.id ?? null;
  const ready = form.name.trim() !== "" && form.label.trim() !== "" && form.id !== "";
  const draft = useMemo(() => draftOf(form), [form]);
  // What is checked as the user types: the draft, with stand-ins for the
  // words not typed yet, so a counter is checked and previewed before the
  // statistic has a name.
  const checked = useMemo(
    () =>
      draftOf({
        ...form,
        id: form.id || "my_statistic",
        name: form.name.trim() || "-",
        label: form.label.trim() || "-",
      }),
    [form],
  );

  // Check (and preview) the draft once typing pauses; a late answer for an
  // older draft is dropped.
  const sequence = useRef(0);
  useEffect(() => {
    const mine = ++sequence.current;
    const timer = window.setTimeout(() => {
      setChecking(true);
      ipc
        .customStatCheck(checked, replacing)
        .then((answer) => {
          if (mine === sequence.current) setCheck(answer);
        })
        .catch((error: unknown) => {
          if (mine === sequence.current)
            setCheck({ problems: [{ part: "other", offset: null, length: null, message: errorText(error) }], preview: null });
        })
        .finally(() => {
          if (mine === sequence.current) setChecking(false);
        });
    }, CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [checked, replacing]);

  const set = (change: Partial<Form>) => {
    setSaveProblems(null);
    setForm((current) => {
      const next = { ...current, ...change };
      if (change.name !== undefined && !current.idTouched) next.id = idFrom(change.name);
      return next;
    });
  };

  const problems = saveProblems ?? check?.problems ?? [];
  const of = (part: CustomProblem["part"]) => problems.filter((problem) => problem.part === part);
  // A problem of the formula the form filled in (pct(id, id_opp)) has no
  // text to underline.
  const formulaProblems = form.formula.trim() === "" ? of("formula").map((p) => ({ ...p, offset: null })) : of("formula");

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const answer = await ipc.customStatSave(draft, replacing);
      if (answer.list) {
        refreshStatDefinitions();
        onSaved(answer.list);
      } else {
        setSaveProblems(answer.problems);
      }
    } catch (error: unknown) {
      setSaveError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const preview = check?.preview ?? null;
  const fields = list.fields;

  return (
    <section className={styles.editor} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.subheading}>
        {editing ? f.editHeading(editing.definition.name.en) : f.newHeading}
      </h3>
      <div className={styles.grid}>
        <TextField label={f.name} hint={f.nameHint} value={form.name} onChange={(name) => set({ name })} maxLength={80} />
        <TextField label={f.label} hint={f.labelHint} value={form.label} onChange={(label) => set({ label })} maxLength={12} />
        <TextField
          label={f.id}
          hint={f.idHint}
          value={form.id}
          mono
          maxLength={60}
          problems={of("id")}
          onChange={(id) => set({ id: id.toLowerCase(), idTouched: true })}
        />
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${headingId}-group`}>
            {f.group}
          </label>
          <select
            id={`${headingId}-group`}
            className={styles.input}
            value={form.group}
            onChange={(event) => set({ group: event.target.value as StatGroup })}
          >
            {GROUPS.map((group) => (
              <option key={group} value={group}>
                {f.groups[group]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <TextField
        label={f.description}
        hint={f.descriptionHint}
        value={form.description}
        onChange={(description) => set({ description })}
        maxLength={300}
      />
      <CodeField
        label={f.predicate}
        hint={f.predicateHint}
        value={form.predicate}
        rows={3}
        problems={of("predicate")}
        onChange={(predicate) => set({ predicate })}
      />
      <CodeField
        label={f.formula}
        hint={f.formulaHint(form.id || "id")}
        value={form.formula}
        rows={2}
        placeholder={form.predicate.trim() !== "" && form.id !== "" ? `pct(${form.id}, ${form.id}_opp)` : undefined}
        problems={formulaProblems}
        onChange={(formula) => set({ formula })}
      />

      <div className={styles.grid}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${headingId}-unit`}>
            {f.unit}
          </label>
          <select
            id={`${headingId}-unit`}
            className={styles.input}
            value={form.unit}
            onChange={(event) => set({ unit: event.target.value as StatUnit })}
          >
            {UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {f.units[unit]}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${headingId}-decimals`}>
            {f.decimals}
          </label>
          <input
            id={`${headingId}-decimals`}
            className={styles.input}
            type="number"
            min={0}
            max={6}
            disabled={form.unit === "count"}
            value={form.unit === "count" ? 0 : form.decimals}
            onChange={(event) => set({ decimals: Math.max(0, Math.min(6, Math.trunc(Number(event.target.value) || 0))) })}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${headingId}-min`}>
            {f.sampleMin}
          </label>
          <input
            id={`${headingId}-min`}
            className={styles.input}
            type="number"
            min={0}
            value={form.sampleMin}
            aria-describedby={`${headingId}-min-hint`}
            onChange={(event) => set({ sampleMin: Math.max(0, Math.trunc(Number(event.target.value) || 0)) })}
          />
          <span id={`${headingId}-min-hint`} className={styles.hint}>
            {f.sampleMinHint}
          </span>
        </div>
      </div>
      <CodeField
        label={f.sampleOf}
        hint={f.sampleOfHint}
        value={form.sampleOf}
        rows={1}
        problems={of("sample")}
        onChange={(sampleOf) => set({ sampleOf })}
      />

      <fieldset className={styles.bands}>
        <legend className={styles.label}>{f.bands}</legend>
        <span className={styles.hint}>{f.bandsHint}</span>
        {form.bands.map((band, index) => {
          const last = index === form.bands.length - 1;
          return (
            <div key={index} className={styles.band}>
              {last ? (
                <span className={styles.bandRest}>{f.rest}</span>
              ) : (
                <label className={styles.bandBelow}>
                  <span>{f.below}</span>
                  <input
                    className={styles.input}
                    inputMode="decimal"
                    value={band.below}
                    onChange={(event) =>
                      set({ bands: form.bands.map((b, i) => (i === index ? { ...b, below: event.target.value } : b)) })
                    }
                  />
                </label>
              )}
              <select
                className={styles.input}
                aria-label={`${last ? f.rest : `${f.below} ${band.below}`}`}
                value={band.tone}
                onChange={(event) =>
                  set({
                    bands: form.bands.map((b, i) => (i === index ? { ...b, tone: event.target.value as StatTone } : b)),
                  })
                }
              >
                {TONES.map((tone) => (
                  <option key={tone} value={tone}>
                    {f.tones[tone]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={styles.secondary}
                aria-label={f.removeBand(index + 1)}
                onClick={() => set({ bands: form.bands.filter((_, i) => i !== index) })}
              >
                {f.remove}
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className={styles.secondary}
          onClick={() =>
            set({
              bands:
                form.bands.length === 0
                  ? [
                      { below: "", tone: "low" },
                      { below: "", tone: "normal" },
                    ]
                  : [...form.bands.slice(0, -1), { below: "", tone: "normal" }, ...form.bands.slice(-1)],
            })
          }
        >
          {f.addBand}
        </button>
      </fieldset>

      {of("other").length > 0 ? (
        <div className={styles.other} role="alert">
          <span className={styles.label}>{f.problems}</span>
          <ul className={styles.problems}>
            {of("other").map((problem, index) => (
              <li key={index}>{problem.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.preview} aria-live="polite">
        <span className={styles.label}>{f.preview}</span>
        {checking && !preview ? (
          <span className={styles.hint}>{f.checking}</span>
        ) : preview ? (
          <>
            <span className={styles.previewValue}>
              <StatValue shown={preview.shown} unit={form.unit} />
            </span>
            <span className={styles.hint}>
              {preview.sample ? f.previewSample(preview.hands) : f.previewAll(preview.hands)}
              {preview.made !== null && preview.opp !== null ? ` · ${f.previewCounts(preview.made, preview.opp)}` : ""}
            </span>
            {preview.shown.value === null ? <span className={styles.hint}>{f.noValue}</span> : null}
            {preview.sample ? <span className={styles.hint}>{f.afterSave}</span> : null}
          </>
        ) : null}
      </div>

      {saveError ? <p className={styles.error}>{f.saveFailed(saveError)}</p> : null}
      {!ready ? <p className={styles.hint}>{f.nameMissing}</p> : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          disabled={!ready || saving || problems.length > 0}
          onClick={() => void save()}
        >
          {saving ? f.saving : f.save}
        </button>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          {f.cancel}
        </button>
      </div>

      <details className={styles.reference}>
        <summary>{f.reference}</summary>
        <p className={styles.label}>{f.examples}</p>
        <ul className={styles.examples}>
          {(Object.keys(EXAMPLES) as ExampleKey[]).map((key) => (
            <li key={key}>
              <button
                type="button"
                className={styles.example}
                onClick={() =>
                  set({
                    predicate: EXAMPLES[key],
                    ...(form.name.trim() === "" ? { name: f.exampleNames[key] } : {}),
                  })
                }
              >
                <span>{f.exampleNames[key]}</span>
                <code className={styles.mono}>{EXAMPLES[key]}</code>
              </button>
            </li>
          ))}
        </ul>
        <p className={styles.label}>{f.fields}</p>
        <dl className={styles.fields}>
          {fields.map((field) => (
            <div key={field.name} className={styles.fieldRow}>
              <dt className={styles.mono}>{field.name}</dt>
              <dd>
                {f.fieldKinds[field.kind]}
                {field.choices.length > 0 ? ` ${field.choices.join(", ")}` : ""}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

export function CustomStats() {
  const t = useT();
  const c = t.settings.custom;
  const locale = useLocale();
  const headingId = useId();
  const [list, setList] = useState<CustomList | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** `undefined`: no editor; `null`: a new statistic. */
  const [editing, setEditing] = useState<CustomStat | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<CustomStat | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = () => {
    ipc
      .customStatsList()
      .then((next) => {
        setList(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  };
  useEffect(load, []);
  // A recompute after an upgrade (R2.11): its progress, here with the
  // statistics.
  const recompute = useRecompute();

  // While the background pass counts, read the list again now and then.
  const counting = list?.stats.some((stat) => (stat.remaining ?? 0) > 0) ?? false;
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(load, PROGRESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [counting]);

  const remove = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const answer = await ipc.customStatDelete(deleting.definition.id);
      setList(answer.list);
      if (answer.readBy !== null) {
        setDeleteError(c.deleteRefused(answer.readBy));
      } else {
        refreshStatDefinitions();
        setDeleting(null);
      }
    } catch (e: unknown) {
      setDeleteError(errorText(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        {c.heading}
      </h2>
      <p className={styles.body}>{c.body}</p>
      <RecomputeNotice status={recompute} className={styles.hint} />
      {error ? <p className={styles.error}>{c.loadFailed(error)}</p> : null}
      {list === null && !error ? <p className={styles.hint}>{c.loading}</p> : null}
      {list && list.stats.length === 0 ? <p className={styles.hint}>{c.empty}</p> : null}
      {list && list.stats.length > 0 ? (
        <table className={styles.table}>
          <caption className={styles.visuallyHidden}>{c.list}</caption>
          <thead>
            <tr>
              <th scope="col">{c.columns.name}</th>
              <th scope="col">{c.columns.value}</th>
              <th scope="col">{c.columns.status}</th>
              <th scope="col">
                <span className={styles.visuallyHidden}>{c.columns.actions}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.stats.map((stat) => {
              const d = stat.definition;
              return (
                <tr key={d.id}>
                  <th scope="row" title={d.description[locale]}>
                    <span className={styles.statName}>{d.name[locale]}</span>
                    <span className={`${styles.hint} ${styles.mono}`}> {d.label[locale]}</span>
                    {stat.problems.length > 0 ? (
                      <span className={styles.error}>
                        {" "}
                        {c.broken} {stat.problems.map((p) => p.message).join("; ")}
                      </span>
                    ) : null}
                  </th>
                  <td className={styles.value}>{stat.shown ? <StatValue shown={stat.shown} unit={d.format.unit} /> : "—"}</td>
                  <td className={styles.hint}>
                    {stat.remaining === null || stat.total === null
                      ? c.formulaOnly
                      : stat.remaining > 0
                        ? c.counting(stat.total - stat.remaining, stat.total)
                        : c.counted(stat.total)}
                  </td>
                  <td className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.secondary}
                      aria-label={c.editNamed(d.name[locale])}
                      onClick={() => setEditing(stat)}
                    >
                      {c.edit}
                    </button>
                    <button
                      type="button"
                      className={styles.danger}
                      aria-label={c.deleteNamed(d.name[locale])}
                      onClick={() => {
                        setDeleteError(null);
                        setDeleting(stat);
                      }}
                    >
                      {c.delete}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {list && editing === undefined ? (
        <button type="button" className={styles.button} onClick={() => setEditing(null)}>
          {c.add}
        </button>
      ) : null}
      {list && editing !== undefined ? (
        <Editor
          key={editing?.definition.id ?? "new"}
          list={list}
          editing={editing}
          onSaved={(next) => {
            setList(next);
            setEditing(undefined);
          }}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}
      {deleting ? (
        <Dialog title={c.deleteHeading} onClose={() => setDeleting(null)}>
          <p className={styles.body}>{c.deleteBody(deleting.definition.name[locale])}</p>
          {deleteError ? <p className={styles.error}>{deleteError}</p> : null}
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondary} disabled={deleteBusy} onClick={() => setDeleting(null)}>
              {c.form.cancel}
            </button>
            <button type="button" className={styles.dangerSolid} disabled={deleteBusy} onClick={() => void remove()}>
              {deleteBusy ? c.deleting : c.deleteConfirm}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
