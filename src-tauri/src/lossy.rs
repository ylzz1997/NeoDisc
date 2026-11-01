use crate::models::{BitrateMode, ChannelMode, EncodingOptions};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub fn is_lossy(format: &str) -> bool {
    matches!(format, "mp3" | "aac")
}
pub fn extension(format: &str) -> &str {
    if format == "aac" {
        "m4a"
    } else {
        format
    }
}

pub struct Encoder {
    path: PathBuf,
}
pub struct EncodingJob<'a> {
    pub input: &'a Path,
    pub output: &'a Path,
    pub cover: Option<&'a Path>,
    pub tags: &'a [(&'a str, String)],
    pub format: &'a str,
    pub options: &'a EncodingOptions,
}

fn executable(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.into()
    }
}
impl Encoder {
    pub fn bundled() -> Result<Self, String> {
        let executable_dir = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("无法找到应用目录")?
            .to_path_buf();
        let candidates = vec![executable_dir.join(executable("ffmpeg"))];
        #[cfg(debug_assertions)]
        let candidates = {
            let mut candidates = candidates;
            candidates.push(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("encoders")
                    .join(executable(&format!("ffmpeg-{}", env!("NEODISC_TARGET")))),
            );
            candidates
        };
        candidates.into_iter().find(|path|path.is_file()).map(|path|Self{path})
            .ok_or_else(||"未找到内置音频编码器。请使用完整安装包，或保留程序旁的 ffmpeg 文件；FLAC / WAV 仍可使用。".into())
    }
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn encode(&self, job: EncodingJob<'_>, cancel: &AtomicBool) -> Result<(), String> {
        job.options.validate(job.format)?;
        match std::fs::metadata(job.output) {
            Ok(_) => return Err("输出文件已存在，不会覆盖已有文件".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法创建编码输出：{error}")),
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消抓轨".into());
        }
        // -n and a fresh album directory prevent replacement of existing output.
        let mut command = self.command(&job);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = ChildGuard(
            command
                .spawn()
                .map_err(|e| format!("无法启动音频编码器：{e}"))?,
        );
        let stderr = child.0.stderr.take().ok_or("无法读取编码器状态")?;
        let log = thread::spawn(move || read_tail(stderr));
        let start = Instant::now();
        let result = loop {
            if cancel.load(Ordering::Relaxed) {
                break Err("已取消抓轨".to_string());
            }
            if start.elapsed() > Duration::from_secs(1800) {
                break Err("编码超时，已停止当前曲目".into());
            }
            match child.0.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(error) => break Err(format!("读取编码器状态失败：{error}")),
            }
        };
        // Kill and reap before joining the log reader and releasing partial files.
        drop(child);
        let message = log.join().unwrap_or_default();
        let status = result?;
        if !status.success() || !message.is_empty() {
            return Err(format!(
                "{} 编码失败：{}",
                job.format.to_uppercase(),
                String::from_utf8_lossy(&message).trim()
            ));
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消抓轨".into());
        }
        if std::fs::metadata(job.output)
            .map_err(|e| e.to_string())?
            .len()
            == 0
        {
            return Err("编码器未生成有效音频文件".into());
        }
        Ok(())
    }

    fn command(&self, job: &EncodingJob<'_>) -> Command {
        let mut command = Command::new(&self.path);
        command
            .args([
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-n",
                "-f",
                "s16le",
                "-ar",
                "44100",
                "-ac",
                "2",
                "-i",
            ])
            .arg(job.input);
        if let Some(cover) = job.cover {
            command
                .args(["-f", "image2", "-pattern_type", "none", "-i"])
                .arg(cover);
        }
        command.args(["-map", "0:a:0", "-map_metadata", "-1"]);
        if job.cover.is_some() {
            command.args([
                "-map",
                "1:v:0",
                "-c:v",
                "copy",
                "-disposition:v:0",
                "attached_pic",
                "-metadata:s:v:0",
                "title=Album cover",
                "-metadata:s:v:0",
                "comment=Cover (front)",
            ]);
        }
        let options = job.options;
        command.args([
            "-ar",
            &options.sample_rate.to_string(),
            "-ac",
            &options.channels().to_string(),
        ]);
        if job.format == "mp3" {
            command.args([
                "-c:a",
                "libmp3lame",
                "-compression_level",
                &options.encoder_quality.to_string(),
                "-joint_stereo",
                if options.channel_mode == ChannelMode::JointStereo {
                    "1"
                } else {
                    "0"
                },
            ]);
            match options.bitrate_mode {
                BitrateMode::Vbr => {
                    command.args(["-q:a", &options.vbr_quality.to_string()]);
                }
                mode => {
                    command.args([
                        "-b:a",
                        &format!("{}k", options.bitrate_kbps),
                        "-abr",
                        if mode == BitrateMode::Abr { "1" } else { "0" },
                    ]);
                }
            }
            command.args(["-id3v2_version", "3", "-write_id3v1", "0", "-f", "mp3"]);
        } else {
            command.args([
                "-c:a",
                "aac",
                "-profile:a",
                "aac_low",
                "-b:a",
                &format!("{}k", options.bitrate_kbps),
                "-movflags",
                "+faststart",
                "-f",
                "ipod",
            ]);
        }
        for (key, value) in job.tags {
            let name = match *key {
                "TITLE" => "title",
                "ARTIST" => "artist",
                "ALBUMARTIST" => "album_artist",
                "ALBUM" => "album",
                "TRACKNUMBER" => "track",
                _ => continue,
            };
            let value = if *key == "TRACKNUMBER" {
                let total = job
                    .tags
                    .iter()
                    .find(|(key, _)| *key == "TRACKTOTAL")
                    .map(|(_, value)| value.as_str())
                    .unwrap_or("");
                format!("{value}/{total}")
            } else {
                value.clone()
            };
            command.arg("-metadata").arg(format!("{name}={value}"));
        }
        command.arg(job.output);
        command
    }
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn read_tail(mut reader: impl Read) -> Vec<u8> {
    let mut result = Vec::new();
    let mut buffer = [0; 4096];
    while let Ok(length) = reader.read(&mut buffer) {
        if length == 0 {
            break;
        }
        result.extend_from_slice(&buffer[..length]);
        if result.len() > 8192 {
            result.drain(..result.len() - 8192);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hidden_command(path: &Path) -> Command {
        let command = Command::new(path);
        #[cfg(target_os = "windows")]
        let command = {
            use std::os::windows::process::CommandExt;
            let mut command = command;
            command.creation_flags(0x08000000);
            command
        };
        command
    }
    fn probe(path: &Path) -> serde_json::Value {
        let binary = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/encoder-download/tools")
            .join(executable("ffprobe"));
        let result = hidden_command(&binary)
            .args([
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
            ])
            .arg(path)
            .output()
            .expect("run npm run prepare:encoder before native encoder tests");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice(&result.stdout).unwrap()
    }
    #[test]
    fn bundled_encoders_produce_decodable_audio_with_requested_rates_tags_and_covers() {
        let encoder = Encoder::bundled().expect("run npm run prepare:encoder first");
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("原始音频 ' & sample.pcm");
        let duration = 3.0;
        // Construct s16le PCM explicitly; the source is always CD-rate stereo.
        let pcm: Vec<u8> = (0..(44100.0 * duration) as usize)
            .flat_map(|frame| {
                [440.0, 880.0].into_iter().flat_map(move |hz| {
                    (((frame as f64 * hz * std::f64::consts::TAU / 44100.0).sin() * 12000.0).round()
                        as i16)
                        .to_le_bytes()
                })
            })
            .collect();
        std::fs::write(&input, &pcm).unwrap();
        let cover = temp.path().join("cover.png");
        image::DynamicImage::new_rgb8(20, 30).save(&cover).unwrap();
        let tags = [
            ("TITLE", "测试曲目 & 'quotes'".into()),
            ("ARTIST", "测试艺术家".into()),
            ("ALBUM", "测试专辑".into()),
            ("ALBUMARTIST", "专辑艺术家".into()),
            ("TRACKNUMBER", "2".into()),
            ("TRACKTOTAL", "8".into()),
        ];
        let cases = [
            (
                "mp3",
                44100,
                192,
                BitrateMode::Cbr,
                ChannelMode::JointStereo,
            ),
            ("mp3", 48000, 128, BitrateMode::Abr, ChannelMode::Stereo),
            ("mp3", 32000, 128, BitrateMode::Vbr, ChannelMode::Mono),
            ("mp3", 22050, 96, BitrateMode::Cbr, ChannelMode::JointStereo),
            ("aac", 44100, 256, BitrateMode::Cbr, ChannelMode::Stereo),
            ("aac", 24000, 64, BitrateMode::Cbr, ChannelMode::Mono),
        ];
        for (index, (format, sample_rate, bitrate_kbps, bitrate_mode, channel_mode)) in
            cases.into_iter().enumerate()
        {
            let options = EncodingOptions {
                sample_rate,
                bitrate_kbps,
                bitrate_mode,
                channel_mode,
                ..EncodingOptions::for_format(format)
            };
            let output = temp.path().join(format!("{index}.{}", extension(format)));
            encoder
                .encode(
                    EncodingJob {
                        input: &input,
                        output: &output,
                        cover: Some(&cover),
                        tags: &tags,
                        format,
                        options: &options,
                    },
                    &AtomicBool::new(false),
                )
                .unwrap();
            let metadata = probe(&output);
            let streams = metadata["streams"].as_array().unwrap();
            let audio = streams
                .iter()
                .find(|stream| stream["codec_type"] == "audio")
                .unwrap();
            assert_eq!(audio["codec_name"], format);
            assert_eq!(audio["sample_rate"], sample_rate.to_string());
            assert_eq!(audio["channels"], options.channels());
            assert_eq!(metadata["format"]["tags"]["title"], tags[0].1);
            assert_eq!(metadata["format"]["tags"]["album"], "测试专辑");
            assert_eq!(metadata["format"]["tags"]["track"], "2/8");
            assert!(streams
                .iter()
                .any(|stream| stream["disposition"]["attached_pic"] == 1));
            if format == "mp3" && bitrate_mode == BitrateMode::Cbr {
                assert_eq!(audio["bit_rate"], (bitrate_kbps * 1000).to_string());
            }
            let decoded = hidden_command(encoder.path())
                .args(["-v", "error", "-i"])
                .arg(&output)
                .args(["-map", "0:a:0", "-f", "s16le", "-c:a", "pcm_s16le", "-"])
                .output()
                .unwrap();
            assert!(
                decoded.status.success(),
                "{}",
                String::from_utf8_lossy(&decoded.stderr)
            );
            let frames = decoded.stdout.len() as f64 / (2 * options.channels()) as f64;
            assert!((frames / sample_rate as f64 - duration).abs() < 0.1);
            assert!(decoded
                .stdout
                .as_chunks::<2>()
                .0
                .iter()
                .any(|sample| i16::from_le_bytes([sample[0], sample[1]]).unsigned_abs() > 5000));
        }
        assert_eq!(std::fs::read(input).unwrap(), pcm);
    }
    #[test]
    fn encoder_refuses_overwrite_and_cancels_a_running_child() {
        let encoder = Encoder::bundled().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("long.pcm");
        std::fs::File::create(&input)
            .unwrap()
            .set_len(44100 * 4 * 180)
            .unwrap();
        let existing = temp.path().join("keep.m4a");
        std::fs::write(&existing, b"keep this existing file").unwrap();
        let options = EncodingOptions::for_format("aac");
        assert!(encoder
            .encode(
                EncodingJob {
                    input: &input,
                    output: &existing,
                    cover: None,
                    tags: &[],
                    format: "aac",
                    options: &options
                },
                &AtomicBool::new(false)
            )
            .is_err());
        assert_eq!(
            std::fs::read(&existing).unwrap(),
            b"keep this existing file"
        );
        let output = temp.path().join("cancel.m4a.partial");
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        let result = thread::scope(|scope| {
            scope.spawn(|| {
                thread::sleep(Duration::from_millis(25));
                cancel.store(true, Ordering::Relaxed);
            });
            encoder.encode(
                EncodingJob {
                    input: &input,
                    output: &output,
                    cover: None,
                    tags: &[],
                    format: "aac",
                    options: &options,
                },
                &cancel,
            )
        });
        assert!(result.unwrap_err().starts_with("已取消"));
        assert!(started.elapsed() < Duration::from_secs(5));
        if output.exists() {
            std::fs::remove_file(output).unwrap();
        }
        std::fs::remove_file(input).unwrap();
    }
    #[test]
    fn rejects_incompatible_rates_before_encoding() {
        let mut options = EncodingOptions::for_format("mp3");
        options.sample_rate = 22050;
        options.bitrate_kbps = 320;
        assert!(options.validate("mp3").is_err());
        options.bitrate_kbps = 128;
        assert!(options.validate("mp3").is_ok());
        options = EncodingOptions::for_format("aac");
        options.channel_mode = ChannelMode::Mono;
        options.sample_rate = 16000;
        options.bitrate_kbps = 128;
        assert!(options.validate("aac").is_err());
        options.bitrate_kbps = 64;
        assert!(options.validate("aac").is_ok());
        options.bitrate_mode = BitrateMode::Vbr;
        assert!(options.validate("aac").is_err());
    }
    #[test]
    fn error_logs_are_bounded_without_stopping_the_drain() {
        let data = vec![42; 20000];
        assert_eq!(read_tail(std::io::Cursor::new(data)), vec![42; 8192]);
    }
}
