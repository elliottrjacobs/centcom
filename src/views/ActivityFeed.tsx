import type { ActivityEvent, TicketPriority, TicketStatus } from '@shared/types';
import { MarkdownEditor } from '../editor/MarkdownEditor';
import { PRIORITY_LABEL, STATUS_LABEL, clockTime, fullDate, relTime, stripExt, basename } from '../lib/format';
import { href, parse, routeForPath } from '../lib/router';
import { agentById, useStore } from '../lib/store';
import { StatusIcon } from '../ui/glyphs';
import { AgentAvatar } from '../ui/pickers';
import { ShieldAlert } from '../ui/icons';

/** `['instructions', 'skills']` → `instructions and skills`. */
function instructionFields(changes: ActivityEvent['changes']): string {
  const fields = Object.keys(changes ?? {}).filter((f) => f === 'description' || f === 'instructions' || f === 'skills');
  if (fields.length === 0) return 'instructions';
  return fields.length === 1 ? fields[0]! : `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}`;
}

/** Turn a field change into a readable clause: “moved this from Todo to In Progress”. */
function describeChange(field: string, from: unknown, to: unknown, agentName: (id: unknown) => string): string {
  switch (field) {
    case 'status':
      return `moved this from ${STATUS_LABEL[from as TicketStatus] ?? from} to ${STATUS_LABEL[to as TicketStatus] ?? to}`;
    case 'priority':
      return `set priority to ${PRIORITY_LABEL[to as TicketPriority] ?? to}`;
    case 'agent':
      return to ? `assigned this to ${agentName(to)}` : 'removed the assignee';
    case 'title':
      return `renamed this to “${String(to)}”`;
    case 'labels':
      return `changed labels to ${(to as string[]).join(', ') || 'none'}`;
    case 'project':
      return to ? `moved this to ${String(to)}` : 'moved this to the Inbox';
    case 'due':
      return to ? `set the due date to ${String(to)}` : 'cleared the due date';
    case 'body':
      return 'edited the description';
    default:
      return `updated ${field}`;
  }
}

export function describe(ev: ActivityEvent, agentName: (id: unknown) => string): string {
  switch (ev.type) {
    case 'ticket.created':
      return 'created this ticket';
    case 'ticket.comment':
      return 'commented';
    case 'ticket.deleted':
      return 'moved this ticket to Trash';
    case 'ticket.updated': {
      const parts = Object.entries(ev.changes ?? {}).map(([f, [from, to]]) => describeChange(f, from, to, agentName));
      return parts.length ? parts.join(', ') : 'updated this ticket';
    }
    case 'doc.created':
      return 'created';
    case 'doc.updated':
      return 'edited';
    case 'doc.deleted':
      return 'deleted';
    case 'doc.moved':
      return 'moved';
    case 'agent.instructions_changed':
      return ev.target === ev.agent ? `changed its own ${instructionFields(ev.changes)}` : `changed the ${instructionFields(ev.changes)} of`;
  }
}

/** Timeline inside a ticket: changes as quiet one-liners, comments as cards. */
export function TicketTimeline({ events, docPath }: { events: ActivityEvent[]; docPath: string }) {
  const agents = useStore((s) => s.agents);
  const name = (id: unknown) => agentById(agents, String(id))?.name ?? String(id);
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  return (
    <ol className="timeline">
      {ordered.map((ev) => {
        const agent = agentById(agents, ev.agent);
        if (ev.type === 'ticket.comment') {
          return (
            <li key={ev.id} className="tl-comment">
              <div className="tl-comment-head">
                <AgentAvatar agent={agent} size={20} />
                <span className="tl-agent">{agent?.name ?? ev.agent}</span>{ev.device && <span className="activity-device"> on {ev.device}</span>}
                <time className="tl-time" title={fullDate(ev.ts)}>
                  {relTime(ev.ts)}
                </time>
              </div>
              <MarkdownEditor value={ev.body ?? ''} onChange={() => {}} docPath={docPath} readOnly compact toolbar={false} />
            </li>
          );
        }
        const status = ev.changes?.status?.[1] as TicketStatus | undefined;
        return (
          <li key={ev.id} className="tl-event">
            <span className="tl-bullet">{status ? <StatusIcon status={status} size={13} /> : <AgentAvatar agent={agent} size={14} />}</span>
            <span className="tl-text">
              <span className="tl-agent">{agent?.name ?? ev.agent}</span>{ev.device && <span className="activity-device"> on {ev.device}</span>} {describe(ev, name)}
            </span>
            <time className="tl-time" title={fullDate(ev.ts)}>
              {relTime(ev.ts)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}

/** One-line plain-text preview of a markdown comment: prose only, code blocks and syntax dropped. */
function previewOf(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 200).trimEnd()}…` : text;
}

/** Global feed row: who did what to which thing. */
export function FeedRow({ ev }: { ev: ActivityEvent }) {
  const agents = useStore((s) => s.agents);
  const agent = agentById(agents, ev.agent);
  const name = (id: unknown) => agentById(agents, String(id))?.name ?? String(id);
  const isTicket = ev.type.startsWith('ticket.');
  // Agents follow their instructions, so a change to them stands out, most of all when someone else made it.
  const instructions = ev.type === 'agent.instructions_changed';
  const docRoute = !isTicket && !instructions && ev.path && ev.type !== 'doc.deleted' ? routeForPath(ev.path, /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(ev.path) ? 'image' : 'markdown') : null;
  const target = instructions
    ? ev.target
      ? href({ name: 'agent', id: ev.target })
      : undefined
    : isTicket
      ? ev.ticket
        ? href({ name: 'ticket', id: ev.ticket })
        : undefined
      : // Only link where the app can actually show the file (an agent's own profile, for one, it cannot).
        docRoute && parse(href(docRoute)).name === docRoute.name
        ? href(docRoute)
        : undefined;
  const subject = instructions ? (ev.target === ev.agent ? '' : (agentById(agents, ev.target)?.name ?? ev.subject ?? ev.target ?? '')) : (ev.subject ?? (ev.path ? stripExt(basename(ev.path)) : ''));
  const verb = describe(ev, name).replace(/\bthis ticket\b|\bthis\b/g, '').replace(/\s+/g, ' ').trim();
  const alert = instructions ? (ev.target === ev.agent ? 'self' : 'other') : undefined;

  return (
    <a className="feed-row" data-alert={alert} href={target} draggable={false} data-static={!target || undefined}>
      <AgentAvatar agent={agent} size={22} />
      <div className="feed-main">
        <div className="feed-line">
          <span className="feed-agent">{agent?.name ?? ev.agent}</span>{ev.device && <span className="activity-device">on {ev.device}</span>}
          {instructions && <ShieldAlert size={14} className="feed-alert-icon" aria-label="Instructions changed" />}
          <span className="feed-verb">{verb}</span>
          {isTicket && ev.ticket && <span className="ticket-id mono tnum">{ev.ticket}</span>}
          <span className="feed-subject truncate">{subject}</span>
        </div>
        {ev.type === 'ticket.comment' && ev.body && <div className="feed-quote">{previewOf(ev.body)}</div>}
      </div>
      <time className="feed-time tnum" title={fullDate(ev.ts)}>
        {clockTime(ev.ts)}
      </time>
    </a>
  );
}
