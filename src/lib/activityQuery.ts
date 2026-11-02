import type { ActivityEvent } from '@shared/types';

export function filterActivity(events: ActivityEvent[], actor: string, kind: string, oldestFirst: boolean) {
  return events.filter(event => (!actor || event.agent === actor) && (!kind || event.type === kind))
    .sort((a, b) => (oldestFirst ? a.ts - b.ts : b.ts - a.ts) || a.id.localeCompare(b.id));
}

export function activityKindLabel(kind: string) {
  return ({'ticket.created': 'Task created', 'ticket.updated': 'Task updated', 'ticket.comment': 'Comment', 'agent.instructions_changed': 'Instructions changed'} as Record<string, string>)[kind]
    ?? kind.replaceAll('.', ' ').replace(/^./, value => value.toUpperCase());
}
