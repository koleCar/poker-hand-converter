//! Folder discovery: which of the rooms' default hand-history folders
//! exist on this computer (docs/RAIL-PLAN.md R1.4; guideline §3, "Prvo
//! pokretanje"). The first-run screen lists what [`discover`] finds - room,
//! folder, how many hand-history files, the newest one's date, whether it is
//! watched already - and the user confirms; confirming is
//! [`crate::Watcher::add_source_with`].
//!
//! # Templates
//!
//! Each `config/sites.json` entry has folder templates per OS
//! (`paths.macos`, `paths.windows`). A template is cut into folder names:
//!
//! - its root: `~` (the home folder) or `/` on macOS; `%NAME%` (an
//!   environment variable, e.g. `%LOCALAPPDATA%`) or a drive (`C:`) on
//!   Windows;
//! - then names, where `*` is any run of characters and `?` one, matched
//!   against the folders that exist, ASCII case ignored, hidden folders only
//!   when the pattern itself starts with a dot. A `*` level is typically an
//!   account name (`.../HandHistory/*`): every account folder is a folder
//!   of its own in the result.
//!
//! `..` and `.` are refused (a template names folders under its root,
//! nothing else); a variable that is not set, or a missing home, expands to
//! nothing.
//!
//! # What is counted, and how much work it is
//!
//! Every folder found is walked to count its hand-history files: those
//! matching the room's `files.glob`, or - when the glob is unknown - the
//! watcher's candidates ([`scan::EXTENSIONS`]), and then the newest few are
//! **sampled**: their first [`Limits::sample_bytes`] decoded by the core and
//! put through its detection, to say whether they are this room's files at
//! all ([`Found::sample`]). The newest file's mtime stands for the date of
//! the last hand - no file is parsed whole. The walk is bounded (depth,
//! entries per folder, matches per template level) and sorted, so the
//! result is the same for the same disk, and a huge folder costs at most
//! [`Limits::entries`] directory entries: its count is then a lower bound
//! ([`Found::complete`] is `false`).
//!
//! Everything the process needs from outside comes through [`Env`] (OS,
//! home folder, variables), so tests run the Windows and macOS templates on
//! a fake home anywhere.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use rail_config::Config;
use rail_config::model::{PathEntry, Site};

use crate::{codec, scan};

/// Whose templates are used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Os {
    Macos,
    Windows,
}

impl Os {
    /// The OS this build runs on; `None` where no room has a client (Linux).
    pub const fn current() -> Option<Self> {
        if cfg!(target_os = "macos") {
            Some(Self::Macos)
        } else if cfg!(windows) {
            Some(Self::Windows)
        } else {
            None
        }
    }

    /// A site's templates for this OS.
    pub fn templates(self, site: &Site) -> &[PathEntry] {
        match self {
            Self::Macos => &site.paths.macos,
            Self::Windows => &site.paths.windows,
        }
    }
}

/// What templates resolve against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Env {
    pub os: Os,
    /// `~` (macOS templates).
    pub home: Option<PathBuf>,
    /// Environment variables by upper-case name (`%NAME%` in Windows
    /// templates; Windows ignores the case of variable names).
    vars: BTreeMap<String, String>,
}

impl Env {
    /// An environment with no variables: tests, and the base of
    /// [`Env::current`].
    pub const fn new(os: Os, home: Option<PathBuf>) -> Self {
        Self {
            os,
            home,
            vars: BTreeMap::new(),
        }
    }

    /// With the variable `name` set to `value`.
    #[must_use]
    pub fn with_var(mut self, name: &str, value: impl Into<String>) -> Self {
        self.vars.insert(name.to_ascii_uppercase(), value.into());
        self
    }

    /// A variable's value.
    pub fn var(&self, name: &str) -> Option<&str> {
        self.vars
            .get(&name.to_ascii_uppercase())
            .map(String::as_str)
    }

    /// This process's: its OS, the home folder (`HOME`, or `USERPROFILE` on
    /// Windows) and its environment. `None` on an OS no room has a client
    /// for.
    pub fn current() -> Option<Self> {
        let os = Os::current()?;
        let home_var = match os {
            Os::Macos => "HOME",
            Os::Windows => "USERPROFILE",
        };
        let home = std::env::var_os(home_var)
            .filter(|home| !home.is_empty())
            .map(PathBuf::from);
        let mut env = Self::new(os, home);
        for (name, value) in std::env::vars_os() {
            if let (Some(name), Some(value)) = (name.to_str(), value.to_str()) {
                env = env.with_var(name, value);
            }
        }
        Some(env)
    }
}

/// How much work one discovery may do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// Folders a wildcard level of a template may match (the first ones by
    /// name).
    pub matches: usize,
    /// Directory entries looked at per folder found, its subfolders
    /// included.
    pub entries: usize,
    /// Subfolder levels walked below a folder found.
    pub depth: usize,
    /// Files sampled per folder when the room's file names are unknown.
    pub samples: usize,
    /// Bytes read from the start of a sampled file.
    pub sample_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            matches: 32,
            entries: 20_000,
            depth: 3,
            samples: 3,
            sample_bytes: 64 * 1024,
        }
    }
}

/// One folder found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// The `sites.json` id of the room.
    pub site: String,
    /// The room's display name.
    pub name: String,
    pub path: PathBuf,
    /// The template it came from.
    pub template: String,
    /// Whether that template was seen on a real install (`verified`).
    pub verified: bool,
    /// The room's `files.glob`, which chose the files counted.
    pub glob: Option<String>,
    /// Hand-history files in it (subfolders included, to [`Limits::depth`]).
    pub files: u64,
    /// `false` when the walk stopped at [`Limits::entries`]: `files` is a
    /// lower bound and `newest_ms` the newest of those seen.
    pub complete: bool,
    /// The newest file's mtime, ms since the epoch: the date of the last
    /// hand, as far as can be told without reading the files.
    pub newest_ms: Option<i64>,
    /// When the room's file names are unknown: the newest files, sampled.
    pub sample: Option<Sample>,
    /// The folder is a watched folder already, or inside a recursive one.
    pub watched: bool,
}

/// Sampled files of a folder whose room has no `files.glob`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    /// Files looked at.
    pub looked: u32,
    /// Of those, files whose best detection is the room's parser.
    pub claimed: u32,
}

/// A folder that is watched already: its path and whether it is recursive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Watched {
    pub path: PathBuf,
    pub recursive: bool,
}

/// Every existing default folder of every room in `config`, for `env`'s
/// OS: in `config` order, then by path; a folder two templates (or two
/// rooms) name is reported once, for the first.
pub fn discover(config: &Config, env: &Env, watched: &[Watched], limits: &Limits) -> Vec<Found> {
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for site in &config.sites {
        for entry in env.os.templates(site) {
            for path in expand(&entry.path, env, limits.matches) {
                if !seen.insert(path.clone()) {
                    continue;
                }
                let glob = site.files.glob.clone();
                let count = count_files(&path, glob.as_deref(), limits);
                let sample = match (&glob, &site.parser) {
                    (None, Some(parser)) => Some(sample(&count.newest_files, parser, limits)),
                    _ => None,
                };
                found.push(Found {
                    site: site.id.clone(),
                    name: site.name.clone(),
                    watched: is_watched(&path, watched),
                    path,
                    template: entry.path.clone(),
                    verified: entry.verified,
                    glob,
                    files: count.files,
                    complete: count.complete,
                    newest_ms: count.newest_ms,
                    sample,
                });
            }
        }
    }
    found
}

/// `files.glob` per `sites.json` id, for [`crate::WatchConfig::file_globs`].
pub fn file_globs(config: &Config) -> BTreeMap<String, String> {
    config
        .sites
        .iter()
        .filter_map(|site| Some((site.id.clone(), site.files.glob.clone()?)))
        .collect()
}

/// The existing folders a template names under `env`, sorted, at most
/// `matches` per wildcard level.
pub fn expand(template: &str, env: &Env, matches: usize) -> Vec<PathBuf> {
    let Some((root, names)) = split(template, env) else {
        return Vec::new();
    };
    if names.iter().any(|name| *name == "." || *name == "..") {
        return Vec::new();
    }
    let mut current = vec![root];
    for name in names {
        let mut next = Vec::new();
        for folder in &current {
            if !name.contains(['*', '?']) {
                next.push(folder.join(name));
                continue;
            }
            let Ok(entries) = fs::read_dir(folder) else {
                continue;
            };
            let mut names: Vec<String> = entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .filter(|child| name.starts_with('.') || !child.starts_with('.'))
                .filter(|child| scan::name_matches(name, child))
                .collect();
            names.sort();
            next.extend(
                names
                    .into_iter()
                    .map(|child| folder.join(child))
                    // A link to a folder counts as the folder.
                    .filter(|path| path.is_dir())
                    .take(matches),
            );
        }
        current = next;
    }
    current.retain(|path| path.is_dir());
    current.sort();
    current.dedup();
    current
}

/// A template's root folder and the names after it.
fn split<'a>(template: &'a str, env: &Env) -> Option<(PathBuf, Vec<&'a str>)> {
    let names = |rest: &'a str, separator: char| {
        rest.split(separator)
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>()
    };
    match env.os {
        Os::Macos => {
            if let Some(rest) = template.strip_prefix("~/") {
                Some((env.home.clone()?, names(rest, '/')))
            } else {
                let rest = template.strip_prefix('/')?;
                Some((PathBuf::from("/"), names(rest, '/')))
            }
        }
        Os::Windows => {
            let (first, rest) = template.split_once('\\')?;
            let root = if let Some(name) = first
                .strip_prefix('%')
                .and_then(|name| name.strip_suffix('%'))
            {
                PathBuf::from(env.var(name).filter(|value| !value.is_empty())?)
            } else if first.len() == 2
                && first.ends_with(':')
                && first.as_bytes()[0].is_ascii_alphabetic()
            {
                PathBuf::from(format!("{first}\\"))
            } else {
                return None;
            };
            Some((root, names(rest, '\\')))
        }
    }
}

/// What a bounded walk of a folder found.
#[derive(Debug, Default)]
struct Count {
    files: u64,
    complete: bool,
    newest_ms: Option<i64>,
    /// The newest files, newest first (at most `Limits::samples`).
    newest_files: Vec<(i64, PathBuf)>,
}

fn count_files(root: &Path, glob: Option<&str>, limits: &Limits) -> Count {
    let mut count = Count {
        complete: true,
        ..Count::default()
    };
    let mut entries_seen = 0_usize;
    let mut stack = vec![(root.to_path_buf(), 0_usize)];
    'walk: while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut children: Vec<_> = entries.filter_map(Result::ok).collect();
        children.sort_by_key(fs::DirEntry::file_name);
        let mut subfolders = Vec::new();
        for entry in children {
            entries_seen += 1;
            if entries_seen > limits.entries {
                count.complete = false;
                break 'walk;
            }
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                let hidden = entry.file_name().to_string_lossy().starts_with('.');
                if !hidden && depth < limits.depth {
                    subfolders.push((path, depth + 1));
                }
                continue;
            }
            if !scan::is_candidate_for(&path, glob) {
                continue;
            }
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            count.files += 1;
            let Some(mtime) = metadata
                .modified()
                .ok()
                .and_then(rail_store::time::system_time_ms)
            else {
                continue;
            };
            count.newest_ms = Some(count.newest_ms.map_or(mtime, |newest| newest.max(mtime)));
            if limits.samples > 0 {
                count.newest_files.push((mtime, path));
                count
                    .newest_files
                    .sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
                count.newest_files.truncate(limits.samples);
            }
        }
        // Popped in name order.
        stack.extend(subfolders.into_iter().rev());
    }
    count
}

/// The first bytes of each file through the core's decoding and detection:
/// how many are `parser`'s.
fn sample(files: &[(i64, PathBuf)], parser: &str, limits: &Limits) -> Sample {
    let registry = rail_core::parsers::builtin();
    let mut sample = Sample {
        looked: 0,
        claimed: 0,
    };
    for (_, path) in files {
        let Ok(file) = fs::File::open(path) else {
            continue;
        };
        let mut bytes = Vec::new();
        let limit = u64::try_from(limits.sample_bytes).unwrap_or(u64::MAX);
        if file.take(limit).read_to_end(&mut bytes).is_err() {
            continue;
        }
        sample.looked += 1;
        // A cut at the byte limit may end inside a UTF-8 sequence.
        let complete = codec::without_incomplete_utf8_tail(&bytes);
        let decoded = rail_core::decode::decode_source(&bytes[..complete]);
        if decoded.problem.is_some() {
            continue;
        }
        let best = registry.detect_site(&decoded.text);
        if best
            .first()
            .is_some_and(|candidate| candidate.parser.id() == parser)
        {
            sample.claimed += 1;
        }
    }
    sample
}

fn is_watched(path: &Path, watched: &[Watched]) -> bool {
    watched
        .iter()
        .any(|folder| path == folder.path || (folder.recursive && path.starts_with(&folder.path)))
}
