import type { Ticket } from '../../shared/types';
export type TaskSort = 'priority' | 'updated' | 'created' | 'title' | 'due';
export const TASK_SORT_LABELS: Record<TaskSort, string> = {priority: 'Priority', updated: 'Recently updated', created: 'Newest created', title: 'Title A–Z', due: 'Due date'};
export interface TaskFilters { query: string; status: string; priority: string; agent: string; project: string; labels: string[]; due: string }
export const EMPTY_FILTERS: TaskFilters = {query: '', status: '', priority: '', agent: '', project: '', labels: [], due: ''};
export function matchesTask(t: Ticket, f: TaskFilters, today: string) {
  return (!f.query.trim() || `${t.id} ${t.title} ${t.body} ${t.labels.join(' ')}`.toLowerCase().includes(f.query.trim().toLowerCase())) &&
    (!f.status || t.status === f.status) && (!f.priority || t.priority === Number(f.priority)) &&
    (!f.agent || (f.agent === '__none' ? !t.agent : t.agent === f.agent)) &&
    (!f.project || (f.project === '__inbox' ? !t.project : t.project === f.project)) &&
    f.labels.every(l => t.labels.some(x => x.toLowerCase() === l.toLowerCase())) &&
    (!f.due || (f.due === 'none' ? !t.due : f.due === 'today' ? t.due === today : !!t.due && t.due < today && !['done', 'canceled'].includes(t.status)));
}
export function compareTasks(sort: TaskSort, a: Ticket, b: Ticket) {
  const order = sort === 'title' ? a.title.localeCompare(b.title, undefined, {numeric:true, sensitivity:'base'}) :
    sort === 'due' ? (a.due ?? '9999').localeCompare(b.due ?? '9999') :
    sort === 'created' ? b.created - a.created : sort === 'updated' ? b.updated - a.updated : (a.priority || 5) - (b.priority || 5);
  return order || b.updated - a.updated || a.id.localeCompare(b.id, undefined, {numeric:true});
}
export function localDay(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
