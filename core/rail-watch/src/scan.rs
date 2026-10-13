//! Which files of a watched folder are read, and whether a folder is on a
//! network volume (polled, never trusted to notify).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Extensions of hand-history files (lower case). Every corpus file is
/// `.txt` or `.xml`; some clients write `.log`. R1.4 narrows this per room
/// with `sites.json`'s `files.glob` once the folders are verified.
pub const EXTENSIONS: &[&str] = &["txt", "xml", "log"];

/// Whether a file is one the watcher reads: a hand-history extension, not
/// hidden, not an editor's backup.
pub fn is_candidate(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if name.starts_with('.') || name.ends_with('~') {
        return false;
    }
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            EXTENSIONS
                .iter()
                .any(|known| ext.eq_ignore_ascii_case(known))
        })
}

/// What a walk of a folder found.
#[derive(Debug, Default)]
pub struct Walk {
    /// Candidate files, with their size and mtime (ms).
    pub files: Vec<(PathBuf, u64, Option<i64>)>,
    /// Folders or files that could not be read (permissions), with why.
    pub errors: Vec<(PathBuf, io::Error)>,
}

/// Every candidate file under `root` (its subfolders too when `recursive`).
/// Hidden folders are skipped and symbolic links to folders are not
/// followed (a link loop cannot make the walk endless). Fails only when
/// `root` itself cannot be read.
pub fn walk(root: &Path, recursive: bool) -> io::Result<Walk> {
    let mut walk = Walk::default();
    let mut stack = vec![root.to_path_buf()];
    let mut first = true;
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if first => return Err(error),
            Err(error) => {
                walk.errors.push((dir, error));
                continue;
            }
        };
        first = false;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    walk.errors.push((dir.clone(), error));
                    continue;
                }
            };
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                let hidden = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with('.'));
                if recursive && !hidden {
                    stack.push(path);
                }
                continue;
            }
            if !is_candidate(&path) {
                continue;
            }
            // A link to a file is read like the file.
            match fs::metadata(&path) {
                Ok(metadata) if metadata.is_file() => {
                    let mtime = metadata
                        .modified()
                        .ok()
                        .and_then(rail_store::time::system_time_ms);
                    walk.files.push((path, metadata.len(), mtime));
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => walk.errors.push((path, error)),
            }
        }
    }
    walk.files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(walk)
}

/// File system types that are network mounts (Linux `/proc/self/mounts`,
/// macOS `mount`).
const NETWORK_FS: &[&str] = &[
    "nfs",
    "nfs4",
    "cifs",
    "smb3",
    "smbfs",
    "afpfs",
    "webdav",
    "davfs",
    "sshfs",
    "fuse.sshfs",
    "9p",
    "afs",
    "ceph",
    "glusterfs",
    "fuse.rclone",
];

/// Whether `path` is on a network volume, as far as can be told without
/// OS calls: a UNC path on Windows (`\\server\share`, `\\?\UNC\...`; a
/// network share mapped to a drive letter is not detected - R1.5 lets the
/// user mark a folder "poll only"), a network file system in the mount
/// table on macOS (`mount`) and Linux (`/proc/self/mounts`).
pub fn is_network_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        return text.starts_with(r"\\?\UNC\")
            || (text.starts_with(r"\\") && !text.starts_with(r"\\?\"));
    }
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    mount_table()
        .iter()
        .filter(|(mount_point, _)| path.starts_with(mount_point))
        .max_by_key(|(mount_point, _)| mount_point.as_os_str().len())
        .is_some_and(|(_, fs_type)| NETWORK_FS.contains(&fs_type.as_str()))
}

/// (mount point, file system type) of every mount, best effort.
fn mount_table() -> Vec<(PathBuf, String)> {
    if cfg!(target_os = "linux") {
        return fs::read_to_string("/proc/self/mounts")
            .map(|table| parse_proc_mounts(&table))
            .unwrap_or_default();
    }
    if cfg!(target_os = "macos") {
        return std::process::Command::new("/sbin/mount")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| parse_bsd_mount(&String::from_utf8_lossy(&output.stdout)))
            .unwrap_or_default();
    }
    Vec::new()
}

/// `/proc/self/mounts`: `device mount_point type options 0 0`, with spaces
/// and other characters in names written as octal escapes (`\040`).
fn parse_proc_mounts(table: &str) -> Vec<(PathBuf, String)> {
    table
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(' ');
            let _device = fields.next()?;
            let mount_point = unescape_octal(fields.next()?);
            let fs_type = fields.next()?.to_owned();
            Some((PathBuf::from(mount_point), fs_type))
        })
        .collect()
}

fn unescape_octal(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\'
            && i + 4 <= bytes.len()
            && bytes[i + 1..i + 4]
                .iter()
                .all(|b| (b'0'..=b'7').contains(b))
        {
            let value = bytes[i + 1..i + 4]
                .iter()
                .fold(0_u32, |acc, b| acc * 8 + u32::from(b - b'0'));
            if let Ok(byte) = u8::try_from(value) {
                out.push(byte);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// macOS `mount`: `//user@server/share on /Volumes/share (smbfs, nodev, ...)`.
fn parse_bsd_mount(output: &str) -> Vec<(PathBuf, String)> {
    output
        .lines()
        .filter_map(|line| {
            let (_, rest) = line.split_once(" on ")?;
            let open = rest.rfind(" (")?;
            let mount_point = &rest[..open];
            let fs_type = rest[open + 2..].split([',', ')']).next()?.trim().to_owned();
            Some((PathBuf::from(mount_point), fs_type))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_are_hand_history_files() {
        assert!(is_candidate(Path::new("/x/HH20260101 Table.txt")));
        assert!(is_candidate(Path::new("/x/session.XML")));
        assert!(!is_candidate(Path::new("/x/.hidden.txt")));
        assert!(!is_candidate(Path::new("/x/notes.txt~")));
        assert!(!is_candidate(Path::new("/x/rail.db")));
        assert!(!is_candidate(Path::new("/x/noext")));
    }

    #[test]
    fn mount_tables_parse() {
        let proc = "server:/export /mnt/hh\\040files nfs4 rw 0 0\n/dev/sda1 / ext4 rw 0 0\n";
        assert_eq!(
            parse_proc_mounts(proc),
            vec![
                (PathBuf::from("/mnt/hh files"), "nfs4".to_owned()),
                (PathBuf::from("/"), "ext4".to_owned())
            ]
        );
        let bsd = "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n\
                   //me@nas/poker on /Volumes/poker hands (smbfs, nodev, nosuid, mounted by me)\n";
        assert_eq!(
            parse_bsd_mount(bsd),
            vec![
                (PathBuf::from("/"), "apfs".to_owned()),
                (PathBuf::from("/Volumes/poker hands"), "smbfs".to_owned())
            ]
        );
    }

    #[test]
    fn walks_recursively_and_skips_hidden_folders() {
        let root = std::env::temp_dir().join(format!("rail-watch-walk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("sub/deeper")).expect("dirs");
        fs::create_dir_all(root.join(".cache")).expect("dirs");
        for file in [
            "a.txt",
            "sub/b.txt",
            "sub/deeper/c.xml",
            ".cache/d.txt",
            "e.db",
        ] {
            fs::write(root.join(file), "x").expect("file");
        }
        let names = |walk: Walk| -> Vec<String> {
            walk.files
                .iter()
                .map(|(path, _, _)| {
                    path.strip_prefix(&root)
                        .expect("under root")
                        .to_string_lossy()
                        .replace('\\', "/")
                })
                .collect()
        };
        assert_eq!(
            names(walk(&root, true).expect("walk")),
            ["a.txt", "sub/b.txt", "sub/deeper/c.xml"]
        );
        assert_eq!(names(walk(&root, false).expect("walk")), ["a.txt"]);
        assert!(walk(&root.join("missing"), true).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
