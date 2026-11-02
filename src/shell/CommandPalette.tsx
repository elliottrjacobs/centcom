import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SearchHit } from '@shared/types';
import { api } from '../lib/api';
import { navigate, routeForPath, type Route } from '../lib/router';
import { useStore } from '../lib/store';
import { BookOpen, Activity, Box, Bot, Document, Image as ImageIcon, Inbox, Library, Palette, Plus, Puzzle, Search, Settings, Ticket, Trash } from '../ui/icons';
import { Modal } from '../ui/overlays';
import { ProjectDot } from '../ui/pickers';

interface Item {
  id: string;
  group: string;
  label: string;
  detail?: string;
  icon: ReactNode;
  run: () => void;
}

const go = (r: Route) => () => navigate(r);

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const projects = useStore((s) => s.projects);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounced server search; stale responses are dropped.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      api
        .search(q, 24)
        .then((r) => live && setHits(r))
        .catch(() => live && setHits([]));
    }, 110);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query]);

  const items = useMemo<Item[]>(() => {
    const fire = (name: string, detail?: unknown) => () => window.dispatchEvent(new CustomEvent(name, { detail }));
    const commands: Item[] = [
      { id: 'c:ticket', group: 'Create', label: 'New task', detail: 'C', icon: <Plus size={15} />, run: fire('centcom:new-ticket', {}) },
      { id: 'c:project', group: 'Create', label: 'New project', icon: <Plus size={15} />, run: fire('centcom:new-project') },
      { id: 'g:activity', group: 'Go to', label: 'Activity', icon: <Activity size={15} />, run: go({ name: 'activity' }) },
      { id: 'g:inbox', group: 'Go to', label: 'Inbox', icon: <Inbox size={15} />, run: go({ name: 'inbox' }) },
      { id: 'g:tickets', group: 'Go to', label: 'All tasks', icon: <Ticket size={15} />, run: go({ name: 'tickets' }) },
      { id: 'g:instructions', group: 'Go to', label: 'Instructions', icon: <BookOpen size={15} />, run: go({ name: 'instructions' }) },
      { id: 'g:skills', group: 'Go to', label: 'Skills', icon: <Puzzle size={15} />, run: go({ name: 'skills' }) },
      { id: 'g:agents', group: 'Go to', label: 'Agents', icon: <Bot size={15} />, run: go({ name: 'agents' }) },
      { id: 'g:trash', group: 'Go to', label: 'Trash', icon: <Trash size={15} />, run: go({ name: 'trash' }) },
      { id: 'g:settings', group: 'Go to', label: 'Settings', icon: <Settings size={15} />, run: go({ name: 'settings' }) },
      ...projects.map<Item>((p) => ({
        id: `p:${p.slug}`,
        group: 'Projects',
        label: p.name,
        detail: p.key,
        icon: <ProjectDot project={p} size={15} />,
        run: go({ name: 'project', slug: p.slug, tab: 'overview' }),
      })),
    ];
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const matched = commands.filter((c) => c.label.toLowerCase().includes(q));
    const results = hits.map<Item>((h) => ({
      id: `h:${h.type}:${h.ticket ?? h.path}`,
      group: 'Results',
      label: h.title,
      detail: h.type === 'ticket' ? h.ticket : h.path.replace(/\/[^/]+$/, ''),
      icon:
        h.type === 'ticket' ? <Ticket size={15} /> : h.type === 'image' ? <ImageIcon size={15} /> : h.type === 'project' ? <Box size={15} /> : <Document size={15} />,
      run:
        h.type === 'ticket' && h.ticket
          ? go({ name: 'ticket', id: h.ticket })
          : () => navigate(routeForPath(h.path, h.type === 'image' ? 'image' : h.type === 'project' ? 'dir' : 'markdown')),
    }));
    return [...results, ...matched];
  }, [query, hits, projects]);

  useEffect(() => setActive(0), [query, hits.length]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (i: number) => {
    const item = items[i];
    if (!item) return;
    onClose();
    item.run();
  };

  let lastGroup = '';
  return (
    <Modal onClose={onClose} width={620} instant top>
      <div
        className="palette"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(items.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            run(active);
          }
        }}
      >
        <div className="palette-input">
          <Search size={16} />
          <input
            autoFocus
            className="selectable"
            placeholder="Search tasks, projects, and docs… or run a command"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header && <div className="palette-group">{header}</div>}
                <button className="palette-item" data-active={i === active} onPointerMove={() => setActive(i)} onClick={() => run(i)}>
                  <span className="menu-icon">{item.icon}</span>
                  <span className="truncate palette-label">{item.label}</span>
                  {item.detail && <span className="palette-detail truncate">{item.detail}</span>}
                </button>
              </div>
            );
          })}
          {items.length === 0 && <div className="menu-empty">No results for “{query}”</div>}
        </div>
      </div>
    </Modal>
  );
}
