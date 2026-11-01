import { tr, getLocale } from './i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertCircle, CheckCircle2, Disc3, FolderOpen, FolderX, History, ListMusic, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import type { HistoryEntry } from './types';
import { encodingSummary } from './encoding';

type DirectoryState = 'available' | 'missing' | 'unavailable';
type DirectoryStates = Record<string, DirectoryState>;

interface Props {
  entries: HistoryEntry[];
  native: boolean;
  artwork: ReactNode;
  onRemove: (ids: string[]) => void;
  onRestore: (entries: HistoryEntry[]) => void;
  onDisc: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export default function HistoryPage({ entries, native, artwork, onRemove, onRestore, onDisc, onError, onNotice }: Props) {
  const [directories, setDirectories] = useState<DirectoryStates>({});
  const [checking, setChecking] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [removed, setRemoved] = useState<{ entries: HistoryEntry[]; bulk: boolean } | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const mounted = useRef(false), cleanupInFlight = useRef(false), checkGeneration = useRef(0);
  const missingCount = entries.filter(entry => directories[entry.path] === 'missing').length;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!native || !entries.length) {
      setDirectories({});
      setChecking(false);
      refreshRef.current = () => {};
      return;
    }
    let active = true, pending = false;
    const paths = [...new Set(entries.map(entry => entry.path))];
    const refresh = async () => {
      if (!active || pending || cleanupInFlight.current) return;
      pending = true;
      const generation = ++checkGeneration.current;
      setChecking(true);
      try {
        const states = await invoke<DirectoryStates>('check_history_directories', { paths });
        if (active && generation === checkGeneration.current) setDirectories(states);
      } catch {
        // An inaccessible volume or a failed check is not proof of deletion.
        if (active && generation === checkGeneration.current) setDirectories(Object.fromEntries(paths.map(path => [path, 'unavailable'])));
      } finally {
        pending = false;
        if (active) setChecking(false);
      }
    };
    const refreshVisible = () => { if (!document.hidden) void refresh(); };
    refreshRef.current = () => { void refresh(); };
    void refresh();
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    const timer = setInterval(refreshVisible, 5000);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [entries, native]);

  async function cleanMissing() {
    if (!native || !entries.length || cleanupInFlight.current) return;
    cleanupInFlight.current = true;
    ++checkGeneration.current;
    setCleaning(true);
    const snapshot = entries;
    try {
      // Always recheck every directory: a folder may have been restored since
      // the last poll. Unknown/inaccessible paths are never cleanup candidates.
      const paths = [...new Set(snapshot.map(entry => entry.path))];
      const states = await invoke<DirectoryStates>('check_history_directories', { paths });
      if (!mounted.current) return;
      setDirectories(states);
      const missing = snapshot.filter(entry => states[entry.path] === 'missing');
      if (missing.length) {
        setRemoved({ entries:missing, bulk:true });
        onRemove(missing.map(entry => entry.id));
      } else {
        onNotice(tr("没有需要清理的记录。仅清理目录不存在的记录。"));
      }
    } catch {
      if (mounted.current) onError(tr("暂时无法检查目录，未清理任何记录。请稍后重试。"));
    } finally {
      cleanupInFlight.current = false;
      if (mounted.current) {
        setCleaning(false);
        refreshRef.current();
      }
    }
  }

  async function openFolder(entry: HistoryEntry) {
    try {
      await invoke('open_folder', { path: entry.path });
    } catch (error) {
      refreshRef.current();
      onError(String(error));
    }
  }

  return <div className="history-page">
    <div className="page-heading">
      <div>
        <div className="eyebrow">SAVED FOR ANOTHER DAY.</div>
        <h1>{tr("音乐，已经留下")}<span className="accent">{tr('。')}</span></h1>
        <p className="page-subtitle">{entries.length ? tr("{v0} 次完成的抓轨，随时回到熟悉的旋律。",{v0:entries.length}) : tr("每一次保存，都是一次重新收藏。")}</p>
      </div>
      <div className="history-heading-actions">
        {entries.length > 0 && <>
          <button type="button" className="secondary history-cleanup" aria-label={tr("一键清理失效记录")} title={tr("重新检查并清理目录不存在的记录，保留音频文件")} disabled={!native || checking || cleaning} onClick={() => void cleanMissing()}>
            {cleaning ? <LoaderCircle size={16} className="spin"/> : <Trash2 size={16}/>}
            {cleaning ? tr("正在检查…") : tr("一键清理")}
            {!cleaning && missingCount > 0 && <span className="cleanup-count">{missingCount}</span>}
          </button>
          <button type="button" className="icon-button" aria-label={tr("刷新目录状态")} title={tr("刷新目录状态")} disabled={!native || checking || cleaning} onClick={() => refreshRef.current()}><RefreshCw size={18} className={checking ? 'spin' : ''}/></button>
        </>}
        <History className="heading-illustration" size={48}/>
      </div>
    </div>
    {removed && <div className="history-undo" role="status">
      <CheckCircle2 size={17}/><span>{removed.bulk ? tr("已清理 {v0} 条目录不存在的记录，音频文件保留。",{v0:removed.entries.length}) : tr("已删除“{v0}”的记录，音频文件保留。",{v0:removed.entries[0].title})}</span>
      <button type="button" className="text-button" disabled={cleaning} onClick={() => { onRestore(removed.entries); setRemoved(null); }}>{tr("撤销")}</button>
      <button type="button" className="icon-button" aria-label={tr("关闭删除提示")} onClick={() => setRemoved(null)}><X size={16}/></button>
    </div>}
    {entries.length ? <>
      <div className="history-list">
        {entries.map(entry => {
          const state = directories[entry.path];
          return <article key={entry.id} className="history-item" aria-label={tr("{v0}的抓轨记录",{v0:entry.title})}>
            {artwork}
            <div className="history-detail">
              <h3 title={entry.title}>{entry.title}</h3>
              <p>{entry.artist} · {tr('{v0} 首曲目',{v0:entry.tracks})}</p>
              <span>{new Date(entry.date).toLocaleString(getLocale(), { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}<i/>{entry.verified ? tr("已做重复读取比对") : tr("标准读取")}</span>
              {entry.encoding&&<div className="history-encoding">{encodingSummary(entry.format==='AAC'?'aac':'mp3',entry.encoding)}</div>}
              <div className="history-location">
                {state === 'missing' && <span className="history-directory-state missing"><FolderX size={13}/>{tr("目录不存在")}</span>}
                {state === 'unavailable' && <span className="history-directory-state unavailable"><AlertCircle size={13}/>{tr("无法访问目录")}</span>}
                {!state && <span className="history-directory-state">{native ? <><LoaderCircle size={13} className="spin"/>{tr("正在检查目录")}</> : tr("请在桌面版检查目录")}</span>}
                <span className="history-path" title={entry.path}>{entry.path}</span>
              </div>
            </div>
            <span className="pill">{entry.format}</span>
            <div className="history-actions">
              <button type="button" className="secondary" disabled={!native || state !== 'available'} onClick={() => void openFolder(entry)}><FolderOpen size={16}/>{tr("打开文件夹")}</button>
              <button type="button" className="icon-button history-delete" aria-label={tr("删除记录：{v0}",{v0:entry.title})} title={tr("删除记录（保留音频文件）")} disabled={cleaning} onClick={() => { setRemoved({ entries:[entry], bulk:false }); onRemove([entry.id]); }}><Trash2 size={17}/></button>
            </div>
          </article>;
        })}
      </div>
      <p className="history-hint">{tr("删除记录只清除这条历史，不会删除音频文件。")}</p>
    </> : <div className="history-empty">
      <div><ListMusic size={48}/></div>
      <h2>{tr("下一次相遇，不必等光盘在身边")}</h2>
      <p>{tr("把喜欢的 CD 保存为 FLAC、WAV、MP3 或 AAC，")}<br/>{tr("完成的抓轨会出现在这里。")}</p>
      <button className="primary" onClick={onDisc}><Disc3 size={17}/>{tr("去看看我的 CD")}</button>
    </div>}
  </div>;
}
