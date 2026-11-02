import type { ButtonHTMLAttributes } from 'react';
import { Filter } from './icons';

/** Applied count is distinct from disclosure state. Always name the filtered surface. */
export function FilterButton({label, activeCount = 0, ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {label: string; activeCount?: number}) {
  const description = `${label}${activeCount ? `, ${activeCount} active` : ''}`;
  return <button {...props} type="button" className="icon-btn filter-button" data-on={activeCount > 0} aria-label={description} title={description}>
    <Filter size={16} aria-hidden="true"/>
    {activeCount > 0 && <span className="filter-button-count" aria-hidden="true">{activeCount}</span>}
  </button>;
}
