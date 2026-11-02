import type { AgentProfileSource } from '@shared/types';
import { parse, routeForPath, type Route } from './routes';

export function sourceLabel(source: AgentProfileSource): string {
  return source === 'grokbot-sync' ? 'Synced from Grok Bot' : 'Self-reported';
}

export type DeliverableTarget = { type: 'external'; url: string } | { type: 'route'; route: Route } | { type: 'raw'; path: string };

/**
 * Where a deliverable opens. Its url is an http(s) URL (validated by the server) or a vault path:
 * a doc the app can show opens in the app, any other file opens raw.
 */
export function deliverableTarget(url: string): DeliverableTarget {
  if (/^https?:\/\//i.test(url)) return { type: 'external', url };
  if (/\.md$/i.test(url)) {
    const route = routeForPath(url, 'markdown');
    // Only routes the app can actually show; a doc outside a project Library cannot be opened as a page.
    if (route.name !== 'doc' || parse(`#/doc/${route.path}`).name === 'doc') return { type: 'route', route };
  }
  return { type: 'raw', path: url };
}

/** The first paragraph of some markdown as one plain line: for lists, where formatting would be noise. */
export function oneLine(markdown: string): string {
  const first = markdown.trim().split(/\n[ \t]*\n/)[0] ?? '';
  return first
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
