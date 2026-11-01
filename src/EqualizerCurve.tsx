import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { eqFrequencies, gainLabel } from './equalizer';
import { tr } from './i18n';

const WIDTH = 740, HEIGHT = 210, LEFT = 48, RIGHT = 720, TOP = 18, BOTTOM = 172;
const x = (frequency: number) => LEFT + Math.log2(frequency / eqFrequencies[0]) / Math.log2(eqFrequencies.at(-1)! / eqFrequencies[0]) * (RIGHT - LEFT);
const y = (gain: number) => TOP + (12 - gain) / 24 * (BOTTOM - TOP);
const clamp = (gain: number) => Math.max(-12, Math.min(12, Math.round(gain * 2) / 2));

interface Props { bands: number[]; disabled: boolean; onChange: (index: number, gain: number) => void }

export default function EqualizerCurve({ bands, disabled, onChange }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointer: number; startY: number; gain: number } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const gradient = useId();
  const help = useId();
  const points = eqFrequencies.map((frequency, i) => `${x(frequency)},${y(bands[i])}`).join(' ');

  function begin(event: PointerEvent<SVGGElement>, index: number) {
    if (disabled || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, startY: event.clientY, gain: bands[index] };
    setActive(index);
  }
  function move(event: PointerEvent<SVGGElement>, index: number) {
    if (disabled || drag.current?.pointer !== event.pointerId || !svg.current) return;
    const height = svg.current.getBoundingClientRect().height * (BOTTOM - TOP) / HEIGHT;
    onChange(index, clamp(drag.current.gain - (event.clientY - drag.current.startY) * 24 / height));
  }
  function finish(event: PointerEvent<SVGGElement>) {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function key(event: KeyboardEvent<SVGGElement>, index: number) {
    // Space belongs to the focused slider, not the app's playback shortcut.
    if (event.key === ' ') { event.preventDefault(); event.stopPropagation(); }
    if (disabled) return;
    const step = event.shiftKey ? 2 : 0.5;
    const value: Record<string, number> = { ArrowUp: bands[index] + step, ArrowRight: bands[index] + step, ArrowDown: bands[index] - step, ArrowLeft: bands[index] - step, PageUp: bands[index] + 3, PageDown: bands[index] - 3, Home: -12, End: 12, Enter: 0 };
    if (Object.hasOwn(value, event.key)) { event.preventDefault(); event.stopPropagation(); onChange(index, clamp(value[event.key])); }
  }

  return <div className={`eq-curve ${disabled ? 'disabled' : ''}`}>
    <svg ref={svg} className="eq-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="group" aria-label={tr('频率与增益曲线')}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".16"/><stop offset="100%" stopColor="var(--accent)" stopOpacity=".025"/></linearGradient></defs>
      <g className="eq-grid" aria-hidden="true">
        <text x="2" y="10">dB</text>
        {[12, 6, 0, -6, -12].map(gain => <g key={gain}><line x1={LEFT} x2={RIGHT} y1={y(gain)} y2={y(gain)} className={gain === 0 ? 'eq-zero' : ''}/><text x="2" y={y(gain) + 4}>{gain > 0 ? '+' : ''}{gain}</text></g>)}
        {eqFrequencies.map(frequency => <g key={frequency}><line x1={x(frequency)} x2={x(frequency)} y1={TOP} y2={BOTTOM}/><text x={x(frequency)} y={BOTTOM + 23} textAnchor="middle">{frequency >= 1000 ? `${frequency / 1000}k` : frequency}</text></g>)}
        <text x={RIGHT} y={HEIGHT - 2} textAnchor="end">Hz</text>
      </g>
      <polygon points={`${LEFT},${y(0)} ${points} ${RIGHT},${y(0)}`} fill={`url(#${gradient})`} aria-hidden="true"/>
      <polyline className="eq-curve-line" points={points} aria-hidden="true"/>
      {eqFrequencies.map((frequency, index) => <g key={frequency} className={`eq-node ${active === index ? 'active' : ''}`} transform={`translate(${x(frequency)},${y(bands[index])})`} role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label={tr('{frequency} Hz 频段', { frequency })} aria-orientation="vertical" aria-valuemin={-12} aria-valuemax={12} aria-valuenow={bands[index]} aria-valuetext={gainLabel(bands[index])} aria-describedby={help}
        onPointerDown={event => begin(event, index)} onPointerMove={event => move(event, index)} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null; }}
        onFocus={() => setActive(index)} onBlur={() => setActive(null)} onPointerEnter={() => !disabled && setActive(index)} onPointerLeave={event => { if (!drag.current && document.activeElement !== event.currentTarget) setActive(null); }}
        onKeyDown={event => key(event, index)} onDoubleClick={() => !disabled && onChange(index, 0)}>
        <circle className="eq-node-hit" r="15"/><circle className="eq-node-halo" r="11"/><circle className="eq-node-dot" r="4.5"/>
      </g>)}
      {active !== null && !disabled && <g className="eq-tooltip" transform={`translate(${Math.max(LEFT + 58, Math.min(RIGHT - 58, x(eqFrequencies[active])))},${y(bands[active]) < TOP + 36 ? y(bands[active]) + 26 : y(bands[active]) - 27})`} aria-hidden="true">
        <rect x="-58" y="-12" width="116" height="24" rx="5"/><text textAnchor="middle" dominantBaseline="central">{eqFrequencies[active] >= 1000 ? `${eqFrequencies[active] / 1000}k` : eqFrequencies[active]} Hz · {gainLabel(bands[active])}</text>
      </g>}
    </svg>
    <p className="eq-curve-help" id={help}>{tr('拖动节点或使用方向键微调；双击节点归零。')}</p>
  </div>;
}
