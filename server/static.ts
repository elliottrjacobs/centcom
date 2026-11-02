import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { HttpError } from './errors.ts';
import { mtimeOf, statOrNull } from './fsutil.ts';
import { makeSafeRoot, resolveVaultPath, staticContentType } from './paths.ts';
import { PERMISSIONS_POLICY } from './routes.ts';

/**
 * The shell's own CSP is a meta tag (see index.html), which cannot say `frame-ancestors`; these
 * travel as headers on every UI response. No other site may frame CENTCOM (clickjacking).
 */
export const SHELL_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': PERMISSIONS_POLICY,
  'X-Content-Type-Options': 'nosniff',
};

/** `opts.uiDir` → `$CENTCOM_UI_DIR` → `<cwd>/dist-ui`. Never derived from `import.meta` (the server is also shipped as a CJS bundle). */
export function resolveUiDir(explicit?: string): string {
  return path.resolve(explicit ?? process.env.CENTCOM_UI_DIR ?? path.join(process.cwd(), 'dist-ui'));
}

/**
 * Serve the built UI when `<uiDir>/index.html` exists, with an SPA fallback for every
 * GET that is not `/api` or `/mcp`. Checked per request, so a later `pnpm build:ui`
 * is picked up without restarting the server.
 */
export function mountStaticUi(app: Hono, uiDir: string): void {
  app.get('*', async (c) => {
    const { pathname } = new URL(c.req.url);
    if (pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/mcp')) return c.notFound();
    const indexFile = path.join(uiDir, 'index.html');
    const indexStat = await statOrNull(indexFile);
    if (!indexStat?.isFile()) {
      return c.text('CENTCOM server is running. The UI has not been built (no dist-ui/index.html); the API is at /api.\n', 200, { ...SHELL_HEADERS });
    }

    let file = indexFile;
    let stat = indexStat;
    let isAsset = false;
    if (pathname !== '/' && pathname !== '/index.html') {
      try {
        // Same path-safety function as the vault, rooted at the UI directory instead.
        const resolved = await resolveVaultPath(await makeSafeRoot(uiDir), decodeURIComponent(pathname.slice(1)));
        const candidate = await statOrNull(resolved.abs);
        if (candidate?.isFile()) {
          file = resolved.abs;
          stat = candidate;
          isAsset = true;
        }
      } catch (err) {
        if (!(err instanceof HttpError) && !(err instanceof URIError)) throw err;
      }
      // A missing file with an extension is a real 404, not a route for the SPA to handle.
      if (!isAsset && /\.[a-z0-9]{1,8}$/i.test(pathname)) return c.notFound();
    }

    const etag = `"${mtimeOf(stat).toString(36)}-${stat.size.toString(36)}"`;
    const headers: Record<string, string> = {
      'Content-Type': staticContentType(file),
      // Vite fingerprints everything under /assets; the shell must always be revalidated.
      'Cache-Control': isAsset && pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
      ...SHELL_HEADERS,
    };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
    headers['Content-Length'] = String(stat.size);
    return new Response(Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>, { status: 200, headers });
  });
}
