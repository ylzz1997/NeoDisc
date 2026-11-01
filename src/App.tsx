import { tr, localizeMessage, setLanguage, useLocale } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { Disc3, Download, History, Palette, Search, ChevronRight, ChevronLeft, RefreshCw, ArrowUpFromLine as Eject, Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Minus, Square, X, FolderOpen, Check, CheckCheck, Sun, Moon, Monitor, Clock3, ArrowUpRight, Pencil, ListMusic, Headphones, SlidersHorizontal, LoaderCircle, CircleHelp, CheckCircle2, AlertCircle, AudioLines, Repeat2 } from 'lucide-react';
import type { AlbumMetadata, AudioOutput, Disc, Drive, HistoryEntry, Playback, Progress, Settings, Skin, ThemeMode } from './types';
import { duration, readSettings, resolveTheme } from './theme';
import Preferences from './Preferences';
import HistoryPage from './HistoryPage';
import EncodingSettings, { EncodingDialog } from './EncodingSettings';
import { isLossy } from './encoding';
import type { LossyFormat } from './types';
import { version } from '../package.json';
import appIcon from '../assets/neodisc.png';
import { withAutomaticMetadata, withManualMetadata } from './metadata';

const native = isTauri();
const emptyPlayback: Playback = { track: null, playing: false, position: 0, duration: 0, volume: 0.5, error: null, ended: false };
const previewDisc: Disc = { driveId: 'preview', title: '留一点时间，给音乐', artist: 'NeoDisc Studio · 界面示例', fingerprint: 'preview', tracks: ['First light / 初光','A quiet place / 安静的地方','Between the lines / 字里行间','Slow Sunday / 慢慢的星期天','After the rain / 雨后','Stay a little longer / 再停留片刻','Homeward / 归途','Until tomorrow / 明日再会'].map((title,i) => ({number:i+1,title,startSector:i*18000,sectors:[18300,16050,20475,15675,21750,18900,14100,19500][i],preEmphasis:false})) };
const getSkins = (): { id: Skin; name: string; detail: string; colors: string[] }[] => [
  { id:'graphite',name:tr("石墨 · 珊瑚"),detail:tr("安静底色，一点热烈"),colors:['#1a1a20','#fb6576','#a3a3b4'] },
  { id:'forest',name:tr("深林 · 青苔"),detail:tr("像森林一样，松弛下来"),colors:['#15211e','#8bc9ad','#82998e'] },
  { id:'amber',name:tr("暖夜 · 琥珀"),detail:tr("留住唱片店的温度"),colors:['#251e18','#e9b574','#9c8c7c'] },
];
function savedHistory(): HistoryEntry[] { try { const data=JSON.parse(localStorage.getItem('lucent.history')||'[]'); return Array.isArray(data)?data:[]; } catch { return []; } }
function saveLocal(key:string,value:unknown) { try {localStorage.setItem(key,JSON.stringify(value));} catch {/* Storage may be unavailable in private previews. */} }
function DiscArt({small=false, spinning=false, cover}:{small?:boolean;spinning?:boolean;cover?:string|null}) {
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[cover]);
  if(cover&&!failed)return <div className={`disc-art album-cover ${small?'small':''}`}><img src={cover} alt={tr("专辑封面")} onError={()=>setFailed(true)}/></div>;
  return <div className={`disc-art ${small?'small':''} ${spinning?'spinning':''}`} aria-hidden="true"><div className="art-grain"/><span className="art-label">NEODISC<br/>ORIGINAL SOUND</span><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="optical-disc"><div className="disc-ring"/><div className="disc-hole"/></div><div className="art-caption"><span>THE ART OF<br/>LISTENING.</span><span>33°<br/>44.1</span></div></div>;
}
function IconButton({label,children,onClick,disabled=false,className=''}:{label:string;children:React.ReactNode;onClick?:()=>void;disabled?:boolean;className?:string}) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

export default function App() {
  const locale=useLocale();
  const skins=getSkins();
  const [settings,setSettings]=useState<Settings>(readSettings);
  useEffect(()=>setLanguage(settings.language),[settings.language]);
  useEffect(()=>{document.documentElement.lang=locale;},[locale]);
  const [page,setPage]=useState<'disc'|'history'|'appearance'|'preferences'>('disc');
  const [drives,setDrives]=useState<Drive[]>([]),[driveId,setDriveId]=useState('');
  const [disc,setDisc]=useState<Disc|null>(native?null:previewDisc);
  const [artwork,setArtwork]=useState<{fingerprint:string;cover:string|null}|null>(null);
  const discLoad=useRef(0);
  const [selected,setSelected]=useState<number[]>(native?[]:previewDisc.tracks.map(t=>t.number));
  const [search,setSearch]=useState(''),[busy,setBusy]=useState(''),[deviceMessage,setDeviceMessage]=useState(tr("正在寻找光驱…"));
  const [playback,setPlayback]=useState<Playback>(emptyPlayback);
  const [audioOutput,setAudioOutput]=useState<AudioOutput|null>(null);
  const [audioBusy,setAudioBusy]=useState(false),[audioReady,setAudioReady]=useState(!native);
  const [progress,setProgress]=useState<Progress|null>(null),[ripping,setRipping]=useState(false);
  const [history,setHistory]=useState<HistoryEntry[]>(savedHistory);
  const [encodingEdit,setEncodingEdit]=useState<LossyFormat|null>(null);
  const [notice,setNotice]=useState<{message:string;error:boolean}|null>(null);
  const [editing,setEditing]=useState<Disc|null>(null),[closeConfirm,setCloseConfirm]=useState(false);
  const [loop,setLoop]=useState(false),[seek,setSeek]=useState<number|null>(null);
  const [theme,setTheme]=useState('dark');
  const initialized=useRef(false),discRef=useRef(disc),ripRef=useRef(false),loopRef=useRef(false),closeAfterRip=useRef(false),previousPlayback=useRef(emptyPlayback),noticeTimer=useRef<ReturnType<typeof setTimeout>|null>(null),lastError=useRef('');
  discRef.current=disc; ripRef.current=ripping; loopRef.current=loop;
  const patch=(value:Partial<Settings>)=>setSettings(s=>({...s,...value}));
  function commitEdits(edited:Disc){
    saveLocal(`lucent.disc.${edited.fingerprint}`,{title:edited.title,artist:edited.artist,tracks:edited.tracks.map(({number,title})=>({number,title}))});
    // A lookup may have completed while the editor was open. Keep its cover ID
    // and current disc geometry while applying only the text the user edited.
    setDisc(current=>current?.fingerprint===edited.fingerprint?{...current,title:edited.title,artist:edited.artist,tracks:current.tracks.map(t=>({...t,title:edited.tracks.find(e=>e.number===t.number)?.title||t.title}))}:current);
    setEditing(null);toast(tr("专辑信息已保存，抓轨时会写入音频标签。"));
  }
  const toast=(message:string,error=false)=>{setNotice({message,error});if(noticeTimer.current)clearTimeout(noticeTimer.current);noticeTimer.current=setTimeout(()=>setNotice(null),error?14000:6000);};
  const guarded=async(action:()=>Promise<unknown>)=>{try{await action();}catch(e){toast(String(e),true);}};
  const changeVolume=(value:number)=>{patch({volume:value});if(native)void guarded(()=>invoke('player_action',{action:'volume',value}));};
  async function selectOutput(deviceName:string|null){
    if(!native||audioBusy)return;
    patch({outputDevice:deviceName});setAudioBusy(true);
    try{setAudioOutput(await invoke<AudioOutput>('select_audio_output',{deviceName}));}
    catch(e){toast(String(e),true);}finally{setAudioBusy(false);}
  }
  async function refreshOutput(reconnect:boolean){
    if(!native||audioBusy)return;setAudioBusy(true);
    try{setAudioOutput(await invoke<AudioOutput>('refresh_audio_outputs',{reconnect}));if(reconnect)toast(tr("音频输出已重新连接。"));}
    catch(e){toast(String(e),true);}finally{setAudioBusy(false);}
  }
  useEffect(()=>{saveLocal('lucent.settings',settings);const query=matchMedia('(prefers-color-scheme: dark)');const apply=()=>{const t=resolveTheme(settings,new Date(),query.matches);document.documentElement.dataset.theme=t;document.documentElement.dataset.skin=settings.skin;setTheme(t);};apply();query.addEventListener('change',apply);document.addEventListener('visibilitychange',apply);const timer=setInterval(apply,15000);return()=>{query.removeEventListener('change',apply);document.removeEventListener('visibilitychange',apply);clearInterval(timer);};},[settings]);
  useEffect(()=>{saveLocal('lucent.history',history);},[history]);

  function removeHistory(ids:string[]) {
    const removedIds=new Set(ids);
    setHistory(current=>current.filter(entry=>!removedIds.has(entry.id)));
  }
  function restoreHistory(entries:HistoryEntry[]) {
    setHistory(current=>{
      const currentIds=new Set(current.map(entry=>entry.id));
      return [...current,...entries.filter(entry=>!currentIds.has(entry.id))]
        .sort((a,b)=>Date.parse(b.date)-Date.parse(a.date)).slice(0,100);
    });
  }

  async function loadDisc(id:string) {
    const generation=++discLoad.current;
    setArtwork(null);
    setBusy('read');setDeviceMessage(tr("正在读取光盘目录…"));
    try {const data=withManualMetadata(await invoke<Disc>('read_disc',{driveId:id}));
      if(generation!==discLoad.current)return;
      setDisc(data);setSelected(data.tracks.map(t=>t.number));setDeviceMessage(tr("{v0} 首曲目 · Audio CD",{v0:data.tracks.length}));setProgress(null);setPlayback(emptyPlayback);setSearch('');
      // Network lookup runs after the disc is usable and never holds playback/ripping busy.
      void invoke<AlbumMetadata|null>('identify_disc',{disc:data}).then(meta=>{
        if(!meta||generation!==discLoad.current)return;
        setDisc(current=>current?.fingerprint===data.fingerprint&&current.driveId===data.driveId?withAutomaticMetadata(current,meta):current);
        setArtwork({fingerprint:data.fingerprint,cover:meta.cover});
      }).catch(()=>{/* Missing/offline metadata intentionally leaves the default display. */});
    }catch(e){if(generation===discLoad.current){setDisc(null);setSelected([]);setPlayback(emptyPlayback);setDeviceMessage(String(e));}}finally{if(generation===discLoad.current)setBusy('');}
  }
  async function refresh() {
    if(!native){toast(tr("这是浏览器界面预览；请打开桌面版连接光驱。"));return;}
    if(ripRef.current)return;setBusy('scan');
    try{const list=await invoke<Drive[]>('list_drives');setDrives(list);const id=list.find(d=>d.id===driveId)?.id||list[0]?.id||'';setDriveId(id);if(id){await loadDisc(id);}else{++discLoad.current;setArtwork(null);setDisc(null);setSelected([]);setDeviceMessage(tr("未发现音频光驱。连接 USB 光驱并放入 CD 后，点击刷新。"));}}catch(e){setDeviceMessage(String(e));}finally{setBusy('');}
  }
  useEffect(()=>{
    if(initialized.current)return;initialized.current=true;
    if(native){void refresh();void invoke<string>('default_output').then(path=>setSettings(s=>({...s,outputDir:s.outputDir||path}))).catch(e=>toast(String(e),true));void invoke('player_action',{action:'volume',value:settings.volume}).catch(e=>toast(String(e),true));void invoke<AudioOutput>('select_audio_output',{deviceName:settings.outputDevice}).then(setAudioOutput).catch(e=>toast(String(e),true)).finally(()=>setAudioReady(true));}
    else setDeviceMessage(tr("界面预览 · 未连接实体光驱"));
  },[]);
  useEffect(()=>{
    if(!native)return;let active=true,polling=false;let unlisten:(()=>void)|undefined,unclose:(()=>void)|undefined;
    void listen<Progress>('rip-progress',event=>{if(active)setProgress(event.payload);}).then(fn=>{if(active)unlisten=fn;else fn();});
    void getCurrentWindow().onCloseRequested(event=>{if(ripRef.current){event.preventDefault();setCloseConfirm(true);}}).then(fn=>{if(active)unclose=fn;else fn();});
    const timer=setInterval(async()=>{if(polling)return;polling=true;try{const next=await invoke<Playback>('playback_status');if(!active)return;const previous=previousPlayback.current;previousPlayback.current=next;setPlayback(next);
      if(next.output)setAudioOutput(next.output);
      const error=next.error||next.output?.error||'';
      if(error&&error!==lastError.current)toast(error,true);
      lastError.current=error;
      const current=discRef.current;
      if(previous.playing&&!next.playing&&next.ended&&!next.error&&next.track!==null&&current&&!ripRef.current){const index=current.tracks.findIndex(t=>t.number===next.track);const following=current.tracks[index+1]||(loopRef.current?current.tracks[0]:null);if(following)void invoke('play_track',{disc:current,track:following.number,position:0}).catch(e=>toast(String(e),true));}
    }catch{/* A closing native window can stop accepting IPC. */}finally{polling=false;}},250);
    return()=>{active=false;clearInterval(timer);unlisten?.();unclose?.();};
  },[]);
  async function play(number?:number,position=0){
    if(!native){toast(tr("预览中不模拟播放；桌面版会读取真实 CD 音频。"));return;}
    if(!disc||ripping||busy||audioBusy||!audioReady)return;setBusy('play');lastError.current='';
    try{await invoke('play_track',{disc,track:number??disc.tracks[0].number,position});setPlayback(await invoke<Playback>('playback_status'));}catch(e){toast(String(e),true);}finally{setBusy('');}
  }
  async function togglePlayback(){
    if(!native){toast(tr("请在桌面版中播放实体 CD。"));return;}
    if(!disc||ripping||busy||audioBusy||!audioReady)return;
    if(playback.track===null||playback.ended){await play(playback.track??undefined);return;}
    await guarded(async()=>{await invoke('player_action',{action:playback.playing?'pause':'resume'});setPlayback(await invoke<Playback>('playback_status'));});
  }
  const skip=(direction:number)=>{if(!disc)return;const index=disc.tracks.findIndex(t=>t.number===playback.track);const next=disc.tracks[(Math.max(0,index)+direction+disc.tracks.length)%disc.tracks.length];void play(next.number);};
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.code==='Space'&&!['INPUT','TEXTAREA','SELECT','BUTTON'].includes((e.target as HTMLElement).tagName)&&!editing&&!closeConfirm&&!encodingEdit){e.preventDefault();void togglePlayback();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);});
  async function chooseFolder(){if(!native){toast(tr("桌面版支持选择本地文件夹。"));return;}await guarded(async()=>{const path=await open({directory:true,multiple:false,title:tr("选择抓轨保存位置"),defaultPath:settings.outputDir||undefined});if(typeof path==='string')patch({outputDir:path});});}
  async function rip(){
    if(!native){toast(tr("这是界面预览，不会生成抓轨文件。请使用桌面版。"));return;}
    if(!disc||!selected.length||ripping||busy)return;
    const request={disc,tracks:selected,format:settings.format,outputDir:settings.outputDir,verify:settings.verify,encoding:isLossy(settings.format)?settings[settings.format]:null};
    setRipping(true);ripRef.current=true;setProgress({phase:'starting',track:selected[0],completed:0,total:selected.length,fraction:0,message:tr("正在准备读取光盘…"),outputDir:''});
    try{const path=await invoke<string>('start_rip',{request});setHistory(h=>[{id:crypto.randomUUID(),title:disc.title,artist:disc.artist,date:new Date().toISOString(),format:settings.format.toUpperCase(),tracks:selected.length,path,verified:settings.verify,encoding:request.encoding??undefined},...h].slice(0,100));toast(tr("抓轨完成，已保存 {v0} 首曲目。",{v0:selected.length}));}
    catch(e){const message=String(e);setProgress(p=>p?{...p,phase:'stopped',message}:null);toast(message,!message.startsWith('已取消'));}
    finally{setRipping(false);ripRef.current=false;if(closeAfterRip.current)void getCurrentWindow().close();}
  }
  const cancel=()=>guarded(async()=>{await invoke('cancel_rip');setProgress(p=>p?{...p,phase:'cancelling',message:tr("正在取消，保留已完成的曲目…")}:null);});
  async function windowAction(action:'minimize'|'maximize'|'close') {if(!native)return;if(action==='close'&&ripping){setCloseConfirm(true);return;}await guarded(()=>action==='minimize'?getCurrentWindow().minimize():action==='maximize'?getCurrentWindow().toggleMaximize():getCurrentWindow().close());}
  const currentTrack=disc?.tracks.find(t=>t.number===playback.track);
  const selectedTracks=disc?.tracks.filter(t=>selected.includes(t.number))||[];
  const seconds=disc?.tracks.reduce((sum,t)=>sum+t.sectors/75,0)||0;
  const selectedBytes=selectedTracks.reduce((sum,t)=>sum+t.sectors*2352,0);
  const visibleTracks=disc?.tracks.filter(t=>`${t.title} ${t.number}`.toLowerCase().includes(search.toLowerCase()))||[];
  const allSelected=!!disc&&selected.length===disc.tracks.length;
  const playbackDisabled=!disc||ripping||!!busy||audioBusy||!audioReady;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand" data-tauri-drag-region><img className="app-icon" src={appIcon} alt=""/><span>NeoDisc<span className="brand-dot">.</span></span></div>
      <div className="nav-label">{tr("音乐，回到手中")}</div>
      <nav aria-label={tr("主要导航")}>
        <button className={page==='disc'?'active':''} onClick={()=>setPage('disc')}><Disc3 size={20}/>{tr("我的 CD")}<span className="nav-dot"/></button>
        <button className={page==='history'?'active':''} onClick={()=>setPage('history')}><History size={20}/>{tr("抓轨记录")}{history.length>0&&<span className="nav-count">{history.length}</span>}</button>
      </nav>
      <div className="sidebar-divider"/><div className="nav-label">{tr("让这里，更像你")}</div>
      <nav><button className={page==='appearance'?'active':''} onClick={()=>setPage('appearance')}><Palette size={20}/>{tr("外观与皮肤")}</button><button className={page==='preferences'?'active':''} onClick={()=>setPage('preferences')}><SlidersHorizontal size={20}/>{tr("首选项")}</button></nav>
      <div className="sidebar-bottom">
        <div className="device-box"><div className="device-icon"><Disc3 size={22}/><i className={disc?'connected':''}/></div><div><strong>{disc?tr("光盘已就绪"):tr("等待一张好唱片")}</strong><span>{native?(driveId||tr("连接你的光驱")):tr("浏览器预览")}</span></div></div>
        <div className="sidebar-foot"><span>NEODISC <small>{version}</small></span><Headphones size={15}/></div>
      </div>
    </aside>

    <div className="main-shell">
      <header className="topbar" data-tauri-drag-region>
        <IconButton label={tr("返回我的 CD")} onClick={()=>setPage('disc')}><ChevronLeft size={20}/></IconButton>
        <label className="search-box"><Search size={18}/><input placeholder={tr("搜索当前 CD 的曲目")} aria-label={tr("搜索当前 CD 的曲目")} value={search} onChange={e=>{setSearch(e.target.value);setPage('disc');}}/><span>⌕</span></label>
        <div className="topbar-space" data-tauri-drag-region/>
        <span className="local-badge"><i/>{tr("本地聆听")}</span>
        <IconButton label={tr("更换皮肤")} onClick={()=>setPage('appearance')}><Palette size={19}/></IconButton>
        <IconButton label={theme==='dark'?tr("切换浅色模式"):tr("切换深色模式")} onClick={()=>patch({mode:theme==='dark'?'light':'dark'})}>{theme==='dark'?<Moon size={19}/>:<Sun size={19}/>}</IconButton>
        <span className="window-divider"/>
        <div className="window-buttons"><IconButton label={tr("最小化")} onClick={()=>void windowAction('minimize')}><Minus size={18}/></IconButton><IconButton label={tr("最大化或还原")} onClick={()=>void windowAction('maximize')}><Square size={14}/></IconButton><IconButton className="window-close" label={tr("关闭窗口")} onClick={()=>void windowAction('close')}><X size={19}/></IconButton></div>
      </header>

      <main className="content">
        {!native&&<div className="preview-banner"><Monitor size={15}/>{tr("界面预览 · 示例曲目仅用于展示，播放和抓轨需要桌面版。")}</div>}
        {page==='preferences'&&<Preferences native={native} onLanguage={language=>patch({language})} settings={settings} output={audioOutput} changing={audioBusy||!audioReady} onSelect={name=>void selectOutput(name)} onRefresh={reconnect=>void refreshOutput(reconnect)} onVolume={changeVolume} onAppearance={()=>setPage('appearance')}/>}
        {page==='disc'&&<>
          <div className="page-heading"><div><div className="eyebrow">YOUR DISC. YOUR COLLECTION.</div><h1>{tr("让音乐，慢下来")}<span className="accent">{tr("。")}</span></h1></div><div className="drive-controls"><select aria-label={tr("选择光驱")} disabled={ripping||!!busy} value={driveId} onChange={e=>{setDriveId(e.target.value);void loadDisc(e.target.value);}}>{drives.length?drives.map(d=><option key={d.id} value={d.id}>{localizeMessage(d.name)}</option>):<option value="">{native?tr("未发现光驱"):tr("演示光盘")}</option>}</select><IconButton label={tr("刷新光盘")} onClick={()=>void refresh()} disabled={ripping||!!busy}><RefreshCw size={17} className={busy==='read'||busy==='scan'?'spin':''}/></IconButton><IconButton label={tr("弹出光盘")} disabled={!native||!driveId||ripping||!!busy} onClick={()=>void guarded(async()=>{await invoke('eject_disc',{driveId});++discLoad.current;setArtwork(null);setDisc(null);setSelected([]);setPlayback(emptyPlayback);setDeviceMessage(tr("光盘已弹出，放入下一张 CD 后刷新。"));})}><Eject size={18}/></IconButton></div></div>

          <div className="disc-layout"><section className="collection">
            <div className="album-hero"><DiscArt spinning={playback.playing} cover={artwork?.fingerprint===disc?.fingerprint?artwork?.cover:null}/><div className="album-info"><div className="album-type"><span className="pill">AUDIO CD</span><span>{tr("一张唱片，一段时光")}</span></div><h2>{disc?.title||tr("下一张，听什么？")}</h2><p className="artist">{disc?.artist||tr("连接光驱，重新发现你的 CD 收藏")}</p><div className="album-meta"><span>{disc?tr("{v0} 首曲目",{v0:disc.tracks.length}):tr("等待光盘")}</span><i/>{disc?<span>{Math.floor(seconds/60)} {tr(" 分钟 ")}{Math.floor(seconds%60)} {tr(" 秒")}</span>:<span>Windows & macOS</span>}</div><div className="quality-tags"><span>{tr("无损音质")}</span><span>44.1 kHz</span><span>16 bit · Stereo</span></div><div className="album-actions"><button className="primary" disabled={playbackDisabled} onClick={()=>void play()}>{busy==='play'?<LoaderCircle size={17} className="spin"/>:<Play size={16} fill="currentColor"/>}{tr("播放全部")}</button><button className="secondary" disabled={!disc||ripping} onClick={()=>setEditing(structuredClone(disc))}><Pencil size={15}/>{tr("编辑信息")}</button></div></div></div>
            <div className="track-toolbar"><div className="track-tab">{tr("曲目列表 ")}<span>{disc?.tracks.length||0}</span></div><span className="track-selection">{selected.length?tr("已选 {v0} 首",{v0:selected.length}):tr("选择想要保存的音乐")}</span></div>
            {disc?<><div className="track-table"><div className="track-header"><input type="checkbox" aria-label={tr("选择全部曲目")} checked={allSelected} disabled={ripping} onChange={()=>setSelected(allSelected?[]:disc.tracks.map(t=>t.number))}/><span>#</span><span>{tr("音乐标题")}</span><span>{tr("音质")}</span><Clock3 size={14}/></div>{visibleTracks.map(t=><div key={t.number} className={`track-row ${playback.track===t.number?'current':''}`} onDoubleClick={()=>void play(t.number)}><input type="checkbox" aria-label={tr("选择 {v0}",{v0:t.title})} checked={selected.includes(t.number)} disabled={ripping} onChange={()=>setSelected(s=>s.includes(t.number)?s.filter(n=>n!==t.number):[...s,t.number])}/><button className="track-number" aria-label={tr("播放 {v0}",{v0:t.title})} onClick={()=>void play(t.number)} disabled={playbackDisabled}>{playback.track===t.number&&playback.playing?<AudioLines size={17}/>:<><span>{String(t.number).padStart(2,'0')}</span><Play size={13} fill="currentColor"/></>}</button><div className="track-title"><span>{t.title}</span>{t.preEmphasis&&<small title={tr("原始音频带预加重；当前不应用去加重处理")}>{tr("预加重")}</small>}</div><span className="lossless-label">LOSSLESS</span><time>{duration(t.sectors/75)}</time></div>)}{visibleTracks.length===0&&<div className="empty-search">{tr("没有找到“")}{search}{tr("”，试试曲目编号。")}</div>}</div><div className="table-foot"><Disc3 size={14}/><span>{native?tr("直接聆听光盘中的原始音频"):tr("当前为示例专辑")}</span><span>{tr("双击曲目即可播放")}</span></div></>:<div className="empty-disc"><Disc3 size={44}/><h3>{busy?tr("正在读取你的唱片"):tr("好音乐，值得再听一次")}</h3><p>{localizeMessage(deviceMessage)}</p><button className="secondary" disabled={!!busy} onClick={()=>void refresh()}><RefreshCw size={16}/>{tr("重新扫描")}</button></div>}
          </section>

          <aside className="rip-panel"><div className="panel-heading"><div className="panel-icon"><Download size={20}/></div><div><h3>{tr("收藏到本地")}</h3><p>{tr("让喜欢的音乐，长久留下")}</p></div></div><div className="rip-divider"/><EncodingSettings settings={settings} disabled={ripping} onFormat={format=>patch({format})} onEdit={setEncodingEdit}/><label className="field-label">{tr("保存位置")}</label><button className="folder-picker" title={settings.outputDir} disabled={ripping} onClick={()=>void chooseFolder()}><FolderOpen size={17}/><span>{settings.outputDir?settings.outputDir.replace(/\\/g,'/').split('/').slice(-2).join('/'):tr("选择文件夹")}</span><ChevronRight size={14}/></button><div className="verify-row"><div><strong>{tr("重复读取比对")}</strong><span>{tr("每段读取两次，检查一致性")}</span></div><button role="switch" aria-checked={settings.verify} aria-label={tr("重复读取比对")} className={`toggle ${settings.verify?'on':''}`} disabled={ripping} onClick={()=>patch({verify:!settings.verify})}><i/></button></div><div className="rip-summary"><span>{tr("已选曲目")}<strong>{selected.length} <small>{tr("首")}</small></strong></span><span>{tr("原始音频大小")}<strong>{Math.round(selectedBytes/1024/1024)} <small>MB</small></strong></span></div>
            {progress&&<div className={`rip-progress ${progress.phase}`} aria-live="polite"><div><span>{progress.phase==='complete'?<CheckCircle2 size={15}/>:ripping?<LoaderCircle size={15} className="spin"/>:<AlertCircle size={15}/>}<strong>{progress.phase==='complete'?tr("已保存到本地"):progress.phase==='stopped'?tr("任务已停止"):tr("正在抓轨")}</strong></span><b>{Math.round(progress.fraction*100)}%</b></div><progress max="1" value={progress.fraction}/><p>{localizeMessage(progress.message)}</p>{progress.outputDir&&!ripping&&<button className="text-button" onClick={()=>void guarded(()=>invoke('open_folder',{path:progress.outputDir}))}>{tr("打开输出文件夹 ")}<ArrowUpRight size={13}/></button>}</div>}
            {ripping?<button className="secondary rip-start" onClick={()=>void cancel()} disabled={progress?.phase==='cancelling'}><X size={17}/>{tr("取消抓轨")}</button>:<button className="primary rip-start" disabled={!disc||!selected.length||!!busy} onClick={()=>void rip()}><Download size={17}/>{tr("开始抓轨 ")}<span>{selected.length}</span></button>}<p className="rip-footnote"><CheckCheck size={14}/>{tr("本地处理 · 不上传音频")}</p><div className="read-note"><CircleHelp size={14}/><span>{tr("重复比对可能命中缓存，不等同于 AccurateRip 校验。原有文件不会被覆盖。")}</span></div>
          </aside></div>
        </>}

        {page==='appearance'&&<div className="appearance-page"><div className="page-heading"><div><div className="eyebrow">MAKE YOURSELF AT HOME.</div><h1>{tr("你的音乐，你的颜色")}<span className="accent">{tr("。")}</span></h1><p className="page-subtitle">{tr("换一种心情，继续听。")}</p></div><Palette className="heading-illustration" size={48}/></div><section className="settings-section"><h2>{tr("选一款皮肤")}</h2><p>{tr("同一套配色，也有日与夜的两种模样。")}</p><div className="skin-grid">{skins.map(s=><button key={s.id} className={`skin-card ${settings.skin===s.id?'chosen':''}`} onClick={()=>patch({skin:s.id})}><div className="skin-preview" style={{background:s.colors[0],'--swatch':s.colors[1]} as React.CSSProperties}><div className="mini-sidebar"><i/><i/><i/></div><div className="mini-content"><div className="mini-search"/><div className="mini-album"><div/><span><i/><i/><i/></span></div><div className="mini-lines"><i/><i/><i/></div></div><div className="mini-player"><i/><span/><b>▶</b></div></div><div className="skin-description"><div><strong>{s.name}</strong><span>{s.detail}</span></div><div className="skin-check">{settings.skin===s.id&&<Check size={15}/>}</div></div></button>)}</div></section><section className="settings-section"><h2>{tr("明暗模式")}</h2><p>{tr("手动选择，或让 NeoDisc 随时间安静下来。")}</p><div className="mode-grid" role="radiogroup" aria-label={tr("明暗模式")}>{([{id:'light',label:tr("浅色"),icon:Sun},{id:'dark',label:tr("深色"),icon:Moon},{id:'system',label:tr("跟随系统"),icon:Monitor},{id:'schedule',label:tr("定时夜间"),icon:Clock3}] as {id:ThemeMode;label:string;icon:typeof Sun}[]).map(m=><button key={m.id} role="radio" aria-checked={settings.mode===m.id} className={settings.mode===m.id?'selected':''} onClick={()=>patch({mode:m.id})}><m.icon size={22}/><span>{m.label}</span>{settings.mode===m.id&&<Check size={14}/>}</button>)}</div>{settings.mode==='schedule'&&<div className="schedule-panel"><div><Moon size={20}/><span><strong>{tr("自动夜间模式")}</strong><small>{tr("按本机时间切换，白天使用浅色。")}</small></span></div><label>{tr("开始")}<input type="time" aria-label={tr("夜间模式开始时间")} value={settings.nightStart} onChange={e=>e.target.value&&patch({nightStart:e.target.value})}/></label><span>—</span><label>{tr("结束")}<input type="time" aria-label={tr("夜间模式结束时间")} value={settings.nightEnd} onChange={e=>e.target.value&&patch({nightEnd:e.target.value})}/></label></div>}<div className="settings-hint"><CheckCircle2 size={15}/>{tr("设置即时生效，自动保存在这台电脑。")}{settings.mode==='schedule'&&settings.nightStart===settings.nightEnd?tr("开始与结束相同，全天保持深色。"):''}</div></section><div className="about-strip"><div className="brand-mark"><Disc3 size={22}/></div><div><strong>NeoDisc <span>{version}</span></strong><p>{tr("为实体唱片，留一个现代的家。")}</p></div><span>Windows · macOS</span></div></div>}

        {page==='history'&&<HistoryPage entries={history} native={native} artwork={<DiscArt small/>} onRemove={removeHistory} onRestore={restoreHistory} onDisc={()=>setPage('disc')} onError={message=>toast(message,true)} onNotice={message=>toast(message)}/>}
      </main>
    </div>

    <footer className="player"><div className="now-playing"><DiscArt small spinning={playback.playing} cover={artwork?.fingerprint===disc?.fingerprint?artwork?.cover:null}/><div><strong>{currentTrack?.title||tr("此刻，留给音乐")}</strong><span>{currentTrack?(currentTrack.artist||disc?.artist):tr("选择一首曲目，开始聆听")}</span></div></div><div className="transport"><div className="transport-buttons"><IconButton className={loop?'is-active':''} label={loop?tr("关闭列表循环"):tr("开启列表循环")} onClick={()=>setLoop(!loop)}><Repeat2 size={17}/></IconButton><IconButton label={tr("上一曲")} onClick={()=>skip(-1)} disabled={playbackDisabled}><SkipBack size={20} fill="currentColor"/></IconButton><button className="play-button" aria-label={playback.playing?tr("暂停"):tr("播放")} disabled={playbackDisabled} onClick={()=>void togglePlayback()}>{busy==='play'?<LoaderCircle size={24} className="spin"/>:playback.playing?<Pause size={24} fill="currentColor"/>:<Play size={24} fill="currentColor"/>}</button><IconButton label={tr("下一曲")} onClick={()=>skip(1)} disabled={playbackDisabled}><SkipForward size={20} fill="currentColor"/></IconButton><IconButton label={tr("显示曲目列表")} onClick={()=>setPage('disc')}><ListMusic size={20}/></IconButton></div><div className="timeline"><time>{duration(seek??playback.position)}</time><input type="range" min="0" max={playback.duration||1} step="0.1" value={seek??playback.position} disabled={!currentTrack||playbackDisabled} aria-label={tr("播放进度")} style={{'--range-fill':`${((seek??playback.position)/(playback.duration||1))*100}%`} as React.CSSProperties} onChange={e=>setSeek(+e.target.value)} onPointerUp={e=>{const value=+e.currentTarget.value;setSeek(null);void play(playback.track??undefined,value);}} onKeyUp={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){const value=+e.currentTarget.value;setSeek(null);void play(playback.track??undefined,value);}}}/><time>{duration(playback.duration)}</time></div></div><div className="player-right"><span className="quality-badge">{tr("无损")}</span><IconButton label={settings.volume===0?tr("取消静音"):tr("静音")} onClick={()=>{const value=settings.volume===0?0.5:0;patch({volume:value});if(native)void guarded(()=>invoke('player_action',{action:'volume',value}));}}>{settings.volume===0?<VolumeX size={19}/>:<Volume2 size={19}/>}</IconButton><input type="range" min="0" max="1" step="0.01" aria-label={tr("音量")} value={settings.volume} style={{'--range-fill':`${settings.volume*100}%`} as React.CSSProperties} onChange={e=>{const value=+e.target.value;patch({volume:value});if(native)void guarded(()=>invoke('player_action',{action:'volume',value}));}}/><IconButton label={tr("打开首选项")} className={audioOutput?.error?'output-error':''} onClick={()=>setPage('preferences')}><SlidersHorizontal size={19}/></IconButton></div></footer>

    {encodingEdit&&<EncodingDialog format={encodingEdit} options={settings[encodingEdit]} onClose={()=>setEncodingEdit(null)} onSave={options=>{patch(encodingEdit==='mp3'?{mp3:options}:{aac:options});setEncodingEdit(null);}}/>}
    {notice&&<div className={`toast ${notice.error?'error':''}`} role={notice.error?'alert':'status'}>{notice.error?<AlertCircle size={18}/>:<CheckCircle2 size={18}/>}<span>{localizeMessage(notice.message)}</span><IconButton label={tr("关闭提示")} onClick={()=>setNotice(null)}><X size={16}/></IconButton></div>}
    {editing&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setEditing(null);}}><form className="modal metadata-modal" role="dialog" aria-modal="true" aria-labelledby="edit-title" onSubmit={e=>{e.preventDefault();commitEdits(editing);}}><div className="modal-heading"><div><div className="eyebrow">MAKE IT YOURS</div><h2 id="edit-title">{tr("编辑专辑信息")}</h2></div><IconButton label={tr("关闭编辑")} onClick={()=>setEditing(null)}><X size={20}/></IconButton></div><p>{tr("信息保存在本机。FLAC、MP3 与 AAC 写入内嵌标签，WAV 附带专辑日志。")}</p><div className="metadata-fields"><label>{tr("专辑名称")}<input autoFocus required maxLength={150} value={editing.title} onChange={e=>setEditing({...editing,title:e.target.value})}/></label><label>{tr("艺术家")}<input required maxLength={150} value={editing.artist} onChange={e=>setEditing({...editing,artist:e.target.value})}/></label></div><div className="edit-tracks">{editing.tracks.map(t=><label key={t.number}><span>{String(t.number).padStart(2,'0')}</span><input required maxLength={150} aria-label={tr("曲目 {v0} 的名称",{v0:t.number})} value={t.title} onChange={e=>setEditing({...editing,tracks:editing.tracks.map(v=>v.number===t.number?{...v,title:e.target.value}:v)})}/><time>{duration(t.sectors/75)}</time></label>)}</div><div className="modal-actions"><button className="secondary" type="button" onClick={()=>setEditing(null)}>{tr("取消")}</button><button className="primary" type="submit"><Check size={16}/>{tr("保存信息")}</button></div></form></div>}
    {closeConfirm&&<div className="modal-backdrop"><div className="modal close-modal" role="dialog" aria-modal="true" aria-labelledby="close-title"><Download size={28} className="accent"/><h2 id="close-title">{tr("正在为你保存音乐")}</h2><p>{tr("关闭窗口会取消当前抓轨。已经完成的曲目会保留，未完成的文件会清理。")}</p><div className="modal-actions"><button className="secondary" onClick={()=>setCloseConfirm(false)}>{tr("继续抓轨")}</button><button className="primary" onClick={()=>{closeAfterRip.current=true;setCloseConfirm(false);void cancel();}}>{tr("取消抓轨并关闭")}</button></div></div></div>}
  </div>;
}
