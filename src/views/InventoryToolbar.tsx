import { useId, useState, type ReactNode } from 'react';
import { Search } from '../ui/icons';
import { FilterButton } from '../ui/FilterButton';

/** Keeps search and the result count visible while less-used filters stay one click away. */
export function InventoryToolbar({query, onQuery, label, count, activeCount, summary, onClear, children}: {
  query: string; onQuery: (value: string) => void; label: string; count: string;
  activeCount: number; summary?: string; onClear: () => void; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <div className="inventory-tools">
    <div className="inventory-search-row">
      <label className="skill-search"><Search size={16}/><input aria-label={`Search ${label}`} placeholder={`Search ${label.toLowerCase()}…`} value={query} onChange={e => onQuery(e.target.value)}/></label>
      <FilterButton label={`Filter ${label}`} activeCount={activeCount} aria-expanded={expanded} aria-controls={expanded ? id : undefined} onClick={() => setExpanded(!expanded)}/>
    </div>
    {summary && <p className="inventory-active-filters">{summary}</p>}
    {expanded && <div className="inventory-filter-panel" id={id}>{children}</div>}
    <div className="inventory-results"><span role="status">{count}</span>{(activeCount > 0 || query) && <button className="btn" onClick={onClear}>Clear filters</button>}</div>
  </div>;
}
