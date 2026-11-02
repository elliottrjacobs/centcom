import { LabelManager } from '../ui/LabelManager';
import { ProjectAppearance, ProjectIcon } from '../ui/ProjectAppearance';
import { useState } from 'react';
import { PROJECT_STATUSES, type Project } from '@shared/types';
import { MarkdownEditor } from '../editor/MarkdownEditor';
import { api } from '../lib/api';
import * as act from '../lib/actions';
import { PROJECT_STATUS_LABEL, safeName } from '../lib/format';
import { href, navigate, type ProjectTab } from '../lib/router';
import { refreshProjects, refreshTree, useStore } from '../lib/store';
import { ViewHeader } from '../shell/ViewHeader';
import { ProjectStatusIcon, StatusIcon, PriorityIcon } from '../ui/glyphs';
import { Box, Clipboard, Edit, MoreH, Plus, Trash } from '../ui/icons';
import { Menu, Modal, Popover, confirm, prompt, toastError, usePopover } from '../ui/overlays';
import { AgentPicker, ProjectDot } from '../ui/pickers';
import { LibraryView } from './LibraryView';
import { TicketsView } from './TicketsView';

const TAB_LABEL: Record<ProjectTab, string> = { overview: 'Home', tickets: 'Tasks', library: 'Library' };

export function ProjectView({ slug, tab }: { slug: string; tab: ProjectTab }) {
  const project = useStore((s) => s.projects.find((p) => p.slug === slug));
  const ready = useStore((s) => s.ready);
  const more = usePopover();
  const [managingLabels, setManagingLabels] = useState(false);
  const [editing, setEditing] = useState(false);

  if (!project) {
    return (
      <>
        <ViewHeader crumbs={[{ label: slug }]} />
        {ready && (
          <div className="empty">
            <Box size={28} className="empty-icon" />
            <div className="empty-title">Project not found</div>
            <p className="empty-body">“{slug}” may have been renamed or moved to Trash.</p>
          </div>
        )}
      </>
    );
  }

  const open = project.counts.todo + project.counts.in_progress + project.counts.in_review + project.counts.backlog;

  const destroy = async () => {
    const ok = await confirm({
      title: `Move “${project.name}” to Trash?`,
      body: 'Its tasks and project details go with it. You can restore the whole project from Trash.',
      confirmLabel: 'Move to Trash',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteProject(project.slug);
      await Promise.all([refreshProjects(), refreshTree()]);
      navigate({ name: 'activity' });
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <>
      <ViewHeader crumbs={[{ label: project.name, icon: <ProjectDot project={project} /> }]}>
        <button className="btn btn-sm" onClick={() => setManagingLabels(true)}>Labels</button>
        <button className="btn btn-sm" onClick={() => setEditing(true)}><Edit size={14} /> Edit project</button>
        <button className="icon-btn" title="More" onClick={(e) => more.open(e.currentTarget)}>
          <MoreH size={15} />
        </button>
        {more.anchor && (
          <Popover anchor={more.anchor} onClose={more.close} className="popover-menu" align="end">
            <Menu
              onClose={more.close}
              items={[
                { id: 'path', label: 'Copy folder path', icon: <Clipboard size={14} />, onSelect: () => void act.copyPath(project.path) },
                { id: 'del', label: 'Move project to Trash', icon: <Trash size={14} />, danger: true, separatorBefore: true, onSelect: () => void destroy() },
              ]}
            />
          </Popover>
        )}
      </ViewHeader>
      <div className="view-subheader">
        <div className="tabs" role="tablist">
          {(Object.keys(TAB_LABEL) as ProjectTab[]).map((t) => (
            <a key={t} role="tab" className="tab" aria-selected={tab === t} href={href({ name: 'project', slug, tab: t })} draggable={false}>
              {TAB_LABEL[t]}
              {t === 'tickets' && open > 0 && <span className="tab-count">{open}</span>}
            </a>
          ))}
        </div>
      </div>
      {managingLabels && <LabelManager project={slug} onClose={() => setManagingLabels(false)} />}
      {editing && <EditProject project={project} onClose={() => setEditing(false)} />}
      {tab === 'overview' && <Overview key={project.slug} project={project} />}
      {tab === 'library' && <LibraryView slug={project.slug} />}
      {tab === 'tickets' && <TicketsView project={project.slug} embedded />}
    </>
  );
}

/* ───────── Overview ───────── */

function Overview({ project }: { project: Project }) {
  const tickets = useStore((s) => s.tickets);
  const active = tickets.filter((t) => t.project === project.slug && !['done', 'canceled'].includes(t.status)).sort((a, b) => (a.priority || 5) - (b.priority || 5) || b.updated - a.updated).slice(0, 6);
  const statusPop = usePopover();

  const patch = (input: Parameters<typeof api.updateProject>[1]) =>
    api
      .updateProject(project.slug, input)
      .then(async (next) => {
        await refreshProjects();
        if (next.slug !== project.slug) {
          await refreshTree();
          navigate({ name: 'project', slug: next.slug, tab: 'overview' }, { replace: true });
        }
      })
      .catch(toastError);

  const total = Object.values(project.counts).reduce((a, b) => a + b, 0) - project.counts.canceled;

  return (
    <div className="view-body">
      <article className="doc">
        <header className="doc-head">
          <div className="project-mark"><ProjectIcon icon={project.icon} color={project.color} size={24} /></div>
          <h1
            className="doc-title"
            title="Double-click to rename"
            onDoubleClick={async () => {
              const name = await prompt({ title: 'Rename project', initial: project.name, confirmLabel: 'Rename' });
              if (name && safeName(name) && safeName(name) !== project.name) void patch({ name: safeName(name) });
            }}
          >
            {project.name}
          </h1>


          <div className="project-props">
            <button className="prop-field" onClick={(e) => statusPop.open(e.currentTarget)}>
              <ProjectStatusIcon status={project.status} />
              {PROJECT_STATUS_LABEL[project.status]}
            </button>
            {statusPop.anchor && (
              <Popover anchor={statusPop.anchor} onClose={statusPop.close} className="popover-menu">
                <Menu
                  onClose={statusPop.close}
                  items={PROJECT_STATUSES.map((s) => ({
                    id: s,
                    label: PROJECT_STATUS_LABEL[s],
                    icon: <ProjectStatusIcon status={s} />,
                    checked: s === project.status,
                    onSelect: () => void patch({ status: s }),
                  }))}
                />
              </Popover>
            )}
            <AgentPicker variant="field" value={project.lead} onChange={(lead) => void patch({ lead })} />
            <span className="pill mono">{project.key}</span>

          </div>
        </header>
        <section className="project-about"><h2 className="project-home-heading">About this project</h2>
          {project.body ? <MarkdownEditor value={project.body} revision={project.updated} docPath={`${project.path}/project.md`} onChange={() => {}} readOnly /> : <p className="quiet">Use Edit project to add its purpose, goals, and context.</p>}
        </section>
        <div className="project-home-stats">
          {([['Open tasks', total - project.counts.done], ['In progress', project.counts.in_progress], ['In review', project.counts.in_review], ['Completed', project.counts.done]] as const).map(([label, count]) => <div key={label}><span>{label}</span><strong className="tnum">{count}</strong></div>)}
        </div>
        <section className="project-home-work">
          <div className="project-home-heading"><h2>Active work</h2><button className="btn btn-sm" onClick={() => window.dispatchEvent(new CustomEvent('centcom:new-ticket', { detail: { project: project.slug } }))}><Plus size={13} /> New task</button></div>
          {active.length ? active.map((t) => <a className="project-home-task" key={t.id} href={href({ name: 'ticket', id: t.id })}><StatusIcon status={t.status} /><span className="mono quiet">{t.id}</span><span className="truncate">{t.title}</span><PriorityIcon priority={t.priority} /></a>) : <p className="quiet">No open tasks. Add one to get started.</p>}
          <a className="project-home-all" href={href({ name: 'project', slug: project.slug, tab: 'tickets' })}>View all tasks →</a>
        </section>

      </article>
    </div>
  );
}

function EditProject({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [summary, setSummary] = useState(project.summary);
  const [body, setBody] = useState(project.body);
  const [icon, setIcon] = useState(project.icon);
  const [color, setColor] = useState(project.color);
  const [busy, setBusy] = useState(false);
  const dirty = name !== project.name || summary !== project.summary || body !== project.body || icon !== project.icon || color !== project.color;
  const close = () => { if (!busy && (!dirty || window.confirm('Discard unsaved project changes?'))) onClose(); };
  const save = async () => {
    setBusy(true);
    try {
      const next = await api.updateProject(project.slug, { name, summary, body, icon, color });
      await Promise.all([refreshProjects(), refreshTree()]);
      if (next.slug !== project.slug) navigate({ name: 'project', slug: next.slug, tab: 'overview' });
      onClose();
    } catch (error) { toastError(error); } finally { setBusy(false); }
  };
  return <Modal onClose={close} width={720}><div className="dialog">
    <h2 className="dialog-title">Edit project</h2>
    <label className="field"><span className="field-label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label className="field"><span className="field-label">Short summary</span><input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
    <ProjectAppearance icon={icon} color={color} onIcon={setIcon} onColor={setColor} />
    <h3 className="field-label">About this project</h3>
    <MarkdownEditor value={body} onChange={setBody} docPath={`${project.path}/project.md`} />
    <div className="dialog-actions"><button className="btn" disabled={busy} onClick={close}>Cancel</button><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button></div>
  </div></Modal>;
}
