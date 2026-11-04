pub mod aiff;
pub mod audio;
pub mod device;
pub mod encode;
pub mod equalizer;
mod history;
pub mod lossy;
pub mod metadata;
pub mod models;
pub mod playback;
pub mod rip;

use models::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager, State};

struct Engine {
    player: playback::Player,
    gate: Mutex<()>,
    ripping: AtomicBool,
    cancel: AtomicBool,
    metadata: metadata::MetadataService,
}
impl Default for Engine {
    fn default() -> Self {
        Self {
            player: Default::default(),
            gate: Mutex::new(()),
            ripping: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            metadata: Default::default(),
        }
    }
}
type Shared = Arc<Engine>;

#[tauri::command]
async fn identify_disc(
    disc: Disc,
    refresh: Option<bool>,
    state: State<'_, Shared>,
) -> Result<Option<AlbumMetadata>, String> {
    let engine = state.inner().clone();
    // Capture cancellation before queuing; the blocking pool may start later.
    let generation = engine.metadata.generation();
    tauri::async_runtime::spawn_blocking(move || {
        engine
            .metadata
            .lookup_at_generation(&disc, refresh.unwrap_or(false), generation)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_metadata_lookup(state: State<'_, Shared>) {
    state.metadata.cancel();
}

#[tauri::command]
async fn list_drives() -> Result<Vec<Drive>, String> {
    tauri::async_runtime::spawn_blocking(device::drives)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_disc(drive_id: String, state: State<'_, Shared>) -> Result<Disc, String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = engine.gate.lock().unwrap();
        if engine.ripping.load(Ordering::SeqCst) {
            return Err("抓轨期间请勿切换光盘".into());
        }
        engine.player.stop()?;
        device::read_disc(&drive_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn play_track(
    disc: Disc,
    track: u8,
    position: f64,
    state: State<'_, Shared>,
) -> Result<(), String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = engine.gate.lock().unwrap();
        if engine.ripping.load(Ordering::SeqCst) {
            return Err("请等待抓轨完成后播放".into());
        }
        engine.player.play(disc, track, position)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn player_action(
    action: String,
    value: Option<f32>,
    state: State<'_, Shared>,
) -> Result<(), String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "pause" => engine.player.pause(),
        "resume" => engine.player.resume(),
        "stop" => engine.player.stop(),
        "volume" => engine.player.volume(value.unwrap_or(0.5)),
        _ => Err("未知播放操作".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn playback_status(state: State<'_, Shared>) -> PlaybackStatus {
    state.player.status()
}
#[tauri::command]
async fn set_equalizer(
    settings: equalizer::EqualizerSettings,
    state: State<'_, Shared>,
) -> Result<(), String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || engine.player.set_equalizer(settings))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn select_audio_output(
    device_name: Option<String>,
    state: State<'_, Shared>,
) -> Result<AudioOutputStatus, String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = engine.gate.lock().unwrap();
        engine.player.select_output(device_name)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn refresh_audio_outputs(
    reconnect: bool,
    state: State<'_, Shared>,
) -> Result<AudioOutputStatus, String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = engine.gate.lock().unwrap();
        engine.player.refresh_output(reconnect)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn default_output() -> String {
    dirs::audio_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_default()
        .join("NeoDisc")
        .to_string_lossy()
        .into()
}
#[tauri::command]
async fn eject_disc(drive_id: String, state: State<'_, Shared>) -> Result<(), String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = engine.gate.lock().unwrap();
        if engine.ripping.load(Ordering::SeqCst) {
            return Err("抓轨期间无法弹出光盘".into());
        }
        engine.player.stop()?;
        device::eject(&drive_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn start_rip(
    request: RipRequest,
    app: tauri::AppHandle,
    state: State<'_, Shared>,
) -> Result<String, String> {
    let engine = state.inner().clone();
    {
        let _gate = engine.gate.lock().unwrap();
        if engine.ripping.swap(true, Ordering::SeqCst) {
            return Err("已有抓轨任务正在进行".into());
        }
        engine.cancel.store(false, Ordering::SeqCst);
    }
    let worker = engine.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        worker.player.stop()?;
        rip::run(request, &worker.cancel, |p| {
            let _ = app.emit("rip-progress", p);
        })
    })
    .await
    .map_err(|e| e.to_string());
    engine.ripping.store(false, Ordering::SeqCst);
    result?
}
#[tauri::command]
fn cancel_rip(state: State<'_, Shared>) {
    state.cancel.store(true, Ordering::SeqCst);
}
#[tauri::command]
async fn check_history_directories(
    paths: Vec<String>,
) -> Result<std::collections::HashMap<String, history::DirectoryState>, String> {
    tauri::async_runtime::spawn_blocking(move || history::check_directories(paths))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn open_folder(path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        match history::directory_state(&path) {
            history::DirectoryState::Available => {}
            history::DirectoryState::Missing => {
                return Err("目录不存在，可能已被移动或删除。".into());
            }
            history::DirectoryState::Unavailable => {
                return Err("无法访问目录，请检查磁盘连接或文件夹权限。".into());
            }
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer.exe")
                .arg(path)
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("/usr/bin/open")
                .arg(path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Engine::default()))
        .invoke_handler(tauri::generate_handler![
            list_drives,
            read_disc,
            identify_disc,
            cancel_metadata_lookup,
            play_track,
            player_action,
            set_equalizer,
            playback_status,
            select_audio_output,
            refresh_audio_outputs,
            default_output,
            eject_disc,
            start_rip,
            cancel_rip,
            check_history_directories,
            open_folder
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let engine = window.state::<Shared>();
                engine.cancel.store(true, Ordering::SeqCst);
                let _ = engine.player.stop();
            }
        })
        .run(tauri::generate_context!())
        .expect("无法启动 NeoDisc");
}
