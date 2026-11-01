import type { EqualizerSettings, SavedEqualizer } from './types';

export const eqFrequencies = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const defaultEqualizer: EqualizerSettings = { enabled: false, preampDb: 0, bands: Array<number>(10).fill(0) };
export const eqPresets = [
  { id: 'flat', label: '平直', preampDb: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', label: '低音增强', preampDb: -9, bands: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0] },
  { id: 'vocal', label: '人声', preampDb: -6, bands: [-2, -2, -1, 0, 2, 3, 4, 2, 0, -1] },
  { id: 'pop', label: '流行', preampDb: -5, bands: [1, 2, 3, 1, -1, 0, 2, 3, 2, 1] },
  { id: 'rock', label: '摇滚', preampDb: -6, bands: [4, 3, 1, -1, -2, 1, 3, 4, 3, 2] },
  { id: 'classical', label: '古典', preampDb: -5, bands: [3, 2, 0, 0, -1, 0, 1, 2, 3, 3] },
  { id: 'jazz', label: '爵士', preampDb: -5, bands: [3, 2, 1, 1, -1, -1, 0, 2, 3, 2] },
];

export function normalizeEqualizer(value: unknown): EqualizerSettings {
  const saved = value && typeof value === 'object' ? value as Partial<EqualizerSettings> : {};
  const gain = (number: unknown, min: number, max: number) => typeof number === 'number' && Number.isFinite(number) ? Math.round(Math.min(max, Math.max(min, number)) * 2) / 2 : 0;
  return {
    enabled: saved.enabled === true,
    preampDb: gain(saved.preampDb, -24, 12),
    bands: Array.from({ length: 10 }, (_, index) => gain(Array.isArray(saved.bands) ? saved.bands[index] : 0, -12, 12)),
  };
}

export function matchingPreset(settings: EqualizerSettings) {
  return eqPresets.find(preset => matchesEqualizer(preset, settings));
}

export function matchesEqualizer(preset: Pick<EqualizerSettings, 'preampDb' | 'bands'>, settings: EqualizerSettings) {
  return preset.preampDb === settings.preampDb && preset.bands.length === 10 && preset.bands.every((gain, i) => gain === settings.bands[i]);
}

export function normalizeSavedEqualizers(value: unknown): SavedEqualizer[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>(), names = new Set<string>();
  return value.flatMap((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const saved = entry as Partial<SavedEqualizer>;
    const name = typeof saved.name === 'string' ? saved.name.trim().slice(0, 40) : '';
    const id = typeof saved.id === 'string' && saved.id.length > 0 && saved.id.length <= 100 ? saved.id : `saved-eq-${index}`;
    if (!name || !Array.isArray(saved.bands) || ids.has(id) || names.has(name.toLowerCase())) return [];
    ids.add(id); names.add(name.toLowerCase());
    const { bands, preampDb } = normalizeEqualizer(saved);
    return [{ id, name, bands, preampDb }];
  });
}

export function gainLabel(gain: number) { return `${gain > 0 ? '+' : ''}${gain} dB`; }
