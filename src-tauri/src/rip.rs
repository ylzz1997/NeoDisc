use crate::{
    device::{self, SectorReader},
    encode::AudioWriter,
    lossy::{self, Encoder, EncodingJob},
    models::*,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn safe_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .take(90)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    if trimmed.is_empty() || trimmed == ".." {
        "Untitled".into()
    } else if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&stem.as_str())
    {
        format!("_{trimmed}")
    } else {
        trimmed.into()
    }
}
fn cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err("已取消抓轨".into())
    } else {
        Ok(())
    }
}
pub fn checked_read(
    reader: &mut dyn SectorReader,
    offset: u32,
    count: u32,
    verify: bool,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, String> {
    let mut error = "两次读取不一致".to_string();
    for _ in 0..3 {
        cancelled(cancel)?;
        match reader.read_sectors(offset, count) {
            Ok(first) => {
                if first.len() != count as usize * 2352 {
                    error = "读取数据长度不完整".into();
                    continue;
                }
                if !verify {
                    return Ok(first);
                }
                cancelled(cancel)?;
                match reader.read_sectors(offset, count) {
                    Ok(second) if first == second => return Ok(first),
                    Ok(_) => error = "两次读取不一致".into(),
                    Err(e) => error = e,
                }
            }
            Err(e) => error = e,
        }
    }
    Err(format!("扇区 {offset} 重试 3 次后失败：{error}"))
}
fn create_album_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    for n in 0..1000 {
        let path = root.join(if n == 0 {
            name.into()
        } else {
            format!("{name} ({n})")
        });
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("输出目录中存在太多同名专辑".into())
}
pub fn run(
    request: RipRequest,
    cancel: &AtomicBool,
    notify: impl Fn(RipProgress),
) -> Result<String, String> {
    if !["flac", "wav", "mp3", "aac"].contains(&request.format.as_str()) {
        return Err("不支持的输出格式".into());
    }
    let encoding = if lossy::is_lossy(&request.format) {
        let options = request
            .encoding
            .clone()
            .unwrap_or_else(|| EncodingOptions::for_format(&request.format));
        options.validate(&request.format)?;
        Some((Encoder::bundled()?, options))
    } else {
        None
    };
    if !Path::new(&request.output_dir).is_absolute() {
        return Err("请选择完整的输出目录".into());
    }
    let disc = device::validated_disc(&request.disc)?;
    let cover = crate::metadata::cached_cover(&disc);
    let tracks: Vec<&Track> = disc
        .tracks
        .iter()
        .filter(|t| request.tracks.contains(&t.number))
        .collect();
    if tracks.is_empty() {
        return Err("请至少选择一首曲目".into());
    }
    cancelled(cancel)?;
    let folder = create_album_dir(
        Path::new(&request.output_dir),
        &format!("{} - {}", safe_name(&disc.artist), safe_name(&disc.title)),
    )?;
    if let Some(cover) = &cover {
        fs::write(folder.join(cover.filename()), &cover.data).map_err(|e| e.to_string())?;
    }
    let cover_path = cover.as_ref().map(|cover| folder.join(cover.filename()));
    let total_sectors: u64 = tracks.iter().map(|t| t.sectors as u64).sum();
    let mut finished_sectors = 0u64;
    let mut reports: Vec<Value> = vec![];
    let mut playlist = String::from("#EXTM3U\n");
    let mut last_emit = std::time::Instant::now();
    let report_path = folder.join("rip-report.json");
    let save_report = |entries: &[Value], status: &str| -> Result<(), String> {
        let report = json!({"application":concat!("NeoDisc ", env!("CARGO_PKG_VERSION")),"timeUnix":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),"album":disc.title,"artist":disc.artist,"discFingerprint":disc.fingerprint,"format":request.format,"encoding":encoding.as_ref().map(|(_,options)|options),"sourceAudio":{"sampleRate":44100,"channels":2,"bitsPerSample":16},"pcmHashScope":"source CD PCM before encoding or resampling","readComparison":request.verify,"note":"重复读取可能命中光驱或系统缓存，不等同于 AccurateRip、安全抓轨或驱动偏移校正。预加重保持原样；macOS 暂不检测预加重。","status":status,"tracks":entries});
        fs::write(
            &report_path,
            serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    };
    for (index, track) in tracks.iter().enumerate() {
        let filename = format!(
            "{:02} - {}.{}",
            track.number,
            safe_name(&track.title),
            lossy::extension(&request.format)
        );
        let partial = folder.join(format!("{filename}.partial"));
        let source = if encoding.is_some() {
            folder.join(format!("{filename}.pcm.partial"))
        } else {
            partial.clone()
        };
        let result = (|| -> Result<String, String> {
            cancelled(cancel)?;
            let mut reader = device::open_track(&disc, track)?;
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&source)
                .map_err(|e| e.to_string())?;
            let tags = [
                ("TITLE", track.title.clone()),
                (
                    "ARTIST",
                    track.artist.clone().unwrap_or_else(|| disc.artist.clone()),
                ),
                ("ALBUMARTIST", disc.artist.clone()),
                ("ALBUM", disc.title.clone()),
                ("TRACKNUMBER", track.number.to_string()),
                ("TRACKTOTAL", disc.tracks.len().to_string()),
            ];
            let mut writer = if encoding.is_some() {
                AudioWriter::Pcm(file)
            } else {
                AudioWriter::with_cover(file, &request.format, &tags, cover.as_ref())?
            };
            let mut offset = 0;
            let mut hash = Sha256::new();
            while offset < track.sectors {
                let count = (track.sectors - offset).min(27);
                let data = checked_read(reader.as_mut(), offset, count, request.verify, cancel)?;
                writer.write(&data)?;
                hash.update(&data);
                offset += count;
                if last_emit.elapsed().as_millis() > 120 || offset == track.sectors {
                    notify(RipProgress {
                        phase: "reading".into(),
                        track: track.number,
                        completed: index,
                        total: tracks.len(),
                        fraction: (finished_sectors as f64
                            + offset as f64 * if encoding.is_some() { 0.9 } else { 1.0 })
                            / total_sectors as f64,
                        message: format!(
                            "正在{}曲目 {:02} · {}",
                            if request.verify {
                                "读取并比对"
                            } else {
                                "读取"
                            },
                            track.number,
                            track.title
                        ),
                        output_dir: folder.to_string_lossy().into(),
                    });
                    last_emit = std::time::Instant::now();
                }
            }
            cancelled(cancel)?;
            writer.finish()?;
            if let Some((encoder, options)) = &encoding {
                notify(RipProgress {
                    phase: "encoding".into(),
                    track: track.number,
                    completed: index,
                    total: tracks.len(),
                    fraction: (finished_sectors as f64 + track.sectors as f64 * 0.9)
                        / total_sectors as f64,
                    message: format!(
                        "正在编码 {} · 曲目 {:02} · {}",
                        request.format.to_uppercase(),
                        track.number,
                        track.title
                    ),
                    output_dir: folder.to_string_lossy().into(),
                });
                encoder.encode(
                    EncodingJob {
                        input: &source,
                        output: &partial,
                        cover: cover_path.as_deref(),
                        tags: &tags,
                        format: &request.format,
                        options,
                    },
                    cancel,
                )?;
                fs::remove_file(&source).map_err(|e| e.to_string())?;
            }
            cancelled(cancel)?;
            fs::rename(&partial, folder.join(&filename)).map_err(|e| e.to_string())?;
            Ok(format!("{:x}", hash.finalize()))
        })();
        match result {
            Ok(hash) => {
                finished_sectors += track.sectors as u64;
                reports.push(json!({"track":track.number,"title":track.title,"file":filename,"samples":track.sectors as u64*588,"pcmSha256":hash,"readCompared":request.verify,"preEmphasis":track.pre_emphasis,"status":"complete"}));
                playlist.push_str(&format!(
                    "#EXTINF:{},{}\n{}\n",
                    track.duration().round(),
                    track.title.replace(['\n', '\r'], " "),
                    filename
                ));
                fs::write(folder.join("playlist.m3u8"), &playlist).map_err(|e| e.to_string())?;
                save_report(&reports, "in-progress")?;
            }
            Err(error) => {
                if partial.exists() {
                    let _ = fs::remove_file(&partial);
                }
                if source != partial && source.exists() {
                    let _ = fs::remove_file(&source);
                }
                reports.push(json!({"track":track.number,"status":"incomplete","error":error}));
                let report_error = save_report(
                    &reports,
                    if cancel.load(Ordering::Relaxed) {
                        "cancelled"
                    } else {
                        "failed"
                    },
                )
                .err();
                return Err(format!(
                    "{error}。已完成的文件保留在 {}{}",
                    folder.display(),
                    report_error
                        .map(|e| format!("；日志写入失败：{e}"))
                        .unwrap_or_default()
                ));
            }
        }
    }
    save_report(&reports, "complete")?;
    notify(RipProgress {
        phase: "complete".into(),
        track: 0,
        completed: tracks.len(),
        total: tracks.len(),
        fraction: 1.0,
        message: format!("{} 首曲目已保存", tracks.len()),
        output_dir: folder.to_string_lossy().into(),
    });
    Ok(folder.to_string_lossy().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        n: u8,
        unstable: bool,
    }
    impl SectorReader for Fake {
        fn read_sectors(&mut self, _: u32, n: u32) -> Result<Vec<u8>, String> {
            self.n += 1;
            Ok(vec![
                if self.unstable { self.n } else { 42 };
                n as usize * 2352
            ])
        }
    }
    #[test]
    fn comparison_rejects_mismatches_and_honors_cancellation() {
        let cancel = AtomicBool::new(false);
        let mut reader = Fake {
            n: 0,
            unstable: true,
        };
        assert!(checked_read(&mut reader, 0, 1, true, &cancel).is_err());
        assert_eq!(reader.n, 6);
        reader.unstable = false;
        assert!(checked_read(&mut reader, 0, 1, true, &cancel).is_ok());
        cancel.store(true, Ordering::Relaxed);
        let before = reader.n;
        assert!(checked_read(&mut reader, 0, 1, false, &cancel).is_err());
        assert_eq!(before, reader.n);
    }
    #[test]
    fn filenames_cannot_escape_or_use_windows_reserved_names() {
        assert_eq!(safe_name("../../A:B"), ".._.._A_B");
        assert_eq!(safe_name("NUL"), "_NUL");
        assert_eq!(safe_name("..."), "Untitled");
    }
    #[test]
    fn album_directories_never_overwrite_previous_exports() {
        let dir = tempfile::tempdir().unwrap();
        let one = create_album_dir(dir.path(), "album").unwrap();
        fs::write(one.join("keep.txt"), "keep").unwrap();
        let two = create_album_dir(dir.path(), "album").unwrap();
        assert_ne!(one, two);
        assert_eq!(fs::read_to_string(one.join("keep.txt")).unwrap(), "keep");
    }
}
