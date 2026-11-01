use lucent_core::{
    device, lossy,
    models::{ChannelMode, EncodingOptions, RipRequest},
    rip,
};
use serde_json::Value;
use std::{
    cell::{Cell, RefCell},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};

fn probe(path: &Path) -> Result<Value, String> {
    let binary = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../artifacts/encoder-download/tools")
        .join(if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        });
    let mut command = Command::new(binary);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
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
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}
fn main() -> Result<(), String> {
    let arguments: Vec<String> = std::env::args().collect();
    let drive = arguments
        .get(1)
        .ok_or("Usage: compressed_smoke <drive> <test-output-directory>")?;
    let root = PathBuf::from(arguments.get(2).ok_or("Provide a test output directory")?);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let disc = device::read_disc(drive)?;
    let first = disc.tracks.first().ok_or("No tracks")?;
    let mut hashes = vec![];
    for format in ["mp3", "aac"] {
        let mut options = EncodingOptions::for_format(format);
        options.sample_rate = if format == "mp3" { 48000 } else { 32000 };
        options.bitrate_kbps = if format == "mp3" { 192 } else { 96 };
        options.channel_mode = if format == "mp3" {
            ChannelMode::Stereo
        } else {
            ChannelMode::Mono
        };
        let request = RipRequest {
            disc: disc.clone(),
            tracks: vec![first.number],
            format: format.into(),
            output_dir: root.to_string_lossy().into(),
            verify: true,
            encoding: Some(options.clone()),
        };
        let last = Cell::new(0);
        let folder = rip::run(request, &AtomicBool::new(false), |progress| {
            let bucket = (progress.fraction * 10.0) as u32;
            if bucket != last.get() || progress.phase == "encoding" {
                println!(
                    "{format}: {}% {}",
                    (progress.fraction * 100.0) as u32,
                    progress.message
                );
                last.set(bucket);
            }
        })?;
        let report: Value = serde_json::from_slice(
            &fs::read(Path::new(&folder).join("rip-report.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let filename = report["tracks"][0]["file"]
            .as_str()
            .ok_or("No completed track")?;
        assert!(filename.ends_with(lossy::extension(format)));
        assert_eq!(report["encoding"]["sampleRate"], options.sample_rate);
        assert_eq!(report["status"], "complete");
        let metadata = probe(&Path::new(&folder).join(filename))?;
        let audio = metadata["streams"]
            .as_array()
            .unwrap()
            .iter()
            .find(|stream| stream["codec_type"] == "audio")
            .unwrap();
        assert_eq!(audio["codec_name"], format);
        assert_eq!(audio["sample_rate"], options.sample_rate.to_string());
        assert_eq!(audio["channels"], options.channels());
        let length: f64 = metadata["format"]["duration"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!((length - first.duration()).abs() < 0.2);
        assert_eq!(metadata["format"]["tags"]["title"], first.title);
        let playlist = fs::read_to_string(Path::new(&folder).join("playlist.m3u8")).unwrap();
        assert!(playlist.contains(filename));
        assert!(fs::read_dir(&folder).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".partial")));
        hashes.push(report["tracks"][0]["pcmSha256"].clone());
        println!(
            "PASS {format}: codec, sample rate, channels, duration, tags, playlist and cleanup"
        );
    }
    assert_eq!(hashes[0], hashes[1]);
    for phase in ["reading", "encoding"] {
        let cancel = AtomicBool::new(false);
        let folder = RefCell::new(String::new());
        let request = RipRequest {
            disc: disc.clone(),
            tracks: vec![first.number],
            format: "aac".into(),
            output_dir: root.to_string_lossy().into(),
            verify: false,
            encoding: Some(EncodingOptions::for_format("aac")),
        };
        let result = rip::run(request, &cancel, |progress| {
            *folder.borrow_mut() = progress.output_dir;
            if progress.phase == phase {
                cancel.store(true, Ordering::Relaxed);
            }
        });
        assert!(result.unwrap_err().starts_with("已取消"));
        assert!(fs::read_dir(&*folder.borrow()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".partial")));
        println!("PASS cancellation in {phase}: incomplete raw and encoded files removed");
    }
    fs::write(root.join("compressed-smoke-result.txt"),format!("PASS MP3 and AAC full-track extraction, rates, channels, metadata, playlists\nPASS identical source PCM SHA256: {}\nPASS cancellation during reading and encoding, no partial files\n",hashes[0])).map_err(|e|e.to_string())?;
    Ok(())
}
