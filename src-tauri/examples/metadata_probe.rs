//! Opt-in online metadata check; sends a Disc ID / TOC, never audio samples.
use lucent_core::{
    device,
    metadata::MetadataService,
    models::{Disc, DiscToc, Track},
};
fn main() -> Result<(), String> {
    let drive = std::env::args()
        .nth(1)
        .ok_or("Pass a CD drive or mount path")?;
    let disc = if drive == "--reference" {
        // Published MusicBrainz Disc ID calculation example, not the user's CD.
        let toc = DiscToc {
            first_track: 1,
            last_track: 6,
            lead_out: 95462,
            offsets: vec![150, 15363, 32314, 46592, 63414, 80489],
        };
        let tracks = (0..6)
            .map(|i| Track {
                number: i as u8 + 1,
                title: String::new(),
                start_sector: toc.offsets[i] - 150,
                sectors: toc.offsets.get(i + 1).copied().unwrap_or(toc.lead_out) - toc.offsets[i],
                pre_emphasis: false,
                source_path: None,
                artist: None,
            })
            .collect();
        Disc {
            drive_id: "reference".into(),
            title: String::new(),
            artist: String::new(),
            tracks,
            fingerprint: "reference".into(),
            lookup_toc: Some(toc),
            metadata_id: None,
        }
    } else {
        device::read_disc(&drive)?
    };
    println!("TOC: {:?}", disc.lookup_toc);
    println!(
        "Disc ID: {:?}",
        disc.lookup_toc.as_ref().and_then(|t| t.disc_id())
    );
    match MetadataService::default()
        .lookup_with_refresh(&disc, std::env::args().any(|arg| arg == "--refresh"))?
    {
        None => println!("NO MATCH: default names and artwork are retained"),
        Some(album) => {
            println!("Source: {}", album.source);
            println!("{} / {} / {}", album.title, album.artist, album.release_id);
            println!(
                "Album details: {}",
                serde_json::to_string(&album.details).unwrap()
            );
            for track in album.tracks {
                println!("{:02}: {} / {}", track.number, track.title, track.artist);
                println!(
                    "Track details: {}",
                    serde_json::to_string(&track.details).unwrap()
                );
            }
            println!("Cover available: {}", album.cover.is_some());
        }
    }
    Ok(())
}
