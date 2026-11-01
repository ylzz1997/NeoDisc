# NeoDisc

<img src="assets/neodisc.png" alt="NeoDisc" width="128" />

[简体中文](README.md) · [GitHub Actions](https://github.com/ylzz1997/NeoDisc/actions)

A modern CD player and ripper for Windows and macOS, built with Rust, Tauri and React. Current development version: **0.1.0**.

- Frameless desktop window with integrated controls, light/dark skins and scheduled night mode.
- Simplified Chinese and English. Follows the system language by default, with a persistent override in Preferences. Unsupported system languages fall back to English.
- CD playback, seeking, repeat, volume and selectable audio output. Follows system output changes by default.
- FLAC and WAV preserve original CD audio. MP3 and AAC/M4A offer sample rate, bitrate and channel settings; MP3 also supports CBR, ABR and VBR.
- Automatic MusicBrainz / Cover Art Archive identification. Missing or ambiguous results leave the disc usable without a prompt.
- Tags and artwork, playlists, source PCM hashes and rip reports. Optional repeated-read comparison, progress and cancellation.
- Rip history with folder availability checks, deletion, bulk cleanup and undo. Removing history keeps audio files.

Windows has been tested with a physical USB CD drive. macOS uses mounted cddafs AIFF/AIFC tracks; physical-drive testing on macOS is still pending. Repeated reads are not AccurateRip verification or a secure-ripping guarantee. HTOA, drive-offset correction and de-emphasis are not implemented.

## Development

Install Node.js 24, Rust stable, and the platform's Tauri prerequisites: MSVC build tools and WebView2 on Windows; Xcode command-line tools on macOS.

```sh
npm ci
npm run desktop
```

The encoder preparation script downloads a SHA-256-verified LGPL FFmpeg build on Windows and builds pinned FFmpeg/LAME sources on macOS. FFmpeg is bundled with the application. No system FFmpeg installation is needed.

```sh
npm run prepare:encoder
npm run check:version
npm test
npm run build
npm run test:ui
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
```

Browser tests use Edge on Windows and Playwright Chromium elsewhere (`npx playwright install chromium`). Hardware tests are separate and require an actual audio CD; see the [Chinese README](README.md) for commands and technical limits.

## Packages and releases

```sh
# Windows installer
npm run package -- --bundles nsis

# macOS, run on the matching architecture
npm run package -- --bundles dmg
```

Regular commits and pull requests run checks only. Pushing a matching version tag, such as `v0.1.0`, runs `.github/workflows/release.yml`. Once all checks and builds pass, it publishes a Windows x64 EXE, Apple Silicon DMG, Intel DMG and SHA-256 checksums. No release is made until a tag is pushed. Builds currently have no developer signature or Apple notarization.

Use `node scripts/set-version.mjs <version>` to update the package, Cargo and Tauri versions together. `npm run check:version` checks consistency. The release workflow also checks the tag against the application version.

Translations live in `src/locales`; the icon source is `assets/neodisc.png`. Local storage keys and the Tauri identifier retain their original `lucent` names so existing settings and history remain available.
