use lucent_core::{device, encode::AudioWriter};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    path::PathBuf,
    sync::atomic::AtomicBool,
};

fn main() -> Result<(), String> {
    let drives = device::drives()?;
    println!("Drives: {}", serde_json::to_string(&drives).unwrap());
    let drive = std::env::args()
        .nth(1)
        .or_else(|| drives.first().map(|d| d.id.clone()))
        .ok_or("No optical drive found")?;
    let disc = device::read_disc(&drive)?;
    println!("{}", serde_json::to_string_pretty(&disc).unwrap());
    if let Some(folder) = std::env::args().nth(2) {
        let root = PathBuf::from(folder);
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let track = disc.tracks.first().ok_or("No audio tracks")?;
        let mut reader = device::open_track(&disc, track)?;
        let mut pcm = vec![];
        let length = track.sectors.min(75 * 3);
        let cancel = AtomicBool::new(false);
        let mut offset = 0;
        while offset < length {
            let count = (length - offset).min(27);
            pcm.extend(lucent_core::rip::checked_read(
                reader.as_mut(),
                offset,
                count,
                true,
                &cancel,
            )?);
            offset += count;
        }
        for format in ["flac", "wav"] {
            let path = root.join(format!("probe.{format}"));
            let file = File::options()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            let mut writer = AudioWriter::new(
                file,
                format,
                &[("TITLE", "Hardware verification sample".into())],
            )?;
            writer.write(&pcm)?;
            writer.finish()?;
        }
        let mut decoder =
            claxon::FlacReader::open(root.join("probe.flac")).map_err(|e| e.to_string())?;
        let decoded: Vec<u8> = decoder
            .samples()
            .map(|s| s.map(|n| (n as i16).to_le_bytes()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
            .into_iter()
            .flatten()
            .collect();
        if pcm != decoded {
            return Err("FLAC round trip differs from physical CD PCM".into());
        }
        let report=format!("Hardware read: {} sectors / {} bytes\nRepeated read: identical\nFLAC decode: bit-exact\nPCM SHA256: {:x}\n",length,pcm.len(),Sha256::digest(&pcm));
        println!("{report}");
        fs::write(root.join("verification.txt"), report).map_err(|e| e.to_string())?;
    }
    Ok(())
}
