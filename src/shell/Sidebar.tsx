import { PageMenu, pages, useNavigationPreferences } from './PageMenu';
import { type ReactNode } from 'react';
import type { Project } from '@shared/types';
import { href, useRoute, type Route } from '../lib/router';
import { useStore } from '../lib/store';
import { usePersisted } from '../lib/usePersisted';
import { Activity, BookOpen, Box, ChevronRight, Bot, Edit, Inbox, Plus, Search, Settings, Ticket, Trash, type IconComponent } from '../ui/icons';

const INDENT = 14;

export function Sidebar({ onSearch, onCompose }: { onSearch: () => void; onCompose: () => void }) {
  const route = useRoute();
  const [navigation] = useNavigationPreferences();
  const projects = useStore((s) => s.projects);
  const tickets = useStore((s) => s.tickets);
  const online = useStore((s) => s.online);
  const [sections, setSections] = usePersisted<Record<string, boolean>>('sidebar.sections', {});
  const isOpen = (k: string) => sections[k] !== false;
  const toggle = (k: string) => setSections({ ...sections, [k]: !isOpen(k) });

  const inboxCount = tickets.filter((t) => !t.project && t.status !== 'done' && t.status !== 'canceled').length;
  const activeCount = tickets.filter((t) => t.status === 'in_progress' || t.status === 'in_review').length;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-name">CENTCOM</span>
        </div>
        <button className="icon-btn" title="Search  ⌘K" onClick={onSearch}>
          <Search size={15} />
        </button>
        <button className="icon-btn compose" title="New task  C" onClick={onCompose}>
          <Edit size={15} />
        </button>
      </div>

      <nav className="sidebar-scroll">
        <div className="nav-group">
          {navigation.order.filter(id => !navigation.hidden.includes(id) && id !== 'settings' && id !== 'trash').map(id => <NavLink key={id} to={{name:id}} icon={pages[id].icon} label={pages[id].label} active={route.name===id || (id==='tickets' && route.name==='ticket') || (id==='agents' && route.name==='agent')} count={id==='inbox' ? inboxCount || undefined : id==='tickets' ? activeCount || undefined : undefined}/>)}
        </div>

        <SectionHeader
          label="Projects"
          open={isOpen('projects')}
          onToggle={() => toggle('projects')}
          action={{ title: 'New project', run: () => window.dispatchEvent(new CustomEvent('centcom:new-project')) }}
        />
        {isOpen('projects') && (
          <div className="nav-group">
            {projects.map((p) => (
              <ProjectItem key={p.slug} project={p} />
            ))}
            {projects.length === 0 && <div className="nav-empty">No projects yet</div>}
          </div>
        )}
      </nav>

      <div className="sidebar-foot">
        {navigation.order.filter(id => !navigation.hidden.includes(id) && (id === 'settings' || id === 'trash')).map(id => <NavLink key={id} to={{name:id}} icon={pages[id].icon} label={pages[id].label} active={route.name===id}/>)}
        <div className="sidebar-connection">
        <div className="conn" data-online={online} title={online ? 'Connected to the CENTCOM server' : 'Server unreachable. Retrying…'}>
          <span className="conn-dot" />
          {online ? 'Live' : 'Offline'}
        </div><PageMenu sidebar onSearch={onSearch}/></div>
      </div>
    </aside>
  );
}

/* ───────── Pieces ───────── */

function NavLink({
  to,
  icon: Icon,
  label,
  active,
  count,
}: {
  to: Route;
  icon: IconComponent;
  label: string;
  active: boolean;
  count?: number;
}) {
  return (
    <a className="nav-row" href={href(to)} data-active={active} draggable={false}>
      <span className="nav-icon">
        <Icon size={15} weight={active ? 'Filled' : 'Outline'} />
      </span>
      <span className="nav-label truncate">{label}</span>
      {count !== undefined && <span className="nav-count tnum">{count}</span>}
    </a>
  );
}

function SectionHeader({
  label,
  open,
  onToggle,
  action,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: { title: string; run: () => void };
}) {
  return (
    <div className="nav-section">
      <button className="nav-section-btn" onClick={onToggle} aria-expanded={open}>
        {label}
        <ChevronRight size={11} className="chev" data-open={open} />
      </button>
      {action && (
        <button className="icon-btn nav-section-action" title={action.title} onClick={action.run}>
          <Plus size={13} />
        </button>
      )}
    </div>
  );
}

/* ───────── Expand state (persisted per path) ───────── */

function useExpanded(path: string, initial = false) {
  const [map, setMap] = usePersisted<Record<string, boolean>>('sidebar.expanded', {});
  const open = map[path] ?? initial;
  return [open, (next?: boolean) => setMap({ ...map, [path]: next ?? !open })] as const;
}

function Row({
  depth,
  active,
  over,
  to,
  icon,
  label,
  expandable,
  open,
  onToggle,
  trailing,
  ...rest
}: {
  depth: number;
  active: boolean;
  over?: boolean;
  to: Route;
  icon: ReactNode;
  label: string;
  expandable?: boolean;
  open?: boolean;
  onToggle?: () => void;
  trailing?: ReactNode;
} & React.HTMLAttributes<HTMLAnchorElement> & { draggable?: boolean }) {
  return (
    <a
      className="nav-row tree-row"
      href={href(to)}
      data-active={active}
      data-over={over || undefined}
      style={{ paddingLeft: 8 + depth * INDENT }}
      {...rest}
    >
      {expandable ? (
        <button
          className="tree-chev"
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggle?.();
          }}
        >
          <ChevronRight size={11} className="chev" data-open={open} />
        </button>
      ) : (
        <span className="tree-chev" />
      )}
      <span className="nav-icon">{icon}</span>
      <span className="nav-label truncate">{label}</span>
      {trailing}
    </a>
  );
}

function ProjectItem({ project }: { project: Project }) {
  const route = useRoute();
  const [open, setOpen] = useExpanded(project.path, true);
  const here = route.name === 'project' && route.slug === project.slug;
  const count = project.counts.todo + project.counts.in_progress + project.counts.in_review + project.counts.backlog;
  return <>
    <Row depth={0} active={here && route.tab === 'overview'}
      to={{ name: 'project', slug: project.slug, tab: 'overview' }}
      icon={<Box size={15} color={project.color} weight="Filled" />} label={project.name}
      expandable open={open} onToggle={() => setOpen()} />
    {open && <div role="group">
      <Row depth={1} active={here && route.tab === 'overview'} to={{ name: 'project', slug: project.slug, tab: 'overview' }} icon={<Box size={14} />} label="Home" />
      <Row depth={1} active={here && route.tab === 'tickets'} to={{ name: 'project', slug: project.slug, tab: 'tickets' }} icon={<Ticket size={14} />} label="Tasks" trailing={<span className="nav-count tnum">{count}</span>} />
      <Row depth={1} active={here && route.tab === 'library'} to={{ name: 'project', slug: project.slug, tab: 'library' }} icon={<BookOpen size={14} />} label="Library" />
    </div>}
  </>;
}
