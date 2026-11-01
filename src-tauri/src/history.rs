use serde::Serialize;
use std::{collections::HashMap, io::ErrorKind, path::Path};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DirectoryState {
    Available,
    Missing,
    Unavailable,
}

pub fn directory_state(path: &Path) -> DirectoryState {
    if !path.is_absolute() {
        return DirectoryState::Unavailable;
    }
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => DirectoryState::Available,
        Ok(_) => DirectoryState::Missing,
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            DirectoryState::Missing
        }
        Err(_) => DirectoryState::Unavailable,
    }
}

pub fn check_directories(paths: Vec<String>) -> Result<HashMap<String, DirectoryState>, String> {
    if paths.len() > 100 {
        return Err("一次最多检查 100 个抓轨目录".into());
    }
    Ok(paths
        .into_iter()
        .map(|path| {
            let state = directory_state(Path::new(&path));
            (path, state)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_tracks_directory_removal_and_restoration_without_changing_files() {
        let temp = tempfile::tempdir().unwrap();
        let album = temp.path().join("专辑 · Album");
        std::fs::create_dir(&album).unwrap();
        let audio = album.join("01.flac");
        std::fs::write(&audio, b"original audio").unwrap();
        let path = album.to_string_lossy().into_owned();
        let states = check_directories(vec![path.clone()]).unwrap();
        assert_eq!(states[&path], DirectoryState::Available);
        assert_eq!(std::fs::read(&audio).unwrap(), b"original audio");

        std::fs::remove_file(&audio).unwrap();
        std::fs::remove_dir(&album).unwrap();
        assert_eq!(directory_state(&album), DirectoryState::Missing);
        std::fs::create_dir(&album).unwrap();
        assert_eq!(directory_state(&album), DirectoryState::Available);

        std::fs::remove_dir(&album).unwrap();
        std::fs::write(&album, b"a file is not a directory").unwrap();
        assert_eq!(directory_state(&album), DirectoryState::Missing);
        assert_eq!(
            directory_state(&album.join("child")),
            DirectoryState::Missing
        );
        assert_eq!(
            directory_state(Path::new("relative/path")),
            DirectoryState::Unavailable
        );
    }
}
