import { Children, isValidElement, useRef, type ReactNode } from 'react';
import { ChevronDown } from './icons';
import { Menu, Popover, usePopover } from './overlays';

/** A compact choice menu shared by filters and document controls. */
export function Select({ value, onChange, children, 'aria-label': label }: {
  value: string; onChange: (value: string) => void; children: ReactNode; 'aria-label': string;
}) {
  const pop = usePopover();
  const trigger = useRef<HTMLButtonElement>(null);
  const options = Children.toArray(children).filter(isValidElement<{ value?: string; children: ReactNode }>).map(option => ({
    value: String(option.props.value ?? option.props.children),
    label: Children.toArray(option.props.children).join(''),
  }));
  const close = () => { pop.close(); trigger.current?.focus(); };
  return <>
    <button ref={trigger} type="button" className="choice-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={!!pop.anchor}
      onClick={e => pop.anchor ? pop.close() : pop.open(e.currentTarget)}
      onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pop.open(e.currentTarget); } }}>
      <span>{options.find(o => o.value === value)?.label ?? label}</span><ChevronDown size={12}/>
    </button>
    {pop.anchor && <Popover anchor={pop.anchor} onClose={pop.close} width={Math.min(360, Math.max(220, pop.anchor.w))} className="popover-menu">
      <Menu searchable={options.length > 8} placeholder={`Find ${label.toLowerCase()}…`} onClose={close}
        items={options.map(o => ({ id: o.value, label: o.label, checked: o.value === value, onSelect: () => onChange(o.value) }))}/>
    </Popover>}
  </>;
}
