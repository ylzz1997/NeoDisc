//! Optional TOC-based lookup. Only unambiguous matches; failures never block the CD engine.
mod ctdb;
use crate::models::{
    AlbumMetadata, AlbumMetadataDetails, Disc, DiscToc, MetadataTrack, TrackMetadataDetails,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_JSON: u64 = 2 * 1024 * 1024;
const MAX_COVER: u64 = 2 * 1024 * 1024;
const DAY: u64 = 86400;
const CACHE_SCHEMA: u8 = 3;

impl DiscToc {
    pub fn disc_id(&self) -> Option<String> {
        if self.first_track == 0
            || self.last_track > 99
            || self.last_track < self.first_track
            || self.offsets.len() != usize::from(self.last_track - self.first_track + 1)
            || self.offsets.first().is_none_or(|n| *n < 150)
            || self.offsets.windows(2).any(|p| p[0] >= p[1])
            || self.offsets.last().is_none_or(|n| *n >= self.lead_out)
            || self.lead_out > 100 * 60 * 75
        {
            return None;
        }
        let mut input = format!(
            "{:02X}{:02X}{:08X}",
            self.first_track, self.last_track, self.lead_out
        );
        for number in 1..=99 {
            let offset = if (self.first_track..=self.last_track).contains(&number) {
                self.offsets[usize::from(number - self.first_track)]
            } else {
                0
            };
            input.push_str(&format!("{offset:08X}"));
        }
        Some(
            STANDARD
                .encode(Sha1::digest(input.as_bytes()))
                .replace('+', ".")
                .replace('/', "_")
                .replace('=', "-"),
        )
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Cached {
    #[serde(default)]
    schema: u8,
    checked_at: u64,
    value: Option<AlbumMetadata>,
}
#[derive(Default)]
struct State {
    last_request: Option<Instant>,
    recent: HashMap<String, (Instant, Option<AlbumMetadata>)>,
}
pub struct MetadataService {
    cache: PathBuf,
    state: Mutex<State>,
    generation: AtomicU64,
}

struct LookupControl<'a> {
    generation: &'a AtomicU64,
    started: u64,
}
impl LookupControl<'_> {
    fn check(&self) -> Result<(), String> {
        if self.generation.load(Ordering::SeqCst) != self.started {
            Err("Metadata lookup cancelled".into())
        } else {
            Ok(())
        }
    }
}
fn cache_root() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("NeoDisc")
        .join("metadata-v1")
}
impl Default for MetadataService {
    fn default() -> Self {
        Self {
            cache: cache_root(),
            state: Mutex::new(State::default()),
            generation: AtomicU64::new(0),
        }
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn read_cache(root: &Path, id: &str) -> Option<Cached> {
    let file = fs::File::open(root.join(format!("{id}.json"))).ok()?;
    if file.metadata().ok()?.len() > MAX_COVER * 2 {
        return None;
    }
    let cached: Cached = serde_json::from_reader(file).ok()?;
    if cached.value.as_ref().is_some_and(|v| v.disc_id != id) {
        return None;
    }
    Some(cached)
}
impl MetadataService {
    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn lookup(&self, disc: &Disc) -> Result<Option<AlbumMetadata>, String> {
        self.lookup_with_refresh(disc, false)
    }

    pub fn lookup_with_refresh(
        &self,
        disc: &Disc,
        refresh: bool,
    ) -> Result<Option<AlbumMetadata>, String> {
        self.lookup_at_generation(disc, refresh, self.generation())
    }

    pub(crate) fn lookup_at_generation(
        &self,
        disc: &Disc,
        refresh: bool,
        generation: u64,
    ) -> Result<Option<AlbumMetadata>, String> {
        self.lookup_using(disc, refresh, generation, fetch_metadata)
    }

    fn lookup_using(
        &self,
        disc: &Disc,
        refresh: bool,
        generation: u64,
        fetch: impl FnOnce(
            &str,
            &DiscToc,
            &mut Option<Instant>,
            &LookupControl<'_>,
        ) -> Result<Option<AlbumMetadata>, String>,
    ) -> Result<Option<AlbumMetadata>, String> {
        let control = LookupControl {
            generation: &self.generation,
            started: generation,
        };
        let Some(toc) = &disc.lookup_toc else {
            return Ok(None);
        };
        let Some(id) = toc.disc_id() else {
            return Ok(None);
        };
        if disc.tracks.len() != toc.offsets.len()
            || disc
                .tracks
                .iter()
                .enumerate()
                .any(|(i, t)| usize::from(t.number) != usize::from(toc.first_track) + i)
        {
            return Ok(None);
        }
        // A separate lock from playback/ripping also coalesces overlapping refreshes.
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        control.check()?;
        if let Some((time, value)) = state.recent.get(&id) {
            if !refresh && time.elapsed() < Duration::from_secs(300) {
                return Ok(value.clone());
            }
        }
        let cached = read_cache(&self.cache, &id);
        if let Some(cached) = &cached {
            let ttl = if cached.value.is_some() {
                30 * DAY
            } else {
                DAY
            };
            if !refresh
                && cached.schema == CACHE_SCHEMA
                && now().saturating_sub(cached.checked_at) < ttl
            {
                return Ok(cached.value.clone());
            }
        }
        let result = fetch(&id, toc, &mut state.last_request, &control);
        // Disabling lookup also cancels follow-up requests and cache writes.
        control.check()?;
        let fallback = cached.and_then(|c| c.value);
        // A transient failure may reuse old positive metadata, never writes a negative disk cache.
        let remembered = result
            .as_ref()
            .ok()
            .cloned()
            .unwrap_or_else(|| fallback.clone());
        if state.recent.len() >= 128 {
            state.recent.clear();
        }
        if result.is_ok() || remembered.is_some() {
            state
                .recent
                .insert(id.clone(), (Instant::now(), remembered));
        }
        match result {
            Ok(value) => {
                let record = Cached {
                    schema: CACHE_SCHEMA,
                    checked_at: now(),
                    value: value.clone(),
                };
                if let Ok(bytes) = serde_json::to_vec(&record) {
                    if fs::create_dir_all(&self.cache).is_ok() {
                        let _ = fs::write(self.cache.join(format!("{id}.json")), bytes);
                    }
                }
                Ok(value)
            }
            Err(_) if fallback.is_some() => Ok(fallback),
            Err(error) => Err(error),
        }
    }
}

fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!(
            "NeoDisc/",
            env!("CARGO_PKG_VERSION"),
            " (desktop audio CD metadata lookup)"
        ))
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .https_only(true)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}
fn download(
    client: &Client,
    url: &str,
    limit: u64,
    control: &LookupControl<'_>,
) -> Result<Option<Vec<u8>>, String> {
    control.check()?;
    let response = client.get(url).send().map_err(|e| e.to_string())?;
    control.check()?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let response = response.error_for_status().map_err(|e| e.to_string())?;
    if response.content_length().is_some_and(|n| n > limit) {
        return Err("Metadata response too large".into());
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Metadata response too large".into());
    }
    control.check()?;
    Ok(Some(bytes))
}
fn download_musicbrainz(
    client: &Client,
    url: &str,
    last_request: &mut Option<Instant>,
    control: &LookupControl<'_>,
) -> Result<Option<Vec<u8>>, String> {
    if let Some(last) = last_request {
        if let Some(delay) = Duration::from_millis(1100).checked_sub(last.elapsed()) {
            thread::sleep(delay);
        }
    }
    *last_request = Some(Instant::now());
    download(client, url, MAX_JSON, control)
}
fn fetch_metadata(
    id: &str,
    toc: &DiscToc,
    last_request: &mut Option<Instant>,
    control: &LookupControl<'_>,
) -> Result<Option<AlbumMetadata>, String> {
    let client = client()?;
    let primary = fetch_musicbrainz(&client, id, toc, last_request, control);
    control.check()?;
    provider_fallback(primary, || ctdb::fetch(&client, id, toc, control))
}

// An unavailable primary must not hide a successful secondary. A failure at
// either provider must not become a long-lived "not found" cache entry.
fn provider_fallback(
    primary: Result<Option<AlbumMetadata>, String>,
    secondary: impl FnOnce() -> Result<Option<AlbumMetadata>, String>,
) -> Result<Option<AlbumMetadata>, String> {
    match primary {
        Ok(Some(album)) => Ok(Some(album)),
        primary => match secondary() {
            Ok(Some(album)) => Ok(Some(album)),
            Ok(None) => primary,
            Err(error) => Err(error),
        },
    }
}

fn fetch_musicbrainz(
    client: &Client,
    id: &str,
    toc: &DiscToc,
    last_request: &mut Option<Instant>,
    control: &LookupControl<'_>,
) -> Result<Option<AlbumMetadata>, String> {
    let url = format!("https://musicbrainz.org/ws/2/discid/{id}?fmt=json&inc=recordings+artist-credits&cdstubs=no");
    let Some(bytes) = download_musicbrainz(client, &url, last_request, control)? else {
        return Ok(None);
    };
    let json: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let Some(mut matched) = select_release(&json, id, toc) else {
        return Ok(None);
    };
    // Enrich only the already matched release. Failure keeps the basic match intact.
    // https://musicbrainz.org/doc/MusicBrainz_API#Relationships
    let url = format!("https://musicbrainz.org/ws/2/release/{}?fmt=json&inc=recordings+artist-credits+labels+release-groups+genres+annotation+ratings+discids+media+recording-level-rels+work-rels+work-level-rels+artist-rels+url-rels", matched.release_id);
    if let Ok(Some(bytes)) = download_musicbrainz(client, &url, last_request, control) {
        if let Ok(release) = serde_json::from_slice(&bytes) {
            enrich_details(&mut matched, release, toc);
        }
    }
    // Album text remains useful when the cover archive is unavailable.
    let url = format!(
        "https://coverartarchive.org/release/{}/front-500",
        matched.release_id
    );
    matched.cover = download(client, &url, MAX_COVER, control)
        .ok()
        .flatten()
        .and_then(CoverImage::parse)
        .map(|c| c.data_url());
    Ok(Some(matched))
}
fn core_tracks_match(left: &[MetadataTrack], right: &[MetadataTrack]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(a, b)| a.number == b.number && a.title == b.title && a.artist == b.artist)
}
fn enrich_details(matched: &mut AlbumMetadata, release: Value, toc: &DiscToc) {
    if release["id"].as_str() != Some(matched.release_id.as_str()) {
        return;
    }
    let media_count = release["media"]
        .as_array()
        .and_then(|media| u16::try_from(media.len()).ok());
    let root = serde_json::json!({"id": matched.disc_id, "releases": [release]});
    if let Some(mut enriched) = select_release(&root, &matched.disc_id, toc) {
        if matched.title == enriched.title
            && matched.artist == enriched.artist
            && core_tracks_match(&matched.tracks, &enriched.tracks)
        {
            // This full release lookup includes every medium; disc-ID lookups may not.
            enriched.details.disc_total = media_count.filter(|count| {
                *count > 0
                    && enriched
                        .details
                        .disc_number
                        .is_none_or(|number| number <= *count)
            });
            matched.details = enriched.details;
            matched.tracks = enriched.tracks;
        }
    }
}
fn note(value: &Value) -> Option<String> {
    let value = value.as_str()?.trim();
    if value.is_empty()
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return None;
    }
    Some(value.chars().take(2000).collect())
}
fn joined(values: impl Iterator<Item = String>) -> Option<String> {
    let mut unique = vec![];
    for value in values.take(30) {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    if unique.is_empty() {
        None
    } else {
        Some(unique.join(" / "))
    }
}
fn genre(value: &Value) -> Option<String> {
    let mut genres: Vec<_> = value
        .as_array()?
        .iter()
        .filter(|g| g["count"].as_i64().unwrap_or(0) >= 0)
        .collect();
    genres.sort_by_key(|g| std::cmp::Reverse(g["count"].as_i64().unwrap_or(0)));
    joined(genres.into_iter().take(8).filter_map(|g| text(&g["name"])))
}
fn album_details(release: &Value, medium: &Value) -> AlbumMetadataDetails {
    let year = text(&release["date"]).and_then(|date| {
        date.get(..4)
            .filter(|year| year.bytes().all(|b| b.is_ascii_digit()) && *year != "0000")
            .map(str::to_owned)
    });
    let positive_number = |value: &Value| {
        value
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .filter(|n| *n > 0)
    };
    AlbumMetadataDetails {
        year,
        genre: genre(&release["genres"]).or_else(|| genre(&release["release-group"]["genres"])),
        disc_number: positive_number(&medium["position"]),
        disc_total: positive_number(&release["medium-count"]),
        label: joined(
            release["label-info"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|label| text(&label["label"]["name"])),
        ),
        compilation: release["release-group"]["secondary-types"]
            .as_array()
            .map(|types| {
                types
                    .iter()
                    .any(|kind| kind.as_str() == Some("Compilation"))
            }),
        url: release["relations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|relation| relation["type"].as_str() == Some("official homepage"))
            .find_map(|relation| {
                let url = relation["url"]["resource"].as_str()?;
                let parsed = reqwest::Url::parse(url).ok()?;
                (matches!(parsed.scheme(), "http" | "https")
                    && parsed.host_str().is_some()
                    && url.len() <= 2000)
                    .then(|| url.to_owned())
            }),
        comment: note(&release["annotation"]),
        // Audio CDs do not have an encoder tag. MusicBrainz does not expose a
        // copyright tag here either; neither is inferred from a label or artist.
        ..Default::default()
    }
}
fn track_details(recording: &Value) -> TrackMetadataDetails {
    let composers = recording["relations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|relation| relation["type"].as_str() == Some("performance"))
        .flat_map(|relation| {
            relation["work"]["relations"]
                .as_array()
                .into_iter()
                .flatten()
        })
        .filter(|relation| relation["type"].as_str() == Some("composer"))
        .filter_map(|relation| {
            text(&relation["target-credit"]).or_else(|| text(&relation["artist"]["name"]))
        });
    TrackMetadataDetails {
        recording_id: recording["id"]
            .as_str()
            .filter(|id| uuid(id))
            .map(str::to_owned),
        rating: recording["rating"]["value"].as_f64().filter(|value| {
            value.is_finite()
                && (0.0..=5.0).contains(value)
                && recording["rating"]["votes-count"].as_u64() != Some(0)
        }),
        composer: joined(composers),
        comment: note(&recording["annotation"]),
    }
}
fn text(value: &Value) -> Option<String> {
    let s = value.as_str()?.trim();
    if s.is_empty() || s.chars().count() > 300 || s.chars().any(char::is_control) {
        None
    } else {
        Some(s.into())
    }
}
fn credit(value: &Value) -> Option<String> {
    let mut result = String::new();
    for part in value.as_array()? {
        let name = text(&part["name"]).or_else(|| text(&part["artist"]["name"]))?;
        result.push_str(&name);
        result.push_str(part["joinphrase"].as_str().unwrap_or(""));
    }
    text(&Value::String(result))
}
fn uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn select_release(root: &Value, id: &str, toc: &DiscToc) -> Option<AlbumMetadata> {
    if root["id"].as_str()? != id {
        return None;
    }
    let mut candidates = vec![];
    for release in root["releases"].as_array()? {
        let Some(release_id) = release["id"].as_str().filter(|id| uuid(id)) else {
            continue;
        };
        let (Some(title), Some(artist)) =
            (text(&release["title"]), credit(&release["artist-credit"]))
        else {
            continue;
        };
        for medium in release["media"].as_array().into_iter().flatten() {
            if !medium["discs"]
                .as_array()
                .is_some_and(|ds| ds.iter().any(|d| d["id"].as_str() == Some(id)))
            {
                continue;
            }
            let Some(tracks) = medium["tracks"]
                .as_array()
                .filter(|ts| ts.len() == toc.offsets.len())
            else {
                continue;
            };
            let tracks: Option<Vec<_>> = tracks
                .iter()
                .enumerate()
                .map(|(i, track)| {
                    if track["position"].as_u64()? != i as u64 + 1 {
                        return None;
                    }
                    Some(MetadataTrack {
                        number: toc.first_track + i as u8,
                        title: text(&track["title"])
                            .or_else(|| text(&track["recording"]["title"]))?,
                        artist: credit(&track["artist-credit"])
                            .or_else(|| credit(&track["recording"]["artist-credit"]))
                            .unwrap_or_else(|| artist.clone()),
                        details: track_details(&track["recording"]),
                    })
                })
                .collect();
            if let Some(tracks) = tracks {
                candidates.push((
                    release["cover-art-archive"]["front"]
                        .as_bool()
                        .unwrap_or(false),
                    AlbumMetadata {
                        disc_id: id.into(),
                        release_id: release_id.into(),
                        source: "MusicBrainz".into(),
                        title: title.clone(),
                        artist: artist.clone(),
                        tracks,
                        cover: None,
                        details: album_details(release, medium),
                    },
                ));
            }
        }
    }
    let first = &candidates.first()?.1;
    // Equivalent pressings are fine; contradictory album/track text is not an automatic match.
    if candidates.iter().any(|(_, c)| {
        c.title != first.title
            || c.artist != first.artist
            || !core_tracks_match(&c.tracks, &first.tracks)
    }) {
        return None;
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.release_id.cmp(&b.1.release_id)));
    candidates.into_iter().next().map(|(_, c)| c)
}

pub struct CoverImage {
    pub data: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    pub depth: u32,
}
impl CoverImage {
    fn parse(data: Vec<u8>) -> Option<Self> {
        if data.len() as u64 > MAX_COVER {
            return None;
        }
        let mut reader = image::ImageReader::new(Cursor::new(&data))
            .with_guessed_format()
            .ok()?;
        let mime = match reader.format()? {
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::Png => "image/png",
            _ => return None,
        };
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(32 * 1024 * 1024);
        reader.limits(limits);
        let decoded = reader.decode().ok()?;
        Some(Self {
            width: decoded.width(),
            height: decoded.height(),
            depth: u32::from(decoded.color().bits_per_pixel()),
            data,
            mime,
        })
    }
    fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.mime, STANDARD.encode(&self.data))
    }
    pub fn filename(&self) -> &'static str {
        if self.mime == "image/png" {
            "cover.png"
        } else {
            "cover.jpg"
        }
    }
    pub fn flac_block(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(3u32.to_be_bytes()); // Front cover.
        out.extend((self.mime.len() as u32).to_be_bytes());
        out.extend(self.mime.as_bytes());
        for n in [
            0,
            self.width,
            self.height,
            self.depth,
            0,
            self.data.len() as u32,
        ] {
            out.extend(n.to_be_bytes());
        }
        out.extend(&self.data);
        out
    }
}
pub fn cached_cover(disc: &Disc) -> Option<CoverImage> {
    let id = disc.lookup_toc.as_ref()?.disc_id()?;
    if disc.metadata_id.as_deref() != Some(&id) {
        return None;
    }
    let cached = read_cache(&cache_root(), &id)?.value?;
    let cover = cached.cover?;
    let (_, data) = cover.split_once(";base64,")?;
    CoverImage::parse(STANDARD.decode(data).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn toc() -> DiscToc {
        DiscToc {
            first_track: 1,
            last_track: 6,
            lead_out: 95462,
            offsets: vec![150, 15363, 32314, 46592, 63414, 80489],
        }
    }
    fn disc() -> Disc {
        let toc = toc();
        Disc {
            drive_id: "test".into(),
            title: String::new(),
            artist: String::new(),
            tracks: toc
                .offsets
                .iter()
                .enumerate()
                .map(|(i, offset)| crate::models::Track {
                    number: i as u8 + 1,
                    title: String::new(),
                    start_sector: offset - 150,
                    sectors: toc.offsets.get(i + 1).copied().unwrap_or(toc.lead_out) - offset,
                    pre_emphasis: false,
                    source_path: None,
                    artist: None,
                })
                .collect(),
            fingerprint: "test".into(),
            lookup_toc: Some(toc),
            metadata_id: None,
        }
    }
    fn service(path: &Path) -> MetadataService {
        MetadataService {
            cache: path.into(),
            state: Mutex::new(State::default()),
            generation: AtomicU64::new(0),
        }
    }
    #[test]
    fn fallback_survives_primary_outage_without_hiding_partial_failures() {
        let id = toc().disc_id().unwrap();
        let album = select_release(&response(&id), &id, &toc()).unwrap();
        assert!(
            provider_fallback(Err("offline".into()), || Ok(Some(album.clone())))
                .unwrap()
                .is_some()
        );
        assert!(provider_fallback(Ok(None), || Ok(Some(album.clone())))
            .unwrap()
            .is_some());
        assert!(
            provider_fallback(Ok(Some(album)), || panic!("unnecessary fallback"))
                .unwrap()
                .is_some()
        );
        assert!(provider_fallback(Err("offline".into()), || Ok(None)).is_err());
        assert!(provider_fallback(Ok(None), || Err("offline".into())).is_err());
        assert!(provider_fallback(Ok(None), || Ok(None)).unwrap().is_none());
    }
    #[test]
    fn new_sources_and_explicit_retry_bypass_negative_caches() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        let disc = disc();
        let id = toc().disc_id().unwrap();
        fs::write(
            dir.path().join(format!("{id}.json")),
            serde_json::to_vec(&Cached {
                schema: 2,
                checked_at: now(),
                value: None,
            })
            .unwrap(),
        )
        .unwrap();
        // The old MusicBrainz-only miss cannot prevent trying new providers.
        service
            .lookup_using(&disc, false, 0, |_, _, _, _| Ok(None))
            .unwrap();
        assert_eq!(read_cache(dir.path(), &id).unwrap().schema, CACHE_SCHEMA);
        service
            .lookup_using(&disc, false, 0, |_, _, _, _| {
                panic!("negative cache should be fresh")
            })
            .unwrap();
        let album = service
            .lookup_using(&disc, true, 0, |id, toc, _, _| {
                Ok(select_release(&response(id), id, toc))
            })
            .unwrap()
            .unwrap();
        assert_eq!(album.title, "测试专辑");
        assert!(read_cache(dir.path(), &id).unwrap().value.is_some());
    }
    #[test]
    fn outages_are_not_cached_as_misses_and_old_positive_cache_works_offline() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        let disc = disc();
        let id = toc().disc_id().unwrap();
        assert!(service
            .lookup_using(&disc, false, 0, |_, _, _, _| Err("offline".into()))
            .is_err());
        assert!(service.state.lock().unwrap().recent.is_empty());
        assert!(read_cache(dir.path(), &id).is_none());
        let album = select_release(&response(&id), &id, &toc()).unwrap();
        fs::write(
            dir.path().join(format!("{id}.json")),
            serde_json::to_vec(&Cached {
                schema: 2,
                checked_at: 0,
                value: Some(album),
            })
            .unwrap(),
        )
        .unwrap();
        assert!(service
            .lookup_using(&disc, false, 0, |_, _, _, _| Err("offline".into()))
            .unwrap()
            .is_some());
    }
    #[test]
    fn cancellation_prevents_followup_requests_and_cache_writes() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        let result = service.lookup_using(&disc(), false, 0, |id, toc, _, control| {
            service.cancel();
            assert!(control.check().is_err());
            // Even a result that arrived just as the user disabled lookup is ignored.
            Ok(select_release(&response(id), id, toc))
        });
        assert!(result.is_err());
        assert!(service.state.lock().unwrap().recent.is_empty());
        assert!(read_cache(dir.path(), &toc().disc_id().unwrap()).is_none());
    }
    #[test]
    fn a_queued_lookup_cannot_start_after_the_user_turns_it_off() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        let queued_generation = service.generation();
        service.cancel();
        assert!(service
            .lookup_using(&disc(), false, queued_generation, |_, _, _, _| {
                panic!("a cancelled queued request must not contact a server")
            })
            .is_err());
        assert!(service
            .lookup_using(&disc(), false, service.generation(), |_, _, _, _| Ok(None))
            .is_ok());
    }
    #[test]
    fn official_disc_id_vector_and_invalid_tocs() {
        assert_eq!(
            toc().disc_id().as_deref(),
            Some("49HHV7Eb8UKF3aQiNmu1GR8vKTY-")
        );
        let mut t = toc();
        t.offsets[1] = 150;
        assert!(t.disc_id().is_none());
        t = toc();
        t.last_track = 99;
        assert!(t.disc_id().is_none());
        t = toc();
        t.lead_out = 150;
        assert!(t.disc_id().is_none());
    }
    fn response(id: &str) -> Value {
        json!({"id":id,"releases":[{"id":"01234567-1234-1234-1234-123456789abc","title":"测试专辑","artist-credit":[{"name":"音乐人"}],"media":[{"discs":[{"id":id}],"tracks":(1..=6).map(|n| json!({"position":n,"title":format!("作品 {n}")})).collect::<Vec<_>>()}]}]})
    }
    #[test]
    fn exact_medium_matches_and_conflicting_releases_are_skipped() {
        let id = toc().disc_id().unwrap();
        let mut v = response(&id);
        let matched = select_release(&v, &id, &toc()).unwrap();
        assert_eq!(matched.tracks.len(), 6);
        assert_eq!(matched.tracks[0].artist, "音乐人");
        let mut second = v["releases"][0].clone();
        second["id"] = json!("11234567-1234-1234-1234-123456789abc");
        v["releases"].as_array_mut().unwrap().push(second);
        assert!(select_release(&v, &id, &toc()).is_some());
        v["releases"][1]["title"] = json!("另一个专辑");
        assert!(select_release(&v, &id, &toc()).is_none());
        let mut wrong = response(&id);
        wrong["releases"][0]["media"][0]["discs"][0]["id"] = json!("wrong");
        assert!(select_release(&wrong, &id, &toc()).is_none());
        let mut partial = response(&id);
        partial["releases"][0]["media"][0]["tracks"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert!(select_release(&partial, &id, &toc()).is_none());
        assert!(select_release(&json!({"id":id,"releases":[]}), &id, &toc()).is_none());
    }
    #[test]
    fn corrupt_cache_and_non_images_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("test.json"), b"broken").unwrap();
        assert!(read_cache(dir.path(), "test").is_none());
        assert!(CoverImage::parse(b"<html>unavailable</html>".to_vec()).is_none());
    }

    #[test]
    fn release_details_preserve_source_values_and_do_not_invent_missing_tags() {
        let id = toc().disc_id().unwrap();
        let mut root = response(&id);
        let release = &mut root["releases"][0];
        release["date"] = json!("2006-04-02");
        release["genres"] = json!([{"name":"jazz","count":4},{"name":"pop","count":1},{"name":"unwanted","count":-1}]);
        release["label-info"] =
            json!([{"label":{"name":"Studio Records"}},{"label":{"name":"Studio Records"}}]);
        release["release-group"] = json!({"secondary-types":["Compilation"]});
        release["annotation"] = json!("Album note\nSecond line");
        release["relations"] = json!([{"type":"official homepage","url":{"resource":"javascript:alert(1)"}},{"type":"official homepage","url":{"resource":"https://example.com/album"}}]);
        release["media"][0]["position"] = json!(2);
        release["media"][0]["tracks"][0]["recording"] = json!({
            "id":"11234567-1234-1234-1234-123456789abc", "rating":{"value":4.5,"votes-count":10}, "annotation":"Track note",
            "relations":[{"type":"performance","work":{"relations":[
                {"type":"composer","artist":{"name":"Original name"},"target-credit":"Credited composer"},
                {"type":"composer","artist":{"name":"Credited composer"}},
                {"type":"lyricist","artist":{"name":"Not the composer"}}
            ]}}]
        });
        let matched = select_release(&root, &id, &toc()).unwrap();
        assert_eq!(matched.details.year.as_deref(), Some("2006"));
        assert_eq!(matched.details.genre.as_deref(), Some("jazz / pop"));
        assert_eq!(matched.details.label.as_deref(), Some("Studio Records"));
        assert_eq!(matched.details.disc_number, Some(2));
        assert_eq!(matched.details.disc_total, None); // A filtered disc-ID response cannot establish the total.
        assert_eq!(matched.details.compilation, Some(true));
        assert_eq!(
            matched.details.url.as_deref(),
            Some("https://example.com/album")
        );
        assert_eq!(
            matched.details.comment.as_deref(),
            Some("Album note\nSecond line")
        );
        assert!(matched.details.copyright.is_none());
        assert!(matched.details.encoded_by.is_none());
        assert_eq!(
            matched.tracks[0].details.composer.as_deref(),
            Some("Credited composer")
        );
        assert_eq!(matched.tracks[0].details.rating, Some(4.5));
        assert_eq!(
            matched.tracks[0].details.comment.as_deref(),
            Some("Track note")
        );
        assert!(matched.tracks[1].details.rating.is_none());
    }

    #[test]
    fn enrichment_matches_release_and_medium_and_keeps_basic_metadata_on_failure() {
        let id = toc().disc_id().unwrap();
        let root = response(&id);
        let mut matched = select_release(&root, &id, &toc()).unwrap();
        let mut release = root["releases"][0].clone();
        release["media"][0]["position"] = json!(2);
        release["media"]
            .as_array_mut()
            .unwrap()
            .insert(0, json!({"position":1,"tracks":[]}));
        release["date"] = json!("1998");
        enrich_details(&mut matched, release.clone(), &toc());
        assert_eq!(matched.details.disc_number, Some(2));
        assert_eq!(matched.details.disc_total, Some(2));
        assert_eq!(matched.details.year.as_deref(), Some("1998"));
        let before = serde_json::to_value(&matched).unwrap();
        release["id"] = json!("21234567-1234-1234-1234-123456789abc");
        enrich_details(&mut matched, release.clone(), &toc());
        assert_eq!(serde_json::to_value(&matched).unwrap(), before);
        release["id"] = root["releases"][0]["id"].clone();
        release["media"][1]["tracks"][0]["title"] = json!("Conflicting track");
        enrich_details(&mut matched, release, &toc());
        enrich_details(&mut matched, json!({"error":"unavailable"}), &toc());
        assert_eq!(serde_json::to_value(&matched).unwrap(), before);
    }

    #[test]
    fn older_cached_metadata_stays_readable_and_ratings_are_not_guessed() {
        let id = toc().disc_id().unwrap();
        let album = select_release(&response(&id), &id, &toc()).unwrap();
        let mut old = serde_json::to_value(album).unwrap();
        old.as_object_mut().unwrap().remove("details");
        for track in old["tracks"].as_array_mut().unwrap() {
            track.as_object_mut().unwrap().remove("details");
        }
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(format!("{id}.json")),
            serde_json::to_vec(&json!({"checked_at":now(),"value":old})).unwrap(),
        )
        .unwrap();
        let cached = read_cache(dir.path(), &id).unwrap();
        assert_eq!(cached.schema, 0); // Forces a refresh, while retaining this value for offline fallback.
        assert!(cached.value.unwrap().tracks[0].details.composer.is_none());
        for rating in [
            json!({"value":5.1,"votes-count":1}),
            json!({"value":-1,"votes-count":1}),
            json!({"value":4,"votes-count":0}),
            json!({"value":null}),
        ] {
            assert!(track_details(&json!({"rating":rating})).rating.is_none());
        }
        assert_eq!(
            track_details(&json!({"rating":{"value":0,"votes-count":1}})).rating,
            Some(0.0)
        );
        assert!(album_details(&json!({}), &json!({})).compilation.is_none());
        assert_eq!(
            album_details(&json!({"release-group":{"secondary-types":[]}}), &json!({})).compilation,
            Some(false)
        );
    }
}
