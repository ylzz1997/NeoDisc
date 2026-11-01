import { AudioLines, RotateCcw, RefreshCw, BookmarkPlus, Pencil, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { tr, localizeMessage } from './i18n';
import type { EqualizerSettings, SavedEqualizer } from './types';
import { defaultEqualizer, eqPresets, gainLabel, matchingPreset, matchesEqualizer } from './equalizer';
import EqualizerCurve from './EqualizerCurve';
import EqualizerPresetDialog from './EqualizerPresetDialog';
import './equalizer.css';

interface Props {
  settings: EqualizerSettings;
  native: boolean;
  pending: boolean;
  error: string | null;
  onChange: (settings: EqualizerSettings) => void;
  onRetry: () => void;
  presets: SavedEqualizer[];
  onPresets: (presets: SavedEqualizer[]) => void;
}

export default function EqualizerPanel({ settings, native, pending, error, onChange, onRetry, presets, onPresets }: Props) {
  const selected = matchingPreset(settings);
  const [preferred, setPreferred] = useState<string | null | undefined>(undefined);
  const [editor, setEditor] = useState<{ renameId: string | null; name: string } | null>(null);
  const [deleted, setDeleted] = useState<{ preset: SavedEqualizer; index: number } | null>(null);
  const saved = preferred === null ? undefined : presets.find(preset => preset.id === preferred && matchesEqualizer(preset, settings)) || presets.find(preset => matchesEqualizer(preset, settings));
  function savePreset(name: string, replaceId: string | null) {
    const id = replaceId || crypto.randomUUID();
    const prior = presets.find(preset => preset.id === id);
    const preset: SavedEqualizer = editor?.renameId && prior ? { ...prior, name } : { id, name, preampDb: settings.preampDb, bands: [...settings.bands] };
    onPresets(prior ? presets.map(item => item.id === id ? preset : item) : [...presets, preset]);
    setPreferred(id); setEditor(null); setDeleted(null);
  }
  function changeBand(index: number, value: number) {
    onChange({ ...settings, bands: settings.bands.map((gain, i) => i === index ? value : gain) });
  }
  return <section className={`equalizer-card ${settings.enabled ? 'enabled' : ''}`} aria-labelledby="equalizer-heading">
    <div className="eq-heading">
      <div className="panel-icon"><AudioLines size={22}/></div>
      <div><h2 id="equalizer-heading">{tr('均衡器')} <span>EQ</span></h2><p>{tr('10 段调节，找到你喜欢的声音。')}</p></div>
      <button className={`toggle ${settings.enabled ? 'on' : ''}`} role="switch" aria-label={tr('启用均衡器')} aria-checked={settings.enabled} onClick={() => onChange({ ...settings, enabled: !settings.enabled })}><i/></button>
    </div>
    <div className="eq-preset-heading"><span>{tr('声音预设')}</span><span className="eq-current" title={saved?.name}>{saved?.name || (selected ? tr(selected.label) : tr('自定义'))}</span><div className="eq-preset-actions"><button className="eq-save" onClick={() => setEditor({ renameId: null, name: presets.find(preset => preset.id === preferred)?.name || saved?.name || '' })}><BookmarkPlus size={13}/>{tr('保存预设')}</button><button className="eq-reset" onClick={() => { setPreferred(null); onChange({ ...defaultEqualizer, bands: [...defaultEqualizer.bands], enabled: settings.enabled }); }}><RotateCcw size={13}/>{tr('重置均衡器')}</button></div></div>
    <div className="eq-presets" role="group" aria-label={tr('声音预设')}>
      {eqPresets.map(preset => <button key={preset.id} aria-pressed={selected?.id === preset.id && !saved} onClick={() => { setPreferred(null); onChange({ enabled: true, preampDb: preset.preampDb, bands: [...preset.bands] }); }}>{tr(preset.label)}</button>)}
    </div>
    {presets.length > 0 && <div className="eq-saved-presets"><label htmlFor="eq-saved-preset">{tr('我的预设')}</label><select id="eq-saved-preset" aria-label={tr('已保存的预设')} value={saved?.id || ''} onChange={event => {
      const preset = presets.find(item => item.id === event.target.value);
      if (preset) { setPreferred(preset.id); onChange({ enabled: true, preampDb: preset.preampDb, bands: [...preset.bands] }); }
    }}><option value="" disabled>{tr('选择已保存的预设')}</option>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><button className="icon-button" disabled={!saved} aria-label={tr('重命名预设')} title={tr('重命名预设')} onClick={() => saved && setEditor({ renameId: saved.id, name: saved.name })}><Pencil size={15}/></button><button className="icon-button" disabled={!saved} aria-label={tr('删除预设')} title={tr('删除预设')} onClick={() => {
      if (saved) { setDeleted({ preset: saved, index: presets.indexOf(saved) }); onPresets(presets.filter(preset => preset.id !== saved.id)); setPreferred(null); }
    }}><Trash2 size={15}/></button></div>}
    {deleted && <div className="eq-preset-notice" aria-live="polite"><span>{tr('已删除预设“{name}”，当前声音设置保留。', { name: deleted.preset.name })}</span><button onClick={() => {
      const restored = [...presets]; restored.splice(deleted.index, 0, deleted.preset); onPresets(restored); setPreferred(deleted.preset.id); setDeleted(null);
    }}><Undo2 size={13}/>{tr('撤销删除预设')}</button></div>}
    <fieldset className="eq-controls" disabled={!settings.enabled}>
      <legend className="eq-visually-hidden">{tr('频段增益')}</legend>
      <EqualizerCurve bands={settings.bands} disabled={!settings.enabled} onChange={changeBand}/>
      <div className="eq-preamp"><label htmlFor="eq-preamp">{tr('前级增益')}</label><input id="eq-preamp" type="range" min="-24" max="12" step="0.5" value={settings.preampDb} aria-valuetext={gainLabel(settings.preampDb)} onChange={event => onChange({ ...settings, preampDb: +event.target.value })} style={{ '--range-fill': `${(settings.preampDb + 24) / 36 * 100}%` } as CSSProperties}/><output htmlFor="eq-preamp" aria-hidden="true">{gainLabel(settings.preampDb)}</output></div>
    </fieldset>
    <p className="eq-help">{tr('选择预设即可启用，也可按喜好微调。提升频段时，可降低前级增益以减少失真。')}</p>
    <div className="eq-footer"><span className={`eq-status ${error ? 'failed' : ''}`} aria-live="polite">{error ? tr('应用失败') : !native ? tr('桌面版播放时生效') : pending ? tr('正在应用…') : settings.enabled ? tr('播放 EQ 已启用') : tr('播放 EQ 已关闭')}</span><span>{tr('仅影响播放，不改变抓轨文件。')}</span></div>
    {error && <div className="eq-error" role="alert"><span>{localizeMessage(error)}</span><button onClick={onRetry}><RefreshCw size={13}/>{tr('重试应用 EQ')}</button></div>}
    {editor && <EqualizerPresetDialog presets={presets} renameId={editor.renameId} initialName={editor.name} onSave={savePreset} onClose={() => setEditor(null)}/>}
  </section>;
}
