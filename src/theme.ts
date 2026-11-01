import type { Settings } from './types';
import { defaultAac, defaultMp3, normalizeEncoding } from './encoding';
import { defaultEqualizer, normalizeEqualizer } from './equalizer';
export const defaults: Settings = { language:'system', skin: 'amber', mode: 'dark', nightStart: '19:00', nightEnd: '07:00', format: 'flac', verify: true, outputDir: '', volume: 0.5, outputDevice: null, equalizer:defaultEqualizer, mp3:defaultMp3, aac:defaultAac };
export function isNight(time: string, start: string, end: string): boolean {
  if (start === end) return true;
  return start < end ? time >= start && time < end : time >= start || time < end;
}
export function resolveTheme(settings: Settings, date: Date, systemDark: boolean): 'dark' | 'light' {
  if (settings.mode === 'system') return systemDark ? 'dark' : 'light';
  if (settings.mode !== 'schedule') return settings.mode;
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return isNight(time, settings.nightStart, settings.nightEnd) ? 'dark' : 'light';
}
export function readSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem('lucent.settings') || '{}');
    return { ...defaults, ...saved, equalizer:normalizeEqualizer(saved.equalizer), language:['system','zh-CN','en'].includes(saved.language)?saved.language:'system', format:['flac','wav','mp3','aac'].includes(saved.format)?saved.format:defaults.format, mp3:normalizeEncoding('mp3',saved.mp3), aac:normalizeEncoding('aac',saved.aac), outputDevice: typeof saved.outputDevice === 'string' && saved.outputDevice.trim() ? saved.outputDevice : null, skin: ['graphite','forest','amber'].includes(saved.skin) ? saved.skin : defaults.skin, mode: ['dark','light','system','schedule'].includes(saved.mode) ? saved.mode : defaults.mode, volume: Number.isFinite(saved.volume) ? Math.min(1, Math.max(0, saved.volume)) : defaults.volume };
  } catch { return defaults; }
}
export function duration(seconds: number) { const s = Math.max(0, Math.floor(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
