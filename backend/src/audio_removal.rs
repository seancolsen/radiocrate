//! Removing the audio files of deleted `file` records from the collection, for a `dml` request that
//! asks for it (`deleteAudioFiles`, see [`crate::dml`]).
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

use std::ffi::OsString;
use std::io;
use std::path::{Component, Path, PathBuf};

use tracing::{error, info, warn};

/// What a moved file's name gets, after a leading dot: `.01 Song.flac.radiocrate-deleting`.
const STAGED_SUFFIX: &str = ".radiocrate-deleting";

/// Audio files moved aside, awaiting the outcome of the transaction that deleted their records.
#[must_use = "moved files are left under hidden names unless finished or restored"]
pub(crate) struct Staged {
    /// Each file's own path, and the path it was moved to.
    moves: Vec<(PathBuf, PathBuf)>,
}

impl Staged {
    /// Removes the moved files, once their records' deletion has committed.
    pub(crate) fn finish(self) {
        for (original, staged) in &self.moves {
            match std::fs::remove_file(staged) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => warn!(
                    path = %original.display(),
                    staged = %staged.display(),
                    "couldn't remove a deleted record's audio file: {e}"
                ),
            }
        }
        if !self.moves.is_empty() {
            info!(
                count = self.moves.len(),
                "removed deleted records' audio files"
            );
        }
    }

    /// Puts the moved files back, when their records' deletion won't happen after all.
    pub(crate) fn restore(self) {
        for (original, staged) in self.moves.iter().rev() {
            if let Err(e) = std::fs::rename(staged, original) {
                error!(
                    path = %original.display(),
                    staged = %staged.display(),
                    "couldn't put back an audio file whose record wasn't deleted: {e}"
                );
            }
        }
    }
}

/// Moves aside the audio file at each of `paths`, as `file.path` holds them: relative to
/// `collection` (`./Artist/Album/01.flac`), or absolute within it. Fails, with every file already
/// moved put back, on a path outside the collection or a file that can't be moved. A file that
/// isn't there is passed over.
pub(crate) fn stage(collection: &Path, paths: &[String]) -> Result<Staged, String> {
    let mut staged = Staged { moves: Vec::new() };
    for stored in paths {
        let moved = resolve(collection, stored)
            .ok_or_else(|| format!("The audio file “{stored}” isn’t in the collection’s folder."))
            .and_then(|original| {
                let aside = staged_path(&original)
                    .ok_or_else(|| format!("The audio file “{stored}” has no file name."))?;
                match std::fs::rename(&original, &aside) {
                    Ok(()) => Ok(Some((original, aside))),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
                    Err(e) => Err(format!("Couldn’t delete the audio file “{stored}”: {e}.")),
                }
            });
        match moved {
            Ok(Some(entry)) => staged.moves.push(entry),
            Ok(None) => {}
            Err(message) => {
                staged.restore();
                return Err(message);
            }
        }
    }
    Ok(staged)
}

/// Where a stored path is on disk, if that's within `collection`. A path that climbs out of a
/// folder (`..`) is refused rather than worked out.
fn resolve(collection: &Path, stored: &str) -> Option<PathBuf> {
    let path = Path::new(stored);
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    let full = collection.join(path);
    (full.starts_with(collection) && full != collection).then_some(full)
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
}
