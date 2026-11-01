import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, Disc3, Info, LoaderCircle, Star, X } from 'lucide-react';
import { tr } from './i18n';
import { duration } from './theme';
import type { Disc, Track } from './types';
import './track-details.css';

function Field({ label, value }: { label: string; value?: ReactNode }) {
  const unknown = value === undefined || value === null || value === '';
  return <div className="detail-field"><dt>{label}</dt><dd className={unknown ? 'unknown' : ''}>{unknown ? tr('未知') : value}</dd></div>;
}
function discNumber(number?: number | null, total?: number | null) {
  if (!number && !total) return null;
  return `${number || tr('未知')} / ${total || tr('未知')}`;
}

export default function TrackDetails({ disc, track, cover, pending, onClose }: { disc: Disc; track: Track; cover?: string | null; pending: boolean; onClose: () => void }) {
  const modal = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const album = disc.details;
  const metadata = track.details;
  const rating = typeof metadata?.rating === 'number' && Number.isFinite(metadata.rating) && metadata.rating >= 0 && metadata.rating <= 5 ? metadata.rating : null;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key === 'Tab') {
        const buttons = modal.current?.querySelectorAll<HTMLButtonElement>('button');
        if (!buttons?.length) return;
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal track-details-modal" ref={modal} role="dialog" aria-modal="true" aria-labelledby="track-details-title">
      <header className="track-details-heading"><div><div className="eyebrow">BEHIND THE MUSIC.</div><h2 id="track-details-title">{tr('曲目详情')}</h2></div><button type="button" className="icon-button" aria-label={tr('关闭曲目详情')} onClick={onClose}><X size={20}/></button></header>
      <div className="track-details-scroll">
        <div className="track-details-summary"><div className="track-details-art">{cover ? <img src={cover} alt="" onError={event => { event.currentTarget.style.display = 'none'; }}/> : null}<Disc3 size={34} aria-hidden="true"/></div><div><strong>{track.title || tr('未知')}</strong><span>{track.artist || disc.artist || tr('未知')}</span><small>{tr('音轨 {number}', { number: String(track.number).padStart(2, '0') })} · {duration(track.sectors / 75)} · Audio CD</small></div></div>
        <div className="track-details-columns">
          <section aria-labelledby="album-details-title"><h3 id="album-details-title"><Disc3 size={15}/>{tr('专辑信息')}</h3><dl>
            <Field label={tr('专辑艺术家')} value={disc.artist}/>
            <Field label={tr('专辑')} value={disc.title}/>
            <Field label={tr('年份')} value={album?.year}/>
            <Field label={tr('类型')} value={album?.genre}/>
            <Field label={tr('光盘号')} value={discNumber(album?.discNumber, album?.discTotal)}/>
            <Field label={tr('发行商')} value={album?.label}/>
            <Field label={tr('版权')} value={album?.copyright}/>
            <Field label={tr('编码者')} value={album?.encodedBy}/>
            <Field label="URL" value={album?.url}/>
          </dl></section>
          <section aria-labelledby="recording-details-title"><h3 id="recording-details-title"><AudioLines size={15}/>{tr('曲目信息')}</h3><dl>
            <Field label={tr('音轨艺术家')} value={track.artist || disc.artist}/>
            <Field label={tr('标题')} value={track.title}/>
            <Field label={tr('编号')} value={`${track.number} / ${disc.lookupToc?.lastTrack || Math.max(...disc.tracks.map(t => t.number))}`}/>
            <Field label={tr('等级')} value={rating === null ? null : <span className="detail-rating"><Star size={12} fill="currentColor" aria-hidden="true"/>{rating.toFixed(1)} / 5 <small>{tr('MusicBrainz 评分')}</small></span>}/>
            <Field label={tr('作曲家')} value={metadata?.composer}/>
            <Field label={tr('合辑的一部分')} value={typeof album?.compilation === 'boolean' ? album.compilation ? tr('是') : tr('否') : null}/>
            <Field label={tr('注释')} value={metadata?.comment || album?.comment}/>
          </dl></section>
        </div>
        <section className="track-audio-details" aria-labelledby="track-audio-title"><h3 id="track-audio-title">{tr('音频参数')}</h3><dl>
          <Field label={tr('采样率')} value="44.1 kHz"/><Field label={tr('位深')} value="16-bit"/><Field label={tr('声道')} value={tr('立体声 · 2 声道')}/><Field label={tr('码率')} value="1411.2 kbps"/><Field label={tr('时长')} value={duration(track.sectors / 75)}/><Field label={tr('预加重')} value={track.preEmphasis ? tr('是') : tr('否')}/>
        </dl></section>
        <div className="track-details-note">{pending ? <LoaderCircle size={14} className="spin"/> : <Info size={14}/>}<p>{pending ? tr('正在自动识别元信息…') : disc.metadataId ? tr('已载入自动识别结果，专辑与曲名保留本地修改。') : tr('显示当前光盘信息；未获取到的元信息标为未知。')}<br/>{tr('音频参数来自 CD 原始音轨，不代表当前输出设备或抓轨编码设置。')}</p></div>
      </div>
      <footer className="track-details-footer"><span>{tr('只读详情')}</span><button className="primary" type="button" onClick={onClose}>{tr('完成')}</button></footer>
    </div>
  </div>, document.body);
}
