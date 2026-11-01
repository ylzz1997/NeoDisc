use super::*;
use crate::aiff::AiffReader;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn mounted_cd(path: &Path) -> bool {
    path.parent() == Some(Path::new("/Volumes")) && path.join(".TOC.plist").is_file()
}
pub fn drives() -> Result<Vec<Drive>, String> {
    let mut result = vec![];
    for entry in fs::read_dir("/Volumes")
        .map_err(|e| e.to_string())?
        .flatten()
    {
        if mounted_cd(&entry.path()) {
            result.push(Drive {
                id: entry.path().to_string_lossy().into(),
                name: format!("Audio CD · {}", entry.file_name().to_string_lossy()),
            });
        }
    }
    Ok(result)
}
fn track_number(path: &Path) -> u8 {
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .split(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

// The mounted plist includes the raw MMC format-2 TOC. Use its absolute MSF
// addresses rather than deriving offsets from AIFF lengths (which loses pregaps).
fn lookup_toc(value: &plist::Value) -> Option<DiscToc> {
    let raw = value
        .as_dictionary()?
        .get("Format 0x02 TOC Data")?
        .as_data()?;
    if raw.len() < 4 || raw[2] != raw[3] {
        return None;
    }
    let size = usize::from(u16::from_be_bytes([raw[0], raw[1]])) + 2;
    if size > raw.len() || size < 4 || !(size - 4).is_multiple_of(11) {
        return None;
    }
    let mut first = None;
    let mut last = None;
    let mut lead_out = None;
    let mut tracks = std::collections::BTreeMap::new();
    for record in raw[4..size].as_chunks::<11>().0 {
        if record[1] >> 4 != 1 {
            continue;
        }
        if record[0] != raw[2] {
            return None;
        }
        let msf = || {
            if record[9] >= 60 || record[10] >= 75 {
                return None;
            }
            Some(u32::from(record[8]) * 60 * 75 + u32::from(record[9]) * 75 + u32::from(record[10]))
        };
        match record[3] {
            0xa0 => first = Some(record[8]),
            0xa1 => last = Some(record[8]),
            0xa2 => lead_out = msf(),
            1..=99 if record[1] & 4 != 0 || tracks.insert(record[3], msf()?).is_some() => {
                return None
            }
            _ => {}
        }
    }
    let toc = DiscToc {
        first_track: first?,
        last_track: last?,
        lead_out: lead_out?,
        offsets: tracks.values().copied().collect(),
    };
    if tracks.keys().copied().ne(toc.first_track..=toc.last_track) {
        return None;
    }
    toc.disc_id()?;
    Some(toc)
}
pub fn read_disc(id: &str) -> Result<Disc, String> {
    let path = Path::new(id);
    if !mounted_cd(path) {
        return Err("未找到已挂载的音频 CD。请插入光盘后刷新。".into());
    }
    let mut paths: Vec<PathBuf> = fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("aiff") || s.eq_ignore_ascii_case("aif"))
        })
        .collect();
    paths.sort_by_key(|p| track_number(p));
    let mut tracks = vec![];
    let mut start = 0;
    for path in paths {
        let reader = AiffReader::open(&path)?;
        let number = track_number(&path);
        if number == 0 || tracks.iter().any(|t: &Track| t.number == number) {
            return Err("无法识别 CD 音轨编号".into());
        }
        let sectors = reader.frames / 588;
        tracks.push(Track {
            number,
            title: path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            start_sector: start,
            sectors,
            pre_emphasis: false,
            source_path: Some(path.to_string_lossy().into()),
            artist: None,
        });
        start += sectors;
    }
    if tracks.is_empty() {
        return Err("光盘中未发现音频轨道".into());
    }
    let lookup_toc = plist::Value::from_file(path.join(".TOC.plist"))
        .ok()
        .and_then(|v| lookup_toc(&v))
        .filter(|toc| {
            tracks.len() == toc.offsets.len()
                && tracks
                    .iter()
                    .map(|t| t.number)
                    .eq(toc.first_track..=toc.last_track)
        });
    Ok(Disc {
        drive_id: id.into(),
        title: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        artist: "未知艺术家".into(),
        fingerprint: fingerprint(&tracks),
        tracks,
        lookup_toc,
        metadata_id: None,
    })
}

pub fn open_track(_disc: &Disc, track: &Track) -> Result<Box<dyn SectorReader>, String> {
    Ok(Box::new(AiffReader::open(Path::new(
        track.source_path.as_deref().ok_or("缺少音轨路径")?,
    ))?))
}
pub fn eject(id: &str) -> Result<(), String> {
    if !mounted_cd(Path::new(id)) {
        return Err("音频 CD 已卸载".into());
    }
    let result = Command::new("/usr/sbin/diskutil")
        .arg("eject")
        .arg(id)
        .output()
        .map_err(|e| e.to_string())?;
    if result.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&result.stderr).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_toc_retains_first_track_pregap_and_rejects_multisession() {
        let mut raw = vec![0u8; 4 + 4 * 11];
        raw[..2].copy_from_slice(&46u16.to_be_bytes());
        raw[2] = 1;
        raw[3] = 1;
        for (index, (point, m, s, f)) in [
            (0xa0, 1, 0, 0),
            (0xa1, 1, 0, 0),
            (0xa2, 3, 2, 0),
            (1, 0, 3, 0),
        ]
        .into_iter()
        .enumerate()
        {
            let p = 4 + index * 11;
            raw[p] = 1;
            raw[p + 1] = 0x10;
            raw[p + 3] = point;
            raw[p + 8] = m;
            raw[p + 9] = s;
            raw[p + 10] = f;
        }
        let value = |data: Vec<u8>| {
            let mut d = plist::Dictionary::new();
            d.insert("Format 0x02 TOC Data".into(), plist::Value::Data(data));
            plist::Value::Dictionary(d)
        };
        let toc = lookup_toc(&value(raw.clone())).unwrap();
        assert_eq!(toc.offsets, vec![225]);
        assert_eq!(toc.lead_out, 13650);
        raw[3] = 2;
        assert!(lookup_toc(&value(raw)).is_none());
    }
}
