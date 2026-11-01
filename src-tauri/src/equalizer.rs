//! Playback-only EQ for the CD's 44.1 kHz stereo stream, before device resampling.
use rodio::Source;
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

const RATE: u32 = 44_100;
const FREQUENCIES: [f64; 10] = [
    31.25, 62.5, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];
const FADE_FRAMES: usize = RATE as usize / 50; // 20 ms, shared by both channels.

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqualizerSettings {
    pub enabled: bool,
    pub preamp_db: f32,
    pub bands: [f32; 10],
}
impl EqualizerSettings {
    fn validate(&self) -> Result<(), String> {
        if !self.preamp_db.is_finite() || !(-24.0..=12.0).contains(&self.preamp_db) {
            return Err("EQ 前级增益必须在 -24 到 +12 dB 之间".into());
        }
        if self
            .bands
            .iter()
            .any(|gain| !gain.is_finite() || !(-12.0..=12.0).contains(gain))
        {
            return Err("EQ 频段增益必须在 -12 到 +12 dB 之间".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Default)]
struct Coefficients {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}
impl Coefficients {
    fn peak(frequency: f64, gain: f32) -> Self {
        // RBJ peaking EQ, Q = sqrt(2), normalized to a0 = 1.
        // https://www.w3.org/TR/audio-eq-cookbook/#formulae
        let a = 10.0_f64.powf(gain as f64 / 40.0);
        let omega = std::f64::consts::TAU * frequency / RATE as f64;
        let alpha = omega.sin() / (2.0 * std::f64::consts::SQRT_2);
        let a0 = 1.0 + alpha / a;
        Self {
            b0: (1.0 + alpha * a) / a0,
            b1: -2.0 * omega.cos() / a0,
            b2: (1.0 - alpha * a) / a0,
            a1: -2.0 * omega.cos() / a0,
            a2: (1.0 - alpha / a) / a0,
        }
    }
}

#[derive(Clone, Copy)]
struct Prepared {
    coefficients: [Coefficients; 10],
    active: [bool; 10],
    gain: f64,
    enabled: bool,
}
impl From<EqualizerSettings> for Prepared {
    fn from(settings: EqualizerSettings) -> Self {
        Self {
            coefficients: std::array::from_fn(|i| {
                Coefficients::peak(FREQUENCIES[i], settings.bands[i])
            }),
            active: settings.bands.map(|gain| gain != 0.0),
            gain: 10.0_f64.powf(settings.preamp_db as f64 / 20.0),
            enabled: settings.enabled,
        }
    }
}

struct Shared {
    prepared: Mutex<Prepared>,
    revision: AtomicU64,
}
#[derive(Clone)]
pub(crate) struct EqualizerControl(Arc<Shared>);
impl Default for EqualizerControl {
    fn default() -> Self {
        Self(Arc::new(Shared {
            prepared: Mutex::new(EqualizerSettings::default().into()),
            revision: AtomicU64::new(0),
        }))
    }
}
impl EqualizerControl {
    pub fn set(&self, settings: EqualizerSettings) -> Result<(), String> {
        settings.validate()?;
        // Coefficients are calculated on the command thread, never in the audio callback.
        let prepared = settings.into();
        let mut target = self.0.prepared.lock().unwrap();
        *target = prepared;
        self.0.revision.fetch_add(1, Ordering::Release);
        Ok(())
    }
}

#[derive(Clone, Copy, Default)]
struct FilterState {
    z1: f64,
    z2: f64,
}
impl FilterState {
    fn process(&mut self, input: f64, c: Coefficients) -> f64 {
        let output = c.b0 * input + self.z1;
        self.z1 = c.b1 * input - c.a1 * output + self.z2;
        self.z2 = c.b2 * input - c.a2 * output;
        // Flush subnormal tails without enabling process-wide floating point modes.
        if self.z1.abs() < 1e-25 {
            self.z1 = 0.0;
        }
        if self.z2.abs() < 1e-25 {
            self.z2 = 0.0;
        }
        output
    }
}
struct Bank {
    prepared: Prepared,
    states: [[FilterState; 10]; 2],
}
impl Bank {
    fn new(prepared: Prepared) -> Self {
        Self {
            prepared,
            states: [[FilterState::default(); 10]; 2],
        }
    }
    fn process(&mut self, sample: f64, channel: usize) -> f64 {
        if !self.prepared.enabled {
            return sample;
        }
        let mut output = sample * self.prepared.gain;
        for i in 0..10 {
            if self.prepared.active[i] {
                output = self.states[channel][i].process(output, self.prepared.coefficients[i]);
            }
        }
        output
    }
}

pub(crate) struct EqualizerSource<S> {
    source: S,
    control: EqualizerControl,
    current: Bank,
    incoming: Option<Bank>,
    revision: u64,
    fade: usize,
    channel: usize,
    frames: usize,
}
impl<S: Source> EqualizerSource<S> {
    pub fn new(source: S, control: EqualizerControl) -> Self {
        // The source is CD PCM; output devices may resample it afterwards.
        assert_eq!(source.sample_rate(), RATE);
        assert_eq!(source.channels(), 2);
        // Construction runs on the player thread before appending to the sink.
        let (prepared, revision) = {
            let prepared = control.0.prepared.lock().unwrap();
            (*prepared, control.0.revision.load(Ordering::Acquire))
        };
        Self {
            source,
            control,
            current: Bank::new(prepared),
            incoming: None,
            revision,
            fade: 0,
            channel: 0,
            frames: 0,
        }
    }
    fn update(&mut self) {
        if self.incoming.is_some()
            || self.control.0.revision.load(Ordering::Acquire) == self.revision
        {
            return;
        }
        // Never wait for the UI/command thread or allocate in the audio callback.
        // While fading, further edits coalesce into the latest prepared settings.
        if let Ok(prepared) = self.control.0.prepared.try_lock() {
            self.incoming = Some(Bank::new(*prepared));
            self.revision = self.control.0.revision.load(Ordering::Acquire);
            self.fade = 0;
        }
    }
}
impl<S: Source> Iterator for EqualizerSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let sample = self.source.next()? as f64;
        if self.channel == 0 && self.frames.is_multiple_of(64) {
            self.update();
        }
        let mut output = self.current.process(sample, self.channel);
        if let Some(incoming) = &mut self.incoming {
            let next = incoming.process(sample, self.channel);
            let mix = (self.fade + 1) as f64 / FADE_FRAMES as f64;
            output += (next - output) * mix;
        }
        self.channel = (self.channel + 1) % 2;
        if self.channel == 0 {
            self.frames = self.frames.wrapping_add(1);
            if self.incoming.is_some() {
                self.fade += 1;
                if self.fade == FADE_FRAMES {
                    self.current = self.incoming.take().unwrap();
                }
            }
        }
        Some(output as f32)
    }
}
impl<S: Source> Source for EqualizerSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> u16 {
        self.source.channels()
    }
    fn sample_rate(&self) -> u32 {
        self.source.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::buffer::SamplesBuffer;

    fn tone(frequency: f64, seconds: usize) -> Vec<f32> {
        (0..RATE as usize * seconds)
            .flat_map(|n| {
                let sample = (0.05
                    * (std::f64::consts::TAU * frequency * n as f64 / RATE as f64).sin())
                    as f32;
                [sample, 0.0]
            })
            .collect()
    }
    fn render(settings: EqualizerSettings, input: Vec<f32>) -> Vec<f32> {
        let control = EqualizerControl::default();
        control.set(settings).unwrap();
        EqualizerSource::new(SamplesBuffer::new(2, RATE, input), control).collect()
    }
    fn rms(samples: &[f32]) -> f64 {
        (samples
            .iter()
            .step_by(2)
            .map(|v| (*v as f64).powi(2))
            .sum::<f64>()
            / (samples.len() / 2) as f64)
            .sqrt()
    }

    #[test]
    fn bypass_and_enabled_flat_preserve_samples_and_length_exactly() {
        let input = tone(1000.0, 1);
        let mut settings = EqualizerSettings {
            bands: [12.0; 10],
            preamp_db: 12.0,
            ..Default::default()
        };
        assert_eq!(render(settings, input.clone()), input);
        settings = EqualizerSettings {
            enabled: true,
            ..Default::default()
        };
        assert_eq!(render(settings, input.clone()), input);
    }

    #[test]
    fn each_band_boosts_and_cuts_at_its_center_without_channel_crosstalk() {
        for (index, frequency) in FREQUENCIES.iter().enumerate() {
            for gain in [-6.0, 6.0] {
                let input = tone(*frequency, 1);
                let mut settings = EqualizerSettings {
                    enabled: true,
                    ..Default::default()
                };
                settings.bands[index] = gain;
                let output = render(settings, input.clone());
                let skip = RATE as usize; // Last half second, after filter settling.
                let db = 20.0 * (rms(&output[skip..]) / rms(&input[skip..])).log10();
                assert!((db - gain as f64).abs() < 0.025, "{frequency} Hz: {db} dB");
                assert!(output.iter().skip(1).step_by(2).all(|v| *v == 0.0));
            }
        }
    }

    #[test]
    fn preamp_attenuates_and_distant_frequency_stays_unchanged() {
        let input = tone(100.0, 1);
        let mut settings = EqualizerSettings {
            enabled: true,
            preamp_db: -6.0,
            ..Default::default()
        };
        settings.bands[5] = 6.0;
        let output = render(settings, input.clone());
        let db = 20.0 * (rms(&output[RATE as usize..]) / rms(&input[RATE as usize..])).log10();
        assert!((db + 6.0).abs() < 0.05, "{db}");
    }

    #[test]
    fn live_edits_crossfade_and_new_sources_keep_the_latest_settings() {
        let control = EqualizerControl::default();
        let input = tone(1000.0, 2);
        let mut source =
            EqualizerSource::new(SamplesBuffer::new(2, RATE, input.clone()), control.clone());
        let mut output: Vec<f32> = source.by_ref().take(RATE as usize).collect();
        let mut settings = EqualizerSettings {
            enabled: true,
            ..Default::default()
        };
        settings.bands[5] = 6.0;
        control.set(settings).unwrap();
        output.extend(source.by_ref().take(RATE as usize));
        let db = 20.0 * (rms(&output[66_150..]) / rms(&input[66_150..88_200])).log10();
        assert!((db - 6.0).abs() < 0.025);
        let fresh: Vec<_> =
            EqualizerSource::new(SamplesBuffer::new(2, RATE, input.clone()), control.clone())
                .collect();
        assert_eq!(fresh, render(settings, input.clone()));
        settings.enabled = false;
        control.set(settings).unwrap();
        output.extend(source);
        assert_eq!(&output[100_000..], &input[100_000..]);
        let max_step = output
            .iter()
            .step_by(2)
            .copied()
            .collect::<Vec<_>>()
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0_f32, f32::max);
        assert!(max_step < 0.02, "Unexpected discontinuity: {max_step}");
    }

    #[test]
    fn concurrent_control_lock_never_blocks_audio_and_latest_edit_wins() {
        let control = EqualizerControl::default();
        let mut source = EqualizerSource::new(
            SamplesBuffer::new(2, RATE, tone(1000.0, 1)),
            control.clone(),
        );
        control
            .set(EqualizerSettings {
                enabled: true,
                bands: [12.0; 10],
                preamp_db: -24.0,
            })
            .unwrap();
        let guard = control.0.prepared.lock().unwrap();
        assert!(source.by_ref().take(512).all(f32::is_finite));
        drop(guard);
        for index in 0..50 {
            control
                .set(EqualizerSettings {
                    enabled: index % 2 == 0,
                    bands: [if index % 3 == 0 { 12.0 } else { -12.0 }; 10],
                    preamp_db: -12.0,
                })
                .unwrap();
            assert!(source
                .by_ref()
                .take(256)
                .all(|v| v.is_finite() && v.abs() < 2.0));
        }
        control.set(EqualizerSettings::default()).unwrap();
        let output: Vec<_> = source.by_ref().take(8000).collect();
        let input = tone(1000.0, 1);
        assert_eq!(
            &output[4000..],
            &input[512 + 50 * 256 + 4000..512 + 50 * 256 + 8000]
        );
    }

    #[test]
    fn rejects_malformed_settings_without_replacing_valid_configuration() {
        let control = EqualizerControl::default();
        for gain in [f32::NAN, f32::INFINITY, -12.1, 12.1] {
            assert!(control
                .set(EqualizerSettings {
                    bands: [gain; 10],
                    ..Default::default()
                })
                .is_err());
        }
        for gain in [f32::NAN, f32::NEG_INFINITY, -24.1, 12.1] {
            assert!(control
                .set(EqualizerSettings {
                    preamp_db: gain,
                    ..Default::default()
                })
                .is_err());
        }
        assert_eq!(control.0.revision.load(Ordering::Acquire), 0);
        assert!(serde_json::from_str::<EqualizerSettings>(
            r#"{"enabled":true,"preampDb":0,"bands":[1,2]}"#
        )
        .is_err());
    }
}
