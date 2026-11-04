use crate::models::Disc;

const PACK_SIZE: usize = 18;
pub(super) const BUFFER_SIZE: usize = 4 + 8 * 256 * PACK_SIZE + 2;
type Pack = [u8; PACK_SIZE];
type Names = [Option<String>; 100];

#[link(name = "kernel32")]
unsafe extern "system" {
    fn MultiByteToWideChar(
        code_page: u32,
        flags: u32,
        input: *const u8,
        input_size: i32,
        output: *mut u16,
        output_size: i32,
    ) -> i32;
}

fn checksum(bytes: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &byte in bytes {
        crc ^= u16::from(byte) << 8;
        for _ in 0..8 {
            crc = (crc << 1) ^ if crc & 0x8000 != 0 { 0x1021 } else { 0 };
        }
    }
    !crc
}

fn decode(bytes: &[u8], encoding: u8) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let value: String = match encoding {
        0 => bytes.iter().copied().map(char::from).collect(),
        1 if bytes.is_ascii() => std::str::from_utf8(bytes).ok()?.into(),
        0x80 => {
            // Windows code page 932 is Microsoft Shift-JIS.
            let size = i32::try_from(bytes.len()).ok()?;
            let mut wide = vec![0; bytes.len()];
            let count = unsafe {
                MultiByteToWideChar(932, 8, bytes.as_ptr(), size, wide.as_mut_ptr(), size)
            };
            (count > 0).then_some(())?;
            String::from_utf16(&wide[..count as usize]).ok()?
        }
        _ => return None,
    };
    let value = value.trim();
    (!value.is_empty() && !value.chars().any(char::is_control)).then(|| value.to_owned())
}

fn read_field(packs: &[&Pack], kind: u8, first: usize, last: usize, encoding: Option<u8>) -> Names {
    let mut names: Names = std::array::from_fn(|_| None);
    let mut text = Vec::new();
    let mut number = 0;
    let mut previous_seq = None;
    for pack in packs.iter().filter(|pack| pack[0] == kind) {
        let track = usize::from(pack[1]);
        let position = pack[3] & 15;
        // Continuation bytes are usable only if we read the preceding pack.
        let mut complete = position == 0
            || (track == number && !text.is_empty() && previous_seq == pack[2].checked_sub(1));
        if position == 0 || !complete {
            text.clear();
        }
        number = track;
        previous_seq = Some(pack[2]);
        let width = if pack[3] & 0x80 != 0 { 2 } else { 1 };
        let encoding = encoding.unwrap_or(if width == 2 { 0x80 } else { 0 });
        for character in pack[4..16].chunks_exact(width) {
            if number > last {
                break;
            }
            if character.iter().any(|&byte| byte != 0) {
                text.extend_from_slice(character);
                continue;
            }
            if complete {
                names[number] = if text == [9] || text == [9, 9] {
                    let previous = if number <= first { 0 } else { number - 1 };
                    names[previous].clone()
                } else {
                    decode(&text, encoding)
                };
            }
            text.clear();
            complete = true;
            number = if number == 0 { first } else { number + 1 };
        }
    }
    names
}

pub(super) fn apply(data: &[u8], disc: &mut Disc) {
    let (Some(first), Some(last)) = (disc.tracks.first(), disc.tracks.last()) else {
        return;
    };
    let (first, last) = (usize::from(first.number), usize::from(last.number));
    if first == 0
        || last > 99
        || first > last
        || disc
            .tracks
            .iter()
            .any(|track| !(first..=last).contains(&usize::from(track.number)))
        || data.len() < 4
    {
        return;
    }
    // The reported length excludes its own two bytes. Drives may pad the transfer.
    let end = 2 + usize::from(u16::from_be_bytes([data[0], data[1]]));
    let Some(body) = data.get(4..end) else {
        return;
    };
    let mut blocks: [Vec<&Pack>; 8] = std::array::from_fn(|_| Vec::new());
    for pack in body.as_chunks::<PACK_SIZE>().0 {
        if pack[1] < 100 && checksum(&pack[..16]).to_be_bytes() == pack[16..] {
            blocks[usize::from((pack[3] >> 4) & 7)].push(pack);
        }
    }
    for mut packs in blocks.into_iter().filter(|packs| !packs.is_empty()) {
        packs.sort_unstable_by_key(|pack| pack[2]);
        packs.dedup_by_key(|pack| pack[2]);
        let size_pack = packs.iter().find(|pack| pack[0] == 0x8f && pack[1] == 0);
        let encoding = size_pack.map(|pack| pack[4]);
        let first = size_pack
            .map(|pack| usize::from(pack[5]))
            .filter(|number| (1..=first).contains(number))
            .unwrap_or(first);
        let mut titles = read_field(&packs, 0x80, first, last, encoding);
        let mut artists = read_field(&packs, 0x81, first, last, encoding);
        // Some discs record only track numbers where the names would go.
        if titles[0].is_none()
            && artists.iter().all(Option::is_none)
            && disc.tracks.iter().all(|track| {
                titles[usize::from(track.number)]
                    .as_deref()
                    .is_none_or(|title| title.parse() == Ok(track.number))
            })
        {
            continue;
        }
        if let Some(title) = titles[0].take() {
            disc.title = title;
        }
        if let Some(artist) = artists[0].take() {
            disc.artist = artist;
        }
        for track in &mut disc.tracks {
            let number = usize::from(track.number);
            if let Some(title) = titles[number].take() {
                track.title = title;
            }
            if let Some(artist) = artists[number].take() {
                track.artist = Some(artist);
            }
        }
        break;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Track;

    fn disc() -> Disc {
        Disc {
            drive_id: "E:".into(),
            title: "未命名专辑".into(),
            artist: "未知艺术家".into(),
            tracks: (1..=2)
                .map(|number| Track {
                    number,
                    title: format!("曲目 {number:02}"),
                    start_sector: u32::from(number - 1) * 750,
                    sectors: 750,
                    pre_emphasis: false,
                    source_path: None,
                    artist: None,
                })
                .collect(),
            fingerprint: "fixture".into(),
            lookup_toc: None,
            metadata_id: None,
        }
    }

    fn response(packs: &[([u8; 4], &[u8])]) -> Vec<u8> {
        let length = 2 + PACK_SIZE * packs.len();
        let mut data = vec![0; length + 2];
        data[..2].copy_from_slice(&(length as u16).to_be_bytes());
        for (pack, (header, payload)) in data[4..]
            .as_chunks_mut::<PACK_SIZE>()
            .0
            .iter_mut()
            .zip(packs)
        {
            assert!(payload.len() <= 12);
            pack[..4].copy_from_slice(header);
            pack[4..4 + payload.len()].copy_from_slice(payload);
            let crc = checksum(&pack[..16]);
            pack[16..].copy_from_slice(&crc.to_be_bytes());
        }
        data
    }

    #[test]
    fn names_span_packs_and_tab_repeats_the_previous_performer() {
        let mut disc = disc();
        let data = response(&[
            ([0x80, 0, 0, 0], b"Caf\xe9\0Long ti"),
            ([0x80, 1, 1, 7], b"tle\0Second\0"),
            ([0x81, 0, 2, 0], b"Band\0\t\0Guest"),
            ([0x81, 2, 3, 5], b"\0"),
        ]);
        apply(&data, &mut disc);
        assert_eq!(disc.title, "Café");
        assert_eq!(disc.artist, "Band");
        assert_eq!(disc.tracks[0].title, "Long title");
        assert_eq!(disc.tracks[0].artist.as_deref(), Some("Band"));
        assert_eq!(disc.tracks[1].title, "Second");
        assert_eq!(disc.tracks[1].artist.as_deref(), Some("Guest"));
        assert_eq!(disc.tracks[1].start_sector, 750);
    }

    #[test]
    fn ignores_numbered_placeholders_and_uses_the_next_language_block() {
        let mut disc = disc();
        let data = response(&[([0x80, 0, 0, 0], b"\x0001\x0002\0")]);
        apply(&data, &mut disc);
        assert_eq!(disc.tracks[0].title, "曲目 01");

        let mut data = response(&[
            ([0x80, 0, 0, 0], b"\x0001\x0002\0"),
            ([0x80, 0, 0, 0x90], b"\x93\xfa\x96\x7b\0\0\x89\xb9\0\0"),
            ([0x8f, 0, 1, 0x10], &[0x80, 1, 2]),
        ]);
        data.extend_from_slice(&[0, 0]); // Padding returned by some Windows drives.
        apply(&data, &mut disc);
        assert_eq!(disc.title, "日本");
        assert_eq!(disc.tracks[0].title, "音");
        assert_eq!(disc.tracks[1].title, "曲目 02");
    }

    #[test]
    fn damaged_or_truncated_packs_leave_the_disc_usable() {
        let mut disc = disc();
        let mut data = response(&[([0x80, 0, 0, 0], b"Bad\0")]);
        apply(&data[..data.len() - 1], &mut disc);
        assert_eq!(disc.title, "未命名专辑");
        data[4 + 16] ^= 1;
        apply(&data, &mut disc);
        assert_eq!(disc.title, "未命名专辑");
        assert_eq!(disc.tracks.len(), 2);
    }
}
