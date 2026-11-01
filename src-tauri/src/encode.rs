use flacenc::{
    bitsink::ByteSink,
    component::{BitRepr, StreamInfo},
    error::{Verified, Verify},
    source::{Fill, FrameBuf},
};
use md5::{Digest, Md5};
use std::{
    fs::File,
    io::{Seek, SeekFrom, Write},
};

const BLOCK: usize = 4116; // Seven complete CD sectors; even the final block is >= 588 samples.
pub enum AudioWriter {
    Wav(hound::WavWriter<File>),
    Flac(Box<FlacWriter>),
    Pcm(File),
}
impl AudioWriter {
    pub fn new(file: File, format: &str, tags: &[(&str, String)]) -> Result<Self, String> {
        Self::with_cover(file, format, tags, None)
    }
    pub fn with_cover(
        file: File,
        format: &str,
        tags: &[(&str, String)],
        cover: Option<&crate::metadata::CoverImage>,
    ) -> Result<Self, String> {
        match format {
            "wav" => Ok(Self::Wav(
                hound::WavWriter::new(
                    file,
                    hound::WavSpec {
                        channels: 2,
                        sample_rate: 44100,
                        bits_per_sample: 16,
                        sample_format: hound::SampleFormat::Int,
                    },
                )
                .map_err(|e| e.to_string())?,
            )),
            "flac" => Ok(Self::Flac(Box::new(FlacWriter::new(file, tags, cover)?))),
            _ => Err("请选择 FLAC 或 WAV 格式".into()),
        }
    }
    pub fn write(&mut self, pcm: &[u8]) -> Result<(), String> {
        if !pcm.len().is_multiple_of(4) {
            return Err("音频样本不完整".into());
        }
        match self {
            Self::Pcm(file) => file.write_all(pcm).map_err(|e| e.to_string()),
            Self::Wav(w) => {
                for p in pcm.as_chunks::<2>().0 {
                    w.write_sample(i16::from_le_bytes([p[0], p[1]]))
                        .map_err(|e| e.to_string())?;
                }
                Ok(())
            }
            Self::Flac(w) => w.write(pcm),
        }
    }
    pub fn finish(self) -> Result<(), String> {
        match self {
            Self::Pcm(file) => file.sync_all().map_err(|e| e.to_string()),
            Self::Wav(w) => w.finalize().map_err(|e| e.to_string()),
            Self::Flac(w) => w.finish(),
        }
    }
}

pub struct FlacWriter {
    file: File,
    config: Verified<flacenc::config::Encoder>,
    info: StreamInfo,
    pending: Vec<i32>,
    index: usize,
    md5: Md5,
}
impl FlacWriter {
    fn new(
        mut file: File,
        tags: &[(&str, String)],
        cover: Option<&crate::metadata::CoverImage>,
    ) -> Result<Self, String> {
        let config = flacenc::config::Encoder::default()
            .into_verified()
            .map_err(|e| format!("{e:?}"))?;
        let mut info = StreamInfo::new(44100, 2, 16).map_err(|e| e.to_string())?;
        info.set_block_sizes(BLOCK, BLOCK)
            .map_err(|e| e.to_string())?;
        info.set_frame_sizes(0, 0).map_err(|e| e.to_string())?;
        file.write_all(b"fLaC\0\0\0\x22")
            .map_err(|e| e.to_string())?;
        let mut sink = ByteSink::new();
        info.write(&mut sink).map_err(|e| format!("{e:?}"))?;
        file.write_all(sink.as_slice()).map_err(|e| e.to_string())?;
        let vendor = concat!("NeoDisc ", env!("CARGO_PKG_VERSION"), " / flacenc").as_bytes();
        let mut comment = vec![];
        comment.extend((vendor.len() as u32).to_le_bytes());
        comment.extend(vendor);
        comment.extend((tags.len() as u32).to_le_bytes());
        for (key, value) in tags {
            let text = format!("{key}={value}");
            comment.extend((text.len() as u32).to_le_bytes());
            comment.extend(text.as_bytes());
        }
        if comment.len() > 0xffffff {
            return Err("标签太长".into());
        }
        let len = (comment.len() as u32).to_be_bytes();
        file.write_all(&[
            if cover.is_some() { 0x04 } else { 0x84 },
            len[1],
            len[2],
            len[3],
        ])
        .map_err(|e| e.to_string())?;
        file.write_all(&comment).map_err(|e| e.to_string())?;
        if let Some(cover) = cover {
            let block = cover.flac_block();
            if block.len() > 0xffffff {
                return Err("封面太大".into());
            }
            let len = (block.len() as u32).to_be_bytes();
            file.write_all(&[0x86, len[1], len[2], len[3]])
                .map_err(|e| e.to_string())?;
            file.write_all(&block).map_err(|e| e.to_string())?;
        }
        Ok(Self {
            file,
            config,
            info,
            pending: Vec::with_capacity(BLOCK * 2),
            index: 0,
            md5: Md5::new(),
        })
    }
    fn write(&mut self, pcm: &[u8]) -> Result<(), String> {
        self.md5.update(pcm);
        for pair in pcm.as_chunks::<2>().0 {
            self.pending
                .push(i16::from_le_bytes([pair[0], pair[1]]) as i32);
            if self.pending.len() == BLOCK * 2 {
                self.flush_frame()?;
            }
        }
        Ok(())
    }
    fn flush_frame(&mut self) -> Result<(), String> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let mut buf = FrameBuf::with_size(2, BLOCK).map_err(|e| e.to_string())?;
        buf.fill_interleaved(&self.pending)
            .map_err(|e| e.to_string())?;
        let frame = flacenc::encode_fixed_size_frame(&self.config, &buf, self.index, &self.info)
            .map_err(|e| e.to_string())?;
        self.info.update_frame_info(&frame);
        let mut sink = ByteSink::new();
        frame.write(&mut sink).map_err(|e| format!("{e:?}"))?;
        self.file
            .write_all(sink.as_slice())
            .map_err(|e| e.to_string())?;
        self.index += 1;
        self.pending.clear();
        Ok(())
    }
    fn finish(mut self) -> Result<(), String> {
        self.flush_frame()?;
        self.info.set_md5_digest(&self.md5.finalize().into());
        let mut sink = ByteSink::new();
        self.info.write(&mut sink).map_err(|e| format!("{e:?}"))?;
        self.file
            .seek(SeekFrom::Start(8))
            .map_err(|e| e.to_string())?;
        self.file
            .write_all(sink.as_slice())
            .map_err(|e| e.to_string())?;
        self.file.sync_all().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_front_cover_keeps_audio_bit_exact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cover.flac");
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 3)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let cover = crate::metadata::CoverImage {
            data: bytes.into_inner(),
            mime: "image/png",
            width: 2,
            height: 3,
            depth: 24,
        };
        let pcm: Vec<u8> = (0..2352).map(|n| (n % 256) as u8).collect();
        let mut writer = AudioWriter::with_cover(
            File::create(&path).unwrap(),
            "flac",
            &[("TITLE", "测试封面".into())],
            Some(&cover),
        )
        .unwrap();
        writer.write(&pcm).unwrap();
        writer.finish().unwrap();
        let mut reader = claxon::FlacReader::open(&path).unwrap();
        assert_eq!(reader.get_tag("TITLE").next(), Some("测试封面"));
        let decoded: Vec<u8> = reader
            .samples()
            .map(Result::unwrap)
            .flat_map(|n| (n as i16).to_le_bytes())
            .collect();
        assert_eq!(decoded, pcm);
        let file = std::fs::read(&path).unwrap();
        let mut cursor = 4;
        let mut picture = None;
        loop {
            let kind = file[cursor];
            let len = u32::from_be_bytes([0, file[cursor + 1], file[cursor + 2], file[cursor + 3]])
                as usize;
            let block = &file[cursor + 4..cursor + 4 + len];
            if kind & 0x7f == 6 {
                picture = Some(block.to_vec());
            }
            cursor += 4 + len;
            if kind & 0x80 != 0 {
                break;
            }
        }
        let picture = picture.unwrap();
        assert_eq!(u32::from_be_bytes(picture[..4].try_into().unwrap()), 3);
        assert_eq!(&picture[8..17], b"image/png");
        assert_eq!(u32::from_be_bytes(picture[21..25].try_into().unwrap()), 2);
        assert_eq!(u32::from_be_bytes(picture[25..29].try_into().unwrap()), 3);
        assert_eq!(&picture[41..], &cover.data);
    }
    #[test]
    fn flac_roundtrip_is_bit_exact_with_tags_and_short_last_frame() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("check.flac");
        let pcm: Vec<i16> = (0..588 * 2 * 17)
            .map(|i| (((i * 7919) % 65536) - 32768) as i16)
            .collect();
        let bytes: Vec<u8> = pcm.iter().flat_map(|n| n.to_le_bytes()).collect();
        let mut writer = AudioWriter::new(
            File::create(&path).unwrap(),
            "flac",
            &[("TITLE", "测试音轨".into())],
        )
        .unwrap();
        for chunk in bytes.chunks(2352 * 5) {
            writer.write(chunk).unwrap();
        }
        writer.finish().unwrap();
        let mut reader = claxon::FlacReader::open(&path).unwrap();
        assert_eq!(reader.streaminfo().samples, Some((pcm.len() / 2) as u64));
        assert_eq!(
            reader.streaminfo().md5sum,
            <[u8; 16]>::from(Md5::digest(&bytes))
        );
        assert_eq!(reader.get_tag("TITLE").next(), Some("测试音轨"));
        let decoded: Vec<i32> = reader.samples().map(Result::unwrap).collect();
        assert_eq!(decoded, pcm.iter().map(|n| *n as i32).collect::<Vec<_>>());
    }
    #[test]
    fn wav_keeps_stereo_sample_order_and_exact_length() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("check.wav");
        let pcm = [i16::MIN, i16::MAX, 0, -1, 1234, -1234];
        let mut writer = AudioWriter::new(File::create(&path).unwrap(), "wav", &[]).unwrap();
        writer
            .write(&pcm.iter().flat_map(|n| n.to_le_bytes()).collect::<Vec<_>>())
            .unwrap();
        writer.finish().unwrap();
        let mut reader = hound::WavReader::open(path).unwrap();
        assert_eq!(reader.spec().sample_rate, 44100);
        assert_eq!(
            reader
                .samples::<i16>()
                .map(Result::unwrap)
                .collect::<Vec<_>>(),
            pcm
        );
    }
}
