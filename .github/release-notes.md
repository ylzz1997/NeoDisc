NeoDisc — a modern CD player and ripper for Windows and macOS.

| Download | Platform |
| --- | --- |
| `*_x64-setup.exe` | Windows x64 installer |
| `*_aarch64.dmg` | macOS Apple Silicon |
| `*_x64.dmg` | macOS Intel |

## Fixed in 0.1.1

- Fixed the incomplete macOS app-bundle signature that caused downloaded Apple Silicon builds to fail signature validation. Both macOS packages now use a complete ad-hoc signature, including the bundled encoder and resources.
- Release checks now mount the actual DMGs and verify signatures, executable architectures, resources, MP3/AAC encoding and decoding, and application startup before uploading installers.
- Fixed a timing race in the EQ preset browser test by waiting for the final settings to reach the native boundary before capturing the save baseline.

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
