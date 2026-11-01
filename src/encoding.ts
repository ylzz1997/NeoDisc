import { tr } from './i18n';
import type { EncodingOptions, LossyFormat, OutputFormat } from './types';

export const sampleRates = [16000,22050,24000,32000,44100,48000];
export const defaultMp3: EncodingOptions = {sampleRate:44100,bitrateKbps:192,bitrateMode:'cbr',vbrQuality:2,channelMode:'jointStereo',encoderQuality:2};
export const defaultAac: EncodingOptions = {...defaultMp3,bitrateKbps:256,channelMode:'stereo'};
export function isLossy(format: OutputFormat): format is LossyFormat { return format === 'mp3' || format === 'aac'; }
export function bitrates(format: LossyFormat, options: Pick<EncodingOptions,'sampleRate'|'channelMode'>): number[] {
  if (format === 'mp3') return options.sampleRate < 32000 ? [32,48,64,96,128,160] : [64,96,128,160,192,256,320];
  return [32,48,64,96,128,160,192,256,320].filter(rate => rate*1000 <= options.sampleRate*(options.channelMode === 'mono' ? 1 : 2)*6);
}
export function normalizeEncoding(format: LossyFormat, value: unknown): EncodingOptions {
  const fallback = format === 'aac' ? defaultAac : defaultMp3;
  const saved = value && typeof value === 'object' ? value as Partial<EncodingOptions> : {};
  const options = {...fallback,...saved};
  options.sampleRate = sampleRates.includes(saved.sampleRate!) ? saved.sampleRate! : fallback.sampleRate;
  options.bitrateMode = format === 'mp3' && ['cbr','abr','vbr'].includes(saved.bitrateMode!) ? saved.bitrateMode! : 'cbr';
  options.channelMode = (format === 'mp3' ? ['jointStereo','stereo','mono'] : ['stereo','mono']).includes(saved.channelMode!) ? saved.channelMode! : fallback.channelMode;
  for (const key of ['vbrQuality','encoderQuality'] as const) options[key] = Number.isInteger(saved[key]) && saved[key]! >= 0 && saved[key]! <= 9 ? saved[key]! : fallback[key];
  const allowed = bitrates(format,options);
  const requested = typeof saved.bitrateKbps === 'number' && Number.isFinite(saved.bitrateKbps) ? saved.bitrateKbps : fallback.bitrateKbps;
  options.bitrateKbps = allowed.includes(requested) ? requested : [...allowed].reverse().find(rate => rate <= requested) ?? allowed[0];
  return options;
}
export function encodingSummary(format: LossyFormat, options: EncodingOptions): string {
  const rate = options.bitrateMode === 'vbr' ? `VBR · V${options.vbrQuality}` : `${options.bitrateKbps} kbps${format === 'mp3' ? ` · ${options.bitrateMode.toUpperCase()}` : ''}`;
  const channels = {jointStereo:tr("联合立体声"),stereo:tr("立体声"),mono:tr("单声道")}[options.channelMode];
  return `${options.sampleRate/1000} kHz · ${rate} · ${channels}`;
}
