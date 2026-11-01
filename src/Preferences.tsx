import { tr, localizeMessage } from './i18n';
import { Headphones, Volume2, RefreshCw, Cable, CheckCircle2, AlertCircle, Palette, ChevronRight, Monitor, LoaderCircle } from 'lucide-react';
import type { AudioOutput, Language, Settings } from './types';
import './preferences.css';

interface Props {
  native: boolean;
  settings: Settings;
  output: AudioOutput | null;
  changing: boolean;
  onSelect: (name: string | null) => void;
  onRefresh: (reconnect: boolean) => void;
  onVolume: (value: number) => void;
  onAppearance: () => void;
  onLanguage: (language:Language) => void;
}

export default function Preferences({ native, settings, output, changing, onSelect, onRefresh, onVolume, onAppearance, onLanguage }: Props) {
  const devices = output?.devices || [];
  const selectedMissing = settings.outputDevice && !devices.some(d => d.name === settings.outputDevice);
  const ready = !!output?.activeDevice && !output.error;
  return <div className="preferences-page">
    <div className="page-heading"><div><div className="eyebrow">A LITTLE MORE IN TUNE.</div><h1>{tr("让声音，去对的地方")}<span className="accent">{tr("。")}</span></h1><p className="page-subtitle">{tr("首选项 · 音频输出与播放")}</p></div><Headphones className="heading-illustration" size={48}/></div>
    <section className="language-settings"><div><label htmlFor="interface-language">{tr('界面语言')}</label><p>{tr(settings.language==='system'?'自动使用系统语言；暂不支持的语言使用英文。':'语言设置即时生效，不改变专辑、曲名或文件路径。')}</p></div><select id="interface-language" aria-label={tr('界面语言')} value={settings.language} onChange={event=>onLanguage(event.target.value as Language)}><option value="system">{tr('跟随系统语言')}</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></section>
    <section className="audio-settings-card">
      <div className="audio-card-heading"><div className="panel-icon"><Volume2 size={22}/></div><div><h2>{tr("音频输出")}</h2><p>{tr("选择耳机、音箱，或跟随系统的选择。")}</p></div><span className={`audio-state-badge ${ready?'ready':''}`}>{changing?tr("正在连接…"):!native?tr("桌面版功能"):output?.error?tr("需要连接"):ready?tr("输出已就绪"):tr("正在检测…")}</span></div>
      <label className="audio-device-label" htmlFor="audio-device">{tr("输出设备")}</label>
      <select id="audio-device" aria-label={tr("音频输出设备")} className="audio-device-select" value={settings.outputDevice||''} disabled={!native||changing} onChange={e=>onSelect(e.target.value||null)}>
        <option value="">{tr("跟随系统默认（推荐）")}</option>
        {selectedMissing&&<option value={settings.outputDevice!}>{settings.outputDevice}{tr("（未连接）")}</option>}
        {devices.map((d,i)=><option value={d.name} key={`${d.name}-${i}`} disabled={!d.selectable}>{d.name}{d.isDefault?tr(" · 系统默认"):''}{!d.selectable?tr(" · 同名设备需重命名"):''}</option>)}
      </select>
      <p className="audio-route-note">{settings.outputDevice?tr("始终使用此设备。设备断开时暂停，重新连接后可继续播放。"):tr("系统默认输出改变时自动切换，保留当前曲目、播放位置和暂停状态。")}</p>
      <div className="active-output"><Headphones size={25}/><div><span>{tr("当前实际输出")}</span><strong>{output?.activeDevice || (native?tr("尚未连接音频输出"):tr("请在桌面版查看真实设备"))}</strong></div>{ready&&<CheckCircle2 size={19}/>}</div>
      <div className="audio-format-grid">
        <div><span>{tr("输出采样率")}</span><strong>{output?.sampleRate?`${output.sampleRate/1000} kHz`:'—'}</strong></div>
        <div><span>{tr("输出声道")}</span><strong>{output?.channels===2?tr("立体声 · 2 声道"):output?.channels?tr("{v0} 声道",{v0:output.channels}):'—'}</strong></div>
        <div><span>{tr("输出格式")}</span><strong>{output?.sampleFormat || '—'}</strong></div>
      </div>
      <p className="system-output"><Monitor size={14}/>{tr("系统默认：")}<span>{output?.systemDefault || (native?tr("暂无可用设备"):tr("浏览器预览不读取设备"))}</span></p>
      {output?.error&&<div className="audio-error" role="alert"><AlertCircle size={18}/><span>{localizeMessage(output.error)}</span></div>}
      <div className="audio-actions"><button className="secondary" disabled={!native||changing} onClick={()=>onRefresh(false)}><RefreshCw size={16}/>{tr("刷新设备列表")}</button><button className="primary" disabled={!native||changing} onClick={()=>onRefresh(true)}>{changing?<LoaderCircle size={16} className="spin"/>:<Cable size={17}/>}{tr("重新连接输出")}</button><span>{devices.length?tr("发现 {v0} 个输出设备",{v0:devices.length}):''}</span></div>
    </section>
    <section className="preferences-volume"><div><Volume2 size={20}/><span><strong>{tr("播放音量")}</strong><small>{tr("只调整 NeoDisc，不改变系统音量。")}</small></span></div><input aria-label={tr("首选项播放音量")} type="range" min="0" max="1" step="0.01" value={settings.volume} onChange={e=>onVolume(+e.target.value)} style={{'--range-fill':`${settings.volume*100}%`} as React.CSSProperties}/><b>{Math.round(settings.volume*100)}%</b></section>
    <div className="audio-info-note"><CheckCircle2 size={15}/><p>{tr("音频使用系统共享输出，实际格式由设备决定。FLAC / WAV 保留 CD 原始音频；MP3 / AAC 使用单独的编码设置。")}<br/>{tr("设备选择自动保存在本机；切换设备时可能有短暂的声音间隔。")}</p></div>
    <button className="appearance-shortcut" onClick={onAppearance}><Palette size={21}/><span><strong>{tr("外观与皮肤")}</strong><small>{tr("配色、深浅模式与自动夜间")}</small></span><ChevronRight size={19}/></button>
  </div>;
}
