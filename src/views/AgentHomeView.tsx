import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ActivityEvent, AgentDeliverable, AgentHome } from '@shared/types';
import { MarkdownEditor } from '../editor/MarkdownEditor';
import { externalLinkProps, openFileProps } from '../lib/actions';
import { ApiFailure, api } from '../lib/api';
import { deliverableTarget, sourceLabel } from '../lib/agentHome';
import { dayHeading, fullDate, relTime, shortDate } from '../lib/format';
import { href } from '../lib/router';
import { agentById, useStore } from '../lib/store';
import { ViewHeader } from '../shell/ViewHeader';
import { Bot, Document, File, Link, Trash } from '../ui/icons';
import { confirm, toastError } from '../ui/overlays';
import { AgentAvatar } from '../ui/pickers';
import { FeedRow } from './ActivityFeed';

const DELIVERABLE_LABEL: Record<AgentDeliverable['kind'], string> = { pr: 'PR', doc: 'Doc', file: 'File', link: 'Link', other: 'Other' };
/** Instructions longer than this start collapsed. */
const LONG_INSTRUCTIONS = 1200;

const Code = ({ children }: { children: ReactNode }) => <code className="mono">{children}</code>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="page-section">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

/** Markdown, read-only, the same renderer comments and project pages use. */
function Markdown({ value, docPath, revision }: { value: string; docPath: string; revision: number }) {
  return <MarkdownEditor value={value} revision={revision} docPath={docPath} onChange={() => {}} readOnly toolbar={false} />;
}

function Instructions({ value, docPath, revision }: { value: string; docPath: string; revision: number }) {
  const long = value.length > LONG_INSTRUCTIONS;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="agent-collapsible" data-collapsed={(long && !open) || undefined}>
        <Markdown value={value} docPath={docPath} revision={revision} />
      </div>
      {long && (
        <button className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  );
}

function DeliverableRow({ agentId, d, onRemoved }: { agentId: string; d: AgentDeliverable; onRemoved: () => void }) {
  const project = useStore((s) => s.projects.find((p) => p.slug === d.project));
  const target = deliverableTarget(d.url);
  const link = target.type === 'external' ? externalLinkProps(target.url) : target.type === 'raw' ? openFileProps(target.path) : { href: href(target.route) };
  const icon = target.type === 'external' ? <Link size={16} /> : target.type === 'raw' ? <File size={16} /> : <Document size={16} />;
  const date = d.date ? new Date(`${d.date}T00:00:00`).getTime() : null;
  const remove = async () => {
    const ok = await confirm({
      title: `Remove “${d.title}”?`,
      body: 'It comes off this agent’s list of deliverables. The PR, doc or link itself is not touched.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    api.removeDeliverable(agentId, d.id).then(onRemoved).catch(toastError);
  };
  return (
    <div className="file-row deliverable-row">
      <a className="deliverable-link" {...link} title={d.note || d.url} draggable={false}>
        <span className="file-icon">{icon}</span>
        <span className="file-name truncate">{d.title}</span>
      </a>
      <span className="pill">{DELIVERABLE_LABEL[d.kind]}</span>
      {(project || d.project) && <span className="file-meta truncate">{project?.name ?? d.project}</span>}
      <time className="file-date">{date ? shortDate(date) : ''}</time>
      <button className="icon-btn" title="Remove deliverable" onClick={() => void remove()}>
        <Trash size={14} />
      </button>
    </div>
  );
}

function ActivityDays({ events }: { events: ActivityEvent[] }) {
  const days = useMemo(() => {
    const map = new Map<string, ActivityEvent[]>();
    for (const ev of events) {
      const key = dayHeading(ev.ts);
      map.set(key, [...(map.get(key) ?? []), ev]);
    }
    return [...map.entries()];
  }, [events]);
  return (
    <>
      {days.map(([day, list]) => (
        <div key={day} className="feed-day">
          <h3 className="feed-day-head">{day}</h3>
          {list.map((ev) => (
            <FeedRow key={ev.id} ev={ev} />
          ))}
        </div>
      ))}
    </>
  );
}

/** An agent's home: who it is, how it operates, what it can do, and what it made. Agents own it; the app only shows it. */
export function AgentHomeView({ id }: { id: string }) {
  const [home, setHome] = useState<AgentHome | null>(null);
  const [missing, setMissing] = useState(false);
  const [reload, setReload] = useState(0);
  const live = useStore((s) => agentById(s.agents, id));
  const agents = useStore((s) => s.agents);
  // Refetch when this agent's home changes, or when it does something new.
  const version = useStore((s) => s.agentVersions[id] ?? 0);
  const latest = useStore((s) => s.activity.find((e) => e.agent === id)?.id);

  useEffect(() => {
    let alive = true;
    api
      .agentHome(id)
      .then((h) => {
        if (!alive) return;
        setHome(h);
        setMissing(false);
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiFailure && err.status === 404) setMissing(true);
        else toastError(err);
      });
    return () => {
      alive = false;
    };
  }, [id, version, latest, reload]);

  const agent = live ?? home?.agent ?? null;
  const crumbs = [{ label: 'Agents', icon: <Bot size={15} />, to: { name: 'agents' } as const }, { label: agent?.name ?? id }];

  if (missing) {
    return (
      <>
        <ViewHeader crumbs={crumbs} />
        <div className="empty">
          <Bot size={28} className="empty-icon" />
          <div className="empty-title">Agent not found</div>
          <p className="empty-body">No agent called “{id}” has written to CENTCOM or published a profile.</p>
        </div>
      </>
    );
  }
  if (!home || !agent) return <ViewHeader crumbs={crumbs} />;

  const { profile, deliverables, activity } = home;
  const updatedBy = profile ? (agentById(agents, profile.updatedBy)?.name ?? profile.updatedBy) : '';
  const seen = agent.kind === 'human' ? 'You' : agent.lastSeen ? `Seen ${relTime(agent.lastSeen)}` : 'Not seen yet';
  const profileApi = <Code>PUT /api/agents/{id}/profile</Code>;

  return (
    <>
      <ViewHeader crumbs={crumbs} />
      <div className="view-body">
        <div className="page">
          <header className="agent-home-head">
            <AgentAvatar agent={agent} size={48} />
            <div className="agent-names">
              <h1 className="doc-title">{agent.name}</h1>
              <div className="agent-home-meta">
                <span className="mono">{agent.id}</span>
                <span className="pill">{agent.kind === 'human' ? 'Human' : 'Agent'}</span>
                <span>{seen}</span>
                {profile && <span className="pill">{sourceLabel(profile.source)}</span>}
              </div>
              {profile && (
                <div className="agent-home-meta" title={fullDate(profile.updated)}>
                  Updated {relTime(profile.updated)} by {updatedBy}
                </div>
              )}
            </div>
          </header>

          <Section title="Description">
            {profile?.description ? (
              <Markdown value={profile.description} docPath={profile.path} revision={profile.updated} />
            ) : profile ? (
              <p className="quiet">No description yet. Agents describe themselves in the description field of {profileApi}.</p>
            ) : (
              <p className="quiet">
                This agent hasn’t published a profile yet. Agents publish with {profileApi}; see docs/AGENT-ACCESS.md.
              </p>
            )}
          </Section>

          <Section title="Operating instructions and rules">
            {profile?.instructions ? (
              <Instructions value={profile.instructions} docPath={profile.path} revision={profile.updated} />
            ) : (
              <p className="quiet">No instructions or rules yet. Agents include them as instructions (markdown) in {profileApi}.</p>
            )}
          </Section>

          <Section title="Skills">
            {profile?.skills.length ? (
              <ul className="skill-list">
                {profile.skills.map((s) => (
                  <li key={s.name} className="skill-row">
                    <span className="skill-name mono">{s.name}</span>
                    <span className="skill-desc">{s.description}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="quiet">No skills listed. Agents list them as skills, a name and one line each, in {profileApi}.</p>
            )}
          </Section>

          <Section title="Outputs">
            <h3 className="sub-title">Deliverables</h3>
            {deliverables.length ? (
              <div className="file-list">
                {deliverables.map((d) => (
                  <DeliverableRow key={d.id} agentId={id} d={d} onRemoved={() => setReload((n) => n + 1)} />
                ))}
              </div>
            ) : (
              <p className="quiet">
                Nothing reported yet. Agents report the PRs, docs, files and links they ship with <Code>POST /api/agents/{id}/deliverables</Code>.
              </p>
            )}
            <h3 className="sub-title">Activity</h3>
            {activity.length ? (
              <ActivityDays events={activity} />
            ) : (
              <p className="quiet">No activity yet. Tickets this agent files, claims or comments on, and docs it edits, show up here.</p>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
