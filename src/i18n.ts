import { useSyncExternalStore } from 'react';
import english from './locales/en.json';
import nativeEnglish from './locales/native-en.json';
import type { Language } from './types';

export type Locale = 'zh-CN' | 'en';
type Parameters = Record<string, string | number>;
const messages: Record<string,string> = {...english,...nativeEnglish};
const subscribers = new Set<() => void>();
let preference: Language = 'system';
try {
  const saved = typeof window === 'undefined' ? 'system' : JSON.parse(window.localStorage.getItem('lucent.settings') || '{}').language;
  if (saved === 'en' || saved === 'zh-CN') preference = saved;
} catch { /* Browser storage can be unavailable. */ }

export function resolveLocale(language: Language, languages: readonly string[]): Locale {
  if (language !== 'system') return language;
  for (const value of languages) {
    const base = value.toLowerCase().replaceAll('_','-').split('-')[0];
    if (base === 'zh') return 'zh-CN';
    if (base === 'en') return 'en';
  }
  return 'en';
}
const systemLanguages = () => typeof navigator === 'undefined' ? ['en'] : navigator.languages?.length ? navigator.languages : [navigator.language];
let current = resolveLocale(preference,systemLanguages());
function applyLocale() {
  const next = resolveLocale(preference,systemLanguages());
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (next !== current) { current = next; subscribers.forEach(notify => notify()); }
}
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange',applyLocale);
  applyLocale();
}
export function setLanguage(language: Language) { preference=language; applyLocale(); }
export const getLocale = () => current;
export function useLocale() {
  return useSyncExternalStore(notify => { subscribers.add(notify); return () => {subscribers.delete(notify);}; },getLocale,getLocale);
}

const singular: Record<string,string> = {
  '{v0} 首曲目 · Audio CD':'{v0} track · Audio CD',
  '{v0} 首曲目':'{v0} track',
  '抓轨完成，已保存 {v0} 首曲目。':'Ripping complete. Saved {v0} track.',
  '{v0} 声道':'{v0} channel',
  '发现 {v0} 个输出设备':'{v0} output device found',
  '{v0} 次完成的抓轨，随时回到熟悉的旋律。':'{v0} completed rip. Return to a familiar melody anytime.',
  '已清理 {v0} 条目录不存在的记录，音频文件保留。':'Removed {v0} record with a missing folder. Audio files are kept.',
  '{count} 首曲目已保存':'Saved {count} track',
};
export function tr(key: string, parameters: Parameters = {}): string {
  let template = current === 'en' ? messages[key] ?? key : key;
  if (current === 'en' && singular[key] && Number(parameters.v0 ?? parameters.count) === 1) template=singular[key];
  return template.replace(/\{(\w+)\}/g,(match,name:string) => parameters[name] === undefined ? match : String(parameters[name]));
}

function pattern(template:string) {
  const names:string[]=[];
  const escape = (value:string) => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const parts=template.split(/(\{\w+\})/g).map(part => {
    if (/^\{\w+\}$/.test(part)) {names.push(part.slice(1,-1));return '([\\s\\S]+?)';}
    return escape(part);
  });
  return {regex:new RegExp(`^${parts.join('')}$`),names};
}
// The engine's stable source messages are translated only at presentation time.
// Captured titles, device names, and paths are left untouched; nested errors are
// translated separately. This also updates already-visible messages on a switch.
const templates=Object.entries(messages)
  .sort(([a],[b]) => b.replace(/\{\w+\}/g,'').length-a.replace(/\{\w+\}/g,'').length)
  .flatMap(([key,en]) => [...new Set([key,en,singular[key]].filter(Boolean))].map(template => ({key,...pattern(template)})));
export function localizeMessage(value:string, depth=0):string {
  if (depth > 5) return value;
  if (value.startsWith('Error: ')) return `Error: ${localizeMessage(value.slice(7),depth+1)}`;
  for (const {key,regex,names} of templates) {
    const match=regex.exec(value);
    if (!match) continue;
    const parameters:Parameters={};
    names.forEach((name,index) => {parameters[name]=/error/i.test(name)?localizeMessage(match[index+1],depth+1):match[index+1];});
    return tr(key,parameters);
  }
  return value;
}
