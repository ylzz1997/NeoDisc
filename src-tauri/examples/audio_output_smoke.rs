//! Opt-in, muted hardware check. Never changes the system's default output.
use lucent_core::{device, equalizer::EqualizerSettings, playback::Player};
use std::{thread, time::Duration};

fn settle() {
    thread::sleep(Duration::from_millis(300));
}

fn main() -> Result<(), String> {
    let player = Player::default();
    player.volume(0.0)?;
    let output = player.refresh_output(false)?;
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
    let Some(drive) = std::env::args().nth(1) else {
        return Ok(());
    };
    let disc = device::read_disc(&drive)?;
    let track = disc.tracks.first().ok_or("No tracks")?.number;
    player.play(disc, track, 3.0)?;
    // Cold USB/Bluetooth endpoints can start asynchronously. Wait for samples,
    // not an assumed fixed device startup latency.
    for _ in 0..20 {
        settle();
        let state = player.status();
        if state.position > 3.05 || state.error.is_some() || state.output.error.is_some() {
            break;
        }
    }
    let before = player.status();
    if !before.playing || before.position <= 3.05 {
        return Err(format!("Initial playback did not advance: {before:?}"));
    }
    let generation = before.output.generation;
    let mut eq = EqualizerSettings {
        enabled: true,
        preamp_db: -6.0,
        bands: [4.0, 3.0, 1.0, -1.0, -2.0, 1.0, 3.0, 4.0, 3.0, 2.0],
    };
    player.set_equalizer(eq)?;
    settle();
    let adjusted = player.status();
    if !adjusted.playing
        || adjusted.track != before.track
        || adjusted.position <= before.position
        || adjusted.output.generation != generation
        || adjusted.volume != 0.0
    {
        return Err(format!("Live EQ disturbed playback: {adjusted:?}"));
    }
    println!("PASS: live EQ keeps the output stream, position and muted playback");
    player.refresh_output(true)?;
    settle();
    let reconnected = player.status();
    if !reconnected.playing
        || reconnected.position < before.position - 0.05
        || reconnected.output.generation <= generation
        || reconnected.volume != 0.0
    {
        return Err(format!("Reconnect lost transport state: {reconnected:?}"));
    }
    println!("PASS: reconnect preserves track, position, playback and muted volume");

    // Test every selectable endpoint while paused, without emitting sound.
    player.pause()?;
    settle();
    let position = player.status().position;
    eq.enabled = false;
    player.set_equalizer(eq)?;
    settle();
    if player.status().playing || (player.status().position - position).abs() > 0.001 {
        return Err("EQ bypass disturbed paused playback".into());
    }
    eq.enabled = true;
    player.set_equalizer(eq)?;
    println!("PASS: EQ bypass preserves pause and position");
    for device in output.devices.iter().filter(|d| d.selectable) {
        player.select_output(Some(device.name.clone()))?;
        settle();
        let state = player.status();
        if state.playing
            || (state.position - position).abs() > 0.05
            || state.output.active_device.as_ref() != Some(&device.name)
            || state.track != Some(track)
        {
            return Err(format!("Device switch lost paused state: {state:?}"));
        }
        println!("PASS: paused switch to {}", device.name);
    }
    player.select_output(None)?;
    player.resume()?;
    settle();
    if !player.status().playing || player.status().position <= position + 0.05 {
        return Err("Resume after output switch did not advance".into());
    }
    let missing = "Lucent hardware test — intentionally absent endpoint";
    if player.select_output(Some(missing.into())).is_ok() {
        return Err("Missing output unexpectedly succeeded".into());
    }
    let failed = player.status();
    if failed.playing || failed.output.active_device.is_some() || failed.ended {
        return Err(format!(
            "Missing device did not suspend playback: {failed:?}"
        ));
    }
    player.select_output(None)?;
    settle();
    let recovered = player.status();
    if recovered.playing
        || recovered.output.error.is_some()
        || (recovered.position - failed.position).abs() > 0.05
    {
        return Err(format!(
            "Recovery did not retain paused position: {recovered:?}"
        ));
    }
    player.resume()?;
    settle();
    if !player.status().playing || player.status().position <= recovered.position + 0.05 {
        return Err("Resume after recovery failed".into());
    }
    player.stop()?;
    println!("PASS: missing device pauses; recovery and resume preserve position");
    Ok(())
}
