/**
 * Disk → index reconciliation shared by the watcher, `POST /api/reindex` and `git pull`.
 * The filesystem is the source of truth; every caller here says "look at this path again"
 * and lets `VaultIndex.syncMany` work out what, if anything, really changed.
 */
import path from 'node:path';
import { FILESYSTEM_AGENT } from './agents.ts';
import { broadcastChanges, isRecentApiWrite, recordActivitySafe, shouldLogDocUpdate, type Ctx } from './context.ts';
import { projectOfPath } from './docs.ts';
import { hasChanges, type Changes } from './index-store.ts';
import type { TicketRecord } from './model.ts';

/** A burst bigger than this is a bulk operation (import, git checkout, restore); indexing it is enough. */
const BULK_THRESHOLD = 25;

const TRACKED_TICKET_FIELDS = ['title', 'status', 'priority', 'agent', 'due', 'parent'] as const;

function ticketDiff(before: TicketRecord, after: TicketRecord): Record<string, [unknown, unknown]> {
  const changes: Record<string, [unknown, unknown]> = {};
  for (const field of TRACKED_TICKET_FIELDS) if (before[field] !== after[field]) changes[field] = [before[field], after[field]];
  if (before.labels.join('\n') !== after.labels.join('\n')) changes.labels = [before.labels, after.labels];
  return changes;
}

/**
 * External edits → activity, attributed to `filesystem` (or, for a new hand-written ticket,
 * to whoever its `created_by` names). Field changes on tickets are always recorded;
 * plain content edits are rate-limited to one per file per 60 s.
 */
export async function logExternalActivity(ctx: Ctx, changes: Changes): Promise<void> {
  if (changes.files.length > BULK_THRESHOLD) {
    ctx.log.info(`${changes.files.length} files changed on disk at once; indexed without per-file activity.`);
    return;
  }
  const ticketPaths = new Set<string>();
  for (const t of changes.tickets) {
    const record = t.after ?? t.before;
    if (record) ticketPaths.add(record.path);
  }

  for (const t of changes.tickets) {
    const where = (t.after ?? t.before)?.path;
    if (where && isRecentApiWrite(ctx, where)) continue; // the API already logged this under the real agent
    if (t.before && t.after) {
      const diff = ticketDiff(t.before, t.after);
      const bodyChanged = t.before.body !== t.after.body;
      if (Object.keys(diff).length > 0) {
        await recordActivitySafe(ctx, { agent: FILESYSTEM_AGENT, type: 'ticket.updated', ticket: t.after.id, path: t.after.path, project: t.after.project, subject: t.after.title, changes: diff });
      } else if (bodyChanged && shouldLogDocUpdate(ctx, FILESYSTEM_AGENT, t.after.path)) {
        await recordActivitySafe(ctx, { agent: FILESYSTEM_AGENT, type: 'ticket.updated', ticket: t.after.id, path: t.after.path, project: t.after.project, subject: t.after.title, changes: { body: ['(edited on disk)', '(edited on disk)'] } });
      }
    } else if (t.after) {
      const author = t.after.createdBy || FILESYSTEM_AGENT;
      await recordActivitySafe(ctx, { agent: author, type: 'ticket.created', ticket: t.after.id, path: t.after.path, project: t.after.project, subject: t.after.title });
    } else if (t.before) {
      await recordActivitySafe(ctx, { agent: FILESYSTEM_AGENT, type: 'ticket.deleted', ticket: t.before.id, path: t.before.path, project: t.before.project, subject: t.before.title });
    }
  }

  for (const file of changes.files) {
    if (ticketPaths.has(file.path) || ctx.index.isSidecar(file.path)) continue;
    if (file.kind === 'other' || isRecentApiWrite(ctx, file.path)) continue;
    const base = { agent: FILESYSTEM_AGENT, path: file.path, project: projectOfPath(file.path), subject: file.title ?? path.posix.basename(file.path) };
    if (file.change === 'added') await recordActivitySafe(ctx, { ...base, type: 'doc.created' });
    else if (file.change === 'removed') await recordActivitySafe(ctx, { ...base, type: 'doc.deleted' });
    else if (shouldLogDocUpdate(ctx, FILESYSTEM_AGENT, file.path)) await recordActivitySafe(ctx, { ...base, type: 'doc.updated' });
  }
}

/**
 * Walk `rels` (files or whole folders; `''` is the entire vault) and bring the index in line
 * with what is on disk, telling every listener what changed. With `announceTree` a
 * `{ type: 'tree' }` event goes out even when nothing changed, so a client that asked for a
 * reconcile always gets its cue to refetch.
 */
export async function reconcileFromDisk(ctx: Ctx, rels: readonly string[], opts: { announceTree?: boolean } = {}): Promise<Changes> {
  const changes = await ctx.index.syncMany(rels);
  if (hasChanges(changes)) {
    broadcastChanges(ctx, changes);
    await logExternalActivity(ctx, changes);
  }
  if (opts.announceTree && !changes.structure) ctx.hub.broadcast({ type: 'tree' });
  return changes;
}
