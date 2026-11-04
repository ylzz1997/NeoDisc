export interface Drive { id: string; name: string }
export interface TrackMetadataDetails { recordingId?: string | null; rating?: number | null; composer?: string | null; comment?: string | null }
export interface AlbumMetadataDetails { year?: string | null; genre?: string | null; discNumber?: number | null; discTotal?: number | null; label?: string | null; copyright?: string | null; encodedBy?: string | null; url?: string | null; compilation?: boolean | null; comment?: string | null }
export interface Track { number: number; title: string; startSector: number; sectors: number; preEmphasis: boolean; sourcePath?: string; artist?: string | null; details?: TrackMetadataDetails }
export interface Disc { driveId: string; title: string; artist: string; tracks: Track[]; fingerprint: string; lookupToc?: { firstTrack: number; lastTrack: number; leadOut: number; offsets: number[] } | null; metadataId?: string | null; metadataReleaseId?: string | null; details?: AlbumMetadataDetails }
export interface AlbumMetadata { discId: string; releaseId: string; source?: string; title: string; artist: string; tracks: { number: number; title: string; artist: string; details?: TrackMetadataDetails }[]; cover: string | null; details?: AlbumMetadataDetails }
export interface AudioDevice { name: string; isDefault: boolean; selectable: boolean }
export interface AudioOutput { selectedDevice: string | null; systemDefault: string | null; activeDevice: string | null; devices: AudioDevice[]; sampleRate: number | null; channels: number | null; sampleFormat: string | null; error: string | null; generation: number }
export interface Playback { track: number | null; playing: boolean; position: number; duration: number; volume: number; error: string | null; ended: boolean; output?: AudioOutput }
export interface Progress { phase: string; track: number; completed: number; total: number; fraction: number; message: string; outputDir: string }
export interface HistoryEntry { id: string; title: string; artist: string; date: string; format: string; tracks: number; path: string; verified: boolean; encoding?: EncodingOptions }
export type ThemeMode = 'dark' | 'light' | 'system' | 'schedule';
export type Skin = 'graphite' | 'forest' | 'amber';
export type OutputFormat = 'flac' | 'wav' | 'mp3' | 'aac';
export type LossyFormat = 'mp3' | 'aac';
export type Language = 'system' | 'zh-CN' | 'en';
export interface EqualizerSettings { enabled: boolean; preampDb: number; bands: number[] }
export interface SavedEqualizer { id: string; name: string; preampDb: number; bands: number[] }
export interface EncodingOptions { sampleRate: number; bitrateKbps: number; bitrateMode: 'cbr' | 'abr' | 'vbr'; vbrQuality: number; channelMode: 'jointStereo' | 'stereo' | 'mono'; encoderQuality: number }
export interface Settings { language: Language; autoMetadata: boolean; skin: Skin; mode: ThemeMode; nightStart: string; nightEnd: string; format: OutputFormat; verify: boolean; outputDir: string; volume: number; outputDevice: string | null; equalizer: EqualizerSettings; equalizerPresets: SavedEqualizer[]; mp3: EncodingOptions; aac: EncodingOptions }
