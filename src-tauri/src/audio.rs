//! Output routing is separate from transport so device changes never imply a new track.
use crate::models::{AudioDeviceInfo, AudioOutputStatus};
use rodio::{
    cpal::{
        self,
        traits::{DeviceTrait, HostTrait},
    },
    OutputStream, OutputStreamBuilder,
};
use std::sync::{Arc, Mutex};

pub struct Inventory<D> {
    pub devices: Vec<(String, D)>,
    pub default: Option<(String, D)>,
}
pub struct Opened<S> {
    pub stream: S,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
}
pub type StreamFault = Arc<Mutex<Option<String>>>;

pub trait Backend {
    type Device: Clone;
    type Stream;
    fn scan(&mut self) -> Result<Inventory<Self::Device>, String>;
    fn same_device(a: &Self::Device, b: &Self::Device) -> bool;
    fn open(
        &mut self,
        device: Self::Device,
        fault: StreamFault,
    ) -> Result<Opened<Self::Stream>, String>;
}

pub struct CpalBackend;
impl Backend for CpalBackend {
    type Device = cpal::Device;
    type Stream = OutputStream;
    fn scan(&mut self) -> Result<Inventory<Self::Device>, String> {
        let host = cpal::default_host();
        let default = host
            .default_output_device()
            .and_then(|d| d.name().ok().map(|n| (n, d)));
        let devices = host
            .output_devices()
            .map_err(|e| format!("无法读取音频设备列表：{e}"))?
            .filter_map(|d| d.name().ok().map(|n| (n, d)))
            .collect();
        Ok(Inventory { devices, default })
    }
    fn same_device(a: &Self::Device, b: &Self::Device) -> bool {
        // Compare native endpoint identities, not names: a new endpoint can reuse an old label.
        #[cfg(target_os = "windows")]
        {
            let (cpal::platform::DeviceInner::Wasapi(a), cpal::platform::DeviceInner::Wasapi(b)) =
                (a.as_inner(), b.as_inner());
            a == b
        }
        #[cfg(target_os = "macos")]
        {
            let (
                cpal::platform::DeviceInner::CoreAudio(a),
                cpal::platform::DeviceInner::CoreAudio(b),
            ) = (a.as_inner(), b.as_inner());
            a == b
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            a.name().ok() == b.name().ok()
        }
    }
    fn open(
        &mut self,
        device: Self::Device,
        fault: StreamFault,
    ) -> Result<Opened<Self::Stream>, String> {
        // Fallback changes formats only within this device, never silently selects other speakers.
        let mut stream = OutputStreamBuilder::from_device(device)
            .map_err(|e| e.to_string())?
            .with_error_callback(move |error| {
                *fault.lock().unwrap() = Some(format!("音频输出连接中断：{error}"));
            })
            .open_stream_or_fallback()
            .map_err(|e| e.to_string())?;
        stream.log_on_drop(false);
        let config = *stream.config();
        Ok(Opened {
            stream,
            sample_rate: config.sample_rate(),
            channels: config.channel_count(),
            sample_format: format!("{:?}", config.sample_format()),
        })
    }
}

pub struct OutputRouter<B: Backend> {
    backend: B,
    selected: Option<String>,
    desired: Result<(String, B::Device), String>,
    bound: Option<B::Device>,
    opened: Option<Opened<B::Stream>>,
    fault: StreamFault,
    pub status: AudioOutputStatus,
}
impl<B: Backend> OutputRouter<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            selected: None,
            desired: Err("尚未检测输出设备".into()),
            bound: None,
            opened: None,
            fault: Arc::new(Mutex::new(None)),
            status: AudioOutputStatus::default(),
        }
    }
    pub fn select(&mut self, name: Option<String>) {
        self.selected = name;
        self.status.selected_device = self.selected.clone();
    }
    pub fn stream(&self) -> Option<&B::Stream> {
        self.opened.as_ref().map(|o| &o.stream)
    }

    /// Refresh inventory and report whether the transport must detach before rebuilding.
    pub fn refresh(&mut self, force: bool) -> bool {
        self.desired = match self.backend.scan() {
            Ok(inventory) => {
                self.status.system_default = inventory.default.as_ref().map(|d| d.0.clone());
                self.status.devices = inventory
                    .devices
                    .iter()
                    .map(|(name, _)| AudioDeviceInfo {
                        name: name.clone(),
                        is_default: self.status.system_default.as_ref() == Some(name),
                        selectable: inventory.devices.iter().filter(|(n, _)| n == name).count()
                            == 1,
                    })
                    .collect();
                match &self.selected {
                    None => inventory
                        .default
                        .ok_or_else(|| "未检测到系统默认输出设备，请连接耳机或音箱。".into()),
                    Some(name) => {
                        let mut matching = inventory.devices.into_iter().filter(|(n, _)| n == name);
                        match (matching.next(), matching.next()) {
                            (Some(device), None) => Ok(device),
                            (None, _) => Err(format!(
                                "首选设备“{name}”未连接。重新连接后点击播放，或选择其他输出。"
                            )),
                            _ => Err(format!(
                                "存在多个名为“{name}”的设备，请在系统中重命名后选择。"
                            )),
                        }
                    }
                }
            }
            Err(error) => {
                self.status.devices.clear();
                self.status.system_default = None;
                Err(error)
            }
        };
        let fault = self.fault.lock().unwrap().take();
        force
            || fault.is_some()
            || match &self.desired {
                Ok((_, device)) => {
                    self.bound
                        .as_ref()
                        .is_none_or(|b| !B::same_device(b, device))
                        || self.opened.is_none()
                }
                Err(error) => self.opened.is_some() || self.status.error.as_ref() != Some(error),
            }
    }
    pub fn reconnect(&mut self) -> Result<(), String> {
        self.opened = None;
        self.bound = None;
        self.status.active_device = None;
        self.status.sample_rate = None;
        self.status.channels = None;
        self.status.sample_format = None;
        self.fault = Arc::new(Mutex::new(None));
        let result = (|| {
            let (name, device) = self.desired.clone()?;
            let opened = self
                .backend
                .open(device.clone(), self.fault.clone())
                .map_err(|e| format!("无法打开“{name}”：{e}。可点击“重新连接输出”重试。"))?;
            self.status.active_device = Some(name);
            self.status.sample_rate = Some(opened.sample_rate);
            self.status.channels = Some(opened.channels);
            self.status.sample_format = Some(opened.sample_format.clone());
            self.status.generation += 1;
            self.bound = Some(device);
            self.opened = Some(opened);
            Ok(())
        })();
        self.status.error = result.as_ref().err().cloned();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct World {
        devices: Vec<(String, u32)>,
        default: Option<(String, u32)>,
        faults: Vec<StreamFault>,
        fail_open: bool,
        opened: Vec<u32>,
    }
    struct Fake(Arc<Mutex<World>>);
    impl Backend for Fake {
        type Device = u32;
        type Stream = u32;
        fn scan(&mut self) -> Result<Inventory<u32>, String> {
            let w = self.0.lock().unwrap();
            Ok(Inventory {
                devices: w.devices.clone(),
                default: w.default.clone(),
            })
        }
        fn same_device(a: &u32, b: &u32) -> bool {
            a == b
        }
        fn open(&mut self, device: u32, fault: StreamFault) -> Result<Opened<u32>, String> {
            let mut w = self.0.lock().unwrap();
            if w.fail_open {
                return Err("Device unavailable".into());
            }
            w.opened.push(device);
            w.faults.push(fault);
            Ok(Opened {
                stream: device,
                sample_rate: 48000,
                channels: 2,
                sample_format: "F32".into(),
            })
        }
    }
    fn setup() -> (Arc<Mutex<World>>, OutputRouter<Fake>) {
        let w = Arc::new(Mutex::new(World {
            devices: vec![("A".into(), 1), ("B".into(), 2)],
            default: Some(("A".into(), 1)),
            ..Default::default()
        }));
        let mut router = OutputRouter::new(Fake(w.clone()));
        assert!(router.refresh(false));
        router.reconnect().unwrap();
        (w, router)
    }
    #[test]
    fn follows_default_and_detects_endpoint_replaced_under_same_name() {
        let (w, mut r) = setup();
        assert!(!r.refresh(false));
        w.lock().unwrap().default = Some(("B".into(), 2));
        assert!(r.refresh(false));
        r.reconnect().unwrap();
        assert_eq!(r.stream(), Some(&2));
        w.lock().unwrap().default = Some(("B".into(), 3));
        assert!(r.refresh(false));
        r.reconnect().unwrap();
        assert_eq!(r.stream(), Some(&3));
    }
    #[test]
    fn pinned_device_ignores_default_change_and_never_falls_back_when_unplugged() {
        let (w, mut r) = setup();
        r.select(Some("B".into()));
        assert!(r.refresh(false));
        r.reconnect().unwrap();
        w.lock().unwrap().default = Some(("B".into(), 2));
        assert!(!r.refresh(false));
        w.lock().unwrap().devices.retain(|(_, id)| *id != 2);
        assert!(r.refresh(false));
        assert!(r.reconnect().is_err());
        assert!(r.stream().is_none());
        assert_eq!(r.status.selected_device.as_deref(), Some("B"));
        w.lock().unwrap().devices.push(("B".into(), 4));
        assert!(r.refresh(false));
        r.reconnect().unwrap();
        assert_eq!(r.stream(), Some(&4));
    }
    #[test]
    fn callback_fault_rebuilds_stream_and_stale_callback_cannot_poison_new_stream() {
        let (w, mut r) = setup();
        let old = w.lock().unwrap().faults[0].clone();
        *old.lock().unwrap() = Some("unplugged".into());
        assert!(r.refresh(false));
        r.reconnect().unwrap();
        assert_eq!(r.status.generation, 2);
        *old.lock().unwrap() = Some("late callback".into());
        assert!(!r.refresh(false));
        assert!(r.refresh(true));
        r.reconnect().unwrap();
        assert_eq!(r.status.generation, 3);
    }
    #[test]
    fn no_devices_or_failed_open_clear_active_device_and_can_recover() {
        let (w, mut r) = setup();
        w.lock().unwrap().default = None;
        assert!(r.refresh(false));
        assert!(r.reconnect().is_err());
        assert!(r.status.active_device.is_none());
        {
            let mut w = w.lock().unwrap();
            w.default = Some(("A".into(), 1));
            w.fail_open = true;
        }
        assert!(r.refresh(false));
        assert!(r.reconnect().is_err());
        w.lock().unwrap().fail_open = false;
        assert!(r.refresh(false));
        r.reconnect().unwrap();
        assert!(r.status.error.is_none());
    }
    #[test]
    fn ambiguous_saved_device_name_is_not_routed_to_arbitrary_hardware() {
        let (w, mut r) = setup();
        w.lock().unwrap().devices.push(("A".into(), 9));
        r.select(Some("A".into()));
        assert!(r.refresh(false));
        assert!(r.reconnect().is_err());
        assert!(r
            .status
            .devices
            .iter()
            .filter(|d| d.name == "A")
            .all(|d| !d.selectable));
        assert!(r.stream().is_none());
    }
}
