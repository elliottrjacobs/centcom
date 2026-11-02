import { useRef, useState, type KeyboardEvent } from 'react';
import { calendarDays, dateKey, offsetDate, parseDate } from '../lib/calendar';
import { Calendar, ChevronDown, ChevronRight } from './icons';
import { Popover, usePopover } from './overlays';

export function DatePicker({value, onChange}: {value: string | null; onChange: (date: string | null) => void}) {
  const pop = usePopover();
  const trigger = useRef<HTMLButtonElement>(null);
  const [focused, setFocused] = useState(value ? parseDate(value) : new Date());
  const choose = (date: string | null) => { onChange(date); pop.close(); trigger.current?.focus(); };
  const move = (date: Date) => {
    setFocused(date);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-calendar-date="${dateKey(date)}"]`)?.focus());
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -focused.getDay(), End: 6 - focused.getDay() };
    if (e.key in delta) { e.preventDefault(); move(offsetDate(focused, delta[e.key]!)); }
    if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); move(new Date(focused.getFullYear(), focused.getMonth() + (e.key === 'PageUp' ? -1 : 1), 1)); }
  };
  return <>
    <button ref={trigger} className="choice-trigger date-trigger" aria-label="Due date" aria-haspopup="dialog" aria-expanded={!!pop.anchor}
      onClick={e => { setFocused(value ? parseDate(value) : new Date()); pop.open(e.currentTarget); }}>
      <Calendar size={14}/><span>{value ? parseDate(value).toLocaleDateString(undefined, {month:'short',day:'numeric',year:'numeric'}) : 'Set due date'}</span><ChevronDown size={12}/>
    </button>
    {pop.anchor && <Popover anchor={pop.anchor} onClose={pop.close} width={280} className="calendar-popover">
      <div className="calendar-heading">
        <strong aria-live="polite">{focused.toLocaleDateString(undefined, {month:'long',year:'numeric'})}</strong>
        <button className="icon-btn" aria-label="Previous month" onClick={() => setFocused(new Date(focused.getFullYear(),focused.getMonth()-1,1))}><ChevronRight size={15} style={{transform:'rotate(180deg)'}}/></button>
        <button className="icon-btn" aria-label="Next month" onClick={() => setFocused(new Date(focused.getFullYear(),focused.getMonth()+1,1))}><ChevronRight size={15}/></button>
      </div>
      <div className="calendar-grid" onKeyDown={onKeyDown} role="group" aria-label="Choose due date">
        {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => <span className="calendar-weekday" key={d}>{d}</span>)}
        {calendarDays(focused).map(date => { const key = dateKey(date); return <button key={key} data-calendar-date={key}
          autoFocus={key===dateKey(focused)} tabIndex={key===dateKey(focused) ? 0 : -1}
          aria-label={date.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'})}
          aria-pressed={key===value} aria-current={key===dateKey(new Date()) ? 'date' : undefined}
          data-outside={date.getMonth()!==focused.getMonth()} onFocus={() => { if (dateKey(focused)!==key) setFocused(date); }}
          onClick={() => choose(key)}>{date.getDate()}</button>; })}
      </div>
      <div className="calendar-shortcuts"><button className="btn" onClick={() => choose(dateKey(new Date()))}>Today</button><button className="btn" onClick={() => choose(dateKey(offsetDate(new Date(),1)))}>Tomorrow</button><button className="btn" disabled={!value} onClick={() => choose(null)}>Clear</button></div>
    </Popover>}
  </>;
}
