import { ProjectIcon } from './ProjectAppearance';
import type { ReactNode } from 'react';
import { TICKET_STATUSES, type Agent, type Project, type TicketPriority, type TicketStatus } from '@shared/types';
import { PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, initials } from '../lib/format';
import { agentById, useStore } from '../lib/store';
import { PriorityIcon, StatusIcon } from './glyphs';
import { Bot, Box, Inbox, Tag, User } from './icons';
import { Menu, Popover, usePopover, type MenuItem } from './overlays';

/* ───────── Agent avatar ───────── */

export function AgentAvatar({ agent, size = 18 }: { agent: Agent | null; size?: number }) {
  if (!agent) {
    return (
      <span className="avatar" data-empty style={{ width: size, height: size }} aria-label="Unassigned">
        <User size={size * 0.62} />
      </span>
    );
  }
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: agent.color, fontSize: Math.max(8, size * 0.44) }}
      title={agent.name}
    >
      {agent.kind === 'human' ? initials(agent.name) : <Bot size={size * 0.72} aria-hidden="true" />}
    </span>
  );
}

export function AgentChip({ id, size = 18 }: { id: string | null | undefined; size?: number }) {
  const agent = useStore((s) => agentById(s.agents, id));
  return (
    <span className="agent-chip">
      <AgentAvatar agent={agent} size={size} />
      <span className="truncate">{agent?.name ?? id ?? 'Unassigned'}</span>
    </span>
  );
}

/* ───────── Generic trigger ───────── */

interface PickerProps {
  /** `icon` = glyph only (list rows) · `field` = glyph + label (side panel, dialogs) */
  variant?: 'icon' | 'field';
  disabled?: boolean;
}

function Trigger({
  variant,
  icon,
  label,
  muted,
  onOpen,
  title,
}: {
  variant: 'icon' | 'field';
  icon: ReactNode;
  label: string;
  muted?: boolean;
  onOpen: (el: Element) => void;
  title: string;
}) {
  return (
    <button
      className={variant === 'icon' ? 'prop-icon' : 'prop-field'}
      data-muted={muted || undefined}
      title={variant === 'icon' ? `${title}: ${label}` : title}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(e.currentTarget);
      }}
    >
      {icon}
      {variant === 'field' && <span className="truncate">{label}</span>}
    </button>
  );
}

/* ───────── Status ───────── */

export function StatusPicker({
  value,
  onChange,
  variant = 'icon',
}: PickerProps & { value: TicketStatus; onChange: (s: TicketStatus) => void }) {
  const pop = usePopover();
  const items: MenuItem[] = TICKET_STATUSES.map((s, i) => ({
    id: s,
    label: STATUS_LABEL[s],
    icon: <StatusIcon status={s} />,
    checked: s === value,
    hint: String(i + 1),
    onSelect: () => onChange(s),
  }));
  return (
    <>
      <Trigger variant={variant} icon={<StatusIcon status={value} />} label={STATUS_LABEL[value]} onOpen={pop.open} title="Status" />
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} className="popover-menu">
          <Menu items={items} onClose={pop.close} searchable placeholder="Change status…" />
        </Popover>
      )}
    </>
  );
}

/* ───────── Priority ───────── */

export function PriorityPicker({
  value,
  onChange,
  variant = 'icon',
}: PickerProps & { value: TicketPriority; onChange: (p: TicketPriority) => void }) {
  const pop = usePopover();
  const items: MenuItem[] = PRIORITIES.map((p) => ({
    id: String(p),
    label: PRIORITY_LABEL[p],
    icon: <PriorityIcon priority={p} />,
    checked: p === value,
    hint: String(p),
    onSelect: () => onChange(p),
  }));
  return (
    <>
      <Trigger
        variant={variant}
        icon={<PriorityIcon priority={value} />}
        label={PRIORITY_LABEL[value]}
        muted={value === 0}
        onOpen={pop.open}
        title="Priority"
      />
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} className="popover-menu">
          <Menu items={items} onClose={pop.close} searchable placeholder="Set priority…" />
        </Popover>
      )}
    </>
  );
}

/* ───────── Agent (assignee) ───────── */

export function AgentPicker({
  value,
  onChange,
  variant = 'icon',
  align,
}: PickerProps & { value: string | null; onChange: (id: string | null) => void; align?: 'start' | 'end' }) {
  const pop = usePopover();
  const agents = useStore((s) => s.agents);
  const current = agentById(agents, value);
  const items: MenuItem[] = [
    {
      id: '__none',
      label: 'Unassigned',
      icon: <AgentAvatar agent={null} size={16} />,
      checked: value === null,
      onSelect: () => onChange(null),
    },
    ...agents.map((a) => ({
      id: a.id,
      label: a.name,
      icon: <AgentAvatar agent={a} size={16} />,
      checked: a.id === value,
      onSelect: () => onChange(a.id),
    })),
  ];
  return (
    <>
      <Trigger
        variant={variant}
        icon={<AgentAvatar agent={current} size={variant === 'icon' ? 20 : 16} />}
        label={current?.name ?? value ?? 'Unassigned'}
        muted={!value}
        onOpen={pop.open}
        title="Assigned agent"
      />
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} className="popover-menu" align={align}>
          <Menu
            items={items}
            onClose={pop.close}
            searchable
            placeholder="Assign to agent…"
            onCreate={(text) => onChange(text.replace(/\s+/g, '-'))}
            createLabel={(t) => `Assign to new agent “${t}”`}
          />
        </Popover>
      )}
    </>
  );
}

/* ───────── Labels ───────── */

/** Stable hue from the label text, so a label is the same color everywhere. */
export function labelColor(label: string): string {
  let h = 0;
  for (const ch of label.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 52%)`;
}

export function LabelPill({ label, onRemove, project }: { label: string; project?: string | null; onRemove?: () => void }) {
  const color = useStore(s => s.labels.find(l => !l.deleted && (project === undefined || l.project === project) && l.name.toLowerCase() === label.toLowerCase())?.color) ?? labelColor(label);
  return (
    <span className="pill">
      <span className="pill-dot" style={{ background: color }} />
      <span className="truncate">{label}</span>
      {onRemove && <button className="label-remove" aria-label={`Remove label ${label}`} onClick={onRemove}>×</button>}
    </span>
  );
}

export function LabelPicker({ value, onChange, allowCreate = true, project }: { project?: string | null; value: string[]; onChange: (labels: string[]) => void; allowCreate?: boolean }) {
  const pop = usePopover();
  const catalog = useStore(s => s.labels);
  const scoped = catalog.filter(l => !l.deleted && (project === undefined || l.project === project));
  const known = Array.from(new Map([...scoped.map(l => l.name), ...value].map(l => [l.toLowerCase(), l])).values()).sort((a,b) => a.localeCompare(b));
  const toggle = (l: string) => onChange(value.some(x => x.toLowerCase() === l.toLowerCase()) ? value.filter(x => x.toLowerCase() !== l.toLowerCase()) : [...value, l]);
  const items: MenuItem[] = known.map((l) => ({
    id: l,
    label: l,
    icon: <span className="pill-dot" style={{ background: scoped.find(x => x.name === l)?.color ?? labelColor(l) }} />,
    checked: value.some(x => x.toLowerCase() === l.toLowerCase()),
    onSelect: () => toggle(l),
  }));
  return (
    <>
      <span className="label-row">
        {value.map(l => <LabelPill key={l} label={l} project={project} onRemove={() => toggle(l)} />)}
        <button className="prop-field" onClick={e => pop.open(e.currentTarget)}><Tag size={14} /><span>{allowCreate ? 'Add label' : 'Labels'}</span></button>
      </span>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} className="popover-menu">
          <Menu
            items={items}
            onClose={pop.close}
            searchable
            sticky
            placeholder={allowCreate ? "Add or create a label…" : "Filter by labels…"}
            onCreate={allowCreate ? (text) => { const name = text.trim().replace(/\s+/g, ' ').slice(0,60); if(name) toggle(known.find(l => l.toLowerCase() === name.toLowerCase()) ?? name); } : undefined}
            createLabel={(t) => `Create label “${t}”`}
          />
        </Popover>
      )}
    </>
  );
}

/* ───────── Project ───────── */

export function ProjectDot({ project, size = 14 }: { project: Project | null; size?: number }) {
  if (!project) return <Inbox size={size} />;
  return <ProjectIcon icon={project.icon} color={project.color} size={size} />;
}

export function ProjectPicker({
  value,
  onChange,
  onCreate,
}: {
  value: string | null;
  onChange: (slug: string | null) => void;
  onCreate?: () => void;
}) {
  const pop = usePopover();
  const projects = useStore((s) => s.projects);
  const current = projects.find((p) => p.slug === value) ?? null;
  const items: MenuItem[] = [
    { id: '__inbox', label: 'Inbox (no project)', icon: <Inbox size={14} />, checked: value === null, onSelect: () => onChange(null) },
    ...projects.map((p) => ({
      id: p.slug,
      label: p.name,
      icon: <ProjectDot project={p} />,
      checked: p.slug === value,
      onSelect: () => onChange(p.slug),
    })),
  ];
  if (onCreate) items.push({ id: "__create", label: "New project…", onSelect: onCreate });
  return (
    <>
      <button type="button" className="prop-field" data-muted={!current || undefined} onClick={(e) => pop.open(e.currentTarget)} title="Project">
        <ProjectDot project={current} />
        <span className="truncate">{current?.name ?? 'Inbox'}</span>
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} className="popover-menu">
          <Menu items={items} onClose={pop.close} searchable placeholder="Move to project…" />
        </Popover>
      )}
    </>
  );
}
