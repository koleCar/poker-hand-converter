//! The benchmark's input: **generated** hand-history files, built on the fly
//! by replicating the repository's corpus with rewritten hand ids
//! (docs/RAIL-PLAN.md R1.6). Never committed, never under `testdata/` or a
//! fixture tree: it is written to a temporary directory whose name and
//! `GENERATED.md` say what it is, and removed after the run.
//!
//! How a copy is made: every corpus file the core turns into hands is a
//! *template*. Its hand ids' digit runs (four digits or more) are collected;
//! copy *c* rewrites every such run in the file through a permutation of the
//! digits 1-9 (0 stays 0, so a leading digit stays non-zero and the length
//! is kept - no offsets move, no parser sees a longer number). The
//! permutation is a bijection, so the hands of one copy keep distinct ids,
//! and copy 0 is the corpus itself. A template is used only if its first
//! rewritten copy converts into exactly as many hands and refusals as the
//! original with none of the original hand keys: files whose ids cannot be
//! rewritten this way (no digit run, or a key built from something else)
//! are left out and counted.
//!
//! The rewrite works on code units: bytes for UTF-8 and Windows-1252 (no
//! multi-byte UTF-8 sequence contains an ASCII digit), 16-bit units for
//! UTF-16 LE / BE.
//!
//! **Player names** (`--rename-players`, R2.7c; off by default, so CI's
//! benchmark is unchanged): without it every copy holds the corpus's few
//! thousand opponents again, far fewer players than a real store of that
//! size. With it, copy *c* also rewrites every villain's name through a
//! per-copy permutation of the ASCII letters that keeps each letter's class
//! (`a-f`, `g-z`, `A-F`, `G-Z`: an opaque hex token stays a hex token, so
//! no room's anonymisation changes) - the same length, so again no offset
//! moves. A name is rewritten wherever it stands as a whole word (the bytes
//! around it are not letters, digits or `_`); a hero's name never is. A
//! template's names are rewritten only if its first renamed copy converts
//! to the same hands with exactly the expected names, the same heroes and
//! the same anonymisation; otherwise its copies keep the corpus's names
//! (counted). Byte templates only (UTF-16 files keep their names).
//!
//! **Dates** (`--spread`, R2.9; off by default, so CI's import benchmark is
//! unchanged): without it every copy is played on the corpus's own days,
//! so at a million hands a day holds ~140 copies of a corpus day - about
//! fifty times a real day. With it, copy *c* is played [`SPREAD_DAYS`] x
//! *c* days earlier: every date in the file (`2026/02/17`, `2026-02-17`,
//! `2014/3/9`; for the templates that need it `3/9/2014` read month first
//! or day first, and Unix times in seconds) moves back by that many days in
//! the room's own calendar, the time of day and the weekday kept. A million
//! hands then span ~2.7 years back from the corpus, and a day holds the
//! hands of the few corpus days that land on it: real sessions (the corpus
//! files are real tables at their real pace) at a realistic daily volume.
//! A template's dates move only if its first shifted copy converts to the
//! same hands, each dealt exactly that many days earlier (give or take the
//! hour a daylight-saving change makes); otherwise its copies keep the
//! corpus's dates (counted). Byte templates only.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use rail_core::convert::{FileConversion, convert_file};
use rail_core::decode::Encoding;
use rail_core::detect::ConvertOptions;
use rail_core::phf::PhfHand;

/// Digit runs shorter than this are never rewritten (too common: amounts,
/// seats, times).
const MIN_RUN: usize = 4;

/// `--spread`: copy *c* is played this many days x *c* earlier (whole
/// weeks keep every weekday a room may print).
pub const SPREAD_DAYS: i64 = 7;

/// How a template's dates are read (`--spread`): year first always, plus
/// the forms its first shifted copy needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct DateStyle {
    /// `M/D/YYYY`.
    mdy: bool,
    /// `D/M/YYYY`.
    dmy: bool,
    /// Unix times in seconds (ten digits, not a hand id's run).
    epoch: bool,
}

/// The styles tried, in order.
const DATE_STYLES: [DateStyle; 6] = [
    DateStyle {
        mdy: false,
        dmy: false,
        epoch: false,
    },
    DateStyle {
        mdy: true,
        dmy: false,
        epoch: false,
    },
    DateStyle {
        mdy: false,
        dmy: true,
        epoch: false,
    },
    DateStyle {
        mdy: false,
        dmy: false,
        epoch: true,
    },
    DateStyle {
        mdy: true,
        dmy: false,
        epoch: true,
    },
    DateStyle {
        mdy: false,
        dmy: true,
        epoch: true,
    },
];

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day number (`civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// `(year, month, day)` moved by `shift` days, if it is a real date in a
/// plausible year.
fn shifted_date(year: i64, month: i64, day: i64, shift: i64) -> Option<(i64, i64, i64)> {
    if !(1990..=2099).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    (civil_from_days(days) == (year, month, day)).then(|| civil_from_days(days + shift))
}

/// A month or day as written: a two-digit original keeps its zero, a
/// one-digit one stays unpadded.
fn digits(value: i64, width: usize) -> String {
    if width >= 2 {
        format!("{value:02}")
    } else {
        value.to_string()
    }
}

/// The value of an ASCII digit run.
fn number(run: &[u8]) -> i64 {
    run.iter()
        .fold(0, |acc, digit| acc * 10 + i64::from(digit - b'0'))
}

/// `bytes` with every date (in `style`) moved by `shift` days; Unix times
/// in seconds by as many days' seconds, unless the run is one of `ids`.
fn shift_dates(bytes: &[u8], shift: i64, style: DateStyle, ids: &HashSet<Vec<u8>>) -> Vec<u8> {
    // Maximal digit runs: (start, end).
    let mut runs = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            runs.push((start, i));
        } else {
            i += 1;
        }
    }
    let sep_between = |a: (usize, usize), b: (usize, usize)| -> Option<u8> {
        (b.0 == a.1 + 1 && matches!(bytes[a.1], b'/' | b'-' | b'.')).then(|| bytes[a.1])
    };
    let mut out = Vec::with_capacity(bytes.len() + 16);
    let mut copied = 0;
    let mut k = 0;
    while k < runs.len() {
        let (start, end) = runs[k];
        let len = end - start;
        let mut replaced: Option<(usize, String)> = None;
        if k + 2 < runs.len()
            && let (Some(s1), Some(s2)) = (
                sep_between(runs[k], runs[k + 1]),
                sep_between(runs[k + 1], runs[k + 2]),
            )
            && s1 == s2
        {
            let (b, c) = (runs[k + 1], runs[k + 2]);
            let (lb, lc) = (b.1 - b.0, c.1 - c.0);
            let sep = char::from(s1);
            if len == 4 && (1..=2).contains(&lb) && (1..=2).contains(&lc) {
                if let Some((y, m, d)) = shifted_date(
                    number(&bytes[start..end]),
                    number(&bytes[b.0..b.1]),
                    number(&bytes[c.0..c.1]),
                    shift,
                ) {
                    let text = format!("{y}{sep}{}{sep}{}", digits(m, lb), digits(d, lc));
                    replaced = Some((c.1, text));
                }
            } else if (style.mdy || style.dmy)
                && (1..=2).contains(&len)
                && (1..=2).contains(&lb)
                && lc == 4
            {
                let (first, second) = (number(&bytes[start..end]), number(&bytes[b.0..b.1]));
                let (m, d) = if style.mdy {
                    (first, second)
                } else {
                    (second, first)
                };
                if let Some((y, m2, d2)) = shifted_date(number(&bytes[c.0..c.1]), m, d, shift) {
                    let (a2, b2) = if style.mdy { (m2, d2) } else { (d2, m2) };
                    let text = format!("{}{sep}{}{sep}{y}", digits(a2, len), digits(b2, lb));
                    replaced = Some((c.1, text));
                }
            }
        }
        if replaced.is_none() && style.epoch && len == 10 && !ids.contains(&bytes[start..end]) {
            let seconds = number(&bytes[start..end]);
            if (1_000_000_000..2_000_000_000).contains(&seconds) {
                replaced = Some((end, (seconds + shift * 86_400).to_string()));
            }
        }
        if let Some((until, text)) = replaced {
            out.extend_from_slice(&bytes[copied..start]);
            out.extend_from_slice(text.as_bytes());
            copied = until;
            while k < runs.len() && runs[k].0 < until {
                k += 1;
            }
        } else {
            k += 1;
        }
    }
    out.extend_from_slice(&bytes[copied..]);
    out
}

/// Copy `copy`'s date shift under `--spread`, in days.
pub fn spread_shift(copy: usize) -> i64 {
    -SPREAD_DAYS * i64::try_from(copy).expect("copy")
}

/// A corpus file that can be replicated.
#[derive(Debug, Clone)]
pub struct Template {
    /// Path relative to the repository root.
    pub relative: PathBuf,
    pub bytes: Vec<u8>,
    unit: Unit,
    runs: HashSet<Vec<u8>>,
    /// Hands one copy of it stores (distinct keys).
    pub hands: usize,
    /// Their keys in the corpus.
    keys: HashSet<String>,
    /// The parser of its first hand.
    parser: String,
    /// Villain names rewritten in its copies (`--rename-players`; empty:
    /// the corpus's names).
    names: Vec<Vec<u8>>,
    /// How its dates move (`--spread`; `None`: the corpus's dates).
    dates: Option<DateStyle>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unit {
    Byte,
    Le16,
    Be16,
}

/// Every corpus file (the inputs the goldens list).
pub fn corpus(root: &Path) -> Vec<PathBuf> {
    let golden = root.join("testdata/golden");
    let mut files = Vec::new();
    let mut stack = vec![golden.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("testdata/golden") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                files.push(
                    path.strip_prefix(&golden)
                        .expect("prefix")
                        .with_extension(""),
                );
            }
        }
    }
    files.sort();
    files
}

/// The conversion options the watcher's reader uses for a file (validated,
/// with its name).
pub fn options(name: &Path) -> ConvertOptions {
    ConvertOptions {
        source_filename: name.file_name().map(|n| n.to_string_lossy().into_owned()),
        validate: true,
        ..ConvertOptions::default()
    }
}

/// (hand keys, refusals) of a conversion; `None` when it threw or the bytes
/// are not text.
fn outline(conversion: &FileConversion) -> Option<(Vec<String>, usize)> {
    let result = conversion.result.as_ref()?.as_ref().ok()?;
    let keys = result
        .hands
        .iter()
        .map(|hand| rail_store::batch::hand_key_of(&hand.hand))
        .collect();
    Some((keys, result.failures.len()))
}

/// Maximal ASCII digit runs of `id`, at least [`MIN_RUN`] long.
fn digit_runs(id: &str) -> Vec<Vec<u8>> {
    id.as_bytes()
        .split(|byte| !byte.is_ascii_digit())
        .filter(|run| run.len() >= MIN_RUN)
        .map(<[u8]>::to_vec)
        .collect()
}

/// The digit permutation of copy `copy`: identity for 0, else a seeded
/// shuffle of 1-9 (0 fixed), distinct for every copy.
pub fn permutations(copies: usize) -> Vec<[u8; 10]> {
    let mut seen = HashSet::new();
    let mut list = Vec::with_capacity(copies);
    let identity: [u8; 10] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    seen.insert(identity);
    list.push(identity);
    let mut state: u64 = 0x5EED_0001_0006;
    while list.len() < copies {
        let mut perm = identity;
        // Fisher-Yates over 1..=9 with SplitMix64.
        for i in (2..=9_usize).rev() {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            let j = 1 + usize::try_from(z % u64::try_from(i).expect("small")).expect("small");
            perm.swap(i, j);
        }
        if seen.insert(perm) {
            list.push(perm);
        }
    }
    list
}

/// Copy `copy`'s letter map (`--rename-players`): identity for copy 0,
/// else a seeded shuffle within each class `a-f`, `g-z`, `A-F`, `G-Z`.
pub fn letter_map(copy: usize) -> [u8; 256] {
    let mut map = [0_u8; 256];
    for (i, slot) in map.iter_mut().enumerate() {
        *slot = u8::try_from(i).expect("byte");
    }
    if copy == 0 {
        return map;
    }
    let mut state: u64 = 0x5EED_0007_0C00 ^ u64::try_from(copy).expect("copy");
    for (first, last) in [(b'a', b'f'), (b'g', b'z'), (b'A', b'F'), (b'G', b'Z')] {
        let mut class: Vec<u8> = (first..=last).collect();
        for i in (1..class.len()).rev() {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            let j = usize::try_from(z % u64::try_from(i + 1).expect("small")).expect("small");
            class.swap(i, j);
        }
        for (letter, mapped) in (first..=last).zip(class) {
            map[usize::from(letter)] = mapped;
        }
    }
    map
}

/// Whether `byte` continues a word (a name's neighbours must not).
fn word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Every whole-word occurrence in `bytes` of a name in `names`, mapped
/// letter by letter through `map` (the same length).
fn rename(bytes: &mut [u8], names: &[Vec<u8>], map: &[u8; 256]) {
    let original = bytes.to_vec();
    for name in names {
        let Some(&first) = name.first() else { continue };
        let mut at = 0;
        while at + name.len() <= original.len() {
            if original[at] == first
                && original[at..at + name.len()] == name[..]
                && (at == 0 || !word_byte(original[at - 1]))
                && original
                    .get(at + name.len())
                    .is_none_or(|&next| !word_byte(next))
            {
                for (k, &byte) in name.iter().enumerate() {
                    bytes[at + k] = map[usize::from(byte)];
                }
                at += name.len();
            } else {
                at += 1;
            }
        }
    }
}

impl Template {
    /// Copy `copy` of the file: its id runs rewritten through `perm` and,
    /// when its names are rewritten, its villains' names through the copy's
    /// [`letter_map`].
    pub fn rewrite(&self, perm: &[u8; 10], copy: usize) -> Vec<u8> {
        let mut out = match self.dates {
            Some(style) if copy > 0 => {
                let moved = shift_dates(&self.bytes, spread_shift(copy), style, &self.runs);
                self.rewrite_ids(&moved, perm)
            }
            _ => self.rewrite_ids(&self.bytes, perm),
        };
        if copy > 0 && !self.names.is_empty() {
            rename(&mut out, &self.names, &letter_map(copy));
        }
        out
    }

    /// `bytes` (the file, its dates perhaps moved) with its id runs
    /// rewritten through `perm`.
    fn rewrite_ids(&self, bytes: &[u8], perm: &[u8; 10]) -> Vec<u8> {
        let mut out = bytes.to_vec();
        let width = if self.unit == Unit::Byte { 1 } else { 2 };
        let digit_at = |bytes: &[u8], at: usize| -> Option<u8> {
            let unit = match self.unit {
                Unit::Byte => u16::from(bytes[at]),
                Unit::Le16 => u16::from_le_bytes([bytes[at], bytes[at + 1]]),
                Unit::Be16 => u16::from_be_bytes([bytes[at], bytes[at + 1]]),
            };
            (0x30..=0x39)
                .contains(&unit)
                .then(|| u8::try_from(unit).expect("ASCII"))
        };
        let units = bytes.len() / width;
        let mut i = 0;
        let mut run = Vec::new();
        while i < units {
            if digit_at(bytes, i * width).is_none() {
                i += 1;
                continue;
            }
            let start = i;
            run.clear();
            while i < units
                && let Some(digit) = digit_at(bytes, i * width)
            {
                run.push(digit);
                i += 1;
            }
            if run.len() >= MIN_RUN && self.runs.contains(&run) {
                for (k, digit) in run.iter().enumerate() {
                    let mapped = b'0' + perm[usize::from(digit - b'0')];
                    let at = (start + k) * width;
                    match self.unit {
                        Unit::Byte => out[at] = mapped,
                        Unit::Le16 => out[at] = mapped,
                        Unit::Be16 => out[at + 1] = mapped,
                    }
                }
            }
        }
        out
    }
}

/// What [`templates`] kept and left out.
#[derive(Debug, Default)]
pub struct Selection {
    pub templates: Vec<Template>,
    pub corpus_files: usize,
    /// Files with no hands (refused, unclaimed, not text).
    pub no_hands: usize,
    /// Files with hands whose ids could not be rewritten.
    pub not_rewritable: usize,
    /// Files whose hands another kept file holds too (the corpus has some
    /// hands in several files): left out, so every hand converted is a
    /// hand stored and hands/s means one thing.
    pub repeats: usize,
    /// Parsers with at least one template.
    pub parsers: BTreeSet<String>,
    /// (`--rename-players`) Templates whose copies rename their villains,
    /// and those that keep the corpus's names (the check failed, or UTF-16).
    pub renamed: usize,
    pub names_kept: usize,
    /// (`--spread`) Templates whose copies move their dates, and those that
    /// keep the corpus's (the check failed, or UTF-16) with their hands.
    pub shifted: usize,
    pub dates_kept: usize,
    pub dates_kept_hands: usize,
}

/// Load the corpus and keep the files that can be replicated (see the
/// module docs), using `threads` threads; with `rename`, the villains'
/// names are rewritten in every copy but the first wherever that checks out;
/// with `spread`, likewise the dates.
pub fn templates(root: &Path, threads: usize, rename: bool, spread: bool) -> Selection {
    let files = corpus(root);
    let corpus_files = files.len();
    let next = AtomicUsize::new(0);
    let out = Mutex::new(Selection {
        corpus_files,
        ..Selection::default()
    });
    let check = perm_one();
    std::thread::scope(|scope| {
        for _ in 0..threads.max(1) {
            scope.spawn(|| {
                loop {
                    let n = next.fetch_add(1, Ordering::Relaxed);
                    let Some(relative) = files.get(n) else { break };
                    let verdict = template(root, relative, &check, rename, spread);
                    let mut out = out.lock().expect("selection");
                    match verdict {
                        Verdict::Keep(template) => out.templates.push(*template),
                        Verdict::NoHands => out.no_hands += 1,
                        Verdict::NotRewritable => out.not_rewritable += 1,
                    }
                }
            });
        }
    });
    let mut selection = out.into_inner().expect("selection");
    selection
        .templates
        .sort_by(|a, b| a.relative.cmp(&b.relative));
    let mut seen: HashSet<String> = HashSet::new();
    let mut kept = Vec::with_capacity(selection.templates.len());
    for template in std::mem::take(&mut selection.templates) {
        if template.keys.iter().any(|key| seen.contains(key)) {
            selection.repeats += 1;
            continue;
        }
        seen.extend(template.keys.iter().cloned());
        kept.push(template);
    }
    selection.parsers = kept.iter().map(|t| t.parser.clone()).collect();
    selection.renamed = kept.iter().filter(|t| !t.names.is_empty()).count();
    if rename {
        selection.names_kept = kept.len() - selection.renamed;
    }
    if spread {
        selection.shifted = kept.iter().filter(|t| t.dates.is_some()).count();
        selection.dates_kept = kept.len() - selection.shifted;
        selection.dates_kept_hands = kept
            .iter()
            .filter(|t| t.dates.is_none())
            .map(|t| t.hands)
            .sum();
    }
    selection.templates = kept;
    selection
}

fn perm_one() -> [u8; 10] {
    permutations(2)[1]
}

enum Verdict {
    Keep(Box<Template>),
    NoHands,
    NotRewritable,
}

fn template(root: &Path, relative: &Path, check: &[u8; 10], rename: bool, spread: bool) -> Verdict {
    let Ok(bytes) = std::fs::read(root.join(relative)) else {
        return Verdict::NoHands;
    };
    let options = options(relative);
    let conversion = convert_file(&bytes, &options);
    let Some((keys, refusals)) = outline(&conversion) else {
        return Verdict::NoHands;
    };
    if keys.is_empty() {
        return Verdict::NoHands;
    }
    let unit = match conversion.encoding {
        Encoding::Utf16Le | Encoding::Utf16LeNoBom => Unit::Le16,
        Encoding::Utf16Be | Encoding::Utf16BeNoBom => Unit::Be16,
        _ => Unit::Byte,
    };
    let Some(result) = conversion.result.as_ref().and_then(|r| r.as_ref().ok()) else {
        return Verdict::NoHands;
    };
    let mut runs = HashSet::new();
    for hand in &result.hands {
        let found = digit_runs(&hand.hand.meta.hand_id);
        if found.is_empty() {
            return Verdict::NotRewritable;
        }
        runs.extend(found);
    }
    let parser = result
        .hands
        .first()
        .map(|hand| hand.hand.meta.parser_id.clone())
        .unwrap_or_default();
    let mut template = Template {
        relative: relative.to_path_buf(),
        bytes,
        unit,
        runs,
        hands: keys.iter().collect::<HashSet<_>>().len(),
        keys: keys.iter().cloned().collect(),
        parser,
        names: Vec::new(),
        dates: None,
    };
    let copy = template.rewrite(check, 1);
    let Some((new_keys, new_refusals)) = outline(&convert_file(&copy, &options)) else {
        return Verdict::NotRewritable;
    };
    let old: HashSet<&String> = keys.iter().collect();
    let fresh: HashSet<&String> = new_keys.iter().collect();
    if new_keys.len() != keys.len()
        || new_refusals != refusals
        || fresh.len() != old.len()
        || new_keys.iter().any(|key| old.contains(key))
    {
        return Verdict::NotRewritable;
    }
    let hands: Vec<&PhfHand> = result.hands.iter().map(|hand| &hand.hand).collect();
    if spread && unit == Unit::Byte {
        template.dates = DATE_STYLES
            .into_iter()
            .find(|&style| shifts_cleanly(&template, style, &hands, refusals, check, &options));
    }
    if rename && unit == Unit::Byte {
        template.names = villain_names(&hands);
        if !template.names.is_empty() && !renames_cleanly(&template, &hands, check, &options) {
            template.names.clear();
        }
    }
    Verdict::Keep(Box::new(template))
}

/// The names a template's copies rewrite: every villain's (at least three
/// bytes, with a letter), never one that is a hero's in the file.
fn villain_names(hands: &[&PhfHand]) -> Vec<Vec<u8>> {
    let heroes: HashSet<&str> = hands
        .iter()
        .flat_map(|hand| hand.players.iter())
        .filter(|player| player.is_hero)
        .map(|player| player.name.as_str())
        .collect();
    let names: BTreeSet<Vec<u8>> = hands
        .iter()
        .flat_map(|hand| hand.players.iter())
        .filter(|player| !player.is_hero && !heroes.contains(player.name.as_str()))
        .map(|player| player.name.as_bytes().to_vec())
        .filter(|name| name.len() >= 3 && name.iter().any(u8::is_ascii_alphabetic))
        .collect();
    names.into_iter().collect()
}

/// Whether copy 1 with renamed villains converts to the same hands with
/// exactly the expected names, the same heroes and the same anonymisation.
fn renames_cleanly(
    template: &Template,
    hands: &[&PhfHand],
    check: &[u8; 10],
    options: &ConvertOptions,
) -> bool {
    let map = letter_map(1);
    let names: HashSet<&[u8]> = template.names.iter().map(Vec::as_slice).collect();
    let copy = template.rewrite(check, 1);
    let conversion = convert_file(&copy, options);
    let Some(Ok(result)) = conversion.result.as_ref() else {
        return false;
    };
    if result.hands.len() != hands.len() {
        return false;
    }
    hands.iter().zip(&result.hands).all(|(old, new)| {
        let new = &new.hand;
        old.players.len() == new.players.len()
            && anonymization(old) == anonymization(new)
            && old.players.iter().zip(&new.players).all(|(a, b)| {
                let expected: Vec<u8> = if names.contains(a.name.as_bytes()) {
                    a.name.bytes().map(|byte| map[usize::from(byte)]).collect()
                } else {
                    a.name.as_bytes().to_vec()
                };
                a.is_hero == b.is_hero && a.seat == b.seat && b.name.as_bytes() == expected
            })
    })
}

/// Whether copy 1 with its dates moved in `style` converts to as many new
/// hands and refusals, each hand dealt [`spread_shift`]`(1)` days earlier
/// (an hour either way for a daylight-saving change in the room's zone; an
/// undated hand stays undated).
fn shifts_cleanly(
    template: &Template,
    style: DateStyle,
    hands: &[&PhfHand],
    refusals: usize,
    check: &[u8; 10],
    options: &ConvertOptions,
) -> bool {
    let shift_ms = spread_shift(1) * 86_400_000;
    let mut trial = template.clone();
    trial.dates = Some(style);
    trial.names.clear();
    let copy = trial.rewrite(check, 1);
    let conversion = convert_file(&copy, options);
    let Some(Ok(result)) = conversion.result.as_ref() else {
        return false;
    };
    if result.hands.len() != hands.len() || result.failures.len() != refusals {
        return false;
    }
    let ms = |at: Option<&str>| at.and_then(rail_store::time::ms_from_iso);
    hands.iter().zip(&result.hands).all(|(old, new)| {
        let (old, new) = (old.played_at.as_deref(), new.hand.played_at.as_deref());
        match (ms(old), ms(new)) {
            (Some(a), Some(b)) => (b - a - shift_ms).abs() <= 3_600_000,
            (None, None) => old.is_none() && new.is_none(),
            _ => false,
        }
    })
}

/// The hand's anonymisation, as the store derives it.
fn anonymization(hand: &PhfHand) -> &'static str {
    rail_store::PreparedStats::from_phf(hand)
        .anonymization
        .as_str()
}

/// What [`write`] produced.
#[derive(Debug, Default)]
pub struct Dataset {
    pub dir: PathBuf,
    pub files: Vec<(PathBuf, u64)>,
    pub bytes: u64,
    /// Hands the copies convert into (some repeat across corpus files, as
    /// the corpus itself does).
    pub hands: u64,
    pub copies: usize,
}

/// Write `copies` copies of every template under `dir` (`copy-NNNN/<the
/// corpus path>`), with a `GENERATED.md` saying what this is, and every
/// file's mtime set a day back (a backfill reads old files; a file written
/// a moment ago would wait for the reader's quiet period).
pub fn write(dir: &Path, selection: &Selection, copies: usize, threads: usize) -> Dataset {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).expect("dataset dir");
    // Not `.txt`: the watcher would read the label as a hand history.
    std::fs::write(
        dir.join("GENERATED.md"),
        "GENERATED DATA - Rail import benchmark (docs/RAIL-PLAN.md R1.6).\n\
         Copies of the repository's corpus with every hand id's digits permuted\n\
         (with --rename-players, the villains' names' letters too; with\n\
         --spread, every date moved back a week per copy),\n\
         made on the fly by core/rail-watch/examples/import_bench. Not real hands\n\
         of anyone; never commit this directory. Safe to delete.\n",
    )
    .expect("label");
    let perms = permutations(copies);
    let jobs: Vec<(usize, usize)> = (0..copies)
        .flat_map(|c| (0..selection.templates.len()).map(move |t| (c, t)))
        .collect();
    let next = AtomicUsize::new(0);
    let written = Mutex::new(Vec::with_capacity(jobs.len()));
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 3600);
    std::thread::scope(|scope| {
        for _ in 0..threads.max(1) {
            scope.spawn(|| {
                loop {
                    let n = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&(copy, t)) = jobs.get(n) else { break };
                    let template = &selection.templates[t];
                    let path = dir.join(format!("copy-{copy:04}")).join(&template.relative);
                    std::fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
                    let bytes = template.rewrite(&perms[copy], copy);
                    std::fs::write(&path, &bytes).expect("write");
                    std::fs::File::options()
                        .write(true)
                        .open(&path)
                        .and_then(|file| file.set_modified(old))
                        .expect("mtime");
                    let size = u64::try_from(bytes.len()).expect("size");
                    written
                        .lock()
                        .expect("written")
                        .push((path, size, template.hands));
                }
            });
        }
    });
    let written = written.into_inner().expect("written");
    let mut dataset = Dataset {
        dir: dir.to_path_buf(),
        copies,
        ..Dataset::default()
    };
    for (path, size, hands) in written {
        dataset.bytes += size;
        dataset.hands += u64::try_from(hands).expect("hands");
        dataset.files.push((path, size));
    }
    dataset.files.sort();
    dataset
}
