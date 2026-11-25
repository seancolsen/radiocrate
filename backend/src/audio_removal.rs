//! Removing the audio files of deleted `file` records from the collection, for a `dml` request that
//! asks for it (`deleteAudioFiles`, see [`crate::dml`]), and the folders that leaves behind.
//!
//! The records and their audio go together or not at all. While the request's transaction is still
//! open, each file is moved aside: renamed, within its own folder, to a hidden name the scanner
//! doesn't take for audio. A file that can't be moved fails the request, which puts back the files
//! already moved and rolls the records back. Only once the transaction has committed are the moved
//! files removed. A rename within one folder needs the same permission as removing the file, so a
//! file that could be moved aside can almost always be removed; if one somehow can't, it's logged
//! and left under its hidden name.
//!
//! A file that's already missing is no failure: what was asked for is true of it.
//!
//! **Folders.** A folder the removals leave empty goes too, and so does each folder above it that's
//! left empty in turn, up to but never including the collection's own. A folder holding anything
//! at all, even a hidden file, stays, unless the request names it (`deleteFolders`). The folders it
//! can name are those [`leftover_folders`] reports: with the request's audio gone, they'd hold no
//! audio, only what came with it (cover art, a cue sheet, a rip log). A named folder is moved aside
//! whole, like a file, and removed with everything in it once the transaction has committed. One
//! that would still hold audio once the request's is gone, as when a file was added since the
//! dialog looked, is left alone.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::OsString;
use std::io;
use std::path::{Component, Path, PathBuf};

use api_schema::LeftoverFolder;
use tracing::{error, info, warn};

use crate::scanner::is_audio_file;

/// What a moved file's or folder's name gets, after a leading dot:
/// `.01 Song.flac.radiocrate-deleting`.
const STAGED_SUFFIX: &str = ".radiocrate-deleting";

/// How many of a leftover folder's files [`leftover_folders`] names.
const LISTED_FILES: usize = 12;

/// One file or folder moved aside.
struct Move {
    original: PathBuf,
    staged: PathBuf,
    folder: bool,
}

/// Audio files and folders moved aside, awaiting the outcome of the transaction that deleted their
/// records.
#[must_use = "moved files are left under hidden names unless finished or restored"]
pub(crate) struct Staged {
    /// The collection's folder, which is never removed however empty it's left.
    collection: PathBuf,
    moves: Vec<Move>,
}

impl Staged {
    /// Removes what was moved aside, once the records' deletion has committed, and then the
    /// folders that leaves empty.
    pub(crate) fn finish(self) {
        let mut parents = BTreeSet::new();
        let (mut files, mut folders) = (0, 0);
        for Move {
            original,
            staged,
            folder,
        } in &self.moves
        {
            let removed = if *folder {
                std::fs::remove_dir_all(staged)
            } else {
                std::fs::remove_file(staged)
            };
            match removed {
                Ok(()) => {
                    if *folder {
                        folders += 1;
                    } else {
                        files += 1;
                    }
                    if let Some(parent) = original.parent() {
                        parents.insert(parent.to_path_buf());
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => warn!(
                    path = %original.display(),
                    staged = %staged.display(),
                    "couldn't remove what a deletion moved aside: {e}"
                ),
            }
        }
        let emptied: usize = parents
            .iter()
            .map(|folder| remove_empty_folders(&self.collection, folder))
            .sum();
        if files + folders + emptied > 0 {
            info!(
                files,
                folders, emptied, "removed deleted records' audio files"
            );
        }
    }

    /// Puts back what was moved aside, when the records' deletion won't happen after all.
    pub(crate) fn restore(self) {
        for Move {
            original, staged, ..
        } in self.moves.iter().rev()
        {
            if let Err(e) = std::fs::rename(staged, original) {
                error!(
                    path = %original.display(),
                    staged = %staged.display(),
                    "couldn't put back what a deletion that failed moved aside: {e}"
                );
            }
        }
    }

    /// Moves `original` aside. `Ok(false)` if it isn't there.
    fn move_aside(&mut self, original: PathBuf, folder: bool) -> io::Result<bool> {
        let staged = staged_path(&original).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "the path has no last part")
        })?;
        match std::fs::rename(&original, &staged) {
            Ok(()) => {
                self.moves.push(Move {
                    original,
                    staged,
                    folder,
                });
                Ok(true)
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Whether `path` is in, or is, a folder already moved aside.
    fn within_moved_folder(&self, path: &Path) -> bool {
        self.moves
            .iter()
            .any(|m| m.folder && path.starts_with(&m.original))
    }
}

/// Moves aside the audio file at each of `paths`, as `file.path` holds them: relative to
/// `collection` (`./Artist/Album/01.flac`), or absolute within it; and, before them, each of
/// `folders` (named the same way) that would hold no audio with those files gone, with everything
/// in it. Fails, with everything already moved put back, on a path outside the collection or one
/// that can't be moved. A file or folder that isn't there is passed over.
pub(crate) fn stage(
    collection: &Path,
    paths: &[String],
    folders: &[String],
) -> Result<Staged, String> {
    let mut staged = Staged {
        collection: collection.to_path_buf(),
        moves: Vec::new(),
    };
    let fail = |staged: Staged, message: String| {
        staged.restore();
        Err(message)
    };

    let mut files = Vec::with_capacity(paths.len());
    for stored in paths {
        match resolve(collection, stored) {
            Some(path) => files.push((stored, path)),
            None => {
                return fail(
                    staged,
                    format!("The audio file “{stored}” isn’t in the collection’s folder."),
                );
            }
        }
    }
    let going: HashSet<PathBuf> = files.iter().map(|(_, path)| path.clone()).collect();

    let mut named = Vec::with_capacity(folders.len());
    for stored in folders {
        match resolve(collection, stored) {
            Some(path) => named.push((stored, path)),
            None => {
                return fail(
                    staged,
                    format!("The folder “{stored}” isn’t in the collection’s folder."),
                );
            }
        }
    }
    // Outermost first, so that a folder within another named one goes with it.
    named.sort_by_key(|(_, path)| path.components().count());
    for (stored, folder) in named {
        if staged.within_moved_folder(&folder) {
            continue;
        }
        if !going.iter().any(|file| file.starts_with(&folder)) || keeps_audio(&folder, &going) {
            warn!(folder = %stored, "left a folder that would still hold audio");
            continue;
        }
        if let Err(e) = staged.move_aside(folder, true) {
            return fail(
                staged,
                format!("Couldn’t delete the folder “{stored}”: {e}."),
            );
        }
    }

    for (stored, file) in files {
        if staged.within_moved_folder(&file) {
            continue;
        }
        if let Err(e) = staged.move_aside(file, false) {
            return fail(
                staged,
                format!("Couldn’t delete the audio file “{stored}”: {e}."),
            );
        }
    }
    Ok(staged)
}

/// The folders that removing the audio files at `paths` (stored as [`stage`] takes them) would
/// leave with no audio anywhere in them, but with something else: the outermost such folder above
/// each file, short of the collection's own, with what's left in it. A folder that would be left
/// empty isn't one: it goes without being asked.
pub(crate) fn leftover_folders(collection: &Path, paths: &[String]) -> Vec<LeftoverFolder> {
    let going: HashSet<PathBuf> = paths
        .iter()
        .filter_map(|stored| resolve(collection, stored))
        .collect();

    // Whether each folder looked at keeps audio. A folder that does means every folder above it
    // does too, so each file's walk up stops at the first.
    let mut keeps: HashMap<PathBuf, bool> = HashMap::new();
    let mut outermost = BTreeSet::new();
    for file in &going {
        let mut top = None;
        let mut current = file.parent();
        while let Some(folder) = current {
            if folder == collection || !folder.starts_with(collection) {
                break;
            }
            let kept = *keeps
                .entry(folder.to_path_buf())
                .or_insert_with(|| keeps_audio(folder, &going));
            if kept {
                break;
            }
            top = Some(folder);
            current = folder.parent();
        }
        if let Some(top) = top {
            outermost.insert(top.to_path_buf());
        }
    }

    // In path order a folder comes before the folders in it, which are part of it.
    let mut tops: Vec<PathBuf> = Vec::new();
    for folder in outermost {
        if !tops.iter().any(|top| folder.starts_with(top)) {
            tops.push(folder);
        }
    }
    tops.into_iter()
        .filter_map(|folder| {
            let mut left = Vec::new();
            list_left(&folder, &folder, &going, &mut left);
            if left.is_empty() {
                return None;
            }
            left.sort();
            let file_count = u32::try_from(left.len()).unwrap_or(u32::MAX);
            left.truncate(LISTED_FILES);
            Some(LeftoverFolder {
                path: stored_path(collection, &folder),
                files: left,
                file_count,
            })
        })
        .collect()
}

/// Whether anything under `folder` would still be audio with `going` gone: an audio file not
/// among them, or a link to a folder, which the scanner follows into. A folder that can't be read
/// is taken to, since what's in it can't be known.
fn keeps_audio(folder: &Path, going: &HashSet<PathBuf>) -> bool {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return true;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return true;
        };
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            return true;
        };
        let audio = if kind.is_dir() {
            keeps_audio(&path, going)
        } else if kind.is_symlink() && path.is_dir() {
            true
        } else {
            is_audio_file(&path) && !going.contains(&path)
        };
        if audio {
            return true;
        }
    }
    false
}

/// Adds to `left` every file under `folder` that isn't one of `going`, by its path from `root`.
/// A link is a file here, whatever it leads to: removing the folder removes the link alone.
fn list_left(root: &Path, folder: &Path, going: &HashSet<PathBuf>, left: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            list_left(root, &path, going, left);
        } else if !going.contains(&path)
            && let Ok(relative) = path.strip_prefix(root)
        {
            left.push(slashed(relative));
        }
    }
}

/// A relative path with `/` between its parts, as the wire has them on any platform.
fn slashed(relative: &Path) -> String {
    relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// A path within `collection` as `file.path` holds one: `./Artist/Album`.
fn stored_path(collection: &Path, path: &Path) -> String {
    match path.strip_prefix(collection) {
        Ok(relative) => format!("./{}", slashed(relative)),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

/// Where a stored path is on disk, if that's within `collection`, with no `.` parts, so that one
/// file has one path however it was named. A path that climbs out of a folder (`..`) is refused
/// rather than worked out.
fn resolve(collection: &Path, stored: &str) -> Option<PathBuf> {
    let path = Path::new(stored);
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    let plain: PathBuf = path
        .components()
        .filter(|component| !matches!(component, Component::CurDir))
        .collect();
    let full = collection.join(plain);
    (full.starts_with(collection) && full != collection).then_some(full)
}

/// Removes `folder` if it's empty, then each folder above it left empty in turn, stopping at the
/// first that isn't (or can't be removed), and always below `collection`. Returns how many it
/// removed.
fn remove_empty_folders(collection: &Path, folder: &Path) -> usize {
    let mut removed = 0;
    let mut current = folder;
    while current != collection && current.starts_with(collection) {
        // `remove_dir` removes only an empty folder, and not a link to one.
        match std::fs::remove_dir(current) {
            Ok(()) => removed += 1,
            Err(e) => {
                let kind = e.kind();
                if kind != io::ErrorKind::NotFound && kind != io::ErrorKind::DirectoryNotEmpty {
                    warn!(folder = %current.display(), "couldn't remove a folder left empty: {e}");
                }
                break;
            }
        }
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
    }
    removed
}

/// The hidden name, in the same folder, that `original` is moved to.
fn staged_path(original: &Path) -> Option<PathBuf> {
    let mut name = OsString::from(".");
    name.push(original.file_name()?);
    name.push(STAGED_SUFFIX);
    Some(original.with_file_name(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_path_resolves_only_within_the_collection() {
        let root = Path::new("/music");
        assert_eq!(
            resolve(root, "./A/B/01.flac"),
            Some(PathBuf::from("/music/A/B/01.flac"))
        );
        assert_eq!(
            resolve(root, "/music/A/01.flac"),
            Some(PathBuf::from("/music/A/01.flac"))
        );
        assert_eq!(resolve(root, "./A/../../etc/passwd"), None);
        assert_eq!(resolve(root, "/elsewhere/01.flac"), None);
        assert_eq!(resolve(root, "."), None);
    }

    #[test]
    fn a_moved_file_is_hidden_beside_itself() {
        assert_eq!(
            staged_path(Path::new("/music/A/01 Song.flac")),
            Some(PathBuf::from("/music/A/.01 Song.flac.radiocrate-deleting"))
        );
    }

    /// A collection on disk for a test, removed when dropped.
    struct Disk(PathBuf);

    impl Disk {
        fn new(files: &[&str]) -> Self {
            let root =
                std::env::temp_dir().join(format!("radiocrate-audio-{}", uuid::Uuid::new_v4()));
            for file in files {
                let path = root.join(file);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, b"x").unwrap();
            }
            std::fs::create_dir_all(&root).unwrap();
            Disk(root)
        }

        fn leftovers(&self, going: &[&str]) -> Vec<LeftoverFolder> {
            let paths: Vec<String> = going.iter().map(|p| format!("./{p}")).collect();
            leftover_folders(&self.0, &paths)
        }
    }

    impl Drop for Disk {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn folder(path: &str, files: &[&str], file_count: u32) -> LeftoverFolder {
        LeftoverFolder {
            path: path.to_string(),
            files: files.iter().map(ToString::to_string).collect(),
            file_count,
        }
    }

    #[test]
    fn an_album_with_no_audio_left_is_a_leftover_folder() {
        let disk = Disk::new(&[
            "Artist/Album/01.flac",
            "Artist/Album/02.flac",
            "Artist/Album/cover.jpg",
            "Artist/Album/Scans/back.jpg",
            "Artist/Other/01.mp3",
        ]);
        // With a track left, the album isn't.
        assert_eq!(disk.leftovers(&["Artist/Album/01.flac"]), vec![]);
        // With none left, it is, and the artist, with another album, isn't.
        assert_eq!(
            disk.leftovers(&["Artist/Album/01.flac", "Artist/Album/02.flac"]),
            vec![folder(
                "./Artist/Album",
                &["Scans/back.jpg", "cover.jpg"],
                2
            )]
        );
    }

    #[test]
    fn the_outermost_folder_with_no_audio_left_is_the_one() {
        let disk = Disk::new(&[
            "Artist/artist.jpg",
            "Artist/Album/CD1/01.flac",
            "Artist/Album/CD1/album.cue",
            "Artist/Album/CD2/01.flac",
            "Loose/01.flac",
            "root.flac",
        ]);
        assert_eq!(
            disk.leftovers(&["Artist/Album/CD1/01.flac", "Artist/Album/CD2/01.flac"]),
            vec![folder(
                "./Artist",
                &["Album/CD1/album.cue", "artist.jpg"],
                2
            )]
        );
        // A folder that would be left empty goes anyway, and the collection's own is never one.
        assert_eq!(disk.leftovers(&["Loose/01.flac", "root.flac"]), vec![]);
    }

    #[test]
    fn audio_the_deletion_doesnt_take_keeps_a_folder() {
        // An audio file with no record is audio all the same.
        let disk = Disk::new(&["A/01.flac", "A/unscanned.FLAC", "A/cover.jpg"]);
        assert_eq!(disk.leftovers(&["A/01.flac"]), vec![]);
    }

    #[test]
    fn a_long_list_of_files_left_is_cut_short_and_counted() {
        let names: Vec<String> = (0..20).map(|i| format!("A/scan{i:02}.jpg")).collect();
        let mut files: Vec<&str> = names.iter().map(String::as_str).collect();
        files.push("A/01.flac");
        let disk = Disk::new(&files);
        let left = disk.leftovers(&["A/01.flac"]);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].file_count, 20);
        assert_eq!(left[0].files.len(), LISTED_FILES);
        assert_eq!(left[0].files[0], "scan00.jpg");
    }
}
