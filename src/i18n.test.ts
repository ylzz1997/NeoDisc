import {afterEach,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {getLocale,localizeMessage,resolveLocale,setLanguage,tr} from './i18n';
import english from './locales/en.json';
import nativeEnglish from './locales/native-en.json';
import {eqPresets} from './equalizer';

afterEach(()=>setLanguage('system'));
describe('language selection and translation',()=>{
  it('follows supported system languages and falls back to English',()=>{
    expect(resolveLocale('system',['zh-Hans-CN','en-US'])).toBe('zh-CN');
    expect(resolveLocale('system',['zh-TW'])).toBe('zh-CN');
    expect(resolveLocale('system',['en-GB','zh-CN'])).toBe('en');
    expect(resolveLocale('system',['de-DE'])).toBe('en');
    expect(resolveLocale('zh-CN',['en-US'])).toBe('zh-CN');
    expect(resolveLocale('en',['zh-CN'])).toBe('en');
  });
  it('switches existing messages, interpolates metadata safely, and uses singular counts',()=>{
    setLanguage('en');
    expect(getLocale()).toBe('en');
    expect(tr('{v0} 首曲目',{v0:1})).toBe('1 track');
    expect(tr('{v0} 首曲目',{v0:2})).toBe('2 tracks');
    const message=tr('已删除“{v0}”的记录，音频文件保留。',{v0:'未知艺术家 <script> & 音乐'});
    expect(message).toContain('未知艺术家 <script> & 音乐');
    setLanguage('zh-CN');
    expect(localizeMessage(message)).toBe('已删除“未知艺术家 <script> & 音乐”的记录，音频文件保留。');
  });
  it('translates native progress and nested errors while preserving titles, devices, and paths',()=>{
    setLanguage('en');
    expect(localizeMessage('正在读取并比对曲目 01 · 安静的地方')).toBe('Reading and comparing track 01 · 安静的地方');
    expect(localizeMessage('正在编码 AAC · 曲目 02 · 雨后')).toBe('Encoding AAC · Track 02 · 雨后');
    expect(localizeMessage('首选设备“我的耳机”未连接。重新连接后点击播放，或选择其他输出。')).toContain('“我的耳机”');
    expect(localizeMessage('扇区 80 重试 3 次后失败：两次读取不一致。已完成的文件保留在 C:\\音乐\\专辑')).toBe('Sector 80 failed after 3 retries: The two reads did not match. Completed files are kept in C:\\音乐\\专辑');
    expect(localizeMessage('Unrecognized operating system error 123')).toBe('Unrecognized operating system error 123');
  });
  it('has translations for literal UI keys and retains all interpolation parameters',()=>{
    const dictionary:Record<string,string>={...english,...nativeEnglish};
    for(const preset of eqPresets)expect(dictionary[preset.label],preset.id).toBeTruthy();
    for(const file of ['App.tsx','Preferences.tsx','HistoryPage.tsx','EncodingSettings.tsx','encoding.ts','EqualizerPanel.tsx','EqualizerCurve.tsx','equalizer.ts']){
      const source=ts.createSourceFile(file,readFileSync(new URL(`./${file}`,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
      function visit(node:ts.Node){
        if(ts.isCallExpression(node)&&node.expression.getText(source)==='tr'&&ts.isStringLiteral(node.arguments[0]))expect(dictionary[node.arguments[0].text],`${file}: ${node.arguments[0].text}`).toBeTruthy();
        ts.forEachChild(node,visit);
      }
      visit(source);
    }
    for(const [key,value] of Object.entries(dictionary))expect((value.match(/\{\w+\}/g)||[]).sort(),key).toEqual((key.match(/\{\w+\}/g)||[]).sort());
  });
});
