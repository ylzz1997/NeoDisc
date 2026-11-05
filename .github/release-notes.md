NeoDisc — a modern CD player and ripper for Windows and macOS.

| Download | Platform |
| --- | --- |
| `*_x64-setup.exe` | Windows x64 installer |
| `*_aarch64.dmg` | macOS Apple Silicon |
| `*_x64.dmg` | macOS Intel |

## New in 0.1.2

- Audio CDs inserted after startup are detected automatically. Discs that are still mounting are retried, removal clears the loaded disc, and background scans preserve track selections and pause during ripping.
- Improved album and track identification with CUETools DB as a fallback to MusicBrainz. Only unambiguous exact matches are applied, and existing disc information is kept when no reliable match is found.
- Added identification status and an **Identify again** action that bypasses cached misses without rereading the disc or interrupting playback.
- Added a saved **Identify CD information automatically** preference. Turning it off cancels lookup and ignores late results while keeping displayed information and local edits.
- Windows now reads available album and track information from CD-TEXT, while playback and ripping validate the disc layout without rereading CD-TEXT.

## Features

- Modern frameless CD player with selectable skins, light/dark modes and automatic night mode.
- FLAC / WAV / MP3 / AAC ripping with configurable encoding settings.
- Automatic album, cover and track identification, plus per-track metadata details. Missing information is shown as unknown.
- Audio output selection and a live 10-band equalizer with built-in and saved custom presets.
- Rip history with individual deletion, missing-folder detection and bulk cleanup.
- Simplified Chinese and English, following the system language by default.

The audio encoder is bundled. `SHA256SUMS.txt` contains download checksums.

These community builds are not Developer ID signed or notarized. If macOS blocks NeoDisc on first launch, try opening it, then allow it in **System Settings → Privacy & Security → Open Anyway**. Ad-hoc signing fixes the invalid bundle signature; it does not provide Apple notarization.

macOS optical-drive support still needs testing on physical hardware.
