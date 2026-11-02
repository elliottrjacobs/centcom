import { ProjectAppearance, PROJECT_COLORS } from '../ui/ProjectAppearance';
import { useState } from 'react';
import type { TicketPriority, TicketStatus } from '@shared/types';
import { MarkdownEditor } from '../editor/MarkdownEditor';
import { api, me } from '../lib/api';
import { navigate } from '../lib/router';
import { refreshProjects, refreshTree, useStore } from '../lib/store';
import { Modal, toast, toastError } from '../ui/overlays';
import { AgentPicker, LabelPicker, PriorityPicker, ProjectPicker, StatusPicker } from '../ui/pickers';

export interface NewTicketDefaults {
  project?: string | null;
  status?: TicketStatus;
  parent?: string | null;
}

export function NewTicketDialog({ defaults, onClose }: { defaults: NewTicketDefaults; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [project, setProject] = useState<string | null>(defaults.project ?? null);
  const [status, setStatus] = useState<TicketStatus>(defaults.status ?? 'todo');
  const [priority, setPriority] = useState<TicketPriority>(0);
  const [agent, setAgent] = useState<string | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const projects = useStore((s) => s.projects);
  const current = projects.find((p) => p.slug === project);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const t = await api.createTicket({
        title: title.trim(),
        body,
        project,
        status,
        priority,
        agent,
        labels,
        parent: defaults.parent ?? null,
        createdBy: me(),
      });
      toast(`${t.id} created`, { action: { label: 'Open', run: () => navigate({ name: 'ticket', id: t.id }) } });
      if (more) {
        setTitle('');
        setBody('');
        setBusy(false);
      } else onClose();
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <>
    {!creatingProject && <Modal onClose={onClose} width={680} instant>
      <form
        className="compose-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="compose-crumb">
          <span className="pill">{current ? current.key : 'INB'}</span>
          <span>{defaults.parent ? `New subtask of ${defaults.parent}` : 'New task'}</span>
        </div>
        <input
          className="compose-title selectable"
          placeholder="Task title"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="compose-body">
          <MarkdownEditor
            key={busy ? 'busy' : 'idle'}
            value={body}
            onChange={setBody}
            docPath={current ? `${current.path}/Tickets/new.md` : 'Inbox/new.md'}
            placeholder="Add a description…"
            toolbar={false}
            compact
          />
        </div>
        <div className="compose-props">
          <StatusPicker variant="field" value={status} onChange={setStatus} />
          <PriorityPicker variant="field" value={priority} onChange={setPriority} />
          <AgentPicker variant="field" value={agent} onChange={setAgent} />
          <ProjectPicker onCreate={() => setCreatingProject(true)} value={project} onChange={next => {setProject(next); setLabels([]);}} />
          <LabelPicker project={project} value={labels} onChange={setLabels} />
        </div>
        <div className="compose-foot">
          <label className="check">
            <input type="checkbox" checked={more} onChange={(e) => setMore(e.target.checked)} />
            Create more
          </label>
          <span className="header-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!title.trim() || busy}>
            Create task
          </button>
        </div>
      </form>
    </Modal>}
    {creatingProject && <NewProjectDialog onClose={() => setCreatingProject(false)} onCreated={slug => {setProject(slug); setLabels([]);}} />}
    </>
  );
}

const COLORS = PROJECT_COLORS;

function deriveKey(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0]!.slice(0, 3);
  return words.map((w) => w[0]).join('').slice(0, 4);
}

export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (slug: string) => void }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [summary, setSummary] = useState('');
  const [color, setColor] = useState(COLORS[0]!);
  const [icon, setIcon] = useState('Box');
  const [busy, setBusy] = useState(false);
  // Select the stable array and derive outside: a selector that builds a new array every call never settles.
  const taken = useStore((s) => s.projects).map((p) => p.key);
  const effectiveKey = (keyTouched ? key : deriveKey(name)).toUpperCase();
  const keyValid = /^[A-Z]{2,5}$/.test(effectiveKey) && !taken.includes(effectiveKey) && effectiveKey !== 'INB';

  const submit = async () => {
    if (!name.trim() || !keyValid || busy) return;
    setBusy(true);
    try {
      const p = await api.createProject({ name: name.trim(), key: effectiveKey, summary: summary.trim(), color, icon, status: 'active', lead: me() });
      await Promise.all([refreshProjects(), refreshTree()]);
      if (onCreated) onCreated(p.slug);
      else navigate({ name: 'project', slug: p.slug, tab: 'overview' });
      onClose();
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} width={480}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="dialog-title">New project</h2>
        <p className="dialog-body">Every project gets a home page, a task list, and a library for its docs, outputs and files.</p>
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Wildlife Dex" />
        </label>
        <div className="field-row">
          <label className="field" style={{ width: 120 }}>
            <span className="field-label">Ticket prefix</span>
            <input
              className="input mono"
              value={effectiveKey}
              maxLength={5}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value.replace(/[^a-zA-Z]/g, ''));
              }}
              placeholder="WLD"
              aria-invalid={!!effectiveKey && !keyValid}
            />
          </label>

        </div>
        <ProjectAppearance icon={icon} color={color} onIcon={setIcon} onColor={setColor} />
        {effectiveKey && !keyValid && (
          <p className="field-error">
            {taken.includes(effectiveKey) || effectiveKey === 'INB' ? `${effectiveKey} is already in use.` : 'Use 2–5 letters.'}
          </p>
        )}
        <label className="field">
          <span className="field-label">Summary</span>
          <input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="One line on what this is" />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || !keyValid || busy}>
            Create project
          </button>
        </div>
      </form>
    </Modal>
  );
}
