import { instructionCatalog, instructionDocument, instructionReportSchema, reportInstructions } from './instructions.ts';
import { skillCatalog, skillDocument, reportSkills, skillReportSchema } from './skills.ts';
import { listLabels, mutateLabel } from './labels.ts';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { IncomingMessage } from 'node:http';
import { DELIVERABLE_KINDS, PROJECT_STATUSES, TICKET_STATUSES, TOKEN_SCOPES, type ApiError, type LinkInfo, type ServerInfo, type TreeNode } from '../shared/types.ts';
import { addDeliverable, agentHome, listProfiles, readProfile, removeDeliverable, upsertProfile } from './agent-profiles.ts';
import { isPersonalAgent, normalizeAgentId } from './agents.ts';
import { refreshBookmark, saveBookmark } from './bookmarks.ts';
import { gateVerdictOf, type GateVerdict } from './auth.ts';
import type { SessionStore } from './sessions.ts';
import { hasScope, mayWriteInstructions, type Principal, type TokenStore } from './tokens.ts';
import { actingAgent, recordActivitySafe, syncAndBroadcast, type Ctx } from './context.ts';
import { createDoc, createFolder, deletePath, duplicatePath, MAX_UPLOAD_BYTES, movePath, projectOfPath, readDoc, uploadFile, writeDoc } from './docs.ts';
import { forbidden, HttpError, invalid, notFound, tooLarge, unauthorized } from './errors.ts';
import { mtimeOf, statOrNull } from './fsutil.ts';
import { allLinkGitStatus, fetchLinks, pullLink } from './link-git.ts';
import { coerceTicketPriority, coerceTicketStatus } from './model.ts';
import { fileKind, relBasename, resolveVaultPath, vaultContentType } from './paths.ts';
import { createProject, deleteProject, listProjects, requireProject, toApiProject, updateProject } from './projects.ts';
import { reconcileFromDisk } from './reconcile.ts';
import { search } from './search.ts';
import { commentOnTicket, createTicket, deleteComment, deleteTicket, editComment, getTicketDetail, listTickets, updateTicket, type CommentGuard } from './tickets.ts';
import { listTrash, purgeTrash, restoreFromTrash } from './trash.ts';

export const MAX_JSON_BYTES = 5 * 1024 * 1024;

/** No CENTCOM page or file ever needs a camera, microphone, location, or the rest. */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

/* ───────────────────────── Body + validation helpers ───────────────────────── */

async function readJson(c: Context, containsToken?: (text: string) => boolean): Promise<unknown> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw tooLarge('JSON body exceeds the 5 MB limit.');
  const stream = c.req.raw.body;
  if (!stream) return {};
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge('JSON body exceeds the 5 MB limit.');
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  // The likeliest self-inflicted leak: pasting a token into a ticket, comment, doc or profile.
  if (containsToken?.(text)) {
    throw invalid('This write contains a live CENTCOM token. Remove it and try again: tokens belong in a secret store, never in tickets, comments or documents.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid('Request body is not valid JSON.');
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const message = result.error.issues
    .slice(0, 5)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
  throw invalid(message || 'Invalid request body.');
}

async function parseBody<T>(c: Context, schema: z.ZodType<T>, containsToken?: (text: string) => boolean): Promise<T> {
  const json = await readJson(c, containsToken);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw invalid('Request body must be a JSON object.');
  return parse(schema, json);
}

/* Liberal on the way in: "in-progress", "High", "2" are all understood; what gets stored is canonical. */
const statusSchema = z.unknown().transform((value, ctx) => {
  const status = coerceTicketStatus(value);
  if (!status) {
    ctx.addIssue({ code: 'custom', message: `must be one of ${TICKET_STATUSES.join(', ')}` });
    return z.NEVER;
  }
  return status;
});

const prioritySchema = z.unknown().transform((value, ctx) => {
  const priority = coerceTicketPriority(value);
  if (priority === null) {
    ctx.addIssue({ code: 'custom', message: 'must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)' });
    return z.NEVER;
  }
  return priority;
});

const nullableString = z.string().nullable();
const agentField = z.string().max(200).optional();

const createTicketSchema = z.object({
  device: z.string().max(100).optional(),
  title: z.string(),
  project: nullableString.optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  agent: nullableString.optional(),
  createdBy: agentField,
  labels: z.array(z.string()).max(50).optional(),
  due: nullableString.optional(),
  parent: nullableString.optional(),
  body: z.string().optional(),
});

const updateTicketSchema = z.object({
  device: z.string().max(100).optional(),
  title: z.string().optional(),
  project: nullableString.optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  agent: nullableString.optional(),
  labels: z.array(z.string()).max(50).optional(),
  due: nullableString.optional(),
  parent: nullableString.optional(),
  body: z.string().optional(),
  by: agentField,
});

const commentSchema = z.object({ device: z.string().max(100).optional(), body: z.string(), agent: agentField });
const commentEditSchema = z.object({ body: z.string(), agent: agentField });

const projectStatus = z.enum(PROJECT_STATUSES);
const createProjectSchema = z.object({
  name: z.string(),
  key: z.string().optional(),
  status: projectStatus.optional(),
  summary: z.string().max(2000).optional(),
  color: z.string().optional(),
  icon: z.string().max(100).optional(),
  lead: nullableString.optional(),
  body: z.string().optional(),
  agent: agentField,
});
const updateProjectSchema = createProjectSchema.partial();

const frontmatterSchema = z.record(z.string(), z.unknown());
const writeDocSchema = z.object({
  path: z.string(),
  body: z.string().optional(),
  frontmatter: frontmatterSchema.optional(),
  ifMatch: z.number().nullable().optional(),
  agent: agentField,
});
const createDocSchema = z.object({ path: z.string(), body: z.string().optional(), frontmatter: frontmatterSchema.optional(), agent: agentField });
const folderSchema = z.object({ path: z.string() });
const moveSchema = z.object({ from: z.string(), to: z.string(), agent: agentField });
const duplicateSchema = z.object({ path: z.string(), agent: agentField });
const restoreSchema = z.object({ id: z.string(), agent: agentField });
const bookmarkSchema = z.object({
  url: z.string().max(2048),
  dir: z.string().max(1024).optional(),
  title: z.string().max(500).optional(),
  tags: z.array(z.string().max(200)).max(50).optional(),
  note: z.string().max(200_000).optional(),
  agent: agentField,
});
const bookmarkRefreshSchema = z.object({ path: z.string(), agent: agentField });
const createTokenSchema = z.object({
  label: z.string().trim().min(1).max(100),
  agent: z.string().max(200),
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).max(TOKEN_SCOPES.length),
  projects: z.array(z.string().max(200)).max(100).optional(),
  instructionAgents: z.array(z.string().max(70)).max(100).optional(),
});
const linkFetchSchema = z.object({ mount: z.string().max(1024).optional() });
const linkPullSchema = z.object({ mount: z.string().max(1024) });
const agentPatchSchema = z.object({ name: z.string().optional(), color: z.string().optional(), kind: z.enum(['human', 'agent']).optional() });
const agentProfileSchema = z.object({
  name: z.string().max(80).optional(),
  description: z.string().max(4000),
  instructions: z.string().max(100_000),
  skills: z.array(z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(1000) })).max(200).optional(),
  source: z.enum(['grokbot-sync', 'self-reported']).optional(),
  agent: agentField,
});
const deliverableSchema = z.object({
  title: z.string().trim().min(1).max(500),
  url: z.string().max(2048),
  kind: z.enum(DELIVERABLE_KINDS),
  date: z.string().max(10).optional(),
  project: z.string().max(200).optional(),
  note: z.string().max(2000).optional(),
  agent: agentField,
});

/** Drop `undefined` keys so objects satisfy the contract's optional (not `| undefined`) properties. */
function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

function intParam(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw invalid(`${name} must be a positive integer.`);
  return n;
}

/**
 * `Range: bytes=…` for a file of `size` bytes. null = serve the whole file (no header, a unit
 * other than bytes, several ranges, or nonsense); 'unsatisfiable' = 416.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (size === 0) return 'unsatisfiable'; // no byte of an empty file can be addressed
  if (m[1] === '') {
    // `-N`: the last N bytes.
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix)) return null;
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? Number.MAX_SAFE_INTEGER : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

function ticketIdParam(c: Context): string {
  const id = c.req.param('id') ?? '';
  if (!id || id.length > 200 || id.includes('\0')) throw invalid('Invalid ticket id.');
  return id;
}

function commentIdParam(c: Context): string {
  const id = c.req.param('commentId') ?? '';
  if (!id || id.length > 100 || id.includes('\0')) throw invalid('Invalid comment id.');
  return id;
}

/* ───────────────────────── App ───────────────────────── */

export interface AppDeps {
  ctx: Ctx;
  info: () => ServerInfo;
  connection?: () => { token: string; urls: string[] };
  /** Re-read the link allowlist from config, rebuild the index and the watchers. */
  reloadLinks: () => Promise<LinkInfo[]>;
  /** True when `text` contains one of this server's live tokens; such writes are refused. */
  containsToken?: (text: string) => boolean;
  /** Named tokens; without it only the owner token exists and `/api/tokens` is unavailable. */
  tokens?: TokenStore;
  /** Browser sessions, so revoking a token ends the sessions it opened. */
  sessions?: SessionStore;
}

/**
 * The verdict the HTTP gate reached for this request. A request off a socket carries it on the
 * Node request; the embedded MCP endpoint calls `app.fetch` in-process and hands over the verdict
 * of the `/mcp` request it is serving, so tools act with exactly the caller's authority.
 */
function verdictOf(c: Context): GateVerdict | undefined {
  const env = c.env as { incoming?: IncomingMessage; verdict?: GateVerdict } | undefined;
  return gateVerdictOf(env?.incoming) ?? env?.verdict;
}

/** Only the Projects subtree a confined token may see, and nothing else at the vault root. */
function pruneTree(root: TreeNode, projects: readonly string[]): TreeNode {
  const children = (root.children ?? []).flatMap((node) => {
    if (node.name !== 'Projects') return [];
    return [{ ...node, children: (node.children ?? []).filter((p) => projects.includes(p.name)) }];
  });
  return { ...root, children };
}

export function createApp({ ctx, info, reloadLinks, connection, containsToken, tokens, sessions }: AppDeps): Hono {
  const app = new Hono();
  // Every JSON write in this app goes through here, so every one gets the token check.
  const body = <T>(c: Context, schema: z.ZodType<T>): Promise<T> => parseBody(c, schema, containsToken);

  /* ── Who is asking ── */
  const principal = (c: Context): Principal => {
    const p = verdictOf(c)?.principal;
    if (!p) throw unauthorized('A token is required. Send Authorization: Bearer <token>.');
    return p;
  };
  /**
   * The agent a write is recorded as. A named token IS its agent: it may omit the field, and may
   * not claim anyone else. The owner token and trusted loopback act as whoever they say.
   */
  const actor = (c: Context, claimed: unknown, field = 'agent'): string => {
    const bound = principal(c).agent;
    if (!bound) return actingAgent(ctx, claimed, field);
    if (claimed !== undefined && claimed !== null && claimed !== '' && normalizeAgentId(claimed, field) !== bound) {
      throw forbidden(`This token writes as "${bound}"; it cannot act as "${String(claimed).slice(0, 80)}".`);
    }
    return bound;
  };
  /**
   * The writer of an agent profile or deliverable. Same binding as `actor`, but an unbound caller
   * that names no one leaves it to `agent-profiles.ts`, which treats that as the agent itself.
   */
  const profileWriter = (c: Context, claimed: string | undefined): string | undefined => {
    if (principal(c).agent) return actor(c, claimed);
    return claimed || undefined;
  };
  /** Instructions are what agents act on: changing someone else's needs `write:instructions` for them. */
  const allowInstructionWrite = (c: Context, rawId: string): void => {
    const id = normalizeAgentId(rawId, 'id');
    if (!mayWriteInstructions(principal(c), id)) {
      throw forbidden(`This token may not change ${id}'s profile or deliverables: that needs the write:instructions scope${principal(c).instructionAgents ? ` for ${id}` : ''}.`);
    }
  };
  const owner = (c: Context, what: string): void => {
    if (!principal(c).owner) throw forbidden(`Only the owner can ${what}.`);
  };
  /* Project confinement: a token with a project list sees and touches only those projects. */
  const confinedTo = (c: Context): readonly string[] | null => principal(c).projects;
  const inScope = (c: Context, slug: string | null | undefined): boolean => {
    const projects = confinedTo(c);
    return projects === null || (slug !== null && slug !== undefined && projects.includes(slug));
  };
  const allowProject = (c: Context, slug: string | null | undefined): void => {
    if (!inScope(c, slug)) throw forbidden(`This token is limited to ${(confinedTo(c) ?? []).join(', ')}.`);
  };
  const allowProjectRef = (c: Context, ref: string | null | undefined): void => {
    if (confinedTo(c) === null) return;
    allowProject(c, ref ? (ctx.index.findProject(ref)?.slug ?? null) : null);
  };
  const allowPath = async (c: Context, raw: string | undefined): Promise<void> => {
    if (confinedTo(c) === null) return;
    allowProject(c, projectOfPath((await resolveVaultPath(ctx.vault, raw ?? '', { allowRoot: true })).rel));
  };
  const allowTicket = (c: Context, id: string): void => {
    if (confinedTo(c) === null) return;
    allowProject(c, ctx.index.findTicket(id)?.project ?? null);
  };
  /** A comment is changed by the token it was written as, or by the owner; nobody else. */
  const commentGuard = (c: Context): CommentGuard => {
    const p = principal(c);
    return (author) => {
      if (!p.owner && p.agent !== author) throw forbidden(`Only ${author} or the owner can change this comment.`);
    };
  };
  const vaultWide = (c: Context): void => {
    if (confinedTo(c) !== null) throw forbidden(`This token is limited to ${(confinedTo(c) ?? []).join(', ')} and cannot use ${c.req.method} ${c.req.path}.`);
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(err.toJSON(), err.status as 400);
    if (err instanceof z.ZodError) return c.json<ApiError>({ error: err.message, code: 'invalid' }, 400);
    ctx.log.error(`${c.req.method} ${c.req.path}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return c.json<ApiError>({ error: 'Internal server error.' }, 500);
  });

  // Everything the API returns is live data; never let a browser or proxy reuse it.
  app.use('/api/*', async (c, next) => {
    // Belt and braces: the gate and this router parse the URL independently. If a request the
    // gate waved through as "public" (no token needed) has nonetheless been routed to an API
    // handler, the two disagree about what the path is, and the safe answer is no.
    const verdict = verdictOf(c);
    if (verdict?.via === 'public') throw unauthorized('A token is required for non-loopback clients. Send Authorization: Bearer <token>.');
    // In-process callers must carry the verdict of the request they serve; none means no authority.
    if (!verdict?.principal) throw unauthorized('A token is required. Send Authorization: Bearer <token>.');
    const p = verdict.principal;
    const reading = c.req.method === 'GET' || c.req.method === 'HEAD';
    const instructionWrite = /^\/api\/agents\/[^/]+\/(?:profile|deliverables)(?:\/|$)/.test(c.req.path);
    if (reading ? !hasScope(p, 'read') : !hasScope(p, 'write') && !(instructionWrite && hasScope(p, 'write:instructions'))) {
      throw forbidden(`This token does not have the ${reading ? 'read' : 'write'} scope.`);
    }
    await next();
    // Vault content included: nothing behind a credential belongs in a browser or proxy cache.
    c.res.headers.set('Cache-Control', 'no-store');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
  });

  /* ── Meta ── */
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/info', (c) => {
    const p = verdictOf(c)?.principal;
    return c.json(p ? { ...info(), caller: { agent: p.agent, owner: p.owner } } : info());
  });
  app.get('/api/connection', (c) => {
    if (!verdictOf(c)?.loopback || !connection) throw forbidden('Connection credentials are available only on this Mac.');
    return c.json(connection());
  });
  app.get('/api/tree', (c) => {
    const projects = confinedTo(c);
    return c.json(projects === null ? ctx.index.tree() : pruneTree(ctx.index.tree(), projects));
  });

  /* ── Documents ── */
  app.get('/api/doc', async (c) => {
    await allowPath(c, c.req.query('path'));
    return c.json(await readDoc(ctx, c.req.query('path')));
  });

  app.put('/api/doc', async (c) => {
    const input = await body(c, writeDocSchema);
    const { agent, ifMatch, ...rest } = input;
    await allowPath(c, rest.path);
    const doc = await writeDoc(ctx, defined({ ...rest, ifMatch: ifMatch ?? undefined }), actor(c, agent));
    return c.json(doc);
  });

  app.post('/api/doc', async (c) => {
    const input = await body(c, createDocSchema);
    await allowPath(c, input.path);
    return c.json(await createDoc(ctx, input, actor(c, input.agent)), 201);
  });

  app.delete('/api/doc', async (c) => {
    await allowPath(c, c.req.query('path'));
    return c.json(await deletePath(ctx, c.req.query('path'), actor(c, c.req.query('agent') ?? c.req.query('by'))));
  });

  app.post('/api/folder', async (c) => {
    const input = await body(c, folderSchema);
    await allowPath(c, input.path);
    return c.json(await createFolder(ctx, input.path), 201);
  });

  app.post('/api/move', async (c) => {
    const input = await body(c, moveSchema);
    await allowPath(c, input.from);
    await allowPath(c, input.to);
    return c.json(await movePath(ctx, input.from, input.to, actor(c, input.agent)));
  });

  app.post('/api/duplicate', async (c) => {
    const input = await body(c, duplicateSchema);
    await allowPath(c, input.path);
    return c.json(await duplicatePath(ctx, input.path, actor(c, input.agent)), 201);
  });

  app.post('/api/upload', async (c) => {
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw tooLarge('Upload exceeds the 50 MB limit.');
    await allowPath(c, c.req.query('dir') ?? '');
    const node = await uploadFile(ctx, c.req.query('dir') ?? '', c.req.query('name'), c.req.raw.body, actor(c, c.req.query('agent')));
    return c.json(node, 201);
  });

  app.get('/api/raw/*', async (c) => {
    let rel: string;
    try {
      // `c.req.path` is the path exactly as the router matched it (reserved characters and `%25`
      // still encoded), so stripping the route prefix from it cannot be thrown off by an oddly
      // encoded prefix. One more decode yields the literal file path.
      rel = decodeURIComponent(c.req.path.slice('/api/raw/'.length));
    } catch {
      throw invalid('Malformed path encoding.');
    }
    const target = await resolveVaultPath(ctx.vault, rel);
    allowProject(c, projectOfPath(target.rel));
    const stat = await statOrNull(target.abs);
    if (!stat) throw notFound(`${target.rel} does not exist.`);
    if (!stat.isFile()) throw invalid(`${target.rel} is not a file.`);

    const etag = `"${mtimeOf(stat).toString(36)}-${stat.size.toString(36)}"`;
    const kind = fileKind(relBasename(target.rel));
    // PDFs, video and audio cannot script in our origin (and `nosniff` stops them being read as
    // anything else), but a browser's built-in viewer / player cannot run inside a CSP sandbox.
    // Everything else, HTML and SVG above all, keeps the sandbox: an opaque origin and no script.
    const inert = kind === 'pdf' || kind === 'video' || kind === 'audio';
    const headers: Record<string, string> = {
      'Content-Type': vaultContentType(relBasename(target.rel)),
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
      // Vault content is untrusted. Even if a browser is pointed straight at it, it gets an
      // opaque origin and no script, so it can never call this API with the user's authority.
      'Content-Security-Policy': `${inert ? '' : 'sandbox; '}default-src 'none'; img-src 'self' data:; media-src 'self'; ${inert ? "object-src 'self'; " : ''}style-src 'unsafe-inline'; frame-ancestors 'none'`,
      'Permissions-Policy': PERMISSIONS_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-site',
    };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });

    // Range: what lets a <video>/<audio> seek and a PDF viewer load page by page. One range only;
    // a multi-range request is answered with the whole file, which the spec allows.
    const ifRange = c.req.header('if-range');
    const range = ifRange === undefined || ifRange === etag ? parseRange(c.req.header('range'), stat.size) : null;
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
      headers['Content-Length'] = String(range.end - range.start + 1);
      const part = Readable.toWeb(createReadStream(target.abs, { start: range.start, end: range.end })) as unknown as ReadableStream<Uint8Array>;
      return new Response(part, { status: 206, headers });
    }
    headers['Content-Length'] = String(stat.size);
    const stream = Readable.toWeb(createReadStream(target.abs)) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, { status: 200, headers });
  });

  /* ── Bookmarks ── */
  // Saving makes THIS machine fetch a URL the caller chose; see server/ssrf.ts for why that is
  // fenced in, and note that nothing but parsed fields ever comes back.
  app.post('/api/bookmarks', async (c) => {
    const { agent, ...input } = await body(c, bookmarkSchema);
    await allowPath(c, input.dir ?? '');
    const saved = await saveBookmark(ctx, defined(input), actor(c, agent));
    return c.json(saved.doc, saved.created ? 201 : 200);
  });

  app.post('/api/bookmarks/refresh', async (c) => {
    const input = await body(c, bookmarkRefreshSchema);
    await allowPath(c, input.path);
    return c.json(await refreshBookmark(ctx, input.path, actor(c, input.agent)));
  });

  app.use('/api/instructions/*', async (c, next) => { vaultWide(c); await next(); });
  app.use('/api/instructions', async (c, next) => { vaultWide(c); await next(); });
  app.use('/api/skills/*', async (c, next) => { vaultWide(c); await next(); });
  app.use('/api/skills', async (c, next) => { vaultWide(c); await next(); });
  app.get('/api/instructions', async c => c.json(await instructionCatalog(ctx)));
  app.get('/api/instructions/copies/:id', async c => c.json(await instructionDocument(ctx, c.req.param('id'))));
  app.put('/api/instructions/inventory', async c => c.json(await reportInstructions(ctx, await body(c, instructionReportSchema))));

  app.get('/api/skills', async c => c.json(await skillCatalog(ctx)));
  app.get('/api/skills/installations/:id', async c => c.json(await skillDocument(ctx, c.req.param('id'))));
  app.put('/api/skills/inventory', async c => c.json(await reportSkills(ctx, await body(c, skillReportSchema))));

  /* ── Tickets ── */
  app.get('/api/tickets', (c) => {
    const q = c.req.query();
    const list = listTickets(ctx, { project: q.project, status: q.status, agent: q.agent, label: q.label, q: q.q, parent: q.parent });
    return c.json(list.filter((t) => inScope(c, t.project)));
  });

  app.post('/api/tickets', async (c) => {
    const input = await body(c, createTicketSchema);
    allowProjectRef(c, input.project ?? null);
    return c.json(await createTicket(ctx, defined({ ...input, createdBy: actor(c, input.createdBy, 'createdBy') })), 201);
  });

  app.get('/api/tickets/:id', async (c) => {
    allowTicket(c, ticketIdParam(c));
    return c.json(await getTicketDetail(ctx, ticketIdParam(c)));
  });

  app.patch('/api/tickets/:id', async (c) => {
    const input = await body(c, updateTicketSchema);
    allowTicket(c, ticketIdParam(c));
    if (input.project !== undefined) allowProjectRef(c, input.project);
    return c.json(await updateTicket(ctx, ticketIdParam(c), defined({ ...input, by: actor(c, input.by, 'by') })));
  });

  app.delete('/api/tickets/:id', async (c) => {
    allowTicket(c, ticketIdParam(c));
    return c.json(await deleteTicket(ctx, ticketIdParam(c), actor(c, c.req.query('by') ?? c.req.query('agent'), 'by'), c.req.query('device')));
  });

  app.post('/api/tickets/:id/comments', async (c) => {
    const input = await body(c, commentSchema);
    allowTicket(c, ticketIdParam(c));
    return c.json(await commentOnTicket(ctx, ticketIdParam(c), input.body, actor(c, input.agent), input.device), 201);
  });

  app.patch('/api/tickets/:id/comments/:commentId', async (c) => {
    const input = await body(c, commentEditSchema);
    allowTicket(c, ticketIdParam(c));
    return c.json(await editComment(ctx, ticketIdParam(c), commentIdParam(c), input.body, actor(c, input.agent), commentGuard(c)));
  });

  app.delete('/api/tickets/:id/comments/:commentId', async (c) => {
    allowTicket(c, ticketIdParam(c));
    return c.json(await deleteComment(ctx, ticketIdParam(c), commentIdParam(c), actor(c, c.req.query('by') ?? c.req.query('agent'), 'by'), commentGuard(c)));
  });

  /* ── Projects ── */
  app.get('/api/labels', async c => c.json((await listLabels(ctx)).filter((l) => l.project === null || inScope(c, l.project))));
  app.post('/api/labels', async c => {
    const data = await body(c,z.object({project: nullableString, name:z.string().min(1).max(60),color:z.string().optional(),agent:agentField}));
    allowProjectRef(c, data.project);
    return c.json(await mutateLabel(ctx,data.project,undefined,{ ...data, agent: actor(c, data.agent) }),201);
  });
  app.patch('/api/labels/:id', async c => {
    const data = await body(c,z.object({project:nullableString,name:z.string().min(1).max(60).optional(),color:z.string().optional(),deleted:z.boolean().optional(),agent:agentField}));
    allowProjectRef(c, data.project);
    return c.json(await mutateLabel(ctx,data.project,c.req.param('id'),{ ...data, agent: actor(c, data.agent) }));
  });

  app.get('/api/projects', (c) => c.json(listProjects(ctx).filter((p) => inScope(c, p.slug))));

  app.post('/api/projects', async (c) => {
    vaultWide(c);
    const { agent, ...input } = await body(c, createProjectSchema);
    return c.json(await createProject(ctx, defined(input), actor(c, agent)), 201);
  });

  app.get('/api/projects/:slug', (c) => {
    const record = requireProject(ctx, c.req.param('slug'));
    allowProject(c, record.slug);
    return c.json(toApiProject(ctx, record));
  });

  app.patch('/api/projects/:slug', async (c) => {
    const { agent, ...input } = await body(c, updateProjectSchema);
    allowProject(c, requireProject(ctx, c.req.param('slug')).slug);
    return c.json(await updateProject(ctx, c.req.param('slug'), defined(input), actor(c, agent)));
  });

  app.delete('/api/projects/:slug', async (c) => {
    allowProject(c, requireProject(ctx, c.req.param('slug')).slug);
    await deleteProject(ctx, c.req.param('slug'), actor(c, c.req.query('by') ?? c.req.query('agent')));
    return c.json({ ok: true });
  });

  /* ── Activity, agents, search ── */
  app.get('/api/activity', (c) => {
    const q = c.req.query();
    const limit = intParam(q.limit, 'limit');
    const ticket = q.ticket ? ctx.index.findTicket(q.ticket) : undefined;
    const project = q.project ? (ctx.index.findProject(q.project)?.slug ?? q.project) : undefined;
    const events = ctx.activity.query({
      limit,
      agent: q.agent ? normalizeAgentId(q.agent) : undefined,
      project,
      tickets: q.ticket ? (ticket ? [ticket.id, ...ticket.previousIds] : [q.ticket]) : undefined,
    });
    return c.json(events.filter((e) => inScope(c, e.project ?? null)));
  });

  app.get('/api/agents', (c) => c.json(ctx.agents.list().map((agent) => ({ ...agent, showInDirectory: isPersonalAgent(agent) }))));

  app.patch('/api/agents/:id', async (c) => {
    owner(c, 'rename agents or change their kind');
    const input = await body(c, agentPatchSchema);
    return c.json(await ctx.agents.patch(normalizeAgentId(c.req.param('id'), 'id'), input));
  });

  /* ── Agent homes ── */
  app.get('/api/agent-profiles', async (c) => c.json(await listProfiles(ctx)));

  app.get('/api/agents/:id/home', async (c) => {
    const home = await agentHome(ctx, c.req.param('id'), intParam(c.req.query('limit'), 'limit'));
    return c.json({ ...home, activity: home.activity.filter((e) => inScope(c, e.project ?? null)) });
  });

  app.get('/api/agents/:id/profile', async (c) => {
    const profile = await readProfile(ctx, c.req.param('id'));
    if (!profile) throw notFound(`Agent "${c.req.param('id')}" has no profile yet.`);
    return c.json(profile);
  });

  app.put('/api/agents/:id/profile', async (c) => {
    const { agent, ...input } = await body(c, agentProfileSchema);
    allowInstructionWrite(c, c.req.param('id'));
    return c.json(await upsertProfile(ctx, c.req.param('id'), defined(input), profileWriter(c, agent)));
  });

  app.post('/api/agents/:id/deliverables', async (c) => {
    const { agent, ...input } = await body(c, deliverableSchema);
    allowInstructionWrite(c, c.req.param('id'));
    const { deliverable, created } = await addDeliverable(ctx, c.req.param('id'), defined(input), profileWriter(c, agent));
    return c.json(deliverable, created ? 201 : 200);
  });

  app.delete('/api/agents/:id/deliverables/:deliverableId', async (c) => {
    const by = c.req.query('agent') ?? c.req.query('by');
    allowInstructionWrite(c, c.req.param('id'));
    await removeDeliverable(ctx, c.req.param('id'), c.req.param('deliverableId'), profileWriter(c, by));
    return c.json({ ok: true });
  });

  app.get('/api/search', async (c) => {
    const raw = c.req.query('scope');
    // A folder scope is a vault path like any other: same rules, same Wiki → Library alias.
    const scope = raw && raw !== 'tasks' ? (await resolveVaultPath(ctx.vault, raw, { allowRoot: true })).rel || undefined : raw || undefined;
    const hits = search(ctx, c.req.query('q') ?? '', intParam(c.req.query('limit'), 'limit'), scope);
    return c.json(hits.filter((h) => inScope(c, h.project ?? projectOfPath(h.path))));
  });

  /* ── Reindex ── */
  // The safety net behind the watcher: walk the whole vault (links included), bring the index in
  // line with the disk, and always tell clients to refetch the tree. Reads the disk, writes nothing.
  app.post('/api/reindex', async (c) => {
    vaultWide(c);
    const changes = await reconcileFromDisk(ctx, [''], { announceTree: true });
    return c.json({ ok: true, files: changes.files.length, tickets: changes.tickets.length, projects: changes.projects.size });
  });

  /* ── Linked folders ── */
  // Loopback-only, token or not (enforced by the gate, re-checked here). There is deliberately
  // no endpoint that accepts a link: the allowlist is whatever the local config file says.
  const assertThisMachine = (c: Context): void => {
    if (verdictOf(c)?.loopback !== true) throw forbidden('This endpoint can only be called from the machine CENTCOM runs on.');
  };

  app.post('/api/links/reload', async (c) => {
    assertThisMachine(c);
    return c.json({ links: await reloadLinks() });
  });

  // Git state of each link's clone. Status reads local refs only; fetch and pull use the machine
  // owner's git credentials and network, so none of this is ever available to a remote caller,
  // token or not (the gate already refuses `/api/links/*`; this is the second lock on the door).
  app.get('/api/links/git', async (c) => {
    assertThisMachine(c);
    return c.json(await allLinkGitStatus(ctx));
  });

  app.post('/api/links/git/fetch', async (c) => {
    assertThisMachine(c);
    const input = await body(c, linkFetchSchema);
    return c.json(await fetchLinks(ctx, input.mount));
  });

  app.post('/api/links/git/pull', async (c) => {
    assertThisMachine(c);
    const input = await body(c, linkPullSchema);
    return c.json(await pullLink(ctx, input.mount));
  });

  /* ── Trash ── */
  app.use('/api/trash/*', async (c, next) => { vaultWide(c); await next(); });
  app.use('/api/trash', async (c, next) => { vaultWide(c); await next(); });
  app.get('/api/trash', async (c) => c.json(await listTrash(ctx)));

  app.post('/api/trash/restore', async (c) => {
    const input = await body(c, restoreSchema);
    const agent = actor(c, input.agent);
    const { path: restoredPath, restored } = await restoreFromTrash(ctx, input.id);
    await syncAndBroadcast(ctx, restored);
    const ticket = ctx.index.tickets.get(restoredPath);
    await recordActivitySafe(
      ctx,
      ticket
        ? { agent, type: 'ticket.updated', ticket: ticket.id, path: restoredPath, project: ticket.project, subject: ticket.title, changes: { deleted: [true, false] } }
        : { agent, type: 'doc.created', path: restoredPath, project: projectOfPath(restoredPath), subject: ctx.index.docs.get(restoredPath)?.title ?? relBasename(restoredPath) },
    );
    return c.json({ path: restoredPath });
  });

  app.delete('/api/trash', async (c) => {
    await purgeTrash(ctx, c.req.query('id'));
    return c.json({ ok: true });
  });

  /* ── Tokens (owner only) ── */
  app.get('/api/tokens', (c) => {
    owner(c, 'list tokens');
    return c.json(tokens?.list() ?? []);
  });

  app.post('/api/tokens', async (c) => {
    owner(c, 'create tokens');
    if (!tokens) throw notFound('Named tokens are not available on this server.');
    const input = await body(c, createTokenSchema);
    const projects = input.projects?.map((ref) => {
      const found = ctx.index.findProject(ref);
      if (!found) throw invalid(`project "${ref}" not found.`);
      return found.slug;
    });
    return c.json(await tokens.create({ label: input.label, agent: input.agent, scopes: input.scopes, projects: projects ?? null, instructionAgents: input.instructionAgents ?? null }), 201);
  });

  app.delete('/api/tokens/:id', async (c) => {
    owner(c, 'revoke tokens');
    if (!tokens) throw notFound('Named tokens are not available on this server.');
    const revoked = await tokens.revoke(c.req.param('id'));
    // A revoked token takes every browser session it opened with it.
    const sessionsEnded = sessions?.revokeToken(revoked.id) ?? 0;
    return c.json({ ok: true, revoked, sessionsEnded });
  });

  /* ── Live events ── */
  app.get('/api/events', (c) => {
    vaultWide(c);
    return new Response(ctx.hub.stream(), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  app.all('/api/*', (c) => c.json<ApiError>({ error: `No such endpoint: ${c.req.method} ${c.req.path}`, code: 'not_found' }, 404));

  return app;
}
