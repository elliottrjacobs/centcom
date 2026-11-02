import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CentcomClient } from '../mcp/client.ts';
import { createMcpServer } from '../mcp/tools.ts';
import type { Logger } from './context.ts';
import { errorMessage } from './errors.ts';
import { MAX_JSON_BYTES } from './routes.ts';

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function readBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) return { ok: false, status: 413, message: 'Request body exceeds the 5 MB limit.' };
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buf.length;
      if (size > MAX_JSON_BYTES) return { ok: false, status: 413, message: 'Request body exceeds the 5 MB limit.' };
      chunks.push(buf);
    }
  } catch (err) {
    return { ok: false, status: 400, message: `Could not read request body: ${errorMessage(err)}` };
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
  } catch {
    return { ok: false, status: 400, message: 'Parse error: request body is not valid JSON.' };
  }
}

/**
 * Streamable HTTP, stateless: a fresh server + transport per request, plain JSON responses.
 * Called by the Node http server *before* Hono, and only after `securityGate` has passed,
 * so `/mcp` obeys exactly the same Host / Origin / token rules as `/api`.
 */
export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, deps: { client: CentcomClient; version: string; log: Logger }): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') {
    // No sessions, so there is no server-initiated stream to GET and nothing to DELETE.
    sendJsonRpcError(res, 405, -32000, 'Method not allowed. This MCP endpoint is stateless: use POST.', { Allow: 'POST' });
    return;
  }
  const body = await readBody(req);
  if (!body.ok) {
    sendJsonRpcError(res, body.status, body.status === 413 ? -32600 : -32700, body.message);
    return;
  }

  const server = createMcpServer(deps.client, deps.version);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  };
  res.on('close', cleanup);
  try {
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res, body.value);
  } catch (err) {
    deps.log.error(`MCP request failed: ${errorMessage(err)}`);
    sendJsonRpcError(res, 500, -32603, 'Internal server error.');
    cleanup();
  }
}
