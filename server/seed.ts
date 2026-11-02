import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CreateTicketInput, VaultUser } from '../shared/types.ts';
import { syncAndBroadcast, type Ctx } from './context.ts';
import { atomicCreateExclusive, pathExists } from './fsutil.ts';
import { createProject } from './projects.ts';
import { createTicket } from './tickets.ts';

/** Instructions shared by the task clients and agents. */
export function agentsGuide(owner: VaultUser): string {
  return `# CENTCOM: ${owner.name}'s project and task tracker

CENTCOM is a shared task tracker for humans and agents. The Mac app, iOS companion,
CLI and MCP all use one backend. Projects live in Projects/<Name>/project.md;
tasks live in Projects/<Name>/Tickets/ or Inbox/ as markdown with YAML frontmatter.

1. Find or create a ticket before starting work.
2. Claim it with your agent id and set status to in_progress.
3. Comment with decisions, progress and links to changes.
4. Set in_review when a human should look, or done when finished.
5. File separate tickets for out-of-scope work.
6. Identify yourself on every write.

Use the REST API at http://127.0.0.1:4747/api, CLI (centcom ticket --help),
or MCP at http://127.0.0.1:4747/mcp. Remote clients require a bearer token.
IDs are allocated by the server. Statuses: backlog, todo, in_progress, in_review,
done, canceled. Priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.

Existing reference files can remain on disk; they are not part of the task tracker.
`;
}

const CENTCOM_OVERVIEW = 'One place to plan projects, capture tasks, and follow work across your devices and agents.';
const SEED_TICKETS: CreateTicketInput[] = [
  { title: 'Connect your first agent', status: 'todo', priority: 3, body: 'Connect a CLI or MCP client and create, claim, comment on and complete a task.' },
  { title: 'Set up remote access', status: 'todo', priority: 2, body: 'Put the server behind private HTTPS (for example Tailscale Serve, Cloudflare Tunnel, or your own reverse proxy) and add its https:// origin to remoteOrigin. Verify that remote requests without a token are refused.' },
  { title: 'Connect the iOS companion', status: 'todo', priority: 3, body: 'Enter the shared backend URL and token in the iOS app. Create a task on the phone and verify it appears on desktop.' },
];

async function isEmptyVault(root: string): Promise<boolean> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) return false;
    // The structural root folders are created on every boot; they only count once something is inside them.
    const inside = (await fs.readdir(path.join(root, entry.name))).filter((n) => !n.startsWith('.'));
    if (inside.length > 0) return false;
  }
  return true;
}

/**
 * First run on an empty vault only. Nothing here ever overwrites an existing file:
 * `AGENTS.md` is created exclusively and the project/tickets go through the normal
 * creation paths (which refuse to clobber).
 */
export async function seedVaultIfEmpty(ctx: Ctx): Promise<boolean> {
  if (!(await isEmptyVault(ctx.vault.root))) return false;
  ctx.log.info('Empty vault: seeding AGENTS.md, folders and the CENTCOM project.');

  const agentsFile = path.join(ctx.vault.root, 'AGENTS.md');
  if (!(await pathExists(agentsFile))) await atomicCreateExclusive(agentsFile, agentsGuide(ctx.user));
  await syncAndBroadcast(ctx, ['AGENTS.md']);

  await createProject(
    ctx,
    { name: 'CENTCOM', key: 'CEN', status: 'active', summary: 'Projects and tasks, shared across your devices and agents.', icon: 'Command', lead: ctx.user.id, body: CENTCOM_OVERVIEW },
    ctx.user.id,
  );
  for (const ticket of SEED_TICKETS) await createTicket(ctx, { ...ticket, project: 'CENTCOM', createdBy: ctx.user.id });
  return true;
}
