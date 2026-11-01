import { AudioLines, RotateCcw, RefreshCw } from 'lucide-react';
import type { CSSProperties } from 'react';
import { tr, localizeMessage } from './i18n';
import type { EqualizerSettings } from './types';
import { defaultEqualizer, eqPresets, gainLabel, matchingPreset } from './equalizer';
import EqualizerCurve from './EqualizerCurve';
import './equalizer.css';

interface Props {
  settings: EqualizerSettings;
  native: boolean;
  pending: boolean;
  error: string | null;
  onChange: (settings: EqualizerSettings) => void;
  onRetry: () => void;
}

export default function EqualizerPanel({ settings, native, pending, error, onChange, onRetry }: Props) {
  const selected = matchingPreset(settings);
  function changeBand(index: number, value: number) {
    onChange({ ...settings, bands: settings.bands.map((gain, i) => i === index ? value : gain) });
  }
  return <section className={`equalizer-card ${settings.enabled ? 'enabled' : ''}`} aria-labelledby="equalizer-heading">
    <div className="eq-heading">
      <div className="panel-icon"><AudioLines size={22}/></div>
      <div><h2 id="equalizer-heading">{tr('均衡器')} <span>EQ</span></h2><p>{tr('10 段调节，找到你喜欢的声音。')}</p></div>
      <button className={`toggle ${settings.enabled ? 'on' : ''}`} role="switch" aria-label={tr('启用均衡器')} aria-checked={settings.enabled} onClick={() => onChange({ ...settings, enabled: !settings.enabled })}><i/></button>
    </div>
    <div className="eq-preset-heading"><span>{tr('声音预设')}</span><span className="eq-current">{selected ? tr(selected.label) : tr('自定义')}</span><button className="eq-reset" onClick={() => onChange({ ...defaultEqualizer, bands: [...defaultEqualizer.bands], enabled: settings.enabled })}><RotateCcw size={13}/>{tr('重置均衡器')}</button></div>
    <div className="eq-presets" role="group" aria-label={tr('声音预设')}>
      {eqPresets.map(preset => <button key={preset.id} aria-pressed={selected?.id === preset.id} onClick={() => onChange({ enabled: true, preampDb: preset.preampDb, bands: [...preset.bands] })}>{tr(preset.label)}</button>)}
    </div>
    <fieldset className="eq-controls" disabled={!settings.enabled}>
      <legend className="eq-visually-hidden">{tr('频段增益')}</legend>
      <EqualizerCurve bands={settings.bands} disabled={!settings.enabled} onChange={changeBand}/>
      <div className="eq-preamp"><label htmlFor="eq-preamp">{tr('前级增益')}</label><input id="eq-preamp" type="range" min="-24" max="12" step="0.5" value={settings.preampDb} aria-valuetext={gainLabel(settings.preampDb)} onChange={event => onChange({ ...settings, preampDb: +event.target.value })} style={{ '--range-fill': `${(settings.preampDb + 24) / 36 * 100}%` } as CSSProperties}/><output htmlFor="eq-preamp" aria-hidden="true">{gainLabel(settings.preampDb)}</output></div>
    </fieldset>
    <p className="eq-help">{tr('选择预设即可启用，也可按喜好微调。提升频段时，可降低前级增益以减少失真。')}</p>
    <div className="eq-footer"><span className={`eq-status ${error ? 'failed' : ''}`} aria-live="polite">{error ? tr('应用失败') : !native ? tr('桌面版播放时生效') : pending ? tr('正在应用…') : settings.enabled ? tr('播放 EQ 已启用') : tr('播放 EQ 已关闭')}</span><span>{tr('仅影响播放，不改变抓轨文件。')}</span></div>
    {error && <div className="eq-error" role="alert"><span>{localizeMessage(error)}</span><button onClick={onRetry}><RefreshCw size={13}/>{tr('重试应用 EQ')}</button></div>}
  </section>;
}
