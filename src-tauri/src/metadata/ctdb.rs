//! CUETools DB's public TOC lookup, using only exact MusicBrainz/FreeDB records.
//! Protocol and field definitions:
//! https://github.com/gchudov/db.cue.tools/blob/master/utils/docker/ctdbweb/db.cue.tools/lookup2.php
use super::{
    core_tracks_match, download, text, uuid, CoverImage, LookupControl, MAX_COVER, MAX_JSON,
};
use crate::models::{AlbumMetadata, AlbumMetadataDetails, DiscToc, MetadataTrack};
use quick_xml::{events::Event, Reader};
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Response {
    #[serde(default, rename = "metadata")]
    entries: Vec<Entry>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Entry {
    #[serde(rename = "@source")]
    source: String,
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "@artist")]
    artist: String,
    #[serde(rename = "@album")]
    album: String,
    #[serde(rename = "@year")]
    year: String,
    #[serde(rename = "@genre")]
    genre: String,
    #[serde(rename = "@discnumber")]
    disc_number: String,
    #[serde(rename = "@disccount")]
    disc_count: String,
    #[serde(rename = "@relevance")]
    relevance: Option<u32>,
    #[serde(rename = "track")]
    tracks: Vec<Track>,
    #[serde(rename = "label")]
    labels: Vec<Label>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Track {
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@artist")]
    artist: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Label {
    #[serde(rename = "@name")]
    name: String,
}

fn clean(value: &str) -> Option<String> {
    text(&Value::String(value.into()))
}

fn lookup_url(toc: &DiscToc) -> Option<String> {
    toc.disc_id()?;
    // A leading data track is not represented in our audio-only DiscToc.
    // Do not invent its geometry for CTDB; MusicBrainz handles this case.
    if toc.first_track != 1 {
        return None;
    }
    let offsets = toc
        .offsets
        .iter()
        .chain([&toc.lead_out])
        .map(|offset| (offset - 150).to_string())
        .collect::<Vec<_>>()
        .join(":");
    // `fuzzy=0` controls audio verification, NOT metadata matching. Disable
    // each metadata fuzzy source explicitly as well. No audio is submitted.
    Some(format!("https://db.cue.tools/lookup2.php?version=3&ctdb=0&fuzzy=0&metadata=fast&musicbrainz=1&musicbrainzfuzzy=0&musicbrainzraw=0&freedb=2&freedbfuzzy=0&discogs=0&discogsfuzzy=0&toc={offsets}"))
}

pub(super) fn fetch(
    client: &Client,
    id: &str,
    toc: &DiscToc,
    control: &LookupControl<'_>,
) -> Result<Option<AlbumMetadata>, String> {
    let Some(url) = lookup_url(toc) else {
        return Ok(None);
    };
    let Some(bytes) = download(client, &url, MAX_JSON, control)? else {
        return Ok(None);
    };
    let mut album = select(&bytes, id, toc)?;
    if let Some(matched) = &mut album {
        // Only use a known cover endpoint. Arbitrary image URLs from XML are
        // never fetched. FreeDB records still provide useful album/track text.
        if uuid(&matched.release_id) {
            let url = format!(
                "https://coverartarchive.org/release/{}/front-500",
                matched.release_id
            );
            matched.cover = download(client, &url, MAX_COVER, control)
                .ok()
                .flatten()
                .and_then(CoverImage::parse)
                .map(|cover| cover.data_url());
        }
    }
    Ok(album)
}

fn select(bytes: &[u8], id: &str, toc: &DiscToc) -> Result<Option<AlbumMetadata>, String> {
    if bytes.len() as u64 > MAX_JSON {
        return Err("Metadata response too large".into());
    }
    let mut reader = Reader::from_reader(bytes);
    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Decl(_) | Event::Comment(_) => {}
            Event::Text(text) if text.as_ref().chars().all(|c| c.is_ascii_whitespace()) => {}
            Event::Start(root) | Event::Empty(root) if root.name().as_ref() == "ctdb" => break,
            _ => return Err("Invalid CUETools DB response".into()),
        }
    }
    let response: Response =
        quick_xml::de::from_reader(bytes).map_err(|error| error.to_string())?;
    let mut candidates: Vec<_> = response
        .entries
        .into_iter()
        .filter_map(|entry| candidate(entry, id, toc))
        .collect();
    let Some(first) = candidates.first() else {
        return Ok(None);
    };
    if candidates.iter().any(|other| {
        other.title != first.title
            || other.artist != first.artist
            || !core_tracks_match(&other.tracks, &first.tracks)
    }) {
        return Ok(None);
    }
    candidates.sort_by(|left, right| left.release_id.cmp(&right.release_id));
    Ok(candidates.into_iter().next())
}

fn candidate(entry: Entry, id: &str, toc: &DiscToc) -> Option<AlbumMetadata> {
    if entry.tracks.len() != toc.offsets.len() || entry.relevance.is_some_and(|n| n != 100) {
        return None;
    }
    let (source, release_id) = match entry.source.as_str() {
        "musicbrainz" if uuid(&entry.id) => ("CUETools DB · MusicBrainz", entry.id),
        "freedb"
            if !entry.id.is_empty()
                && entry.id.len() <= 128
                && entry
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/-_".contains(&b)) =>
        {
            ("CUETools DB · FreeDB", format!("ctdb:freedb:{}", entry.id))
        }
        _ => return None,
    };
    let title = clean(&entry.album)?;
    let artist = clean(&entry.artist)?;
    let tracks: Option<Vec<_>> = entry
        .tracks
        .into_iter()
        .enumerate()
        .map(|(index, track)| {
            Some(MetadataTrack {
                number: toc.first_track + index as u8,
                title: clean(&track.name)?,
                artist: clean(&track.artist).unwrap_or_else(|| artist.clone()),
                details: Default::default(),
            })
        })
        .collect();
    let positive = |number: &str| number.parse::<u16>().ok().filter(|number| *number > 0);
    Some(AlbumMetadata {
        disc_id: id.into(),
        release_id,
        source: source.into(),
        title,
        artist,
        tracks: tracks?,
        cover: None,
        details: AlbumMetadataDetails {
            year: (entry.year.len() == 4
                && entry.year.bytes().all(|b| b.is_ascii_digit())
                && entry.year != "0000")
                .then_some(entry.year),
            genre: clean(&entry.genre),
            disc_number: positive(&entry.disc_number),
            disc_total: positive(&entry.disc_count),
            label: super::joined(
                entry
                    .labels
                    .into_iter()
                    .filter_map(|label| clean(&label.name)),
            ),
            ..Default::default()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires internet; queries CUETools DB and Cover Art Archive"]
    fn live_reference_lookup() {
        // Published MusicBrainz TOC example, not a user-specific album mapping.
        let toc = DiscToc {
            first_track: 1,
            last_track: 6,
            lead_out: 95462,
            offsets: vec![150, 15363, 32314, 46592, 63414, 80489],
        };
        let generation = std::sync::atomic::AtomicU64::new(0);
        let control = LookupControl {
            generation: &generation,
            started: 0,
        };
        let album = fetch(
            &super::super::client().unwrap(),
            &toc.disc_id().unwrap(),
            &toc,
            &control,
        )
        .unwrap()
        .unwrap();
        println!(
            "{}: {} / {} ({} tracks)",
            album.source,
            album.artist,
            album.title,
            album.tracks.len()
        );
        assert_eq!(album.tracks.len(), 6);
        assert_eq!(album.source, "CUETools DB · MusicBrainz");
    }
    fn toc() -> DiscToc {
        DiscToc {
            first_track: 1,
            last_track: 2,
            lead_out: 30150,
            offsets: vec![150, 15150],
        }
    }
    fn entry() -> &'static str {
        r#"<metadata source="freedb" id="rock/12345678" album="测试 &amp; Album" artist="音乐人" year="2020" genre="Rock"><track name="第一首"/><track name="Second" artist="Guest"/></metadata>"#
    }
    fn parse(entries: &str) -> Option<AlbumMetadata> {
        let xml = format!(
            r#"<?xml version="1.0"?><ctdb xmlns="http://db.cuetools.net/ns/mmd-1.0#">{entries}</ctdb>"#
        );
        select(xml.as_bytes(), "disc-id", &toc()).unwrap()
    }
    #[test]
    fn exact_toc_query_preserves_pregap_and_disables_all_fuzzy_sources() {
        let url = lookup_url(&toc()).unwrap();
        assert!(url.ends_with("&toc=0:15000:30000"));
        for source in ["musicbrainzfuzzy", "freedbfuzzy", "discogsfuzzy"] {
            assert!(url.contains(&format!("&{source}=0")));
        }
        let mut pregap = toc();
        pregap.offsets[0] = 225;
        assert!(lookup_url(&pregap)
            .unwrap()
            .ends_with("&toc=75:15000:30000"));
        let mut mixed = toc();
        mixed.first_track = 2;
        mixed.last_track = 3;
        assert!(lookup_url(&mixed).is_none());
    }
    #[test]
    fn decodes_chinese_and_entities_and_maps_track_artists() {
        let album = parse(entry()).unwrap();
        assert_eq!(album.title, "测试 & Album");
        assert_eq!(album.source, "CUETools DB · FreeDB");
        assert_eq!(album.release_id, "ctdb:freedb:rock/12345678");
        assert_eq!(album.tracks[0].artist, "音乐人");
        assert_eq!(album.tracks[1].artist, "Guest");
        assert_eq!(album.details.year.as_deref(), Some("2020"));
        assert_eq!(album.tracks[1].number, 2);
        assert!(album.cover.is_none());
    }
    #[test]
    fn rejects_incomplete_fuzzy_unknown_and_conflicting_results() {
        assert!(parse("").is_none());
        assert!(parse(&entry().replace("<track name=\"第一首\"/>", "")).is_none());
        assert!(parse(&entry().replace("source=", "relevance=\"99\" source=")).is_none());
        assert!(parse(&entry().replace("freedb", "discogs")).is_none());
        assert!(parse(&format!("{}{}", entry(), entry())).is_some());
        assert!(parse(&format!(
            "{}{}",
            entry(),
            entry().replace("Second", "Different")
        ))
        .is_none());
        assert!(parse(&entry().replace("第一首", "")).is_none());
        assert!(select(b"<html>Server unavailable</html>", "id", &toc()).is_err());
        assert!(select(b"<ctdb><metadata", "id", &toc()).is_err());
    }
}
