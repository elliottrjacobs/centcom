import { Select } from '../ui/Select';
import { LabelManager } from '../ui/LabelManager';
import { compareTasks, matchesTask, localDay, EMPTY_FILTERS, TASK_SORT_LABELS, type TaskFilters, type TaskSort } from '../lib/taskQuery';
import { copyText } from '../lib/clipboard';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Ticket, TicketStatus } from '@shared/types';
import { api } from '../lib/api';
import { copyPath } from '../lib/actions';
import { BOARD_ORDER, STATUS_LABEL, STATUS_ORDER, shortDate } from '../lib/format';
import { navigate } from '../lib/router';
import { agentById, patchTicketLocal, useStore } from '../lib/store';
import { usePersisted } from '../lib/usePersisted';
import { PriorityIcon, StatusIcon } from '../ui/glyphs';
import { ArrowUpRight, Check, ChevronRight, Clipboard, Cpu, Kanban, List, Plus, Ticket as TicketIcon, Trash } from '../ui/icons';
import { Menu, Popover, contextMenu, toast, toastError, usePopover, type MenuItem } from '../ui/overlays';
import { AgentAvatar, AgentPicker, LabelPicker, LabelPill, PriorityPicker, ProjectDot, StatusPicker } from '../ui/pickers';

type Tab = 'all' | 'active' | 'backlog' | 'done';
const TAB_STATUSES: Record<Tab, TicketStatus[]> = {
  all: STATUS_ORDER,
  active: ['in_progress', 'in_review', 'todo'],
  backlog: ['backlog'],
  done: ['done', 'canceled'],
};

export function openNewTicket(defaults: { project?: string | null; status?: TicketStatus } = {}) {
  window.dispatchEvent(new CustomEvent('centcom:new-ticket', { detail: defaults }));
}

export async function updateTicket(t: Ticket, patch: Parameters<typeof api.updateTicket>[1]) {
  // Optimistic: the row responds now, the server event reconciles a moment later.
  const { project: _p, ...local } = patch;
  patchTicketLocal(t.id, local as Partial<Ticket>);
  try {
    await api.updateTicket(t.id, patch);
  } catch (err) {
    patchTicketLocal(t.id, t);
    toastError(err);
  }
}

export async function deleteTicket(t: Ticket) {
  try {
    await api.deleteTicket(t.id);
    toast(`${t.id} moved to Trash`);
  } catch (err) {
    toastError(err);
  }
}

export function ticketMenu(t: Ticket): MenuItem[] {
  return [
    { id: 'open', label: 'Open', icon: <ArrowUpRight size={14} />, onSelect: () => navigate({ name: 'ticket', id: t.id }) },
    ...(t.status !== 'in_progress'
      ? [{ id: 'start', label: 'Mark in progress', icon: <StatusIcon status="in_progress" />, separatorBefore: true, onSelect: () => void updateTicket(t, { status: 'in_progress' }) }]
      : []),
    ...(t.status !== 'done'
      ? [{ id: 'done', label: 'Mark done', icon: <StatusIcon status="done" />, separatorBefore: t.status === 'in_progress', onSelect: () => void updateTicket(t, { status: 'done' }) }]
      : []),
    { id: 'id', label: 'Copy ID', icon: <Clipboard size={14} />, separatorBefore: true, onSelect: () => void copyText(t.id).then(() => toast(`${t.id} copied`)).catch(toastError) },
    { id: 'path', label: 'Copy file path', icon: <Clipboard size={14} />, onSelect: () => void copyPath(t.path) },
    { id: 'del', label: 'Move to Trash', icon: <Trash size={14} />, danger: true, separatorBefore: true, onSelect: () => void deleteTicket(t) },
  ];
}

/**
 * @param project `undefined` = every ticket · `null` = Inbox (no project) · slug = one project
 */
export function TicketsView({ project, embedded }: { project?: string | null; embedded?: boolean }) {
  const [managingLabels, setManagingLabels] = useState(false);
  const all = useStore((s) => s.tickets);
  const agents = useStore((s) => s.agents);
  const [tab, setTab] = usePersisted<Tab>(`tickets.tab.${project ?? (project === null ? '__inbox' : '__all')}`, 'all');
  const [layout, setLayout] = usePersisted<'list' | 'board'>('tickets.layout', 'list');
  const projects = useStore(s => s.projects);
  const scope = project ?? (project === null ? '__inbox' : '__all');
  const [savedFilters, setFilters] = usePersisted<TaskFilters>(`tickets.filters.${scope}`, EMPTY_FILTERS);
  // Retired text searches must not invisibly filter the list after removing the search bar.
  const filters = useMemo(() => ({...savedFilters, query: ''}), [savedFilters]);
  const [sort, setSort] = usePersisted<TaskSort>(`tickets.sort.${scope}`, 'priority');
  const [grouped, setGrouped] = usePersisted<boolean>(`tickets.grouped.${scope}`, true);
  const field = (key: keyof TaskFilters, value: string | string[]) => setFilters({...filters, [key]: value, ...(key === "project" ? {labels: []} : {})});
  const activeFilters = Object.values(filters).some(v => v.length > 0);

  const scoped = useMemo(
    () => all.filter((t) => (project === undefined ? true : project === null ? !t.project : t.project === project)),
    [all, project],
  );
  const visible = useMemo(
    () => scoped.filter((t) => TAB_STATUSES[tab].includes(t.status) && matchesTask(t, filters, localDay())).sort((a,b) => compareTasks(sort,a,b)),
    [scoped, tab, filters, sort],
  );

  const counts: Record<Tab, number> = {
    all: scoped.length,
    active: scoped.filter((t) => TAB_STATUSES.active.includes(t.status)).length,
    backlog: scoped.filter((t) => t.status === 'backlog').length,
    done: scoped.filter((t) => TAB_STATUSES.done.includes(t.status)).length,
  };


  return (
    <div className="tickets" data-embedded={embedded || undefined}>
      <div className="view-subheader">
        <div className="tabs" role="tablist">
          {(['all', 'active', 'backlog', 'done'] as Tab[]).map((t) => (
            <button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => { setTab(t); field("status", ""); }}>
              {{ all: 'All', active: 'Active', backlog: 'Backlog', done: 'Done' }[t]}
              <span className="tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
        <span className="header-spacer" />
        <div className="seg">
          <button className="icon-btn" data-on={layout === 'list'} title="List" onClick={() => setLayout('list')}>
            <List size={15} />
          </button>
          <button className="icon-btn" data-on={layout === 'board'} title="Board" onClick={() => setLayout('board')}>
            <Kanban size={15} />
          </button>
        </div>
        <button className="btn btn-sm" onClick={() => openNewTicket({ project: project ?? null })}>
          <Plus size={13} /> New ticket
        </button>
      </div>


      {managingLabels && <LabelManager project={project ?? null} onClose={() => setManagingLabels(false)} />}
      <div className="task-controls">
        <Select aria-label="Filter status" value={filters.status} onChange={value => { field('status', value); setTab('all'); }}><option value="">All statuses</option>{STATUS_ORDER.map(x => <option key={x} value={x}>{STATUS_LABEL[x]}</option>)}</Select>
        <Select aria-label="Filter priority" value={filters.priority} onChange={value => field('priority', value)}><option value="">All priorities</option>{['No priority','Urgent','High','Medium','Low'].map((x,i) => <option key={i} value={String(i)}>{x}</option>)}</Select>
        <Select aria-label="Filter assignee" value={filters.agent} onChange={value => field('agent', value)}><option value="">All assignees</option><option value="__none">Unassigned</option>{agents.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        {project === undefined && <Select aria-label="Filter project" value={filters.project} onChange={value => field('project', value)}><option value="">All projects</option><option value="__inbox">Inbox</option>{projects.map(x => <option key={x.slug} value={x.slug}>{x.name}</option>)}</Select>}
        <LabelPicker project={project === undefined ? filters.project === "__inbox" ? null : filters.project || undefined : project} value={filters.labels} onChange={labels => field('labels', labels)} allowCreate={false} />
        <Select aria-label="Filter due date" value={filters.due} onChange={value => field('due', value)}><option value="">Any due date</option><option value="overdue">Overdue (open)</option><option value="today">Due today</option><option value="none">No due date</option></Select>
        <Select aria-label="Sort tasks" value={sort} onChange={value => setSort(value as TaskSort)}>{Object.entries(TASK_SORT_LABELS).map(([k,v]) => <option key={k} value={k}>Sort: {v}</option>)}</Select>
        {layout === 'list' && <Select aria-label="Group tasks" value={grouped ? 'status' : 'none'} onChange={value => setGrouped(value === 'status')}><option value="status">Group: Status</option><option value="none">No grouping</option></Select>}
        {project === null && <button className="btn btn-ghost" onClick={() => setManagingLabels(true)}>Manage labels</button>}
        <span className="quiet" role="status">{visible.length} tasks</span>
        {activeFilters && <button className="btn btn-ghost btn-sm" onClick={() => {setFilters(EMPTY_FILTERS); setTab('all');}}>Clear filters</button>}
      </div>

      {scoped.length === 0 ? (
        <div className="empty">
          <TicketIcon size={28} className="empty-icon" />
          <div className="empty-title">{project === null ? 'Inbox is clear' : 'No tickets yet'}</div>
          <p className="empty-body">
            {project === null
              ? 'Tickets that agents file without a project land here for you to triage.'
              : 'Tickets are how agents report what they are doing. Create one here, or let an agent file it through the CLI or MCP.'}
          </p>
          <button className="btn btn-primary" onClick={() => openNewTicket({ project: project ?? null })}>
            <Plus size={14} /> New ticket
          </button>
        </div>
      ) : layout === 'list' ? (
        <TicketList tickets={visible} grouped={grouped} statuses={TAB_STATUSES[tab]} showProject={project === undefined} project={project} />
      ) : (
        <TicketBoard tickets={visible} showProject={project === undefined} project={project} />
      )}
    </div>
  );
}

/* ───────── List ───────── */

function TicketList({
  tickets,
  statuses,
  grouped,
  showProject,
  project,
}: {
  tickets: Ticket[];
  statuses: TicketStatus[];
  grouped: boolean;
  showProject: boolean;
  project?: string | null;
}) {
  const [collapsed, setCollapsed] = usePersisted<Record<string, boolean>>('tickets.collapsed', {});
  const [cursor, setCursor] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const groups = statuses
    .map((s) => ({ status: s, items: tickets.filter((t) => t.status === s) }))
    .filter((g) => g.items.length > 0);
  const flat = !grouped ? tickets : groups.flatMap((g) => (collapsed[g.status] ? [] : g.items));

  // j/k + arrows move a cursor, Enter opens. Keyboard-driven, so nothing animates.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, button, [contenteditable="true"], .popover, .modal')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = flat.findIndex((t) => t.id === cursor);
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setCursor(flat[Math.min(flat.length - 1, idx + 1)]?.id ?? null);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setCursor(flat[Math.max(0, idx - 1)]?.id ?? null);
      } else if (e.key === 'Enter' && cursor) {
        e.preventDefault();
        navigate({ name: 'ticket', id: cursor });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, cursor]);

  useEffect(() => {
    bodyRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (groups.length === 0) {
    return (
      <div className="empty">
        <Check size={26} className="empty-icon" />
        <div className="empty-title">Nothing here</div>
        <p className="empty-body">No tickets match this view.</p>
      </div>
    );
  }

  return (
    <div className="view-body ticket-list" ref={bodyRef}>
      {!grouped ? tickets.map(t => <TicketRow key={t.id} ticket={t} showProject={showProject} cursor={cursor === t.id} />) : groups.map((g) => (
        <section key={g.status}>
          <div className="group-band">
            <button
              className="group-toggle"
              onClick={() => setCollapsed({ ...collapsed, [g.status]: !collapsed[g.status] })}
              aria-expanded={!collapsed[g.status]}
            >
              <ChevronRight size={11} className="chev" data-open={!collapsed[g.status]} />
              <StatusIcon status={g.status} />
              <span className="group-name">{STATUS_LABEL[g.status]}</span>
              <span className="group-count tnum">{g.items.length}</span>
            </button>
            <button
              className="icon-btn"
              title={`New ${STATUS_LABEL[g.status].toLowerCase()} ticket`}
              onClick={() => openNewTicket({ project: project ?? null, status: g.status })}
            >
              <Plus size={14} />
            </button>
          </div>
          {!collapsed[g.status] &&
            g.items.map((t) => <TicketRow key={t.id} ticket={t} showProject={showProject} cursor={cursor === t.id} />)}
        </section>
      ))}
    </div>
  );
}

export function TicketRow({ ticket: t, showProject, cursor }: { ticket: Ticket; showProject?: boolean; cursor?: boolean }) {
  const project = useStore((s) => s.projects.find((p) => p.slug === t.project) ?? null);
  const closed = t.status === 'done' || t.status === 'canceled';
  return (
    <div
      className="ticket-row"
      data-cursor={cursor || undefined}
      data-closed={closed || undefined}
      onClick={() => navigate({ name: 'ticket', id: t.id })}
      onContextMenu={(e) => contextMenu(e, ticketMenu(t))}
    >
      <PriorityPicker value={t.priority} onChange={(priority) => void updateTicket(t, { priority })} />
      <span className="ticket-id mono tnum">{t.id}</span>
      <StatusPicker value={t.status} onChange={(status) => void updateTicket(t, { status })} />
      <span className="ticket-title truncate">{t.title}</span>
      <span className="ticket-meta">
        {t.labels.slice(0, 3).map((l) => (
          <LabelPill key={l} label={l} project={t.project} />
        ))}
        {showProject && project && (
          <span className="pill">
            <ProjectDot project={project} size={12} />
            <span className="truncate">{project.name}</span>
          </span>
        )}
      </span>
      <AgentPicker value={t.agent} onChange={(agent) => void updateTicket(t, { agent })} align="end" />
      <span className="ticket-date tnum" title="Last updated">
        {shortDate(t.updated)}
      </span>
    </div>
  );
}

/* ───────── Board ───────── */

const DND = 'application/x-centcom-ticket';

function TicketBoard({ tickets, showProject, project }: { tickets: Ticket[]; showProject: boolean; project?: string | null }) {
  const [over, setOver] = useState<TicketStatus | null>(null);
  const byId = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets]);
  return (
    <div className="view-body board">
      {BOARD_ORDER.map((status) => {
        const items = tickets.filter((t) => t.status === status);
        return (
          <section
            key={status}
            className="board-col"
            data-over={over === status || undefined}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(DND)) {
                e.preventDefault();
                setOver(status);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const t = byId.get(e.dataTransfer.getData(DND));
              if (t && t.status !== status) void updateTicket(t, { status });
            }}
          >
            <header className="board-col-head">
              <StatusIcon status={status} />
              <span className="group-name">{STATUS_LABEL[status]}</span>
              <span className="group-count tnum">{items.length}</span>
              <span className="header-spacer" />
              <button className="icon-btn" title="New ticket" onClick={() => openNewTicket({ project: project ?? null, status })}>
                <Plus size={14} />
              </button>
            </header>
            <div className="board-cards">
              {items.map((t) => (
                <BoardCard key={t.id} ticket={t} showProject={showProject} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function BoardCard({ ticket: t, showProject }: { ticket: Ticket; showProject: boolean }) {
  const agent = useStore((s) => agentById(s.agents, t.agent));
  const project = useStore((s) => s.projects.find((p) => p.slug === t.project) ?? null);
  return (
    <article
      className="board-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DND, t.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => navigate({ name: 'ticket', id: t.id })}
      onContextMenu={(e) => contextMenu(e, ticketMenu(t))}
    >
      <div className="board-card-top">
        <span className="ticket-id mono tnum">{t.id}</span>
        <span className="header-spacer" />
        <AgentAvatar agent={agent} size={18} />
      </div>
      <div className="board-card-title">{t.title}</div>
      <div className="board-card-meta">
        <PriorityIcon priority={t.priority} />
        {t.labels.slice(0, 2).map((l) => (
          <LabelPill key={l} label={l} project={t.project} />
        ))}
        {showProject && project && (
          <span className="pill">
            <ProjectDot project={project} size={12} />
            <span className="truncate">{project.name}</span>
          </span>
        )}
      </div>
    </article>
  );
}
