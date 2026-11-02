import { useId, useMemo, useState } from 'react';
import type { ActivityEvent, Agent } from '@shared/types';
import { api } from '../lib/api';
import { oneLine, sourceLabel } from '../lib/agentHome';
import { dayHeading, pluralize, relTime } from '../lib/format';
import { href } from '../lib/router';
import { agentById, refreshAgents, useStore } from '../lib/store';
import { ViewHeader } from '../shell/ViewHeader';
import { StatusIcon } from '../ui/glyphs';
import { Activity as ActivityIcon, Bot, Edit, Search, ChevronRight } from '../ui/icons';
import { prompt, toastError } from '../ui/overlays';
import { AgentAvatar } from '../ui/pickers';
import { FeedRow } from './ActivityFeed';
import { FilterButton } from '../ui/FilterButton';
import { Select } from '../ui/Select';
import { activityKindLabel, filterActivity } from '../lib/activityQuery';

export function ActivityView() {
  const activity = useStore((s) => s.activity);
  const tickets = useStore((s) => s.tickets);
  const agents = useStore((s) => s.agents);
  const [agentFilter, setAgentFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [oldestFirst, setOldestFirst] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const filterId = useId();
  const activeCount = Number(!!agentFilter) + Number(!!kindFilter);
  // Instruction changes always show: agents act on them, so who changed them is never noise.
  const sourceEvents = useMemo(() => activity.filter(ev => ev.ticket || ev.type === 'agent.instructions_changed' || /^Projects\/[^/]+\/project\.md$/.test(ev.path ?? '')), [activity]);
  const events = useMemo(() => filterActivity(sourceEvents, agentFilter, kindFilter, oldestFirst), [sourceEvents, agentFilter, kindFilter, oldestFirst]);
  const actorIds = [...new Set(sourceEvents.map(e => e.agent))].sort();
  const kinds = [...new Set(sourceEvents.map(e => e.type))].sort();

  const inFlight = useMemo(
    () => tickets.filter((t) => t.status === 'in_progress' || t.status === 'in_review').sort((a, b) => b.updated - a.updated),
    [tickets],
  );
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
      <ViewHeader crumbs={[{ label: 'Activity', icon: <ActivityIcon size={15} /> }]}>
        <FilterButton label="Filter activity" activeCount={activeCount} aria-expanded={filtering} aria-controls={filtering ? filterId : undefined} onClick={() => setFiltering(!filtering)}/>
      </ViewHeader>
      <div className="view-body">
        <div className="page">
          <section className="page-section">
            <h2 className="eyebrow">In flight</h2>
            {inFlight.length === 0 ? (
              <p className="quiet">Nothing is in progress. When an agent picks up a ticket it shows up here.</p>
            ) : (
              <div className="flight-grid">
                {inFlight.slice(0, 8).map((t) => {
                  const agent = agentById(agents, t.agent);
                  return (
                    <a key={t.id} className="flight-card" href={href({ name: 'ticket', id: t.id })} draggable={false}>
                      <div className="flight-top">
                        <StatusIcon status={t.status} />
                        <span className="ticket-id mono tnum">{t.id}</span>
                        <span className="header-spacer" />
                        <span className="flight-time">{relTime(t.updated)}</span>
                      </div>
                      <div className="flight-title">{t.title}</div>
                      <div className="flight-agent">
                        <AgentAvatar agent={agent} size={16} />
                        <span className="truncate">{agent?.name ?? 'Unassigned'}</span>
                      </div>
                    </a>
                  );
                })}
              </div>
            )}
          </section>

          <section className="page-section">
            <div className="section-head">
              <h2 className="eyebrow">Feed</h2>
              <span className="quiet">{events.length} recent events · {oldestFirst ? 'Oldest first' : 'Newest first'}</span>
            </div>
            {filtering && <div id={filterId} className="inventory-filter-panel activity-filter-panel">
              <label>Who acted<Select aria-label="Who acted" value={agentFilter} onChange={setAgentFilter}><option value="">Everyone</option>{actorIds.map(id => <option key={id} value={id}>{agentById(agents, id)?.name ?? id}</option>)}</Select></label>
              <label>Event<Select aria-label="Event" value={kindFilter} onChange={setKindFilter}><option value="">All events</option>{kinds.map(kind => <option key={kind} value={kind}>{activityKindLabel(kind)}</option>)}</Select></label>
              <label>Order<Select aria-label="Order" value={oldestFirst ? 'oldest' : 'newest'} onChange={value => setOldestFirst(value === 'oldest')}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></Select></label>
              <button className="btn" onClick={() => {setAgentFilter(''); setKindFilter(''); setOldestFirst(false);}}>Reset</button>
            </div>}
            {activeCount > 0 && <div className="inventory-results"><span>{[agentFilter && (agentById(agents, agentFilter)?.name ?? agentFilter), kindFilter && activityKindLabel(kindFilter)].filter(Boolean).join(' · ')}</span><button className="btn" onClick={() => {setAgentFilter(''); setKindFilter('');}}>Clear filters</button></div>}
            {days.length === 0 ? (
              <div className="empty">
                <ActivityIcon size={28} className="empty-icon" />
                <div className="empty-title">{activeCount ? 'No matching activity' : 'No activity yet'}</div>
                <p className="empty-body">
                  {activeCount ? 'Try changing or clearing your filters.' : 'Task changes, comments, and project updates appear here as they happen.'}
                </p>
              </div>
            ) : (
              days.map(([day, events]) => (
                <div key={day} className="feed-day">
                  <h3 className="feed-day-head">{day}</h3>
                  {events.map((ev) => (
                    <FeedRow key={ev.id} ev={ev} />
                  ))}
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </>
  );
}

export function AgentsView() {
  const registry = useStore((s) => s.agents);
  const [query, setQuery] = useState('');
  const directory = registry.filter((agent) => agent.showInDirectory === true);
  const tickets = useStore((s) => s.tickets);
  const activity = useStore((s) => s.activity);
  const profiles = useStore((s) => s.profiles);
  const agents = directory.filter(a => `${a.name} ${a.id} ${profiles.find(p => p.id === a.id)?.description ?? ''}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => a.name.localeCompare(b.name));

  const rename = async (a: Agent) => {
    const name = await prompt({ title: 'Rename agent', label: `Display name for “${a.id}”`, initial: a.name, confirmLabel: 'Rename' });
    if (!name) return;
    api.updateAgent(a.id, { name }).then(refreshAgents).catch(toastError);
  };

  return (
    <>
      <ViewHeader crumbs={[{ label: 'Agents', icon: <Bot size={15} /> }]} />
      <div className="view-body">
        <div className="page agent-directory">
          <h1>Agents</h1>
          <p className="lede">
            Your bots and personal agents. Open one to see who it is, how it works, its skills and what it has shipped.
          </p>
          <label className="skill-search"><Search size={16}/><input aria-label="Find an agent" placeholder="Find an agent…" value={query} onChange={e => setQuery(e.target.value)}/></label>
          {!agents.length && <div className="empty"><h2>No matching agents</h2><p>Try another name or skill.</p>{query && <button className="btn" onClick={() => setQuery('')}>Clear search</button>}</div>}
          <div className="agent-grid">
            {agents.map((a) => {
              const mine = tickets.filter((t) => t.agent === a.id);
              const working = mine.filter((t) => t.status === 'in_progress' || t.status === 'in_review');
              const open = mine.filter((t) => t.status === 'todo' || t.status === 'backlog');
              const done = mine.filter((t) => t.status === 'done');
              const last = activity.find((e) => e.agent === a.id);
              const profile = profiles.find((p) => p.id === a.id);
              return (
                <article key={a.id} className="agent-card">
                  <header className="agent-head">
                    <AgentAvatar agent={a} size={32} />
                    <div className="agent-names">
                      <a className="agent-name agent-home-link" href={href({ name: 'agent', id: a.id })} draggable={false}>
                        {a.name}
                      </a>
                      <div className="agent-id mono">{a.id}</div>
                    </div>
                    <button className="icon-btn" aria-label={`Rename ${a.name}`} title="Rename" onClick={() => void rename(a)}>
                      <Edit size={14} />
                    </button>
                  </header>
                  {profile && (
                    <div className="agent-about">
                      {profile.description && <p className="agent-desc" title={oneLine(profile.description)}>{oneLine(profile.description)}</p>}

                    </div>
                  )}
                  {profile && <span className="agent-source">{sourceLabel(profile.source)}</span>}
                  <dl className="agent-stats tnum">
                    <div><dt>Working</dt><dd>{working.length}</dd></div>
                    <div><dt>Queued</dt><dd>{open.length}</dd></div>
                    <div><dt>Done</dt><dd>{done.length}</dd></div>
                  </dl>
                  {working.slice(0, 3).map((t) => (
                    <a key={t.id} className="agent-ticket" href={href({ name: 'ticket', id: t.id })} draggable={false}>
                      <StatusIcon status={t.status} size={13} />
                      <span className="ticket-id mono tnum">{t.id}</span>
                      <span className="truncate">{t.title}</span>
                    </a>
                  ))}
                  <footer className="agent-foot">
                    <span className="agent-seen">
                      {a.kind === 'human' ? 'You' : last ? `Active ${relTime(last.ts)}` : a.lastSeen ? `Seen ${relTime(a.lastSeen)}` : 'Not seen yet'}
                    </span>
                    <span className="agent-open" aria-hidden="true">View agent <ChevronRight size={14}/></span>
                  </footer>
                </article>
              );
            })}
          </div>
          <p className="quiet">{pluralize(agents.length, 'personal agent')}.</p>
        </div>
      </div>
    </>
  );
}
