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

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use rail_core::convert::{FileConversion, convert_file};
use rail_core::decode::Encoding;
use rail_core::detect::ConvertOptions;

/// Digit runs shorter than this are never rewritten (too common: amounts,
/// seats, times).
const MIN_RUN: usize = 4;

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

impl Template {
    /// The file with its id runs rewritten through `perm`.
    pub fn rewrite(&self, perm: &[u8; 10]) -> Vec<u8> {
        let mut out = self.bytes.clone();
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
        let units = self.bytes.len() / width;
        let mut i = 0;
        let mut run = Vec::new();
        while i < units {
            if digit_at(&self.bytes, i * width).is_none() {
                i += 1;
                continue;
            }
            let start = i;
            run.clear();
            while i < units
                && let Some(digit) = digit_at(&self.bytes, i * width)
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
}

/// Load the corpus and keep the files that can be replicated (see the
/// module docs), using `threads` threads.
pub fn templates(root: &Path, threads: usize) -> Selection {
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
                    let verdict = template(root, relative, &check);
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

fn template(root: &Path, relative: &Path, check: &[u8; 10]) -> Verdict {
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
    let template = Template {
        relative: relative.to_path_buf(),
        bytes,
        unit,
        runs,
        hands: keys.iter().collect::<HashSet<_>>().len(),
        keys: keys.iter().cloned().collect(),
        parser,
    };
    let copy = template.rewrite(check);
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
    Verdict::Keep(Box::new(template))
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
         Copies of the repository's corpus with every hand id's digits permuted,\n\
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
                    let bytes = template.rewrite(&perms[copy]);
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
