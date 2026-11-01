import type { AlbumMetadata, Disc } from './types';

type Manual = Pick<Disc, 'title' | 'artist' | 'tracks'>;
export function manualMetadata(fingerprint: string): Manual | null {
  try {
    const value = JSON.parse(localStorage.getItem(`lucent.disc.${fingerprint}`) || 'null');
    return value && typeof value.title === 'string' && typeof value.artist === 'string' && Array.isArray(value.tracks) ? value : null;
  } catch { return null; }
}
export function withManualMetadata(disc: Disc): Disc {
  const saved = manualMetadata(disc.fingerprint);
  if (!saved) return disc;
  return { ...disc, title: saved.title || disc.title, artist: saved.artist || disc.artist,
    tracks: disc.tracks.map(t => ({ ...t, title: saved.tracks.find(m => m.number === t.number)?.title || t.title })) };
}
export function withAutomaticMetadata(disc: Disc, metadata: AlbumMetadata): Disc {
  return withManualMetadata({ ...disc, title: metadata.title, artist: metadata.artist, metadataId: metadata.discId, metadataReleaseId: metadata.releaseId, details: metadata.details,
    tracks: disc.tracks.map(t => {
      const found = metadata.tracks.find(m => m.number === t.number);
      return found ? { ...t, title: found.title, artist: found.artist, details: found.details } : t;
    }) });
}
