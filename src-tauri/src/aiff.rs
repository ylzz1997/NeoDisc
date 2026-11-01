//! Apple's cddafs exposes CD tracks as AIFF files. Parse chunks, never assume a fixed header.
use crate::device::SectorReader;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub struct AiffReader {
    file: File,
    offset: u64,
    pub frames: u32,
    little_endian: bool,
}
impl AiffReader {
    pub fn open(path: &Path) -> Result<Self, String> {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        let mut head = [0; 12];
        file.read_exact(&mut head).map_err(|e| e.to_string())?;
        let aifc = &head[8..12] == b"AIFC";
        if &head[..4] != b"FORM" || (!aifc && &head[8..12] != b"AIFF") {
            return Err("不是有效的 AIFF 音轨".into());
        }
        let mut format = None;
        let mut sound = None;
        while file.stream_position().map_err(|e| e.to_string())? + 8 <= length {
            let mut header = [0; 8];
            file.read_exact(&mut header).map_err(|e| e.to_string())?;
            let size = u32::from_be_bytes(header[4..8].try_into().unwrap()) as u64;
            let start = file.stream_position().map_err(|e| e.to_string())?;
            if start.checked_add(size).is_none_or(|end| end > length) {
                return Err("AIFF 数据被截断".into());
            }
            if &header[..4] == b"COMM" {
                if size < 18 || (aifc && size < 22) {
                    return Err("AIFF 格式块不完整".into());
                }
                let mut data = vec![0; if aifc { 22 } else { 18 }];
                file.read_exact(&mut data).map_err(|e| e.to_string())?;
                let channels = u16::from_be_bytes(data[..2].try_into().unwrap());
                let frames = u32::from_be_bytes(data[2..6].try_into().unwrap());
                let bits = u16::from_be_bytes(data[6..8].try_into().unwrap());
                let expected_rate = [0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0];
                if channels != 2 || bits != 16 || data[8..18] != expected_rate {
                    return Err("仅支持 44.1 kHz / 16-bit 立体声 CD 音轨".into());
                }
                let le = aifc && &data[18..22] == b"sowt";
                if aifc && !le && &data[18..22] != b"NONE" {
                    return Err("不支持压缩 AIFF 音轨".into());
                }
                format = Some((frames, le));
            } else if &header[..4] == b"SSND" {
                if size < 8 {
                    return Err("AIFF 音频块不完整".into());
                }
                let mut data = [0; 8];
                file.read_exact(&mut data).map_err(|e| e.to_string())?;
                let skip = u32::from_be_bytes(data[..4].try_into().unwrap()) as u64;
                if skip > size - 8 {
                    return Err("AIFF 音频偏移无效".into());
                }
                sound = Some((start + 8 + skip, size - 8 - skip));
            }
            file.seek(SeekFrom::Start(start + size + (size % 2)))
                .map_err(|e| e.to_string())?;
            if format.is_some() && sound.is_some() {
                break;
            }
        }
        let (frames, little_endian) = format.ok_or("缺少 AIFF 格式块")?;
        let (offset, bytes) = sound.ok_or("缺少 AIFF 音频块")?;
        if frames == 0 || frames as u64 * 4 > bytes || frames % 588 != 0 {
            return Err("AIFF 音轨长度不是完整 CD 扇区".into());
        }
        Ok(Self {
            file,
            offset,
            frames,
            little_endian,
        })
    }
}
impl SectorReader for AiffReader {
    fn read_sectors(&mut self, relative: u32, count: u32) -> Result<Vec<u8>, String> {
        if count == 0
            || relative
                .checked_add(count)
                .is_none_or(|n| n > self.frames / 588)
        {
            return Err("读取范围超出音轨".into());
        }
        self.file
            .seek(SeekFrom::Start(self.offset + relative as u64 * 2352))
            .map_err(|e| e.to_string())?;
        let mut data = vec![0; count as usize * 2352];
        self.file.read_exact(&mut data).map_err(|e| e.to_string())?;
        if !self.little_endian {
            for sample in data.as_chunks_mut::<2>().0 {
                sample.swap(0, 1);
            }
        }
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(little: bool) -> Vec<u8> {
        let mut bytes = Vec::from(&b"FORM\0\0\0\0"[..]);
        bytes.extend(if little { b"AIFC" } else { b"AIFF" });
        bytes.extend(b"JUNK\0\0\0\x03abc\0"); // Odd-sized chunks require padding.
        let mut comm = vec![];
        comm.extend(2u16.to_be_bytes());
        comm.extend(588u32.to_be_bytes());
        comm.extend(16u16.to_be_bytes());
        comm.extend([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
        if little {
            comm.extend(b"sowt");
        }
        bytes.extend(b"COMM");
        bytes.extend((comm.len() as u32).to_be_bytes());
        bytes.extend(comm);
        bytes.extend(b"SSND");
        bytes.extend((2352u32 + 12).to_be_bytes());
        bytes.extend(4u32.to_be_bytes());
        bytes.extend(0u32.to_be_bytes());
        bytes.extend([0, 0, 0, 0]);
        for i in 0..1176 {
            let n = (i as i16).wrapping_mul(131);
            bytes.extend(if little {
                n.to_le_bytes()
            } else {
                n.to_be_bytes()
            });
        }
        let length = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&length.to_be_bytes());
        bytes
    }
    #[test]
    fn cddafs_aiff_and_sowt_preserve_samples_and_offsets() {
        for little in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("01.aiff");
            std::fs::write(&path, fixture(little)).unwrap();
            let mut reader = AiffReader::open(&path).unwrap();
            let pcm = reader.read_sectors(0, 1).unwrap();
            let expected: Vec<u8> = (0..1176)
                .flat_map(|i| (i as i16).wrapping_mul(131).to_le_bytes())
                .collect();
            assert_eq!(pcm, expected);
            assert!(reader.read_sectors(1, 1).is_err());
        }
    }
    #[test]
    fn truncated_aiff_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.aiff");
        let mut bytes = fixture(false);
        bytes.truncate(bytes.len() - 1);
        std::fs::write(&path, bytes).unwrap();
        assert!(AiffReader::open(&path).is_err());
    }
}
