import { DatePicker } from '../ui/DatePicker';
import { copyText } from '../lib/clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ticket } from '@shared/types';
import { MarkdownEditor } from '../editor/MarkdownEditor';
import { api, ApiFailure, type TicketDetail as Detail } from '../lib/api';
import { copyPath } from '../lib/actions';
import { fullDate, relTime } from '../lib/format';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { ViewHeader } from '../shell/ViewHeader';
import { Clipboard, Inbox, MoreH, Plus, Send, Ticket as TicketIcon, Trash } from '../ui/icons';
import { Menu, Popover, toast, toastError, usePopover } from '../ui/overlays';
import { AgentChip, AgentPicker, LabelPicker, PriorityPicker, ProjectDot, ProjectPicker, StatusPicker } from '../ui/pickers';
import { TicketTimeline } from './ActivityFeed';
import { TicketRow, deleteTicket, updateTicket } from './TicketsView';

export function TicketDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  // Any store change touching this ticket (SSE-driven) triggers a refetch of the full detail.
  const live = useStore((s) => s.tickets.find((t) => t.id === id));
  // New events and comments edited or deleted elsewhere both refetch.
  const activityTick = useStore((s) => s.activity.filter((a) => a.ticket === id).map((a) => `${a.id}:${a.editedAt ?? ''}:${a.deletedAt ?? ''}`).join());
  const project = useStore((s) => s.projects.find((p) => p.slug === (detail?.ticket.project ?? live?.project)) ?? null);
  const more = usePopover();
  const lastDevice = detail?.activity.filter(e => e.device).sort((a,b) => b.ts - a.ts)[0];

  const load = useCallback(async () => {
    try {
      const d = await api.ticket(id);
      setDetail(d);
      setMissing(false);
      // A re-keyed ticket (moved between projects) resolves under its new id: follow it.
      if (d.ticket.id !== id) navigate({ name: 'ticket', id: d.ticket.id }, { replace: true });
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 404) setMissing(true);
      else toastError(err);
    }
  }, [id]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (detail) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.updated, activityTick]);

  if (missing) {
    return (
      <>
        <ViewHeader crumbs={[{ label: 'Tickets', to: { name: 'tickets' } }, { label: id }]} />
        <div className="empty">
          <TicketIcon size={28} className="empty-icon" />
          <div className="empty-title">{id} doesn’t exist</div>
          <p className="empty-body">It may have been moved to Trash, or the ID is mistyped.</p>
          <button className="btn" onClick={() => navigate({ name: 'tickets' })}>
            Back to tickets
          </button>
        </div>
      </>
    );
  }
  if (!detail) return <ViewHeader crumbs={[{ label: id }]} />;

  // Prefer the live store copy for properties so optimistic edits show immediately.
  const t: Ticket = live ? { ...detail.ticket, ...live, body: detail.ticket.body } : detail.ticket;

  return (
    <>
      <ViewHeader
        crumbs={[
          project
            ? { label: project.name, icon: <ProjectDot project={project} />, to: { name: 'project', slug: project.slug, tab: 'tickets' } }
            : { label: 'Inbox', icon: <Inbox size={14} />, to: { name: 'inbox' } },
          { label: t.id },
        ]}
      >
        <button className="icon-btn" title="Copy ID" onClick={() => void copyText(t.id).then(() => toast(`${t.id} copied`)).catch(toastError)}>
          <Clipboard size={15} />
        </button>
        <button className="icon-btn" title="More" onClick={(e) => more.open(e.currentTarget)}>
          <MoreH size={15} />
        </button>
        {more.anchor && (
          <Popover anchor={more.anchor} onClose={more.close} className="popover-menu" align="end">
            <Menu
              onClose={more.close}
              items={[
                { id: 'sub', label: 'Add sub-ticket', icon: <Plus size={14} />, onSelect: () => window.dispatchEvent(new CustomEvent('centcom:new-ticket', { detail: { project: t.project, parent: t.id } })) },
                { id: 'path', label: 'Copy file path', icon: <Clipboard size={14} />, onSelect: () => void copyPath(t.path) },
                {
                  id: 'del',
                  label: 'Move to Trash',
                  icon: <Trash size={14} />,
                  danger: true,
                  separatorBefore: true,
                  onSelect: () => void deleteTicket(t).then(() => navigate(project ? { name: 'project', slug: project.slug, tab: 'tickets' } : { name: 'tickets' })),
                },
              ]}
            />
          </Popover>
        )}
      </ViewHeader>

      <div className="detail">
        <div className="detail-main view-body">
          <div className="detail-col">
            <TitleField key={t.id} value={t.title} onCommit={(title) => void updateTicket(t, { title })} />
            <DescriptionField key={`${t.id}:body`} ticket={detail.ticket} />

            {(detail.children.length > 0 || t.parent) && (
              <section className="detail-section">
                <div className="section-head">
                  <h3>{t.parent ? `Sub-ticket of ${t.parent}` : 'Sub-tickets'}</h3>
                  {!t.parent && (
                    <button className="icon-btn" title="Add sub-ticket" onClick={() => openNewTicketWithParent(t)}>
                      <Plus size={14} />
                    </button>
                  )}
                </div>
                {t.parent && (
                  <button className="btn btn-ghost btn-sm" onClick={() => navigate({ name: 'ticket', id: t.parent! })}>
                    Open {t.parent}
                  </button>
                )}
                <div className="sub-list">
                  {detail.children.map((c) => (
                    <TicketRow key={c.id} ticket={c} />
                  ))}
                </div>
              </section>
            )}

            <section className="detail-section">
              <div className="section-head">
                <h3>Activity</h3>
              </div>
              <TicketTimeline events={detail.activity} docPath={t.path} ticketId={t.id} onChanged={load} />
              <CommentBox ticketId={t.id} docPath={t.path} onPosted={load} />
            </section>
          </div>
        </div>

        <aside className="detail-side">
          <div className="side-card">
            <div className="side-title">Properties</div>
            <Prop label="Status">
              <StatusPicker variant="field" value={t.status} onChange={(status) => void updateTicket(t, { status })} />
            </Prop>
            <Prop label="Priority">
              <PriorityPicker variant="field" value={t.priority} onChange={(priority) => void updateTicket(t, { priority })} />
            </Prop>
            <Prop label="Assignee">
              <AgentPicker variant="field" value={t.agent} onChange={(agent) => void updateTicket(t, { agent })} />
            </Prop>
            <Prop label="Labels">
              <LabelPicker project={t.project} value={t.labels} onChange={(labels) => void updateTicket(t, { labels })} />
            </Prop>
            <Prop label="Project">
              <ProjectPicker
                value={t.project}
                onChange={(p) => {
                  if (p === t.project) return;
                  // Moving projects re-keys the ticket on the server; reload to pick up the new id.
                  api.updateTicket(t.id, { project: p }).then((next) => navigate({ name: 'ticket', id: next.id }, { replace: true })).catch(toastError);
                }}
              />
            </Prop>
            <Prop label="Last device">
              <span title={lastDevice ? `Most recent reported device · ${fullDate(lastDevice.ts)}` : 'No device has been reported for this ticket'}>{lastDevice?.device ?? 'Not reported'}</span>{lastDevice && <span className="reported-by">Reported by <AgentChip id={lastDevice.agent} size={14}/></span>}
            </Prop>
            <Prop label="Due">
              <DatePicker value={t.due ?? null} onChange={due => void updateTicket(t, { due })}/>
            </Prop>
          </div>
          <div className="side-card side-meta">
            <div className="meta-row">
              <span>Filed by</span>
              <AgentChip id={t.createdBy} size={16} />
            </div>
            <div className="meta-row">
              <span>Created</span>
              <time title={fullDate(t.created)}>{relTime(t.created)}</time>
            </div>
            <div className="meta-row">
              <span>Updated</span>
              <time title={fullDate(t.updated)}>{relTime(t.updated)}</time>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

function openNewTicketWithParent(t: Ticket) {
  window.dispatchEvent(new CustomEvent('centcom:new-ticket', { detail: { project: t.project, parent: t.id } }));
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <div className="prop-value">{children}</div>
    </div>
  );
}

/** Title edits commit on blur or Enter, never per keystroke. */
function TitleField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const commit = () => {
    const next = text.trim();
    if (next && next !== value) onCommit(next);
    else setText(value);
  };
  return (
    <textarea
      ref={ref}
      className="title-field selectable"
      rows={1}
      value={text}
      placeholder="Ticket title"
      onChange={(e) => setText(e.target.value.replace(/\n/g, ' '))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function DescriptionField({ ticket }: { ticket: Ticket }) {
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<string | null>(null);
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (pending.current === null) return;
    const body = pending.current;
    pending.current = null;
    api.updateTicket(ticket.id, { body }).catch(toastError);
  }, [ticket.id]);
  // Never lose the last few keystrokes when navigating away.
  useEffect(() => flush, [flush]);

  return (
    <MarkdownEditor
      value={ticket.body}
      docPath={ticket.path}
      placeholder="Add a description…"
      compact
      onChange={(md) => {
        pending.current = md;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, 700);
      }}
    />
  );
}

function CommentBox({ ticketId, docPath, onPosted }: { ticketId: string; docPath: string; onPosted: () => void }) {
  const [text, setText] = useState('');
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const post = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.comment(ticketId, body);
      setText('');
      setNonce((n) => n + 1); // remount to clear the editor
      onPosted();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comment-box">
      <MarkdownEditor
        key={nonce}
        value=""
        docPath={docPath}
        onChange={setText}
        onSubmit={() => void post()}
        placeholder="Leave a comment…"
        toolbar={false}
        compact
      />
      <div className="comment-actions">
        <span className="hint">
          <kbd>⌘</kbd> <kbd>↵</kbd> to send
        </span>
        <button className="btn btn-primary btn-sm" disabled={!text.trim() || busy} onClick={() => void post()}>
          <Send size={13} /> Comment
        </button>
      </div>
    </div>
  );
}
