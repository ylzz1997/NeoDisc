use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub number: u8,
    pub title: String,
    pub start_sector: u32,
    pub sectors: u32,
    pub pre_emphasis: bool,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
}
impl Track {
    pub fn duration(&self) -> f64 {
        self.sectors as f64 / 75.0
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Disc {
    pub drive_id: String,
    pub title: String,
    pub artist: String,
    pub tracks: Vec<Track>,
    pub fingerprint: String,
    #[serde(default)]
    pub lookup_toc: Option<DiscToc>,
    #[serde(default)]
    pub metadata_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscToc {
    pub first_track: u8,
    pub last_track: u8,
    pub lead_out: u32,
    pub offsets: Vec<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataTrack {
    pub number: u8,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub details: TrackMetadataDetails,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackMetadataDetails {
    pub recording_id: Option<String>,
    pub rating: Option<f64>,
    pub composer: Option<String>,
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumMetadataDetails {
    pub year: Option<String>,
    pub genre: Option<String>,
    pub disc_number: Option<u16>,
    pub disc_total: Option<u16>,
    pub label: Option<String>,
    pub copyright: Option<String>,
    pub encoded_by: Option<String>,
    pub url: Option<String>,
    pub compilation: Option<bool>,
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumMetadata {
    pub disc_id: String,
    pub release_id: String,
    #[serde(default = "musicbrainz_source")]
    pub source: String,
    pub title: String,
    pub artist: String,
    pub tracks: Vec<MetadataTrack>,
    pub cover: Option<String>,
    #[serde(default)]
    pub details: AlbumMetadataDetails,
}

fn musicbrainz_source() -> String {
    "MusicBrainz".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RipRequest {
    pub disc: Disc,
    pub tracks: Vec<u8>,
    pub format: String,
    pub output_dir: String,
    pub verify: bool,
    #[serde(default)]
    pub encoding: Option<EncodingOptions>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BitrateMode {
    Cbr,
    Abr,
    Vbr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChannelMode {
    JointStereo,
    Stereo,
    Mono,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodingOptions {
    pub sample_rate: u32,
    pub bitrate_kbps: u32,
    pub bitrate_mode: BitrateMode,
    pub vbr_quality: u8,
    pub channel_mode: ChannelMode,
    pub encoder_quality: u8,
}
impl EncodingOptions {
    pub fn for_format(format: &str) -> Self {
        Self {
            sample_rate: 44100,
            bitrate_kbps: if format == "aac" { 256 } else { 192 },
            bitrate_mode: BitrateMode::Cbr,
            vbr_quality: 2,
            channel_mode: if format == "aac" {
                ChannelMode::Stereo
            } else {
                ChannelMode::JointStereo
            },
            encoder_quality: 2,
        }
    }
    pub fn channels(&self) -> u32 {
        if self.channel_mode == ChannelMode::Mono {
            1
        } else {
            2
        }
    }
    pub fn validate(&self, format: &str) -> Result<(), String> {
        if ![16000, 22050, 24000, 32000, 44100, 48000].contains(&self.sample_rate) {
            return Err("不支持的编码采样率".into());
        }
        if self.vbr_quality > 9 || self.encoder_quality > 9 {
            return Err("MP3 质量等级必须介于 0 和 9".into());
        }
        match format {
            "mp3" => {
                let rates: &[u32] = if self.sample_rate < 32000 {
                    &[32, 48, 64, 96, 128, 160]
                } else {
                    &[64, 96, 128, 160, 192, 256, 320]
                };
                if self.bitrate_mode != BitrateMode::Vbr && !rates.contains(&self.bitrate_kbps) {
                    return Err("当前 MP3 采样率不支持此码率，请调整编码设置".into());
                }
            }
            "aac" => {
                if self.bitrate_mode != BitrateMode::Cbr
                    || self.channel_mode == ChannelMode::JointStereo
                {
                    return Err("AAC 使用目标码率模式，请选择立体声或单声道".into());
                }
                if ![32, 48, 64, 96, 128, 160, 192, 256, 320].contains(&self.bitrate_kbps)
                    || self.bitrate_kbps * 1000 > self.sample_rate * self.channels() * 6
                {
                    return Err("当前 AAC 采样率和声道数不支持此码率，请调整编码设置".into());
                }
            }
            _ => return Err("不支持的压缩格式".into()),
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RipProgress {
    pub phase: String,
    pub track: u8,
    pub completed: usize,
    pub total: usize,
    pub fraction: f64,
    pub message: String,
    pub output_dir: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub track: Option<u8>,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub volume: f32,
    pub error: Option<String>,
    pub ended: bool,
    pub output: AudioOutputStatus,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub name: String,
    pub is_default: bool,
    pub selectable: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputStatus {
    pub selected_device: Option<String>,
    pub system_default: Option<String>,
    pub active_device: Option<String>,
    pub devices: Vec<AudioDeviceInfo>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub sample_format: Option<String>,
    pub error: Option<String>,
    pub generation: u64,
}
