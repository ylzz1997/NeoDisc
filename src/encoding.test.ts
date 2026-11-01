import { expect, test } from 'vitest';
import { defaultAac, defaultMp3, normalizeEncoding } from './encoding';

test('sample rate and channel changes constrain compatible bitrates',()=>{
  expect(normalizeEncoding('mp3',{...defaultMp3,sampleRate:22050,bitrateKbps:320}).bitrateKbps).toBe(160);
  expect(normalizeEncoding('aac',{...defaultAac,sampleRate:16000,channelMode:'mono',bitrateKbps:256}).bitrateKbps).toBe(96);
});
test('old or malformed preferences receive safe format-specific defaults',()=>{
  expect(normalizeEncoding('mp3',null)).toEqual(defaultMp3);
  expect(normalizeEncoding('aac',undefined)).toEqual(defaultAac);
  const result=normalizeEncoding('aac',{sampleRate:99999,channelMode:'jointStereo',bitrateMode:'vbr',vbrQuality:99});
  expect(result.sampleRate).toBe(44100);
  expect(result.channelMode).toBe('stereo');
  expect(result.bitrateMode).toBe('cbr');
  expect(result.vbrQuality).toBe(2);
});
