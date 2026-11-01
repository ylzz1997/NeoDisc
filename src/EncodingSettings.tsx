import { tr } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, SlidersHorizontal, X } from 'lucide-react';
import type { EncodingOptions, LossyFormat, OutputFormat, Settings } from './types';
import { bitrates, defaultAac, defaultMp3, encodingSummary, isLossy, normalizeEncoding, sampleRates } from './encoding';
import './encoding.css';

const getFormats = (): {id:OutputFormat;label:string;detail:string;note:string}[] => [
  {id:'flac',label:'FLAC',detail:tr("无损压缩"),note:tr("完整保留 CD 音质，节省存储空间。")},
  {id:'wav',label:'WAV',detail:tr("原始音频"),note:tr("未压缩 PCM，兼容常见音频软件。")},
  {id:'mp3',label:'MP3',detail:tr("有损压缩"),note:tr("兼容常见播放器，文件更小。")},
  {id:'aac',label:'AAC',detail:tr("M4A 文件"),note:tr("AAC-LC 有损压缩，保存为 .m4a 文件。")},
];
export default function EncodingSettings({settings,disabled,onFormat,onEdit}:{settings:Settings;disabled:boolean;onFormat:(format:OutputFormat)=>void;onEdit:(format:LossyFormat)=>void}) {
  const formats=getFormats();
  const format = settings.format;
  return <>
    <label className="field-label">{tr("保存格式")}</label>
    <div className="format-options">{formats.map(item=><button key={item.id} className={format===item.id?'selected':''} disabled={disabled} onClick={()=>onFormat(item.id)}><strong>{item.label}</strong><span>{item.detail}</span>{format===item.id&&<Check size={14}/>}</button>)}</div>
    <p className="format-note">{formats.find(item=>item.id===format)?.note}</p>
    {isLossy(format)&&<button className="encoding-shortcut" disabled={disabled} onClick={()=>onEdit(format)} aria-label={tr("编码详细设置")}><SlidersHorizontal size={17}/><span><strong>{tr("编码详细设置")}</strong><small>{encodingSummary(format,settings[format])}</small></span><ChevronRight size={14}/></button>}
  </>;
}

export function EncodingDialog({format,options,onSave,onClose}:{format:LossyFormat;options:EncodingOptions;onSave:(options:EncodingOptions)=>void;onClose:()=>void}) {
  const [draft,setDraft]=useState(()=>normalizeEncoding(format,options));
  const modal=useRef<HTMLDivElement>(null);
  const closeRef=useRef(onClose); closeRef.current=onClose;
  const patch=(change:Partial<EncodingOptions>)=>setDraft(current=>normalizeEncoding(format,{...current,...change}));
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    modal.current?.querySelector<HTMLSelectElement>('select')?.focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();closeRef.current();}
      if(event.key==='Tab'){
        const controls=modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled)');
        if(!controls?.length)return;
        const first=controls[0],last=controls[controls.length-1];
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    };
    window.addEventListener('keydown',key);
    return()=>{window.removeEventListener('keydown',key);previous?.focus();};
  },[]);
  const availableRates=bitrates(format,draft);
  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div className="modal encoding-modal" ref={modal} role="dialog" aria-modal="true" aria-labelledby="encoding-title">
      <div className="modal-heading"><div><div className="eyebrow">MAKE ROOM FOR YOUR MUSIC.</div><h2 id="encoding-title">{format==='mp3'?'MP3':'AAC / M4A'} {tr(" 编码设置")}</h2></div><button type="button" className="icon-button" aria-label={tr("关闭编码设置")} onClick={onClose}><X size={20}/></button></div>
      <p>{tr("CD 原始音频为 44.1 kHz / 16-bit / 立体声。压缩设置会影响音质和文件大小；提高采样率不会增加原始细节。")}</p>
      <div className="encoding-presets" aria-label={tr("编码预设")}>{[{name:tr("高音质"),bitrate:format==='mp3'?320:256},{name:tr("均衡"),bitrate:192},{name:tr("小体积"),bitrate:128}].map(preset=><button type="button" key={preset.name} onClick={()=>setDraft({... (format==='mp3'?defaultMp3:defaultAac),bitrateKbps:preset.bitrate})}>{preset.name}<span>{preset.bitrate} kbps</span></button>)}</div>
      <div className="encoding-fields">
        <label>{tr("采样率")}<select aria-label={tr("编码采样率")} value={draft.sampleRate} onChange={event=>patch({sampleRate:+event.target.value})}>{sampleRates.map(rate=><option key={rate} value={rate}>{rate/1000} kHz{rate===44100?tr(" · CD 原始"):''}</option>)}</select></label>
        <label>{tr("声道模式")}<select aria-label={tr("编码声道模式")} value={draft.channelMode} onChange={event=>patch({channelMode:event.target.value as EncodingOptions['channelMode']})}>{format==='mp3'&&<option value="jointStereo">{tr("联合立体声")}</option>}<option value="stereo">{tr("立体声")}</option><option value="mono">{tr("单声道")}</option></select></label>
        <label>{tr("码率模式")}<select aria-label={tr("编码码率模式")} value={draft.bitrateMode} disabled={format==='aac'} onChange={event=>patch({bitrateMode:event.target.value as EncodingOptions['bitrateMode']})}>{format==='aac'?<option value="cbr">{tr("目标码率 · AAC-LC")}</option>:<><option value="cbr">{tr("CBR · 固定码率")}</option><option value="abr">{tr("ABR · 平均码率")}</option><option value="vbr">{tr("VBR · 按音质分配码率")}</option></>}</select></label>
        {draft.bitrateMode==='vbr'?<label>{tr("VBR 音质")}<select aria-label={tr("VBR 音质")} value={draft.vbrQuality} onChange={event=>patch({vbrQuality:+event.target.value})}>{Array.from({length:10},(_,quality)=><option key={quality} value={quality}>V{quality}{quality===0?tr(" · 最高音质"):quality===2?tr(" · 推荐"):quality===9?tr(" · 最小体积"):''}</option>)}</select></label>:<label>{draft.bitrateMode==='abr'?tr("目标平均码率"):tr("码率")}<select aria-label={tr("编码码率")} value={draft.bitrateKbps} onChange={event=>patch({bitrateKbps:+event.target.value})}>{availableRates.map(rate=><option key={rate} value={rate}>{rate} kbps</option>)}</select></label>}
        {format==='mp3'&&<label>{tr("编码精度")}<select aria-label={tr("MP3 编码精度")} value={draft.encoderQuality} onChange={event=>patch({encoderQuality:+event.target.value})}>{Array.from({length:10},(_,quality)=><option key={quality} value={quality}>{quality}{quality===0?tr(" · 最高精度，较慢"):quality===2?tr(" · 推荐"):quality===9?tr(" · 最快"):''}</option>)}</select></label>}
      </div>
      <p className="encoding-help">{draft.bitrateMode==='vbr'?tr("VBR 音质数值越小，质量越高；文件大小取决于音乐内容。"):tr("可选码率会随采样率和声道数调整。实际平均码率与文件大小会略有浮动。")}{format==='mp3'?tr(" 编码精度数值越小，计算越细致、耗时越长。"):''}</p>
      <div className="encoding-preview"><span>{tr("本次输出")}</span><strong>{format==='aac'?'.m4a · AAC-LC':'.mp3 · LAME'}</strong><p>{encodingSummary(format,draft)}</p><small>{tr("自动写入已识别的曲名、专辑信息与封面。")}</small></div>
      <div className="modal-actions"><button className="secondary" type="button" onClick={onClose}>{tr("取消")}</button><button className="primary" type="button" onClick={()=>onSave(draft)}><Check size={16}/>{tr("保存编码设置")}</button></div>
    </div>
  </div>;
}
