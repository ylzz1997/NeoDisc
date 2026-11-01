import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookmarkPlus, Check, X } from 'lucide-react';
import { tr } from './i18n';
import type { SavedEqualizer } from './types';

interface Props {
  presets: SavedEqualizer[];
  renameId: string | null;
  initialName: string;
  onSave: (name: string, replaceId: string | null) => void;
  onClose: () => void;
}

export default function EqualizerPresetDialog({ presets, renameId, initialName, onSave, onClose }: Props) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState('');
  const modal = useRef<HTMLFormElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const trimmed = name.trim();
  const existing = presets.find(preset => preset.name.toLowerCase() === trimmed.toLowerCase());
  const updating = !renameId && !!existing;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const input = modal.current?.querySelector('input');
    input?.focus(); input?.select();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        const controls = modal.current?.querySelectorAll<HTMLElement>('input,button:not(:disabled)');
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form ref={modal} className="modal eq-preset-modal" role="dialog" aria-modal="true" aria-labelledby="eq-save-title" noValidate onSubmit={event => {
      event.preventDefault();
      if (!trimmed) { setError('请输入预设名称。'); return; }
      if (renameId && existing && existing.id !== renameId) { setError('已有同名预设，请换个名称。'); return; }
      onSave(trimmed, renameId || existing?.id || null);
    }}>
      <div className="modal-heading"><div><div className="eyebrow">YOUR SOUND, SAVED.</div><h2 id="eq-save-title">{renameId ? tr('重命名预设') : tr('保存声音预设')}</h2></div><button type="button" className="icon-button" aria-label={tr('关闭预设窗口')} onClick={onClose}><X size={20}/></button></div>
      <p>{renameId ? tr('重命名不会改变已保存的声音设置。') : tr('保存当前 10 个频段和前级增益，供以后直接调用。')}</p>
      <label htmlFor="eq-preset-name">{tr('预设名称')}</label>
      <input id="eq-preset-name" value={name} maxLength={40} placeholder={tr('例如：我的耳机')} aria-invalid={!!error} aria-describedby={error ? 'eq-save-error' : undefined} onChange={event => { setName(event.target.value); setError(''); }}/>
      {error && <p id="eq-save-error" className="eq-save-message" role="alert">{tr(error)}</p>}
      {updating && <p className="eq-save-message">{tr('将更新已有预设“{name}”的曲线和前级增益。', { name: existing.name })}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>{tr('取消')}</button><button type="submit" className="primary">{renameId ? <Check size={15}/> : <BookmarkPlus size={15}/>} {renameId ? tr('保存名称') : updating ? tr('更新预设') : tr('保存预设')}</button></div>
    </form>
  </div>, document.body);
}
