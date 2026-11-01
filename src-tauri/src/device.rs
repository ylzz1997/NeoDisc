use crate::models::{Disc, DiscToc, Drive, Track};
use sha2::{Digest, Sha256};

pub trait SectorReader: Send {
    /// CD-DA, interleaved stereo signed 16-bit little endian, 2352 bytes/sector.
    fn read_sectors(&mut self, relative: u32, count: u32) -> Result<Vec<u8>, String>;
}

pub fn fingerprint(tracks: &[Track]) -> String {
    let mut hash = Sha256::new();
    for t in tracks {
        hash.update([t.number]);
        hash.update(t.start_sector.to_le_bytes());
        hash.update(t.sectors.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}

#[cfg(target_os = "windows")]
#[path = "device/windows.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "device/macos.rs"]
mod platform;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use platform::{drives, eject, open_track, read_disc};

// Type-check the macOS adapter during Windows tests, too. Hardware validation still needs a Mac.
#[cfg(all(test, not(target_os = "macos")))]
#[allow(dead_code)]
#[path = "device/macos.rs"]
mod macos_compile_check;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn drives() -> Result<Vec<Drive>, String> {
    Ok(vec![])
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn read_disc(_: &str) -> Result<Disc, String> {
    Err("当前版本支持 Windows 和 macOS".into())
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn open_track(_: &Disc, _: &Track) -> Result<Box<dyn SectorReader>, String> {
    Err("不支持此系统".into())
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn eject(_: &str) -> Result<(), String> {
    Err("不支持此系统".into())
}

pub fn validated_disc(requested: &Disc) -> Result<Disc, String> {
    let mut actual = read_disc(&requested.drive_id)?;
    if actual.fingerprint != requested.fingerprint {
        return Err("光盘已更换，请重新读取曲目。".into());
    }
    actual.title = requested.title.clone();
    actual.artist = requested.artist.clone();
    actual.metadata_id = requested.metadata_id.clone();
    for track in &mut actual.tracks {
        if let Some(meta) = requested.tracks.iter().find(|t| t.number == track.number) {
            track.title = meta.title.clone();
            track.artist = meta.artist.clone();
        }
    }
    Ok(actual)
}
