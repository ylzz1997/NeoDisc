use super::*;
use std::{
    ffi::c_void,
    fs::{File, OpenOptions},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
};

#[path = "cd_text.rs"]
mod cd_text;

const IOCTL_CDROM_READ_TOC_EX: u32 = 0x24054;
const CDROM_READ_TOC_EX_FORMAT_CDTEXT: u8 = 5;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLogicalDrives() -> u32;
    fn GetDriveTypeW(root: *const u16) -> u32;
    fn DeviceIoControl(
        handle: *mut c_void,
        code: u32,
        input: *const c_void,
        input_size: u32,
        output: *mut c_void,
        output_size: u32,
        returned: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
}

fn open(id: &str) -> Result<File, String> {
    if id.len() != 2 || !id.as_bytes()[0].is_ascii_alphabetic() || id.as_bytes()[1] != b':' {
        return Err("光驱路径无效".into());
    }
    OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(format!("\\\\.\\{id}"))
        .map_err(|e| format!("无法访问光驱 {id}：{e}。请检查是否插入音频 CD。"))
}

fn ioctl(file: &File, code: u32, input: &[u8], output: &mut [u8]) -> Result<usize, String> {
    let mut returned = 0;
    let ok = unsafe {
        DeviceIoControl(
            file.as_raw_handle(),
            code,
            if input.is_empty() {
                std::ptr::null()
            } else {
                input.as_ptr().cast()
            },
            input.len() as u32,
            if output.is_empty() {
                std::ptr::null_mut()
            } else {
                output.as_mut_ptr().cast()
            },
            output.len() as u32,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(returned as usize)
    }
}

pub fn drives() -> Result<Vec<Drive>, String> {
    let mask = unsafe { GetLogicalDrives() };
    let mut result = vec![];
    for index in 0..26 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index) as char;
        let path: Vec<u16> = format!("{letter}:\\\0").encode_utf16().collect();
        if unsafe { GetDriveTypeW(path.as_ptr()) } == 5 {
            result.push(Drive {
                id: format!("{letter}:"),
                name: format!("CD / DVD 光驱 ({letter}:)"),
            });
        }
    }
    Ok(result)
}

pub fn parse_toc(data: &[u8]) -> Result<Vec<Track>, String> {
    if data.len() < 12 {
        return Err("光盘目录不完整".into());
    }
    let (first, last) = (data[2], data[3]);
    if first == 0 || first > last || last > 99 {
        return Err("光盘目录无效".into());
    }
    let count = (last - first + 1) as usize;
    if data.len() < 4 + (count + 1) * 8 {
        return Err("光盘缺少结束位置".into());
    }
    let sector = |i: usize| -> Result<u32, String> {
        let p = 4 + i * 8;
        (data[p + 5] as u32 * 60 * 75 + data[p + 6] as u32 * 75 + data[p + 7] as u32)
            .checked_sub(150)
            .ok_or("音轨地址无效".into())
    };
    let mut tracks = vec![];
    for i in 0..count {
        let p = 4 + i * 8;
        if data[p + 1] & 4 != 0 {
            continue;
        }
        let start = sector(i)?;
        let end = sector(i + 1)?;
        let sectors = end
            .checked_sub(start)
            .filter(|n| *n > 0)
            .ok_or("音轨长度无效")?;
        tracks.push(Track {
            number: data[p + 2],
            title: format!("曲目 {:02}", data[p + 2]),
            start_sector: start,
            sectors,
            pre_emphasis: data[p + 1] & 1 != 0,
            source_path: None,
            artist: None,
        });
    }
    if tracks.is_empty() {
        return Err("这张光盘没有音频轨道，请放入 Audio CD。".into());
    }
    Ok(tracks)
}

pub fn read_disc(id: &str) -> Result<Disc, String> {
    let file = open(id)?;
    let mut disc = read_layout(id, &file)?;
    let mut data = vec![0; cd_text::BUFFER_SIZE];
    let request = [CDROM_READ_TOC_EX_FORMAT_CDTEXT, 0, 0, 0];
    if let Ok(size) = ioctl(&file, IOCTL_CDROM_READ_TOC_EX, &request, &mut data) {
        cd_text::apply(&data[..size], &mut disc);
    }
    Ok(disc)
}

pub(super) fn read_disc_layout(id: &str) -> Result<Disc, String> {
    read_layout(id, &open(id)?)
}

fn read_layout(id: &str, file: &File) -> Result<Disc, String> {
    let mut toc = [0u8; 804];
    let size = ioctl(file, 0x24000, &[], &mut toc).map_err(|e| format!("未能读取音频 CD：{e}"))?;
    let tracks = parse_toc(&toc[..size])?;
    // Only build an exact lookup for all-audio TOCs; mixed-session layouts need
    // a separate lead-out calculation and must not be guessed from durations.
    let lookup_toc = if tracks.len() == usize::from(toc[3] - toc[2] + 1) {
        tracks.last().map(|last| DiscToc {
            first_track: toc[2],
            last_track: toc[3],
            lead_out: last.start_sector + last.sectors + 150,
            offsets: tracks.iter().map(|t| t.start_sector + 150).collect(),
        })
    } else {
        None
    };
    Ok(Disc {
        drive_id: id.into(),
        title: "未命名专辑".into(),
        artist: "未知艺术家".into(),
        fingerprint: fingerprint(&tracks),
        tracks,
        lookup_toc,
        metadata_id: None,
    })
}

struct Reader {
    file: File,
    start: u32,
    length: u32,
}
impl SectorReader for Reader {
    fn read_sectors(&mut self, relative: u32, count: u32) -> Result<Vec<u8>, String> {
        if count == 0
            || count > 32
            || relative
                .checked_add(count)
                .is_none_or(|end| end > self.length)
        {
            return Err("读取范围超出音轨".into());
        }
        let mut input = [0u8; 16];
        // RAW_READ_INFO uses cooked-sector offsets even for 2352-byte CDDA reads.
        input[..8].copy_from_slice(&(((self.start + relative) as i64) * 2048).to_le_bytes());
        input[8..12].copy_from_slice(&count.to_le_bytes());
        input[12..16].copy_from_slice(&2u32.to_le_bytes()); // TRACK_MODE_TYPE::CDDA
        let mut output = vec![0u8; count as usize * 2352];
        let read = ioctl(&self.file, 0x2403e, &input, &mut output)
            .map_err(|e| format!("扇区 {} 读取失败：{e}", self.start + relative))?;
        if read != output.len() {
            return Err("光驱返回了不完整的音频数据".into());
        }
        Ok(output)
    }
}
pub fn open_track(disc: &Disc, track: &Track) -> Result<Box<dyn SectorReader>, String> {
    Ok(Box::new(Reader {
        file: open(&disc.drive_id)?,
        start: track.start_sector,
        length: track.sectors,
    }))
}
pub fn eject(id: &str) -> Result<(), String> {
    ioctl(&open(id)?, 0x2d4808, &[], &mut []).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn toc_filters_data_and_preserves_audio_boundaries() {
        let mut toc = vec![0; 36];
        toc[2] = 1;
        toc[3] = 3;
        for (i, (number, control, seconds)) in [(1, 0, 2), (2, 1, 12), (3, 4, 22), (170, 0, 32)]
            .iter()
            .enumerate()
        {
            let p = 4 + i * 8;
            toc[p + 1] = *control;
            toc[p + 2] = *number;
            toc[p + 6] = *seconds;
        }
        let tracks = parse_toc(&toc).unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].sectors, 750);
        assert!(tracks[1].pre_emphasis);
        assert_eq!(tracks[1].start_sector, 750);
        assert!(parse_toc(&toc[..20]).is_err());
    }
}
