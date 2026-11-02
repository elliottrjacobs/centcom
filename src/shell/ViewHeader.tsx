import { Fragment, type ReactNode } from 'react';
import { href, type Route } from '../lib/router';
import { ChevronRight, SidebarLeft } from '../ui/icons';

export interface Crumb {
  label: string;
  icon?: ReactNode;
  to?: Route;
}

export function ViewHeader({ crumbs, children }: { crumbs: Crumb[]; children?: ReactNode }) {
  return (
    <header className="view-header">
      <button
        className="icon-btn sidebar-toggle"
        title="Toggle sidebar  ⌘\"
        onClick={() => window.dispatchEvent(new CustomEvent('centcom:toggle-sidebar'))}
      >
        <SidebarLeft size={15} />
      </button>
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <ChevronRight size={11} className="crumb-sep" />}
            {c.to ? (
              <a className="crumb" href={href(c.to)} draggable={false}>
                {c.icon}
                <span className="truncate">{c.label}</span>
              </a>
            ) : (
              <span className="crumb">
                {c.icon}
                <span className="truncate">{c.label}</span>
              </span>
            )}
          </Fragment>
        ))}
      </div>
      <span className="header-spacer" />
      <div className="header-actions">{children}</div>
    </header>
  );
}
