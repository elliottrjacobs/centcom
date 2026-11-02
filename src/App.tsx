import { InstructionsView } from './views/InstructionsView';
import { ProjectsView } from './views/ProjectsView';
import { SkillsView } from './views/SkillsView';
import { PageMenu } from './shell/PageMenu';
import { useEffect, useState } from 'react';
import { useRoute } from './lib/router';
import { useStore } from './lib/store';
import { usePersisted } from './lib/usePersisted';
import { CommandPalette } from './shell/CommandPalette';
import { NewProjectDialog, NewTicketDialog, type NewTicketDefaults } from './shell/Dialogs';
import { Sidebar } from './shell/Sidebar';
import { ViewHeader } from './shell/ViewHeader';
import { Inbox, Ticket } from './ui/icons';
import { CentcomLogo } from './ui/CentcomLogo';
import { Overlays } from './ui/overlays';
import { Onboarding } from './shell/Onboarding';
import { ActivityView, AgentsView } from './views/ActivityView';
import { AgentHomeView } from './views/AgentHomeView';
import { LibraryPage } from './views/LibraryView';
import { ProjectView } from './views/ProjectView';
import { SettingsView, TrashView } from './views/SystemViews';
import { TicketDetail } from './views/TicketDetail';
import { TicketsView } from './views/TicketsView';

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && !!el.closest('input, textarea, select, [contenteditable="true"]');

export function App() {
  const route = useRoute();
  const ready = useStore((s) => s.ready);
  const online = useStore((s) => s.online);
  const hasData = useStore((s) => s.tree !== null);
  const [sidebarOpen, setSidebarOpen] = usePersisted('sidebar.open', true);
  const [palette, setPalette] = useState(false);
  const [newTicket, setNewTicket] = useState<NewTicketDefaults | null>(null);
  const [newProject, setNewProject] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (mod && e.key === '\\') {
        e.preventDefault();
        setSidebarOpen(!sidebarOpen);
      } else if (!mod && !e.altKey && e.key.toLowerCase() === 'c' && !isTyping(e.target) && !document.querySelector('.modal, .popover')) {
        e.preventDefault();
        // Default the new ticket to whatever project is on screen.
        setNewTicket({ project: route.name === 'project' ? route.slug : null });
      } else if (!mod && e.key === '/' && !isTyping(e.target)) {
        e.preventDefault();
        setPalette(true);
      }
    };
    const onNewTicket = (e: Event) => setNewTicket(((e as CustomEvent).detail as NewTicketDefaults | undefined) ?? {});
    const onNewProject = () => setNewProject(true);
    const onToggle = () => setSidebarOpen(!sidebarOpen);
    window.addEventListener('keydown', onKey);
    window.addEventListener('centcom:new-ticket', onNewTicket);
    window.addEventListener('centcom:new-project', onNewProject);
    window.addEventListener('centcom:toggle-sidebar', onToggle);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('centcom:new-ticket', onNewTicket);
      window.removeEventListener('centcom:new-project', onNewProject);
      window.removeEventListener('centcom:toggle-sidebar', onToggle);
    };
  }, [route, sidebarOpen, setSidebarOpen]);

  if (!ready) return <div className="boot" />;

  if (!online && !hasData) {
    return (
      <div className="boot">
        <div className="empty">
          <CentcomLogo size={40} className="empty-icon" />
          <div className="empty-title">Can’t reach the CENTCOM server</div>
          <p className="empty-body">
            The shared server isn’t answering yet. This screen reconnects automatically when the connection returns.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      <Sidebar onSearch={() => setPalette(true)} onCompose={() => setNewTicket({ project: route.name === 'project' ? route.slug : null })} />
      <main className="main">
        <div className="panel">
          {route.name === 'activity' && <ActivityView />}
          {route.name === 'inbox' && (
            <>
              <ViewHeader crumbs={[{ label: 'Inbox', icon: <Inbox size={15} /> }]} />
              <TicketsView project={null} />
            </>
          )}
          {route.name === 'tickets' && (
            <>
              <ViewHeader crumbs={[{ label: 'All tasks', icon: <Ticket size={15} /> }]} />
              <TicketsView />
            </>
          )}
          {route.name === 'agents' && <AgentsView />}
          {route.name === 'agent' && <AgentHomeView key={route.id} id={route.id} />}
          {route.name === 'skills' && <SkillsView />}
          {route.name === 'instructions' && <InstructionsView />}
          {route.name === 'projects' && <ProjectsView />}
          {route.name === 'ticket' && <TicketDetail key={route.id} id={route.id} />}
          {route.name === 'project' && <ProjectView slug={route.slug} tab={route.tab} />}
          {route.name === 'doc' && <LibraryPage key={route.path} path={route.path} />}
          {route.name === 'trash' && <TrashView />}
          {route.name === 'settings' && <SettingsView />}
        </div>
      </main>

      <PageMenu onSearch={() => setPalette(true)} />
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {newTicket && <NewTicketDialog defaults={newTicket} onClose={() => setNewTicket(null)} />}
      {newProject && <NewProjectDialog onClose={() => setNewProject(false)} />}
      <Overlays />
      {window.centcom?.onboarding && <Onboarding />}
    </div>
  );
}
