use crate::{
    audio::{CpalBackend, OutputRouter},
    device,
    equalizer::{EqualizerControl, EqualizerSettings, EqualizerSource},
    models::*,
};
use rodio::{OutputStream, Sink, Source};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender, TryRecvError, TrySendError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

enum Command {
    Play(Disc, u8, f64),
    Pause,
    Resume,
    Stop,
    Volume(f32),
    SelectOutput(Option<String>),
    RefreshOutput(bool),
}
type Reply = SyncSender<Result<(), String>>;
pub struct Player {
    sender: Sender<(Command, Reply)>,
    status: Arc<Mutex<PlaybackStatus>>,
    equalizer: EqualizerControl,
}
impl Default for Player {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel();
        let status = Arc::new(Mutex::new(PlaybackStatus {
            volume: 0.5,
            ..Default::default()
        }));
        let shared = status.clone();
        let equalizer = EqualizerControl::default();
        let control = equalizer.clone();
        thread::spawn(move || worker(receiver, shared, control));
        Self {
            sender,
            status,
            equalizer,
        }
    }
}
impl Player {
    fn send(&self, command: Command) -> Result<(), String> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.sender
            .send((command, tx))
            .map_err(|_| "音频线程已停止")?;
        rx.recv().map_err(|_| "音频线程没有响应")?
    }
    pub fn play(&self, disc: Disc, track: u8, position: f64) -> Result<(), String> {
        self.send(Command::Play(disc, track, position))
    }
    pub fn pause(&self) -> Result<(), String> {
        self.send(Command::Pause)
    }
    pub fn resume(&self) -> Result<(), String> {
        self.send(Command::Resume)
    }
    pub fn stop(&self) -> Result<(), String> {
        self.send(Command::Stop)
    }
    pub fn volume(&self, value: f32) -> Result<(), String> {
        if !value.is_finite() {
            return Err("音量无效".into());
        }
        self.send(Command::Volume(value.clamp(0.0, 1.0)))
    }
    pub fn status(&self) -> PlaybackStatus {
        self.status.lock().unwrap().clone()
    }
    pub fn set_equalizer(&self, settings: EqualizerSettings) -> Result<(), String> {
        self.equalizer.set(settings)
    }
    pub fn select_output(&self, name: Option<String>) -> Result<AudioOutputStatus, String> {
        self.send(Command::SelectOutput(name))?;
        Ok(self.status().output)
    }
    pub fn refresh_output(&self, reconnect: bool) -> Result<AudioOutputStatus, String> {
        self.send(Command::RefreshOutput(reconnect))?;
        Ok(self.status().output)
    }
}
struct CdSource {
    receiver: Receiver<Vec<f32>>,
    buffer: Vec<f32>,
    index: usize,
    consumed: Arc<AtomicU64>,
}
impl Iterator for CdSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        if self.index == self.buffer.len() {
            match self.receiver.try_recv() {
                Ok(data) => {
                    self.buffer = data;
                    self.index = 0;
                }
                Err(TryRecvError::Empty) => return Some(0.0),
                Err(TryRecvError::Disconnected) => return None,
            }
        }
        let value = self.buffer[self.index];
        self.index += 1;
        self.consumed.fetch_add(1, Ordering::Relaxed);
        Some(value)
    }
}
impl Source for CdSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        2
    }
    fn sample_rate(&self) -> u32 {
        44100
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}
fn samples(data: Vec<u8>) -> Vec<f32> {
    data.as_chunks::<2>()
        .0
        .iter()
        .map(|p| i16::from_le_bytes([p[0], p[1]]) as f32 / 32768.0)
        .collect()
}
struct Session {
    sink: Sink,
    cancel: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    consumed: Arc<AtomicU64>,
    start: f64,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.sink.stop();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

fn begin(
    stream: &OutputStream,
    disc: Disc,
    number: u8,
    position: f64,
    status: Arc<Mutex<PlaybackStatus>>,
    paused: bool,
    equalizer: EqualizerControl,
) -> Result<Session, String> {
    let disc = device::validated_disc(&disc)?;
    let track = disc
        .tracks
        .iter()
        .find(|t| t.number == number)
        .ok_or("未找到该音轨")?
        .clone();
    if !position.is_finite() || position < 0.0 {
        return Err("播放位置无效".into());
    }
    let offset = ((position * 75.0) as u32).min(track.sectors.saturating_sub(1));
    let mut reader = device::open_track(&disc, &track)?;
    let count = (track.sectors - offset).min(27);
    let first = samples(reader.read_sectors(offset, count)?);
    let (tx, rx) = mpsc::sync_channel(8);
    let cancel = Arc::new(AtomicBool::new(false));
    let cancelled = cancel.clone();
    let consumed = Arc::new(AtomicU64::new(0));
    let sink = Sink::connect_new(stream.mixer());
    sink.pause();
    let volume = status.lock().unwrap().volume;
    sink.set_volume(volume);
    let source = CdSource {
        receiver: rx,
        buffer: first,
        index: 0,
        consumed: consumed.clone(),
    };
    let shared = status.clone();
    let thread = thread::spawn(move || {
        let mut offset = offset + count;
        while offset < track.sectors && !cancelled.load(Ordering::Relaxed) {
            let count = (track.sectors - offset).min(27);
            let mut data = match reader.read_sectors(offset, count) {
                Ok(bytes) => samples(bytes),
                Err(error) => {
                    shared.lock().unwrap().error = Some(error);
                    return;
                }
            };
            loop {
                if cancelled.load(Ordering::Relaxed) {
                    return;
                }
                match tx.try_send(data) {
                    Ok(()) => break,
                    Err(TrySendError::Full(returned)) => {
                        data = returned;
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(TrySendError::Disconnected(_)) => return,
                }
            }
            offset += count;
        }
    });
    {
        let mut state = status.lock().unwrap();
        state.track = Some(number);
        state.duration = track.duration();
        state.position = offset as f64 / 75.0;
        state.playing = !paused;
        state.error = None;
        state.ended = false;
    }
    sink.append(EqualizerSource::new(source, equalizer));
    if !paused {
        sink.play();
    }
    Ok(Session {
        sink,
        cancel,
        reader: Some(thread),
        consumed,
        start: offset as f64 / 75.0,
    })
}
#[derive(Clone)]
struct Transport {
    disc: Disc,
    track: u8,
    position: f64,
    paused: bool,
}

struct Runtime {
    // Session must be dropped before its output stream.
    session: Option<Session>,
    transport: Option<Transport>,
    output: OutputRouter<CpalBackend>,
    status: Arc<Mutex<PlaybackStatus>>,
    equalizer: EqualizerControl,
}
impl Runtime {
    fn update_position(&mut self) {
        if let Some(session) = &self.session {
            let mut state = self.status.lock().unwrap();
            state.position = (session.start
                + session.consumed.load(Ordering::Relaxed) as f64 / 88200.0)
                .min(state.duration);
            if let Some(transport) = &mut self.transport {
                transport.position = state.position;
                transport.paused = session.sink.is_paused();
            }
            if session.sink.empty() {
                state.playing = false;
                state.ended = state.error.is_none();
                if state.ended {
                    self.transport = None;
                }
            }
        }
    }
    fn restore(&mut self) -> Result<(), String> {
        if let Some(t) = self.transport.clone() {
            let stream = self.output.stream().ok_or("音频输出未就绪")?;
            self.session = Some(begin(
                stream,
                t.disc,
                t.track,
                t.position,
                self.status.clone(),
                t.paused,
                self.equalizer.clone(),
            )?);
        }
        Ok(())
    }
    fn synchronize_output(&mut self, force: bool) -> Result<(), String> {
        let result = if self.output.refresh(force) {
            self.update_position();
            drop(self.session.take());
            // Capture the current sample position and pause state before discarding the old mixer.
            let result = self.output.reconnect().and_then(|()| self.restore());
            if result.is_err() {
                if let Some(t) = &mut self.transport {
                    t.paused = true;
                }
                let mut state = self.status.lock().unwrap();
                state.playing = false;
                state.ended = false;
                if self.output.status.error.is_none() {
                    state.error = result.as_ref().err().cloned();
                }
            }
            result
        } else {
            self.output.status.error.clone().map_or(Ok(()), Err)
        };
        self.status.lock().unwrap().output = self.output.status.clone();
        result
    }
    fn command(&mut self, command: Command) -> Result<(), String> {
        match command {
            Command::Play(disc, track, position) => {
                if !position.is_finite() || position < 0.0 {
                    return Err("播放位置无效".into());
                }
                drop(self.session.take());
                self.transport = None;
                {
                    let mut state = self.status.lock().unwrap();
                    state.playing = false;
                    state.ended = false;
                    state.error = None;
                    state.track = None;
                }
                self.synchronize_output(false)?;
                self.transport = Some(Transport {
                    disc,
                    track,
                    position,
                    paused: false,
                });
                if let Err(error) = self.restore() {
                    self.transport = None;
                    self.status.lock().unwrap().error = Some(error.clone());
                    return Err(error);
                }
            }
            Command::Pause => {
                if let Some(s) = &self.session {
                    s.sink.pause();
                }
                if let Some(t) = &mut self.transport {
                    t.paused = true;
                }
                self.status.lock().unwrap().playing = false;
            }
            Command::Resume => {
                self.synchronize_output(false)?;
                if let Some(t) = &mut self.transport {
                    t.paused = false;
                }
                if self.session.as_ref().is_none_or(|s| s.sink.empty()) {
                    drop(self.session.take());
                    self.restore()?;
                }
                if let Some(s) = &self.session {
                    if !s.sink.empty() {
                        s.sink.play();
                        self.status.lock().unwrap().playing = true;
                    }
                }
            }
            Command::Stop => {
                drop(self.session.take());
                self.transport = None;
                let mut state = self.status.lock().unwrap();
                state.playing = false;
                state.track = None;
                state.position = 0.0;
                state.error = None;
                state.ended = false;
            }
            Command::Volume(value) => {
                if let Some(s) = &self.session {
                    s.sink.set_volume(value);
                }
                self.status.lock().unwrap().volume = value;
            }
            Command::SelectOutput(name) => {
                self.output.select(name);
                self.synchronize_output(true)?;
            }
            Command::RefreshOutput(force) => {
                self.synchronize_output(force)?;
            }
        }
        Ok(())
    }
}
fn worker(
    receiver: Receiver<(Command, Reply)>,
    status: Arc<Mutex<PlaybackStatus>>,
    equalizer: EqualizerControl,
) {
    let mut runtime = Runtime {
        session: None,
        transport: None,
        output: OutputRouter::new(CpalBackend),
        status,
        equalizer,
    };
    let _ = runtime.synchronize_output(false);
    let mut last_scan = Instant::now();
    loop {
        match receiver.recv_timeout(Duration::from_millis(80)) {
            Ok((command, reply)) => {
                let result = runtime.command(command);
                let _ = reply.send(result);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        runtime.update_position();
        let interval = if runtime.output.status.error.is_some() {
            2
        } else {
            1
        };
        if last_scan.elapsed() >= Duration::from_secs(interval) {
            let _ = runtime.synchronize_output(false);
            last_scan = Instant::now();
        }
    }
}
