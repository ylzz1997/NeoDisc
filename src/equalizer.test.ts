import { describe, expect, it } from 'vitest';
import { defaultEqualizer, eqFrequencies, eqPresets, matchingPreset, normalizeEqualizer, normalizeSavedEqualizers } from './equalizer';

describe('equalizer settings', () => {
  it('loads named presets safely and retains names while repairing gains', () => {
    expect(normalizeSavedEqualizers(undefined)).toEqual([]);
    expect(normalizeSavedEqualizers({ name: 'bad' })).toEqual([]);
    const presets = normalizeSavedEqualizers([
      { id: 'one', name: '  My 耳机 <night>  ', preampDb: -50, bands: [999, null, '5', -50] },
      { id: 'two', name: 'my 耳机 <night>', bands: [0] },
      { id: 'one', name: 'duplicate ID', bands: [0] },
      { name: 'missing curve', bands: null },
      { name: '   ', bands: [1] },
      { name: 'Studio', preampDb: -3.5, bands: eqPresets[2].bands },
    ]);
    expect(presets).toEqual([
      { id: 'one', name: 'My 耳机 <night>', preampDb: -24, bands: [12, 0, 0, -12, 0, 0, 0, 0, 0, 0] },
      { id: 'saved-eq-5', name: 'Studio', preampDb: -3.5, bands: eqPresets[2].bands },
    ]);
    expect(presets[1].bands).not.toBe(eqPresets[2].bands);
  });
  it('migrates old settings and repairs corrupt saved gains without enabling EQ', () => {
    for (const value of [undefined, null, false, 'bad', {}]) expect(normalizeEqualizer(value)).toEqual(defaultEqualizer);
    expect(normalizeEqualizer({ enabled: 'true', preampDb: Infinity, bands: [NaN, -50, 50, '5', 2.3] })).toEqual({ enabled: false, preampDb: 0, bands: [0, -12, 12, 0, 2.5, 0, 0, 0, 0, 0] });
    const saved = { enabled: true, preampDb: -9, bands: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0] };
    expect(normalizeEqualizer(saved)).toEqual(saved);
    expect(normalizeEqualizer(saved).bands).not.toBe(saved.bands);
    expect(matchingPreset(saved)?.id).toBe('bass');
    expect(matchingPreset({ ...saved, preampDb: -8.5 })).toBeUndefined();
  });

  it('presets reserve enough preamp headroom for the combined filter response', () => {
    // Evaluate the combined frequency response, including overlap between bands.
    // This catches presets whose individual peaks appear safe but sum above 0 dB.
    for (const preset of eqPresets) {
      let peak = -Infinity;
      for (let frequency = 20; frequency < 22050; frequency *= 1.004) {
        const w = 2 * Math.PI * frequency / 44100;
        let gain = preset.preampDb;
        for (const [i, center] of eqFrequencies.entries()) {
          const a = 10 ** (preset.bands[i] / 40);
          const omega = 2 * Math.PI * center / 44100;
          const alpha = Math.sin(omega) / (2 * Math.SQRT2);
          const magnitude = (p0: number, p1: number, p2: number) => Math.hypot(p0 + p1 * Math.cos(w) + p2 * Math.cos(2 * w), -p1 * Math.sin(w) - p2 * Math.sin(2 * w));
          gain += 20 * Math.log10(magnitude(1 + alpha * a, -2 * Math.cos(omega), 1 - alpha * a) / magnitude(1 + alpha / a, -2 * Math.cos(omega), 1 - alpha / a));
        }
        peak = Math.max(peak, gain);
      }
      expect(peak, preset.id).toBeLessThanOrEqual(0.01);
    }
  });
});
