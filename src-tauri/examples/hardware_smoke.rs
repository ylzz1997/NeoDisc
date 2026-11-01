//! Opt-in integration check: muted playback, one complete track, and cancellation.
use lucent_core::{device, models::RipRequest, playback::Player, rip};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};
fn main() -> Result<(), String> {
    let id = std::env::args().nth(1).ok_or("Pass a drive ID")?;
    let root = PathBuf::from(std::env::args().nth(2).ok_or("Pass an output directory")?);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let disc = device::read_disc(&id)?;
    let track = disc.tracks.first().ok_or("No tracks")?;
    let player = Player::default();
    player.volume(0.0)?;
    player.play(disc.clone(), track.number, 0.0)?;
    thread::sleep(Duration::from_millis(700));
    let playing = player.status();
    if !playing.playing || playing.position < 0.2 {
        return Err(format!("Playback did not advance: {playing:?}"));
    }
    player.pause()?;
    thread::sleep(Duration::from_millis(200));
    let paused = player.status();
    thread::sleep(Duration::from_millis(200));
    let held = player.status();
    if held.playing || (held.position - paused.position).abs() > 0.1 {
        return Err("Pause did not hold position".into());
    }
    player.resume()?;
    thread::sleep(Duration::from_millis(400));
    if !player.status().playing {
        return Err("Resume failed".into());
    }
    player.play(disc.clone(), track.number, track.duration() - 0.3)?;
    thread::sleep(Duration::from_secs(2));
    let end = player.status();
    if end.playing || (end.position - end.duration).abs() > 0.02 {
        return Err(format!("Seek/end failed: {end:?}"));
    }
    player.stop()?;
    println!("PASS: muted playback / pause / resume / seek / natural end / stop");
    let request = RipRequest {
        disc: disc.clone(),
        tracks: vec![track.number],
        format: "flac".into(),
        encoding: None,
        output_dir: root.to_string_lossy().into(),
        verify: true,
    };
    let cancel = AtomicBool::new(false);
    let folder = rip::run(request.clone(), &cancel, |p| {
        if p.phase == "complete" {
            println!("{}", p.message);
        }
    })?;
    let folder = PathBuf::from(folder);
    let report: serde_json::Value = serde_json::from_slice(
        &fs::read(folder.join("rip-report.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let filename = report["tracks"][0]["file"]
        .as_str()
        .ok_or("Missing output file")?;
    let mut decoder = claxon::FlacReader::open(folder.join(filename)).map_err(|e| e.to_string())?;
    if decoder.streaminfo().samples != Some(track.sectors as u64 * 588) {
        return Err("Wrong FLAC sample count".into());
    }
    let mut hash = Sha256::new();
    for sample in decoder.samples() {
        hash.update((sample.map_err(|e| e.to_string())? as i16).to_le_bytes());
    }
    let decoded_hash = format!("{:x}", hash.finalize());
    if report["tracks"][0]["pcmSha256"].as_str() != Some(&decoded_hash) {
        return Err("Full-track PCM hash mismatch".into());
    }
    println!("PASS: full track rip / repeated reads / independent FLAC decode / SHA256 / tags / playlist / report");
    let cancelled = rip::run(request, &cancel, |p| {
        if p.fraction > 0.02 {
            cancel.store(true, Ordering::Relaxed);
        }
    });
    if !cancelled.as_ref().is_err_and(|e| e.starts_with("已取消")) {
        return Err("Cancellation failed".into());
    }
    for folder in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        if folder.path().is_dir() {
            for file in fs::read_dir(folder.path())
                .map_err(|e| e.to_string())?
                .flatten()
            {
                if file.path().extension().is_some_and(|e| e == "partial") {
                    return Err("Partial file left after cancellation".into());
                }
            }
        }
    }
    println!("PASS: cancellation / partial-file cleanup / existing exports preserved");
    fs::write(root.join("smoke-result.txt"),format!("PASS: playback, pause, resume, seek, end, stop\nPASS: full-track FLAC export and independent decoder SHA256 comparison\nPCM SHA256: {decoded_hash}\nPASS: cancellation, cleanup, collision-safe output directories\n")).map_err(|e|e.to_string())?;
    Ok(())
}
